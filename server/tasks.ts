import { Router } from "express";
import { z } from "zod";
import {
  dueDateSchema,
  taskEffortSchema,
  taskPrioritySchema,
  taskTitleSchema,
} from "./task-schema.ts";
import { TaskConstraintError, type TaskStore } from "./task-store.ts";

const parentIdSchema = z.string().trim().min(1);

const createTaskSchema = z.strictObject({
  title: taskTitleSchema,
  dueDate: dueDateSchema.optional(),
  priority: taskPrioritySchema.optional(),
  effort: taskEffortSchema.optional(),
  parentId: parentIdSchema.optional(),
});

const updateTaskSchema = z
  .strictObject({
    title: taskTitleSchema.optional(),
    done: z.boolean().optional(),
    dueDate: dueDateSchema.nullable().optional(),
    priority: taskPrioritySchema.nullable().optional(),
    effort: taskEffortSchema.nullable().optional(),
    parentId: parentIdSchema.nullable().optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0);

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(tasks.list());
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res
        .status(400)
        .json({ error: "任务字段无效，请检查标题（1-200 字）及扩展属性格式。" });
    }
    const { title, ...attributes } = input.data;
    try {
      res.status(201).json(tasks.create(title, attributes));
    } catch (error) {
      if (error instanceof TaskConstraintError) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供至少一个有效的更新字段。" });
    }

    try {
      const updated = tasks.update(req.params.id, input.data);
      if (!updated) return res.status(404).json(taskNotFound);
      res.json(updated);
    } catch (error) {
      if (error instanceof TaskConstraintError) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
  });

  router.delete("/:id", (req, res) => {
    if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    res.sendStatus(204);
  });

  return router;
}
