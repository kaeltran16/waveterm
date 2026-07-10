# Free-text asks + shared jump-to-latest — design

Date: 2026-07-10
Status: approved (design); plan pending

Two independent Tier-A deferred-backlog gaps, batched into one spec because they share the
agents-surface context and will land as one commit. They are otherwise unrelated and **must stay
independently shippable** — Feature 1 carries a live-protocol verification risk that must not block
Feature 2.

Source: `docs/deferred.md` — "Multi-answer ask … Remaining gap: free-text answering is still not
delivered from the panel" and the "Jump-to-bottom pill" line in the feature-triage residue (that
line is stale; see Feature 2).

---

## Feature 1 — Free-text ask answering

### Problem

Claude Code's `AskUserQuestion` picker always offers a "Type something" row so the human can answer
with custom text instead of picking an option. The Wave answer panel can deliver every *select*
shape — single-select, multi-select (`encodeMultiSelect`), and multi-question batches
(`encodeMultiQuestion`) — but **cannot deliver free text**. `encode.go` only navigates *past* the
"Type something" row to reach real options; `AgentAnswerItem` has no field to carry typed text. Free
text is the one answer type the panel still can't produce, so those asks force the user into the
terminal.

### Scope (approved)

Full free-text: as the whole answer to a **single-question** ask, **and** as one or more free-text
**tabs within a multi-question batch**. Single-line text only for v1 (embedded newlines
rejected/stripped). Per question, the answer is *either* a selection *or* free text — never both
(this matches CC: choosing "Type something" replaces picking an option).

### Data model — `pkg/baseds/baseds.go`

`AgentAnswerItem` gains an optional `Text`:

```go
type AgentAnswerItem struct {
    SelectedIndexes []int  `json:"selectedindexes,omitempty"`
    Text            string `json:"text,omitempty"` // free-text answer; mutually exclusive with SelectedIndexes
}
```

Regenerate TS bindings (`task generate`) so `frontend/types/gotypes.d.ts` carries `text`.

Validation (in `EncodeAnswer` / per-question): exactly one of `Text` (non-empty) or
`SelectedIndexes` (non-empty) per question. Both empty or both set → error (caller falls back to the
terminal).

### Encoding — `pkg/agentask/encode.go`

- `encodeSingleQuestion`: if `answer.Text != ""` → `encodeFreeText(q, text)`; else the existing
  single/multi-select paths (unchanged).
- `encodeMultiQuestion`: per tab, a text answer emits free-text-tab keys; a select answer keeps
  today's keys. The trailing Submit-tab confirm is unchanged.
- New helper (shape TBD by the spike): from a tab highlighted at option 0, navigate down to the
  "Type something" row, activate it, emit the string's bytes, then submit (single-question) or
  advance (multi-question tab).

The keystroke output stays one-element-per-slice so `DeliverAnswer` keeps injecting one write per
element with `KeystrokeDelay` between (see the delivery-mechanics spike question — a typed string may
be N single-byte writes, or one bracketed-paste write).

### The gating spike (Task 1 — blocks the encoding)

The "Type something" protocol is **unverified**. Every prior answer type was proven *by outcome*
(CC echoed back exactly the intended answer) under a `node-pty` harness against a real CC version,
at the real 60ms `KeystrokeDelay`, before its encoding was trusted and frozen with a version-cited
comment (`encodeMultiSelect` — CC v2.1.199; `encodeMultiQuestion` — CC v2.1.205). Free-text clears
the same bar. The spike answers, and the encoding is written only afterward:

1. **Single-question:** does Enter on "Type something" open an inline input? After typing, does Enter
   submit directly, or is there a "Ready to submit your answers?" review that needs one more Enter
   (as multi-select does)?
2. **Multi-question tab:** how is a free-text tab filled and advanced — an explicit **Tab** (like
   multi-select), or does Enter advance? Then the Submit-tab confirm.
3. **Delivery mechanics:** char-by-char single-byte writes with `KeystrokeDelay` vs. a single
   bracketed-paste (`ESC[200~` … `ESC[201~`) write — which does CC's Ink/React input accept
   reliably without dropping or reordering characters?
4. **Escaping:** confirm plain printable ASCII/UTF-8 round-trips; reject/strip embedded `\r`/`\n`
   for v1.

Exit criterion: CC echoes back the exact typed string for a single-question ask and for a
`[select][free-text]` and `[free-text][select]` multi-question batch. The verified sequence is
encoded and frozen with a comment citing the CC version.

### Free-text protocol — VERIFIED (CC v2.1.206, 2026-07-10)

Driven by outcome under a `node-pty` + headless-xterm harness at the real 60ms `KeystrokeDelay`.
Picker layout (single question, N options): rows `0..N-1` are the options, index `N` is
`Type something.`, then a separator and `Chat about this` at `N+1`. Multi-question renders a tab bar
`←  ☐ Q1  ☐ Q2  ✔ Submit  →`; each tab's list carries the same `Type something.` at index N.

Confirmed sequence (corrects two assumptions in the original plan template):

- **Single-question free-text:** `ESC[B × N` (highlight `Type something.`) → **type the string directly**
  → one `\r` submits. There is **no "open" Enter** — pressing Enter on the *empty* `Type something.`
  row *declines the question*; you type while the row is highlighted (it becomes an inline input),
  then Enter submits. **No review gate** for a single question.
- **Multi-question free-text tab:** `ESC[B × N` → type → one `\r` **confirms the text and
  auto-advances to the next tab** — i.e. Enter, *not* Tab (Tab was the plan's guess; a free-text tab
  behaves like a single-select tab, whose Enter both confirms and advances). The trailing final `\r`
  after the last question confirms the `Ready to submit your answers?` Submit review (unchanged).
- **Delivery:** one write per character at `KeystrokeDelay`; ASCII lands intact and in order (no
  bracketed paste needed). `typeBytes` iterates runes so a multi-byte char is written atomically.
- **Escaping:** reject control characters — a literal `\t` would advance the tab bar, `\x1b` cancels,
  `\r`/`\n` submit. v1 is single-line printable text.

Verified outcomes: single-question `quokka-hex-42` echoed exactly (`You picked quokka-hex-42`);
`[select][free-text]` delivered `Zephyr` + `zzq-freetext-7`; `[free-text][select]` delivered
`aardvark-tab-3` + `Green`.

### Frontend — `frontend/app/view/agents/answerbar.tsx`

- Add an always-available "type your own answer" input per question (mirrors CC's ever-present
  "Type something"). Typing into it is mutually exclusive with option selection for that question —
  entering text clears any selected index for that question and vice-versa.
- `buildAskAnswers` emits `Text` for a question when its input is non-empty, else `SelectedIndexes`.
- `canSubmitAsk` passes when **every** question has either a selection or non-empty text.

Reuse the existing submit path (`AnswerAgentCommand` → `DeliverAnswer` → `EncodeAnswer`); no new RPC.

### Error handling

Unchanged. An unencodable shape (both/neither set, or a shape the encoder rejects) returns an error
from `EncodeAnswer`; `DeliverAnswer` propagates it and the human answers in the terminal. The
idempotent no-op on "no pending ask" is untouched.

### Tests

- `pkg/agentask/encode_test.go`: free-text single-question keystrokes; free-text tab in a
  `[select][free-text]` and `[free-text][select]` batch; the mutual-exclusion / empty-both / set-both
  validation errors.
- `frontend/app/view/agents/agentsviewmodel.test.ts`: `buildAskAnswers` emits `text`;
  `canSubmitAsk` accepts text-only and rejects a blank question.
- Live PTY verification is the spike's exit criterion (above), not a committed automated test —
  consistent with the prior answer-type work.

---

## Feature 2 — Shared jump-to-latest (follow + pill)

### Problem (corrected from deferred.md)

deferred.md lists "jump-to-bottom pill" as unbuilt. **It already ships** in the cockpit card
(`agentrow.tsx`): `scrollRef` + `stickRef` + `atBottom`, a `useLayoutEffect` that pins scroll to the
tail on new `entries`, `onNarrationScroll` → `isNearBottom(el)`, `jumpToBottom`, and the rendered
`!atBottom` button. `isNearBottom` is a pure, unit-tested helper in `agentsviewmodel.ts`.

The real gap: the *other* surfaces that stream a live `NarrationTimeline` have **neither follow nor
pill** —

- **`subagentinterior.tsx`** — live-tailing (`active`) child transcript in an `overflow-y-auto`
  scroller, with no stick-to-bottom effect. Opening a streaming child does not follow the tail.
- **`runworkercard.tsx`** — same: an `active` live feed in a `max-h-[260px]` scroller, no follow,
  no pill.

The behavior is trapped card-local. Lift it to a shared unit and give those two streaming feeds the
auto-follow they lack.

### New unit

`useStickToBottom(entries)` — a hook co-located in the agents view. Owns `scrollRef`, the `stickRef`
flag, the `useLayoutEffect` that pins to the tail when `stickRef` is set and `entries` change, an
`onScroll` handler that recomputes `atBottom` via the existing `isNearBottom`, and `jumpToBottom`.
Returns `{ scrollRef, onScroll, atBottom, jumpToBottom }`.

`<JumpToLatestPill visible onClick />` — the styled button extracted verbatim from `agentrow` (it
stops click propagation so it doesn't trigger the card's `onCursor`). Rendered inside a `relative`
parent of the scroller so it anchors to the viewport bottom and doesn't scroll with the feed.

### Consumers

- **`agentrow.tsx`** — migrate onto the hook; delete the inline copy. Pure refactor, behavior
  identical (the card keeps its exact current follow + pill).
- **`subagentinterior.tsx`** — wrap the scroller with the hook (`ref`/`onScroll`), add a `relative`
  parent, drop in the pill. **Behavior change (the fix):** a live child now follows the tail.
- **`runworkercard.tsx`** — same on the `max-h-[260px]` live feed. The collapsed history disclosure
  (`max-h-[300px]`, `active={false}`) is left as-is.
- **Channels** (`channelssurface.tsx`) — out of scope; it has its own `onTranscriptScroll` handler.

### Testing reality

`isNearBottom` is already pure + unit-tested. The hook is DOM-effect-heavy and this repo has **no
jsdom/render harness** (per CLAUDE.md), so hook correctness is verified over CDP on the live dev app
(`scripts/cdp-shot.mjs`, port 9222): open a streaming subagent interior → confirm it follows the
tail; scroll up → the pill appears; click it → it jumps back and resumes following. This is stated
explicitly rather than covered by a hollow unit test.

---

## Rollout / independence

- Feature 2 has no external-protocol risk and can land first (or in parallel). Feature 1's encoding
  is blocked on the spike; if the spike surfaces a protocol we can't reliably drive, Feature 1 can be
  deferred again without affecting Feature 2.
- Both fold into a single feature commit per the repo's git convention (spec included, no separate
  docs-only commit).

## Out of scope

- Multi-line / rich free-text (v1 is single-line).
- Free-text combined with a selection in the same question (CC treats them as exclusive).
- A jump-to-latest affordance in Channels (separate scroll model).
- Codex asks (this is the CC `AskUserQuestion` picker protocol).
