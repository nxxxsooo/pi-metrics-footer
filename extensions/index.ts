import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * pi-metrics-footer
 *
 * Replaces the pi TUI footer with a metrics line:
 *   - live tokens/sec while streaming (2s rolling window), shown as `⚡ 45t/s`,
 *   - the last finished turn's average, kept visible until the next turn replaces it
 *     (also covers providers that do not stream deltas), shown as `⏱ 31t/s` so it is never
 *     mistaken for a live rate,
 *   - the tool currently executing, shown as `⚙ write`, which is what is holding the stream,
 *   - input/output/cache/cost tokens, context usage, and the current model.
 *
 * Model display names come from a default map and can be overridden per user via
 * `<agent-dir>/pi-metrics-footer.json`:
 *   { "modelLabels": { "anthropic/claude-sonnet-5": "🎭 Sonnet 5" } }
 */

const CONFIG_FILE = "pi-metrics-footer.json";

/** Default labels for well-known public model IDs. Override via config. */
const DEFAULT_MODEL_LABELS: Record<string, string> = {
  // Anthropic
  "anthropic/claude-opus-4": "🦑 Opus 4",
  "anthropic/claude-opus-4-1": "🦑 Opus 4.1",
  "anthropic/claude-sonnet-4": "🎭 Sonnet 4",
  "anthropic/claude-sonnet-4-5": "🎭 Sonnet 4.5",
  "anthropic/claude-haiku-4-5": "🎋 Haiku 4.5",
  // OpenAI
  "openai/gpt-5": "🧠 GPT-5",
  "openai/gpt-5-mini": "⚡ GPT-5 Mini",
  "openai/gpt-5-nano": "⚡ GPT-5 Nano",
  // Google
  "google/gemini-2.5-pro": "💎 Gemini Pro",
  "google/gemini-2.5-flash": "💎 Gemini Flash",
  // Others
  "deepseek/deepseek-chat": "🐋 DeepSeek",
  "deepseek/deepseek-reasoner": "🐋 DeepSeek R",
  "qwen/qwen3-coder": "👾 Qwen Coder",
};

// Seed value only, and only for the character estimator. The ratio it stands for swings with what
// is being written: measured on one local engine, 1.16 chars/token for a list of numbers, 2.6-2.8
// for code and tables, 4.1-4.4 for prose. No pooled constant covers a 4x spread, which is why a
// shipped value of 3.2 read 66-73 t/s on turns the engine itself reported at 50.2-51.1.
const CHARS_PER_TOKEN_DEFAULT = 3.2;
// Seed for the delta estimator: one token per delta event, which is how local llama.cpp-class
// servers actually stream (measured: 421 completion tokens in 371 content chunks, so ~1.13).
const DEFAULT_TOKENS_PER_DELTA = 1.0;
// Calibration guard rails. One turn is a noisy sample, so each turn nudges a ratio rather than
// setting it, and a ratio outside these bounds is not a token ratio at all.
const CALIBRATION_BLEND = 0.3;
const CALIBRATION_MIN_TOKENS = 24;   // shorter than this, a turn is too noisy to learn from
const CALIBRATION_MIN_CHARS = 120;
const CALIBRATION_MIN_DELTAS = 8;
const CPT_MIN = 0.8;
const CPT_MAX = 12;
const TPD_MIN = 0.05;
const TPD_MAX = 20;
// How fast the running error of each estimator forgets. The estimator with the smaller recent error
// drives the live figure, so this also controls how quickly a session switches over.
const ERR_BLEND = 0.4;
// Switch only on a clear win. Two estimators within this factor of each other are equally bad, and
// alternating between two bad estimators makes the figure jump around more than either alone.
const ERR_HYSTERESIS = 1.25;

type RateEstimator = "auto" | "deltas" | "chars";
type FooterConfig = {
  labels: Record<string, string>;
  charsPerToken: number;
  // True when charsPerToken came from the config file. A pinned value is respected and never
  // recalibrated: an explicit number in the config means "use exactly this", and it also pins the
  // estimator to characters, because that is the only knob that number turns.
  charsPerTokenPinned: boolean;
  // Which token estimator drives the live rate. "auto" scores both against the provider's real
  // counts every turn and keeps the better one; see the estimator block below.
  rateEstimator: RateEstimator;
};

function loadConfig(): FooterConfig {
  const fallback = {
    labels: {} as Record<string, string>,
    charsPerToken: CHARS_PER_TOKEN_DEFAULT,
    charsPerTokenPinned: false,
    rateEstimator: "auto" as RateEstimator,
  };
  try {
    const raw = readFileSync(join(getAgentDir(), CONFIG_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    const obj = parsed as Record<string, unknown>;
    const labels = obj.modelLabels && typeof obj.modelLabels === "object"
      ? obj.modelLabels as Record<string, string>
      : fallback.labels;
    // Only used when the provider does not stream a running output count. If it is present in the
    // config it pins the divisor and calibration is switched off for the session.
    const pinned = typeof obj.charsPerToken === "number" && obj.charsPerToken > 1 && obj.charsPerToken < 12;
    const charsPerToken = pinned ? (obj.charsPerToken as number) : CHARS_PER_TOKEN_DEFAULT;
    const rateEstimator: RateEstimator = obj.rateEstimator === "deltas" || obj.rateEstimator === "chars"
      ? obj.rateEstimator
      : "auto";
    return { labels, charsPerToken, charsPerTokenPinned: pinned, rateEstimator };
  } catch {
    // missing or unreadable config is fine; defaults apply
    return fallback;
  }
}

const CONFIG = loadConfig();
const MODEL_LABELS: Record<string, string> = { ...DEFAULT_MODEL_LABELS, ...CONFIG.labels };

const ROLLING_WINDOW_MS = 4000;
// A rate figure needs at least this much elapsed history, or none of it is trustworthy: with
// two samples a few milliseconds apart, the rate is whatever noise the provider's batching
// made. And a span longer than MAX means the provider went quiet and whatever arrived just now
// says nothing about the current speed, so no figure is shown.
const MIN_RATE_ELAPSED_MS = 1000;
const MAX_RATE_ELAPSED_MS = 10000;
// Characters per token, for the case where the provider gives no running output count and the
// rate has to be estimated from delta text. Fitted against the engine's own output counts in
// this machine's session store: 2,987 assistant messages / 2,896,724 tokens from one local
// model, least squares on (text chars, thinking chars, tool-argument chars, tool calls).
// Result 3.29 / 3.18 / 3.22 chars per token for those three categories - the ratio barely
// depends on content type - at R^2 0.934, median per-message error 8.3%, total bias 0.0%.
// Four other local models fit 2.9-3.4, so the default is a pooled value and `charsPerToken`
// in the config file overrides it. The previous assumption of 4.0 under-counted by 20.6%
// in total and by 20.1% median per message on the same data.
// [2026-11-23] That fit is sound as an average and misleading as a constant: it has a median
// per-message error of 8.3% and a 90th-percentile error of 23%, which is precisely the difference
// between a live figure that reads 50 and one that reads 66. Hence the per-turn calibration below.
// The displayed rate is the mean of the last few window figures. A figure is taken at most
// once per SMOOTH_INTERVAL_MS so those figures span time, not consecutive renders.
const SMOOTH_SAMPLES = 5;
const SMOOTH_INTERVAL_MS = 500;
const recentTps: number[] = [];
let lastFigureAt = 0;
// Windowed (time, tokens) samples. Counting one per delta is wrong for providers that
// stream several tokens per delta, so when the provider reports a running output count,
// the increase in that count is what gets recorded.
const streamSamples: { at: number; tokens: number }[] = [];
let messageStartTime = 0;
// True between message_start and message_end of an assistant message. The rolling window stays
// full for a few seconds after the last delta, and a figure taken from it afterwards reads as a
// live rate that has frozen, so the live branch is gated on this rather than on sample presence.
let streamingMessage = false;
// First delta of the current message, used to measure the per-turn average over the generation
// span instead of the whole request.
let firstDeltaAt = 0;
let lastAvgTps: number | null = null;

// Two token estimators run side by side, both calibrated against the provider's real output count at
// message_end, and the one that has been predicting better drives the live rate figure:
//
//   deltas - tokens per delta event. Right when the provider streams one chunk per token, which local
//            llama.cpp-class servers do, and it does not swing with content type.
//   chars  - tokens per character. Needed when a delta is a fixed-size text flush rather than a token,
//            which is how hosted providers typically stream; then delta counts say nothing about size.
//
// Both are accumulated every delta so each can be scored at message_end against the real count, which
// is what makes the choice evidence rather than a guess about who the provider is.
let msgChars = 0;
let msgDeltas = 0;
let estCharsTotal = 0;
let estDeltaTotal = 0;
// Fractional tokens not yet pushed into the rolling window, so a burst of small deltas does not all
// round to zero and then one big delta does not look like a spike.
let estCarry = 0;
let charsPerToken = CONFIG.charsPerToken;
let tokensPerDelta = DEFAULT_TOKENS_PER_DELTA;
// Recent relative error of each estimator on this session; null until the first turn long enough to score.
let errChars: number | null = null;
let errDeltas: number | null = null;
// True when the provider's own running output count drove the rate this message. Then there is
// nothing to estimate and nothing to calibrate. Note that a provider which reports usage only in a
// final chunk has NOT used its own counts for the rate, even though lastReportedOutput ends up set:
// that is the common local-server case and it is exactly the one that needs calibrating.
let usedReported = false;
let useDeltas = CONFIG.charsPerTokenPinned ? false : CONFIG.rateEstimator !== "chars";

// Blend `observed` into `current` by CALIBRATION_BLEND, clamped, ignoring a sample that is not a
// believable ratio at all.
function calibrateRatio(current: number, observed: number, min: number, max: number): number {
  if (!Number.isFinite(observed) || observed < min || observed > max) return current;
  const blended = current * (1 - CALIBRATION_BLEND) + observed * CALIBRATION_BLEND;
  return Math.min(max, Math.max(min, blended));
}

// Relative error of one estimator's running total against the provider's real count.
function scoreEstimator(estTotal: number, output: number): number {
  if (output <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(estTotal - output) / output;
}

// Exponential blend that does not get stuck at "no history yet".
function blendError(prev: number | null, observed: number): number {
  if (prev === null || !Number.isFinite(observed)) return observed;
  return prev * (1 - ERR_BLEND) + observed * ERR_BLEND;
}

// The rolling window only fills while deltas stream. During a tool call (writing a file,
// running a command) no deltas arrive, the window empties, and the footer silently falls
// back to the previous turn's average - which reads like a live rate that has frozen. Keep
// the number, but label it as what it is and show which tool is holding the stream.
const activeTools = new Map<string, string>();
let footerTui: { requestRender(): void } | null = null;
// While a reply is streaming, request a footer repaint at 4Hz so the speed figure - which is
// refreshed twice a second by SMOOTH_INTERVAL_MS - reaches the screen as soon as it changes,
// instead of waiting for pi's own render coalescing. Started at message_start and stopped at
// message_end: nothing else in the footer moves outside a turn, so no timer runs when idle.
const DISPLAY_TICK_MS = 250;
let displayTick: ReturnType<typeof setInterval> | null = null;
function startDisplayTick(): void {
  if (displayTick !== null) return;
  displayTick = setInterval(() => footerTui?.requestRender(), DISPLAY_TICK_MS);
}
function stopDisplayTick(): void {
  if (displayTick === null) return;
  clearInterval(displayTick);
  displayTick = null;
}

// Live context usage: pi's ctx.getContextUsage() only counts completed
// messages, so it does not move while the assistant is streaming. Track the
// pre-turn baseline and add streamed tokens for the in-flight message.
let liveBaselineTokens: number | null = null;
let liveContextWindow = 0;
let liveStreamedTokens = 0;
// The provider's last reported running output count for the in-flight message, or -1 when
// it has not reported one yet.
let lastReportedOutput = -1;

function recordStreamTokens(tokens: number): void {
  const now = Date.now();
  if (firstDeltaAt === 0) firstDeltaAt = now;
  streamSamples.push({ at: now, tokens });
  // Bound the list, but keep one sample beyond the window: computeStreamTps needs it as a time
  // anchor so that a silent gap is charged to the rate instead of disappearing with the samples.
  const oldest = now - ROLLING_WINDOW_MS - MAX_RATE_ELAPSED_MS;
  while (streamSamples.length > 2 && streamSamples[1]!.at < oldest) {
    streamSamples.shift();
  }
}

function computeStreamTps(): number | null {
  const now = Date.now();
  const cutoff = now - ROLLING_WINDOW_MS;
  // Index of the newest sample at or before the window start. Samples before it are dropped,
  // samples from it onward are kept: the anchor's timestamp, not the first sample inside the
  // window, defines where the elapsed time begins. Dividing by the spread of only the samples
  // inside the window is what made bursts look enormous - samples landing in the same
  // millisecond divided by zero (Infinity), and one large chunk after a pause read as over
  // 10000 t/s on a real engine.
  let anchor = 0;
  for (let i = 0; i < streamSamples.length; i++) {
    if (streamSamples[i]!.at <= cutoff) anchor = i;
    else break;
  }
  if (anchor > 0) streamSamples.splice(0, anchor);
  if (streamSamples.length < 2) return null;
  const elapsed = streamSamples[streamSamples.length - 1]!.at - streamSamples[0]!.at;
  if (elapsed < MIN_RATE_ELAPSED_MS || elapsed > MAX_RATE_ELAPSED_MS) return null;
  // The anchor's own tokens are excluded: they arrived at the instant the span begins, so they
  // belong to the interval before it. Including them hands the span a free chunk, and the error
  // scales with chunk size rather than with rate - measured with the token counts exact by
  // construction: +0.5% at 1 token/20ms, +7.7% at 16/320ms, +20% at 40/800ms, +50% at 100/2000ms.
  // Providers that batch deltas coarsely therefore read consistently high, which is what looked
  // like the token estimate running hot.
  const tokens = streamSamples.slice(1).reduce((sum, s) => sum + s.tokens, 0);
  return tokens / (elapsed / 1000);
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    pi.on("message_start", (event) => {
      if (event.message?.role === "assistant") {
        streamSamples.length = 0;
        recentTps.length = 0;
        lastFigureAt = 0;
        lastReportedOutput = -1;
        firstDeltaAt = 0;
        msgChars = 0;
        msgDeltas = 0;
        estCharsTotal = 0;
        estDeltaTotal = 0;
        estCarry = 0;
        usedReported = false;
        streamingMessage = true;
        startDisplayTick();
        messageStartTime = Date.now();
        const usage = ctx.getContextUsage();
        liveContextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        liveBaselineTokens = usage?.tokens ?? null;
        liveStreamedTokens = 0;
      }
    });

    pi.on("message_update", (event) => {
      const ev = event.assistantMessageEvent;
      // A tool call's arguments are generated tokens too: a `write` streams its whole file
      // body through toolcall_delta, which is the engine generating at full speed. A bash
      // command, by contrast, generates nothing while it runs, and the gap there is real.
      if (ev?.type === "text_delta" || ev?.type === "thinking_delta" || ev?.type === "toolcall_delta") {
        // Every delta advances the rate window, so the figure cannot stall while the model
        // is still writing. When the provider reports an advancing running output count
        // (e.g. Anthropic) that increase replaces the per-delta estimate; a provider that
        // reports usage only once, at the end, is ignored for the rate so it does not look
        // like one enormous burst, while still making the live context percentage exact.
        const reported = ev.partial?.usage?.output;
        const text = ev.delta ?? "";
        msgChars += text.length;
        let tokens = 0;
        if (typeof reported === "number") {
          if (lastReportedOutput >= 0 && reported > lastReportedOutput) {
            tokens = reported - lastReportedOutput;
            usedReported = true;
          }
          lastReportedOutput = reported;
          if (reported > liveStreamedTokens) liveStreamedTokens = reported;
        }
        // A chunk that carries only a usage report is not a delta: counting it as one would bias
        // tokens-per-delta on precisely the servers that end with such a chunk.
        if (text.length > 0) {
          msgDeltas++;
          estCharsTotal += text.length / charsPerToken;
          estDeltaTotal += tokensPerDelta;
        }
        if (tokens <= 0 && text.length > 0) {
          // No advancing usage count for this delta, so the token count has to be estimated. Both
          // estimators are accumulated so each can be scored at message_end; only the chosen one
          // feeds the rolling window, carrying the fraction so small deltas accumulate instead of
          // rounding away.
          estCarry += useDeltas ? tokensPerDelta : text.length / charsPerToken;
          tokens = Math.floor(estCarry);
          estCarry -= tokens;
          if (typeof reported !== "number") liveStreamedTokens += tokens;
        }
        if (tokens > 0 || text.length > 0) recordStreamTokens(tokens);
      }
    });

    pi.on("message_end", (event) => {
      if (event.message?.role !== "assistant") return;
      const usage = (event.message as AssistantMessage).usage;
      const output = usage?.output ?? 0;
      // Measure the average across the generation span, not the whole request: prefill and
      // first-token latency are not a speed anyone can act on, and on a cached 45k-token prompt
      // they drag a 48 t/s decode down to about 42. A provider that streams no deltas never
      // sets firstDeltaAt, so those turns keep the full span.
      const spanStart = firstDeltaAt > 0 ? firstDeltaAt : messageStartTime;
      const elapsed = Date.now() - spanStart;
      if (output > 0 && elapsed > 400) {
        lastAvgTps = output / (elapsed / 1000);
      }
      // Ground truth for the turn just finished. If the provider reported exact counts there is nothing
      // to learn. Otherwise recalibrate both ratios, score both estimators against the real count, and
      // hand the next turn to whichever has been closer. A pinned charsPerToken means the user chose the
      // character estimator, so it is left alone.
      if (!CONFIG.charsPerTokenPinned && !usedReported && output >= CALIBRATION_MIN_TOKENS
        && (msgChars >= CALIBRATION_MIN_CHARS || msgDeltas >= CALIBRATION_MIN_DELTAS)) {
        charsPerToken = calibrateRatio(charsPerToken, msgChars / output, CPT_MIN, CPT_MAX);
        if (msgDeltas > 0) {
          tokensPerDelta = calibrateRatio(tokensPerDelta, output / msgDeltas, TPD_MIN, TPD_MAX);
        }
        errChars = blendError(errChars, scoreEstimator(estCharsTotal, output));
        errDeltas = blendError(errDeltas, scoreEstimator(estDeltaTotal, output));
        if (CONFIG.rateEstimator === "auto") {
          const d = errDeltas ?? Number.POSITIVE_INFINITY;
          const c = errChars ?? Number.POSITIVE_INFINITY;
          useDeltas = useDeltas ? d <= c * ERR_HYSTERESIS : d * ERR_HYSTERESIS <= c;
        }
      }
      streamingMessage = false;
      stopDisplayTick();
      // Repaint now: without this the new ⏱ figure can wait for the next unrelated render
      // (observed: it only appeared once the user started typing).
      footerTui?.requestRender();
      liveBaselineTokens = null;
      liveStreamedTokens = 0;
    });

    // Tool execution is exactly when no deltas flow, so mark what is running and ask for
    // a repaint - otherwise the footer keeps the pixels it had when the tool started.
    pi.on("tool_execution_start", (event) => {
      activeTools.set(event.toolCallId, event.toolName);
      footerTui?.requestRender();
    });

    pi.on("tool_execution_end", (event) => {
      activeTools.delete(event.toolCallId);
      footerTui?.requestRender();
    });

    ctx.ui.setFooter((_tui, theme, footerData) => {
      footerTui = _tui;
      const unsubscribe = footerData.onBranchChange(() => _tui.requestRender());

      return {
        dispose: () => {
          stopDisplayTick();
          unsubscribe();
        },
        invalidate() {},
        render(width: number): string[] {
          let input = 0;
          let output = 0;
          let cacheRead = 0;
          let cacheWrite = 0;
          let cost = 0;

          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type !== "message" || entry.message.role !== "assistant") continue;
            const message = entry.message as AssistantMessage;
            input += message.usage.input;
            output += message.usage.output;
            cacheRead += message.usage.cacheRead;
            cacheWrite += message.usage.cacheWrite;
            cost += message.usage.cost.total;
          }

          const usage = ctx.getContextUsage();
          let context: string;
          if (liveBaselineTokens !== null && liveStreamedTokens > 0 && liveContextWindow > 0) {
            // In-flight estimate: completed context + tokens streamed so far.
            const pct = ((liveBaselineTokens + liveStreamedTokens) / liveContextWindow) * 100;
            context = `${pct.toFixed(1)}%/${formatTokens(liveContextWindow)}`;
          } else {
            context = usage?.percent == null
              ? `?/${formatTokens(usage?.contextWindow ?? ctx.model?.contextWindow ?? 0)}`
              : `${usage.percent.toFixed(1)}%/${formatTokens(usage.contextWindow)}`;
          }
          const leftParts = [`↑${formatTokens(input)}`, `↓${formatTokens(output)}`];
          // Gated on the message actually streaming: the window is still full for a few seconds
          // after the last delta, and a figure taken from it then is a stale reading wearing the
          // live glyph.
          const live = streamingMessage ? computeStreamTps() : null;
          if (live !== null) {
            const now = Date.now();
            if (recentTps.length === 0 || now - lastFigureAt >= SMOOTH_INTERVAL_MS) {
              recentTps.push(live);
              lastFigureAt = now;
              while (recentTps.length > SMOOTH_SAMPLES) recentTps.shift();
            }
            const mean = recentTps.reduce((sum, v) => sum + v, 0) / recentTps.length;
            leftParts.unshift(`⚡ ${mean.toFixed(0)}t/s`);
          } else if (lastAvgTps !== null) {
            // No deltas are flowing: this is the previous turn's average, not a live rate.
            leftParts.unshift(`⏱ ${lastAvgTps.toFixed(0)}t/s`);
          }
          if (activeTools.size > 0) {
            const names = [...activeTools.values()];
            const extra = names.length > 1 ? `+${names.length - 1}` : "";
            leftParts.unshift(`⚙ ${names[0]!}${extra}`);
          }
          if (cacheRead) leftParts.push(`R${formatTokens(cacheRead)}`);
          if (cacheWrite) leftParts.push(`W${formatTokens(cacheWrite)}`);
          if (cost) leftParts.push(`$${cost.toFixed(3)}`);
          leftParts.push(context);
          const left = theme.fg("dim", leftParts.join(" "));

          const model = ctx.model;
          const modelKey = model ? `${model.provider}/${model.id}` : "";
          const label = MODEL_LABELS[modelKey] ?? model?.name ?? model?.id ?? "no model";
          const thinking = model?.reasoning ? ` · ${ctx.thinkingLevel ?? "off"}` : "";
          const right = theme.fg("accent", `${label}${thinking}`);
          const padding = " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)));

          const branch = footerData.getGitBranch();
          const pwd = branch ? `${ctx.cwd} (${branch})` : ctx.cwd;
          return [
            truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
            truncateToWidth(left + padding + right, width, ""),
          ];
        },
      };
    });
  });
}
