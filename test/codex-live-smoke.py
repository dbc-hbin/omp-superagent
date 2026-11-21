#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12,<3.15"
# dependencies = [
#     "aiortc==1.16.0",
#     "anyio==4.16.0",
#     "httpx2[http2,brotli,zstd]==2.16.2",
#     "pydantic==2.14.3",
#     "websockets==17.4",
# ]
# ///
# Legacy Bun/Python reference, not the production voice backend: uv run --script test/codex-live-smoke.py
# No provider calls or actual account access: only local ICE/RTP and a fake Codex process.

from __future__ import annotations

import base64
import json
import math
import os
import shlex
import struct
import sys
import tempfile
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

import anyio
import av
import httpx2
from aiortc import MediaStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from anyio.abc import ObjectReceiveStream, ObjectSendStream
from pydantic import SecretStr, ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parent / "oracles" / "bun-gateway"))

from codex_live_auth import CodexLogin, CodexLoginError, read_codex_login
from codex_live_media import BridgeEvent, Command, DraftResult, Input, PcmInputTrack, Sideband, run_peer
from codex_live_provider import BridgeError, connect_subscription


def fake_codex(scenario: str, trace_path: Path) -> None:
    account_id = "fixture-account"
    plan = "free" if scenario == "free" else "plus"
    route = {
        "accountRoutingOverride": "us" if scenario == "residency" else "NO_CONSTRAINT",
        "backendOrigin": "https://chatgpt.com",
        "chatgptAccountId": "other-account" if scenario == "mismatch" else account_id,
    }
    claims = {
        "exp": int(time.time()) + (-60 if scenario == "expired" else 60),
        "https://api.openai.com/auth": {"chatgpt_account_id": account_id},
        "https://api.openai.com/profile": {"email": "voice@example.com"},
    }
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    with trace_path.open("w", encoding="utf-8") as trace:
        for line in sys.stdin:
            request = json.loads(line)
            method = request["method"]
            trace.write(method + "\n")
            trace.flush()
            match method:
                case "initialize":
                    result = {}
                case "initialized":
                    continue
                case "account/read":
                    assert not request["params"]["refreshToken"]
                    account = {"type": "chatgpt", "planType": plan, "email": "voice@example.com"}
                    if scenario == "key":
                        account = {"type": "apiKey"}
                    result = {"requiresOpenaiAuth": True, "account": account, "workspaceRouting": route}
                case "getAuthStatus":
                    assert request["params"] == {"includeToken": True, "refreshToken": False}
                    result = {"requiresOpenaiAuth": True, "authMethod": "chatgpt", "authToken": f"a.{payload}.b"}
                case _:
                    raise AssertionError(f"Unexpected RPC: {method}")
            print(json.dumps({"id": request["id"], "result": result}), flush=True)


async def verify_login() -> None:
    with tempfile.TemporaryDirectory(prefix="codex-voice-smoke-auth-") as root:
        trusted_bin = Path(root, ".local", "bin")
        trusted_bin.mkdir(parents=True)
        shell = trusted_bin / "codex"
        trace = Path(root, "rpc-log")
        script = str(Path(__file__).resolve())
        previous_path = os.environ.get("PATH")
        previous_home = os.environ.get("HOME")
        shim = Path(root, "codex")
        shim.write_text("#!/bin/sh\nexit 42\n", encoding="utf-8")
        shim.chmod(0o700)
        os.environ["HOME"] = root
        os.environ["PATH"] = root  # A leading workspace shim must never win over the installed CLI.
        try:
            for scenario in ("key", "free", "residency", "expired", "mismatch", "ok"):
                argv = shlex.join([sys.executable, "-B", script, "--fake-codex", scenario, str(trace)])
                shell.write_text(f"#!/bin/sh\nexec {argv}\n", encoding="utf-8")
                shell.chmod(0o700)
                try:
                    login = await read_codex_login()
                except (CodexLoginError, ValidationError):
                    assert scenario != "ok", "expected the fake ChatGPT subscriber to pass"
                else:
                    assert scenario == "ok", f"unsafe fake login accepted: {scenario}"
                    assert login.account_id.get_secret_value() == "fixture-account"
                used = trace.read_text(encoding="utf-8").splitlines()
                expected = ["initialize", "initialized", "account/read"]
                if scenario in ("expired", "mismatch", "ok"):
                    expected += ["getAuthStatus", "account/read"]
                assert used == expected, f"unexpected RPC sequence for {scenario}: {used}"
        finally:
            if previous_home is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = previous_home
            if previous_path is None:
                os.environ.pop("PATH", None)
            else:
                os.environ["PATH"] = previous_path


class LoopbackSideband:
    def __init__(self, inbound: ObjectReceiveStream[str], outbound: ObjectSendStream[str]) -> None:
        self.inbound = inbound
        self.outbound = outbound

    async def recv(self) -> str:
        return await self.inbound.receive()

    async def send(self, message: str) -> None:
        await self.outbound.send(message)


async def verify_rejected_offer() -> None:
    # Exercise the real HTTP client/JSON serializer, replacing only the network transport.
    # A redirect is not an invitation to send a subscription credential to a different origin.
    destinations: list[str] = []
    offer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
    async def redirect(request: httpx2.Request) -> httpx2.Response:
        destinations.append(request.url.host)
        assert request.method == "POST" and request.url.path == "/backend-api/codex/realtime/calls"
        assert request.headers["Authorization"] == "Bearer offline-fixture"
        assert request.headers["chatgpt-account-id"] == "fixture-account"
        payload = json.loads(await request.aread())
        assert payload["sdp"] == offer
        assert payload["session"]["model"] == "gpt-live-1-codex"
        assert payload["session"]["delegation"] == {"type": "client"}
        return httpx2.Response(307, headers={"Location": "https://elsewhere.invalid/moved"})

    login = CodexLogin(SecretStr("offline-fixture"), SecretStr("fixture-account"))
    with patch("codex_live_provider.httpx2.AsyncHTTPTransport", return_value=httpx2.MockTransport(redirect)):
        try:
            async with connect_subscription(offer, "cove", login):
                raise AssertionError("a redirected subscription offer must never open a session")
        except BridgeError:
            assert destinations == ["chatgpt.com"], destinations


def tone(hz: int) -> bytes:
    samples = [int(13_000 * math.sin(2 * math.pi * hz * n / 24_000)) for n in range(4_800)]
    return struct.pack(f"<{len(samples)}h", *samples)


def audible(data: bytes) -> bool:
    return any(abs(value) > 2_000 for (value,) in struct.iter_unpack("<h", data))


async def verify_media() -> None:
    inbound_send, inbound = anyio.create_memory_object_stream[str](8)
    outbound, outbound_read = anyio.create_memory_object_stream[str](8)
    commands_send, commands = anyio.create_memory_object_stream[Command](8)
    sideband = LoopbackSideband(inbound, outbound)
    upstream = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    assistant = PcmInputTrack()
    upstream.addTrack(assistant)
    heard, played, ready, draft_received = anyio.Event(), anyio.Event(), anyio.Event(), anyio.Event()
    drafts: list[tuple[str, str]] = []

    async def read_owner(track: MediaStreamTrack) -> None:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=24_000)
        while not heard.is_set():
            source = await track.recv()
            assert isinstance(source, av.AudioFrame)
            for frame in resampler.resample(source):
                if audible(bytes(frame.planes[0])[:frame.samples * 2]):
                    heard.set()

    @asynccontextmanager
    async def negotiate(offer: str) -> AsyncIterator[tuple[str, Sideband]]:
        await upstream.setRemoteDescription(RTCSessionDescription(sdp=offer, type="offer"))
        await upstream.setLocalDescription(await upstream.createAnswer())
        answer = upstream.localDescription
        assert answer is not None
        await inbound_send.send('{"type":"session.started"}')
        yield answer.sdp, sideband

    def emit(event: BridgeEvent) -> None:
        match event["type"]:
            case "ready":
                ready.set()
            case "audio":
                data = base64.b64decode(event["audio"])
                assert 0 < len(data) <= 960 and len(data) % 2 == 0
                if audible(data):
                    played.set()
            case "draft":
                drafts.append((event["id"], event["text"]))
                draft_received.set()

    try:
        with anyio.fail_after(12):
            async with anyio.create_task_group() as tasks:
                @upstream.on("track")
                def receive_owner(track: MediaStreamTrack) -> None:
                    tasks.start_soon(read_owner, track)

                tasks.start_soon(run_peer, negotiate, (commands, emit), (SecretStr("do-not-leak"),))
                await ready.wait()
                await commands_send.send(Input(type="input", audio=base64.b64encode(tone(440)).decode()))
                assistant.append(tone(600))
                await heard.wait()
                await played.wait()

                await inbound_send.send(json.dumps({"type": "session.delegation.created", "delegation": {
                    "type": "delegation", "target": "client", "id": "draft_1",
                }}))
                dictated = [
                    'src/GPUPath.ts에서 dispatch("keep_case")를 확인해 줘.\n',
                    "테스트는 2개만 추가하고 설정은 바꾸지 마.",
                ]
                for identifier, chunks in (
                    ("reflected", ["do-not-leak"]),
                    ("oversize", ["a" * 500, "b" * 501]),
                    ("draft_1", dictated),
                ):
                    await inbound_send.send(json.dumps({"type": "delegation.created", "item": {
                        "type": "delegation", "target": "client", "id": identifier,
                        "content": [{"type": "input_text", "text": text} for text in chunks],
                    }}))
                failure = json.loads(await outbound_read.receive())
                assert failure["delegation_item_id"] == "reflected"
                assert "do-not-leak" not in str(failure)
                oversize = json.loads(await outbound_read.receive())
                assert oversize["delegation_item_id"] == "oversize"
                await draft_received.wait()

                assert drafts == [("draft_1", "".join(dictated))]
                await commands_send.send(DraftResult(type="draft_result", id="draft_1", posted=True))
                result = json.loads(await outbound_read.receive())
                assert result["type"] == "delegation.context.append" and result["delegation_item_id"] == "draft_1"
                assert result["channel"] == "speakable"
                assert "written confirmation" in result["content"][0]["text"]
                await commands_send.aclose()
    finally:
        assistant.stop()
        await upstream.close()


async def smoke() -> None:
    await verify_login()
    await verify_rejected_offer()
    await verify_media()
    print("Codex auth RPC, redirect rejection and bidirectional 24 kHz PCM WebRTC loopback passed.")


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--fake-codex":
        fake_codex(sys.argv[2], Path(sys.argv[3]))
    else:
        anyio.run(smoke)
