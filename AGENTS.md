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
  2. `session.status` with `status.type == "retry"` → capture `sessionID`, reset `idx`, call `#failover()` (skipped if `isBusy`).
  3. `session.error` with `statusCode ∈ [401, 402, 403, 404]` and not `MessageAbortedError`:
     - If `isBusy` and same session → set `inCascade = true` (signal for the running failover step).
     - If `isBusy` but different session → silently drop.
     - If `failoverModel` set and same session → stale, drop.
     - If `idx > 0` (mid-cascade, between steps) → set `inCascade = true`, return (signal for the pending recursion).
     - Otherwise → set `sessionID` / `lastError`, reset `idx`, call `#failover()`.
- **`chat.message`** — Clears per-turn state (`sessionID`, `lastError`, `idx`, `inCascade`, `isExhausted`). Captures `State.originalModel` (incl. variant) on first message. Detects user-initiated model changes and clears `failoverModel`. When `failoverModel` is set, overrides `output.message.model` if `input.model` matches the original model.
- **`dispose`** — Resets all `State` fields.

## Global state

```
State = {
    config        : object|null,   // { enabled, models, logLevel }
    sessionID     : string|null,   // session currently being failed over
    originalModel : object|null,   // { providerID, modelID, variant? } user's TUI selection
    failoverModel : object|null,   // { providerID, modelID, variant? } last working model
    lastError     : object|null,   // { name, statusCode, message }
    idx           : 0,             // chain index, advances per attempt
    isBusy        : false,         // re-entrancy guard for #failover()
    inCascade     : false,         // continues the chain; set async by session.error or sync by prompt() failure
    isExhausted   : false          // informational flag
}
```

## `#failover()` — recursive one-step cascade

Each call tries exactly one model from the chain. Exhaustion is checked
at the top before any I/O — guaranteeing it is always reached.

```js
async #failover() {
    if (State.isBusy) return;
    if (!State.config?.models?.length) return;
    if (!State.sessionID) return;

    State.isBusy  = true;
    State.inCascade = false;

    try {
        if (State.idx >= State.config.models.length) {
            // EXHAUSTION — checked at top, before any I/O
            State.isExhausted   = true;
            State.failoverModel = null;
            log("Chain models exhausted");
            await prompt("❌ Failover chain exhausted").catch(() => {});
            return;
        }

        const i = State.idx; State.idx++;
        const entry = models[i];
        const model = modelFromEntry(entry);
        const label = labelFromEntry(entry);

        try {
            const result = await prompt(model, "✅ Failover to [label]", "Continue.");
            if (result?.data?.info?.error)    State.inCascade = true;
            if (result?.data?.info?.state == "rejected") State.inCascade = true;
        } catch (err) {
            State.inCascade = true;
        }

        if (State.inCascade) {
            log(`Failed ${i}: ${label}`);
            return;
        }

        State.failoverModel = model;
        log(`Override: ${label}`);
    } finally {
        State.isBusy = false;
    }

    if (State.inCascade) {
        State.inCascade = false;
        await this.#failover();  // recursive advance to next model
    }
}
```

## Error-detection model (dual mechanism)

Two signals feed into the `#failover()` recursion:

1. **Synchronous** — `prompt()` throw or `result.data.info.error`/`rejected` → sets `inCascade`
2. **Asynchronous** — `session.error` events during `isBusy` set `State.inCascade = true`

After `isBusy` is released in `finally`, the function checks `State.inCascade` and
recursively calls itself to try the next model. The `inCascade` flag is captured
inside the busy lock and processed immediately after.

**Mid-cascade guard**: If `session.error` fires between recursive steps (when `isBusy`
is briefly false), the handler checks `State.idx > 0`. When true it sets `inCascade = true`
and returns without resetting `idx`, preserving chain progress.

Stale errors arriving after the cascade completes (when `failoverModel` is set
and `isBusy` is false) are silently dropped.

## chat.message override flow (across messages)

1. Per-turn state cleared (`sessionID`, `lastError`, `idx`, `inCascade`, `isExhausted`).
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
- Detection of failures uses both synchronous `result.data.info` inspection and asynchronous `session.error` events via the busy/cascade flag pattern.
