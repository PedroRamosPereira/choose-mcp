// Backend "llm": any OpenAI-compatible /chat/completions that returns logprobs
// (OpenAI non-reasoning models, vLLM, llama.cpp, Ollama >= 0.12.11). Same output shape as the TypeSafe API.
export type Question = { type: "choice" | "noul"; instructions: string; criteria?: Record<string, string> };
type Top = { token: string; logprob: number };

const BASE = process.env.CHOOSE_LLM_BASE_URL ?? "http://localhost:11434/v1";
const MODEL = process.env.CHOOSE_LLM_MODEL;
const KEY = process.env.CHOOSE_LLM_API_KEY;
const TEMP = Number(process.env.CHOOSE_LLM_TEMPERATURE ?? 1);
const SAMPLES = Number(process.env.CHOOSE_LLM_SAMPLES ?? 0);
const CONCURRENCY = Number(process.env.CHOOSE_LLM_CONCURRENCY ?? 4);
const TIMEOUT = Number(process.env.CHOOSE_LLM_TIMEOUT_MS ?? 60000);
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SYSTEM = "You are a classifier. Reply with exactly one of the allowed labels and nothing else.";

// " A", "**A", "a)" -> "a". First word only, so sampled text like "B) codex" also works.
const norm = (s: string) => (s.trim().split(/\s+/)[0] ?? "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();

// Probability mass per label, summing token variants. Tokens outside the labels are left out (that gap is the "coverage" signal).
export function labelMass(top: Top[], labels: string[]): Record<string, number> {
  const mass: Record<string, number> = Object.fromEntries(labels.map((l) => [l, 0]));
  for (const t of top) {
    const l = labels.find((x) => x.toLowerCase() === norm(t.token));
    if (l) mass[l] += Math.exp(t.logprob);
  }
  return mass;
}

// Temperature scaling restricted to the labels: softmax(log(m) / T).
export function scale(mass: Record<string, number>, temp: number): Record<string, number> {
  const pow = Object.entries(mass).map(([k, m]) => [k, m ** (1 / temp)] as const);
  const z = pow.reduce((s, [, v]) => s + v, 0);
  return Object.fromEntries(pow.map(([k, v]) => [k, z > 0 ? v / z : 0]));
}

async function chat(body: object): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (KEY) headers.Authorization = `Bearer ${KEY}`;
  for (let i = 0; ; i++) {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: MODEL, ...body }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (r.ok) return r.json();
    // ponytail: 2 fixed retries on 429/5xx, no Retry-After parsing.
    if (i >= 2 || (r.status !== 429 && r.status < 500)) throw new Error(`LLM ${r.status}: ${await r.text()}`);
    await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i));
  }
}

async function ask(prompt: string, labels: string[]): Promise<Record<string, number>> {
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }];
  const r = await chat({ messages, max_tokens: 4, temperature: 0, logprobs: true, top_logprobs: 20 });
  const steps: { token: string; top_logprobs: Top[] }[] | undefined = r.choices?.[0]?.logprobs?.content;
  if (steps?.length) {
    const step = steps.find((s) => norm(s.token) !== "") ?? steps[0]; // skip leading "**", "(", "\n"
    return labelMass(step.top_logprobs, labels);
  }
  if (!(SAMPLES > 0))
    throw new Error("The LLM API returned no logprobs. Use a server that exposes them (OpenAI non-reasoning models, vLLM, llama.cpp, Ollama >= 0.12.11) or set CHOOSE_LLM_SAMPLES (e.g. 5) to estimate by sampling.");
  // Sampling fallback: each answer weighs 1/N, so labelMass turns counts into frequencies.
  const outs = await Promise.all(Array.from({ length: SAMPLES }, () => chat({ messages, max_tokens: 4, temperature: 1 })));
  return labelMass(outs.map((o) => ({ token: String(o.choices?.[0]?.message?.content ?? ""), logprob: -Math.log(SAMPLES) })), labels);
}

// Raw (uncalibrated) mass per option name, or per "Yes"/"No" for noul.
export async function massFor(ctx: string, q: Question): Promise<Record<string, number>> {
  if (q.type === "noul") return ask(`Context:\n${ctx}\n\n${q.instructions}\nAnswer Yes or No.`, ["Yes", "No"]);
  const criteria = q.criteria ?? {};
  const names = Object.keys(criteria);
  if (names.length > LETTERS.length)
    throw new Error(`mode "single" supports up to ${LETTERS.length} options with the llm backend (got ${names.length}). Use mode "multi" or CHOOSE_BACKEND=typesafe.`);
  const labels = names.map((_, i) => LETTERS[i]);
  const list = names.map((n, i) => `${labels[i]}) ${n}: ${criteria[n]}`).join("\n");
  const prompt = `Context:\n${ctx}\n\nQuestion: ${q.instructions}\n\nOptions:\n${list}\n\nAnswer with the letter (A-${labels[labels.length - 1]}) of the best option.`;
  const byLetter = await ask(prompt, labels);
  return Object.fromEntries(names.map((n, i) => [n, byLetter[labels[i]]]));
}

function toAnswer(q: Question, mass: Record<string, number>) {
  const coverage = Math.min(1, Object.values(mass).reduce((s, v) => s + v, 0));
  if (coverage < 1e-6) throw new Error("The LLM answered outside the allowed labels. Use an instruct model or disable thinking.");
  const p = scale(mass, TEMP);
  // Mass outside the labels means the model wanted to say something else: count it as doubt.
  if (q.type === "noul") return { noul: coverage * p.Yes + (1 - coverage) * 0.5 };
  const choice = Object.keys(p).reduce((a, b) => (p[b] > p[a] ? b : a));
  return { choice, confidence: p[choice] * coverage, probabilities: p };
}

// ponytail: tiny worker pool, no queue library.
async function pool<T, R>(items: T[], limit: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit || 1, items.length)) }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await f(items[k]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function llm(state: unknown, questions: Record<string, Question>): Promise<{ answers: Record<string, any> }> {
  if (!MODEL) throw new Error("CHOOSE_LLM_MODEL is not set. Example: CHOOSE_LLM_MODEL=qwen2.5:7b-instruct (Ollama) or CHOOSE_LLM_MODEL=gpt-4.1-mini with CHOOSE_LLM_BASE_URL=https://api.openai.com/v1.");
  if (!(TEMP > 0)) throw new Error("CHOOSE_LLM_TEMPERATURE must be a number > 0");
  const ctx = typeof state === "string" ? state : JSON.stringify(state, null, 2);
  const entries = await pool(Object.entries(questions), CONCURRENCY, async ([k, q]) => [k, toAnswer(q, await massFor(ctx, q))] as const);
  return { answers: Object.fromEntries(entries) };
}
