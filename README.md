# opencode-model-failover

Automatic model failover plugin for [OpenCode](https://opencode.ai). Detects permanent model failures (quota exhaustion, billing, auth) and switches the active session to the next model in a configurable chain — transparently and unattended.

## What it does

When the active model fails with a permanent error (quota exceeded, billing, auth) the plugin immediately aborts the session to skip OpenCode's retry countdown, picks the next eligible failover, sends a minimal "Continue." re-prompt so the new model picks up the task using the existing conversation context, and logs every decision. Notifications appear in the output message summary. Users can switch models manually with `/models` at any time.

## Install

```bash
cp model-failover.js ~/.config/opencode/plugins/model-failover.js
```

No npm, no build step, no dependencies.

## Disable

```bash
mv ~/.config/opencode/plugins/model-failover.js{,.disabled}
```

Or set `"enabled": false` in the config.

## Configuration

`~/.config/opencode/model-failover.json`:

```json
{
	"enabled": true,
	"models":
	[
		{ "model": "opencode-go/deepseek-v4-flash", "variant": "max" },
		{ "model": "opencode-go/deepseek-v4-pro", "variant": "medium" },
		{ "model": "deepseek/deepseek-v4-flash-free", "variant": "max" }
	],
	"cooldownMs": 30000,
	"logLevel": "info"
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Master switch. |
| `models` | `object[]` | `[]` | Ordered model entries `{ model, variant? }` where `model` is `"providerID/modelID"`. Variant can be `max`, `high`, `medium`, `low`, etc. |
| `cooldownMs` | `number` | `30000` | How long a failed model stays marked as unusable (ms). |
| `logLevel` | `string` | `"info"` | `"error"`, `"info"`, or `"debug"`. |

## Logs

`~/.config/opencode/model-failover.log` (append-only). Format: `[ISO_TIMESTAMP] [LEVEL] [model-failover] message`.

```bash
tail -f ~/.config/opencode/model-failover.log
```

## Behavior

| Event | Reaction |
|---|---|
| Permanent error message (quota, billing, etc.) | Immediate failover — abort session, pick failover, re-prompt with "Continue." |
| Transient errors (network, overload) | Ignored — OpenCode handles its own retries. |
| 401 / 402 / 403 status codes | Immediate failover. |
| Next `chat.message` from user with original model | Model silently overridden, summary tagged `⬆️ Failover: A → B`. |
| User switches model via `/models` | Failover cleared, user's choice respected. |
| All failovers in cooldown or chain empty | Error logged, notification shown. |

## Files

| File | Purpose |
|---|---|
| `model-failover.js` | The plugin. Single ESM file, zero dependencies. |
| `README.md` | This file. |
| `AGENTS.md` | AI agent context. |

## License

MIT
