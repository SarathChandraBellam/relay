"""Builds the Deep Agents graph."""

from __future__ import annotations

import os

from copilotkit import CopilotKitMiddleware
from deepagents import create_deep_agent
from langchain.chat_models import init_chat_model
from langgraph.checkpoint.base import BaseCheckpointSaver

from .scripted_model import ScriptedChatModel
from .tools import TOOLS

SYSTEM_PROMPT = """You are a support desk assistant.

Use `lookup_order` to read an order before you talk about it. Use `issue_refund`
only when the user asks for a refund. If the app offers a `render_chart` tool,
use it when the user asks to see numbers as a chart.
"""


def resolve_model():
    """`RELAY_MODEL=scripted` (the default) needs no key.

    Anything else goes to LangChain's `init_chat_model`, for example
    `anthropic:claude-sonnet-4-5` or `openai:gpt-4.1`.
    """
    name = os.getenv("RELAY_MODEL", "scripted")
    if name == "scripted":
        return ScriptedChatModel()
    return init_chat_model(name)


def build_graph(checkpointer: BaseCheckpointSaver):
    return create_deep_agent(
        model=resolve_model(),
        tools=TOOLS,
        system_prompt=SYSTEM_PROMPT,
        # Lets tools registered in the browser reach the model, and ends the
        # run when the model calls one so the browser can execute it.
        middleware=[CopilotKitMiddleware()],
        # The run pauses here until a person approves, edits or rejects.
        interrupt_on={"issue_refund": True},
        checkpointer=checkpointer,
        name="support_desk",
    )
