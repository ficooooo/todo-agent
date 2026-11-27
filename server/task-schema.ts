import { z } from "zod";
import { effortValues, priorityValues } from "../shared/tasks.ts";

export const taskPrioritySchema = z.enum(priorityValues);
export const taskEffortSchema = z.enum(effortValues);

// 仅接受真实存在的公历 YYYY-MM-DD，避免像 2026-02-30 这样的无效日期落盘。
export const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  });

export const taskTitleSchema = z.string().trim().min(1).max(200);
