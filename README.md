# opencode-model-failover

Automatic model failover plugin for [OpenCode](https://opencode.ai). Detects model failures (rate limits, quota exhaustion, auth errors, network errors) and switches the active session to the next model in a configurable chain, transparently and unattended.

## What it does

When the active model fails with a permanent error (quota exceeded, billing, auth) the plugin immediately switches to the next eligible fallback. When the error is transient (overload, network) it waits for `maxRetries` attempts before switching. Every decision is logged, a TUI toast is shown, and the next user message is silently routed to the new model with a `⬆️ Failover` summary so the swap is visible without being noisy.

## Install

Drop the single file into your OpenCode plugins directory:

```bash
cp model-failover.js ~/.config/opencode/plugins/model-failover.js
```

OpenCode picks it up on next start. No npm, no build step, no dependencies.

## Update

```bash
cp model-failover.js ~/.config/opencode/plugins/model-failover.js
```

Or, if you cloned the repo:

```bash
git pull && cp model-failover.js ~/.config/opencode/plugins/model-failover.js
```

## Disable

Set `"enabled": false` in the config, or rename the plugin file:

```bash
mv ~/.config/opencode/plugins/model-failover.js{,.disabled}
```

## Configuration

`~/.config/opencode/model-failover.json`:

```json
{
	"enabled": true,
	"fallbackChain":
	[
		{ "model": "opencode-go/deepseek-v4-flash", "variant": "max" },
		{ "model": "opencode-go/deepseek-v4-pro", "variant": "medium" },
		{ "model": "deepseek/deepseek-v4-flash-free", "variant": "max" }
	],
	"maxRetries": 2,
	"cooldownMs": 30000,
	"logLevel": "info",
	"healthCheck": false
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Master switch. |
| `fallbackChain` | `object[]` | `[]` | Ordered fallback entries `{ model, variant? }` where `model` is `"providerID/modelID"`. |
| `maxRetries` | `number` | `2` | Auto-retries for transient errors before failover. |
| `cooldownMs` | `number` | `30000` | How long a failed model stays marked as unusable (ms). |
| `logLevel` | `string` | `"info"` | `"error"`, `"info"`, or `"debug"`. |
| `healthCheck` | `boolean` | `false` | Reserved. Currently ignored; pick is decided on cooldown state only. |

## Logs

`~/.config/opencode/model-failover.log` (append-only):

```bash
tail -f ~/.config/opencode/model-failover.log
```

Format: `[ISO_TIMESTAMP] [LEVEL] [model-failover] message`.

## Behavior

| Event | Reaction |
|---|---|
| `session.status` retry with permanent error message | Immediate failover, skip OpenCode countdown. |
| `session.status` retry with transient error, `attempt < maxRetries` | Wait. |
| `session.status` retry with transient error, `attempt >= maxRetries` | Failover. |
| `session.error` with 401 / 402 / 403 | Immediate failover. |
| `session.error` with 429 / 5xx | Failover (already retried by OpenCode). |
| Next `chat.message` after failover | Model silently overridden, summary tagged `⬆️ Failover: A → B`. |
| User picks a third model (not original, not failover) | Failover cleared, new model becomes original. |
| All fallbacks in cooldown or chain empty | Toast `Fallback chain exhausted`, session left as is. |

## Files

| File | Purpose |
|---|---|
| `model-failover.js` | The plugin. Single ESM file, zero dependencies. |
| `README.md` | This file. |
| `.gitignore` | `node_modules/`, `dist/`, logs, editor swap. |

## License

MIT
