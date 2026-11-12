/**
 * Drives one run of the agent from admission to its end state.
 *
 * This function knows nothing about HTTP. It takes a plain context, writes to
 * the log, and reports committed events to an optional listener. A browser
 * request, an API call or a scheduled job can all start a run the same way,
 * and a run keeps going when the browser that started it goes away.
 */

import { EventType, type AbstractAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import type { RunnerTimings } from "../config.ts";
import type { Db } from "../db.ts";
import { LeaseLostError, SaveFailedError, type RunnerError } from "./errors.ts";
import { closeLog } from "./close-log.ts";
import { EventWriter } from "./event-writer.ts";
import type { Notifier } from "./notifier.ts";
import type { RunStatus } from "./status.ts";
import { createRun, finishRun, renewLease, slim, type Fence, type RunOutcome } from "./store.ts";

export interface RunnerDeps {
  db: Db;
  notifier: Notifier;
  /** This server process, as a lease holder. */
  holder: string;
  timings: RunnerTimings;
  log?: (message: string, detail?: unknown) => void;
}

export interface RunContext {
  threadId: string;
  agent: AbstractAgent;
  input: RunAgentInput;
  ownerId: string;
  agentId: string;
  trigger: "chat" | "api";
}

export interface RunListener {
  next(event: BaseEvent): void;
  complete(): void;
}

export interface RunResult {
  runId: string;
  /** `lease_lost` means another server settled the run; this one wrote nothing more. */
  status: RunStatus | "lease_lost";
}

/**
 * Admits the run (throws a RunnerError if it is refused), then drives it.
 * Resolves when the run has reached an end state.
 */
export async function executeRun(ctx: RunContext, deps: RunnerDeps, listener?: RunListener): Promise<RunResult> {
  const { db, timings } = deps;
  const runId = ctx.input.runId;

  const created = await createRun(db, {
    threadId: ctx.threadId,
    runId,
    ownerId: ctx.ownerId,
    agentId: ctx.agentId,
    trigger: ctx.trigger,
    input: ctx.input,
    holder: deps.holder,
    leaseTtlMs: timings.leaseTtlMs,
  });
  const fence = created.fence;
  const agentInput = withSettings(created.agentInput, created.settings);
  ctx.agent.threadId = ctx.threadId;
  ctx.agent.setMessages(agentInput.messages);

  // From here on the run exists and this process owns it.
  listener?.next(created.started);
  const seen: BaseEvent[] = [created.started];
  let stopRequested = false;
  let failure: RunnerError | null = null;

  const abort = () => {
    try {
      ctx.agent.abortRun();
    } catch (error) {
      deps.log?.("abortRun failed", error);
    }
  };
  const stop = () => {
    if (stopRequested) return;
    stopRequested = true;
    abort();
  };

  const writer = new EventWriter({
    db,
    fence,
    batchMs: timings.batchMs,
    emit: (event) => listener?.next(event),
    onFailure: (error) => {
      failure = error;
      abort();
    },
  });

  // The lease is renewed on a timer. Each renewal also reads the run's status,
  // so a stop requested through any server is noticed here even if the
  // notification below is missed.
  const heartbeat = setInterval(() => {
    renewLease(db, fence, timings.leaseTtlMs).then(
      (status) => {
        if (status === "stopping") stop();
        else if (status === null && !failure) {
          failure = new LeaseLostError();
          abort();
        }
      },
      // A failed renewal is not fatal by itself. If the database stays
      // unreachable the lease expires and the next write is refused.
      (error) => deps.log?.("lease renewal failed", error),
    );
  }, timings.leaseRenewMs);
  const unsubscribeStop = deps.notifier.onStopRequested(runId, stop);

  let agentError: string | undefined;
  try {
    await ctx.agent.runAgent(agentInput, {
      onEvent: ({ event }) => {
        // The runner already wrote RUN_STARTED when it admitted the run.
        if (event.type === EventType.RUN_STARTED) return;
        // Once the run is being stopped or has lost its lease, the agent's
        // output no longer counts. That includes the error its own abort raises.
        if (stopRequested || failure) return;
        const kept = slim(event);
        seen.push(kept);
        writer.push(kept);
      },
    });
  } catch (error) {
    agentError = error instanceof Error ? error.message : String(error);
  }

  try {
    await writer.drain().catch(() => {});
    const status = await settle({ deps, fence, seen, stopRequested, failure, agentError, listener });
    return { runId, status };
  } finally {
    clearInterval(heartbeat);
    unsubscribeStop();
    listener?.complete();
  }
}

/** Thread settings reach the agent as AG-UI context, on every run. */
function withSettings(input: RunAgentInput, settings: Record<string, unknown>): RunAgentInput {
  const instructions = typeof settings.instructions === "string" ? settings.instructions.trim() : "";
  if (!instructions) return input;
  return {
    ...input,
    context: [...(input.context ?? []), { description: "Instructions set for this conversation", value: instructions }],
  };
}

interface SettleArgs {
  deps: RunnerDeps;
  fence: Fence;
  seen: BaseEvent[];
  stopRequested: boolean;
  failure: RunnerError | null;
  agentError: string | undefined;
  listener?: RunListener;
}

/** Works out how the run ended, records it, and tells the live client. */
async function settle(args: SettleArgs): Promise<RunResult["status"]> {
  const { deps, fence, seen, listener } = args;
  const emit = (events: BaseEvent[]) => events.forEach((event) => listener?.next(event));

  if (args.failure instanceof LeaseLostError) {
    // Another server has settled this run, or will. Writing now would
    // contradict it, so only this client's stream is closed.
    emit(closeLog(seen, { message: args.failure.message, code: args.failure.code }));
    return "lease_lost";
  }

  let outcome = args.stopRequested ? cancelled(seen) : describe(seen, args.failure, args.agentError);
  try {
    let recorded = await finishRun(deps.db, fence, outcome);
    if (!recorded && outcome.status !== "cancelled") {
      // The transition was refused. If a stop slipped in at the last moment the
      // run is `stopping`, and the only way out of that state is `cancelled`.
      const status = await renewLease(deps.db, fence, deps.timings.leaseTtlMs);
      if (status === "stopping") {
        outcome = cancelled(seen);
        recorded = await finishRun(deps.db, fence, outcome);
      }
    }
    if (!recorded) {
      emit(closeLog(seen, { message: new LeaseLostError().message, code: "LEASE_LOST" }));
      return "lease_lost";
    }
  } catch (error) {
    deps.log?.("could not record the end of the run", error);
    emit(closeLog(seen, { message: new SaveFailedError(error).message, code: "SAVE_FAILED" }));
    return "lease_lost";
  }
  emit(outcome.closingEvents);
  return outcome.status;
}

const cancelled = (seen: BaseEvent[]): RunOutcome => ({
  status: "cancelled",
  closingEvents: closeLog(seen, { stopped: true }),
});

/** Reads the run's own events to decide between completed, parked and failed. */
function describe(seen: BaseEvent[], failure: RunnerError | null, agentError: string | undefined): RunOutcome {
  if (failure) {
    return {
      status: "failed",
      error: failure.message,
      closingEvents: closeLog(seen, { message: failure.message, code: failure.code }),
    };
  }
  const closingEvents = closeLog(seen, { message: agentError });
  const all = [...seen, ...closingEvents];
  const runError = all.find((event) => event.type === EventType.RUN_ERROR) as { message?: string } | undefined;
  if (runError) return { status: "failed", error: runError.message ?? agentError ?? "The run failed.", closingEvents };

  const interrupts = pendingInterrupts(seen);
  if (interrupts.length > 0) {
    return { status: "parked", waitingFor: "approval", waitingPayload: { interrupts }, closingEvents };
  }
  const toolCallIds = unansweredToolCalls(seen);
  if (toolCallIds.length > 0) {
    return { status: "parked", waitingFor: "client_tool", waitingPayload: { toolCallIds }, closingEvents };
  }
  return { status: "completed", closingEvents };
}

/**
 * Interrupts the run ended on. Agents report them in one of two ways: the
 * AG-UI outcome on RUN_FINISHED, or a CUSTOM `on_interrupt` event.
 */
function pendingInterrupts(seen: BaseEvent[]): unknown[] {
  const found: unknown[] = [];
  for (const event of seen) {
    if (event.type === EventType.CUSTOM && (event as { name?: string }).name === "on_interrupt") {
      found.push((event as { value?: unknown }).value);
    }
    if (event.type === EventType.RUN_FINISHED) {
      const outcome = (event as { outcome?: { type?: string; interrupts?: unknown[] } }).outcome;
      if (outcome?.type === "interrupt") return outcome.interrupts?.length ? outcome.interrupts : found;
    }
  }
  return found;
}

/**
 * Tool calls the run made and did not answer. The agent runs its own tools
 * inside the run, so what is left over belongs to the browser: the run ends,
 * the browser executes the tool and starts a new run with the result.
 */
function unansweredToolCalls(seen: BaseEvent[]): string[] {
  const open = new Set<string>();
  for (const event of seen) {
    const id = (event as { toolCallId?: string }).toolCallId;
    if (!id) continue;
    if (event.type === EventType.TOOL_CALL_START) open.add(id);
    if (event.type === EventType.TOOL_CALL_RESULT) open.delete(id);
  }
  return [...open];
}
