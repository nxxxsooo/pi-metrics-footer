#!/usr/bin/env node
// Rate-meter check for pi-metrics-footer.
//
// Lifts recordStreamTokens() and computeStreamTps() out of extensions/index.ts and drives them
// with a controlled clock, so the test cannot drift from the code it claims to test. The feeds
// are the shapes a local engine actually produces: speculative decoding delivers tokens in
// bursts, and tool-call arguments arrive as one large chunk.
//
//   node meter-check.mjs [path/to/extensions/index.ts]
//
// Two things are being checked. Bias: the mean figure against a known true rate - a meter that
// is correct reads the same number whatever the chunk size. Pathologies: the last three feeds
// must produce NO figure at all, because no honest rate can be inferred from them; the old code
// produced Infinity.

import { readFileSync } from "node:fs";

// resolved against this file, so the check runs from any working directory
const src = readFileSync(process.argv[2] ?? new URL("../extensions/index.ts", import.meta.url), "utf8");

const strip = (s) =>
  s.replace(/\]!/g, "]").replace("tokens: number", "tokens").replace(": void", "").replace(": number | null", "");

const grab = (re, what) => {
  const m = src.match(re);
  if (!m) {
    console.error(`could not find ${what} in the source - did the meter change shape?`);
    process.exit(1);
  }
  return m[0];
};

const consts = grab(/const ROLLING_WINDOW_MS = \d+;[\s\S]*?const MAX_RATE_ELAPSED_MS = \d+;/, "the window constants");
const record = strip(grab(/function recordStreamTokens\(tokens: number\): void \{[\s\S]*?\n\}/, "recordStreamTokens"));
const compute = strip(grab(/function computeStreamTps\(\): number \| null \{[\s\S]*?\n\}/, "computeStreamTps"));

let now = 0;
const streamSamples = [];
Date.now = () => now;
// firstDeltaAt is module state in the extension; give the lifted code its own copy
new Function("streamSamples", `var firstDeltaAt = 0;\n${consts}\n${record}\n${compute}\nglobalThis.api = { recordStreamTokens, computeStreamTps };`)(streamSamples);

function run(label, feed, trueTps) {
  streamSamples.length = 0;
  const shown = [];
  for (const [t, tokens] of feed) {
    now = t;
    globalThis.api.recordStreamTokens(tokens);
    const r = globalThis.api.computeStreamTps();
    // for the bias rows measure the settled region only, so window filling does not count;
    // the pathology feeds are short and are read in full
    if (r !== null && t > (trueTps ? 15000 : -1)) shown.push(r);
  }
  if (!shown.length) {
    console.log(`${label.padEnd(46)} ${"no figure".padStart(11)}   (falls back to the labelled ⏱)`);
    return;
  }
  const mean = shown.reduce((a, b) => a + b, 0) / shown.length;
  const bias = trueTps ? `  bias ${((mean / trueTps - 1) * 100).toFixed(1).padStart(6)}%` : "";
  console.log(`${label.padEnd(46)} mean ${mean.toFixed(1).padStart(6)} t/s${bias}`);
}

console.log(consts.split("\n").filter((l) => l.trim().startsWith("const")).map((l) => "  " + l.trim()).join("\n"));
console.log("\nbias - token counts exact by construction, true rate 50 t/s in every row:");
for (const [tokens, gap] of [[1, 20], [4, 80], [16, 320], [40, 800], [100, 2000]]) {
  const feed = Array.from({ length: Math.floor(40000 / gap) }, (_, i) => [i * gap, tokens]);
  run(`  50 t/s delivered as ${String(tokens).padStart(3)} tokens / ${String(gap).padStart(4)} ms`, feed, 50);
}

console.log("\nsame rate, uneven arrival (speculative decoding accepts 0-4 draft tokens per step):");
const jitter = [];
let t = 0, seed = 7;
for (let i = 0; i < 800; i++) {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  const tokens = 1 + (seed % 5);
  jitter.push([t, tokens]);
  t += 60 + (seed % 90);
}
run("  1-5 tokens per 60-150 ms step", jitter, jitter.reduce((a, x) => a + x[1], 0) / (t / 1000));

console.log("\nbursts and gaps - what the old spread-based denominator turned into Infinity:");
run("  300-token tool-args burst then 50 t/s", [
  [0, 1], [500, 1], [3000, 300], ...Array.from({ length: 800 }, (_, i) => [3100 + i * 20, 1]),
], null);
run("  600-token chunk after a 3.9 s gap", [[1000, 4], [1100, 3], [5000, 600], [5100, 1]], null);
run("  600-token chunk after a 12 s gap", [[1000, 4], [1100, 3], [13000, 600], [13100, 1]], null);
run("  all samples in the same millisecond", [[1000, 300], [1000, 300], [1000, 300]], null);
run("  short reply: 40 tokens over 0.8 s", Array.from({ length: 40 }, (_, i) => [i * 20, 1]), null);
