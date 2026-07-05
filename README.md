# Model Failover (never stop)

![Version](https://img.shields.io/badge/version-1.0.32-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![OpenCode](https://img.shields.io/badge/OpenCode-plugin-purple)

> Automatic model failover plugin for **OpenCode**. Detects any `session.error`
> (except `MessageAbortedError`) and switches the active session to the next model
> in a configured chain — transparently and unattended.

## 🔄 How it works

```mermaid
flowchart TD
    A["⚠️ session.error /<br/>session.status (retry)"]
    A --> B{"MessageAbortedError<br/>or isBusy or stale?"}
    B -->|"✅ Yes"| C["⏭️ Skip / ignore"]
    B -->|"❌ No"| D["🛑 Start failover()"]

    D --> E{"Next model<br/>in chain?"}
    E -->|"✅ Yes"| F["❌ Abort session<br/>→ wait 1s"]
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

## 💡 What it does

- **Automatic failover** — detects `session.error` (all status codes), aborts the session, selects the next model in the chain, and re-prompts with "Continue." The new model takes over with the existing conversation context.

- **Cascade logic** — if a failover model also fails, the chain advances to the next available model. Every decision is logged. If the chain is exhausted, a clear "❌ Failover chain exhausted" message is sent.

- **Unattended** — no manual intervention required. Notifications appear in the output. `MessageAbortedError` is ignored — only real errors trigger the cascade.

## 🚀 Install

```bash
cp model-failover.ts ~/.config/opencode/plugins/model-failover.ts
```

No npm, no build step, no dependencies. OpenCode runs TypeScript natively.

## ⏹️ Disable

```bash
mv ~/.config/opencode/plugins/model-failover.ts{,.disabled}
```

Or set `"enabled": false` in the config.

## ⚙️ Configuration

`~/.config/opencode/model-failover.json`:

```json
{
	"enabled": true,
	"chain":
	[
		{ "model": "opencode-go/deepseek-v4-flash", "variant": "max" },
		{ "model": "opencode-go/deepseek-v4-pro", "variant": "medium" },
		{ "model": "deepseek/deepseek-v4-flash-free", "variant": "max" }
	],
	"log_level": "info"
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Master switch. |
| `chain` | `object[]` | `[]` | Ordered model entries `{ model, variant? }` where `model` is `"providerID/modelID"`. Variant can be `max`, `high`, `medium`, `low`, etc. |
| `log_level` | `string` | `"info"` | `"silent"`, `"error"`, `"info"`, or `"debug"`. |

## 🪵 Logs

`~/.config/opencode/model-failover.log` (append-only). Format: `[ISO_TIMESTAMP] [LEVEL] message`.

```bash
tail -f ~/.config/opencode/model-failover.log
```

## 📖 Behavior

| Event | Reaction |
|---|---|
| `session.error` (any status code) | Immediate failover — abort session, pick next model, re-prompt with "Continue." |
| Error during failover cascade | Handled inline by the for-loop (logged + next model). Stale `session.error` events dropped by `isBusy` guard. |
| `MessageAbortedError` | Ignored. |
| Failover `prompt()` fails | Error logged, cascade advances to the next model. |
| Chain exhausted | "❌ Failover chain exhausted" sent to session. |
| User switches model via `/models` | Respects user's choice; next `session.error` restarts cascade from the beginning. |

## 💬 Notes

Less is more. :)

## 👤 Authors

- Alejandro Carraretto
- DeepSeek-V4

## 📄 License

MIT — version 1.0.32
