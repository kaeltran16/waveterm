# Multi-question ask — panel answering for multi-question `AskUserQuestion`

Date: 2026-07-09
Status: design approved; combined design + implementation (trivial code scope)

## Problem

The Agents cockpit lets a human answer a Claude Code `AskUserQuestion` **in place** from the
panel: `AnswerBar` renders the options, the answer is projected as keystrokes into the agent's
live TUI (dual-answer — the native terminal picker stays usable too). This works for a single
question (single-select and multi-select). A **multi-question** ask (2–4 questions in one
`AskUserQuestion` call) still falls back to the terminal: the panel can compose the answer but the
Go encoder refuses to deliver it.

The refusal is one guard: `pkg/agentask/encode.go:37`, `len(questions) != 1`.

## Goal / non-goals

- **Goal:** answer a multi-question ask from the panel, end-to-end, with the same dual-answer
  semantics as single/multi-select today.
- **Non-goal:** free-text ("Type something") answering; changing the hook, registry, wire types,
  or any frontend code; touching the two proven single-question keystroke paths.

## Current state (verified in tree)

- **Frontend is already complete.** `AnswerBar` (`answerbar.tsx:260`) maps every question to a
  selectable tab; `buildAskAnswers` emits one `AgentAnswerItem` per question; `canSubmitAsk`
  requires every question answered; `answerHint` renders "N/M answered". No FE change needed.
- **Delivery already loops.** `DeliverAnswer` (`deliver.go`) calls `EncodeAnswer` and writes each
  `[][]byte` element with `KeystrokeDelay` between writes. A longer keystroke list just works.
- **No second guard.** `AnswerAgentCommand` (`wshserver.go:2359`) delegates straight to
  `DeliverAnswer` with no question-count check. The `encode.go:37` guard is the only gate.

So the entire feature lives in **`pkg/agentask/encode.go`** and its test.

## Approach

**A — extend keystroke injection to the multi-question tab bar.** (Chosen over B: deny+reason
hook channel, which breaks dual-answer and touches the out-of-repo `~/.claude` hooks; and C:
graceful-degradation only, which doesn't deliver in-place answering.) A keeps the architecture
coherent — dual-answer preserved, Go-only, FE already done — and reuses the proven
spike → encode → TDD → live-verify pattern already used for single-select and multi-select.

## Protocol

Claude Code renders a multi-question ask as a tab bar `Q1 … QN, Submit`. The picker opens on
`Q1` with option 0 highlighted; each tab resets its highlight to option 0. Answering behaves by
question type:

| Question type | Keystrokes on its tab | How the tab advances |
|---|---|---|
| Single-select | `k`×`↓` (k = chosen index), then `Enter` | `Enter` selects **and auto-advances** |
| Multi-select | for each chosen index (sorted, unique): `Δ`×`↓` + `Enter` (toggle) | explicit `Tab` after the toggles |

After the last question the cursor is on the `Submit` tab (a trailing single-select auto-advanced
onto it; a trailing multi-select's `Tab` landed on it). The Submit tab shows a "Ready to submit your
answers?" review defaulting to "Submit answers", so one `Enter` confirms it. (Live verification
against CC v2.1.205 corrected the original hypothesis, which assumed no review — the trailing `Enter`
count is unchanged either way.)

Bytes: `↓` = `ESC[B` = `{0x1b,'[','B'}` (existing `downArrow`); `Enter` = `\r` (existing `enter`);
`Tab` = `\t` = `0x09` (new const).

This protocol is a **hypothesis** (owner-supplied) until confirmed by the verify phase below.

## Encoder design

`EncodeAnswer` becomes a composition. The two proven single-question paths are left **byte-for-byte
untouched** — they drive a different CC UI (inline Submit row + review) that is already verified.

```
EncodeAnswer(questions, answers):
    if len(questions) == 0: error
    if len(answers) != len(questions): error

    if len(questions) == 1:
        <existing single-select / encodeMultiSelect, unchanged>

    // multi-question branch
    keys = []
    for i, q in questions:
        sel = answers[i].SelectedIndexes   // validate range against q.Options; non-empty
        if q.MultiSelect:
            keys += multiWithinBatch(q, sel)   // sorted-unique toggles, NO inner submit row
            keys += [tab]                      // advance (Enter toggled, did not advance)
        else:
            if len(sel) != 1: error
            keys += singleSelectKeys(sel[0])   // k×down + enter (enter auto-advances)
    keys += [enter]                            // Submit tab -> submit, no confirm
    return keys
```

- `singleSelectKeys(idx)` = the existing single-select body (`idx`×`downArrow` then `enter`),
  factored so both branches share it.
- `multiWithinBatch(q, sel)` = the toggle walk from `encodeMultiSelect` **without** the trailing
  descent to the inner Submit row and **without** the review confirm (this picker has neither).
  Reuses the sort + de-dupe + range validation.
- Single-select emits no `Tab` (its `Enter` auto-advances). Multi-select emits `Tab`. Either way
  the run ends on `Submit`, so the loop is followed by exactly one `Enter`.

## Tests (TDD)

Table-driven, expected sequences (`↓`,`⏎`,`⇥`):

- `[single Q1→1][single Q2→0]` → `↓ ⏎ ⏎ ⏎`
- `[single Q1→0][multi Q2→{0,2}]` → `⏎ ⏎ ↓ ↓ ⏎ ⇥ ⏎`
- `[multi Q1→{1}][single Q2→0]` → `↓ ⏎ ⇥ ⏎ ⏎`
- `[single][single][single]` (3 questions) → verifies no `Tab`, N+1 Enters
- answer/question count mismatch → error
- per-question index out of range → error
- multi-select empty selection within a batch → error

Regression guards kept unchanged: the existing single-select and standalone multi-select tests.

**One existing test inverts:** `TestEncodeRejectsMultiQuestion` currently asserts multi-question
*errors*. It must become a success-path assertion (or be replaced by the table cases above).

## Verification (mandatory)

The owner-supplied protocol is a hypothesis; this package's discipline is to confirm by outcome.

1. Rebuild `wsh` + `wavesrv` (`task build:backend`), relaunch the dev app.
2. Induce a real multi-question `AskUserQuestion` (prompt the installed CC to emit a 2–4 question
   ask), answer it from the panel.
3. Confirm CC echoes back the **exact chosen labels for every question**. Record the installed CC
   version in the `EncodeAnswer` provenance comment (matching `// Verified live against CC v2.1.x`).

**Edges the verify phase must specifically check** (the hypothesis does not fully pin them):
- Does a **trailing single-select** auto-advance land on `Submit`, or is a `Tab` still needed after
  the last question when it is single-select? (If a `Tab` is needed, the fix is: always append the
  advance key after the last question regardless of type — a one-line glue change.)
- Is the tab-advance byte literally `Tab` (`0x09`), and does it need `KeystrokeDelay` spacing like
  every other key (assumed yes — same React-state race as single/multi-select)?

If the live run contradicts the hypothesis, only the glue keys move; the composition holds.

## Risks & graceful degradation

- **Protocol asserted, not yet observed.** Mitigated by the mandatory verify phase and by isolating
  the glue keys so corrections are local.
- **CC-TUI version coupling.** `EncodeAnswer` is the single CC-coupled unit; record the verified
  version in the comment, as the existing paths do.
- **Degradation intact.** Any encode error → `DeliverAnswer` returns it; the native picker is still
  on screen (dual-answer), so the human answers in the terminal. No regression to existing asks.

## Implementation (ordered)

Trivial code scope — this section is the plan; no separate writing-plans doc.

1. **Phase 0 — spike (throwaway).** Rebuild a `node-pty` harness in scratchpad; drive a live
   multi-question `AskUserQuestion` against the installed CC; confirm the protocol table and the two
   edge cases above. Record findings. (Discovery is bounded — the hypothesis is the starting point.)
2. **Phase 1 — encoder (TDD).** In `encode.go`: add `tab` const; factor `singleSelectKeys(idx)` and
   `multiWithinBatch(q, sel)` out of the existing bodies; add the `len(questions) > 1` branch; flip
   the guard to `len(answers) == len(questions)`. Write the table tests first (per the spike-confirmed
   sequences); invert `TestEncodeRejectsMultiQuestion`. `go test ./pkg/agentask/` green.
3. **Phase 2 — build + live verify.** `task build:backend`, relaunch dev, drive a real
   multi-question ask from the panel, confirm every label echoes back. Update the provenance comment
   with the verified CC version. If the run contradicts the spike, apply the glue fix and re-verify.
