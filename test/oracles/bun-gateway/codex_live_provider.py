"""Subscription-only Quicksilver WebRTC signaling and client-delegation vocabulary."""

from __future__ import annotations

import json
import re
import socket
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Final, Protocol
from urllib.parse import urlsplit

import anyio
import httpx2
from pydantic import BaseModel, ConfigDict, Field
from websockets.asyncio.client import ClientConnection, connect

from codex_live_auth import CodexLogin

CALL_URL: Final = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas"
CONTROL_URL: Final = "wss://api.openai.com/v1/live"
VOICES: Final = frozenset({"arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"})
MAX_SDP: Final = 256 * 1024
MAX_EVENT_BYTES: Final = 256 * 1024
CALL_ID: Final = re.compile(r"(?:rtc_[A-Za-z0-9_-]{1,128}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\Z")
DRAFT_ID: Final = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
INSTRUCTIONS: Final = (
    "You are the owner's Discord voice assistant. Speak briefly in the owner's language. "
    "Answer ordinary conversation directly and be honest about uncertainty. Do not send ordinary conversation to HEAD. "
    "Delegate only for a fresh, explicit spoken work request from the owner, never from earlier speech, your own speech, or delegation results. "
    "In one client delegation input_text, transcribe the owner's work request as closely as possible in the original language. "
    "Keep their wording, order, names, paths, code, numbers, and constraints; do not summarize, translate, or add details. "
    "If any material detail is unclear or the text cannot fit in 1,000 characters, ask the owner to restate it instead of guessing or truncating. "
    "Only calls opened with /voice start work or /voice start share in the bound Discord text channel may post drafts; "
    "the latter allows one draft. Only the client checks permission; speech is never permission or approval. "
    "For work, only acknowledge that a draft was posted for written confirmation if the client reports that it was posted. "
    "Otherwise say it was not confirmed; do not retry. Never claim submission, execution, or any HEAD result. HEAD replies through text only."
)


class BridgeError(RuntimeError):
    """An unsafe or failed subscription voice operation."""


class NoRedirectConnection(connect):
    """Do not transfer authorization or the account header to a redirected host."""

    def process_redirect(self, exc: Exception) -> Exception:
        return exc


class SpeechSink(Protocol):
    async def send(self, message: str) -> None: ...


class ContentPart(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True)
    type: str
    text: str | None = Field(default=None, max_length=1_000)


class Delegation(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True)
    id: str
    type: str
    target: str
    content: tuple[ContentPart, ...] = Field(default=(), max_length=16)

    def draft_text(self) -> str:
        return "".join(part.text or "" for part in self.content if part.type == "input_text").strip()


class ProviderEvent(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True)
    type: str


class DelegationEvent(ProviderEvent):
    item: Delegation | None = None
    delegation: Delegation | None = None


def valid_sdp(sdp: str) -> bool:
    lines = sdp.splitlines()
    return (
        0 < len(sdp.encode()) <= MAX_SDP and "\0" not in sdp and bool(lines)
        and lines[0] == "v=0"
        and len([line for line in lines if line.startswith("m=")]) == 1
        and any(line.startswith("m=audio ") for line in lines)
    )


def call_id(headers: httpx2.Headers) -> str:
    candidate = headers.get("openai-session-id")
    location = headers.get("location")
    if location:
        parsed = urlsplit(location)
        if (
            len(location) > 512 or parsed.scheme not in ("", "https") or parsed.query or parsed.fragment
            or parsed.netloc not in ("", "api.openai.com", "chatgpt.com")
        ):
            raise BridgeError("Invalid OpenAI call location.")
        location_id = parsed.path.rstrip("/").split("/")[-1]
        if not CALL_ID.fullmatch(location_id) or (candidate and candidate != location_id):
            raise BridgeError("Invalid OpenAI call identifier.")
        candidate = location_id
    if not candidate or not CALL_ID.fullmatch(candidate):
        raise BridgeError("No OpenAI call identifier was provided.")
    return candidate


@asynccontextmanager
async def connect_subscription(
    offer: str, voice: str, login: CodexLogin,
) -> AsyncIterator[tuple[str, ClientConnection]]:
    if voice not in VOICES or not valid_sdp(offer):
        raise BridgeError("Invalid Codex subscription voice offer.")
    token, account = login.token.get_secret_value(), login.account_id.get_secret_value()
    headers = {
        "Authorization": f"Bearer {token}",
        "chatgpt-account-id": account,
        "OpenAI-Alpha": "quicksilver=v2",  # Protocol selector, not a client identity or entitlement.
        **{name: str(uuid.uuid4()) for name in ("session-id", "thread-id", "x-session-id")},
    }
    transport = httpx2.AsyncHTTPTransport(
        http2=True, trust_env=False, retries=0,
        socket_options=[(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)],
        limits=httpx2.Limits(max_connections=1, max_keepalive_connections=0),
    )
    async with httpx2.AsyncClient(
        transport=transport, trust_env=False, follow_redirects=False,
        timeout=httpx2.Timeout(connect=5, read=24, write=10, pool=5),
    ) as client:
        async with client.stream("POST", CALL_URL, headers={**headers, "Accept-Encoding": "identity"}, json={
            "sdp": offer,
            "session": {
                "model": "gpt-live-1-codex",
                "instructions": INSTRUCTIONS,
                "audio": {"output": {"voice": voice}},
                "delegation": {"type": "client"},
            },
        }) as response:
            if response.status_code not in (200, 201):
                raise BridgeError("OpenAI declined subscription voice access.")
            identifier = call_id(response.headers)
            data = bytearray()
            async for chunk in response.aiter_raw():
                if len(data) + len(chunk) > MAX_SDP:
                    raise BridgeError("OpenAI voice answer exceeded its size limit.")
                data.extend(chunk)
    answer = data.decode("utf-8")
    if not valid_sdp(answer) or token in answer or account in answer:
        raise BridgeError("Invalid OpenAI voice answer.")

    connection = await NoRedirectConnection(
        f"{CONTROL_URL}/{identifier}", additional_headers=headers, proxy=None,
        open_timeout=8, close_timeout=0.5, ping_interval=15, ping_timeout=10,
        max_size=MAX_EVENT_BYTES, max_queue=16, compression=None,
    )
    try:
        yield answer, connection
    finally:
        with anyio.move_on_after(1, shield=True):
            try:
                if connection.state.name == "OPEN":
                    await connection.send('{"type":"session.close"}')
            finally:
                await connection.close()


async def append_draft_result(connection: SpeechSink, text: str, draft_id: str) -> None:
    data = {
        "type": "delegation.context.append",
        "delegation_item_id": draft_id,
        "channel": "speakable",
        "content": [{"type": "input_text", "text": text}],
    }
    with anyio.fail_after(3):
        await connection.send(json.dumps(data))


def delegation_event(raw: str | bytes) -> tuple[str, Delegation | None]:
    # Most sideband events are not relevant, including large transcript events.
    # Do not retain their text or relay raw provider frames to Bun.
    kind = ProviderEvent.model_validate_json(raw).type
    match kind:
        case "delegation.created":
            return kind, DelegationEvent.model_validate_json(raw).item
        case "session.delegation.created":
            return kind, DelegationEvent.model_validate_json(raw).delegation
        case _:
            return kind, None
