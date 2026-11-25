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

const CHARS_PER_TOKEN_DEFAULT = 3.2;
type FooterConfig = { labels: Record<string, string>; charsPerToken: number };

function loadConfig(): FooterConfig {
  const fallback = { labels: {} as Record<string, string>, charsPerToken: CHARS_PER_TOKEN_DEFAULT };
  try {
    const raw = readFileSync(join(getAgentDir(), CONFIG_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    const obj = parsed as Record<string, unknown>;
    const labels = obj.modelLabels && typeof obj.modelLabels === "object"
      ? obj.modelLabels as Record<string, string>
      : fallback.labels;
    // Only used when the provider does not stream a running output count. Fitted from real
    // traffic, see CHARS_PER_TOKEN_DEFAULT.
    const charsPerToken = typeof obj.charsPerToken === "number" && obj.charsPerToken > 1 && obj.charsPerToken < 12
      ? obj.charsPerToken
      : CHARS_PER_TOKEN_DEFAULT;
    return { labels, charsPerToken };
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
        let tokens = 0;
        if (typeof reported === "number") {
          if (lastReportedOutput >= 0 && reported > lastReportedOutput) tokens = reported - lastReportedOutput;
          lastReportedOutput = reported;
          if (reported > liveStreamedTokens) liveStreamedTokens = reported;
        }
        if (tokens <= 0) {
          // No advancing usage report: estimate from the characters in this delta. Counting one
          // per delta under-reads badly on providers that batch several tokens per delta, which
          // is typical of local OpenAI-compatible servers. See CHARS_PER_TOKEN_DEFAULT for how
          // the divisor was measured; the content type does not change it appreciably, so one
          // divisor covers prose, thinking and tool arguments alike.
          tokens = Math.max(1, Math.round((ev.delta ?? "").length / CONFIG.charsPerToken));
          liveStreamedTokens += tokens;
        }
        recordStreamTokens(tokens);
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
