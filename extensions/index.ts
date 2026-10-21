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
 *   - live tokens/sec while streaming (2s rolling window),
 *   - average tokens/sec for the last finished turn, kept visible until the next
 *     turn replaces it (also covers providers that do not stream deltas),
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

function loadUserLabels(): Record<string, string> {
  try {
    const raw = readFileSync(join(getAgentDir(), CONFIG_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "modelLabels" in parsed) {
      const labels = (parsed as { modelLabels: unknown }).modelLabels;
      if (labels && typeof labels === "object") return labels as Record<string, string>;
    }
  } catch {
    // missing or unreadable config is fine; defaults apply
  }
  return {};
}

const MODEL_LABELS: Record<string, string> = { ...DEFAULT_MODEL_LABELS, ...loadUserLabels() };

const ROLLING_WINDOW_MS = 2000;
const tokenTimestamps: number[] = [];
let messageStartTime = 0;
let lastAvgTps: number | null = null;

// Live context usage: pi's ctx.getContextUsage() only counts completed
// messages, so it does not move while the assistant is streaming. Track the
// pre-turn baseline and add streamed tokens for the in-flight message.
let liveBaselineTokens: number | null = null;
let liveContextWindow = 0;
let liveStreamedTokens = 0;

function recordStreamToken(): void {
  const now = Date.now();
  tokenTimestamps.push(now);
  const cutoff = now - ROLLING_WINDOW_MS;
  while (tokenTimestamps.length > 0 && tokenTimestamps[0]! < cutoff) {
    tokenTimestamps.shift();
  }
}

function computeStreamTps(): number | null {
  const cutoff = Date.now() - ROLLING_WINDOW_MS;
  while (tokenTimestamps.length > 0 && tokenTimestamps[0]! < cutoff) {
    tokenTimestamps.shift();
  }
  if (tokenTimestamps.length < 2) return null;
  const elapsed = tokenTimestamps[tokenTimestamps.length - 1]! - tokenTimestamps[0]!;
  if (elapsed <= 0) return null;
  return tokenTimestamps.length / (elapsed / 1000);
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
        tokenTimestamps.length = 0;
        messageStartTime = Date.now();
        const usage = ctx.getContextUsage();
        liveContextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        liveBaselineTokens = usage?.tokens ?? null;
        liveStreamedTokens = 0;
      }
    });

    pi.on("message_update", (event) => {
      const ev = event.assistantMessageEvent;
      if (ev?.type === "text_delta" || ev?.type === "thinking_delta") {
        recordStreamToken();
        liveStreamedTokens += 1;
        // Prefer the provider's exact running output count when it is streamed
        // live (e.g. Anthropic); otherwise the delta count is the estimate.
        const out = ev.partial?.usage?.output;
        if (typeof out === "number" && out > liveStreamedTokens) {
          liveStreamedTokens = out;
        }
      }
    });

    pi.on("message_end", (event) => {
      if (event.message?.role !== "assistant") return;
      const usage = (event.message as AssistantMessage).usage;
      const output = usage?.output ?? 0;
      const elapsed = Date.now() - messageStartTime;
      if (output > 0 && elapsed > 400) {
        lastAvgTps = output / (elapsed / 1000);
      }
      liveBaselineTokens = null;
      liveStreamedTokens = 0;
    });

    ctx.ui.setFooter((_tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => _tui.requestRender());

      return {
        dispose: unsubscribe,
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
          const live = computeStreamTps();
          const tps = live ?? lastAvgTps;
          if (tps !== null) {
            leftParts.unshift(`⚡ ${tps.toFixed(0)}t/s`);
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
