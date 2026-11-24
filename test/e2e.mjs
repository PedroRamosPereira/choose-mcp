// End-to-end test: one fake server mimics the TypeSafe API and an OpenAI-compatible LLM; calls go through a real MCP client.
import http from "node:http";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { labelMass, scale } from "../dist/llm.js";

// Unit: label mass and temperature scaling.
const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-6, `${x} != ${y}`);
const t = (token, p) => ({ token, logprob: Math.log(p) });
const m = labelMass([t(" A", 0.4), t("a", 0.1), t("**B", 0.3), t("The", 0.2)], ["A", "B"]);
near(m.A, 0.5); near(m.B, 0.3); // variants merged, "The" left out
near(scale(m, 1).A, 0.625); // renormalized among valid labels
assert.ok(scale(m, 2).A < 0.625 && scale(m, 2).A > 0.5); // T > 1 flattens
assert.ok(scale(m, 0.5).A > 0.625); // T < 1 sharpens

const lp = (pairs) => pairs.map(([token, p]) => ({ token, logprob: Math.log(p), bytes: [] }));

function fakeChat(body) {
  if (body.model === "fail") return [401, { error: { message: "bad key" } }];
  if (body.model === "nologprobs") return [200, { choices: [{ message: { role: "assistant", content: "B" }, logprobs: null }] }];
  const prompt = body.messages.at(-1).content;
  const top = body.model === "chatty" ? lp([["Sure", 0.9], ["Here", 0.1]])
    : prompt.includes("Options:") ? lp([["A", 0.5], [" B", 0.3], ["The", 0.2]]) // 20% outside the labels
    : prompt.includes('"a"') ? lp([["Yes", 0.9], ["No", 0.1]])
    : prompt.includes('"b"') ? lp([["Yes", 0.45], [" no", 0.35], ["Maybe", 0.2]])
    : lp([["Yes", 0.1], ["No", 0.9]]);
  const { token, logprob } = top[0];
  return [200, { choices: [{ message: { role: "assistant", content: token }, logprobs: { content: [{ token, logprob, top_logprobs: top }] } }] }];
}

function fakeJev({ questions }) {
  const answers = {};
  for (const [k, q] of Object.entries(questions)) {
    if (q.type === "choice") answers[k] = { type: "choice", choice: "codex", confidence: 0.45, probabilities: { codex: 0.55, claude: 0.45 } };
    else answers[k] = { type: "noul", noul: q.instructions.includes('"a"') ? 0.9 : q.instructions.includes('"b"') ? 0.55 : 0.1 };
  }
  return [200, { model: "jev-latest", answers, usage: {} }];
}

const api = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const body = JSON.parse(b);
    const [status, json] = req.url.endsWith("/chat/completions") ? fakeChat(body) : fakeJev(body);
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json));
  });
}).listen(0);
await new Promise((r) => api.once("listening", r));
const BASE = `http://127.0.0.1:${api.address().port}`;

// The developer's shell may carry JEV_*/TYPESAFE_* vars; drop them so each case controls its own config.
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CHOOSE_|JEV_|TYPESAFE_)/.test(k)));
const clients = [];
async function connect(env) {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...clean, ...env } }));
  clients.push(c);
  const raw = (a) => c.callTool({ name: "choose", arguments: a });
  return { raw, call: async (a) => JSON.parse((await raw(a)).content[0].text) };
}

const SINGLE = { context: { task: "refactor" }, question: "Which agent?", options: { codex: "good at refactoring", claude: "good at writing" } };
const MULTI = { context: "x", question: "Relevant?", options: { a: "1", b: "2", c: "3" }, mode: "multi" };
const LLM = { CHOOSE_LLM_BASE_URL: BASE };

// TypeSafe backend (auto-detected from the key: backward compatible).
{
  const { raw, call } = await connect({ TYPESAFE_API_KEY: "x", TYPESAFE_BASE_URL: BASE });
  assert.match(clients.at(-1).getInstructions() ?? "", /without the user asking/);
  const [tool] = (await clients.at(-1).listTools()).tools;
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.match(tool.description, /^Route, delegate/);
  const single = await call(SINGLE);
  assert.deepEqual([single.choice, single.uncertain], ["codex", true]);
  const multi = await call(MULTI);
  assert.deepEqual(multi.approved, ["a", "b"]);
  assert.deepEqual(multi.doubtful, ["b"]);
  assert.ok((await raw({ context: "x", question: "?", options: { only: "one" } })).isError);
}

// LLM backend, explicit.
{
  const { call } = await connect({ CHOOSE_BACKEND: "llm", CHOOSE_LLM_MODEL: "fake", ...LLM });
  const s = await call(SINGLE);
  assert.equal(s.choice, "codex");
  near(s.probabilities.codex, 0.625);
  near(s.confidence, 0.5); // 0.625 * coverage 0.8
  assert.equal(s.uncertain, true);
  const mu = await call(MULTI);
  assert.deepEqual(mu.approved, ["a", "b"]);
  assert.deepEqual(mu.doubtful, ["b"]);
  near(mu.probabilities.b, 0.55); // 0.8 * 0.5625 + 0.2 * 0.5
  near(mu.probabilities.c, 0.1);
}

// LLM backend, auto-detected (no TypeSafe key).
assert.equal((await (await connect({ CHOOSE_LLM_MODEL: "fake", ...LLM })).call(SINGLE)).choice, "codex");

// Failure cases come back as isError.
async function fails(env, args, re) {
  const r = await (await connect(env)).raw(args);
  assert.ok(r.isError, JSON.stringify(env));
  assert.match(r.content[0].text, re);
}
await fails({ CHOOSE_BACKEND: "llm", CHOOSE_LLM_MODEL: "nologprobs", ...LLM }, SINGLE, /logprobs/);
await fails({ CHOOSE_BACKEND: "llm", CHOOSE_LLM_MODEL: "chatty", ...LLM }, SINGLE, /outside the allowed labels/);
await fails({ CHOOSE_BACKEND: "llm", CHOOSE_LLM_MODEL: "fail", ...LLM }, SINGLE, /401/);
await fails({ CHOOSE_BACKEND: "llm", CHOOSE_LLM_MODEL: "fake", ...LLM },
  { ...SINGLE, options: Object.fromEntries(Array.from({ length: 27 }, (_, i) => [`o${i}`, "x"])) }, /up to 26/);
await fails({}, SINGLE, /CHOOSE_LLM_MODEL/);
await fails({ CHOOSE_BACKEND: "foo" }, SINGLE, /CHOOSE_BACKEND/);

// No logprobs but sampling enabled: 3 samples all answer "B" -> claude.
{
  const { call } = await connect({ CHOOSE_BACKEND: "llm", CHOOSE_LLM_MODEL: "nologprobs", CHOOSE_LLM_SAMPLES: "3", ...LLM });
  const s = await call(SINGLE);
  assert.equal(s.choice, "claude");
  near(s.confidence, 1);
}

console.log("ok");
for (const c of clients) await c.close();
api.close();
