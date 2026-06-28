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

1. Error detected → `failover()` sets cooldown on current model AND on selected fallback (to prevent re-selection loops), then picks the next fallback from the chain.
2. Calls `client.session.abort()` to cancel the current failing request.
3. Re-prompt sent via `client.session.prompt( { body: { model, parts } } )` — the fallback model is passed **directly in the API call**, so the re-prompt uses the new model immediately.
4. On next `chat.message`, three cases:
   - Incoming model matches original failed model → `output.message.model` overridden to fallback (user still on old model).
   - Incoming model already matches fallback → session state cleaned up (model was already switched by prompt API).
   - Neither → user manually changed model → failover cleared, `currentModel` updated.

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
