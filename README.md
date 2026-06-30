# opencode-model-failover

Automatic model failover plugin for [OpenCode](https://opencode.ai). Detects permanent model failures (HTTP 401–404) and switches the active session to the next model in a configurable chain — transparently and unattended.

## What it does

When the active model fails with a permanent error (401/402/403/404) the plugin immediately aborts the session, picks the next model in the chain, and sends a "Continue." re-prompt so the new model picks up the task using the existing conversation context. Notifications appear in the output. If a failover model also fails, the cascade continues to the next model in the chain. Every decision is logged.

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
	"logLevel": "info"
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Master switch. |
| `models` | `object[]` | `[]` | Ordered model entries `{ model, variant? }` where `model` is `"providerID/modelID"`. Variant can be `max`, `high`, `medium`, `low`, etc. |
| `logLevel` | `string` | `"info"` | `"error"`, `"info"`, or `"debug"`. |

## Logs

`~/.config/opencode/model-failover.log` (append-only). Format: `[ISO_TIMESTAMP] [LEVEL] message`.

```bash
tail -f ~/.config/opencode/model-failover.log
```

## Behavior

| Event | Reaction |
|---|---|
| `session.error` with status 401 / 402 / 403 / 404 | Immediate failover — abort session, pick next model, re-prompt with "Continue." |
| `session.error` while already in a cascade (`idx > 0`) | Cascade continues to the next model in the chain. |
| `session.error` with other status codes | Ignored (transient errors handled by OpenCode). |
| `MessageAbortedError` | Ignored. |
| Failover `prompt()` fails | Error logged, cascade advances to the next model. |
| Chain exhausted | "❌ Failover chain exhausted" sent to session. |
| User switches model via `/models` | Respects user's choice; next `session.error` restarts cascade from the beginning. |

## Files

| File | Purpose |
|---|---|
| `model-failover.js` | The plugin. Single ESM file, zero dependencies. |
| `README.md` | This file. |
| `AGENTS.md` | AI agent context. |

## License

MIT
