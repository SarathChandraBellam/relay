export type ThreadStatus =
  | "idle"
  | "running"
  | "stopping"
  | "waiting_approval"
  | "waiting_client_tool"
  | "connection_lost"
  | "cancelled"
  | "error";

export interface ThreadSummary {
  id: string;
  title: string | null;
  status: ThreadStatus;
  busy: boolean;
  updatedAt?: string;
  settings?: { instructions?: string };
  settingsPending?: boolean;
  latestRun: { id: string; status: string; trigger: string; error: string | null } | null;
}

export const STATUS_LABEL: Record<ThreadStatus, string> = {
  idle: "Idle",
  running: "Working",
  stopping: "Stopping",
  waiting_approval: "Waiting for approval",
  waiting_client_tool: "Waiting for a tool",
  connection_lost: "Connection lost",
  cancelled: "Stopped",
  error: "Error",
};

const json = async <T,>(response: Response): Promise<T> => {
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
};

export const listThreads = () => fetch("/api/threads").then(json<ThreadSummary[]>);
export const getThread = (id: string) => fetch(`/api/threads/${id}`).then(json<ThreadSummary>);
export const deleteThread = (id: string) => fetch(`/api/threads/${id}`, { method: "DELETE" });

export const saveInstructions = (id: string, instructions: string) =>
  fetch(`/api/threads/${id}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instructions }),
  });

/** Starts a run on the server with no browser attached to it. */
export const startBackgroundRun = (id: string, message: string) =>
  fetch(`/api/threads/${id}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
