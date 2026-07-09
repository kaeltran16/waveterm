# Multi-question Ask Panel Answering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human answer a multi-question Claude Code `AskUserQuestion` from the Agents cockpit panel, end-to-end, with the same dual-answer semantics as single/multi-select today.

**Architecture:** The frontend already composes and gates the full multi-question payload; delivery already loops keystrokes with a per-key delay. The only blocker is the Go encoder's `len(questions) != 1` guard. This plan refactors `pkg/agentask/encode.go` into a composition — shared per-question keystroke helpers plus a new multi-question branch that walks Claude Code's tab bar (`Q1 … QN, Submit`) — leaving the two proven single-question paths byte-for-byte identical in output. The multi-question keystroke protocol is an owner-supplied hypothesis confirmed by a mandatory live drive against the running dev app.

**Tech Stack:** Go (backend, `pkg/agentask`), Go's `testing` package, Task (`task build:backend`), the Tauri dev app for live verification.

---

## File Structure

- **Modify:** `pkg/agentask/encode.go` — add `tab` const; factor `singleSelectKeys`, `sortedUniqueIndexes`, `multiToggleKeys`; add `encodeSingleQuestion` + `encodeMultiQuestion`; flip the guard.
- **Modify:** `pkg/agentask/encode_test.go` — invert `TestEncodeRejectsMultiQuestion`; add multi-question table tests; keep existing tests as regression guards.
- **Modify (final commit only):** `docs/deferred.md` — mark multi-question shipped.
- **Fold into commit:** `docs/superpowers/specs/2026-07-09-agents-multi-question-ask-design.md`, this plan.

No frontend, wire-type, registry, or hook changes. Verified: `AnswerBar` already renders per-question tabs; `AnswerAgentCommand` (`wshserver.go:2359`) has no separate count guard; `DeliverAnswer` already loops `[][]byte` with `KeystrokeDelay`.

---

## Reference: the confirmed protocol

Claude Code renders a multi-question ask as a tab bar `Q1 … QN, Submit`; each tab's highlight starts at option 0.

| Question type | Keystrokes on its tab | How the tab advances |
|---|---|---|
| Single-select | `k`×`↓` (k = chosen index), then `Enter` | `Enter` selects **and auto-advances** (no Tab) |
| Multi-select | for each chosen index (sorted, unique): `Δ`×`↓` + `Enter` (toggle) | explicit `Tab` after the toggles |

After the last question the cursor is on `Submit` → one `Enter` submits, no confirmation review. Bytes: `↓`=`{0x1b,'[','B'}`, `Enter`=`\r`, `Tab`=`\t`.

---

## Task 1: Refactor the encoder into shared helpers (no behavior change)

Pure refactor: extract helpers that reproduce the existing single-select and multi-select output byte-for-byte. The existing tests are the regression guard — they must stay green with zero edits.

**Files:**
- Modify: `pkg/agentask/encode.go`
- Test: `pkg/agentask/encode_test.go` (unchanged this task)

- [ ] **Step 1: Replace the body of `encode.go` with the refactored version**

Replace lines 31–103 (`EncodeAnswer` through `encodeMultiSelect`) with:

```go
// EncodeAnswer returns the keystrokes that drive the native picker to the given answer, one
// keystroke per element so the caller delivers them with KeystrokeDelay between each. Supports one
// question (single- or multi-select) or a multi-question batch (see encodeMultiQuestion). Returns an
// error for shapes it cannot encode; callers then fall back to answering in the terminal.
func EncodeAnswer(questions []baseds.AgentAskQuestion, answers []baseds.AgentAnswerItem) ([][]byte, error) {
	if len(questions) == 0 {
		return nil, fmt.Errorf("no questions to answer")
	}
	if len(answers) != len(questions) {
		return nil, fmt.Errorf("expected %d answers, got %d", len(questions), len(answers))
	}
	if len(questions) == 1 {
		return encodeSingleQuestion(questions[0], answers[0].SelectedIndexes)
	}
	return encodeMultiQuestion(questions, answers)
}

// encodeSingleQuestion drives a standalone one-question picker: single-select confirms + closes on
// enter; multi-select uses its inline Submit row + review. Output is unchanged from the original.
func encodeSingleQuestion(q baseds.AgentAskQuestion, sel []int) ([][]byte, error) {
	if q.MultiSelect {
		return encodeMultiSelect(q, sel)
	}
	if len(sel) != 1 {
		return nil, fmt.Errorf("single-select expects exactly one selected index, got %d", len(sel))
	}
	idx := sel[0]
	if idx < 0 || idx >= len(q.Options) {
		return nil, fmt.Errorf("selected index %d out of range (%d options)", idx, len(q.Options))
	}
	return singleSelectKeys(idx), nil
}

// singleSelectKeys moves the highlight from option 0 down to idx and presses enter.
func singleSelectKeys(idx int) [][]byte {
	keys := make([][]byte, 0, idx+1)
	for i := 0; i < idx; i++ {
		keys = append(keys, downArrow)
	}
	return append(keys, []byte{enter})
}

// sortedUniqueIndexes validates sel against nOpts and returns it ascending + de-duplicated, so a
// double-toggle can't cancel a choice.
func sortedUniqueIndexes(sel []int, nOpts int) ([]int, error) {
	if len(sel) == 0 {
		return nil, fmt.Errorf("multi-select expects at least one selected index")
	}
	idxs := append([]int(nil), sel...)
	sort.Ints(idxs)
	uniq := make([]int, 0, len(idxs))
	for _, i := range idxs {
		if i < 0 || i >= nOpts {
			return nil, fmt.Errorf("selected index %d out of range (%d options)", i, nOpts)
		}
		if len(uniq) == 0 || uniq[len(uniq)-1] != i {
			uniq = append(uniq, i)
		}
	}
	return uniq, nil
}

// multiToggleKeys moves to each selected option and toggles it (enter), stopping after the last
// toggle. It returns the final highlight index so a caller can navigate onward. Assumes the tab's
// highlight starts at option 0.
func multiToggleKeys(sel []int, nOpts int) (keys [][]byte, last int, err error) {
	uniq, err := sortedUniqueIndexes(sel, nOpts)
	if err != nil {
		return nil, 0, err
	}
	cur := 0
	for _, i := range uniq {
		for d := 0; d < i-cur; d++ {
			keys = append(keys, downArrow)
		}
		keys = append(keys, []byte{enter}) // toggle this option
		cur = i
	}
	return keys, cur, nil
}

// encodeMultiSelect drives a standalone multi-select picker: toggle each option, descend to the
// Submit row (index nOpts+1, after CC's "Type something" row), enter to open the review, enter to
// confirm. Verified live against CC v2.1.199 (2026-07-03).
func encodeMultiSelect(q baseds.AgentAskQuestion, sel []int) ([][]byte, error) {
	n := len(q.Options)
	keys, last, err := multiToggleKeys(sel, n)
	if err != nil {
		return nil, err
	}
	for d := 0; d < (n+1)-last; d++ {
		keys = append(keys, downArrow)
	}
	return append(keys, []byte{enter}, []byte{enter}), nil
}
```

- [ ] **Step 2: Run the existing tests to confirm the refactor changed nothing**

Run: `go test ./pkg/agentask/`
Expected: PASS (all existing single-select + multi-select tests still green — the refactor preserves output byte-for-byte).

---

## Task 2: Add the multi-question branch (TDD)

**Files:**
- Modify: `pkg/agentask/encode.go`
- Test: `pkg/agentask/encode_test.go`

- [ ] **Step 1: Add test helpers + the failing multi-question tests**

In `encode_test.go`, add these helpers (alongside the existing `singleSelect`/`ans`/`multiSelectQ`/`multiAns`) and tests. Also **delete `TestEncodeRejectsMultiQuestion`** (lines 128–134) — its premise (multi-question errors) is now false; the tests below replace it.

```go
func qn(nOpts int, multi bool) baseds.AgentAskQuestion {
	opts := make([]baseds.AgentAskOption, nOpts)
	for i := range opts {
		opts[i] = baseds.AgentAskOption{Label: "opt"}
	}
	return baseds.AgentAskQuestion{Question: "q", Options: opts, MultiSelect: multi}
}

func item(idxs ...int) baseds.AgentAnswerItem {
	return baseds.AgentAnswerItem{SelectedIndexes: idxs}
}

// Confirmed protocol: single-select = downs + enter (enter auto-advances); multi-select = toggle
// each choice then Tab; the run ends on the Submit tab -> one final enter, no review.
func TestEncodeMultiQuestionTwoSingleSelects(t *testing.T) {
	got, err := EncodeAnswer(
		[]baseds.AgentAskQuestion{qn(2, false), qn(2, false)},
		[]baseds.AgentAnswerItem{item(1), item(0)},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	down := []byte{0x1b, '[', 'B'}
	want := [][]byte{down, {'\r'}, {'\r'}, {'\r'}} // Q1: down,enter(advance) | Q2: enter(advance) | submit
	if !keysEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeMultiQuestionSingleThenMulti(t *testing.T) {
	got, err := EncodeAnswer(
		[]baseds.AgentAskQuestion{qn(2, false), qn(3, true)},
		[]baseds.AgentAnswerItem{item(0), item(0, 2)},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	down := []byte{0x1b, '[', 'B'}
	tabk := []byte{'\t'}
	// Q1 single idx0: enter(advance) | Q2 multi {0,2}: toggle0, down,down, toggle2, Tab | submit
	want := [][]byte{{'\r'}, {'\r'}, down, down, {'\r'}, tabk, {'\r'}}
	if !keysEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeMultiQuestionMultiThenSingle(t *testing.T) {
	got, err := EncodeAnswer(
		[]baseds.AgentAskQuestion{qn(3, true), qn(2, false)},
		[]baseds.AgentAnswerItem{item(1), item(0)},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	down := []byte{0x1b, '[', 'B'}
	tabk := []byte{'\t'}
	// Q1 multi {1}: down, toggle, Tab | Q2 single idx0: enter(advance) | submit
	want := [][]byte{down, {'\r'}, tabk, {'\r'}, {'\r'}}
	if !keysEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeMultiQuestionThreeSingleSelects(t *testing.T) {
	got, err := EncodeAnswer(
		[]baseds.AgentAskQuestion{qn(2, false), qn(2, false), qn(2, false)},
		[]baseds.AgentAnswerItem{item(0), item(1), item(0)},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	down := []byte{0x1b, '[', 'B'}
	// no Tab anywhere; N+1 = 4 enters total
	want := [][]byte{{'\r'}, down, {'\r'}, {'\r'}, {'\r'}}
	if !keysEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeMultiQuestionRejectsAnswerCountMismatch(t *testing.T) {
	_, err := EncodeAnswer(
		[]baseds.AgentAskQuestion{qn(2, false), qn(2, false)},
		[]baseds.AgentAnswerItem{item(0)},
	)
	if err == nil {
		t.Fatalf("expected error for answer/question count mismatch, got nil")
	}
}

func TestEncodeMultiQuestionRejectsOutOfRange(t *testing.T) {
	_, err := EncodeAnswer(
		[]baseds.AgentAskQuestion{qn(2, false), qn(2, false)},
		[]baseds.AgentAnswerItem{item(0), item(5)},
	)
	if err == nil {
		t.Fatalf("expected error for out-of-range index in question 2, got nil")
	}
}

func TestEncodeMultiQuestionRejectsEmptyMultiSelect(t *testing.T) {
	_, err := EncodeAnswer(
		[]baseds.AgentAskQuestion{qn(2, false), qn(3, true)},
		[]baseds.AgentAnswerItem{item(0), item()},
	)
	if err == nil {
		t.Fatalf("expected error for empty multi-select selection in a batch, got nil")
	}
}
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `go test ./pkg/agentask/ -run TestEncodeMultiQuestion -v`
Expected: FAIL — `EncodeAnswer` still returns the "panel answering supports exactly one question" error (compile passes; the assertions fail on error).

- [ ] **Step 3: Implement `encodeMultiQuestion`**

In `encode.go`, add the `tab` const near `enter` (top of file):

```go
// tab advances to the next question tab in Claude Code's multi-question AskUserQuestion picker. A
// single-select confirms + auto-advances on enter (needs no tab); a multi-select toggles on enter
// (staying on the tab) and needs an explicit tab to move on. Verified live against CC vX.Y.Z.
const tab = byte('\t')
```

Then add the function (after `encodeMultiSelect`):

```go
// encodeMultiQuestion drives Claude Code's multi-question tab bar (Q1..QN, Submit). Each tab's
// highlight starts at option 0. Single-select: downs + enter, where enter selects AND auto-advances
// to the next tab. Multi-select: toggle each choice, then tab to advance (enter only toggles). After
// the last question the cursor is on the Submit tab -> one enter submits (no review). Verified live
// against CC vX.Y.Z.
func encodeMultiQuestion(questions []baseds.AgentAskQuestion, answers []baseds.AgentAnswerItem) ([][]byte, error) {
	var keys [][]byte
	for i, q := range questions {
		sel := answers[i].SelectedIndexes
		if q.MultiSelect {
			toggles, _, err := multiToggleKeys(sel, len(q.Options))
			if err != nil {
				return nil, fmt.Errorf("question %d: %w", i, err)
			}
			keys = append(keys, toggles...)
			keys = append(keys, []byte{tab})
			continue
		}
		if len(sel) != 1 {
			return nil, fmt.Errorf("question %d: single-select expects exactly one selected index, got %d", i, len(sel))
		}
		idx := sel[0]
		if idx < 0 || idx >= len(q.Options) {
			return nil, fmt.Errorf("question %d: selected index %d out of range (%d options)", i, idx, len(q.Options))
		}
		keys = append(keys, singleSelectKeys(idx)...)
	}
	return append(keys, []byte{enter}), nil
}
```

- [ ] **Step 4: Run the full package tests to verify pass**

Run: `go test ./pkg/agentask/ -v`
Expected: PASS — all new `TestEncodeMultiQuestion*` tests pass, and every pre-existing test (single-select, standalone multi-select, single-question rejects) stays green.

---

## Task 3: Build backend and live-verify against a real agent

This is the mandatory verification. The unit tests encode the *hypothesized* protocol; this step confirms it against the running Claude Code TUI. **Do not mark the feature done or commit until every label echoes back correctly.**

**Files:** none (verification only; may edit the `vX.Y.Z` provenance comments in `encode.go` at the end).

- [ ] **Step 1: Build the backend**

Run: `task build:backend`
Expected: `wavesrv` + `wsh` rebuilt into `dist/bin/` with no errors.

- [ ] **Step 2: Launch the dev app and get a real agent to ask a multi-question `AskUserQuestion`**

Start the dev app (`tail -f /dev/null | task dev` per the headless-stdin gotcha, or a normal `task dev`). In a live agent terminal, prompt Claude Code to emit a 2–3 question ask at once, e.g.:

> Use the AskUserQuestion tool right now to ask me exactly two questions in one call: (1) header "Color", question "Pick one color", options Red / Green / Blue, single-select; (2) header "Sizes", question "Pick any sizes", options S / M / L, multiSelect. Ask only via that one tool call.

Confirm the native picker renders its tab bar and the panel `AnswerBar` shows both questions.

- [ ] **Step 3: Answer from the panel and confirm the echo**

Select answers in the panel for both questions (a single-select choice and 1–2 multi-select choices), submit, and confirm the agent proceeds having received the **exact chosen labels for both questions** (CC typically restates them). Capture a screenshot/transcript as evidence.

- [ ] **Step 4: Check the two edge cases the hypothesis did not fully pin**

  - **Trailing single-select:** with the last question single-select, confirm its `Enter` auto-advance lands on `Submit` (the final `Enter` submits cleanly). If a `Tab` is needed after the last question, apply the glue fix: in `encodeMultiQuestion`, append the advance key after every question regardless of type (move `keys = append(keys, []byte{tab})` out of the `MultiSelect` branch to after the loop body, and drop the auto-advance assumption for single-select). Re-run Task 2 tests, updating the expected sequences to include the trailing `Tab`, then re-verify.
  - **Tab byte + timing:** confirm `\t` (0x09) is the advance key and that it needs the same `KeystrokeDelay` spacing as the other keys (it does — `DeliverAnswer` already spaces every element). If the advance key differs, change the `tab` const and the affected test bytes, then re-verify.

- [ ] **Step 5: Stamp the verified version**

Replace `vX.Y.Z` in the three provenance comments (`tab` const, `encodeMultiQuestion`, and any edited comment) with the CC version you verified against (check `claude --version`). Re-run `go test ./pkg/agentask/`.
Expected: PASS.

---

## Task 4: Update deferred log and commit (awaiting approval)

**Files:**
- Modify: `docs/deferred.md`
- Commit: encoder + tests + spec + plan + deferred update

- [ ] **Step 1: Mark multi-question shipped in `docs/deferred.md`**

In the feature-triage residue section, update item 1 ("Multi-answer ask"): change "multi-QUESTION still gated" to note that multi-question panel answering shipped on 2026-07-09 via `encodeMultiQuestion`, verified live against the recorded CC version. Keep free-text ("Type something") answering listed as the remaining gap.

- [ ] **Step 2: Present the commit for approval**

Show the file list with statuses and the proposed message, then ask for approval per the git workflow. Proposed message:

```
feat(agents): multi-question ask panel answering

AskUserQuestion batches (2-4 questions) can now be answered from the
cockpit panel instead of falling back to the terminal. The frontend and
delivery loop were already multi-question capable; this lifts the Go
encoder's single-question guard and drives Claude Code's multi-question
tab bar (single-select auto-advances on enter; multi-select toggles then
tabs; one final enter submits). Verified live against CC <version>.
```

Files: `pkg/agentask/encode.go` (M), `pkg/agentask/encode_test.go` (M), `docs/deferred.md` (M), `docs/superpowers/specs/2026-07-09-agents-multi-question-ask-design.md` (A), `docs/superpowers/plans/2026-07-09-agents-multi-question-ask.md` (A).

- [ ] **Step 3: On approval, commit**

Run (after `git add` of the five files):
`git commit -F <message-file>`
Expected: one commit on `main` containing the feature, tests, and folded docs. Do not push unless asked.

---

## Fallback: standalone node-pty spike (only if the dev-app trigger in Task 3 is unreliable)

If a live agent won't reliably emit a multi-question ask, observe the protocol directly with a throwaway harness. This is observational, not a unit test.

Create `scratchpad/pty-spike/mq-harness.mjs`:

```javascript
// throwaway: observe Claude Code's multi-question AskUserQuestion picker protocol.
// run: node scratchpad/pty-spike/mq-harness.mjs   (requires: npm i node-pty in scratchpad)
import pty from "node-pty";

const p = pty.spawn("claude", [], {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd: process.cwd(),
  env: process.env,
});

// mirror raw PTY output so the tab bar + escape sequences are visible
p.onData((d) => process.stdout.write(d));

// forward your terminal keystrokes into the pty so you can drive it by hand and watch what CC echoes
process.stdin.setRawMode?.(true);
process.stdin.on("data", (d) => p.write(d.toString()));

// after CC boots, paste the multi-question prompt from Task 3 Step 2, let the picker render,
// then hand-drive: single-select = arrows + Enter (watch for auto-advance); multi-select = Enter to
// toggle + Tab to advance; confirm one Enter on Submit finalizes. Note the exact bytes that work.
console.error("[harness] type the multi-question prompt, then observe. Ctrl-C to exit.");
```

Feed it the same prompt, hand-drive the hypothesized keystrokes, and confirm (or correct) each row of the protocol table before finalizing the encoder and its tests.
