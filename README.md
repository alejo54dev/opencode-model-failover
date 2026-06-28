# opencode-model-failover

Automatic model failover plugin for [OpenCode](https://opencode.ai). Detects model failures (rate limits, auth errors, quota exhaustion, network errors) and switches to a configurable chain of fallback models.

## Installation

```bash
npm install opencode-model-failover
```

Or with Bun:

```bash
bun add opencode-model-failover
```

## Configuration

Create `~/.config/opencode/model-failover.json`:

```json
{
  "enabled": true,
  "fallbackChain": [
    "openai/gpt-4o",
    "anthropic/claude-3-opus",
    "google/gemini-2.5-pro"
  ],
  "maxRetries": 2,
  "cooldownMs": 30000
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Enable/disable the plugin |
| `fallbackChain` | `string[]` | `[]` | Ordered list of fallback models (`provider/model`) |
| `maxRetries` | `number` | `2` | Max retry attempts for transient errors |
| `cooldownMs` | `number` | `30000` | Cooldown period after failover (ms) |

## How it works

1. **Error classification** — Errors are classified as permanent (auth, quota, billing) or transient (rate limits, network, server errors)
2. **Retry with backoff** — Transient errors are retried up to `maxRetries` times with exponential backoff
3. **Fallback chain** — Permanent errors or exhausted retries trigger failover to the next model in the chain
4. **Cooldown protection** — Failed models get a 60s cooldown; sessions get a configurable cooldown after failover

## License

MIT
