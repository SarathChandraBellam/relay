# Relay

A proof of concept for a durable runner that sits between a [CopilotKit](https://github.com/CopilotKit/CopilotKit) UI and an agent API, with Postgres as the only piece of infrastructure.

The agent is a [Deep Agents](https://github.com/langchain-ai/deepagents) harness served over the [AG-UI](https://github.com/ag-ui-protocol/ag-ui) protocol. The runner is a custom CopilotKit `AgentRunner`. Postgres holds the transcript, the state of every run and who is driving it, so any server can serve any request and a conversation never depends on one process or one open browser tab.

```
 Browser                    Relay server (run as many as you like)          Agent API
┌──────────────────┐  SSE  ┌───────────────────────────────────────────┐  SSE  ┌─────────────────┐
│ CopilotKit chat  │◄─────►│ CopilotRuntime                            │◄─────►│ FastAPI + AG-UI │
│ approvals        │ AG-UI │  └─ PostgresAgentRunner                   │ AG-UI │ Deep Agents     │
│ browser tools    │       │       run · connect · stop · isRunning    │       │ (LangGraph)     │
└──────────────────┘       └───────────────────┬───────────────────────┘       └────────┬────────┘
                                               │                                        │
                                     ┌─────────▼─────────┐                    ┌─────────▼─────────┐
                                     │ Postgres: relay   │                    │ Postgres:         │
                                     │ threads·runs·events│                   │ relay_agent       │
                                     │ LISTEN / NOTIFY   │                    │ (checkpoints)     │
                                     └───────────────────┘                    └───────────────────┘
```

CopilotKit's open-source runtime ships an in-memory runner and a SQLite runner. Both are for a single instance. This repository shows what it takes to write one that works across instances and survives them going away.

> This is a template to learn from and build on, not a finished product. See [What is not here](#what-is-not-here).

## What it does

| For the user | How |
| --- | --- |
| **Runs survive server changes.** If the server driving a run crashes or is redeployed, the run ends cleanly, the partial answer is kept and the user is told the connection was lost. Nothing stays "running" forever. | Each run has a lease on the database clock. Any server settles a run whose lease expired. |
| **Nothing the user sees is lost.** | Events are committed to the log before they are sent to the browser. The user's message is saved before the agent starts. |
| **A thread is never driven twice.** Sending while the agent is working gives a clear "already running" answer. | One transaction admits a run, backed by a partial unique index. |
| **Accurate status.** Working, stopping, waiting for approval, waiting for a tool, connection lost, stopped, error, idle. | Status is computed from the latest run and its lease. It is never stored, so it cannot go stale. |
| **Approvals that always work.** Reload, come back later, still approve. If two tabs approve at once, one counts and the other joins the live run. An unrelated message is refused until the approval is answered. | A run that ends on an interrupt is parked. A later run claims it with one conditional `UPDATE`. |
| **Browser tools.** Tools that run in the browser (the demo draws a chart) work across runs, and a tool that never reports back does not block the thread. | The run parks on the unanswered tool call. The next run carries the result, or a failure result that the runner fills in. |
| **Open anywhere, see the same chat.** A reload, a second tab or a second device shows the same conversation and joins a run that is still going. Long threads open quickly. | Readers replay from the last safe snapshot, then follow new events through `LISTEN/NOTIFY`. |
| **Stop from anywhere.** | Stop is one state transition. The driver sees it whichever server received the request. |
| **Runs without a browser.** `POST /api/threads/:id/runs` starts a run and returns `202`. Open the thread later and the result is there. | The driving loop takes a plain context. It has no HTTP in it. |
| **Settings apply on the next message.** Viewing or reconnecting never changes agent behaviour. | Settings are versioned on the thread and read when a run is admitted. |

## Run it

You need Node 22+, [pnpm](https://pnpm.io), [uv](https://docs.astral.sh/uv/) and Docker (or any Postgres 14+). No API key is needed: the agent starts with a scripted model.

```bash
docker compose up -d
```

```bash
pnpm install
```

```bash
pnpm db:migrate
```

Then start the three processes, each in its own terminal:

```bash
pnpm dev:agent
```

```bash
pnpm dev:server
```

```bash
pnpm dev:web
```

Open http://localhost:5173.

If you use your own Postgres instead of Docker, create a `relay` user and the databases `relay`, `relay_agent` and `relay_test` (see `docker/init.sql`), or copy `.env.example` to `.env` and point the URLs elsewhere.

### Things to try

The scripted model reacts to keywords, so each of these exercises a different path:

| Type this | What happens |
| --- | --- |
| `What about order A-1001?` | The agent calls a server-side tool and answers. |
| `Please refund A-1002` | The run parks on an approval. Reload the page: the card is still there. Approve it in one tab while another tab is open. |
| `Show me a chart` | The agent calls a tool that lives in the browser. The run ends, the browser draws the chart and starts the next run with the result. |
| `Give me a slow answer` | A long streamed answer. Open the same URL in a second tab mid-answer, press stop in either tab, or kill the server (below). |

**Kill a server mid-run.** Start a second server and point a second web app at it:

```bash
PORT=4001 pnpm dev:server
```

```bash
RELAY_SERVER=http://localhost:4001 WEB_PORT=5174 pnpm dev:web
```

Ask for a slow answer on http://localhost:5173, open the same thread on http://localhost:5174 (copy the `#...` part of the URL), then `kill -9` the first server. Within the lease time (15 seconds by default) the second server settles the run. The partial answer is still there and the status reads "Connection lost". Send another message to continue.

**Use a real model.** Set `RELAY_MODEL` to a LangChain `provider:model` name and the provider's key in `.env`, for example `RELAY_MODEL=anthropic:claude-sonnet-4-5` with `ANTHROPIC_API_KEY`.

### Tests

```bash
pnpm test
```

The tests run against a real Postgres (`relay_test`) with scripted agents, and build two "servers" on the same database to exercise the cross-server cases. They do not need the Python agent.

## How it works

### The run state machine

```
                     ┌──────────► completed
                     ├──────────► failed
  (create) ► running ┼──────────► parked ───► resumed
                │    └──────────► orphaned
                ▼
             stopping ──────────► cancelled
```

`running` and `stopping` are the only states with a driver, and a partial unique index allows one such run per thread. Every transition is an `UPDATE` that names the states it may leave, so two servers racing for the same transition cannot both win. The table of allowed transitions is in [`status.ts`](server/src/runner/status.ts).

A thread has no status column. What the UI shows is derived when it is read:

| Latest run | Lease | The thread shows |
| --- | --- | --- |
| none, `completed`, `resumed` | | idle |
| `running` | alive | running |
| `running` | expired | connection lost |
| `stopping` | alive / expired | stopping / stopped |
| `parked` | | waiting for approval, or waiting for a tool |
| `orphaned` | | connection lost |
| `cancelled` / `failed` | | stopped / error |

### Leases and fencing

When a run is admitted, the server takes a lease on it: `lease_holder` and `lease_expires_at`. Both are set and compared with the database clock (`clock_timestamp()`), so servers do not need synchronised clocks. The holder renews every 5 seconds; the lease lasts 15.

Every write the driver makes is fenced. It succeeds only if the run still names that holder, is still active and the lease has not expired. The holder id is unique per process start, so a restarted server cannot be mistaken for the one it replaced. If a server stalls long enough to lose its lease and then wakes up, its next write is refused and it stops.

Each server also runs a sweeper. It finds runs whose lease expired, closes their log properly (open messages, tool calls and steps are ended, then a terminal event is added) and marks them `orphaned`, or `cancelled` if they were already stopping. `FOR UPDATE SKIP LOCKED` lets all servers sweep without getting in each other's way.

### The event log

The log is append-only and ordered per thread. Sequence numbers come from a counter on the thread row, bumped under a row lock that is held until commit. That makes commit order equal to sequence order, so a reader asking for "everything after N" can never skip an event.

Events from the agent are written in batches of up to 50 ms. A batch is one SQL statement: check the fence, allocate sequence numbers, insert, `pg_notify`. Only after it commits are the events sent to the browser. Events that are worth showing but not worth keeping (raw framework events, reasoning) travel in the same queue to keep their place, skip the database and are never replayed.

### Opening a thread

`connect()` reads only the log, so it does not matter which server is driving the run.

1. **History.** If an earlier run left a `MESSAGES_SNAPSHOT` with nothing message-related after it, the reader gets that snapshot as one closed frame and the earlier runs are skipped. Otherwise the earlier runs are replayed in compact form.
2. **The latest run**, from the log.
3. **The tail.** If that run is still active, the reader follows new events as they commit, woken by `NOTIFY` with a 500 ms poll as a fallback, until the run ends.

Approvals that were already answered belong to earlier runs and are not shown again.

### Parking and resuming

When a run ends on an interrupt (either AG-UI form: the `RUN_FINISHED` outcome or a `CUSTOM on_interrupt` event), or ends with a tool call nobody answered, it is `parked`. Parking releases the lease, so a pending approval costs nothing and can wait for days.

The next run on the thread claims the parked run with `UPDATE runs SET status = 'resumed' WHERE id = ? AND status = 'parked'`, in the same transaction that admits it. One request can win that. A request that loses is not an error for the user: its stream becomes a `connect()` to the run the winner started.

### Where things are

```
agent/                         Python. The Deep Agents harness as an AG-UI API.
  src/relay_agent/
    graph.py                   create_deep_agent: tools, approval rule, browser-tool middleware
    scripted_model.py          keyword-driven model so the stack runs without a key
    server.py                  FastAPI app, Postgres checkpointer
server/                        TypeScript. The runner.
  prisma/schema.prisma         threads, runs, events, message ledger
  src/runner/
    status.ts                  the state machine and derived status
    store.ts                   every SQL statement: admission, fenced writes, lease, stop, sweep, replay anchor
    execute-run.ts             the driving loop, with no HTTP in it
    event-writer.ts            persist, commit, then emit
    replay.ts                  history, then the latest run, then the live tail
    close-log.ts               brings an unfinished log to a valid end
    notifier.ts                one LISTEN connection per process
    postgres-agent-runner.ts   the CopilotKit AgentRunner
  src/api.ts                   thread list and status, headless runs, stop, settings
  test/                        the guarantees, against a real Postgres
web/                           React + CopilotKit chat, thread list, approval card, chart tool
```

## What it is built with, and why

| Piece | Choice | Notes |
| --- | --- | --- |
| Agent | Deep Agents on LangGraph, served with `ag-ui-langgraph` and FastAPI | The agent is a separate service with its own state (LangGraph checkpoints in Postgres). The runner only needs an AG-UI endpoint, so any AG-UI agent can take its place. |
| Protocol | AG-UI events, `@ag-ui/client` | The log stores AG-UI events as they are. The same client library that the browser uses checks the replay in the tests. |
| Runner contract | CopilotKit `AgentRunner` (`@copilotkit/runtime/v2`) | Four methods: `run`, `connect`, `stop`, `isRunning`. CopilotKit's own `finalizeRunEvents` is reused to close unfinished logs. |
| Database | PostgreSQL | Row locks, a partial unique index, `SKIP LOCKED` and `LISTEN/NOTIFY` cover everything. No Redis, no queue. |
| Data access | Prisma for the schema, migrations and client; `pg` for `LISTEN` | The statements that matter are hand-written SQL through `$queryRaw`, because the guarantees live in the SQL. Each fenced write is a single statement, which avoids interactive transactions and their timeouts on the hot path. Prisma cannot hold a `LISTEN` connection, so that one uses `pg` directly. |
| HTTP | Hono | CopilotKit's runtime mounts on it directly. |
| UI | React, Vite, CopilotKit React v2 | `CopilotChat`, `useInterrupt` for approvals, `useFrontendTool` for the chart. |

## What is not here

- **Sign-in and ownership.** Every request is the same anonymous owner. The schema has `owner_id`; the checks are yours to add (`isThreadAccessible` on the runner, and the REST routes).
- **Taking over a live run.** When a driver dies, its run ends as "connection lost" and the user sends another message. The agent keeps its own checkpoints, so nothing it finished is lost, but the runner does not try to re-attach to a half-finished model call.
- **Pruning.** Snapshots are the largest thing in the log. Superseded ones can be deleted, but that has to be safe for readers that are mid-replay. Not implemented.
- **Subagent events.** They are stored and replayed like any other event. Nothing renders them specially.
- **Push status updates.** The thread list polls. `NOTIFY` is already there to drive a push channel.
- **Limits.** Message size and tool-count limits should be checked before a run is admitted, with a clear message. Not implemented.
- **Agent stop.** Stop aborts the runner's request to the agent. The demo agent does not get a separate cancel call.
