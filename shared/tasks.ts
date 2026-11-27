export const priorityValues = ["low", "medium", "high"] as const;
export const effortValues = ["small", "medium", "large"] as const;

export type TaskPriority = (typeof priorityValues)[number];
export type TaskEffort = (typeof effortValues)[number];

export interface Task {
  id: string;
  title: string;
  done: boolean;
  dueDate?: string;
  priority?: TaskPriority;
  effort?: TaskEffort;
  parentId?: string;
}

export interface TaskAttributes {
  dueDate?: string;
  priority?: TaskPriority;
  effort?: TaskEffort;
  parentId?: string;
}

export interface TaskChanges {
  title?: string;
  done?: boolean;
  dueDate?: string | null;
  priority?: TaskPriority | null;
  effort?: TaskEffort | null;
  parentId?: string | null;
}

// 使用本地日历年月日拼接，避免 toISOString() 在东八区凌晨跨天偏移。
export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
