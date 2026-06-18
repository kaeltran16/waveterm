# Agents Panel — Dual-Answer Organic Ask (additive, keystroke-injection)

Date: 2026-06-18
Status: Design (validated by spike; pending review)
Related: `docs/plans/2026-06-17-agents-panel-organic-ask-hook.md` (Plan 3c, deny-based),
`docs/specs/2026-06-17-ask-human-channel-design.md`

## 1. Problem & Constraint

Plan 3c projects an agent's `AskUserQuestion` into the Agents panel via a PreToolUse
hook that returns `permissionDecision: "deny"`. `deny` does two things at once:
(a) Claude Code never runs the tool, so the **native terminal picker never renders**,
and (b) `permissionDecisionReason` carries the answer back to the model. The answer
*rides on the denial*.

The user's requirement: **the Agents panel must be purely additive.** It must not
remove or degrade the native per-tab `AskUserQuestion` behavior. A user must still be
able to open the individual terminal tab and answer there exactly as before, AND
answer the same question from the panel.

`deny` is exactly what strips the terminal picker, so the deny-based mechanism is
incompatible with this requirement and must be removed.

## 2. Goal & Non-Goals

**Goal:** an agent's `AskUserQuestion` renders natively in its own terminal tab
(unchanged behavior) and *simultaneously* appears as an interactive copy in the
Agents panel. Answering in **either** place resolves the one underlying question and
the agent continues. The card clears everywhere once answered.

**Non-goals:**
- Changing how `AskUserQuestion` looks or behaves in the terminal.
- Supporting tools other than `AskUserQuestion`.
- Reconciling genuinely-simultaneous answers from both surfaces (accepted limitation; see §7).

## 3. Key Decision: the panel is a remote keyboard, not a second answer channel

Because the hook no longer denies, the tool runs natively and the **terminal picker
becomes the single source of truth**. Once the tool is running, there is no hook
channel left to deliver an answer through. Therefore the panel answers by **injecting
keystrokes into the agent's terminal PTY** to drive the native picker — the same bytes
a human would type.

This was validated end-to-end (2026-06-18 spike): `RpcApi.ControllerInputCommand`
(→ `blockcontroller.SendInput`) writes raw bytes to a block's PTY even when the block
is unfocused, and CC's picker consumes them as keystrokes. Injecting `↓` then `Enter`
selected "Green" and the agent continued.

Consequence: there is no two-writers problem at the *answer* layer — both surfaces
feed the same native picker.

## 4. Architecture — four flows

```
                          PreToolUse hook (no deny, non-blocking)
agent calls AskUserQuestion ─┬─> wsh ask  ──> AskCommand RPC ──> registry[oref]={askId,blockId,questions}
                             │                              └─> publish agent:ask ──> panel shows interactive card
                             └─> hook exits 0 ──> CC runs AskUserQuestion ──> NATIVE PICKER renders in the tab

answer in TERMINAL:  user drives native picker  ─────────────────────────────┐
answer in PANEL:     card Submit ─> AnswerAgentCommand{oref, structured}      │
                       └─> encoder(questions, answer) -> bytes                 │
                       └─> ControllerInputCommand(blockId, bytes) -> picker ───┤
                                                                               ▼
                                                          native picker resolves, agent continues
                                                                               │
CLEAR (unified):  PostToolUse hook ─> wsh ask --clear ─> publish agent:ask{cleared} ─> registry.Drop(oref) + panel removes card
```

1. **Projection (non-blocking).** PreToolUse hook runs `wsh ask`, which registers the
   pending question and publishes `agent:ask`, then exits 0 with **no**
   `permissionDecision`. CC proceeds; the native picker renders. Fails safe: not in a
   Wave block / wsh missing / publish errors → exit 0 anyway → terminal still renders.
2. **Answer in terminal.** Unchanged native behavior.
3. **Answer in panel.** Card Submit → `AnswerAgentCommand{oref, answers}` → server looks
   up the pending record → encoder produces the keystroke byte stream → `SendInput`
   drives the native picker → agent unblocks.
4. **Clear (unified).** A new PostToolUse hook on `AskUserQuestion` runs `wsh ask --clear`,
   which publishes a cleared `agent:ask` for the ORef. Fires regardless of where the
   answer came from (both paths resolve the native picker, then PostToolUse runs).

## 5. Components

Each is a single-purpose unit. The brittle, CC-coupled logic is quarantined in one
pure function (the encoder).

### 5.1 PreToolUse hook — `docs/agents/ask-hook.js` (modified)
- **Does:** on `AskUserQuestion`, POSTs the questions to Wave (`wsh ask`) and exits 0.
  No `permissionDecision`. No blocking, no 55-min timeout.
- **Depends on:** `WAVETERM_BLOCKID`, `WAVETERM_WSHBINDIR`, the `wsh ask` command.
- **Fail-safe:** any failure → exit 0 → native terminal picker is the user's path.

### 5.2 PostToolUse hook — `docs/agents/ask-clear-hook.js` (new)
- **Does:** on `AskUserQuestion`, runs `wsh ask --clear` to remove the panel copy.
- **Depends on:** `WAVETERM_BLOCKID`, `wsh ask --clear`. Fail-safe: exit 0 (card lingers
  until superseded; see §7).

### 5.3 `wsh ask` — `cmd/wsh/cmd/wshcmd-ask.go` (modified)
- **Does:** default mode reads AUQ JSON from stdin and calls the (now non-blocking)
  `AskCommand`, exits 0. New `--clear` flag calls the clear RPC for the block's ORef.
- **Removed:** the blocking wait and `AskTimeoutMs` (no longer blocks).

### 5.4 RPC surface — `pkg/wshrpc/wshrpctypes.go` (modified; run `task generate`)
- `AskCommand(CommandAskData{oref, questions}) -> AskRtnData{askId}` — now **non-blocking**:
  register + publish, return immediately.
- `AnswerAgentCommand(CommandAnswerAgentData)` — payload changes from a flat answer
  string to **structured selections** (see §6).
- `AgentAskClearCommand(oref)` — new; drops the pending record and publishes cleared.

### 5.5 Registry — `pkg/agentask/agentask.go` (modified)
- **Was:** `map[askId]chan string` + blocking Register/Resolve.
- **Now:** `map[oref]PendingAsk{askId, blockId, questions}`. No channel. Keyed by ORef
  because an agent blocks on one `AskUserQuestion` at a time, so there is at most one
  pending organic ask per block. Methods: `Set(oref, PendingAsk)`, `Get(oref)`,
  `Drop(oref)`.

### 5.6 Answer encoder — `pkg/agentask/encode.go` (new; the isolated risky unit)
- **Does:** pure function `EncodeAnswer(questions []AgentAskQuestion, answer AgentAnswer) ([]byte, error)`
  → the exact keystroke byte stream that drives CC's native picker to the chosen
  answer(s).
- **Verified encoding (single-select):** picker starts at index 0; emit down-arrow
  `\x1b[B` × (target 0-based index), then `\r`. No number-select (footer offers only
  `↑/↓` + Enter). CC appends "Type something" (freeform) and "Chat about this" *after*
  the agent's options, so agent option indices map 1:1; freeform index =
  `len(options)`.
- **To verify during implementation (encoder-local):** multiSelect (space-toggle per
  selection, then submit), freeform (navigate to "Type something" → `\r` → type text →
  `\r`), and multi-question advance (how CC moves to the next question). These change
  only this file.
- **Why isolated:** this is the only unit coupled to CC's TUI keybindings. A CC change
  touches one pure, unit-tested function.

### 5.7 `AnswerAgentCommand` handler — `pkg/wshrpc/wshserver/wshserver.go` (modified)
- **Does:** `Get(oref)` → if absent, no-op (already answered/cleared); else
  `EncodeAnswer(...)` → `ControllerInputCommand` to `blockId`. Does **not** clear the
  card itself — the unified PostToolUse clear handles removal after the picker resolves.
- **Depends on:** registry, encoder, `blockcontroller.SendInput`.

### 5.8 Frontend (mostly unchanged)
- `askcard.tsx`: already interactive. Submit now emits **structured selections** instead
  of a formatted string.
- `agents.tsx`: answer handler sends `{oref, answers}`.
- `agentaskstore.ts`: already clears the per-ORef atom on the `cleared` event. Unchanged.

## 6. Data model (structured answer)

`AskUserQuestion` input (unchanged, from CC):
`{questions:[{question, header, multiSelect, options:[{label, description}]}]}`

New answer payload (`CommandAnswerAgentData`):
```
{
  oref: string
  answers: [            // one per question, in order
    {
      selectedIndexes: []int   // indices into that question's options
      freeformText: string     // non-empty => user chose "Type something"
    }
  ]
}
```
The server needs option *indices* (not labels) to compute navigation. The flattened
display string used today is dropped.

## 7. Edge cases & error handling

- **Not in a Wave block / wsh missing / publish fails:** hook exits 0 → native terminal
  picker is the answer path. (Graceful degradation; the panel just won't show a copy.)
- **Pending record missing on answer:** `AnswerAgentCommand` no-ops (answered in
  terminal first, or already cleared). This also guards against injecting stray bytes
  into the shell after the picker is gone.
- **Esc/cancel in terminal:** if the user dismisses the picker, PostToolUse may not fire
  → the panel card could linger. Mitigation (POC-acceptable): the card is superseded by
  the next `agent:ask`, and the status reporter flips the block out of "waiting". A
  future cleanup can clear on `Stop`/status-leaves-waiting.
- **Genuinely simultaneous answers (terminal + panel within the same instant):**
  keystrokes could interleave and mis-select. Low probability (a human answers in one
  place). Accepted POC limitation; a future soft-lock (disable the card while the
  terminal block has focus) can remove it.
- **multiSelect / freeform / multi-question:** correctness depends on the encoder; gated
  behind §5.6 verification before those paths ship.

## 8. Testing

- **Encoder (unit):** pure function — table tests mapping `(questions, answer)` → expected
  byte stream (single-select verified; multiSelect/freeform/multi-question added as each
  is verified).
- **End-to-end (runtime, CDP):** the §4 spike harness — drive a real CC agent in a Wave
  block, project to panel, answer from the panel, assert the agent receives the selection
  and the card clears. Also assert answering in the *terminal* clears the panel card.
- No reliance on tests for the TUI contract: the encoding is established by observing the
  running CC picker (it is CC-version-coupled by nature).

## 9. Removal / cleanup

- Delete the deny path from the PreToolUse hook and the blocking wait + `AskTimeoutMs`
  from `wsh ask`.
- Remove the registry's channel-based Register/Resolve/Drop blocking API.
- Update `~/.claude/settings.json`: keep the (now non-denying) PreToolUse hook, add the
  PostToolUse clear hook. Back up first.

## 10. Open questions

- Exact multiSelect/freeform/multi-question keystroke sequences (resolved by §5.6 probe).
- Whether to add the soft-lock for the simultaneous-answer edge now or defer (default: defer).
