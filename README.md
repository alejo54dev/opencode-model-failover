# opencode-model-failover

Automatic model failover plugin for [OpenCode](https://opencode.ai). Detects any session.error (except MessageAbortedError) and switches the active session to the next model in a configured chain — transparently and unattended.

## What it does

When the active model fails with a session.error the plugin immediately aborts the session, picks the next model in the chain, and sends a "Continue." re-prompt so the new model picks up the task using the existing conversation context. Notifications appear in the output. If a failover model also fails, the cascade continues to the next model in the chain. Every decision is logged.

## Install

```bash
cp model-failover.ts ~/.config/opencode/plugins/model-failover.ts
```

No npm, no build step, no dependencies. OpenCode runs TypeScript natively.

## Disable

```bash
mv ~/.config/opencode/plugins/model-failover.ts{,.disabled}
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
| `logLevel` | `string` | `"info"` | `"silent"`, `"error"`, `"info"`, or `"debug"`. |

## Logs

`~/.config/opencode/model-failover.log` (append-only). Format: `[ISO_TIMESTAMP] [LEVEL] message`.

```bash
tail -f ~/.config/opencode/model-failover.log
```

## Behavior

| Event | Reaction |
|---|---|
| `session.error` (any status code) | Immediate failover — abort session, pick next model, re-prompt with "Continue." |
| Error during failover cascade | Handled inline by the for-loop (logged + next model). Stale `session.error` events dropped by `isBusy` guard. |
| `MessageAbortedError` | Ignored. |
| Failover `prompt()` fails | Error logged, cascade advances to the next model. |
| Chain exhausted | "❌ Failover chain exhausted" sent to session. |
| User switches model via `/models` | Respects user's choice; next `session.error` restarts cascade from the beginning. |

## Version

Current: **v1.0.28** — CONFIG moved to Constants, Interfaces after Constants.

## Files

| File | Purpose |
|---|---|
| `model-failover.ts` | The plugin. Single TypeScript file, zero dependencies. |
| `README.md` | This file. |
| `AGENTS.md` | AI agent context. |

## License

MIT
