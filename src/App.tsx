import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatMessage } from "../shared/chat.ts";
import type { Task } from "../shared/tasks.ts";
import { requestReply } from "./chat-client.ts";
import { ChatHistory } from "./ChatHistory.tsx";
import { fetchTasks, toggleTaskDone } from "./task-client.ts";
import { TaskPanel } from "./TaskPanel.tsx";

function isSendShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  // 中文输入法会用 Enter 确认选词，部分浏览器此时只报告键码 229。
  const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  return event.key === "Enter" && !event.shiftKey && !composing;
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 780);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  async function refreshTasks() {
    try {
      setTasks(await fetchTasks());
    } catch {
      // 侧栏静默刷新失败不阻塞主对话流程。
    }
  }

  useEffect(() => {
    void refreshTasks();
  }, []);

  async function handleToggleDone(id: string, done: boolean) {
    setTasks((prev) => prev.map((item) => (item.id === id ? { ...item, done } : item)));
    try {
      await toggleTaskDone(id, done);
    } finally {
      await refreshTasks();
    }
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || pending) return;
    const outgoing: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(outgoing);
    setDraft("");
    setPending(true);
    setError("");
    try {
      const answer = await requestReply(outgoing);
      setMessages([...outgoing, { role: "assistant", content: answer }]);
      await refreshTasks();
    } catch (cause) {
      setMessages(messages);
      setDraft(text);
      setError(cause instanceof Error ? `发送失败：${cause.message}` : "发送失败，请重试。");
    } finally {
      setPending(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  }

  const pendingCount = tasks.filter((item) => !item.parentId && !item.done).length;

  return (
    <div className="app">
      <header>
        <img src="/logo.png" alt="" />
        <strong>TokeNow</strong>
        <span className="brand-sub">小明智能体</span>
        <button
          type="button"
          className="panel-toggle"
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((open) => !open)}
        >
          清单
          <em className={pendingCount > 0 ? "active" : ""}>{pendingCount}</em>
        </button>
      </header>
      <div className="workspace">
        <main>
          <ChatHistory messages={messages} pending={pending} onSelectPrompt={send} />
          <div className="compose">
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send(draft);
              }}
            >
              <textarea
                aria-label="消息"
                ref={input}
                placeholder="输入消息…"
                rows={2}
                value={draft}
                readOnly={pending}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (isSendShortcut(event)) {
                    event.preventDefault();
                    void send(draft);
                  }
                }}
              />
              <button className="send" disabled={pending || !draft.trim()} aria-label="发送消息">
                ↑
              </button>
            </form>
            <small>Enter 发送 · Shift + Enter 换行</small>
          </div>
        </main>
        {panelOpen && (
          <>
            <div
              className="panel-backdrop"
              aria-hidden="true"
              onClick={() => setPanelOpen(false)}
            />
            <TaskPanel tasks={tasks} onToggleDone={handleToggleDone} />
          </>
        )}
      </div>
    </div>
  );
}
