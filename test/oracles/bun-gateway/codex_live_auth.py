"""Local Codex managed-login RPC. No thread, turn, login, or tool request is sent."""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from subprocess import DEVNULL, PIPE
from typing import Final, Literal
from urllib.parse import urlsplit

import anyio
from anyio.abc import ByteSendStream
from anyio.streams.buffered import BufferedByteReceiveStream
from pydantic import BaseModel, ConfigDict, Field, SecretStr

MAX_RPC_BYTES: Final = 256 * 1024
JWT: Final = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\Z")
ACCOUNT_ID: Final = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
SUBSCRIPTION_PLANS: Final = frozenset({
    "go", "plus", "pro", "prolite", "promax", "team", "business", "enterprise",
    "edu", "edu_plus", "edu_pro", "ent26", "self_serve_business_prolite",
    "self_serve_business_usage_based", "enterprise_cbp_automation",
    "enterprise_cbp_usage_based", "sci", "sci_plus",
})


class CodexLoginError(RuntimeError):
    """A managed subscription login could not be safely resolved."""


class ManagedAccount(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True)
    type: Literal["chatgpt"]
    plan_type: str = Field(alias="planType")
    email: str | None
    workspace_name: str | None = Field(default=None, alias="workspaceName")


class WorkspaceRouting(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True)
    backend_origin: str = Field(alias="backendOrigin")
    account_routing_override: Literal["NO_CONSTRAINT"] | None = Field(default=None, alias="accountRoutingOverride")
    chatgpt_account_id: str = Field(alias="chatgptAccountId")


class AccountResponse(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True)
    account: ManagedAccount
    requires_openai_auth: Literal[True] = Field(alias="requiresOpenaiAuth")
    workspace_routing: WorkspaceRouting | None = Field(default=None, alias="workspaceRouting")
    user_id: str | None = Field(default=None, alias="userId")


class AuthStatus(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True)
    auth_method: Literal["chatgpt"] = Field(alias="authMethod")
    auth_token: SecretStr = Field(alias="authToken")
    requires_openai_auth: Literal[True] = Field(alias="requiresOpenaiAuth")


class AccountClaim(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True)
    chatgpt_account_id: str = Field(min_length=1, max_length=128)
    chatgpt_user_id: str | None = None


class ProfileClaim(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True)
    email: str | None = None


class JwtClaims(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True)
    exp: int
    auth: AccountClaim = Field(alias="https://api.openai.com/auth")
    profile: ProfileClaim | None = Field(default=None, alias="https://api.openai.com/profile")


@dataclass(frozen=True, slots=True)
class CodexLogin:
    token: SecretStr
    account_id: SecretStr


class RpcMessage(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True)
    id: int | str | None = None
    method: str | None = None
    result: dict[str, str | int | bool | dict[str, str | int | bool | None] | None] | None = None


type RpcParams = dict[str, str | bool | dict[str, str]]


async def rpc(
    streams: tuple[ByteSendStream, BufferedByteReceiveStream],
    request_id: int,
    message: tuple[str, RpcParams],
) -> RpcMessage:
    send, receive = streams
    method, params = message
    await send.send((json.dumps({"id": request_id, "method": method, "params": params}) + "\n").encode())
    for _ in range(64):
        frame = await receive.receive_until(b"\n", MAX_RPC_BYTES)
        reply = RpcMessage.model_validate_json(frame)
        if reply.id is None and reply.method is not None:
            continue  # Unsolicited notifications have no effect.
        if reply.id == request_id and reply.method is None and reply.result is not None:
            return reply
        break  # No server-initiated requests or raw error payloads.
    raise CodexLoginError("Unexpected Codex managed-login response.")


async def read_codex_login() -> CodexLogin:
    # Never resolve the auth broker (or a wrapper's interpreter) from a project
    # PATH, including absolute node_modules/.bin entries injected by Bun.
    paths = [str(Path.home() / ".local" / "bin"), "/opt/homebrew/bin", "/usr/local/bin",
             *[entry for entry in os.defpath.split(os.pathsep) if os.path.isabs(entry)]]
    executable = next((match for path in paths if (match := shutil.which(str(Path(path) / "codex")))), None)
    if not executable:
        raise CodexLoginError("Codex CLI is not installed.")
    env = {
        key: value for key in (
            "HOME", "CODEX_HOME", "SYSTEMROOT", "USERPROFILE", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP",
        ) if (value := os.environ.get(key))
    }
    env["PATH"] = os.pathsep.join(paths)
    env["RUST_LOG"] = "off"
    # Avoid project configuration and do not start/resume a Codex thread. The CLI
    # still owns its usual login/keyring and any managed organization policy.
    with tempfile.TemporaryDirectory(prefix="omp-codex-voice-") as empty_directory:
        process = await anyio.open_process(
            [executable, "app-server", "--listen", "stdio://",
             "-c", "analytics.enabled=false"],
            cwd=empty_directory, env=env, stdin=PIPE, stdout=PIPE, stderr=DEVNULL,
        )
        try:
            if process.stdin is None or process.stdout is None:
                raise CodexLoginError("Codex local authentication pipes are unavailable.")
            streams = process.stdin, BufferedByteReceiveStream(process.stdout)
            with anyio.fail_after(8):
                await rpc(streams, 1, ("initialize", {
                    "clientInfo": {"name": "omp-superagent-voice", "version": "1"},
                }))
                await process.stdin.send(b'{"method":"initialized"}\n')
                request = ("account/read", {"refreshToken": False})
                account = AccountResponse.model_validate((await rpc(streams, 2, request)).result)
                if account.account.plan_type not in SUBSCRIPTION_PLANS:
                    raise CodexLoginError("A ChatGPT subscription is required.")
                route = account.workspace_routing
                if route:
                    origin = urlsplit(route.backend_origin)
                    if (origin.scheme != "https" or origin.netloc != "chatgpt.com"
                            or origin.path not in ("", "/") or origin.query or origin.fragment):
                        raise CodexLoginError("The Codex workspace requires a different backend origin.")
                status = AuthStatus.model_validate((await rpc(streams, 3, ("getAuthStatus", {
                    "includeToken": True, "refreshToken": False,
                }))).result)
                confirmed = AccountResponse.model_validate((await rpc(streams, 4, request)).result)
                if confirmed != account:
                    raise CodexLoginError("The active Codex account changed during voice startup.")
            token = status.auth_token.get_secret_value()
            if len(token) > 32_768 or not JWT.fullmatch(token):
                raise CodexLoginError("Invalid Codex managed login.")
            payload = token.split(".")[1]
            claims = JwtClaims.model_validate_json(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            identity = claims.auth.chatgpt_account_id
            email = account.account.email
            if (claims.exp <= time.time() or not ACCOUNT_ID.fullmatch(identity)
                    or (route and route.chatgpt_account_id != identity)
                    or (account.user_id and claims.auth.chatgpt_user_id and account.user_id != claims.auth.chatgpt_user_id)
                    or (email and claims.profile and claims.profile.email and email.casefold() != claims.profile.email.casefold())):
                raise CodexLoginError("The Codex managed login is expired or does not match the active account.")
            # The provider verifies the JWT and determines the account's actual voice entitlement.
            return CodexLogin(status.auth_token, SecretStr(identity))
        finally:
            with anyio.CancelScope(shield=True):
                if process.returncode is None:
                    if process.stdin is not None:
                        await process.stdin.aclose()
                    with anyio.move_on_after(0.5):
                        await process.wait()
                    if process.returncode is None:
                        process.kill()
                await process.aclose()
