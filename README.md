# pi-metrics-footer

Live model speed and usage metrics in the pi TUI footer: tokens/sec while streaming, per-turn average speed, token/cost/context stats, and model name — with configurable model labels.

## Features

- **Live tokens/sec** while the model generates (`⚡ 45t/s`), computed from a 4s rolling window of `text_delta` / `thinking_delta` / `toolcall_delta` events — a tool call's arguments are generated tokens too, so a `write` streaming its file body keeps the rate live, while a command that is merely executing shows `⏱` because nothing is being generated then, counting tokens rather than deltas: the provider's running output count when it streams an advancing one, otherwise an estimate from the delta's characters at a fitted 3.2 per token (configurable via `charsPerToken`), because local OpenAI-compatible servers often send several tokens per delta. The figure shown is the mean of the last 5 window samples (at most one per 0.5s); while a reply streams the footer repaints at 4Hz, so it visibly changes twice a second.
- **Per-turn average** once a reply finishes, shown as `⏱ 31t/s` and kept visible until the next turn replaces it — so a speed reading is always on screen, it also works when the provider doesn't stream deltas, and a stale reading is never mistaken for a live one. The live figure stops when generation stops, even though the rolling window is still full.
- **Running tool** shown as `⚙ write` (or `⚙ bash+2`) while a tool executes — that is when no deltas flow, so the footer says what is holding the stream instead of appearing to freeze.
- **Token / cost / context line**: input, output, cache read/write, cost, and live context usage during streaming, plus the current model (emoji label + thinking level).
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
  },
  "charsPerToken": 3.2
}
```

Keys are `provider/model` exactly as shown by pi (e.g. from `/model`). User labels override the built-in defaults for the same key and add new ones. Restart pi (or `/reload`) after editing.

`charsPerToken` (default `3.2`) is used only when the provider does not stream a running output count: the live rate is then estimated from the characters in each delta. Set it if the live figure is consistently wrong by a fixed factor for your tokenizer. The default was fitted against engine-reported output counts in pi's own session store - 2,987 assistant messages, 2,896,724 tokens, one local model - giving 3.29 chars/token for prose, 3.18 for thinking and 3.22 for tool arguments (R² 0.93, median per-message error 8.3%, total bias 0.0%); the ratio barely depends on content type. Four other local models fit between 2.9 and 3.4. The previous assumption of 4.0 under-counted that traffic by 20.6% overall.

## Checking the rate meter

`node test/meter-check.mjs` lifts the meter functions out of `extensions/index.ts` and drives them
with a controlled clock over the shapes a real engine produces - speculative bursts, coarse batching,
one huge chunk after a pause. It reports bias against a known true rate, and asserts that the cases
where no honest rate exists produce no figure at all.

## How It Works

- **Live TPS** uses a 4s rolling window of streaming token events, timed from the sample that sits just before the window so a silent gap is charged to the rate instead of dropped. It needs at least two samples spanning at least a second, so very short replies may not show it — and neither will a provider that delivered one huge chunk after going quiet, where no honest rate can be inferred.
- **Average TPS** = output tokens ÷ the generation span of the last finished assistant message (first streamed token to end of message), so prefill and first-token latency do not drag it down; for providers that stream no deltas it falls back to the whole request. It appears the moment a reply finishes and is replaced when the next turn produces a new reading.
- **Live context usage** adds a streamed-output estimate to the completed-message baseline, then returns to pi's reported context usage when the message finishes.
- Before the first reply of a session there is no speed reading yet, so the speed indicator is hidden.

## License

MIT
