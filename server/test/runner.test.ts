/**
 * The runner's guarantees, tested against a real Postgres.
 *
 * Each test builds one or more "servers" (separate pools, LISTEN connections
 * and holder ids) pointed at the same database, which is how the runner is
 * deployed.
 */

import { EventType, type BaseEvent } from "@ag-ui/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AlreadyResumedError, ApprovalPendingError, ThreadBusyError } from "../src/runner/errors.ts";
import { isLiveOnly } from "../src/runner/event-writer.ts";
import { replayThread } from "../src/runner/replay.ts";
import {
  TOOL_DID_NOT_REPORT,
  appendFenced,
  getThread,
  latestRun,
  readEventsAfter,
  reapExpired,
  requestStop,
} from "../src/runner/store.ts";
import {
  ScriptedAgent,
  asClient,
  collect,
  createServer,
  deferred,
  interrupt,
  newThreadId,
  resumeProps,
  runInput,
  sleep,
  start,
  text,
  toolCall,
  until,
  userMessage,
} from "./helpers.ts";

type Server = Awaited<ReturnType<typeof createServer>>;
let a: Server;
let b: Server;

beforeAll(async () => {
  a = await createServer();
  b = await createServer();
});
afterAll(async () => {
  await a.close();
  await b.close();
});

const types = (events: BaseEvent[]) => events.map((event) => event.type);
const stored = async (threadId: string) => (await readEventsAfter(a.db, threadId, 0, 10_000)).map((s) => s.event);
const settled = async (threadId: string) => (await latestRun(a.db, threadId))?.status;

describe("persist before emit", () => {
  it("never shows the client an event that is not committed", async () => {
    const threadId = newThreadId();
    const agent = new ScriptedAgent(() => text("m1", ..."the quick brown fox jumps over the lazy dog".split(" ")));
    const violations: string[] = [];
    let emitted = 0;

    const { executeRun } = await import("../src/runner/execute-run.ts");
    const checks: Promise<void>[] = [];
    await executeRun(
      { threadId, agent, input: runInput(threadId, [userMessage("hi")]), ownerId: "", agentId: "t", trigger: "chat" },
      a,
      {
        next: (event) => {
          if (isLiveOnly(event)) return;
          const position = ++emitted;
          // Read through the other server: the event must be visible to everyone.
          checks.push(
            readEventsAfter(b.db, threadId, 0, 10_000).then((log) => {
              if (log.length < position) violations.push(`${event.type} emitted at ${position}, log had ${log.length}`);
            }),
          );
        },
        complete: () => {},
      },
    );
    await Promise.all(checks);

    expect(violations).toEqual([]);
    expect(emitted).toBe((await stored(threadId)).length);
  });

  it("saves the user's message before the agent produces anything", async () => {
    const threadId = newThreadId();
    const gate = deferred();
    const run = start(a, threadId, new ScriptedAgent(() => [{ wait: gate.promise }, ...text("m1", "ok")]), runInput(threadId, [userMessage("remember me", "u1")]));

    await until(async () => (await stored(threadId)).length > 0);
    const [first] = await stored(threadId);
    expect(first!.type).toBe(EventType.RUN_STARTED);
    expect((first as { input?: { messages: { id: string }[] } }).input!.messages.map((m) => m.id)).toEqual(["u1"]);

    gate.resolve();
    await run.done;
  });

  it("emits live-only events without storing them", async () => {
    const threadId = newThreadId();
    const raw = { type: EventType.RAW, event: { noisy: true } } as BaseEvent;
    const run = start(a, threadId, new ScriptedAgent(() => [raw, ...text("m1", "ok")]), runInput(threadId, [userMessage("hi")]));
    await run.done;

    expect(types(run.events)).toContain(EventType.RAW);
    expect(types(await stored(threadId))).not.toContain(EventType.RAW);
  });
});

describe("one active run per thread", () => {
  it("admits exactly one of many concurrent starts, across servers", async () => {
    const threadId = newThreadId();
    const gate = deferred();
    const attempts = [a, b, a, b, a, b].map((server) =>
      start(server, threadId, new ScriptedAgent(() => [{ wait: gate.promise }, ...text("m1", "ok")]), runInput(threadId, [userMessage("hi")])),
    );
    const refused = await Promise.all(
      attempts.map((attempt) => Promise.race([attempt.done.then(() => null, (error) => error), sleep(500).then(() => null)])),
    );

    expect(refused.filter((error) => error instanceof ThreadBusyError)).toHaveLength(5);
    gate.resolve();
    const results = await Promise.allSettled(attempts.map((attempt) => attempt.done));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await settled(threadId)).toBe("completed");
  });

  it("accepts the next run once the first has ended", async () => {
    const threadId = newThreadId();
    const first = userMessage("one");
    await start(a, threadId, new ScriptedAgent(() => text("m1", "first")), runInput(threadId, [first])).done;
    const second = await start(b, threadId, new ScriptedAgent(() => text("m2", "second")), runInput(threadId, [first, userMessage("two")])).done;
    expect(second.status).toBe("completed");
  });
});

describe("approvals", () => {
  async function parkOnApproval(threadId: string) {
    const question = userMessage("refund please", "u1");
    const run = start(a, threadId, new ScriptedAgent(() => [...toolCall("call1", "issue_refund", "m1"), interrupt({ ask: "approve?" })]), runInput(threadId, [question]));
    expect((await run.done).status).toBe("parked");
    return question;
  }

  it("parks the run and releases the lease", async () => {
    const threadId = newThreadId();
    await parkOnApproval(threadId);
    const thread = await getThread(a.db, threadId);
    expect(thread!.run).toMatchObject({ status: "parked", waitingFor: "approval", leaseAlive: false });
  });

  it("blocks an unrelated message until the approval is answered", async () => {
    const threadId = newThreadId();
    const question = await parkOnApproval(threadId);
    const attempt = start(a, threadId, new ScriptedAgent(() => []), runInput(threadId, [question, userMessage("something else")]));
    await expect(attempt.done).rejects.toBeInstanceOf(ApprovalPendingError);
    expect(await settled(threadId)).toBe("parked");
  });

  it("lets exactly one of many concurrent answers resume the run", async () => {
    const threadId = newThreadId();
    const question = await parkOnApproval(threadId);
    const gate = deferred();
    const attempts = [a, b, a, b, a].map((server) =>
      start(server, threadId, new ScriptedAgent(() => [{ wait: gate.promise }, ...text("m2", "refunded")]), runInput(threadId, [question], resumeProps)),
    );
    const early = await Promise.all(
      attempts.map((attempt) => Promise.race([attempt.done.then(() => null, (error) => error), sleep(500).then(() => null)])),
    );
    expect(early.filter((error) => error instanceof AlreadyResumedError)).toHaveLength(4);

    gate.resolve();
    const results = await Promise.allSettled(attempts.map((attempt) => attempt.done));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const latest = await latestRun(a.db, threadId);
    expect(latest).toMatchObject({ status: "completed", number: 2 });
    expect(latest!.resumesRunId).toBeTruthy();
  });

  it("does not show an answered approval again on reconnect", async () => {
    const threadId = newThreadId();
    const question = await parkOnApproval(threadId);
    const before = await collect(replayThread(b, threadId));
    expect(before.some((e) => e.type === EventType.CUSTOM)).toBe(true);

    await start(a, threadId, new ScriptedAgent(() => text("m2", "refunded")), runInput(threadId, [question], resumeProps)).done;
    const after = await collect(replayThread(b, threadId));
    expect(after.some((e) => e.type === EventType.CUSTOM)).toBe(false);
  });
});

describe("browser tools", () => {
  it("parks on an unanswered tool call and fills in a failure if the tool never reports back", async () => {
    const threadId = newThreadId();
    const ask = userMessage("chart please", "u1");
    const first = start(a, threadId, new ScriptedAgent(() => toolCall("call1", "render_chart", "m1")), runInput(threadId, [ask]));
    expect((await first.done).status).toBe("parked");
    expect((await getThread(a.db, threadId))!.run).toMatchObject({ waitingFor: "client_tool" });

    // The user sends a new message instead of the tool result. The thread moves on.
    const assistant = { id: "m1", role: "assistant", toolCalls: [{ id: "call1", type: "function", function: { name: "render_chart", arguments: "{}" } }] } as never;
    let seenByAgent: { role: string; content?: unknown }[] = [];
    const next = start(
      a,
      threadId,
      new ScriptedAgent((input) => {
        seenByAgent = input.messages;
        return text("m2", "moving on");
      }),
      runInput(threadId, [ask, assistant, userMessage("never mind", "u2")]),
    );
    expect((await next.done).status).toBe("completed");

    expect(seenByAgent.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(String(seenByAgent[2]!.content)).toContain(TOOL_DID_NOT_REPORT);
  });

  it("continues normally when the browser returns the tool result", async () => {
    const threadId = newThreadId();
    const ask = userMessage("chart please", "u1");
    await start(a, threadId, new ScriptedAgent(() => toolCall("call1", "render_chart", "m1")), runInput(threadId, [ask])).done;

    const assistant = { id: "m1", role: "assistant", toolCalls: [{ id: "call1", type: "function", function: { name: "render_chart", arguments: "{}" } }] } as never;
    const result = { id: "t1", role: "tool", toolCallId: "call1", content: "rendered" } as never;
    const next = start(a, threadId, new ScriptedAgent(() => text("m2", "here it is")), runInput(threadId, [ask, assistant, result]));
    await next.done;

    const started = next.events[0] as { input?: { messages: { id: string }[] } };
    expect(started.input!.messages.map((m) => m.id)).toEqual(["t1"]);
  });
});

describe("stop", () => {
  it("is honored once, from any server, and closes the log cleanly", async () => {
    const threadId = newThreadId();
    const never = deferred();
    const run = start(a, threadId, new ScriptedAgent(() => [{ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as BaseEvent, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "partial" } as BaseEvent, { wait: never.promise }]), runInput(threadId, [userMessage("go")]));
    await until(() => run.events.length >= 3);

    // The run is driven by server A. The stop requests go through both.
    const answers = await Promise.all([b, a, b, a, b].map((server) => requestStop(server.db, threadId)));
    expect(answers.filter(Boolean)).toHaveLength(1);

    expect((await run.done).status).toBe("cancelled");
    const log = await stored(threadId);
    expect(types(log).slice(-2)).toEqual([EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED]);
    expect(await asClient(log)).toEqual([expect.objectContaining({ role: "user" }), expect.objectContaining({ id: "m1", content: "partial" })]);
  });

  it("does nothing when no run is active", async () => {
    expect(await requestStop(a.db, newThreadId())).toBe(false);
  });
});

describe("when the driving server goes away", () => {
  it("another server settles the run, keeps the partial answer, and fences the old driver", async () => {
    const threadId = newThreadId();
    // A server that never renews: to everyone else it looks exactly like a crash.
    const dying = await createServer({ leaseTtlMs: 300, leaseRenewMs: 60_000 });
    const release = deferred();
    const run = start(dying, threadId, new ScriptedAgent(() => [{ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as BaseEvent, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "half an ans" } as BaseEvent, { wait: release.promise }, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "wer" } as BaseEvent, { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as BaseEvent]), runInput(threadId, [userMessage("go")]));
    await until(() => run.events.length >= 3);

    // Before the sweep, readers already see that nobody is driving.
    await sleep(350);
    expect((await getThread(b.db, threadId))!.run).toMatchObject({ status: "running", leaseAlive: false });

    expect(await reapExpired(b.db, { threadId })).toBe(1);
    expect(await settled(threadId)).toBe("orphaned");
    const log = await stored(threadId);
    expect(types(log).slice(-2)).toEqual([EventType.TEXT_MESSAGE_END, EventType.RUN_ERROR]);
    expect(log.at(-1)).toMatchObject({ code: "CONNECTION_LOST" });

    // The old driver wakes up and tries to carry on. Its writes are refused.
    release.resolve();
    expect((await run.done).status).toBe("lease_lost");
    await expect(appendFenced(dying.db, { threadId, runId: run.input.runId, holder: dying.holder }, text("m9", "late"))).rejects.toThrow();
    expect(await stored(threadId)).toEqual(log);
    expect(await asClient(log)).toContainEqual(expect.objectContaining({ id: "m1", content: "half an ans" }));

    // The thread is usable again straight away.
    const retry = await start(b, threadId, new ScriptedAgent(() => text("m2", "second try")), runInput(threadId, [userMessage("again")])).done;
    expect(retry.status).toBe("completed");
    await dying.close();
  });

  it("keeps the lease while the driver is healthy, however long the run takes", async () => {
    const threadId = newThreadId();
    const server = await createServer({ leaseTtlMs: 300, leaseRenewMs: 50 });
    const run = start(server, threadId, new ScriptedAgent(() => [{ sleep: 900 }, ...text("m1", "slow but fine")]), runInput(threadId, [userMessage("go")]));
    await sleep(600);
    expect(await reapExpired(b.db, { threadId })).toBe(0);
    expect((await run.done).status).toBe("completed");
    await server.close();
  });
});

describe("failures", () => {
  it("records an agent error and keeps what was produced", async () => {
    const threadId = newThreadId();
    const run = start(a, threadId, new ScriptedAgent(() => [{ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as BaseEvent, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "so far" } as BaseEvent, { fail: "model exploded" }]), runInput(threadId, [userMessage("go")]));
    expect((await run.done).status).toBe("failed");
    const log = await stored(threadId);
    expect(log.at(-1)).toMatchObject({ type: EventType.RUN_ERROR });
    expect((await getThread(a.db, threadId))!.run!.error).toContain("model exploded");
  });
});

describe("reading a thread", () => {
  it("creates nothing when the thread does not exist", async () => {
    const threadId = newThreadId();
    expect(await collect(replayThread(a, threadId))).toEqual([]);
    expect(await getThread(a.db, threadId)).toBeNull();
  });

  it("gives a reader on another server the same conversation, whenever it joins", async () => {
    const threadId = newThreadId();
    const u1 = userMessage("first question", "u1");
    const u2 = userMessage("second question", "u2");

    // Run 1 ends with a snapshot, like a LangGraph agent does.
    const snapshot = { type: EventType.MESSAGES_SNAPSHOT, messages: [u1, { id: "m1", role: "assistant", content: "first answer" }] } as BaseEvent;
    await start(a, threadId, new ScriptedAgent(() => [...text("m1", "first ", "answer"), snapshot]), runInput(threadId, [u1])).done;

    // Run 2 is stepped one event at a time. A new reader joins at every step.
    const script = [...toolCall("call1", "lookup_order", "m2"), { type: EventType.TOOL_CALL_RESULT, toolCallId: "call1", messageId: "t1", role: "tool", content: "found" } as BaseEvent, ...text("m3", "second ", "answer ", "in ", "pieces")];
    const gates = script.map(() => deferred());
    const run = start(a, threadId, new ScriptedAgent(() => script.flatMap((event, i) => [{ wait: gates[i]!.promise }, event])), runInput(threadId, [u1, u2]));

    await until(() => run.events.length >= 1); // admitted

    const readers: Promise<BaseEvent[]>[] = [];
    for (const [index, gate] of gates.entries()) {
      readers.push(collect(replayThread(b, threadId)));
      await sleep(15);
      gate.resolve();
      await until(() => run.events.length >= index + 2);
    }
    await run.done;
    readers.push(collect(replayThread(b, threadId)));

    const expected = await asClient(await stored(threadId));
    expect(expected.map((m) => m.id)).toEqual(["u1", "m1", "u2", "m2", "t1", "m3"]);
    expect(expected.at(-1)).toMatchObject({ content: "second answer in pieces" });

    const views = await Promise.all(readers);
    expect(views).toHaveLength(script.length + 1);
    for (const view of views) {
      // asClient throws if the stream is not valid AG-UI from where the reader joined.
      expect(await asClient(view)).toEqual(expected);
      // History arrives as one snapshot frame, not as a replay of run 1.
      expect(view[1]!.type).toBe(EventType.MESSAGES_SNAPSHOT);
    }
  });

  it("replays from the start when no safe snapshot exists", async () => {
    const threadId = newThreadId();
    const u1 = userMessage("one", "u1");
    await start(a, threadId, new ScriptedAgent(() => text("m1", "alpha")), runInput(threadId, [u1])).done;
    await start(a, threadId, new ScriptedAgent(() => text("m2", "beta")), runInput(threadId, [u1, userMessage("two", "u2")])).done;

    const view = await collect(replayThread(b, threadId));
    expect(types(view)).not.toContain(EventType.MESSAGES_SNAPSHOT);
    expect((await asClient(view)).map((m) => m.id)).toEqual(["u1", "m1", "u2", "m2"]);
  });
});

describe("settings", () => {
  it("apply on the next run, and reading never applies them", async () => {
    const { updateSettings } = await import("../src/runner/store.ts");
    const threadId = newThreadId();
    const u1 = userMessage("hi", "u1");
    await start(a, threadId, new ScriptedAgent(() => text("m1", "hello")), runInput(threadId, [u1])).done;

    await updateSettings(a.db, threadId, "", "t", { instructions: "Answer in French." });
    await collect(replayThread(a, threadId));
    expect((await getThread(a.db, threadId))!.settingsPending).toBe(true);

    let context: { value: string }[] = [];
    await start(
      a,
      threadId,
      new ScriptedAgent((input) => {
        context = input.context;
        return text("m2", "bonjour");
      }),
      runInput(threadId, [u1, userMessage("again", "u2")]),
    ).done;
    expect(context.map((c) => c.value)).toEqual(["Answer in French."]);
    expect((await getThread(a.db, threadId))!.settingsPending).toBe(false);
  });
});
