# KakaoTalk bridge protocol (version 1)

[Operations guide (Korean)](OPERATIONS.md#24-kakaotalk-로컬-브리지-주인-11-전용) ·
[Operations guide (English)](OPERATIONS.en.md#24-kakaotalk-local-bridge-owner-one-to-one-only) ·
[Reference bridge](../scripts/kakao-reference-bridge.ts) · [Adapter](../gateway/src/kakao.rs)

KakaoTalk has no bot API. The Gateway's `kakao` adapter therefore never signs in to
Kakao, stores no Kakao credentials and never contacts Kakao servers. It talks to a
**bridge** that the operator runs on the same machine. The bridge owns whatever Kakao
session or client automation the operator chooses. Superagent does not ship one: the
repository contains only a [reference bridge](../scripts/kakao-reference-bridge.ts)
with an in-memory inbox for tests and local demos.

> **Terms of service risk.** Automating a personal KakaoTalk account is not an
> official Kakao integration. It can violate Kakao's terms of service and may lead to
> account restriction or suspension. Kakao may change its client or protocol at any
> time. The operator alone chooses, runs and is responsible for the bridge. Use a
> separate account where possible and do not automate other people's chats.

## Roles

| Role | Responsibility |
| --- | --- |
| Bridge | Receives Kakao messages, durably records messages that the owner sent in the owner's one-to-one chat with the bridge account, serves them on the inbox endpoint, and delivers replies to that same chat only. |
| Adapter (Gateway) | Polls the inbox, admits rows that exactly match the configured owner and chat, and posts the head's replies. It cannot choose a destination. |

Group chats, open chats and other people's one-to-one chats are out of scope for
version 1. A bridge MUST NOT place their messages in the Superagent inbox.

## Transport and authentication

- Plain HTTP on a literal loopback address: `127.0.0.1` or `[::1]`, with an explicit
  port. The adapter rejects host names (including `localhost`), other addresses,
  HTTPS, credentials, query strings and fragments in `bridgeUrl`. It uses a dedicated
  HTTP client with environment/system proxies disabled, no redirects and no retries.
- A path in `bridgeUrl` is a base: `http://127.0.0.1:8080/kakao` uses
  `/kakao/superagent/inbox` and `/kakao/superagent/send`.
- Every request carries exactly one `X-Superagent-Token` header. The token is a
  dedicated secret for this interface only: at least 24 characters from
  `[A-Za-z0-9_-]`. Do not reuse a token that also authorizes other bridge features.
  The adapter reads it from the environment variable named by `kakao.tokenEnv`.

The bridge MUST:

1. Listen only on loopback and check that the peer address is loopback.
2. Reject (`403`) any request carrying a proxy or forwarding header (`Forwarded`,
   `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`) or a browser header (`Origin`,
   `Referer`, `Sec-Fetch-Site`). This blocks tunnelled requests and browser-based
   cross-site requests to the loopback port.
3. Reject (`403`) zero or several token headers and compare the token in constant
   time.
4. Never log the token or message bodies at default verbosity.
5. Never send replies anywhere but the owner's one-to-one chat. The send request does
   not name a chat, and the bridge MUST ignore any extra field that tries to.

## `GET /superagent/inbox`

Query parameters:

| Name | Meaning |
| --- | --- |
| `after` | Last row ID the adapter has processed (`0` on first contact). |
| `generation` | Inbox generation the adapter last saw (empty on first contact). |
| `limit` | Maximum rows to return. The adapter sends `50`. The bridge MUST NOT return more. |

Response: `200`, `Content-Type: application/json`.

```json
{
  "generation": "f1d2c3",
  "latest": 42,
  "messages": [
    {
      "id": 41,
      "logId": "3279618400000000001",
      "chatId": "18400000000000001",
      "senderId": "4000001",
      "text": "status?",
      "receivedAtMs": 1764000000000,
      "stale": false
    }
  ]
}
```

- `generation`: non-empty opaque string. It identifies one inbox history. The bridge
  MUST change it whenever row IDs can repeat or go backwards (database recreated or
  restored from backup). The reference rule: if `generation` matches but `after` is
  greater than `latest`, issue a new generation.
- `latest`: the highest row ID currently stored, `0` when empty.
- If the requested `generation` differs from the current one, the bridge returns the
  current `generation` and `latest` with **no** messages. The adapter then saves a
  new baseline instead of replaying history: on first contact it starts after `latest`
  (old commands are never executed); after a generation change it starts at `0`.
- Otherwise, return rows with `id > after` in ascending `id` order, at most `limit`.
- `id`: positive integer, strictly increasing within a generation.
- `logId`: Kakao's numeric message log ID, a decimal string without leading zeros (at
  most 20 digits). It is the durable message identity: the adapter admits
  `kakao:<botUserId>:<chatId>:<logId>` at most once, so replaying a row is harmless.
- `chatId`, `senderId`: decimal strings. The adapter drops rows that are not from the
  configured `ownerId` in the configured `chatId`. Only the row ID is logged.
- `text`: 1 to 4000 characters after trimming. Longer rows are dropped.
- `receivedAtMs`: positive Unix milliseconds no greater than 2^53 − 1.
- `stale` (optional, default `false`): the bridge sets it for a row that is too old to
  act on safely (the reference bridge uses 30 minutes since recording). The adapter does not
  execute a stale row and sends the owner one notice instead.
- The whole response body MUST stay below 4 MiB.

A non-JSON `200` (for example an HTML page from an older bridge), a non-`2xx` status,
invalid JSON, an oversized body or an over-limit page leaves the adapter's cursor
unchanged. It retries after a short back-off and logs one line per distinct error per
minute.

## `POST /superagent/send`

Request body (`Content-Type: application/json`):

```json
{ "pushId": "sa-0123456789abcdef01234567-0-2", "outputId": "out-17", "message": "plain text" }
```

- `pushId`: `sa-` followed by at most 120 characters from `[A-Za-z0-9._:-]`. It is
  derived deterministically from the durable output, chunk index and chunk count.
  The bridge MUST deliver a given `pushId` at most once. A repeated `pushId` returns
  success without sending again.
- `outputId`: the Superagent output that produced this chunk (informational; useful for
  matching answers to requests). Every chunk of one output shares it.
- `message`: plain text, 1 to 1500 characters. The adapter strips Markdown and splits
  long replies at line breaks (at most 20 chunks per output).

Responses:

| Status | Body | Adapter behaviour |
| --- | --- | --- |
| `200` | `{"ok": true, "state": "queued" \| "delivered"}` | Accepted. Duplicates also return this. |
| `409` | any | The chat is temporarily quiet. Rejected; Superagent may retry after 60 s. |
| other `4xx` | any | Rejected; the message is not retried. |
| `5xx`, timeout, invalid or oversized (> 64 KiB) receipt | any | Outcome unknown. Superagent does not resend automatically. |

## Unsupported features

Version 1 carries text only. Threads, attachments, reactions, typing indicators and
presence are unsupported. Approval cards cannot be shown: the adapter sends a short
notice and records the approval as **cancelled**. It never accepts one on the owner's
behalf.

## Security model summary

| Threat | Mitigation |
| --- | --- |
| Another local user or web page calls the bridge | Dedicated token, constant-time comparison, browser-header rejection. Loopback is not a sandbox: anyone who can run code as the same OS user can read the token. |
| Token leaves the machine | Literal loopback URL only, proxies disabled, redirects not followed. |
| Remote callers through a tunnel | Bridge rejects forwarding headers and non-loopback peers. |
| Someone else's message reaches the head | Bridge filters to the owner's one-to-one chat; adapter re-checks `ownerId`, `chatId` and `logId` on every row. |
| Replay after restart or restore | `generation` baseline, `after` cursor, and once-only admission by `logId`. |
| Duplicate sends after a timeout | Deterministic `pushId` and bridge-side deduplication; unknown outcomes are not resent automatically. |
| Prompt injection in owner chat | Messages are owner input with the same authority as the owner's other messengers. Anyone who controls the owner's Kakao account controls the head, as with any configured messenger. |
| Unbounded responses | 10 s request timeout, 2 s connect timeout, page and byte limits. |

## Versioning

This document describes version 1. A future incompatible change will use new
endpoint paths (for example `/superagent/v2/...`). New optional response fields may be
added; adapters ignore unknown fields.
