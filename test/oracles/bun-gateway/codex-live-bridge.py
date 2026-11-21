#!/usr/bin/env python3
# Reference for the former Bun Gateway. Not part of the shipped package.

from __future__ import annotations

import json
import logging
import sys
from functools import partial
from typing import Final

import anyio
from anyio.abc import ObjectSendStream

from codex_live_auth import read_codex_login
from codex_live_media import COMMANDS, BridgeEvent, Command, run_peer
from codex_live_provider import VOICES, BridgeError, connect_subscription

MAX_LINE: Final = 65_536


def emit(event: BridgeEvent) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


async def read_commands(send: ObjectSendStream[Command], scope: anyio.CancelScope) -> None:
    async with send:
        while True:
            line = await anyio.to_thread.run_sync(sys.stdin.buffer.readline, MAX_LINE + 1, abandon_on_cancel=True)
            if not line or line == b'{"type":"stop"}\n':
                scope.cancel()
                return
            if len(line) > MAX_LINE or not line.endswith(b"\n"):
                raise BridgeError("Invalid voice bridge command frame.")
            await send.send(COMMANDS.validate_json(line))


async def run(voice: str) -> None:
    if voice not in VOICES:
        raise BridgeError("Unsupported Codex subscription voice.")
    send, commands = anyio.create_memory_object_stream[Command](16)
    async with commands, anyio.create_task_group() as tasks:
        tasks.start_soon(read_commands, send, tasks.cancel_scope)
        try:
            login = await read_codex_login()
            negotiate = partial(connect_subscription, voice=voice, login=login)
            await run_peer(negotiate, (commands, emit), (login.token, login.account_id))
        finally:
            tasks.cancel_scope.cancel()


def main() -> None:
    # Dependency exceptions can include response bodies, SDP or headers.
    # The parent sees only this closed event or EOF, never raw diagnostics.
    logging.disable(logging.CRITICAL)
    exit_status = 0
    try:
        if len(sys.argv) != 2:
            raise BridgeError("Codex voice needs a voice identifier.")
        anyio.run(run, sys.argv[1])
    except Exception:  # Top-level subprocess trust boundary: fail closed without exposing wire data.
        exit_status = 1
    try:
        emit({"type": "ended"})
    except BrokenPipeError:
        sys.exit(exit_status)  # The parent already stopped reading.
    sys.exit(exit_status)


if __name__ == "__main__":
    main()
