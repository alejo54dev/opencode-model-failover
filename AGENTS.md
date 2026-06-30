# opencode-model-failover — Agent context

## Overview

OpenCode plugin that fails over to a failover model when the active model hits a permanent error (HTTP 4xx) or when a failover model itself errors and the cascade needs to continue. Uses module-level global state (no Map, no per-session tracking). On each cascade the chain is traversed from index 0; on success the pointer resets so every error retries the full chain.

## Architecture

| File | Role |
|---|---|
| `model-failover.js` | Plugin entry point. Exports default async function returning three hooks. `class ModelFailoverPlugin` with private fields/methods. |

## Hooks

- **`event`** — Listens for `session.deleted` (clears all runtime State) and `session.error`. On `session.error`: sets `State.sessionID` / `State.lastError`, triggers `#failover()` if `statusCode >= 400 && < 500` and `State.isFailingOver` is false. Ignores `MessageAbortedError`.
- **`chat.message`** — Intercepts every user message. Captures `State.originalModel` on first message seen. If `State.failoverModel` is set and `input.model` matches the original, overrides `output.message.model` to the failover model. Clears failover state if the user manually changes the model.
- **`dispose`** — Resets all State fields to null/0/false.

## Global state

```
State = {
    config:        object|null,  // { enabled, models, logLevel }
    sessionID:     string|null,  // current session being failed over
    chainIdx:      number,       // current index in models[] during cascade
    originalModel: object|null,  // { provider, model } first model seen
    failoverModel: object|null,  // { provider, model, variant? } last working model
    lastError:     object|null,  // { name, statusCode, message }
    isExhausted:   boolean,      // true when whole chain fails
    isFailingOver: boolean       // guard to prevent re-entrant failover
}
```

All runtime state lives in `State`. Methods reference it directly — no parameters passed to `#failover()`.

## Failover flow (within one message turn)

1. `session.error` with `statusCode >= 400 && < 500` → `State.sessionID` / `State.lastError` set, `#failover()` called with no arguments.
2. Loop `State.chainIdx = 0` through `State.config.models[]`:
   - `abort()` cancels failing request, `prompt()` called with failover model.
   - If `prompt()` succeeds: `State.failoverModel` saved, loop exits.
   - If `prompt()` throws: `State.chainIdx++`, loop continues.
3. If all models exhausted: `State.isExhausted = true`, `State.failoverModel = null`, "❌ Failover chain exhausted" sent.

## chat.message override flow (across messages)

1. First message ever: `State.originalModel` captured from `input.model`. No override.
2. After a cascade saves `State.failoverModel`:
   - If `input.model` matches `State.originalModel` → override to `State.failoverModel`.
   - If `input.model` already matches `State.failoverModel` → nothing to do.
   - If matches neither → user changed model → state cleared, `State.originalModel` updated.
3. Failover persists until chain exhausts or user changes model.

## Config

`~/.config/opencode/model-failover.json`:

- `enabled` (boolean, default `true`)
- `models` (array of `{ model, variant? }`)
- `logLevel` (`"error"` | `"info"` | `"debug"`, default `"info"`)

## Conventions

- Tabs for indentation, Allman braces, spaces inside parens/brackets, space before semicolons.
- English-only artifacts.
- No public properties, no `global`, composition over inheritance.
