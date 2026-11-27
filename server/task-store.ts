import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Task, TaskAttributes, TaskChanges } from "../shared/tasks.ts";

// 读取时保持宽松结构，兼容历史清单里已有的自定义扩展字段。
const storedTask = z.looseObject({ id: z.string(), title: z.string(), done: z.boolean() });
const taskList = z.array(storedTask);
type StoredTask = z.infer<typeof storedTask> & Omit<Task, "id" | "title" | "done">;

export class TaskConstraintError extends Error {}

export interface TaskStore {
  list(): StoredTask[];
  create(title: string, attributes?: TaskAttributes): StoredTask;
  update(id: string, changes: TaskChanges): StoredTask | undefined;
  remove(id: string): boolean;
}

// 子任务只保留一层父子关系，避免自引用、循环挂载和过深层级。
function assertValidParent(tasks: StoredTask[], parentId: string, selfId?: string) {
  if (selfId && parentId === selfId) {
    throw new TaskConstraintError("任务不能将自己设为父任务。");
  }
  const parent = tasks.find((item) => item.id === parentId);
  if (!parent) {
    throw new TaskConstraintError("指定的父任务不存在。");
  }
  if (parent.parentId) {
    throw new TaskConstraintError("子任务下不能继续嵌套子任务。");
  }
  if (selfId && tasks.some((item) => item.parentId === selfId)) {
    throw new TaskConstraintError("已包含子任务的父任务不能再挂到其他任务下。");
  }
}

export function createJsonTaskStore(filename: string): TaskStore {
  function list(): StoredTask[] {
    if (!existsSync(filename)) return [];
    return taskList.parse(JSON.parse(readFileSync(filename, "utf8")));
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: StoredTask[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  return {
    list,

    create(title, attributes) {
      const tasks = list();
      if (attributes?.parentId) {
        assertValidParent(tasks, attributes.parentId);
      }

      const task: StoredTask = { id: randomUUID(), title, done: false };
      if (attributes?.dueDate) task.dueDate = attributes.dueDate;
      if (attributes?.priority) task.priority = attributes.priority;
      if (attributes?.effort) task.effort = attributes.effort;
      if (attributes?.parentId) task.parentId = attributes.parentId;

      save([...tasks, task]);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      if (typeof changes.parentId === "string") {
        assertValidParent(tasks, changes.parentId, id);
      }

      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) continue;
        if (value === null) {
          delete task[key];
        } else {
          task[key] = value;
        }
      }

      save(tasks);
      return task;
    },

    remove(id) {
      const tasks = list();
      if (!tasks.some((task) => task.id === id)) return false;

      // 删除父任务时一并清理其子任务，避免留下悬空的 parentId。
      const remaining = tasks.filter((task) => task.id !== id && task.parentId !== id);
      save(remaining);
      return true;
    },
  };
}
