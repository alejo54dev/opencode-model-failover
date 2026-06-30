# opencode-model-failover — Agent context

## Overview

OpenCode plugin that fails over to a failover model when the active model hits a permanent error (HTTP 401–404) or when a failover model itself errors and the cascade needs to continue. Per-session state is a single `Map<sessionID, number>` storing the current index in the failover chain.

## Architecture

| File | Role |
|---|---|
| `model-failover.js` | Plugin entry point. Exports default async function returning two hooks. |

## Hooks

- **`event`** — Listens for `session.deleted` (cleans up per-session state) and `session.error`. On `session.error`: triggers failover if the error has status 401–404, or if the session is already mid-cascade (`idx > 0`). Ignores `MessageAbortedError`.
- **`dispose`** — Clears the `Map<sessionID>`.

## State shape

A single `Map<sessionID, number>` — each entry stores the current chain index. If no entry exists, the cascade has not started (idx = 0).

## Failover flow

1. `session.error` with status 401/402/403/404 → `failover(sessionID, errorInfo)` called.
2. `idx = sessions.get(sessionID) ?? 0` picks `models[idx]`.
3. Log `[idx] modelName — ErrorName (statusCode)`, increment idx, store idx back.
4. `client.session.abort()` cancels the failing request.
5. `client.session.prompt()` re-prompts with the failover model directly in the API body, sending "✅ Failover model to [label]" + "Continue.".
6. If `prompt()` throws (failover model also fails), the error is caught, logged as cascading, and the while loop advances to `models[++idx]`.
7. If the chain exhausts, the session entry is deleted, "❌ Failover chain exhausted" is sent.
8. Cascade index persists across user messages — no reset. A new `session.error` for the same session will continue from where the chain left off.

## Config

`~/.config/opencode/model-failover.json`:

- `enabled` (boolean, default `true`)
- `models` (array of `{ model, variant? }`)
- `logLevel` (`"error"` | `"info"` | `"debug"`, default `"info"`)

## Conventions

- Tabs for indentation, Allman braces, spaces inside parens/brackets, space before semicolons.
- English-only artifacts.
- No public properties, no `global`, composition over inheritance.
