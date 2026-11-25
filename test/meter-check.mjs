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

// ---- the token estimator: measured against ground truth, both provider shapes ----
// Everything above has exact token counts by construction, so it tests the meter. In the real world a
// provider that reports usage only in its final chunk (any OpenAI-compatible local server: the usage
// chunk is the last one and carries "choices":[]) forces the live figure to estimate the token count.
// Two estimators exist for that, and which one is right depends on how the provider chunks:
//
//   deltas - one chunk per token (local llama.cpp-class servers). Ratio holds across content types.
//   chars  - fixed-size text flushes (hosted providers). Delta counts then say nothing about size.
//
// The rows below drive the same lifted meter with each shape and a known true rate, showing the
// estimator auto-selection converging on the right one. The control rows pin the estimator and switch
// calibration off, which is what the shipped code did: one pooled chars/token, forever.
const estConsts = [...src.matchAll(
  /^const (?:CHARS_PER_TOKEN_DEFAULT|DEFAULT_TOKENS_PER_DELTA|CALIBRATION_[A-Z_]+|CPT_[A-Z]+|TPD_[A-Z]+|ERR_BLEND|ERR_HYSTERESIS) = [0-9.]+;/gm,
)].map((m) => m[0]).join("\n");
if (!estConsts.includes("DEFAULT_TOKENS_PER_DELTA")) {
  console.error("could not find the estimator constants - did the estimator change shape?");
  process.exit(1);
}
const estFns = ["calibrateRatio", "scoreEstimator", "blendError"]
  .map((n) => grab(new RegExp(`function ${n}\\([^)]*\\)\\s*:\\s*number \\{[\\s\\S]*?\\n\\}`), n))
  .join("\n")
  .replace(/: number \| null/g, "").replace(/: number/g, "");
const E = new Function(`${estConsts}\n${estFns}\nreturn { calibrateRatio, scoreEstimator, blendError,\n  CALIBRATION_MIN_TOKENS, CALIBRATION_MIN_CHARS, CALIBRATION_MIN_DELTAS, CPT_MIN, CPT_MAX, TPD_MIN, TPD_MAX, ERR_BLEND, ERR_HYSTERESIS,\n  CHARS_PER_TOKEN_DEFAULT, DEFAULT_TOKENS_PER_DELTA };`)();

// One session: turns of [true chars/token, real tokens], decoded at TRUE_TPS. `shape` decides how the
// provider cuts that text into deltas. Returns one row per turn with the figure the footer would show.
function runSession(label, turns, shape, opts = {}) {
  let cpt = E.CHARS_PER_TOKEN_DEFAULT;
  let tpd = E.DEFAULT_TOKENS_PER_DELTA;
  let eC = null, eD = null;
  // Start where the extension starts: the delta estimator, which is also what upstream did by
  // counting one token per delta. The auto selector then has to earn the switch.
  let useD = true;
  if (opts.estimator === "chars") useD = false;
  if (opts.estimator === "deltas") useD = true;
  console.log(`\n${label}`);
  for (const [cptTrue, tokens] of turns) {
    streamSamples.length = 0;                       // message_start clears the window
    let msgChars = 0, msgDeltas = 0, estC = 0, estD = 0, carry = 0;
    const totalChars = Math.round(tokens * cptTrue);
    const cuts = shape === "perToken"
      ? Array.from({ length: tokens }, (_, i) => Math.round(totalChars * (i + 1) / tokens) - Math.round(totalChars * i / tokens))
      : Array.from({ length: Math.ceil(totalChars / 24) }, (_, i) => Math.min(24, totalChars - i * 24));
    let t = now, sent = 0, figure = null;
    const start = t;
    for (const n of cuts) {
      sent += n;
      t += (n / cptTrue) / TRUE_TPS * 1000;         // time the engine needed for n characters
      now = Math.round(t);
      msgChars += n; msgDeltas++;
      estC += n / cpt; estD += tpd;
      carry += useD ? tpd : n / cpt;
      const tok = Math.floor(carry); carry -= tok;
      globalThis.api.recordStreamTokens(tok);
      const r = globalThis.api.computeStreamTps();
      if (r !== null && now - start > 8000) figure = r;
    }
    const output = tokens;
    if (!opts.noCalibrate && output >= E.CALIBRATION_MIN_TOKENS
      && (msgChars >= E.CALIBRATION_MIN_CHARS || msgDeltas >= E.CALIBRATION_MIN_DELTAS)) {
      cpt = E.calibrateRatio(cpt, msgChars / output, E.CPT_MIN, E.CPT_MAX);
      if (msgDeltas > 0) tpd = E.calibrateRatio(tpd, output / msgDeltas, E.TPD_MIN, E.TPD_MAX);
      eC = E.blendError(eC, E.scoreEstimator(estC, output));
      eD = E.blendError(eD, E.scoreEstimator(estD, output));
      if (!opts.estimator) {
        const d = eD ?? Infinity, c = eC ?? Infinity;
        useD = useD ? d <= c * E.ERR_HYSTERESIS : d * E.ERR_HYSTERESIS <= c;
      }
    }
    const err = figure === null ? null : ((figure / TRUE_TPS - 1) * 100).toFixed(1).padStart(6);
    console.log(`  ${cptTrue.toFixed(2).padStart(4)} c/tok, ${String(tokens).padStart(4)} tok, ${String(msgDeltas).padStart(4)} deltas` +
      ` -> reads ${figure === null ? "  no figure" : figure.toFixed(1).padStart(9)} t/s` +
      `  error ${err ?? "    n/a"}%   est=${useD ? "deltas" : "chars "}` +
      `  tpd ${tpd.toFixed(2)} cpt ${cpt.toFixed(2)}` +
      `  errD ${eD === null ? "  -" : (eD * 100).toFixed(0) + "%"} errC ${eC === null ? "  -" : (eC * 100).toFixed(0) + "%"}`);
  }
}

const TRUE_TPS = 50;
// A session like a real coding conversation: prose, tables, code, and a pathological run of digits
// (1.1 chars/token) that no pooled chars/token constant can survive.
const MIXED = [[4.3, 900], [2.8, 1500], [1.1, 420], [4.4, 700], [4.2, 1200], [2.6, 2500], [4.1, 1000]];

runSession("local server, one chunk per token - control: chars estimator, no calibration (shipped behaviour):",
  MIXED, "perToken", { estimator: "chars", noCalibrate: true });
runSession("same session, estimator auto-selected and both ratios calibrated each turn:",
  MIXED, "perToken");
runSession("hosted provider, 24-char flushes - control: deltas estimator, no calibration:",
  MIXED, "flush24", { estimator: "deltas", noCalibrate: true });
runSession("same session through the flush provider, estimator auto-selected:",
  MIXED, "flush24");
console.log("\nThe point of the last two pairs: each provider shape has one estimator that is right and");
console.log("one that is wrong by tens of percent, and neither shape is known in advance. Scoring both");
console.log("against the real count at every message_end picks the right one within a turn or two.");
