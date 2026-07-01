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
  2. `session.status` with `status.type == "retry"` → capture `sessionID`, call `#failover()` (skipped if already in cascade).
  3. `session.error` with `statusCode ∈ [401, 402, 403, 404]` and not `MessageAbortedError`:
     - If `State.isFailingOver` → set `State.iterationError = sc` (signal for the running loop).
     - Otherwise → set `State.sessionID` / `State.lastError`, log fail, call `#failover()`.
- **`chat.message`** — Clears per-turn state (`sessionID`, `lastError`, `isExhausted`). Captures `State.originalModel` on first message. If a `failoverModel` is set, overrides `output.message.model` when the message still references the original model. Detects user-initiated model change and resets failover.
- **`dispose`** — Resets all `State` fields.

## Global state

```
State = {
    config         : object|null,   // { enabled, models, logLevel }
    sessionID      : string|null,   // session currently being failed over
    originalModel  : object|null,   // { providerID, modelID } first model seen
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
    State.isFailingOver = true;
    try {
        for (let i = 0; i < State.config.models.length; i++) {
            const entry  = State.config.models[i];
            const model  = this.#modelFromEntry(entry);
            const label  = this.#labelFromEntry(entry);
            State.iterationError = null;
            this.#log(INFO, `Trying ${i}: ${label}`);
            try {
                await this.#client.session.prompt({
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

## Error-detection model (single mechanism)

The only signal of failure is `session.error` events. When one fires during a
cascade, `onEvent` sets `State.iterationError`. The `#failover()` loop checks
`State.iterationError` after a 300 ms wait post-`prompt()` (giving the event
loop time to drain any in-flight `session.error`). The wait is defensive — in
practice the event arrives inside the `await prompt()` window.

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
- Detection of failures is centralised on `session.error` events — no inspection of `result.data.info.error`, no retry-event polling.
