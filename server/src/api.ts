/**
 * Plain HTTP routes next to the CopilotKit endpoint.
 *
 *   GET    /api/threads                 threads with their derived status
 *   GET    /api/threads/:id             one thread
 *   POST   /api/threads/:id/runs        start a run with no browser attached (202)
 *   POST   /api/threads/:id/stop        stop the active run, from any server
 *   PATCH  /api/threads/:id/settings    change agent settings; applies on the next run
 *   GET    /api/threads/:id/events      the raw event log, for debugging
 *   DELETE /api/threads/:id
 */

import { randomUUID } from "node:crypto";
import { HttpAgent, type Message, type RunAgentInput } from "@ag-ui/client";
import { Hono } from "hono";
import { config } from "./config.ts";
import { RunnerError } from "./runner/errors.ts";
import { executeRun, type RunnerDeps } from "./runner/execute-run.ts";
import { deriveThreadStatus, isBusy, toSimpleStatus } from "./runner/status.ts";
import { deleteThread, getThread, listThreads, readEventsAfter, requestStop, updateSettings, type ThreadRow } from "./runner/store.ts";

/** There is no sign-in in this template. Every request is the same anonymous owner. */
const OWNER = "";

function present(thread: ThreadRow) {
  const status = deriveThreadStatus(thread.run);
  return {
    id: thread.id,
    title: thread.title,
    agentId: thread.agentId,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status,
    simpleStatus: toSimpleStatus(status),
    busy: isBusy(status),
    settings: thread.settings,
    settingsPending: thread.settingsPending,
    latestRun: thread.run && { id: thread.run.id, status: thread.run.status, trigger: thread.run.trigger, error: thread.run.error },
  };
}

export function createApi(deps: RunnerDeps): Hono {
  const api = new Hono();

  api.get("/threads", async (c) => c.json((await listThreads(deps.db, OWNER)).map(present)));

  api.get("/threads/:id", async (c) => {
    const thread = await getThread(deps.db, c.req.param("id"));
    // A thread nobody has run yet is simply idle. Asking about it creates nothing.
    if (!thread) return c.json({ id: c.req.param("id"), status: "idle", simpleStatus: "idle", busy: false, latestRun: null });
    return c.json(present(thread));
  });

  api.post("/threads/:id/runs", async (c) => {
    const threadId = c.req.param("id");
    const body = await c.req.json<{ message?: string }>().catch(() => ({ message: undefined }));
    if (!body.message?.trim()) return c.json({ error: "message is required" }, 400);

    const runId = randomUUID();
    const message: Message = { id: randomUUID(), role: "user", content: body.message };
    const input: RunAgentInput = { threadId, runId, messages: [message], tools: [], context: [], state: {}, forwardedProps: {} };
    const agent = new HttpAgent({ url: config.agentUrl, agentId: config.agentId, threadId });

    // Admission is awaited so the caller learns right away if the thread is
    // busy. After that the run continues on its own; the response does not wait.
    let admitted!: () => void;
    let refused!: (error: unknown) => void;
    const admission = new Promise<void>((resolve, reject) => ((admitted = resolve), (refused = reject)));
    executeRun({ threadId, agent, input, ownerId: OWNER, agentId: config.agentId, trigger: "api" }, deps, {
      next: () => admitted(),
      complete: () => {},
    }).catch((error) => {
      refused(error);
      if (!(error instanceof RunnerError)) deps.log?.("headless run failed", error);
    });

    try {
      await admission;
    } catch (error) {
      if (error instanceof RunnerError) return c.json({ error: error.message, code: error.code }, 409);
      throw error;
    }
    return c.json({ threadId, runId }, 202);
  });

  api.post("/threads/:id/stop", async (c) => c.json({ stopped: await requestStop(deps.db, c.req.param("id")) }));

  api.patch("/threads/:id/settings", async (c) => {
    const patch = await c.req.json<Record<string, unknown>>();
    await updateSettings(deps.db, c.req.param("id"), OWNER, config.agentId, patch);
    return c.json({ ok: true });
  });

  api.get("/threads/:id/events", async (c) => {
    const after = Number(c.req.query("after") ?? 0);
    const events = await readEventsAfter(deps.db, c.req.param("id"), after, 1000);
    return c.json(events.map(({ seq, runId, event }) => ({ seq, runId, ...event })));
  });

  api.delete("/threads/:id", async (c) => {
    await deleteThread(deps.db, c.req.param("id"));
    return c.json({ ok: true });
  });

  return api;
}
