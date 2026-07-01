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

- **`event`** — Three branches, no nesting beyond one level:
  1. `session.deleted` → `reset()`.
  2. `session.status` with `status.type == "retry"` → capture `sessionID`, set `State.lastError`, call `#failover()` (skipped if already in cascade).
  3. `session.error` with `statusCode ∈ [401, 402, 403, 404]` and not `MessageAbortedError`:
     - If `State.isFailingOver` and same session → set `State.iterationError = sc` (signal for the running loop).
     - If `State.isFailingOver` but different session → silently drop.
     - Otherwise → set `State.sessionID` / `State.lastError`, log fail, call `#failover()`.
- **`chat.message`** — Clears per-turn state (`sessionID`, `lastError`, `iterationError`, `isExhausted`). Captures `State.originalModel` (incl. variant) on first message. If a `failoverModel` is set, overrides `output.message.model` when the message still references the original model (provider + model + variant match). Detects user-initiated model change and resets failover.
- **`dispose`** — Resets all `State` fields.

## Global state

```
State = {
    config         : object|null,   // { enabled, models, logLevel }
    sessionID      : string|null,   // session currently being failed over
    originalModel  : object|null,   // { providerID, modelID, variant? } first model seen
    failoverModel  : object|null,   // { providerID, modelID, variant? } last working model
    lastError      : object|null,   // { name, statusCode, message }
    isFailingOver  : boolean,       // re-entrancy guard for #failover()
    iterationError : number|null,   // statusCode captured from session.error during a cascade iteration
    isExhausted    : boolean        // informational flag set when the whole chain fails
}
```

All runtime state lives in `State`. Methods reference it directly — no parameters
passed to `#failover()`.

## `#failover()` — the one and only loop

```js
async #failover() {
    if (State.isFailingOver) return;
    if (!State.config?.models?.length) return;
    if (!State.sessionID) return;
    State.isFailingOver = true;
    try {
        for (let i = 0; i < State.config.models.length; i++) {
            if (!State.sessionID) return;   // aborted by reset()
            const entry  = State.config.models[i];
            const model  = this.#modelFromEntry(entry);
            const label  = this.#labelFromEntry(entry);
            State.iterationError = null;
            this.#log(INFO, `Trying ${i}: ${label}`);
            let result;
            try {
                result = await this.#client.session.prompt({
                    path: { id: State.sessionID },
                    body: {
                        model,
                        parts: [
                            { type: "text", text: `✅ Failover to [${label}]`, ignored: true },
                            { type: "text", text: "Continue." }
                        ]
                    }
                });
            } catch (err) {
                State.iterationError = err?.statusCode ?? "throw";
                this.#log(DEBUG, `prompt() threw for ${label}: ${err?.message ?? err}`);
            }
            if (!State.iterationError && result?.data?.info?.error)
                State.iterationError = result.data.info.error.statusCode ?? "error";
            if (!State.iterationError && result?.data?.info?.state == "rejected")
                State.iterationError = "rejected";
            await new Promise(r => setTimeout(r, 300));   // let session.error drain
            if (State.iterationError) {
                this.#log(INFO, `Failed ${i}: ${label} — ${State.iterationError}`);
                continue;
            }
            this.#log(INFO, `Override: ${label}`);
            State.failoverModel = model;
            return;
        }
        State.isExhausted = true;
        State.failoverModel = null;
        this.#log(INFO, "Cascade exhausted");
        await this.#client.session.prompt({
            path: { id: State.sessionID },
            body: { parts: [{ type: "text", text: "❌ Failover chain exhausted" }] }
        }).catch(() => {});
    } finally {
        State.isFailingOver = false;
    }
}
```

## Error-detection model (dual mechanism)

Two signals feed into the `#failover()` loop:

1. **Synchronous** — `prompt()` result is captured (`const result = await prompt()`). If `result.data.info.error` is present or `result.data.info.state == "rejected"`, the model is considered failed immediately.
2. **Asynchronous** — `session.error` events during a cascade set `State.iterationError`. The loop checks `State.iterationError` after a 300 ms wait post-`prompt()` (giving the event loop time to drain any in-flight `session.error`). Only errors matching the active cascade's session are accepted.

The dual approach closes the race window where an error could fire between the `await` resolving and the 300 ms deferred check.

## chat.message override flow (across messages)

1. First message ever: `State.originalModel` captured from `input.model`. No override.
2. After a cascade saves `State.failoverModel`:
   - If `input.model` matches `State.originalModel` → override to `State.failoverModel`.
   - If `input.model` already matches `State.failoverModel` → nothing to do.
   - If matches neither → user changed model → failover cleared, `State.originalModel` updated.
3. Failover persists until chain exhausts or user changes model.

## Config

`~/.config/opencode/model-failover.json`:

- `enabled` (boolean, default `true`)
- `models` (array of `{ model, variant? }`)
- `logLevel` (`"error"` | `"info"` | `"debug"`, default `"info"`)

## Conventions

- Tabs for indentation, Allman braces, spaces inside parens/brackets, space before semicolons.
- English-only artifacts.
- No public properties on the class except the three hooks, no `global`, composition over inheritance.
- Detection of failures uses both synchronous `result.data.info` inspection and asynchronous `session.error` events.
