# Agents Panel — Organic Ask Channel via PreToolUse Hook (Plan 3c)

**Date:** 2026-06-17
**Status:** Approved; executing via subagent-driven-development (no commits until end).
**Supersedes:** `docs/plans/2026-06-17-agents-panel-ask-channel.md` (Plan 3b — the blocking `ask_human` MCP tool). 3b's channel (registry + `Event_AgentAsk` + `AskCard` + `AnswerAgentCommand`) is **reused**; its trigger (the `ask_human` MCP tool the agent had to *choose* to call) is **removed**.

## 1. Why this exists (the pivot)

Plan 3b shipped an `ask_human` MCP tool. Live testing proved agents **never call it organically** — only when explicitly ordered to. The agent's real, built-in "ask the human" mechanism is the **`AskUserQuestion`** tool (CC's system prompt: *"End turns with AskUserQuestion (for clarifications)"*; superpowers:brainstorming uses it unprompted).

Verified against the Claude Code 2.1.179 binary and end-to-end on a real agent (2026-06-17):
- A **PreToolUse hook matching `AskUserQuestion`** fires the instant the agent asks — **even under `--dangerously-skip-permissions`** (`permission_mode: "bypassPermissions"`).
- The hook resolves its Wave block from `process.env.WAVETERM_BLOCKID` (term block injects it, `blockcontroller.go:466`; also `WAVETERM_WSHBINDIR` so it can find `wsh`).
- The hook can **block** for the human (per-hook `timeout` in settings is seconds, huge ceiling).
- Returning `{permissionDecision:"deny", permissionDecisionReason:"<answer>"}` **suppresses the terminal prompt** and feeds the answer to the model, which continues from it (proven: agent printed *"You chose Ship — proceeding"*). The terminal frames the result as `Error: <reason>`; the model parses it correctly regardless.
- The Elicitation hook does NOT help (fires only for MCP-server `elicitation/create`, not the agent's own questions). Stop hooks do NOT fire (AUQ is a mid-turn tool wait).

**Known coverage gap (non-goal here):** bare prose questions (agent asks in text + ends its turn, no tool) are not caught by PreToolUse — would need a Stop hook with question-vs-done detection. Deferred.

## 2. Data model (full fidelity — the AUQ schema)

`AskUserQuestion` `tool_input` is:
```jsonc
{ "questions": [ { "question": "...", "header": "...", "multiSelect": false,
                   "options": [ { "label": "...", "description": "..." } ] } ] }
```
Up to ~4 questions; option labels may contain `"(Recommended)"`; custom (freeform) answers are always allowed (AUQ never includes None/Other options).

The channel payload widens to carry exactly this. Define the question/option structs **once** in `baseds` and reference them from the RPC command (DRY).

```go
// pkg/baseds/baseds.go
type AgentAskOption struct {
    Label       string `json:"label"`
    Description string `json:"description,omitempty"`
}
type AgentAskQuestion struct {
    Question    string           `json:"question"`
    Header      string           `json:"header,omitempty"`
    MultiSelect bool             `json:"multiselect,omitempty"`
    Options     []AgentAskOption `json:"options,omitempty"`
}
type AgentAskData struct {
    ORef      string             `json:"oref"`
    AskId     string             `json:"askid"`
    Questions []AgentAskQuestion `json:"questions,omitempty"`
    Ts        int64              `json:"ts,omitempty"`
    Cleared   bool               `json:"cleared,omitempty"`
}
```
The flat `Question string` / `Options []string` / `Recommendation string` fields are **removed** (AUQ has no recommendation; "(Recommended)" lives in an option label).

**Answer format (string, both into `AnswerAgentCommand` and out as the deny-reason).** The card formats one line per question:
`<header or question>: <selected label>` (multiSelect → comma-joined labels; freeform → the typed text). Joined by newlines. Example:
```
Project type: CLI tool
Runtime/PM: Node + pnpm
```

## 3. Components

```
agent calls AskUserQuestion
        │  PreToolUse hook (matcher AskUserQuestion) — docs/agents/ask-hook.js
        │     resolves oref from $WAVETERM_BLOCKID, finds wsh via $WAVETERM_WSHBINDIR
        ▼
   wsh ask  (hidden subcommand; reads AUQ {questions} JSON on stdin)
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
        ▼ hook returns deny + permissionDecisionReason=answerString  → terminal prompt suppressed, agent continues
```

## 4. Tasks

> **Process:** subagent-driven-development. Implementer = `sonnet`; both reviewers = `opus`. **No commits** (batched at end on explicit approval — overrides the skill's per-task commit). Work on `main`. Never run `go build` (trust VSCode problems). Never hand-edit generated files — run `task generate`. Run Go tests from the project root.

### Task 1 — Backend: widen the channel payload + reshape the RPC (removes the `AskHuman` naming)
**Files:** `pkg/baseds/baseds.go`, `pkg/wshrpc/wshrpctypes.go`, `pkg/wshrpc/wshserver/wshserver.go`; then `task generate` (regenerates `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts`).
- In `baseds`: replace `AgentAskData`'s flat fields with `Questions []AgentAskQuestion` and add `AgentAskQuestion` + `AgentAskOption` (see §2). Update the doc comment.
- In `wshrpctypes.go`: rename `AskHumanCommand`→`AskCommand`, `CommandAskHumanData`→`CommandAskData`, `AskHumanRtnData`→`AskRtnData`. `CommandAskData` = `{ ORef string \`json:"oref"\`; Questions []baseds.AgentAskQuestion \`json:"questions"\` }`. Keep `AskRtnData{Answer string}` and `CommandAnswerAgentData{AskId, Answer}`. Update the interface method signatures (lines ~218-219).
- In `wshserver.go`: rename the handler to `AskCommand`; validate `ORef != "" && len(Questions) > 0`; publish `AgentAskData` with `Questions`; keep the register/defer-Drop/defer-Cleared/select-on-ctx structure verbatim (incl. the existing WHY comment on the deferred Cleared publish). `AnswerAgentCommand` and `publishAgentAsk` unchanged.
- Run `task generate`. Do not hand-edit generated output.
- **Verify:** no VSCode/Go errors; `pkg/agentask` tests still pass (`go test ./pkg/agentask/...` from root); generated TS shows `AskCommand` + `questions`.
- **Note:** after this task, `wshcmd-askserver.go` will not compile (it calls the old `AskHumanCommand`/`CommandAskHumanData`). That is removed in Task 2 — acceptable transient between tasks since we don't `go build` and don't commit between tasks. The implementer should NOT patch ask-server here.

### Task 2 — Replace the MCP `ask-server` with a hidden `wsh ask` command (MCP code cleanup)
**Files:** delete `cmd/wsh/cmd/wshcmd-askserver.go`; add `cmd/wsh/cmd/wshcmd-ask.go`.
- Delete the entire MCP stdio server file.
- New `wsh ask`: `Hidden: true`, `PreRunE: preRunSetupRpcClient`, `Args: cobra.NoArgs`. It reads the AUQ payload as JSON on **stdin** — shape `{ "questions": [ { "question", "header", "multiSelect", "options": [ { "label", "description" } ] } ] }` (note camelCase `multiSelect` in the AUQ JSON; map it into `baseds.AgentAskQuestion.MultiSelect`). Resolve the block via `resolveBlockArg()`. Call `wshclient.AskCommand(RpcClient, wshrpc.CommandAskData{ORef: oref.String(), Questions: mapped}, &wshrpc.RpcOpts{Timeout: AskTimeoutMs})` with `const AskTimeoutMs = int64(3600000)`. On success, print `rtn.Answer` to stdout (nothing else on stdout). On error, exit non-zero with the message on stderr (the hook treats non-zero/empty as "fall back to terminal"). Call `sendActivity("ask", rtnErr == nil)` in a deferred func like other commands.
- **Verify:** no Go errors; `grep -ri "ask-server\|ask_human\|AskHuman" pkg cmd` returns nothing.

### Task 3 — The PreToolUse hook + install doc (in-repo canonical script)
**Files:** add `docs/agents/ask-hook.js`; rewrite `docs/agents/ask-human-setup.md` → hook setup (rename to `docs/agents/organic-ask-setup.md`, delete the old file).
- `ask-hook.js` (Node, no deps): read PreToolUse JSON on stdin. If `tool_name !== "AskUserQuestion"` or no `process.env.WAVETERM_BLOCKID` or no `WAVETERM_WSHBINDIR` → print nothing, exit 0 (tool runs normally — graceful fallback). Otherwise resolve `wsh` = `path.join(WAVETERM_WSHBINDIR, process.platform === "win32" ? "wsh.exe" : "wsh")`, spawn it as `wsh ask` (synchronous/blocking) feeding `JSON.stringify({questions: tool_input.questions})` on stdin, capture stdout. If the child exits 0 with non-empty stdout → print `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason": "<the answer>"}}` (phrase so it reads as an answer despite the terminal's `Error:` prefix — e.g. prefix with `Answered in Wave: `). On any failure/empty → print nothing, exit 0 (fall back to the terminal prompt).
- The setup doc: the `.claude/settings.json` snippet registering the hook (matcher `AskUserQuestion`, `timeout: 3600`, command pointing at the in-repo `ask-hook.js` via an absolute path), plus a note that only this tiny registration is out-of-repo (the logic is versioned in the repo), and the prose-question coverage gap.
- **Verify:** `node --check docs/agents/ask-hook.js` passes; the doc's settings JSON is valid.

### Task 4 — Frontend: full-fidelity AskCard + types + merge
**Files:** `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/askcard.tsx`, `frontend/app/view/agents/liveagents.ts`, `frontend/app/view/agents/agentsviewmodel.test.ts`.
- `AgentAsk` becomes `{ questions: AgentAskQuestion[]; askId?: string }` with local `AgentAskQuestion = { question: string; header?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] }`. Remove the old `question/options/recommendation` fields.
- `withAsk(vm, ask: AgentAskData, now)`: map `ask.questions` → `AgentAsk.questions` (null/cleared → unchanged, as today).
- `AskCard`: render each question as a group — `header` chip + question text + its options as pills (label text; `description` as a `title`/subtext; primary-style the option whose label includes `"(Recommended)"`, else the first), with `multiSelect` allowing multiple toggled selections, and a per-question `or type…` freeform input. Submit is enabled once every question has a selection or freeform value; it builds the answer string (§2) and calls `onAnswer(askId, answerString)`. Keep the existing header (name · task · "asking · age"), the previous-info block, and the open-session affordance.
- Update `agentsviewmodel.test.ts` `withAsk` tests for the `questions[]` shape (test behavior: a live ask flips state to `asking` and carries the questions; cleared/null leaves the vm unchanged).
- **Verify:** `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts` (from root) passes; no TS errors.

### Task 5 — Docs cleanup + final reference sweep
**Files:** `docs/specs/2026-06-17-ask-human-channel-design.md`, `docs/docs/wsh-reference.mdx`, `docs/plans/2026-06-17-agents-panel-ask-channel.md`.
- Spec: revise §2 (decision is now the PreToolUse hook, not the blocking `ask_human` tool), §3 (the organic-catch is now in scope; the prose-question gap is the new non-goal), and §4 (architecture per §3 here). Keep it a design record, not a changelog.
- `wsh-reference.mdx`: remove the `ask-server` entry. (`wsh ask` is hidden/internal — do not document it as a user command.)
- Old plan 3b: add a one-line header marking it **superseded by Plan 3c** (do not delete — design history).
- **Verify (the cleanup gate):** `grep -ri "ask-server\|ask_human\|AskHuman\|wave-ask" docs pkg cmd frontend` returns only intentional historical mentions in the 3b plan/spec and Plan 3c's own "why we removed it" prose — no live code, no live config, no `wsh-reference` entry.

## 5. Verification (live, after all tasks)

Reuse the proven loop, now hitting the real channel (not `answer.txt`): install the hook in a session, spawn a real agent that calls `AskUserQuestion` (e.g. brainstorming), confirm the card appears in the Agents panel with all questions + options, answer inline, and confirm the terminal prompt never rendered and the agent continued from the submitted answer. Also confirm close-session-while-asking clears the card.

## 6. Out-of-scope / deferred
- Prose-question (Stop-hook) coverage.
- Auto-installing the hook/settings into user config (opt-in docs only).
- Non-Claude agents; auto-answer/Gatekeeper policy (the queue resolver remains the future seam).
