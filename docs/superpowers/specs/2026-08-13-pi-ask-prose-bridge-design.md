# Pi Ask Prose Bridge — Design Spec

> 2026-08-13. Follow-on to the [pi ask bridge](2026-08-12-pi-ask-bridge-design.md)
> (workstream F, shipped): when a pi agent settles with a **bare-prose question** (no
> `ask_user_question` tool call — e.g. "Does A sound right, or do you want B/C?"), the
> cockpit renders it as a full interactive asking card. Scoped to pi (user decision
> 2026-08-13).

## 1. Goal

A pi agent running inside a Wave block ends its turn with a plain-text question. Today
that is just terminal scrollback: question cards exist only when an `agent:ask` event is
projected, and projection happens only on an `ask_user_question` tool call (mirror) or a
Claude Code `AskUserQuestion` hook. The bridge closes the gap: at true turn end
(`agent_settled`), a pure classifier reads the finalized last assistant message; if it
reads as a question, the extension projects the *same* asking card the tool path would
have — parsed option chips + free-text input — and answering injects the answer into the
block terminal as the next user message. The agent enters the `asking` roster/triage
state for free (`withAsk`), exactly like a tool ask.

## 2. Ground truth (verified against source, 2026-08-13)

**The ask pipeline (all existing, all reused):** `wsh ask` → `AskCommand`
(`pkg/wshrpc/wshserver/wshserver_ask.go`) → `PendingAsk` in `pkg/agentask`
`GlobalRegistry` + published `agent:ask` event → FE `agentaskstore.ts` atom →
`withAsk` (`agentsviewmodel.ts:761`) flips the agent to `state:"asking"` → `AnswerBar`
(`answerbar.tsx`) renders chips + a free-text input ("or type your own answer…", already
present) → `submitAnswer` (`agents.tsx:198`) → `AnswerAgentCommand` → `DeliverAnswer`
(`pkg/agentask/deliver.go`): `Claim` (atomic, idempotent) → waiter resolve (pi
`--wait` bridge) or PTY keystroke injection (`encode.go`: picker arrows for options,
`typeBytes`+Enter for free text, each write spaced by `KeystrokeDelay`).

**pi extension events (docs/extensions.md):** `message_end` fires for user/assistant/
toolResult messages with the **finalized** `event.message` (role + typed content
blocks: `text`/`thinking`/`toolCall`). `agent_settled` fires when the turn is truly over
(no retry/compaction/follow-up left) — the status extension already reports `idle`
there. `agent_start` fires when a new turn begins. Event order per turn:
`agent_start` → … → `message_end`(s) → `agent_end` → `agent_settled`.

**Delivery constraint (why delivery stays in the backend):** the only terminal-input
channel in the system is backend `blockcontroller.SendInput` (via `DeliverAnswer`).
`wsh` has **no input-send command** (`term`, `termscrollback`, `debugterm` only) and pi
extensions have no PTY access — so a "waiter resolves in the extension, extension types
the answer" variant would need a new wsh command plus delivery ownership split across
two processes. Rejected; the `--prose` flag + one delivery branch is smaller.

**Prose has no picker and no waiter:** the AUQ card delivers answers by driving a
native picker (arrows+Enter) or resolving a `--wait` waiter registered by a blocked
tool call. A prose question has neither — no tool call exists for a waiter to attach
to. Answer text must be typed directly into the block PTY; pi receives it as the next
user message, which is the correct channel.

**Provisioning (Part D pattern, verified):** `pi/extensions/*.ts` is the source of
truth; `task sync:piartifacts` copies to `cmd/wsh/cmd/pi-*-extension.ts` (Taskfile
:181-205); `wsh install-agent-hooks` → `installPiAskExtension`
(`cmd/wsh/cmd/wshcmd-installhooks.go:409`) writes the extension **pair**
(`waveterm-ask.ts` + `waveterm-ask-core.ts`) into `~/.pi/agent/extensions/` with
`__WSH_PATH__` substitution. The shipped ask extension (`waveterm-ask.ts`) is a
**non-blocking mirror**: `tool_call` → `wsh ask --questions-json` (no wait),
`tool_result` → `wsh ask --clear`; answering in the panel drives the rpiv questionnaire
via the existing keystroke path.

## 3. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Detection locus | pi extension, at `agent_settled` | finalized message in hand (zero transcript IO); true turn end = the agent is actually waiting; `message_end` alone would flash cards for mid-turn questions |
| Classifier | conservative v1: last paragraph of the last text block ends with `?` | bounds false positives; looser heuristics (question words, implicit asks) are tunable later on evidence |
| Option extraction | paragraph/line markers only: `Approach A:`/`Option B:`-style headers, `A)` `A.` `A:` lists, `-` bullets → chips (label + description) | covers the actual case ("Approach A: …"); inline "A or B" stays chip-less (out of scope) |
| AUQ guard | skip prose projection when the turn used `ask_user_question` | the tool already produced a card; prevents double cards |
| Card | identical AUQ card, `prose` flag on the data | same UI, same registry, same answer RPC — the only fork is delivery encoding |
| Delivery | backend types answer text + Enter (no arrows), via `DeliverAnswer` prose branch | no picker exists; extension cannot type (no wsh input command — see §2) |
| Clear | extension `wsh ask --clear` on next `agent_start` (only when a prose card is live) | answered, typed-in-terminal, or ignored — every outcome ends the card |
| Answer shape | chip click submits the option label as **text** | prose has no picker to drive; the label is what pi needs to read |
| Scope | pi only | CC prose is the older known gap but CC is trained to AUQ; a CC classifier would be a second harness (Go Stop hook) — defer |

## 4. Classifier — `pi/extensions/waveterm-prose-core.ts` (new, pure)

Default export no-op (pi auto-loads every file in the extensions dir; this module is a
dependency). `detectProseQuestion(lastAssistantText: string): ProseQuestion | null`
where `ProseQuestion = { question: string; options?: { label: string; description?: string }[] }`.

Rules (v1, all unit-tested):

- Input is the **text content blocks only** of the last assistant message, joined with
  `\n` (`thinking`/`toolCall` blocks ignored). Known v1 limitation: markdown code
  fences live inside the same text block, so a *trailing* fence after the question
  makes the last paragraph code, not the question — detection misses it. Accepted
  (a question is normally the final text; the asker's own conventions fix it), and
  pinned by a unit test.
- Split into paragraphs (blank lines). **Question candidate = last non-empty
  paragraph, trimmed.** Return `null` unless it ends with `?`.
- Option scan over **all** paragraphs of the message (not just the last):
  - `Approach A:` / `Option B:` / `Plan C:`-style: a short word, space, single letter,
    `:` → chip label = `"Approach A"`, description = the rest of the paragraph.
  - `A)` / `A.` / `A:` lines → chip label = `"A"`, description = the rest of the line.
  - `- ` bullets → chip label = the bullet text (trimmed), no description.
  - Chips only when **2–4** options are found (1 is not a choice; cap 4 matches the
    rpiv canonical constraint). More than 4 → keep the first 4.
- Question text for the card = the question candidate (the last paragraph). The
  "Approach A/B/C" case therefore yields the trailing "Does A sound right…?" as the
  question with three chips — exactly the reported scenario.

## 5. Extension wiring — `pi/extensions/waveterm-ask.ts` (extend the mirror)

Module state: `lastAssistantText: string | null`, `turnUsedAskTool: boolean`,
`proseCardLive: boolean`. All best-effort (`pi.exec` catch → no-op), mirroring the
existing mirror handlers; nothing runs without `WAVETERM_BLOCKID` (bare pi keeps today's
behavior).

- `message_end`: `event.message.role === "assistant"` → extract text blocks → store as
  `lastAssistantText`. (Finalized message; `message_end` fires for all roles — filter.)
- `tool_call` (existing handler): also set `turnUsedAskTool = true` when
  `toolName === "ask_user_question"`.
- `agent_settled`: if `turnUsedAskTool` → reset state, return. Else
  `detectProseQuestion(lastAssistantText)` → on hit, build the payload
  (`buildAskPayload`, existing) → `pi.exec(wshPath, ["ask", "--prose",
  "--questions-json", payload])` fire-and-forget; set `proseCardLive = true`. Reset
  `lastAssistantText`.
- `agent_start`: if `proseCardLive` → `pi.exec(wshPath, ["ask", "--clear"])`
  (best-effort); reset `proseCardLive` and `turnUsedAskTool`. Unconditional-clear is
  avoided so a stale clear can never race a tool ask; the flag makes the clear exact.
- `session_shutdown`: reset all state; clear a live prose card (best-effort).

Event-order safety: `agent_settled` fires after the final `message_end` of the run, so
`lastAssistantText` holds the final assistant message. If it is somehow null at settle
(ordering surprise), detection simply returns null — no card.

## 6. wshrpc + CLI — the `prose` flag

- `pkg/wshrpc/wshrpctypes_ask.go`: `CommandAskData` + `Prose bool json:"prose,omitempty"`.
- `pkg/agentask` registry: `PendingAsk` + `Prose bool`.
- `pkg/baseds/baseds.go` `AgentAskData` + `Prose bool json:"prose,omitempty"` (flows to
  regenerated `AgentAskData.prose` in `gotypes.d.ts`).
- `pkg/wshrpc/wshserver/wshserver_ask.go` `AskCommand`: thread `data.Prose` into both
  the registry entry and the published event. Wait mode untouched (prose never waits).
- `cmd/wsh/cmd/wshcmd-ask.go`: `--prose` flag → `data.Prose` (stdin/`--questions-json`
  behavior unchanged).
- `task generate` (wshrpc domain change → regenerated `wshclientapi.ts`,
  `gotypes.d.ts`, `wshclient.go`).

## 7. Delivery — `pkg/agentask` prose branch

`DeliverAnswer` order after `Claim` succeeds: waiter resolve (unchanged, miss for
prose) → **if `pending.Prose` → `deliverProseAnswer`** → else existing `EncodeAnswer`
keystroke path (CC regression-guarded).

`deliverProseAnswer(pending, answers)`:

- Validate: exactly one question, exactly one answer item, no multiSelect (prose never
  sets it).
- Resolve text: `answers[0].Text` if non-empty; else exactly one `SelectedIndexes[0]`
  → `pending.Questions[0].Options[idx].Label` (defensive: the Gatekeeper actuator may
  send indexes); else error.
- `validateFreeText` (reuse — rejects empty + control chars; no length cap, matching
  the existing free-text path).
- New `proseTextKeys(text)` in `encode.go` = `typeBytes(text)` + `[enter]` — **no
  arrows** (there is no picker; `freeTextKeys`'s arrow prefix would type garbage into
  the terminal). Each write spaced by the existing `KeystrokeDelay`, sent via the
  existing `sendInput` seam (test-indirectable). Claim/restore error semantics
  unchanged: encode failure restores the pending ask, mid-inject failure drops it.

No FE delivery changes: `AnswerAgentCommand` already accepts `{text}` answers and
`DeliverAnswer` already owns claim/idempotence.

## 8. Frontend

- `frontend/app/view/agents/agentsviewmodel.ts` `withAsk`: map
  `prose: ask.prose` onto the VM's ask (new `AgentAskVM.prose?: boolean`).
- `buildAskAnswers(qs, sel, txt, prose)` (`agentsviewmodel.ts:608`): prose branch —
  typed text wins (`{text}`); else the single selected chip → `{text:
  q.options[oi].label}` (never `selectedindexes` — the backend would mis-read them as
  picker arrows). Signature gains the flag; call site `agents.tsx` `submitAnswer`
  passes `agent.ask.prose`.
- `answerbar.tsx`: **no changes** — chips, the free-text input, single-select
  submit-on-click, and the sent confirmation already exist. `canSubmitAsk` unchanged
  (text or selection present → submittable).

## 9. Lifecycle & edge cases

| Case | Behavior |
|---|---|
| Mid-turn question (agent keeps working) | no card — detection runs only at `agent_settled`, on the final message |
| Question asked via the tool | AUQ guard skips prose projection; existing mirror path owns it |
| User answers via card | chip/text → injected text+Enter → pi starts a turn → `agent_start` clears the card |
| User answers in the terminal instead | same — the next `agent_start` clears the stale card |
| Card ignored | stays until the next turn starts (the agent's next message ends it); roster keeps showing `asking` — that is the attention feature |
| Dismiss (✕) | existing `AgentAskClearCommand` path, unchanged |
| Stale card after pi restart / session switch | `session_shutdown` clear + `agent_start` clear of the new session |
| Gatekeeper auto-answer | calls `DeliverAnswer` directly → prose branch handles it; index-based answers resolved to labels |
| Auto-close (agent-tab retention) interplay | none: a prose-asking agent has **not exited** (it is waiting); the card lives in the block's ask registry and dies with the block |

## 10. Out of scope

- Claude Code prose questions (would need a Go Stop-hook classifier in
  `wshcmd-agenthook.go` — second harness; CC is trained to AUQ, so rarer).
- Looser detection: question-word heuristics, implicit asks ("let me know if…"),
  yes/no turns without `?`.
- Inline option parsing ("A or B" inside one paragraph), numbered lists, option
  counts > 4.
- A "re-ask" affordance after dismissal.
- Any change to the CC keystroke path or the rpiv questionnaire.

## 11. Testing

- TS (vitest, beside source — house pattern): `pi/extensions/waveterm-prose-core.test.ts`
  — question/no-question; trailing code fence → null (v1 limitation pinned); multi-paragraph (candidate = last
  paragraph); `Approach A:` headers → label+description chips; `A)`/`A.` lists;
  bullets; 1 option → no chips; >4 → first 4; mid-text `?` → null.
- Go: `pkg/agentask/deliver_test.go` — prose text answer → `typeBytes`+Enter only (no
  arrows, captured via the `sendInput` seam); chip label resolution from indexes;
  empty/control-char text rejected; multi-select rejected; waiter path untouched;
  non-prose falls through to `EncodeAnswer` (CC regression guard).
- FE: `agentsviewmodel.test.ts` — `buildAskAnswers` prose (chip → `{text: label}`,
  typed wins, prose flag off → `selectedindexes` unchanged).
- Provisioning: `task sync:piartifacts` regenerates `cmd/wsh/cmd/pi-ask-extension.ts`
  + new `pi-prose-core-extension.ts`; `wsh install-agent-hooks` idempotent rewrite
  installs the new core file.
- Live round-trip (`task dev` + a pi session in a Wave block): end a turn with "Does A
  sound right, or do you want B/C?" (with `Approach A:`-style paragraphs) → card with
  three chips + text input in the cockpit → click a chip → pi receives the answer as
  the next user message, card clears; a no-question turn produces no card; an
  `ask_user_question` turn produces exactly one card.

## 12. Sequencing

1. Classifier core (`waveterm-prose-core.ts`) + vitest (pure, no deps).
2. Backend plumbing: `CommandAskData.Prose` + `PendingAsk.Prose` + `AgentAskData.Prose`
   + `AskCommand` + `wsh ask --prose` + `task generate`.
3. Delivery: `proseTextKeys` + `deliverProseAnswer` + Go tests.
4. FE: `AgentAskVM.prose` + `buildAskAnswers(..., prose)` + tests.
5. Extension wiring (`waveterm-ask.ts`) + provisioning (Taskfile sync:piartifacts,
   `installPiAskExtension`, `pi/package.json`) + sync.
6. Live verification; fold into one commit per AGENTS.md (explicit user approval).
