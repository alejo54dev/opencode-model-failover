# opencode-model-failover — Agent context

## Overview

OpenCode plugin that fails over through a configured chain of models whenever
the active model returns a permanent HTTP 4xx/500 (401/402/403/404/500). Uses
module-level `STATE` as the single source of truth — no `Map`, no per-session
tracking. The cascade starts at index 0 on every trigger. On success the loop
exits; on exhaustion the session is sent "❌ Failover chain exhausted.".

## Architecture

| File | Role |
|---|---|
| `model-failover.js` | Single-file plugin. Default export returns three hooks, module-level functions. |

Module-level functions:

- `loadConfig()` — read & parse config JSON
- `log(level, message)` — append to log file
- `parseEntry(entry)` — split `"provider/model"` into `{ providerID, modelID, variant? }`
- `failover(sessionID, client)` — for-loop cascade
- `onEvent({ event }, client)` — event hook
- `onChatMessage(input, output)` — chat.message hook
- `reset()` — clear STATE

## Hooks

- **`event`** — Three branches:
  1. `session.deleted` → `reset()`.
  2. `session.status` with `status.type == "retry"` → capture `sessionID`, call `failover()` (skipped if `isBusy` or `failoverModel` set).
  3. `session.error` with `statusCode ∈ [401, 402, 403, 404, 500]` and not `MessageAbortedError`:
     - If `isBusy` → silently drop (for-loop captures failures inline).
     - If `failoverModel` set and same session → stale, drop silently.
     - Otherwise → set `sessionID`, call `failover()`.
- **`chat.message`** — Tracks `sessionID`. Captures `STATE.originalModel` on
  first message. Detects user model changes → clears `failoverModel`. When
  `failoverModel` is set, **unconditionally** overrides `output.message.model`
  (this was the critical fix — no guard on `originalModel` match).
- **`dispose`** — Resets all `STATE` fields.

## Global state

```
STATE = {
    config        : object|null,   // { enabled, models, logLevel }
    sessionID     : string|null,   // session being failed over
    originalModel : object|null,   // { providerID, modelID, variant? }
    failoverModel : object|null,   // { providerID, modelID, variant? }
    isBusy        : false,         // re-entrancy guard
}
```

## `failover()` — for-loop cascade

Aborts session first, then tries each model. On first success sets
`failoverModel` and returns. When every model returns an error,
`failoverModel` is nulled, session aborted again, and exhaustion
message sent. Detects `"Aborted"` to stop cascade early.

```
for (let i = 0; i < models.length; i++)
    abort(sessionID)
    prompt(model, "✅ Failover to [label]", "Continue.")
    if errMsg == "Aborted" → return
    if errMsg or state != "ok" → continue
    set failoverModel, return
// Exhausted: null failoverModel, abort, send "❌ Failover chain exhausted."
```

## Error detection

```
info?.error?.data?.message ?? info?.error?.message ?? result?.error?.data?.message ?? result?.error?.message ?? ""
```

## chat.message override flow

1. `sessionID` tracking. Skip if `isBusy`.
2. First message ever: capture `STATE.originalModel` from `input.model`.
3. Model-change detection: if `input.model` differs from `STATE.originalModel`
   → clear `failoverModel`, update `originalModel`, return (no override).
4. Override: if `STATE.failoverModel` is set → `output.message.model = { ...STATE.failoverModel }`.
   **No `originalModel` match guard** — this was the bug fix that eliminated
   model superposition.

## Config

`~/.config/opencode/model-failover.json`:

- `enabled` (boolean, default `true`)
- `models` (array of `{ model, variant? }`)
- `logLevel` (`"error"` | `"info"` | `"debug"`, default `"info"`)

## Conventions

- Tabs for indentation, Allman braces, spaces inside parens/brackets, space before semicolons.
- English-only artifacts.
- Module-level functions, no class, no `global`.
