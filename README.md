# pi-metrics-footer

Live model speed and usage metrics in the pi TUI footer: tokens/sec while streaming, per-turn average speed, token/cost/context stats, and model name — with configurable model labels.

## Features

- **Live tokens/sec** while the model generates (`⚡ 45t/s`), computed from a 4s rolling window of `text_delta` / `thinking_delta` / `toolcall_delta` events — a tool call's arguments are generated tokens too, so a `write` streaming its file body keeps the rate live, while a command that is merely executing shows `⏱` because nothing is being generated then, counting tokens rather than deltas: the provider's running output count when it streams an advancing one, otherwise an estimate auto-selected between tokens-per-delta and characters-per-token and recalibrated from the provider's real counts at every message end (see Configuration). The figure shown is the mean of the last 5 window samples (at most one per 0.5s); while a reply streams the footer repaints at 4Hz, so it visibly changes twice a second.
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
  "charsPerToken": 3.2,
  "rateEstimator": "auto"
}
```

Keys are `provider/model` exactly as shown by pi (e.g. from `/model`). User labels override the built-in defaults for the same key and add new ones. Restart pi (or `/reload`) after editing.

`charsPerToken` (default `3.2`) and `rateEstimator` (default `"auto"`) only matter when the provider does not stream an advancing output count for the in-flight message. There the token count has to be estimated, and there are two ways to do it: **deltas** - tokens per `*_delta` event - and **chars** - characters per token. Which one is right is a property of the provider's chunking, not of the model. A local llama.cpp-class server sends one chunk per token: measured on one, 421 completion tokens arrived as 371 content chunks, with the usage totals in a single final chunk carrying `"choices":[]`. There, delta counting is near-exact and indifferent to what is being written. A hosted provider flushes fixed-size text, where a delta count says nothing about size and only characters work.

`rateEstimator`: `"auto"` accumulates both estimators all turn and at each message end scores each against the provider's real output count, then hands the next turn to whichever has been closer - with hysteresis, so two estimators of similar quality do not alternate and make the figure jump. `"deltas"` or `"chars"` pins the choice. Both ratios are also re-measured from the provider's real count every turn (30% blend, clamped), so they track what this session is actually writing instead of an average over somebody else's.

Why a constant chars/token is not enough: measured on one engine, chars/token was **1.16 for a list of numbers**, 2.6-2.8 for code and tables, 4.1-4.4 for prose. The pooled 3.2 - fitted against engine-reported counts for 2,987 assistant messages / 2,896,724 tokens, R² 0.93, total bias 0.0% - is a correct average and a wrong instantaneous value: driven through those content types it reads +34%, +37% and -65% on individual turns, which is exactly what a live figure of 66 against an engine-reported 50 looks like. Putting `charsPerToken` in the config pins the estimator to characters and stops calibration, so set it if you want a fixed number you trust or the pre-0.1.5 behaviour.

## Checking the rate meter

`node test/meter-check.mjs` lifts the meter functions out of `extensions/index.ts` and drives them
with a controlled clock over the shapes a real engine produces - speculative bursts, coarse batching,
one huge chunk after a pause. It reports bias against a known true rate, and asserts that the cases
where no honest rate exists produce no figure at all. The second half of its output drives the token
estimators over a session whose content mix swings from digits to prose, once with each estimator
pinned and once auto-selected.

`node test/extension-check.mjs` goes further: it loads the real `extensions/index.ts` (Node strips the
types), registers it against a stub pi, and feeds it turns shaped like a local server (one chunk per
token, usage in a final chunk only) and like a hosted provider (24-char flushes, advancing usage).
The speed figure is read back out of the actual footer render, so event wiring, glyph choice and
estimator selection are all covered.

## How It Works

- **Live TPS** uses a 4s rolling window of streaming token events, timed from the sample that sits just before the window so a silent gap is charged to the rate instead of dropped. It needs at least two samples spanning at least a second, so very short replies may not show it — and neither will a provider that delivered one huge chunk after going quiet, where no honest rate can be inferred.
- **Average TPS** = output tokens ÷ the generation span of the last finished assistant message (first streamed token to end of message), so prefill and first-token latency do not drag it down; for providers that stream no deltas it falls back to the whole request. It appears the moment a reply finishes and is replaced when the next turn produces a new reading.
- **Live context usage** adds a streamed-output estimate to the completed-message baseline, then returns to pi's reported context usage when the message finishes.
- Before the first reply of a session there is no speed reading yet, so the speed indicator is hidden.

## License

MIT
