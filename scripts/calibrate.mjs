// Calibrates CHOOSE_LLM_TEMPERATURE for the "llm" backend (single mode).
// Usage: CHOOSE_LLM_MODEL=... [CHOOSE_LLM_BASE_URL=...] node scripts/calibrate.mjs calib.jsonl
// Each line: {"context": ..., "question": "...", "options": {"name": "description"}, "answer": "name"}
import fs from "node:fs";
import assert from "node:assert";
import { massFor, scale } from "../dist/llm.js";

const file = process.argv[2];
if (!file) { console.error("Usage: node scripts/calibrate.mjs calib.jsonl"); process.exit(1); }
if (!process.env.CHOOSE_LLM_MODEL) { console.error("CHOOSE_LLM_MODEL is not set"); process.exit(1); }

const rows = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l, i) => {
  const r = JSON.parse(l);
  assert.ok(r.options && r.answer in r.options, `line ${i + 1}: "answer" must be one of the options`);
  return r;
});
assert.ok(rows.length >= 2, "need at least 2 examples (50-200 recommended)");

// One model call per example. Everything after this is arithmetic on the raw mass.
const data = [];
for (const r of rows) {
  const ctx = typeof r.context === "string" ? r.context : JSON.stringify(r.context, null, 2);
  const mass = await massFor(ctx, { type: "choice", instructions: r.question, criteria: r.options });
  const c = Math.min(1, Object.values(mass).reduce((s, v) => s + v, 0)); // coverage, same as the tool
  data.push({ mass, answer: r.answer, c });
}

const top = (p) => Object.keys(p).reduce((a, b) => (p[b] > p[a] ? b : a));
const nll = (T) => -data.reduce((s, d) => s + Math.log(Math.max(1e-12, scale(d.mass, T)[d.answer])), 0) / data.length;
// 5 bins: with ~100 examples, 10 bins is mostly noise.
const ece = (T, B = 5) => {
  const bins = Array.from({ length: B }, () => ({ conf: 0, acc: 0 }));
  for (const d of data) {
    const p = scale(d.mass, T), t = top(p), conf = d.c * p[t];
    const b = bins[Math.min(B - 1, Math.floor(conf * B))];
    b.conf += conf; b.acc += t === d.answer ? 1 : 0;
  }
  return bins.reduce((s, b) => s + Math.abs(b.acc - b.conf), 0) / data.length;
};

let best = 1;
for (let T = 0.25; T <= 5; T += 0.05) if (nll(T) < nll(best)) best = T;
best = Math.round(best * 100) / 100;

console.log(`examples: ${data.length}`);
console.log(`accuracy: ${(100 * data.filter((d) => top(scale(d.mass, 1)) === d.answer).length / data.length).toFixed(0)}% (argmax does not depend on T)`);
console.log(`ECE at T=1: ${ece(1).toFixed(3)}  ->  at T=${best}: ${ece(best).toFixed(3)}`);
console.log(`\nSuggested: CHOOSE_LLM_TEMPERATURE=${best}`);
if (best <= 0.25 || best >= 4.95) console.log("Warning: T hit the edge of the search range (0.25-5). Too few examples, or the model is a poor fit for this task.");
console.log();
console.log("CHOOSE_THRESHOLD  automatic  accuracy among automatic");
for (const thr of [0.5, 0.6, 0.7, 0.8, 0.9]) {
  const kept = data.filter((d) => { const p = scale(d.mass, best); return d.c * p[top(p)] >= thr; });
  const acc = kept.filter((d) => top(scale(d.mass, best)) === d.answer).length / (kept.length || 1);
  console.log(`${String(thr).padEnd(18)} ${(100 * kept.length / data.length).toFixed(0).padStart(7)}%  ${kept.length ? (100 * acc).toFixed(0) + "%" : "-"}`);
}
console.log("\nThis T is valid for this model + prompt. Recalibrate if either changes.");
