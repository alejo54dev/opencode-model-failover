# opencode-model-failover — Agent context

## Overview

OpenCode plugin that fails over to a failover model when the active model hits a permanent error (quota, billing, auth). Minimal design: one chain-index counter per session, reset on each user message.

## Architecture

| File | Role |
|---|---|
| `model-failover.js` | Plugin entry point. Exports default async function returning three hooks. |

## Hooks

- **`event`** — Listens for `session.error` and `session.status` (type "retry"). On permanent error: reads the chain index for the session, picks `models[index]`, increments the index, aborts the current request, re-prompts with the failover model. Also handles `session.deleted` to clean up the chain index.
- **`chat.message`** — Resets the chain index for the session (`chainIdx.delete(sessionID)`). This ensures each new user message starts a fresh cascade through the failover chain.
- **`dispose`** — Clears the chain-index map.

## Failover flow

1. Permanent error detected → `chainIdx.get(sessionID) ?? 0` → picks `models[idx]`.
2. `chainIdx` set to `idx + 1` so the next error (if the failover also fails) tries the next entry.
3. `client.session.abort()` cancels the failing request.
4. `client.session.prompt()` re-prompts with the failover model directly in the API body.
5. On the next user message (`chat.message`), the chain index resets. If the user's model still fails, the cascade starts from the beginning again.

## Config

`~/.config/opencode/model-failover.json`:

- `enabled` (boolean, default `true`)
- `models` (array of `{ model, variant? }`)
- `logLevel` (`"error"` | `"info"` | `"debug"`, default `"info"`)

## Conventions

- Tabs for indentation, Allman braces, spaces inside parens/brackets, space before semicolons.
- English-only artifacts.
- No public properties, no `global`, composition over inheritance.
