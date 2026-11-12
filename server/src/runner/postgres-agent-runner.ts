/**
 * The CopilotKit side of the runner. `CopilotRuntime` calls these four
 * methods; everything durable happens in executeRun, replayThread and the
 * store.
 */

import { EventType, type BaseEvent } from "@ag-ui/client";
import {
  AgentRunner,
  ThreadAlreadyRunningError,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { Observable, ReplaySubject } from "rxjs";
import { AlreadyResumedError, RunnerError, ThreadBusyError } from "./errors.ts";
import { executeRun, type RunnerDeps } from "./execute-run.ts";
import { replayThread } from "./replay.ts";
import { isActive } from "./status.ts";
import { latestRun, reapExpired, requestStop } from "./store.ts";

export class PostgresAgentRunner extends AgentRunner {
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: RunnerDeps,
    private readonly defaultAgentId: string,
  ) {
    super();
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    // The run is not tied to this subject's subscribers. If the browser goes
    // away the run carries on, and anyone can pick it up through connect().
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    executeRun(
      {
        threadId: request.threadId,
        agent: request.agent,
        input: request.input,
        ownerId: request.ownerId ?? "",
        agentId: request.agent.agentId ?? this.defaultAgentId,
        trigger: "chat",
      },
      this.deps,
      { next: (event) => subject.next(event), complete: () => subject.complete() },
    ).catch((error: unknown) => {
      if (error instanceof AlreadyResumedError) {
        // Two tabs answered the same approval. This one lost, so it simply
        // joins the run the other one started.
        replayThread(this.deps, request.threadId).subscribe(subject);
      } else if (error instanceof ThreadBusyError) {
        subject.error(new ThreadAlreadyRunningError());
      } else if (error instanceof RunnerError) {
        subject.next({ type: EventType.RUN_ERROR, message: error.message, code: error.code } as BaseEvent);
        subject.complete();
      } else {
        this.deps.log?.("run failed to start", error);
        subject.error(error);
      }
    });
    return subject.asObservable();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    return replayThread(this.deps, request.threadId);
  }

  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    const latest = await latestRun(this.deps.db, request.threadId);
    return !!latest && isActive(latest.status) && latest.leaseAlive;
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean> {
    return requestStop(this.deps.db, request.threadId, request.runId);
  }

  /**
   * Every server sweeps. Whichever notices an expired lease first settles the
   * run, so a thread never stays "running" after its driver is gone.
   */
  startSweeper(): void {
    if (this.sweeper) return;
    const tick = () =>
      reapExpired(this.deps.db).then(
        (count) => count > 0 && this.deps.log?.(`settled ${count} run(s) whose driver went away`),
        (error) => this.deps.log?.("sweep failed", error),
      );
    this.sweeper = setInterval(tick, this.deps.timings.sweepMs);
    void tick();
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}
