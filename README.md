# pi-metrics-footer

Live model speed and usage metrics in the pi TUI footer: tokens/sec while streaming, per-turn average speed, token/cost/context stats, and model name — with configurable model labels.

## Features

- **Live tokens/sec** while the model streams (`⚡ 45t/s`), computed from a 2s rolling window of `text_delta` / `thinking_delta` events.
- **Per-turn average** as a fallback: after a reply finishes, the average speed shows for 8 seconds — so it works even when the provider doesn't stream deltas.
- **Token / cost / context line**: input, output, cache read/write, cost, and context usage, plus the current model (emoji label + thinking level).
- **Configurable model labels**: map `provider/model` IDs to your own display names.

## Install

```bash
pi install npm:pi-metrics-footer
```

Then restart pi. The footer is replaced on session start.

## Update

```bash
pi update npm:pi-metrics-footer
```

Updates are manual; the package does not auto-update.

## Uninstall

Remove `pi-metrics-footer` from the `packages` list in `~/.pi/agent/settings.json`, then restart pi.

## Configuration

Create `<pi-agent-dir>/pi-metrics-footer.json` (default: `~/.pi/agent/pi-metrics-footer.json`):

```json
{
  "modelLabels": {
    "anthropic/claude-sonnet-5": "🎭 Sonnet 5",
    "openai/gpt-5.5": "🧠 GPT-5.5"
  }
}
```

Keys are `provider/model` exactly as shown by pi (e.g. from `/model`). User labels override the built-in defaults for the same key and add new ones. Restart pi (or `/reload`) after editing.

## How It Works

- **Live TPS** uses a 2s rolling window of streaming token events; it needs at least 2 samples within the window, so very short replies may not show it.
- **Average TPS** = output tokens ÷ wall time of the last finished assistant message, shown for 8s.
- When idle, nothing shows — the indicator hides on its own.

## License

MIT
