import { formatLocalDate, type Task, type TaskEffort, type TaskPriority } from "../shared/tasks.ts";

interface TaskPanelProps {
  tasks: Task[];
  onToggleDone: (id: string, done: boolean) => void;
}

const priorityLabels: Record<TaskPriority, string> = {
  high: "高优",
  medium: "中优",
  low: "低优",
};

const priorityRank: Record<TaskPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const effortLabels: Record<TaskEffort, string> = {
  small: "小",
  medium: "中",
  large: "大",
};

function dueUrgency(dueDate: string | undefined, today: string): number {
  if (!dueDate) return 3;
  if (dueDate < today) return 0;
  if (dueDate === today) return 1;
  return 2;
}

// 待处理列表按“已逾期 → 今日到期 → 近期截止 → 高优先级 → 创建顺序”排列，突出当下最该处理的事。
function sortPendingTasks(items: Task[], today: string): Task[] {
  return [...items].sort((a, b) => {
    const urgencyDiff = dueUrgency(a.dueDate, today) - dueUrgency(b.dueDate, today);
    if (urgencyDiff !== 0) return urgencyDiff;

    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) {
      return a.dueDate.localeCompare(b.dueDate);
    }

    const prioA = a.priority && a.priority in priorityRank ? priorityRank[a.priority] : 3;
    const prioB = b.priority && b.priority in priorityRank ? priorityRank[b.priority] : 3;
    return prioA - prioB;
  });
}

function formatDueBadge(dueDate: string, today: string): { text: string; kind: string } {
  const short = dueDate.slice(5);
  if (dueDate < today) return { text: `已逾期 · ${short}`, kind: "overdue" };
  if (dueDate === today) return { text: "今天到期", kind: "today" };
  return { text: `${short} 到期`, kind: "upcoming" };
}

export function TaskPanel({ tasks, onToggleDone }: TaskPanelProps) {
  const today = formatLocalDate(new Date());
  const byId = new Set(tasks.map((item) => item.id));

  const childrenByParent = new Map<string, Task[]>();
  const roots: Task[] = [];

  for (const task of tasks) {
    if (task.parentId && byId.has(task.parentId)) {
      const list = childrenByParent.get(task.parentId) ?? [];
      list.push(task);
      childrenByParent.set(task.parentId, list);
    } else {
      roots.push(task);
    }
  }

  const pendingRoots = sortPendingTasks(
    roots.filter((task) => !task.done),
    today,
  );
  const completedRoots = roots.filter((task) => task.done);

  function renderBadges(task: Task, subtasks: Task[]) {
    const badges = [];

    if (task.dueDate && !task.done) {
      const due = formatDueBadge(task.dueDate, today);
      badges.push(
        <span key="due" className={`badge ${due.kind}`}>
          {due.text}
        </span>,
      );
    } else if (task.dueDate && task.done) {
      badges.push(
        <span key="due" className="badge muted">
          {task.dueDate.slice(5)}
        </span>,
      );
    }

    if (task.priority && task.priority in priorityLabels) {
      badges.push(
        <span key="priority" className={`badge priority-${task.priority}`}>
          {priorityLabels[task.priority]}
        </span>,
      );
    }

    if (task.effort && task.effort in effortLabels) {
      badges.push(
        <span key="effort" className="badge effort">
          工作量·{effortLabels[task.effort]}
        </span>,
      );
    }

    if (subtasks.length > 0) {
      const finished = subtasks.filter((item) => item.done).length;
      badges.push(
        <span key="subtasks" className="badge progress">
          子任务 {finished}/{subtasks.length}
        </span>,
      );
    }

    return badges.length > 0 ? <div className="badges">{badges}</div> : null;
  }

  function renderTaskItem(task: Task) {
    const subtasks = childrenByParent.get(task.id) ?? [];
    return (
      <li key={task.id} className={`task-item ${task.done ? "is-done" : ""}`}>
        <div className="task-row">
          <button
            type="button"
            className="check"
            aria-label={
              task.done ? `将「${task.title}」标为未完成` : `将「${task.title}」标为已完成`
            }
            aria-pressed={task.done}
            onClick={() => onToggleDone(task.id, !task.done)}
          >
            {task.done ? "✓" : ""}
          </button>
          <div className="task-body">
            <span className="task-title">{task.title}</span>
            {renderBadges(task, subtasks)}
          </div>
        </div>
        {subtasks.length > 0 && (
          <ul className="subtask-list">
            {subtasks.map((sub) => (
              <li key={sub.id} className={`subtask-item ${sub.done ? "is-done" : ""}`}>
                <button
                  type="button"
                  className="check small"
                  aria-label={
                    sub.done
                      ? `将子任务「${sub.title}」标为未完成`
                      : `将子任务「${sub.title}」标为已完成`
                  }
                  aria-pressed={sub.done}
                  onClick={() => onToggleDone(sub.id, !sub.done)}
                >
                  {sub.done ? "✓" : ""}
                </button>
                <span className="task-title">{sub.title}</span>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <aside className="task-panel" aria-label="实时待办清单">
      <div className="panel-header">
        <h2>待办清单</h2>
        <span>{pendingRoots.length} 项待处理</span>
      </div>

      {tasks.length === 0 ? (
        <p className="panel-empty">还没有待办事项，在对话里告诉小明要记什么吧。</p>
      ) : (
        <div className="panel-scroll">
          <section className="task-section">
            <h3>待处理 · {pendingRoots.length}</h3>
            {pendingRoots.length === 0 ? (
              <p className="all-clear">待办已全部清空。</p>
            ) : (
              <ul className="task-list">{pendingRoots.map(renderTaskItem)}</ul>
            )}
          </section>

          {completedRoots.length > 0 && (
            <details className="completed-group" open={pendingRoots.length === 0}>
              <summary>已完成 · {completedRoots.length}</summary>
              <ul className="task-list">{completedRoots.map(renderTaskItem)}</ul>
            </details>
          )}
        </div>
      )}
    </aside>
  );
}
