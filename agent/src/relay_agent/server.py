"""Serves the agent as an HTTP API that speaks the AG-UI protocol.

    POST /agent    RunAgentInput in, Server-Sent Events of AG-UI events out
    GET  /health

The agent keeps its own working state in LangGraph checkpoints. It knows
nothing about threads lists, leases or replay; that is the runner's job.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

import uvicorn
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
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
    uvicorn.run(
        "relay_agent.server:app",
        host=os.getenv("AGENT_HOST", "127.0.0.1"),
        port=int(os.getenv("AGENT_PORT", "8123")),
    )


if __name__ == "__main__":
    main()
