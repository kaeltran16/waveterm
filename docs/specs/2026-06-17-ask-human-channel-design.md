# Ask-Human Answer Channel — Design Spec

**Date:** 2026-06-17
**Status:** Implemented per Plan 3c (`docs/plans/2026-06-17-agents-panel-organic-ask-hook.md`)
**Base:** Refines §5.2 + §6 of `docs/specs/2026-06-17-agents-panel-design.md` and resolves its Open Item #2. Builds on the Agents panel shipped through Plan 3a (`docs/plans/2026-06-17-agents-panel-live-roster.md`). The `AskCard` UI (inline question + option pills + reply, `onAnswer`) already exists from 3a; this spec adds the channel that feeds it and routes the answer back.

## 1. What this is

The pull answer-channel for the Agents panel: a coding agent asks a structured decision; the question surfaces in that agent's `AskCard`; the user answers inline; the answer routes back and **unblocks the agent without the terminal ever being in the loop**. The loop is deterministic — scripts + a queue, no LLM in the path.

## 2. Decision: PreToolUse hook on `AskUserQuestion`, not a blocking MCP tool

The original 3b design chose a blocking `ask_human` MCP tool the agent had to explicitly call. Live testing proved agents **never call a custom `ask_human` tool organically** — only when explicitly ordered to. This spec records the design as shipped: a **PreToolUse hook on `AskUserQuestion`**, Claude Code's built-in "ask the human" mechanism.

**Why the hook wins:**
- **Organic.** CC's system prompt instructs agents to end turns with `AskUserQuestion` for clarifications; skills like `superpowers:brainstorming` invoke it unprompted. The hook fires on the agent's own built-in path — no special tool registration or CLAUDE.md steering needed.
- **Works under `--dangerously-skip-permissions`.** The PreToolUse hook fires even in `bypassPermissions` mode; permission-tier hooks that require approval do not.
- **Answer delivery without terminal prompt.** Returning `{permissionDecision:"deny", permissionDecisionReason:"<answer>"}` from the hook suppresses the interactive terminal prompt and feeds the answer string directly to the model. Verified end-to-end: agent printed *"You chose Ship — proceeding"* from the deny-reason.
- **In-repo logic.** The hook script (`docs/agents/ask-hook.js`) is versioned with Wave. Only the tiny `.claude/settings.json` registration snippet lives outside the repo.

**Why the MCP approach was dropped:** See Plan 3c §1 for the full reasoning. Elicitation hooks were also evaluated (they only fire for MCP-server `elicitation/create`, not the agent's own questions — not viable here).

For the implementation, see Plan 3c (`docs/plans/2026-06-17-agents-panel-organic-ask-hook.md`).

## 3. Scope / non-goals

**In scope (shipped)**
- A PreToolUse hook (`docs/agents/ask-hook.js`) matching `AskUserQuestion` that intercepts the agent's built-in question mechanism.
- `wsh ask` (hidden subcommand): reads the AUQ `{questions[]}` payload on stdin, resolves the block oref, invokes `AskCommand` RPC, and prints the answer to stdout (which the hook returns as the deny-reason).
- Two `wshrpc` commands: `AskCommand` (blocking; registers the ask, publishes `Event_AgentAsk`, returns the answer) and `AnswerAgentCommand` (resolves a pending ask).
- A backend ask-registry + `Event_AgentAsk` WPS event (scoped to the block oref).
- Frontend: per-block ask store, merge onto `AgentVM.ask` in `liveAgentsAtom` (asking agents only), `AskCard.onAnswer` → `AnswerAgentCommand`.
- **Catching the agent's organic questions** — this is the whole point. AUQ fires unprompted when agents genuinely need clarification.
- **Enforcement as opt-in docs:** `docs/agents/organic-ask-setup.md` — the `.claude/settings.json` hook registration snippet (opt-in only; Wave does not auto-install it).

**Non-goals (deferred or out of scope)**
- Bare prose questions (agent ends its turn with a question in text, no `AskUserQuestion` tool) — would need a Stop hook with question-vs-done detection; deferred.
- Non-Claude agents (Claude Code only, per the parent spec).
- Auto-installing the hook or settings into user config (opt-in docs only).
- Auto-answer / make-a-rule / Gatekeeper policy. The queue resolver is the future seam; this channel leaves it open, builds no policy.
- The conversational manager — a later layer over the same queue.

## 4. Architecture & data flow

```
agent calls AskUserQuestion
        │  PreToolUse hook (matcher: AskUserQuestion) — docs/agents/ask-hook.js
        │     resolves oref from $WAVETERM_BLOCKID
        │     finds wsh via $WAVETERM_WSHBINDIR
        ▼
   wsh ask  (hidden; reads AUQ {questions[]} JSON on stdin)
        │  resolveBlockArg() → oref
        ▼
   AskCommand wshrpc ──▶ wavesrv: register askId, publish Event_AgentAsk{oref,askid,questions,ts}, BLOCK
        │                                   ▼ frontend agentAskStore → getAgentAskAtom(oref)
        │                                   ▼ withAsk merges questions onto AgentVM.ask (asking agents)
        │                              AskCard renders N questions × options (+ freeform), user submits
        │◀── answer ◀── AnswerAgentCommand ◀── AskCard.onAnswer(askId, answerString)
        ▼
   wsh ask prints answerString to stdout
        │
        ▼ hook returns {permissionDecision:"deny", permissionDecisionReason: answerString}
          → terminal prompt suppressed, agent continues with the answer
```

### 4.1 Components

1. **PreToolUse hook (`docs/agents/ask-hook.js`).** Node, no dependencies. If `tool_name !== "AskUserQuestion"` or the Wave env vars are absent → exits 0, no output (graceful fallback to the terminal prompt). Otherwise resolves `wsh` from `$WAVETERM_WSHBINDIR`, spawns `wsh ask` synchronously feeding the AskUserQuestion `tool_input` (a `{questions: [...]}` object) on stdin, captures stdout. On success → returns the deny+reason JSON. On any failure → exits 0, falls back to terminal.

2. **`wsh ask` (hidden subcommand).** Reads `{questions[]}` JSON on stdin, resolves the block oref via `resolveBlockArg()`, calls `AskCommand` with a 1-hour timeout, prints the answer to stdout on success or exits non-zero on error.

3. **`wshrpc` commands** (defined in `wshrpctypes.go`, implemented in `wshserver.go`):
   - `AskCommand(data {oref, questions[]}) → {answer}` — registers the pending ask, publishes `Event_AgentAsk`, then **blocks** on the answer channel until answered or the call's context cancels. Uses an explicit long `RpcOpts.Timeout`.
   - `AnswerAgentCommand(data {askid, answer})` — resolves the pending ask's answer channel. Called from the UI.

4. **Backend ask-registry** (`pkg/agentask`): a mutex-guarded `map[askId]chan string`, with `Register` / `Resolve` / `Drop` helpers using the `lock.Lock(); defer lock.Unlock()` pattern. `Event_AgentAsk` is published scoped to the block oref so the existing per-block subscription model carries it; a `Cleared` event (same oref+askId) removes the card on resolution or cancel.

5. **Frontend** (reuse): `agentAskStore` subscribes to `agent:ask` per oref → `getAgentAskAtom(oref)`; `withAsk` merges the ask onto `AgentVM.ask` in the live roster; `AskCard` renders the full-fidelity questions (header, options, multi-select, freeform); `onAnswer` calls `RpcApi.AnswerAgentCommand`.

## 5. AUQ payload schema

`AskUserQuestion` `tool_input` shape (from the Claude Code 2.1.179 binary, 2026-06-17):
```jsonc
{
  "questions": [
    {
      "question": "...",
      "header": "...",
      "multiSelect": false,
      "options": [ { "label": "...", "description": "..." } ]
    }
  ]
}
```
Up to ~4 questions per call. Option labels may include `"(Recommended)"`. Custom/freeform answers are always allowed.

The Go types in `baseds.AgentAskData` carry this shape exactly (see Task 1 of Plan 3c for the struct definitions). The answer is a formatted string: `<header or question>: <label(s) or freeform>` per question, newline-joined.

## 6. Error handling & edge cases (all deterministic)

- **Agent dies / session closes while waiting:** the `AskCommand` context cancels → the registry drops the pending ask and publishes a Cleared event → the card disappears.
- **Answer submitted after the ask already resolved:** `AnswerAgentCommand` finds no pending channel → no-op; the UI surfaces a quiet "already resolved."
- **Multiple asks from one session:** one outstanding ask per session is expected; keyed by askId, the store keeps the newest per oref.
- **Hook failure / wsh unavailable:** hook exits 0 with no output → CC falls back to the normal terminal prompt. The channel is fail-open.
- **Long human delay vs. timeout:** `wsh ask` uses a 1-hour RPC timeout. On timeout the hook falls back to terminal (exits 0 / empty stdout path).

## 7. Testing / verification

- **Unit (backend):** the ask-registry — register, resolve/return answer, drop-on-cancel, answer-after-resolved no-op (`pkg/agentask` unit tests).
- **Unit (frontend):** `withAsk` pure function — live ask flips state to `asking` and carries questions; null/cleared leaves the vm unchanged (vitest).
- **Live:** a real agent calls `AskUserQuestion` unprompted (e.g. during brainstorming) → its card appears in the Agents panel → answering inline unblocks the agent, terminal prompt never rendered → close-session-while-asking clears the card.

## 8. Build notes / reuse

- **New:** `wsh ask` subcommand; `AskCommand` / `AnswerAgentCommand` RPCs; backend ask-registry + `Event_AgentAsk`; frontend ask store + `withAsk` merge; the PreToolUse hook script.
- **Removed from Plan 3b:** `wsh ask-server` (the MCP stdio server), `AskHumanCommand` / `CommandAskHumanData` RPC names, the `ask_human` tool definition, the `.mcp.json` registration convention.
- **Reuse:** `RpcContext.BlockId` block-keying (same as `wsh agentstatus`), the WPS per-block event/subscription pattern, the `AskCard` / `AgentAsk` / `AgentVM.ask` UI from 3a, `liveAgentsAtom`, the agentask registry from 3b (same structure, renamed RPC surface).
- **Docs (opt-in):** `docs/agents/organic-ask-setup.md` — the hook registration snippet and behavior notes.

## 9. Phased path

Concierge / decision-inbox (Agents panel + this channel) → **Gatekeeper** (auto-answer routine asks in the queue resolver, escalate real forks) → **Delegator** (spawn + manage workers). The queue is the substrate; Gatekeeper and the conversational manager are layers over it, deferred — this channel does not change to add them.
