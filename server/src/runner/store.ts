/**
 * Every statement the runner sends to Postgres.
 *
 * Rules that the rest of the runner relies on:
 *
 * 1. Time is the database clock. Leases are set and compared with
 *    clock_timestamp(), so servers with drifting clocks still agree.
 * 2. A driver's writes are fenced. They only succeed while the run row still
 *    names that driver as lease holder, is still active, and the lease has not
 *    expired. The check takes a row lock on the run, so it cannot interleave
 *    with the sweeper settling the same run.
 * 3. Sequence numbers come from `threads.last_seq`, bumped under a row lock
 *    that is held until commit. Commit order therefore equals sequence order,
 *    and a reader that asks for "seq > N" never skips an event.
 * 4. Lock order is always run row, then thread row.
 */

import { EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client";
import { finalizeRunEvents } from "@copilotkit/runtime/v2";
import type { Db, Tx } from "../db.ts";
import { AlreadyResumedError, ApprovalPendingError, LeaseLostError, ThreadBusyError } from "./errors.ts";
import { TRANSITIONS, type RunStatus, type WaitingFor } from "./status.ts";

export const EVENTS_CHANNEL = "relay_events";
export const CONTROL_CHANNEL = "relay_control";

/** Identifies a driver's claim on a run. Sent with every write it makes. */
export interface Fence {
  threadId: string;
  runId: string;
  holder: string;
}

export interface StoredEvent {
  seq: number;
  runId: string;
  event: BaseEvent;
}

export interface RunRow {
  id: string;
  threadId: string;
  number: number;
  status: RunStatus;
  trigger: string;
  waitingFor: WaitingFor | null;
  waitingPayload: unknown;
  resumesRunId: string | null;
  error: string | null;
  leaseHolder: string | null;
  leaseAlive: boolean;
  createdAt: Date;
  finishedAt: Date | null;
}

const RUN_COLUMNS = `
  id, thread_id AS "threadId", number, status::text AS status, trigger,
  waiting_for AS "waitingFor", waiting_payload AS "waitingPayload",
  resumes_run_id AS "resumesRunId", error, lease_holder AS "leaseHolder",
  COALESCE(lease_expires_at > clock_timestamp(), false) AS "leaseAlive",
  created_at AS "createdAt", finished_at AS "finishedAt"`;

type Sql = Db | Tx;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const seconds = (ms: number) => ms / 1000;

function isUniqueViolation(error: unknown): boolean {
  const text = JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})) + String(error);
  return text.includes("23505") || text.includes("P2002");
}

/** `rawEvent` repeats the framework's native event. It is large and not needed for replay. */
export function slim(event: BaseEvent): BaseEvent {
  if (!("rawEvent" in event)) return event;
  const { rawEvent: _dropped, ...rest } = event;
  return rest as BaseEvent;
}

/** Message ids an event introduces, for the thread's message ledger. */
function messageIdsOf(events: BaseEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    const e = event as BaseEvent & { messageId?: unknown; parentMessageId?: unknown; messages?: unknown };
    if (event.type === EventType.TEXT_MESSAGE_START || event.type === EventType.TOOL_CALL_RESULT) {
      if (typeof e.messageId === "string") ids.add(e.messageId);
    } else if (event.type === EventType.TOOL_CALL_START) {
      if (typeof e.parentMessageId === "string") ids.add(e.parentMessageId);
    } else if (event.type === EventType.MESSAGES_SNAPSHOT && Array.isArray(e.messages)) {
      for (const message of e.messages as Message[]) if (message?.id) ids.add(message.id);
    }
  }
  return [...ids];
}

/** True when the input answers an interrupt, by either AG-UI channel. */
export function hasResume(input: RunAgentInput): boolean {
  const standard = (input as { resume?: unknown[] }).resume;
  if (Array.isArray(standard) && standard.length > 0) return true;
  const command = (input.forwardedProps as { command?: { resume?: unknown } } | undefined)?.command;
  return command?.resume !== undefined && command.resume !== null;
}

function titleFrom(messages: Message[]): string | null {
  const first = messages.find((m) => m.role === "user");
  if (!first || typeof first.content !== "string") return null;
  const text = first.content.trim().replace(/\s+/g, " ");
  return text ? text.slice(0, 80) : null;
}

/**
 * Appends events and tells listeners. The caller must already hold whatever
 * makes the write legitimate (a fence check, or the transition it just made).
 */
async function append(sql: Sql, threadId: string, runId: string, events: BaseEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const payload = JSON.stringify(events);
  const ids = messageIdsOf(events);
  const rows = await sql.$queryRaw<{ last_seq: bigint }[]>`
    WITH alloc AS (
      UPDATE threads SET last_seq = last_seq + ${events.length}, updated_at = clock_timestamp()
      WHERE id = ${threadId}
      RETURNING last_seq
    ), ins AS (
      INSERT INTO events (thread_id, seq, run_id, type, payload)
      SELECT ${threadId}, alloc.last_seq - ${events.length} + e.ord, ${runId}, e.payload->>'type', e.payload
      FROM alloc, jsonb_array_elements(${payload}::jsonb) WITH ORDINALITY AS e(payload, ord)
    ), ledger AS (
      INSERT INTO thread_messages (thread_id, message_id)
      SELECT ${threadId}, unnest(${ids}::text[]) FROM alloc
      ON CONFLICT DO NOTHING
    )
    SELECT alloc.last_seq, pg_notify(${EVENTS_CHANNEL}, ${threadId})::text FROM alloc`;
  return Number(rows[0]!.last_seq);
}

// ---------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------

export interface CreateRunParams {
  threadId: string;
  runId: string;
  ownerId: string;
  agentId: string;
  trigger: "chat" | "api";
  input: RunAgentInput;
  holder: string;
  leaseTtlMs: number;
}

export interface CreatedRun {
  fence: Fence;
  /** The RUN_STARTED event, already committed. Carries only the new messages. */
  started: BaseEvent;
  /** What to send to the agent. May contain tool results the runner filled in. */
  agentInput: RunAgentInput;
  resumesRunId: string | null;
  /** The thread's settings, as of this run. */
  settings: Record<string, unknown>;
}

/**
 * Admits a run or refuses it, in one transaction:
 *
 *   - refuses when a run is already active                  (ThreadBusyError)
 *   - refuses a new message while an approval is pending     (ApprovalPendingError)
 *   - lets exactly one request answer a pending approval     (AlreadyResumedError for the rest)
 *   - picks up a run parked on browser tools, filling in a failure result for
 *     any tool that never reported back
 *   - saves the new input messages and the RUN_STARTED event
 *   - takes the lease
 *
 * The thread row is created here and nowhere else, so looking at a thread
 * never creates one.
 */
export async function createRun(db: Db, p: CreateRunParams): Promise<CreatedRun> {
  // A dead driver must not block the thread until the next sweep.
  await reapExpired(db, { threadId: p.threadId });

  try {
    return await db.$transaction((tx) => createRunTx(tx, p), { timeout: 15_000 });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ThreadBusyError();
    throw error;
  }
}

async function createRunTx(tx: Tx, p: CreateRunParams): Promise<CreatedRun> {
  await tx.$executeRaw`
    INSERT INTO threads (id, owner_id, agent_id) VALUES (${p.threadId}, ${p.ownerId}, ${p.agentId})
    ON CONFLICT (id) DO NOTHING`;
  // The lock serializes run admission per thread.
  const [thread] = await tx.$queryRaw<{ run_count: number; settings: Record<string, unknown> }[]>`
    SELECT run_count, settings FROM threads WHERE id = ${p.threadId} FOR UPDATE`;
  const latest = await latestRun(tx, p.threadId);
  const resume = hasResume(p.input);

  if (latest && (latest.status === "running" || latest.status === "stopping")) {
    throw resume ? new AlreadyResumedError() : new ThreadBusyError();
  }
  const parkedOn = latest?.status === "parked" ? latest.waitingFor : null;
  if (resume && parkedOn !== "approval") throw new AlreadyResumedError();
  if (!resume && parkedOn === "approval") throw new ApprovalPendingError();

  let messages = [...(p.input.messages ?? [])];
  let resumesRunId: string | null = null;
  if (latest && parkedOn) {
    // The claim. It names the state it expects, so it can only succeed once.
    const claimed = await tx.$executeRaw`
      UPDATE runs SET status = 'resumed' WHERE id = ${latest.id} AND status = 'parked'`;
    if (claimed !== 1) throw new AlreadyResumedError();
    resumesRunId = latest.id;
    if (parkedOn === "client_tool") messages = fillMissingToolResults(messages, latest.waitingPayload);
  }

  const ids = messages.map((m) => m.id);
  const fresh = await tx.$queryRaw<{ message_id: string }[]>`
    INSERT INTO thread_messages (thread_id, message_id)
    SELECT ${p.threadId}, unnest(${ids}::text[])
    ON CONFLICT DO NOTHING
    RETURNING message_id`;
  const freshIds = new Set(fresh.map((row) => row.message_id));
  const newMessages = messages.filter((m) => freshIds.has(m.id));

  const recorded = { ...p.input, messages: newMessages };
  const number = thread!.run_count + 1;
  await tx.$executeRaw`
    UPDATE threads
    SET run_count = ${number}, title = COALESCE(title, ${titleFrom(newMessages)}),
        applied_settings_version = settings_version
    WHERE id = ${p.threadId}`;
  await tx.$executeRaw`
    INSERT INTO runs (id, thread_id, number, status, trigger, input, lease_holder, lease_expires_at, resumes_run_id)
    VALUES (${p.runId}, ${p.threadId}, ${number}, 'running', ${p.trigger}, ${JSON.stringify(recorded)}::jsonb,
            ${p.holder}, clock_timestamp() + make_interval(secs => ${seconds(p.leaseTtlMs)}), ${resumesRunId})`;

  const started = { type: EventType.RUN_STARTED, threadId: p.threadId, runId: p.runId, input: recorded } as BaseEvent;
  await append(tx, p.threadId, p.runId, [started]);

  return {
    fence: { threadId: p.threadId, runId: p.runId, holder: p.holder },
    started,
    agentInput: { ...p.input, messages },
    resumesRunId,
    settings: thread!.settings ?? {},
  };
}

export const TOOL_DID_NOT_REPORT = "The tool did not report back.";

/** Gives every unanswered browser tool call a failure result, placed where the answers belong. */
function fillMissingToolResults(messages: Message[], waitingPayload: unknown): Message[] {
  const pending = (waitingPayload as { toolCallIds?: string[] } | null)?.toolCallIds ?? [];
  const answered = new Set(
    messages.filter((m) => m.role === "tool").map((m) => (m as { toolCallId: string }).toolCallId),
  );
  const missing = pending.filter((id) => !answered.has(id));
  if (missing.length === 0) return messages;

  const synthetic = missing.map(
    (toolCallId) =>
      ({
        id: `${toolCallId}-result`,
        role: "tool",
        toolCallId,
        content: JSON.stringify({ status: "error", message: TOOL_DID_NOT_REPORT }),
        error: TOOL_DID_NOT_REPORT,
      }) as Message,
  );
  // Results go right after the assistant message that made the calls.
  const callerIndex = messages.findLastIndex(
    (m) =>
      m.role === "assistant" &&
      ((m as { toolCalls?: { id: string }[] }).toolCalls ?? []).some((call) => missing.includes(call.id)),
  );
  const at = callerIndex === -1 ? messages.length : callerIndex + 1;
  return [...messages.slice(0, at), ...synthetic, ...messages.slice(at)];
}

// ---------------------------------------------------------------------------
// While a run is active
// ---------------------------------------------------------------------------

/**
 * Commits a batch of events for a driver. One statement: check the fence,
 * allocate sequence numbers, insert, notify. Throws LeaseLostError when the
 * driver is no longer entitled to write, in which case nothing was written.
 */
export async function appendFenced(db: Db, fence: Fence, events: BaseEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const payload = JSON.stringify(events);
  const ids = messageIdsOf(events);
  const rows = await db.$queryRaw<{ last_seq: bigint }[]>`
    WITH fence AS (
      SELECT 1 FROM runs
      WHERE id = ${fence.runId} AND lease_holder = ${fence.holder}
        AND status IN ('running', 'stopping') AND lease_expires_at > clock_timestamp()
      FOR UPDATE
    ), alloc AS (
      UPDATE threads SET last_seq = last_seq + ${events.length}, updated_at = clock_timestamp()
      WHERE id = ${fence.threadId} AND EXISTS (SELECT 1 FROM fence)
      RETURNING last_seq
    ), ins AS (
      INSERT INTO events (thread_id, seq, run_id, type, payload)
      SELECT ${fence.threadId}, alloc.last_seq - ${events.length} + e.ord, ${fence.runId}, e.payload->>'type', e.payload
      FROM alloc, jsonb_array_elements(${payload}::jsonb) WITH ORDINALITY AS e(payload, ord)
    ), ledger AS (
      INSERT INTO thread_messages (thread_id, message_id)
      SELECT ${fence.threadId}, unnest(${ids}::text[]) FROM alloc
      ON CONFLICT DO NOTHING
    )
    SELECT alloc.last_seq, pg_notify(${EVENTS_CHANNEL}, ${fence.threadId})::text FROM alloc`;
  if (rows.length === 0) throw new LeaseLostError();
  return Number(rows[0]!.last_seq);
}

/** Extends the lease. Returns the run's status, or null when the lease is gone. */
export async function renewLease(db: Db, fence: Fence, leaseTtlMs: number): Promise<RunStatus | null> {
  const rows = await db.$queryRaw<{ status: RunStatus }[]>`
    UPDATE runs SET lease_expires_at = clock_timestamp() + make_interval(secs => ${seconds(leaseTtlMs)})
    WHERE id = ${fence.runId} AND lease_holder = ${fence.holder}
      AND status IN ('running', 'stopping') AND lease_expires_at > clock_timestamp()
    RETURNING status::text AS status`;
  return rows[0]?.status ?? null;
}

/**
 * Asks the active run on a thread to stop. A single transition, so however
 * many servers or tabs ask, one of them gets `true`. The driver may be on a
 * different server: it learns of the stop from the control channel, or at its
 * next lease renewal at the latest.
 */
export async function requestStop(db: Db, threadId: string, runId?: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH stopped AS (
      UPDATE runs SET status = 'stopping', stop_requested_at = clock_timestamp()
      WHERE thread_id = ${threadId} AND status = 'running' AND (${runId ?? null}::text IS NULL OR id = ${runId ?? null})
      RETURNING id
    )
    SELECT id, pg_notify(${CONTROL_CHANNEL}, id)::text FROM stopped`;
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Ending a run
// ---------------------------------------------------------------------------

export interface RunOutcome {
  status: Exclude<RunStatus, "running" | "stopping" | "resumed">;
  closingEvents: BaseEvent[];
  waitingFor?: WaitingFor;
  waitingPayload?: unknown;
  error?: string;
}

/**
 * The driver's last write: move the run to its end state, release the lease
 * and append the closing events, atomically.
 *
 * Returns false when the transition was not allowed from the run's current
 * state, for example the driver wants `completed` but a stop arrived first.
 */
export async function finishRun(db: Db, fence: Fence, outcome: RunOutcome): Promise<boolean> {
  const from = (Object.keys(TRANSITIONS) as RunStatus[]).filter((s) => TRANSITIONS[s].includes(outcome.status));
  return db.$transaction(async (tx) => {
    const moved = await tx.$executeRaw`
      UPDATE runs
      SET status = ${outcome.status}::run_status, lease_expires_at = NULL, finished_at = clock_timestamp(),
          waiting_for = ${outcome.waitingFor ?? null},
          waiting_payload = ${outcome.waitingPayload === undefined ? null : JSON.stringify(outcome.waitingPayload)}::jsonb,
          error = ${outcome.error ?? null}
      WHERE id = ${fence.runId} AND lease_holder = ${fence.holder}
        AND status::text = ANY(${from}::text[]) AND lease_expires_at > clock_timestamp()`;
    if (moved !== 1) return false;
    if (outcome.closingEvents.length > 0) await append(tx, fence.threadId, fence.runId, outcome.closingEvents);
    else await tx.$executeRaw`SELECT pg_notify(${EVENTS_CHANNEL}, ${fence.threadId})::text`;
    return true;
  });
}

export const CONNECTION_LOST = "The connection to the agent was lost. The partial answer was kept.";

/**
 * Settles runs whose lease expired: the server driving them crashed, was
 * redeployed, or lost its database connection for too long.
 *
 * Any server may do this. The run's log is closed properly (open messages and
 * tool calls are ended, then a terminal event is added), so the partial answer
 * stays readable and the client is told what happened. A run that was already
 * stopping ends as `cancelled`; otherwise as `orphaned`.
 *
 * SKIP LOCKED lets several sweepers run at once without waiting on each other.
 */
export async function reapExpired(db: Db, scope: { threadId?: string } = {}): Promise<number> {
  return db.$transaction(async (tx) => {
    const expired = await tx.$queryRaw<{ id: string; thread_id: string; status: RunStatus }[]>`
      SELECT id, thread_id, status::text AS status FROM runs
      WHERE status IN ('running', 'stopping') AND lease_expires_at <= clock_timestamp()
        AND (${scope.threadId ?? null}::text IS NULL OR thread_id = ${scope.threadId ?? null})
      ORDER BY lease_expires_at
      LIMIT 50
      FOR UPDATE SKIP LOCKED`;

    for (const run of expired) {
      const stopping = run.status === "stopping";
      const log = (await readRunEvents(tx, run.id)).map((stored) => stored.event);
      const closing = finalizeRunEvents(
        log,
        stopping ? { stopRequested: true } : { interruptionMessage: CONNECTION_LOST },
      ) as BaseEvent[];
      for (const event of closing) {
        if (event.type === EventType.RUN_ERROR) (event as { code?: string }).code = "CONNECTION_LOST";
      }
      await tx.$executeRaw`
        UPDATE runs
        SET status = ${stopping ? "cancelled" : "orphaned"}::run_status, lease_expires_at = NULL,
            finished_at = clock_timestamp(), error = ${stopping ? null : CONNECTION_LOST}
        WHERE id = ${run.id}`;
      await append(tx, run.thread_id, run.id, closing);
    }
    return expired.length;
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function latestRun(sql: Sql, threadId: string): Promise<RunRow | null> {
  const rows = await sql.$queryRawUnsafe<RunRow[]>(
    `SELECT ${RUN_COLUMNS} FROM runs WHERE thread_id = $1 ORDER BY number DESC LIMIT 1`,
    threadId,
  );
  return rows[0] ?? null;
}

type EventRecord = { seq: bigint; run_id: string; payload: BaseEvent };
const toStored = (row: EventRecord): StoredEvent => ({ seq: Number(row.seq), runId: row.run_id, event: row.payload });

/** Events after a sequence number, oldest first. */
export async function readEventsAfter(sql: Sql, threadId: string, afterSeq: number, limit = 1000): Promise<StoredEvent[]> {
  const rows = await sql.$queryRaw<EventRecord[]>`
    SELECT seq, run_id, payload FROM events
    WHERE thread_id = ${threadId} AND seq > ${afterSeq}
    ORDER BY seq LIMIT ${limit}`;
  return rows.map(toStored);
}

export async function readRunEvents(sql: Sql, runId: string): Promise<StoredEvent[]> {
  const rows = await sql.$queryRaw<EventRecord[]>`
    SELECT seq, run_id, payload FROM events WHERE run_id = ${runId} ORDER BY seq`;
  return rows.map(toStored);
}

export interface ReplayAnchor {
  /** Replay raw events after this sequence number. */
  afterSeq: number;
  /** State to restore before those events, when history was skipped. */
  messages: BaseEvent | null;
  state: BaseEvent | null;
}

/**
 * Decides where a reader should start.
 *
 * Replaying a long thread from its first event gets slower with every run. If
 * an earlier run left a MESSAGES_SNAPSHOT that already contains everything
 * before the latest run, the reader can start from that snapshot and replay
 * only the latest run. The snapshot must be the last word of the earlier
 * history: if any message or tool-call event follows it before the latest run
 * begins, it is not safe and the reader replays from the start instead.
 */
export async function findReplayAnchor(sql: Sql, threadId: string, latestRunId: string): Promise<ReplayAnchor> {
  const fromStart: ReplayAnchor = { afterSeq: 0, messages: null, state: null };
  const [first] = await sql.$queryRaw<{ seq: bigint | null }[]>`
    SELECT min(seq) AS seq FROM events WHERE run_id = ${latestRunId}`;
  if (first?.seq == null) return fromStart;
  const runStart = Number(first.seq);

  const [snapshot] = await sql.$queryRaw<EventRecord[]>`
    SELECT seq, run_id, payload FROM events
    WHERE thread_id = ${threadId} AND type = 'MESSAGES_SNAPSHOT' AND seq < ${runStart}
    ORDER BY seq DESC LIMIT 1`;
  if (!snapshot) return fromStart;

  const [later] = await sql.$queryRaw<{ found: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM events
      WHERE thread_id = ${threadId} AND seq > ${snapshot.seq} AND seq < ${runStart}
        AND (type LIKE 'TEXT_MESSAGE%' OR type LIKE 'TOOL_CALL%')
    ) AS found`;
  if (later?.found) return fromStart;

  const [state] = await sql.$queryRaw<EventRecord[]>`
    SELECT seq, run_id, payload FROM events
    WHERE thread_id = ${threadId} AND type = 'STATE_SNAPSHOT' AND seq < ${runStart}
    ORDER BY seq DESC LIMIT 1`;
  return { afterSeq: runStart - 1, messages: snapshot.payload, state: state?.payload ?? null };
}

export interface ThreadRow {
  id: string;
  title: string | null;
  agentId: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  settings: Record<string, unknown>;
  /** True when settings changed since the agent last ran. They apply on the next run. */
  settingsPending: boolean;
  run: Pick<RunRow, "id" | "status" | "waitingFor" | "leaseAlive" | "error" | "trigger"> | null;
}

const THREAD_QUERY = `
  SELECT t.id, t.title, t.agent_id AS "agentId", t.owner_id AS "ownerId",
         t.created_at AS "createdAt", t.updated_at AS "updatedAt", t.settings,
         t.settings_version > t.applied_settings_version AS "settingsPending",
         CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object(
           'id', r.id, 'status', r.status, 'waitingFor', r.waiting_for, 'error', r.error, 'trigger', r.trigger,
           'leaseAlive', COALESCE(r.lease_expires_at > clock_timestamp(), false)) END AS run
  FROM threads t
  LEFT JOIN LATERAL (SELECT * FROM runs WHERE thread_id = t.id ORDER BY number DESC LIMIT 1) r ON true`;

export async function listThreads(db: Db, ownerId: string): Promise<ThreadRow[]> {
  return db.$queryRawUnsafe<ThreadRow[]>(
    `${THREAD_QUERY} WHERE t.owner_id = $1 AND t.run_count > 0 ORDER BY t.updated_at DESC LIMIT 100`,
    ownerId,
  );
}

export async function getThread(db: Db, threadId: string): Promise<ThreadRow | null> {
  const rows = await db.$queryRawUnsafe<ThreadRow[]>(`${THREAD_QUERY} WHERE t.id = $1`, threadId);
  return rows[0] ?? null;
}

/**
 * Changes a thread's agent settings. Nothing is rebuilt here: the next run
 * reads them. Viewing or reconnecting never applies settings.
 */
export async function updateSettings(db: Db, threadId: string, ownerId: string, agentId: string, patch: Record<string, unknown>) {
  await db.$executeRaw`
    INSERT INTO threads (id, owner_id, agent_id, settings, settings_version)
    VALUES (${threadId}, ${ownerId}, ${agentId}, ${JSON.stringify(patch)}::jsonb, 1)
    ON CONFLICT (id) DO UPDATE
    SET settings = threads.settings || EXCLUDED.settings, settings_version = threads.settings_version + 1`;
}

export async function deleteThread(db: Db, threadId: string): Promise<void> {
  await db.$executeRaw`DELETE FROM threads WHERE id = ${threadId}`;
}
