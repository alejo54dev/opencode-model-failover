# opencode-model-failover — Agent context

## Overview

OpenCode plugin that fails over to a failover model when the active model hits a permanent error (quota, billing, auth, unknown model). Clean separation of responsibilities: detection, mechanics, and state reset are each handled by a different function.

## Architecture

| File | Role |
|---|---|
| `model-failover.js` | Plugin entry point. Exports default async function returning three hooks. |

## Responsibilities

- **`event` hook** — ONLY detects permanent errors. Listens for `session.error` (ignores `session.status` retry to avoid double-processing). Checks error message against patterns and status codes (401, 402, 403, 404). When a permanent error is found, calls `advanceFailover()`. Also handles `session.deleted` to clean up session state.

- **`advanceFailover()`** — Drives the failover mechanics. Picks `models[attempts]`, increments attempts, aborts the current request via `client.session.abort()`, and re-prompts with the failover model via `client.session.prompt()`. If the chain is exhausted (no more entries), sends a "❌ Failover chain exhausted." message directly. An `inProgress` guard per session prevents re-entrancy from rapid-fire events.

- **`chat.message` hook** — Resets the failover state (`attempts: 0, inProgress: false`) for the session. This ensures each new user message starts a fresh cascade. Does NOT reset while `isFailoverActive` is true (i.e., when the plugin itself is sending a prompt during failover).

- **`dispose` hook** — Clears the sessions map.

## Failover flow

1. `session.error` detected → `event` hook checks patterns/status codes.
2. If permanent → `advanceFailover(sessionID)` called.
3. Picks `models[attempts]`, increments `attempts`.
4. `client.session.abort()` cancels the failing request.
5. `client.session.prompt()` re-prompts with the failover model.
6. If the failover model also fails → next `session.error` → picks `models[1]` etc.
7. If all models exhausted → sends "❌ Failover chain exhausted." and sets `attempts = -1`.
8. On next user message (`chat.message`), state resets → cascade starts fresh.

## Config

`~/.config/opencode/model-failover.json`:

- `enabled` (boolean, default `true`)
- `models` (array of `{ model, variant? }`)
- `patterns` (array of strings, default includes quota/billing/auth/rate-limit/model-not-found patterns)
- `logLevel` (`"error"` | `"info"` | `"debug"`, default `"info"`)

## Conventions

- Tabs for indentation, Allman braces, spaces inside parens/brackets, space before semicolons.
- English-only artifacts.
- No public properties, no `global`, composition over inheritance.
