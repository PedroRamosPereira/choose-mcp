#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { llm, type Question } from "./llm.js";

const API = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai";
const MODEL = process.env.JEV_MODEL ?? "jev-latest";
const DEFAULT_THRESHOLD = Number(process.env.JEV_THRESHOLD ?? 0.6);
if (!(DEFAULT_THRESHOLD >= 0 && DEFAULT_THRESHOLD <= 1)) throw new Error("JEV_THRESHOLD must be a number between 0 and 1");
// Auto-detect: an existing TypeSafe key keeps Jev (backward compatible); otherwise an LLM model selects "llm".
const BACKEND = process.env.JEV_BACKEND ?? (process.env.TYPESAFE_API_KEY || !process.env.JEV_LLM_MODEL ? "typesafe" : "llm");

async function jev(state: unknown, questions: Record<string, Question>) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY is not set. Set it to use Jev, or set JEV_LLM_MODEL to use an OpenAI-compatible LLM (see README).");
  const r = await fetch(`${API}/v1/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, state, questions }),
  });
  if (!r.ok) throw new Error(`TypeSafe ${r.status}: ${await r.text()}`);
  return (await r.json()) as { answers: Record<string, any> };
}

function engine() {
  if (BACKEND === "typesafe") return jev;
  if (BACKEND === "llm") return llm;
  throw new Error(`JEV_BACKEND must be "typesafe" or "llm", got "${BACKEND}"`);
}

// "single" mode: one Choice question. "multi" mode: one Noul per option (each option is judged on its own).
export async function choose(a: {
  context: unknown;
  question: string;
  options: Record<string, string>;
  mode: "single" | "multi";
  threshold: number;
}) {
  if (a.mode === "single") {
    const { answers } = await engine()(a.context, {
      q: { type: "choice", instructions: a.question, criteria: a.options },
    });
    const { choice, confidence, probabilities } = answers.q;
    return { choice, confidence, probabilities, uncertain: confidence < a.threshold };
  }
  const names = Object.keys(a.options);
  const qs = Object.fromEntries(
    names.map((n, i) => [`o${i}`, { type: "noul" as const, instructions: `${a.question}\nOption under review: "${n}": ${a.options[n]}. Does this option fit?` }]),
  );
  const { answers } = await engine()(a.context, qs);
  const probabilities = Object.fromEntries(names.map((n, i) => [n, answers[`o${i}`].noul as number]));
  const approved = names.filter((n) => probabilities[n] >= 0.5).sort((x, y) => probabilities[y] - probabilities[x]);
  // Noul near 0.5 = real doubt between yes and no. With threshold 0.6, doubtful = between 0.4 and 0.6.
  const doubtful = names.filter((n) => probabilities[n] > 1 - a.threshold && probabilities[n] < a.threshold);
  return { approved, probabilities, doubtful, uncertain: doubtful.length > 0 };
}

const DESCRIPTION = `Choice filter with probabilities (backend: TypeSafe's Jev model or any OpenAI-compatible LLM). Use it whenever you need to decide between known options based on context: route a task to an agent, pick the right effort level or model for a task, pick the best result among several, filter the relevant items from a list, or any other "which of these options" decision. Use it at any step where you spot that need, not only at the orchestrator step.

INPUT
- context: everything the decision needs (text or JSON). Prefer JSON with named fields, e.g. {"task": "...", "agents": [...]}. The model only sees what is here.
- question: the decision in natural language, complete and specific.
- options: object {name: description}. Clear, distinct descriptions. Include a "none" option if nothing might fit.
- mode: "single" picks exactly one option; "multi" judges each option separately and returns every option that fits (use it to filter lists).
- threshold (optional): minimum confidence, 0 to 1.

OUTPUT (JSON)
- mode "single": {choice, confidence, probabilities, uncertain}
- mode "multi": {approved (sorted), probabilities, doubtful, uncertain}

WHEN uncertain = true: follow the uncertainty rule configured for you (decide alone, escalate, etc.). If no rule is configured, DO NOT proceed: show the options and probabilities to the user and wait for their answer.`;

const server = new McpServer({ name: "jev-filter", version: "1.0.0" });

server.registerTool(
  "jev_choose",
  {
    description: DESCRIPTION,
    inputSchema: {
      context: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
      question: z.string().min(1),
      options: z.record(z.string(), z.string()).refine((o) => Object.keys(o).length >= 2 && Object.keys(o).length <= 255, "2 to 255 options"),
      mode: z.enum(["single", "multi"]).default("single"),
      threshold: z.number().min(0).max(1).optional(),
    },
  },
  async (args) => {
    try {
      const r = await choose({ ...args, threshold: args.threshold ?? DEFAULT_THRESHOLD });
      return { content: [{ type: "text", text: JSON.stringify(r) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  },
);

await server.connect(new StdioServerTransport());
