import { randomUUID } from "node:crypto";
import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client";
import { Observable, from } from "rxjs";
import type { RunnerTimings } from "../src/config.ts";
import { createDb, type Db } from "../src/db.ts";
import { executeRun, type RunnerDeps, type RunResult } from "../src/runner/execute-run.ts";
import { Notifier } from "../src/runner/notifier.ts";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://relay:relay@localhost:5432/relay_test";

export const fastTimings: RunnerTimings = {
  leaseTtlMs: 2_000,
  leaseRenewMs: 100,
  sweepMs: 100,
  batchMs: 5,
  tailPollMs: 40,
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const newThreadId = () => `test-${randomUUID()}`;

/** One "server": its own database pool, LISTEN connection and holder id. */
export async function createServer(timings: Partial<RunnerTimings> = {}): Promise<RunnerDeps & { close(): Promise<void> }> {
  const db: Db = createDb(TEST_DATABASE_URL);
  const notifier = new Notifier(TEST_DATABASE_URL);
  await notifier.start();
  return {
    db,
    notifier,
    holder: `server-${randomUUID().slice(0, 8)}`,
    timings: { ...fastTimings, ...timings },
    close: async () => {
      await notifier.close();
      await db.$disconnect();
    },
  };
}

type Step = BaseEvent | { wait: Promise<unknown> } | { sleep: number } | { fail: string };

/** An agent that plays back a fixed script. `wait` steps let a test hold it mid-run. */
export class ScriptedAgent extends AbstractAgent {
  private abort = new AbortController();

  constructor(private readonly script: (input: RunAgentInput) => Step[]) {
    super({ agentId: "test_agent" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const signal = this.abort.signal;
    return new Observable<BaseEvent>((subscriber) => {
      void (async () => {
        subscriber.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent);
        for (const step of this.script(input)) {
          if (signal.aborted) return subscriber.error(new Error("aborted"));
          const control = step as { wait?: Promise<unknown>; sleep?: number; fail?: string };
          if (control.wait) await Promise.race([control.wait, new Promise((r) => signal.addEventListener("abort", r))]);
          else if (control.sleep !== undefined) await sleep(control.sleep);
          else if (control.fail !== undefined) return subscriber.error(new Error(control.fail));
          else subscriber.next(step as BaseEvent);
        }
        if (signal.aborted) return subscriber.error(new Error("aborted"));
        subscriber.next({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent);
        subscriber.complete();
      })();
    });
  }

  abortRun(): void {
    this.abort.abort();
  }
}

export const text = (messageId: string, ...chunks: string[]): BaseEvent[] =>
  [
    { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
    ...chunks.map((delta) => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta })),
    { type: EventType.TEXT_MESSAGE_END, messageId },
  ] as BaseEvent[];

export const toolCall = (toolCallId: string, name: string, parentMessageId: string): BaseEvent[] =>
  [
    { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: name, parentMessageId },
    { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: "{}" },
    { type: EventType.TOOL_CALL_END, toolCallId },
  ] as BaseEvent[];

export const interrupt = (value: unknown): BaseEvent =>
  ({ type: EventType.CUSTOM, name: "on_interrupt", value }) as BaseEvent;

export const userMessage = (content: string, id: string = randomUUID()): Message => ({ id, role: "user", content });

export function runInput(threadId: string, messages: Message[], extra: Partial<RunAgentInput> = {}): RunAgentInput {
  return { threadId, runId: randomUUID(), messages, tools: [], context: [], state: {}, forwardedProps: {}, ...extra };
}

export const resumeProps = { forwardedProps: { command: { resume: { approved: true } } } };

export interface Started {
  events: BaseEvent[];
  done: Promise<RunResult>;
  input: RunAgentInput;
}

/** Starts a run and collects what the live client would receive. */
export function start(server: RunnerDeps, threadId: string, agent: AbstractAgent, input: RunAgentInput): Started {
  const events: BaseEvent[] = [];
  const done = executeRun({ threadId, agent, input, ownerId: "", agentId: "test_agent", trigger: "chat" }, server, {
    next: (event) => events.push(event),
    complete: () => {},
  });
  return { events, done, input };
}

export async function collect(stream: Observable<BaseEvent>): Promise<BaseEvent[]> {
  const events: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) =>
    stream.subscribe({ next: (event) => events.push(event), complete: resolve, error: reject }),
  );
  return events;
}

class PlaybackAgent extends AbstractAgent {
  constructor(private readonly events: BaseEvent[]) {
    super();
  }
  run(): Observable<BaseEvent> {
    return from(this.events);
  }
  protected connect(): Observable<BaseEvent> {
    return from(this.events);
  }
}

/**
 * Feeds a stream through the pipeline a real AG-UI client uses when it opens
 * a thread. That pipeline rejects any stream that breaks the protocol
 * (verifyEvents), and returns the messages the client would end up showing.
 */
export async function asClient(events: BaseEvent[]): Promise<{ id: string; role: string; content: unknown; toolCalls?: unknown }[]> {
  const agent = new PlaybackAgent(structuredClone(events));
  let protocolError: unknown;
  agent.subscribe({
    onRunFailed: ({ error }) => {
      // A stream that ends in RUN_ERROR is valid. Anything else is a broken stream.
      if (!events.some((event) => event.type === EventType.RUN_ERROR)) protocolError = error;
    },
  });
  await agent.connectAgent();
  if (protocolError) throw protocolError;
  return agent.messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    ...("toolCalls" in m && m.toolCalls ? { toolCalls: m.toolCalls } : {}),
  }));
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}
