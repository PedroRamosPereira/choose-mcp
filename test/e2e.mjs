// End-to-end test: starts a fake TypeSafe API and calls the tool through a real MCP client.
import http from "node:http";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const api = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const { questions } = JSON.parse(b);
    const answers = {};
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === "choice") answers[k] = { type: "choice", choice: "codex", confidence: 0.45, probabilities: { codex: 0.55, claude: 0.45 } };
      else answers[k] = { type: "noul", noul: q.instructions.includes('"a"') ? 0.9 : q.instructions.includes('"b"') ? 0.55 : 0.1 };
    }
    res.end(JSON.stringify({ model: "jev-latest", answers, usage: {} }));
  });
}).listen(0);
await new Promise((r) => api.once("listening", r));

const client = new Client({ name: "test", version: "0" });
await client.connect(new StdioClientTransport({
  command: "node", args: ["dist/index.js"],
  env: { ...process.env, TYPESAFE_API_KEY: "x", TYPESAFE_BASE_URL: `http://127.0.0.1:${api.address().port}` },
}));
const call = async (a) => JSON.parse((await client.callTool({ name: "jev_choose", arguments: a })).content[0].text);

const single = await call({ context: { task: "refactor" }, question: "Which agent?", options: { codex: "good at refactoring", claude: "good at writing" } });
assert.deepEqual([single.choice, single.uncertain], ["codex", true]);

const multi = await call({ context: "x", question: "Relevant?", options: { a: "1", b: "2", c: "3" }, mode: "multi" });
assert.deepEqual(multi.approved, ["a", "b"]);
assert.deepEqual(multi.doubtful, ["b"]);

const err = await client.callTool({ name: "jev_choose", arguments: { context: "x", question: "?", options: { only: "one" } } });
assert.ok(err.isError);

console.log("ok");
await client.close(); api.close();
