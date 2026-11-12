"""Serves the agent as an HTTP API that speaks the AG-UI protocol.

    POST /agent    RunAgentInput in, Server-Sent Events of AG-UI events out
    GET  /health

The agent keeps its own working state in LangGraph checkpoints. It knows
nothing about thread lists, leases or replay; that is the runner's job.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from dotenv import load_dotenv
from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from copilotkit import LangGraphAGUIAgent
from fastapi import FastAPI
from langgraph.checkpoint.memory import InMemorySaver

from .graph import build_graph


def _mount(app: FastAPI, checkpointer) -> None:
    agent = LangGraphAGUIAgent(
        name="support_desk",
        description="A support desk assistant built on Deep Agents.",
        graph=build_graph(checkpointer),
    )
    add_langgraph_fastapi_endpoint(app, agent, path="/agent")


DEFAULT_DATABASE_URL = "postgresql://relay:relay@localhost:5432/relay_agent"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Checkpoints go to Postgres so the agent can be restarted, or run as
    # several copies, without losing a conversation or a pending approval.
    # AGENT_DATABASE_URL=memory keeps them in the process instead.
    database_url = os.getenv("AGENT_DATABASE_URL", DEFAULT_DATABASE_URL)
    if database_url == "memory":
        _mount(app, InMemorySaver())
        yield
        return

    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    async with AsyncPostgresSaver.from_conn_string(database_url) as checkpointer:
        await checkpointer.setup()
        _mount(app, checkpointer)
        yield


app = FastAPI(title="relay agent", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": os.getenv("RELAY_MODEL", "scripted")}


def main() -> None:
    load_dotenv(Path(__file__).resolve().parents[3] / ".env")
    uvicorn.run(
        "relay_agent.server:app",
        host=os.getenv("AGENT_HOST", "127.0.0.1"),
        port=int(os.getenv("AGENT_PORT", "8123")),
    )


if __name__ == "__main__":
    main()
