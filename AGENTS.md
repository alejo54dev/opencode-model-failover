# opencode-model-failover — Agent context

## Overview

OpenCode plugin that fails over to a fallback model when the active model hits a permanent error (quota, billing, auth). Single ESM file, zero dependencies.

## Architecture

| File | Role |
|---|---|
| `model-failover.js` | Plugin entry point. Exports default async function that returns three hooks: `event`, `chat.message`, `dispose`. |

## Hooks

- **`event`** — Listens for `session.error` and `session.status` (type "retry"). Pattern-matches error messages and checks status codes 401/402/403. On match, calls `failover()`.
- **`chat.message`** — Captures current model on first message. Overrides `output.message.model` if a failover is pending. Detects manual model changes and clears failover state.
- **`dispose`** — Cleans session and cooldown maps.

## Failover flow

1. Error detected → `failover()` sets cooldown on current model, picks next fallback, calls `client.session.abort()`.
2. Re-prompt sent via `client.session.prompt()` with `"Continue."` to restart the session with the new model.
3. On next `chat.message`, if incoming model matches the original (failed) model, `output.message.model` is overridden to the fallback.
4. If user sends with a different model (neither original nor failover), failover is cleared and `currentModel` updated.

## Config

`~/.config/opencode/model-failover.json`:

- `enabled` (boolean, default `true`)
- `fallbackChain` (array of `{ model, variant? }`)
- `cooldownMs` (number, default `30000`)
- `logLevel` (`"error"` | `"info"` | `"debug"`, default `"info"`)

## Conventions

- Tabs for indentation, Allman braces, spaces inside parens/brackets, space before semicolons.
- English-only artifacts.
- No public properties, no `global`, composition over inheritance.
