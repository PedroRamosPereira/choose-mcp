---
name: choose
description: Use before delegating a task to an agent, subagent or model; before picking an effort level, model tier or strategy; when picking the best of several results or drafts; or when filtering or classifying a list by relevance. Calls the choose MCP tool to get a probability per option and an uncertainty flag instead of guessing.
---

# choose

The `choose` tool turns a "which of these options?" decision into one call. It returns the pick, a probability per option and `uncertain: true` when confidence is below the threshold.

## When to call it

Call it on your own, without the user asking, when:

- more than one agent, subagent or model could take the task you are about to delegate;
- you must decide how much effort, which model tier or which approach a task deserves;
- you have several results, drafts or candidates and must keep the best one;
- you have a list (files, issues, search results, tickets) and must keep only the relevant items.

Skip it when:

- there is only one reasonable option, or the user already chose;
- the decision is trivial and easy to undo;
- the question is open-ended, with no fixed set of options.

## How to build the call

1. `context`: every fact the decision needs, as JSON with named fields. The backend sees nothing else: not the chat, not the files.
2. `question`: the decision in one complete sentence.
3. `options`: `{name: description}`. Descriptions must be distinct and say when that option is right. Add `"none"` when nothing may fit.
4. `mode`: `"single"` to pick exactly one; `"multi"` to judge each option on its own and keep every one that fits (filtering).

## Ready-made patterns

Route a task:

```json
{
  "context": { "task": "Refactor the payments module", "agents": ["codex", "claude"] },
  "question": "Which agent should run this task?",
  "options": {
    "codex": "Refactoring and backend code",
    "claude": "Review, docs and writing",
    "none": "Neither agent fits"
  }
}
```

Pick the effort level:

```json
{
  "context": { "task": "Fix a typo in the README" },
  "question": "What effort level does this task need?",
  "options": {
    "low": "Trivial, mechanical task with no multi-step reasoning",
    "medium": "Regular coding task with some context to read",
    "high": "Ambiguous task, architecture work or hard debugging"
  }
}
```

Filter a list:

```json
{
  "context": { "goal": "Find files involved in the login bug", "bug": "Session expires right after login" },
  "question": "Is this file likely involved in the bug?",
  "options": { "src/auth/session.ts": "Session creation and expiry", "src/ui/Button.tsx": "Generic button component" },
  "mode": "multi"
}
```

## Acting on the result

- `single`: act on `choice`. If `choice` is `"none"`, say no option fits and ask.
- `multi`: keep `approved` (already sorted). Items in `doubtful` scored near 0.5.
- `uncertain: true`: follow the rule the user configured. With no rule, do not proceed: show the options with their probabilities and wait for the user.
- An error result means the backend failed or is not configured: tell the user, then decide without the tool.
