/**
 * The run state machine, and how a thread's status is derived from it.
 *
 *                      ┌──────────► completed
 *                      ├──────────► failed
 *   (create) ► running ┼──────────► parked ───► resumed
 *                 │    └──────────► orphaned
 *                 ▼
 *              stopping ──────────► cancelled
 *
 * `running` and `stopping` are the only states with a driver. Everything else
 * is at rest. The transitions are enforced in SQL (each UPDATE names the
 * states it may leave), and this table is the single place that lists them.
 */

export type RunStatus =
  | "running"
  | "stopping"
  | "parked"
  | "resumed"
  | "completed"
  | "cancelled"
  | "failed"
  | "orphaned";

export const ACTIVE: readonly RunStatus[] = ["running", "stopping"];

export const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  running: ["stopping", "completed", "failed", "parked", "orphaned"],
  // A stop that loses the race with the agent's natural end still cancels:
  // the user asked for a stop and gets told it stopped.
  stopping: ["cancelled"],
  parked: ["resumed"],
  resumed: [],
  completed: [],
  cancelled: [],
  failed: [],
  orphaned: [],
};

export const isActive = (status: RunStatus) => ACTIVE.includes(status);
export const canTransition = (from: RunStatus, to: RunStatus) => TRANSITIONS[from].includes(to);

/** Why a parked run is waiting. */
export type WaitingFor = "approval" | "client_tool";

/** What the UI shows for a thread. Computed on read, never stored. */
export type ThreadStatus =
  | "idle"
  | "running"
  | "stopping"
  | "waiting_approval"
  | "waiting_client_tool"
  | "connection_lost"
  | "cancelled"
  | "error";

export interface RunSnapshot {
  status: RunStatus;
  waitingFor: string | null;
  /** Whether the lease was still valid on the database clock when read. */
  leaseAlive: boolean;
}

export function deriveThreadStatus(latest: RunSnapshot | null): ThreadStatus {
  if (!latest) return "idle";
  switch (latest.status) {
    case "running":
      // The row still says running, but nobody is renewing. The sweeper will
      // settle it shortly; readers do not have to wait for that.
      return latest.leaseAlive ? "running" : "connection_lost";
    case "stopping":
      return latest.leaseAlive ? "stopping" : "cancelled";
    case "parked":
      return latest.waitingFor === "client_tool" ? "waiting_client_tool" : "waiting_approval";
    case "orphaned":
      return "connection_lost";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    case "resumed":
    case "completed":
      return "idle";
  }
}

/** A four-value view for UIs that only know idle / running / stopping / error. */
export type SimpleStatus = "idle" | "running" | "stopping" | "error";

export function toSimpleStatus(status: ThreadStatus): SimpleStatus {
  switch (status) {
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    case "error":
    case "connection_lost":
      return "error";
    default:
      return "idle";
  }
}

/** True while the composer should be locked. */
export const isBusy = (status: ThreadStatus) => status === "running" || status === "stopping";
