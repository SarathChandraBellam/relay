import { HttpAgent } from "@ag-ui/client";
import { CopilotRuntime, createCopilotEndpoint } from "@copilotkit/runtime/v2";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createApi } from "./api.ts";
import { config, defaultTimings, newHolderId } from "./config.ts";
import { createDb } from "./db.ts";
import type { RunnerDeps } from "./runner/execute-run.ts";
import { Notifier } from "./runner/notifier.ts";
import { PostgresAgentRunner } from "./runner/postgres-agent-runner.ts";

const holder = newHolderId();
const log = (message: string, detail?: unknown) => console.log(`[relay ${holder}] ${message}`, detail ?? "");

const db = createDb(config.databaseUrl);
const notifier = new Notifier(config.databaseUrl);
await notifier.start();

const deps: RunnerDeps = { db, notifier, holder, timings: defaultTimings, log };
const runner = new PostgresAgentRunner(deps, config.agentId);
runner.startSweeper();

const runtime = new CopilotRuntime({
  // The agent is a separate service. The runtime reaches it over AG-UI.
  agents: { [config.agentId]: new HttpAgent({ url: config.agentUrl }) },
  runner,
});

const app = new Hono();
app.use("/api/*", cors({ origin: config.webOrigin }));
app.get("/health", (c) => c.json({ ok: true, holder }));
app.route("/api", createApi(deps));
app.route("/", createCopilotEndpoint({ runtime, basePath: "/api/copilotkit", cors: { origin: config.webOrigin } }));

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => log(`listening on http://localhost:${port}`));

// On a clean shutdown the lease is simply left to expire. Another server
// settles the run, exactly as it would after a crash.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    runner.stopSweeper();
    server.close();
    void notifier.close().finally(() => process.exit(0));
  });
}
