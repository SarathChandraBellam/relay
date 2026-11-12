"""A deterministic chat model so the whole stack runs without an API key.

It is not a mock of the agent: the real Deep Agents graph, middleware,
checkpointer and AG-UI adapter all run. Only the LLM is replaced by a small
keyword script that can stream text, call a server tool, call a tool that
needs approval, and call a tool that lives in the browser.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from typing import Any, AsyncIterator, Iterator, Sequence

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

_ORDER_RE = re.compile(r"\b[aA]-\d{4}\b")


def _text(message: BaseMessage) -> str:
    content = message.content
    if isinstance(content, str):
        return content
    return " ".join(part.get("text", "") for part in content if isinstance(part, dict))


class ScriptedChatModel(BaseChatModel):
    """Keyword-driven stand-in for an LLM."""

    tool_names: list[str] = []
    delay: float = 0.03

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> "ScriptedChatModel":
        names = []
        for tool in tools:
            if isinstance(tool, dict):
                names.append(tool.get("name") or tool.get("function", {}).get("name", ""))
            else:
                names.append(getattr(tool, "name", getattr(tool, "__name__", "")))
        return self.model_copy(update={"tool_names": names})

    # -- the script ---------------------------------------------------------

    def _plan(self, messages: list[BaseMessage]) -> AIMessage:
        last = messages[-1]
        if isinstance(last, ToolMessage):
            source = f"`{last.name}`" if last.name else "The tool"
            return AIMessage(content=f"Done. {source} returned: {_text(last)}")

        prompt = _text(next((m for m in reversed(messages) if isinstance(m, HumanMessage)), last))
        lowered = prompt.lower()
        order = _ORDER_RE.search(prompt)
        order_id = order.group(0).upper() if order else "A-1001"

        def call(name: str, args: dict) -> AIMessage:
            return AIMessage(
                content="",
                tool_calls=[{"name": name, "args": args, "id": f"call_{uuid.uuid4().hex[:12]}"}],
            )

        if "refund" in lowered and "issue_refund" in self.tool_names:
            return call("issue_refund", {"order_id": order_id, "amount": 25.0})
        if "chart" in lowered and "render_chart" in self.tool_names:
            return call(
                "render_chart",
                {
                    "title": "Orders by status",
                    "points": [
                        {"label": "Delivered", "value": 2},
                        {"label": "In transit", "value": 1},
                    ],
                },
            )
        if "order" in lowered and "lookup_order" in self.tool_names:
            return call("lookup_order", {"order_id": order_id})
        if "slow" in lowered or "long" in lowered:
            return AIMessage(content=" ".join(f"Step {i} of a deliberately long answer." for i in range(1, 121)))
        return AIMessage(
            content=(
                f'You said: "{prompt}". I am the scripted model, so I only know a few tricks: '
                "ask about an order (A-1001), ask for a refund, ask for a chart, or ask for a slow answer."
            )
        )

    # -- LangChain plumbing -------------------------------------------------

    def _generate(self, messages: list[BaseMessage], stop=None, run_manager=None, **kwargs: Any) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self._plan(messages))])

    def _chunks(self, messages: list[BaseMessage]) -> Iterator[AIMessageChunk]:
        plan = self._plan(messages)
        message_id = f"msg_{uuid.uuid4().hex[:12]}"
        if plan.tool_calls:
            call = plan.tool_calls[0]
            # Name first, then the arguments in pieces, the way a real model streams them.
            yield AIMessageChunk(
                content="",
                id=message_id,
                tool_call_chunks=[{"name": call["name"], "args": "", "id": call["id"], "index": 0}],
            )
            args = json.dumps(call["args"])
            for start in range(0, len(args), 24):
                yield AIMessageChunk(
                    content="",
                    id=message_id,
                    tool_call_chunks=[{"name": None, "args": args[start : start + 24], "id": None, "index": 0}],
                )
            return
        words = _text(plan).split(" ")
        for index, word in enumerate(words):
            yield AIMessageChunk(content=word if index == 0 else f" {word}", id=message_id)

    def _stream(self, messages: list[BaseMessage], stop=None, run_manager=None, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        for chunk in self._chunks(messages):
            yield ChatGenerationChunk(message=chunk)

    async def _astream(self, messages: list[BaseMessage], stop=None, run_manager=None, **kwargs: Any) -> AsyncIterator[ChatGenerationChunk]:
        for chunk in self._chunks(messages):
            await asyncio.sleep(self.delay)
            yield ChatGenerationChunk(message=chunk)
