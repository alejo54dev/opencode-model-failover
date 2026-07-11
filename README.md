# Model Failover (never stop)

![Version](https://img.shields.io/badge/version-1.0.38-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![OpenCode](https://img.shields.io/badge/OpenCode-plugin-purple)

> You're in the middle of something important, the model fails, the task gets interrupted, you lose the thread. You have to pick another model, restart the flow. And if you leave it running and go to sleep? Time wasted, everything wrong. Not anymore!

## 💡 What it does

> Models fail. Your conversation doesn't.

- **Auto failover** — detects the error (except if you cancelled), aborts, grabs the next model, sends "Continue." You never noticed.

- **Smart cascade** — if the second one also fails, it moves to the third. If all fail, it says so clearly. No awkward silence.

- **Zero intervention** — you touch nothing. Only real errors trigger the cascade.

## 🧠 Philosophy

A dead session is murdered productivity. Model errors are expected infrastructure — you abort cleanly, pick the next one, the conversation continues.

Not all errors are equal. `MessageAbortedError` is ignored — you cancelled, not a failover. Only real errors matter.

## 🔄 How it works

```mermaid
flowchart TD
    A["⚠️ session.error /<br/>session.status (retry)"]
    A --> B{"MessageAbortedError<br/>or isBusy or stale?"}
    B -->|"✅ Yes"| C["⏭️ Skip / ignore"]
    B -->|"❌ No"| D["🛑 Start failover()"]

    D --> E{"Next model<br/>in chain?"}
    E -->|"✅ Yes"| F["❌ Abort session<br/>→ 1s pre + 1s post wait"]
    F --> G["💬 Prompt 'Continue.'<br/>with &lt;model&gt;"]
    G --> H{"Response OK?"}
    H -->|"✅ Yes"| I["✏️ Override model<br/>(chat.message hook)"]
    H -.->|"❌ No"| E
    E -->|"❌ Exhausted"| J["❌ Chain exhausted<br/>→ send message"]

    K["🛑 session.deleted"]
    K --> L["🧹 reset()"]

    style A fill:#16213e,stroke:#e94560,color:#fff
    style B fill:#16213e,stroke:#e94560,color:#fff
    style C fill:#1a1a2e,stroke:#53a8b6,color:#fff
    style D fill:#0f3460,stroke:#53a8b6,color:#fff
    style E fill:#16213e,stroke:#e94560,color:#fff
    style F fill:#0f3460,stroke:#53a8b6,color:#fff
    style G fill:#0f3460,stroke:#53a8b6,color:#fff
    style H fill:#16213e,stroke:#e94560,color:#fff
    style I fill:#1a1a2e,stroke:#e94560,color:#fff
    style J fill:#1a1a2e,stroke:#e94560,color:#fff
    style K fill:#1a1a2e,stroke:#e94560,color:#fff
    style L fill:#1a1a2e,stroke:#e94560,color:#fff
```

## 🚀 Install

```bash
cp model-failover.ts ~/.config/opencode/plugins/model-failover.ts
```

No npm, no build step, no dependencies. OpenCode runs TypeScript natively.

## ⚙️ Configuration

Copy `model-failover.jsonc` (included in this repo) to `~/.config/opencode/` and edit:

```jsonc
{
	"enabled": true,
	"chain":
	[
		{ "model": "opencode-zen/hy3-free", "variant": "max" },
		{ "model": "opencode-go/deepseek-v4-pro", "variant": "medium" },
		{ "model": "deepseek/deepseek-v4-flash-free", "variant": "max" }
	],
	"log_level": "info"     // "silent" | "error" | "info" | "debug"
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Master switch. |
| `chain` | `object[]` | `[]` | Ordered model entries `{ model, variant? }` where `model` is `"providerID/modelID"`. Variant can be `max`, `high`, `medium`, `low`, etc. |
| `log_level` | `string` | `"info"` | `"silent"`, `"error"`, `"info"`, or `"debug"`. |

## 🪵 Logs

`~/.config/opencode/model-failover.log` (append-only). Format: `[TIMESTAMP] [LEVEL] message`.

```bash
tail -f ~/.config/opencode/model-failover.log
```

```log
[2026-07-05T10:30:00] [INFO]: Config loaded
[2026-07-05T10:30:01] [INFO]: Loaded: 3 models
[2026-07-05T10:35:22] [INFO]: Trying 0: opencode-zen/hy3-free
[2026-07-05T10:35:25] [INFO]: Override: opencode-zen/hy3-free:max
[2026-07-05T10:36:00] [INFO]: Current model: opencode-zen/hy3-free
[2026-07-05T10:40:00] [INFO]: Trying 1: opencode-go/deepseek-v4-pro
[2026-07-05T10:40:00] [INFO]: Chain models exhausted
[2026-07-05T10:45:00] [DEBUG]: Prompt aborted for opencode-go/deepseek-v4-pro, stopping cascade
[2026-07-05T10:50:00] [DEBUG]: Stale skip: 304 (override active)
```

## 📖 Behavior

| Event | Reaction |
|---|---|
| `session.error` (any status code) | Immediate failover — abort session, pick next model, re-prompt with "Continue." |
| Error during failover cascade | Logged and advances to the next model in the chain. Stale `session.error` events dropped by `isBusy` guard. |
| `MessageAbortedError` | Ignored. |
| Failover `prompt()` fails | Error logged, cascade advances to the next model. |
| Chain exhausted | "❌ Failover chain exhausted" sent to session. |
| User switches model via `/models` | Respects user's choice; next `session.error` restarts cascade from the beginning. |

## 💬 Notes

- Failover prompts use `synthetic: true` for model-facing text and `ignored: true` for UI-only notifications.

Less is more. :)

## 👤 Authors

- Alejandro Carraretto
- DeepSeek-V4

## 📄 License

MIT — version 1.0.38
