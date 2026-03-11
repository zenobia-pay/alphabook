from __future__ import annotations

import os
from typing import Any

from agents import Agent, ModelSettings, Runner
from agents.extensions.experimental.codex import (
    CodexToolStreamEvent,
    ThreadOptions,
    codex_tool,
)
from agents.extensions.experimental.codex.events import (
    ThreadError,
    ThreadEvent,
    ThreadStartedEvent,
    TurnFailedEvent,
)
from terminaluse.lib import AgentServer, TaskContext, make_logger
from terminaluse.types import Event, TextPart

logger = make_logger(__name__)
server = AgentServer()


@server.on_create
async def handle_create(ctx: TaskContext, params: dict[str, Any]):
    await ctx.state.create(state={"thread_id": None})


@server.on_event
async def handle_event(ctx: TaskContext, event: Event):
    os.environ.setdefault("CODEX_HOME", "/root/.codex")

    state = await ctx.state.get()
    thread_id = state.get("thread_id") if state else None
    if not isinstance(thread_id, str):
        thread_id = None
    resolved_thread_id = thread_id

    async def on_stream(payload: CodexToolStreamEvent) -> None:
        nonlocal resolved_thread_id
        thread_event: ThreadEvent = payload.event
        await ctx.messages.send(thread_event)
        if isinstance(thread_event, ThreadStartedEvent):
            resolved_thread_id = thread_event.thread_id

    if not isinstance(event.content, TextPart):
        await ctx.messages.send(
            TurnFailedEvent(
                error=ThreadError(message="Only text messages are supported."),
            )
        )
        return

    prompt = (
        "Read the files in /workspace/input. Use shell tools to inspect the full book. "
        "Write a concise grounded report to /workspace/output/report.md and "
        "/workspace/output/report.json with summary and evidence passages. "
        "If the evidence is weak, say so clearly.\n\n"
        f"User request:\n{event.content.text}"
    )

    try:
        agent = Agent(
            name="AlphaBook Research Agent",
            instructions=(
                "Call the codex tool exactly once. Search the provided workspace, ground every claim "
                "in the book text, and keep the final answer concise."
            ),
            model_settings=ModelSettings(tool_choice="required"),
            tools=[
                codex_tool(
                    thread_id=thread_id,
                    default_thread_options=ThreadOptions(
                        working_directory="/workspace",
                        skip_git_repo_check=True,
                        sandbox_mode="danger-full-access",
                        approval_policy="never",
                    ),
                    on_stream=on_stream,
                    failure_error_function=None,
                )
            ],
        )
        await Runner.run(agent, prompt)
    except Exception as exc:
        logger.exception("Terminal Use agent failed")
        await ctx.messages.send(
            TurnFailedEvent(
                error=ThreadError(message=str(exc)),
            )
        )
    finally:
        if isinstance(resolved_thread_id, str) and resolved_thread_id and resolved_thread_id != thread_id:
            await ctx.state.update({"thread_id": resolved_thread_id})
