# opencode-model-failover — Agent context

## Overview

OpenCode plugin that fails over through a configured chain of models whenever
the active model returns a permanent HTTP 4xx (401/402/403/404). Uses module-level
global `State` as the single source of truth — no `Map`, no per-session tracking.
The cascade starts at index 0 on every trigger, so models that recover are picked
up again. On success the loop exits; on exhaustion the session is terminated
with a fixed message.

## Architecture

| File | Role |
|---|---|
| `model-failover.js` | Single-file plugin. Default export returns three hooks. `class ModelFailoverPlugin` with private helpers. |

The whole plugin is one class with five private helpers and three public hooks:

- Private: `#loadConfig`, `#log`, `#labelFromEntry`, `#modelFromEntry`, `#failover`
- Public: `onEvent`, `onChatMessage`, `reset`

## Hooks

- **`event`** — Four branches:
  1. `session.deleted` → `reset()`.
  2. `session.status` with `status.type == "retry"` → capture `sessionID`, call `#failover()` (skipped if `isBusy` or `failoverModel` set).
  3. `session.error` with `statusCode ∈ [401, 402, 403, 404, 500]` and not `MessageAbortedError`:
     - If `isBusy` → silently drop (while-loop captures failures inline).
     - If `failoverModel` set and same session → stale, drop silently.
     - Otherwise → set `sessionID` / `lastError`, call `#failover()`.
- **`chat.message`** — Updates `sessionID` to track current session.
  Clears per-turn state if no `failoverModel`. Captures `State.originalModel`
  (incl. variant) on first message. Detects user-initiated model changes and
  clears `failoverModel`. When `failoverModel` is set, overrides
  `output.message.model` if `input.model` matches the original model.
- **`dispose`** — Resets all `State` fields.

## Global state

```
State = {
    config        : object|null,   // { enabled, models, logLevel }
    sessionID     : string|null,   // session currently being failed over
    originalModel : object|null,   // { providerID, modelID, variant? } user's TUI selection
    failoverModel : object|null,   // { providerID, modelID, variant? } last working model
    lastError     : object|null,   // { name, statusCode, message }
    isBusy        : false,         // re-entrancy guard for #failover()
}
```

## `#failover()` — while-loop cascade

A single while-loop that aborts the session first (to reset its error state),
then tries each model. On the first success it sets `failoverModel` and returns.
When every model returns an error, `failoverModel` is nulled, the session is
aborted again, and a "❌ Failover chain exhausted." message is sent.

```js
async #failover() {
    if (State.isBusy) return;
    if (!State.config?.models?.length) return;
    if (!State.sessionID) return;

    State.isBusy = true;
    try {
        // Abort to reset session state after the 4xx
        await this.#client.session.abort(...).catch(() => {});
        for (let i = 0; i < models.length; i++) {
            // prompt(model, ...)
            // if error → continue to next model
            // if ok    → set failoverModel, return
        }
        // Exhausted — null failoverModel, abort, prompt exhausted message
    } finally {
        State.isBusy = false;
    }
}
```

## Error detection

The while-loop inspects the `prompt()` return value synchronously using a
single property path:

```
info?.error?.data?.message ?? "unknown"
```

Only `info.error.data.message` carries the actual error text; the sibling
`.name` is generic ("Error") and `.statusCode` is logged separately.
`result.error` mirrors `info.error` so it adds no value. The one-line chain
keeps debug logs concise while avoiding dead fallback clutter.

No async error signaling is needed because the while-loop captures the failure
inline — `prompt()` either throws or returns a result with `result.error` /
`info.error`.

Stale errors arriving after the cascade completes (when `failoverModel` is set,
`isBusy` is false, and `sid === State.sessionID`) are silently dropped.

## chat.message override flow

1. `sessionID` tracking: if `failoverModel` is set, `sessionID` is updated to
   `input.sessionID` for correct stale-error detection. Otherwise cleared.
2. First message ever: `State.originalModel` captured from `input.model`.
3. Model-change detection (always, independent of failover state):
   - If `input.model` differs from `State.originalModel` → failover cleared,
     `State.originalModel` updated, log, return (no override).
4. Override (only when `State.failoverModel` is set):
   - If `input.model` matches `State.originalModel` → `output.message.model` overridden
     to `State.failoverModel`.
   - Otherwise nothing to do.

## Config

`~/.config/opencode/model-failover.json`:

- `enabled` (boolean, default `true`)
- `models` (array of `{ model, variant? }`)
- `logLevel` (`"error"` | `"info"` | `"debug"`, default `"info"`)

## Conventions

- Tabs for indentation, Allman braces, spaces inside parens/brackets, space before semicolons.
- English-only artifacts.
- No public properties on the class except the three hooks, no `global`, composition over inheritance.
- The while-loop cascade uses only synchronous result inspection; no async state flags.
