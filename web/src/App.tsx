import { CopilotChat, CopilotKitProvider } from "@copilotkit/react-core/v2";
import { useCallback, useEffect, useState } from "react";
import {
  STATUS_LABEL,
  deleteThread,
  getThread,
  listThreads,
  saveInstructions,
  startBackgroundRun,
  type ThreadSummary,
} from "./api";
import { AgentTools } from "./tools";

const AGENT_ID = "support_desk";

/** The open thread lives in the URL, so a reload or a second tab opens the same one. */
function useThreadId(): [string, (id: string) => void] {
  const read = () => window.location.hash.slice(1);
  const [threadId, setThreadId] = useState(() => {
    const existing = read();
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    window.location.hash = fresh;
    return fresh;
  });
  useEffect(() => {
    const onChange = () => setThreadId(read() || crypto.randomUUID());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const open = useCallback((id: string) => {
    window.location.hash = id;
  }, []);
  return [threadId, open];
}

/** Status is derived on the server. The page just asks for it on a short timer. */
function usePolling<T>(load: () => Promise<T>, initial: T, deps: unknown[]): T {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    let active = true;
    const tick = () => load().then((next) => active && setValue(next), () => {});
    void tick();
    const timer = setInterval(tick, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

function StatusBadge({ status }: { status: ThreadSummary["status"] }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}

const NOTICE: Partial<Record<ThreadSummary["status"], string>> = {
  connection_lost: "The connection to the agent was lost. The partial answer was kept. Send a message to continue.",
  waiting_approval: "The agent is waiting for your approval.",
  cancelled: "This run was stopped.",
  error: "The last run ended with an error.",
};

function Instructions({ thread }: { thread: ThreadSummary }) {
  const saved = thread.settings?.instructions ?? "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved, thread.id]);
  return (
    <form
      className="instructions"
      onSubmit={(event) => {
        event.preventDefault();
        void saveInstructions(thread.id, draft);
      }}
    >
      <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Instructions for this conversation (optional)" />
      <button type="submit" disabled={draft === saved}>
        Save
      </button>
      {thread.settingsPending && <span className="hint">Applies on your next message</span>}
    </form>
  );
}

export function App() {
  const [threadId, openThread] = useThreadId();
  const threads = usePolling(listThreads, [] as ThreadSummary[], []);
  const current = usePolling(
    () => getThread(threadId),
    { id: threadId, title: null, status: "idle", busy: false, latestRun: null } as ThreadSummary,
    [threadId],
  );
  const notice = NOTICE[current.status];

  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit" agentId={AGENT_ID} enableInspector={false}>
      <AgentTools agentId={AGENT_ID} />
      <div className="layout">
        <aside className="sidebar">
          <div className="brand">Relay</div>
          <button className="primary" onClick={() => openThread(crypto.randomUUID())}>
            New conversation
          </button>
          <button
            title="Starts a run on the server. No browser is attached to it; open the conversation to watch or read the result."
            onClick={() => {
              const id = crypto.randomUUID();
              void startBackgroundRun(id, "Give me a slow answer about order A-1001");
            }}
          >
            Start a background run
          </button>
          <nav>
            {threads.map((thread) => (
              <div key={thread.id} className={`thread ${thread.id === threadId ? "active" : ""}`} onClick={() => openThread(thread.id)}>
                <div className="thread-title">{thread.title ?? "Untitled"}</div>
                <div className="thread-meta">
                  <StatusBadge status={thread.status} />
                  <button
                    className="link"
                    onClick={(event) => {
                      event.stopPropagation();
                      void deleteThread(thread.id);
                      if (thread.id === threadId) openThread(crypto.randomUUID());
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {threads.length === 0 && <div className="empty">No conversations yet.</div>}
          </nav>
        </aside>
        <main className="main">
          <header className="header">
            <div className="header-title">{current.title ?? "New conversation"}</div>
            <StatusBadge status={current.status} />
          </header>
          <Instructions thread={current} />
          {notice && <div className={`notice notice-${current.status}`}>{notice}</div>}
          <div className="chat">
            {/* Keyed by thread so each conversation gets a fresh chat that connects and replays. */}
            <CopilotChat
              key={threadId}
              agentId={AGENT_ID}
              threadId={threadId}
              labels={{ chatInputPlaceholder: "Try: order A-1001, a refund, a chart, or a slow answer" }}
            />
          </div>
        </main>
      </div>
    </CopilotKitProvider>
  );
}
