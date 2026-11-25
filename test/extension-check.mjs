#!/usr/bin/env node
// Integration check: loads the real extension and drives it through fake turns.
//
// meter-check.mjs lifts the meter functions out and tests them in isolation. This one is end to end:
// the actual extensions/index.ts is transpiled by Node's own type stripping, registered against a
// stub pi, and fed message_start / message_update / message_end events shaped the way two different
// provider classes deliver them. What the footer would have painted is read back out of the real
// render() output, so a regression in event wiring, glyph choice or estimator selection shows up
// here rather than on someone's status line.
//
//   node test/extension-check.mjs [path/to/extensions/index.ts]
//
// Two provider shapes matter and they disagree about everything:
//   local OpenAI-compatible server - one chunk per token, usage only in the final chunk. This is the
//     case that made the live figure read 66 while the engine said 50.
//   hosted provider - fixed-size text flushes, usage advancing on every chunk. There the provider's
//     own counts are available and the estimate must not be used at all.

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const src = (process.argv[2] ?? new URL("../extensions/index.ts", import.meta.url)).toString().replace("file://", "");
let code = readFileSync(src, "utf8")
  .replace(/^import type .*$/gm, "")
  .replace('import { getAgentDir } from "@earendil-works/pi-coding-agent";',
    'const getAgentDir = () => "/tmp/pi-metrics-footer-check-no-config";')
  .replace('import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";',
    "const truncateToWidth = (s) => s;\nconst visibleWidth = (s) => s.length;");
if (code.includes("@earendil-works")) {
  console.error("an @earendil-works import was left unstubbed - the import shape changed");
  process.exit(1);
}
const tmpTs = join(tmpdir(), "pi-metrics-footer-under-test.ts");
writeFileSync(tmpTs, code);

// A controllable clock: the extension reads Date.now() everywhere, so the whole session runs in
// simulated time and a "turn" costs microseconds.
let now = 1000000;
Date.now = () => now;

const handlers = {};
const pi = { on: (name, fn) => { (handlers[name] ??= []).push(fn); } };
let footerComponent = null;
let renders = 0;
const ctx = {
  mode: "tui",
  cwd: "/tmp",
  thinkingLevel: "off",
  model: { provider: "strata", id: "q3", name: "Qwen3-test", reasoning: false },
  getContextUsage: () => ({ contextWindow: 262144, tokens: 100000 }),
  sessionManager: { getEntries: () => [] },
  ui: { setFooter: (factory) => { footerFactory = factory; } },
};
let footerFactory = null;
const mod = await import(pathToFileURL(tmpTs).href);
mod.default(pi);
for (const fn of handlers.session_start ?? []) fn({}, ctx);
if (!footerFactory) { console.error("session_start did not register a footer"); process.exit(1); }
footerComponent = footerFactory(
  { requestRender: () => { renders++; } },
  { fg: (_c, s) => s },
  { onBranchChange: () => () => {}, getGitBranch: () => null },
);

// What the footer is actually showing: the speed glyph and its number.
function shown() {
  const line = footerComponent.render(140).join(" ");
  const m = line.match(/[⚡⏱]\s*(\d+(?:\.\d+)?)t\/s/);
  if (!m) return { glyph: "-", tps: null };
  return { glyph: line.includes("⚡") ? "⚡" : "⏱", tps: Number(m[1]) };
}

const emit = (name, event) => { for (const fn of handlers[name] ?? []) fn(event, ctx); };

// One turn of `tokens` real tokens decoded at `trueTps`, cut into deltas by the provider shape.
// `usage` says when the provider reports its running count: "end" (local server: a final chunk with
// the totals and no text) or "every" (hosted providers). Renders are pulled at 4 Hz like the real
// display tick, so the smoothing sees the same timeline the user sees.
async function turn({ label, tokens, cpt, chunkChars, usage, trueTps }) {
  emit("message_start", { message: { role: "assistant" } });
  const totalChars = Math.round(tokens * cpt);
  const cuts = chunkChars === null
    ? Array.from({ length: tokens }, (_, i) => Math.round(totalChars * (i + 1) / tokens) - Math.round(totalChars * i / tokens))
    : Array.from({ length: Math.ceil(totalChars / chunkChars) }, (_, i) => Math.min(chunkChars, totalChars - i * chunkChars));
  let nextRender = now + 250;
  let live = null;
  for (let i = 0; i < cuts.length; i++) {
    now += Math.round((cuts[i] / cpt) / trueTps * 1000);
    const partial = usage === "every" ? { usage: { output: Math.round(totalChars * (i + 1) / cuts.length / cpt) } } : {};
    emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "x".repeat(cuts[i]), partial } });
    if (now >= nextRender) { const s = shown(); if (s.glyph === "⚡") live = s.tps; nextRender = now + 250; }
  }
  if (usage === "end") {
    // the local server's last chunk: totals, no text
    emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "", partial: { usage: { output: tokens } } } });
  }
  now += 50;
  emit("message_end", { message: { role: "assistant", usage: { input: 100, output: tokens, cacheRead: 0, cacheWrite: 0, cost: 0 } } });
  const after = shown();
  const err = live === null ? "   n/a" : ((live / trueTps - 1) * 100).toFixed(1).padStart(5);
  const errA = after.tps === null ? "   n/a" : ((after.tps / trueTps - 1) * 100).toFixed(1).padStart(5);
  console.log(`  ${label.padEnd(42)} live ${live === null ? "     n/a" : live.toFixed(1).padStart(7)} t/s (${err}%)   after ${after.glyph} ${after.tps === null ? "   n/a" : after.tps.toFixed(1).padStart(6)} t/s (${errA}%)`);
  return live;
}

const T = 50;
console.log("local OpenAI-compatible server: one chunk per token, usage in the final chunk only.");
console.log("content mix swings chars/token from digits to prose; true rate 50 t/s throughout:");
for (const [cpt, tokens] of [[4.3, 900], [2.8, 1500], [1.1, 420], [4.4, 700], [1.2, 600], [4.2, 1200]]) {
  await turn({ label: `  ${cpt.toFixed(1)} chars/token, ${tokens} tokens`, tokens, cpt, chunkChars: null, usage: "end", trueTps: T });
}

console.log("\nhosted provider: 24-char flushes, usage advancing on every chunk (exact counts available):");
for (const [cpt, tokens] of [[4.3, 900], [1.1, 420], [2.8, 1500]]) {
  await turn({ label: `  ${cpt.toFixed(1)} chars/token, ${tokens} tokens`, tokens, cpt, chunkChars: 24, usage: "every", trueTps: T });
}

console.log("\ntool call: arguments stream as toolcall_delta (generating), then the tool runs (silent):");
emit("message_start", { message: { role: "assistant" } });
let liveWrite2 = null;
// 2000 real tokens of file body at 50 t/s = 40 s of writing, one delta per token like the local
// server sends, then the tool itself runs silently.
for (let i = 0; i < 2000; i++) {
  now += 20;
  emit("message_update", { assistantMessageEvent: { type: "toolcall_delta", delta: "word ", partial: {} } });
  if (i % 50 === 0) { const s2 = shown(); if (s2.glyph === "⚡") liveWrite2 = s2.tps; }
}
console.log(`  during the write: ⚡ ${liveWrite2} t/s (true 50)`);
emit("message_end", { message: { role: "assistant", usage: { input: 10, output: 2000, cacheRead: 0, cacheWrite: 0, cost: 0 } } });
emit("tool_execution_start", { toolCallId: "t1", toolName: "write" });
now += 60000;
const idle = shown();
console.log(`  after 60 s of the tool running with no deltas: ${idle.glyph} ${idle.tps} t/s   (must be ⏱, not ⚡, and the tool name must appear)`);
const line = footerComponent.render(140).join(" ");
console.log(`  footer line: ${line.slice(0, 110)}`);
