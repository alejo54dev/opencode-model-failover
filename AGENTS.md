# opencode-model-failover — Agent context

## Overview

OpenCode plugin that fails over to a failover model when the active model hits a permanent error (quota, billing, auth) or when OpenCode schedules an automatic retry. Per-session state stored in a `Map<sessionID>`, reset on each user message.

## Architecture

| File | Role |
|---|---|
| `model-failover.js` | Plugin entry point. Exports default async function returning three hooks. |

## Hooks

- **`event`** — Listens for `session.deleted`, `session.status` (type "retry"), and `session.error`. On retry or permanent error: reads the chain index from per-session state, picks `models[index]`, increments the index, aborts the current request, re-prompts with the failover model. Also handles `session.deleted` to clean up the per-session state.
- **`chat.message`** — Resets the chain index, `lastError`, and `triggeredAt` for the session. This ensures each new user message starts a fresh cascade through the failover chain.
- **`dispose`** — Clears the `Map<sessionID>`.

## State shape

Each entry in the sessions `Map`:

- `idx` (number) — current position in failover chain
- `busy` (boolean) — re-entrancy guard
- `cascade` (boolean) — unified flag (replaces old pending/shouldRetry duality)
- `sessionID` (string) — redundant but explicit
- `lastError` — `{ name, statusCode, message } | null`, captured from the original error
- `triggeredAt` — timestamp when the cascade was triggered

## Failover flow

1. `session.status("retry")` or `session.error` (status 401-404) detected → `getSession(sessionID)` creates/returns per-session state.
2. `state.idx` picks `models[idx]`.
3. `state.idx++` so the next error tries the next entry.
4. `client.session.abort()` cancels the failing request.
5. `client.session.prompt()` re-prompts with the failover model directly in the API body.
6. If the failover model also fails (prompt throws), `state.cascade = true` → recursive tail call to `failover()` with next idx.
7. On the next user message (`chat.message`), idx resets to 0, lastError/triggeredAt cleared. The cascade starts from the beginning again.

## Config

`~/.config/opencode/model-failover.json`:

- `enabled` (boolean, default `true`)
- `models` (array of `{ model, variant? }`)
- `logLevel` (`"error"` | `"info"` | `"debug"`, default `"info"`)

## Conventions

- Tabs for indentation, Allman braces, spaces inside parens/brackets, space before semicolons.
- English-only artifacts.
- No public properties, no `global`, composition over inheritance.
