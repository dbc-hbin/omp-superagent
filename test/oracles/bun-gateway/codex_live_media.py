"""Paced 24 kHz mono PCM16 over one aiortc peer and an ordered control stream."""

from __future__ import annotations

import base64
import sys
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager, AsyncExitStack
from fractions import Fraction
from typing import Final, Literal, NotRequired, Protocol, TypedDict, assert_never

import anyio
import av
from aiortc import AudioStreamTrack, MediaStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError
from anyio.abc import ObjectReceiveStream
from pydantic import BaseModel, ConfigDict, Field, SecretStr, TypeAdapter

from codex_live_provider import DRAFT_ID, BridgeError, SpeechSink, append_draft_result, delegation_event

PCM_HZ: Final = 24_000
FRAME_SAMPLES: Final = 480
FRAME_BYTES: Final = FRAME_SAMPLES * 2
MAX_PCM: Final = 24_000
MAX_DRAFTS: Final = 32
POSTED: Final = "A draft was posted for written confirmation. Nothing was submitted or executed."
NOT_POSTED: Final = "The client did not confirm posting a draft. Do not retry; check the text channel. Nothing was submitted or executed."
NO_TEXT: Final = "No clear draft text was provided. If the owner explicitly requested a draft, ask them to restate it."


class Input(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True, extra="forbid")
    type: Literal["input"]
    audio: str = Field(min_length=4, max_length=32_000)


class DraftResult(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True, extra="forbid")
    type: Literal["draft_result"]
    id: str = Field(max_length=128)
    posted: bool


type Command = Input | DraftResult
COMMANDS: Final = TypeAdapter(Command)


class BridgeEvent(TypedDict):
    type: Literal["ready", "audio", "draft", "ended"]
    audio: NotRequired[str]
    id: NotRequired[str]
    text: NotRequired[str]


class Sideband(SpeechSink, Protocol):
    async def recv(self) -> str | bytes: ...


type Negotiate = Callable[[str], AbstractAsyncContextManager[tuple[str, Sideband]]]
type Emit = Callable[[BridgeEvent], None]


class PcmInputTrack(AudioStreamTrack):
    """Keep a bounded queue and emit one frame per 20 ms, including silence."""

    def __init__(self) -> None:
        super().__init__()
        self.pending = bytearray()
        self.pts = 0
        self.deadline: float | None = None

    def append(self, data: bytes) -> None:
        if not data or len(data) % 2 or len(self.pending) + len(data) > MAX_PCM:
            raise BridgeError("Invalid or congested voice PCM input.")
        self.pending.extend(data)

    async def recv(self) -> av.AudioFrame:
        if self.readyState != "live":
            raise MediaStreamError
        deadline = self.deadline if self.deadline is not None else anyio.current_time()
        await anyio.sleep_until(deadline)
        if self.readyState != "live":
            raise MediaStreamError
        # Anchor to the audio clock. Adding 20 ms to each actual wake-up would
        # accumulate scheduler jitter until continuous owner speech filled the queue.
        self.deadline = max(deadline + FRAME_SAMPLES / PCM_HZ, anyio.current_time())
        frame = av.AudioFrame(format="s16", layout="mono", samples=FRAME_SAMPLES)
        plane = frame.planes[0]
        count = min(FRAME_BYTES, len(self.pending))
        plane.update(bytes(self.pending[:count]) + bytes(plane.buffer_size - count))
        del self.pending[:count]
        frame.sample_rate = PCM_HZ
        frame.time_base = Fraction(1, PCM_HZ)
        frame.pts = self.pts
        self.pts += FRAME_SAMPLES
        return frame

    def stop(self) -> None:
        self.pending.clear()
        super().stop()


async def play_remote_audio(track: MediaStreamTrack, active: anyio.Event, emit: Emit) -> None:
    output = av.AudioResampler(format="s16", layout="mono", rate=PCM_HZ)
    await active.wait()
    while True:
        frame = await track.recv()
        if not isinstance(frame, av.AudioFrame):
            raise BridgeError("OpenAI returned an unexpected media frame.")
        for chunk in output.resample(frame):
            pcm = bytes(chunk.planes[0])[:chunk.samples * 2]
            if pcm:
                emit({"type": "audio", "audio": base64.b64encode(pcm).decode("ascii")})


async def run_peer(
    negotiate: Negotiate, ports: tuple[ObjectReceiveStream[Command], Emit], secrets: tuple[SecretStr, ...],
) -> None:
    """Negotiate media, process only one local command surface and project safe events."""
    commands, emit = ports
    if sys.byteorder != "little":
        raise BridgeError("Codex voice PCM requires a little-endian host.")
    peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    track = PcmInputTrack()
    peer.addTrack(track)
    connected, remote_audio, started, active = anyio.Event(), anyio.Event(), anyio.Event(), anyio.Event()
    seen: set[str] = set()
    pending: set[str] = set()
    stack = AsyncExitStack()
    try:
        async with anyio.create_task_group() as tasks:
            @peer.on("connectionstatechange")
            def connection_changed() -> None:
                if peer.connectionState == "connected":
                    connected.set()
                elif peer.connectionState in ("failed", "closed"):
                    tasks.cancel_scope.cancel()

            @peer.on("track")
            def track_received(remote: MediaStreamTrack) -> None:
                if remote.kind != "audio" or remote_audio.is_set():
                    tasks.cancel_scope.cancel()
                    return
                remote_audio.set()
                tasks.start_soon(play_remote_audio, remote, active, emit)

            async def receive_control(sideband: Sideband) -> None:
                while True:
                    raw = await sideband.recv()
                    kind, item = delegation_event(raw)
                    if kind == "session.started":
                        started.set()
                    elif kind in ("error", "session.closed"):
                        tasks.cancel_scope.cancel()
                        return
                    if not item or item.type != "delegation" or item.target != "client":
                        continue
                    identifier = item.id
                    if not DRAFT_ID.fullmatch(identifier):
                        raise BridgeError("Malformed voice draft identifier.")
                    text = item.draft_text()
                    # The compact event can precede a rich delegation.created with the same ID.
                    if kind == "session.delegation.created" and not text:
                        continue
                    if identifier in seen:
                        continue
                    if len(seen) >= MAX_DRAFTS:
                        raise BridgeError("Codex voice draft limit exceeded.")
                    seen.add(identifier)
                    if (not active.is_set() or not text or len(text.encode("utf-16-le")) > 2_000
                            or any(secret.get_secret_value() in text for secret in secrets)):
                        await append_draft_result(sideband, NO_TEXT, identifier)
                        continue
                    pending.add(identifier)
                    emit({"type": "draft", "id": identifier, "text": text})

            with anyio.fail_after(35):
                await peer.setLocalDescription(await peer.createOffer())
                offer = peer.localDescription
                if offer is None:
                    raise BridgeError("No local Codex voice media offer.")
                answer, sideband = await stack.enter_async_context(negotiate(offer.sdp))
                tasks.start_soon(receive_control, sideband)
                await peer.setRemoteDescription(RTCSessionDescription(sdp=answer, type="answer"))
                await started.wait()
                await connected.wait()
                await remote_audio.wait()
            if peer.connectionState != "connected":
                raise BridgeError("Codex voice media disconnected during startup.")
            emit({"type": "ready"})
            active.set()
            async for command in commands:
                match command:
                    case Input(audio=audio):
                        pcm = base64.b64decode(audio, validate=True)
                        if base64.b64encode(pcm).decode("ascii") != audio:
                            raise BridgeError("Invalid Codex voice input encoding.")
                        track.append(pcm)
                    case DraftResult(id=identifier, posted=posted):
                        if identifier not in pending:
                            raise BridgeError("Uncorrelated voice draft result.")
                        pending.remove(identifier)
                        await append_draft_result(sideband, POSTED if posted else NOT_POSTED, identifier)
                    case _ as unreachable:
                        assert_never(unreachable)
            tasks.cancel_scope.cancel()
    finally:
        track.stop()
        with anyio.move_on_after(1.5, shield=True):
            await peer.close()
        await stack.aclose()
