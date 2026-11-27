import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createReply, type AgentClient } from "./agent.ts";
import { createJsonTaskStore } from "./task-store.ts";

interface MockTurn {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

async function createTempStore(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createJsonTaskStore(join(directory, "tasks.json"));
}

function createMockClient(turns: MockTurn[], recordedCalls: unknown[]) {
  let cursor = 0;
  const client: AgentClient = {
    chat: {
      completions: {
        create: (async (params: unknown) => {
          recordedCalls.push(structuredClone(params));
          const next = turns[cursor++];
          if (!next) throw new Error("未预期的额外模型请求");
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: next.content ?? "",
                  ...(next.reasoning_content ? { reasoning_content: next.reasoning_content } : {}),
                  ...(next.tool_calls ? { tool_calls: next.tool_calls } : {}),
                },
              },
            ],
          };
        }) as AgentClient["chat"]["completions"]["create"],
      },
    },
  };
  return client;
}

test("智能体通过工具调用完成新增、状态更新与删除，并原样回传 reasoning_content", async (t) => {
  const store = await createTempStore(t);
  const calls: Array<{ messages: Array<Record<string, unknown>> }> = [];

  const createClient = createMockClient(
    [
      {
        reasoning_content: "先创建买牛奶和取快递两条待办。",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "create_task",
              arguments: JSON.stringify({
                title: "买牛奶",
                dueDate: "2026-11-27",
                priority: "high",
              }),
            },
          },
          {
            id: "call_2",
            type: "function",
            function: {
              name: "create_task",
              arguments: JSON.stringify({ title: "取快递", effort: "small" }),
            },
          },
        ],
      },
      { content: "已为你记下买牛奶（今天到期、高优）和取快递。" },
    ],
    calls,
  );

  const replyCreate = createReply(store, {
    getClient: () => createClient,
    now: () => new Date(2026, 10, 27, 9, 0, 0),
  });

  const answer1 = await replyCreate([
    { role: "user", content: "帮我记一下今天买牛奶，再记一条取快递" },
  ]);
  assert.match(answer1, /买牛奶/);
  assert.equal(store.list().length, 2);

  // 验证第二次请求模型时保留了第一轮 assistant 消息上的 reasoning_content。
  const secondRoundAssistant = calls[1]?.messages.find((item) => item.role === "assistant");
  assert.equal(secondRoundAssistant?.reasoning_content, "先创建买牛奶和取快递两条待办。");

  const [milk, parcel] = store.list();
  const mutateClient = createMockClient(
    [
      {
        tool_calls: [
          {
            id: "call_3",
            type: "function",
            function: {
              name: "update_task",
              arguments: JSON.stringify({ id: milk.id, done: true }),
            },
          },
          {
            id: "call_4",
            type: "function",
            function: {
              name: "delete_task",
              arguments: JSON.stringify({ id: parcel.id }),
            },
          },
        ],
      },
      { content: "已把买牛奶标为完成，并删除了取快递。" },
    ],
    [],
  );

  const replyMutate = createReply(store, { getClient: () => mutateClient });
  await replyMutate([{ role: "user", content: "牛奶买好了，取快递删掉吧" }]);

  const finalTasks = store.list();
  assert.equal(finalTasks.length, 1);
  assert.equal(finalTasks[0]?.title, "买牛奶");
  assert.equal(finalTasks[0]?.done, true);
});

test("工具参数或任务约束不合法时将错误作为工具结果回传给模型而非中断请求", async (t) => {
  const store = await createTempStore(t);
  const calls: Array<{ messages: Array<Record<string, unknown>> }> = [];

  const client = createMockClient(
    [
      {
        tool_calls: [
          {
            id: "bad_1",
            type: "function",
            function: { name: "delete_task", arguments: JSON.stringify({ id: "not-exist" }) },
          },
          {
            id: "bad_2",
            type: "function",
            function: { name: "create_task", arguments: "{invalid json" },
          },
        ],
      },
      { content: "没找到对应的任务，请确认名称后再试。" },
    ],
    calls,
  );

  const reply = createReply(store, { getClient: () => client });
  const text = await reply([{ role: "user", content: "删掉不存在的任务" }]);
  assert.match(text, /没找到/);

  const toolMessages = calls[1]?.messages.filter((item) => item.role === "tool") ?? [];
  assert.equal(toolMessages.length, 2);
  assert.match(String(toolMessages[0]?.content), /找不到/);
  assert.match(String(toolMessages[1]?.content), /JSON/);
});

test("未配置 DEEPSEEK_API_KEY 时返回明确的配置指引", async (t) => {
  const store = await createTempStore(t);
  const reply = createReply(store, {
    getClient() {
      throw new Error("请在 .env 中设置 DEEPSEEK_API_KEY 后重启服务。");
    },
  });
  const text = await reply([{ role: "user", content: "你好" }]);
  assert.match(text, /DEEPSEEK_API_KEY/);
});
