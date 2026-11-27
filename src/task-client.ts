import type { Task } from "../shared/tasks.ts";

export async function fetchTasks(): Promise<Task[]> {
  const response = await fetch("/api/tasks");
  if (!response.ok) throw new Error("无法加载待办清单。");
  return (await response.json()) as Task[];
}

export async function toggleTaskDone(id: string, done: boolean): Promise<Task> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ done }),
  });
  if (!response.ok) throw new Error("更新任务状态失败。");
  return (await response.json()) as Task;
}
