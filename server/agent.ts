import { join } from "node:path";
import type OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { z } from "zod";
import type { ChatMessage } from "../shared/chat.ts";
import { effortValues, formatLocalDate, priorityValues } from "../shared/tasks.ts";
import { getModelClient, model as defaultModel } from "./model.ts";
import {
  dueDateSchema,
  taskEffortSchema,
  taskPrioritySchema,
  taskTitleSchema,
} from "./task-schema.ts";
import { createJsonTaskStore, TaskConstraintError, type TaskStore } from "./task-store.ts";

export type { ChatMessage } from "../shared/chat.ts";

// 限制单轮对话最多执行的工具往返步数，防止模型异常时无限循环。
const MAX_TOOL_ROUNDS = 6;
// 仅保留最近的对话窗口，兼顾多轮指代消解与上下文长度开销。
const MAX_HISTORY_MESSAGES = 36;

const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

const createToolArgs = z.object({
  title: taskTitleSchema,
  dueDate: dueDateSchema.optional(),
  priority: taskPrioritySchema.optional(),
  effort: taskEffortSchema.optional(),
  parentId: z.string().trim().min(1).optional(),
});

const updateToolArgs = z
  .object({
    id: z.string().trim().min(1),
    title: taskTitleSchema.optional(),
    done: z.boolean().optional(),
    dueDate: dueDateSchema.nullable().optional(),
    priority: taskPrioritySchema.nullable().optional(),
    effort: taskEffortSchema.nullable().optional(),
    parentId: z.string().trim().min(1).nullable().optional(),
  })
  .refine(({ id: _id, ...changes }) => Object.keys(changes).length > 0, {
    message: "至少需要提供一个待修改字段。",
  });

const deleteToolArgs = z.object({
  id: z.string().trim().min(1),
});

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "重新读取当前全部任务（包含已完成任务与子任务）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "创建一条待办任务；若是某个已有任务的子任务，传入对应的 parentId。",
      parameters: {
        type: "object",
        required: ["title"],
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "简明清晰的任务标题（1-200 字）" },
          dueDate: { type: "string", description: "截止日期，格式 YYYY-MM-DD" },
          priority: {
            type: "string",
            enum: [...priorityValues],
            description: "优先级：low / medium / high",
          },
          effort: {
            type: "string",
            enum: [...effortValues],
            description: "工作量：small / medium / large",
          },
          parentId: { type: "string", description: "所属父任务的 id（仅一层子任务）" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "按 id 修改任务的标题、完成状态（done）或扩展属性；传 null 可清除对应扩展属性。",
      parameters: {
        type: "object",
        required: ["id"],
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "目标任务 id" },
          title: { type: "string", description: "新标题" },
          done: { type: "boolean", description: "true 为已完成，false 为未完成" },
          dueDate: { type: ["string", "null"], description: "截止日期 YYYY-MM-DD，null 表示清除" },
          priority: {
            type: ["string", "null"],
            enum: [...priorityValues, null],
            description: "优先级 low / medium / high，null 表示清除",
          },
          effort: {
            type: ["string", "null"],
            enum: [...effortValues, null],
            description: "工作量 small / medium / large，null 表示清除",
          },
          parentId: { type: ["string", "null"], description: "父任务 id，null 表示变回顶层任务" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "按 id 删除一条任务（若为父任务会同时删除其下属子任务）。",
      parameters: {
        type: "object",
        required: ["id"],
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "要删除的任务 id" },
        },
      },
    },
  },
];

// 生成未来一周的日期对照表，避免模型推算“明天”“这周日”“下周二”时算错日历。
function buildCalendarReference(now: Date): string {
  const days: string[] = [];
  for (let offset = 0; offset <= 7; offset++) {
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const label =
      offset === 0 ? "今天" : offset === 1 ? "明天" : offset === 2 ? "后天" : `+${offset}天`;
    days.push(`${label} ${formatLocalDate(target)}(${weekdayNames[target.getDay()]})`);
  }
  return days.join("，");
}

function buildSystemPrompt(tasks: TaskStore, now: Date): string {
  const snapshot = JSON.stringify(tasks.list());
  return [
    "你是「小明」，一个干练、自然的中文待办清单智能体，帮用户通过日常对话管理个人任务。",
    `当前日期参考：${buildCalendarReference(now)}。`,
    `当前任务清单快照（JSON）：${snapshot}`,
    "",
    "核心行为准则：",
    "1. 任何新增、修改、标记完成/未完成、删除操作，都必须调用对应工具落盘，不能只在回复里口头承诺。",
    "2. 语义匹配：用户说「衣服洗好了」「牛奶买完了」时，结合清单快照定位语义对应的任务 id 并调用 update_task；若说「还没做完/标错了」则将 done 改回 false。",
    "3. 歧义与安全边界：",
    "   - 若清单里有多条任务都能匹配用户的模糊指代（例如同时有「买牛奶」和「给爸妈买牛奶」，用户只说「牛奶买好了」或「把买牛奶删掉」），不要盲猜，先列出匹配项向用户确认。",
    "   - 若用户只说「帮我记一下」「提醒我明天」却没有具体事项内容，自然追问要记什么，不要创建空泛无意义的任务。",
    "   - 新增待办时，若清单中已有语义完全一致且未完成的同名任务，先提醒用户已在清单中（若用户补充了截止日或优先级，可直接更新原任务；除非用户明确要求再记一条）。",
    "   - 用户要求「清空全部任务」「全删掉」等多条破坏性删除且尚未确认时，先简短向用户确认一次；明确指明删除某一条或某几条时直接执行。",
    "4. 扩展属性约定：",
    "   - 截止日期统一存为 YYYY-MM-DD；当用户问「今天有哪些任务到期？」时，准确回答 dueDate 为今天的任务并区分完成状态，若有已逾期未完成的任务也顺带提醒。",
    "   - 优先级映射：低=low、中=medium、高=high；工作量映射：小=small、中=medium、大=large。",
    "   - 子任务通过 parentId 关联顶层父任务（仅支持一层子任务）。",
    "5. 表达与排版规范：",
    "   - 聊天窗口直接按纯文本展示，禁止输出 **、###、` 等 Markdown 标记符号，也不要暴露任务的内部 UUID。",
    "   - 展示清单时优先呈现「待处理」任务（逾期/今日到期、高优先级靠前，子任务缩进在父任务下方并体现进度），再简要列出「已完成」任务，让用户一眼看出还需要处理什么。",
  ].join("\n");
}

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  const sliced = messages.slice(-MAX_HISTORY_MESSAGES);
  const firstUserIndex = sliced.findIndex((item) => item.role === "user");
  return firstUserIndex > 0 ? sliced.slice(firstUserIndex) : sliced;
}

function executeTool(tasks: TaskStore, name: string, rawArguments: string): unknown {
  let parsedJson: unknown;
  try {
    parsedJson = rawArguments ? JSON.parse(rawArguments) : {};
  } catch {
    return { error: "工具参数不是有效的 JSON。" };
  }

  try {
    switch (name) {
      case "list_tasks":
        return { tasks: tasks.list() };
      case "create_task": {
        const input = createToolArgs.safeParse(parsedJson);
        if (!input.success) return { error: "参数校验失败：" + input.error.issues[0]?.message };
        const { title, ...attributes } = input.data;
        return { task: tasks.create(title, attributes) };
      }
      case "update_task": {
        const input = updateToolArgs.safeParse(parsedJson);
        if (!input.success) return { error: "参数校验失败：" + input.error.issues[0]?.message };
        const { id, ...changes } = input.data;
        const updated = tasks.update(id, changes);
        return updated ? { task: updated } : { error: "找不到指定 id 的任务。" };
      }
      case "delete_task": {
        const input = deleteToolArgs.safeParse(parsedJson);
        if (!input.success) return { error: "参数校验失败：" + input.error.issues[0]?.message };
        return tasks.remove(input.data.id)
          ? { deleted: true }
          : { error: "找不到指定 id 的任务。" };
      }
      default:
        return { error: `未知工具：${name}` };
    }
  } catch (error) {
    if (error instanceof TaskConstraintError) {
      return { error: error.message };
    }
    throw error;
  }
}

export interface AgentClient {
  chat: {
    completions: {
      create: OpenAI["chat"]["completions"]["create"];
    };
  };
}

export interface CreateReplyOptions {
  getClient?: () => AgentClient;
  model?: string;
  now?: () => Date;
}

export function createReply(tasks: TaskStore, options: CreateReplyOptions = {}) {
  const resolveClient = options.getClient ?? getModelClient;
  const modelName = options.model ?? defaultModel;
  const resolveNow = options.now ?? (() => new Date());

  return async function reply(messages: ChatMessage[]): Promise<string> {
    let client: AgentClient;
    try {
      client = resolveClient();
    } catch (error) {
      if (error instanceof Error && error.message.includes("DEEPSEEK_API_KEY")) {
        return error.message;
      }
      throw error;
    }

    const conversation: ChatCompletionMessageParam[] = [
      { role: "system", content: buildSystemPrompt(tasks, resolveNow()) },
      ...trimHistory(messages).map((item) => ({
        role: item.role,
        content: item.content,
      })),
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const completion = await client.chat.completions.create({
        model: modelName,
        messages: conversation,
        tools,
      });

      const assistantMessage = completion.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error("模型未返回有效消息。");
      }

      // 原样保留模型返回的整条消息对象（含 DeepSeek 思维链字段 reasoning_content），否则多步工具回传会报 400。
      conversation.push(assistantMessage as ChatCompletionMessageParam);

      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        const text = assistantMessage.content?.trim();
        return text || "已处理完成。";
      }

      for (const call of assistantMessage.tool_calls) {
        if (call.type !== "function") continue;
        const result = executeTool(tasks, call.function.name, call.function.arguments);
        conversation.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    // 达到工具调用轮次上限时做最后一次无工具汇总，保证用户始终拿到自然语言反馈。
    const fallback = await client.chat.completions.create({
      model: modelName,
      messages: conversation,
    });
    return fallback.choices[0]?.message?.content?.trim() || "操作已完成，你可以查看最新清单。";
  };
}

// 默认导出共享本地任务文件，兼容单独引用 server/agent.ts 的调用方。
export const reply = createReply(createJsonTaskStore(join("data", "tasks.json")));
