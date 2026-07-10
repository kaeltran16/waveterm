# Free-text asks + shared jump-to-latest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver free-text answers to Claude Code's "Type something" ask row (single-question and multi-question tabs), and lift the cockpit card's auto-follow + jump-to-latest pill into a shared hook applied to the streaming subagent-interior and runs-worker feeds.

**Architecture:** Two independent tracks. **Track A (jump-to-latest)** carries no external risk and lands first: extract `useStickToBottom` + `<JumpToLatestPill>` from `agentrow.tsx`, migrate the card onto it, and add it to the two surfaces that stream a live `NarrationTimeline` without following. **Track B (free-text)** is gated on a live protocol spike: the "Type something" keystroke sequence is verified by outcome under a `node-pty` harness (as every prior answer type was) before the Go encoding is written; then the data model, encoder, pure FE helpers, answer-state, and `AnswerBar` UI are extended.

**Tech Stack:** Go (`pkg/agentask`, `pkg/baseds`), React 19 + jotai + Tailwind 4 (`frontend/app/view/agents`), vitest, `go test`, `node-pty` (spike only), CDP visual verification (`scripts/cdp-shot.mjs`).

**Spec:** `docs/superpowers/specs/2026-07-10-freetext-asks-and-shared-jump-to-latest-design.md`

**Conventions for every commit in this plan:**
- Never commit without the user's approval (repo rule). Steps below say "Commit" as the natural stopping point; batch or gate per the user's instruction at execution time.
- The spec doc folds into the first feature commit — no separate docs-only commit.
- Frontend typecheck is `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` overflows on this repo; baseline is clean).
- Go tests: `go test ./pkg/agentask/`. Frontend tests: `npx vitest run <file>`.

---

## Track A — Shared jump-to-latest (do first; no external risk)

### Task A1: Extract `useStickToBottom` + `<JumpToLatestPill>`

**Files:**
- Create: `frontend/app/view/agents/sticktobottom.tsx`

Replicates the card's exact behavior (`agentrow.tsx:199-268` and the pill at `agentrow.tsx:522-534`). `isNearBottom` and `STICK_THRESHOLD_PX` already live in `agentsviewmodel.ts:128-136` — reuse them.

- [ ] **Step 1: Write the hook + pill**

Create `frontend/app/view/agents/sticktobottom.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shared stick-to-bottom behavior for streaming NarrationTimeline feeds. Extracted from agentrow.tsx
// so the subagent interior and runs worker cards get the same auto-follow + jump-to-latest pill.

import { useLayoutEffect, useRef, useState } from "react";
import { isNearBottom } from "./agentsviewmodel";

// A scroll region that sticks to the tail while the user is at the bottom, releases when they scroll
// up to read history, and re-sticks on jumpToBottom. `entries` is the dependency that triggers the
// re-pin: pass the same array the feed renders. layout-effect (not effect) so the pin lands before
// paint — otherwise a taller feed paints at the old scrollTop then snaps down a frame later.
export function useStickToBottom(entries: unknown[]) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    const [atBottom, setAtBottom] = useState(true);

    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (el && stickRef.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [entries]);

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        const near = isNearBottom(el);
        stickRef.current = near;
        setAtBottom(near);
    };

    const jumpToBottom = () => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        el.scrollTop = el.scrollHeight;
        stickRef.current = true;
        setAtBottom(true);
    };

    return { scrollRef, onScroll, atBottom, jumpToBottom };
}

// The jump-to-latest pill. Render inside a `relative` parent of the scroll region so it anchors to the
// viewport bottom and does not scroll with the feed. Stops click propagation (callers are often inside
// a clickable card).
export function JumpToLatestPill({ onClick }: { onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
            title="Jump to latest"
            className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-edge-strong bg-surface-raised px-2.5 py-1 text-[11px] font-medium text-secondary shadow-[0_10px_28px_rgba(0,0,0,0.5)] hover:border-accent hover:text-primary"
        >
            <span className="text-[12px] leading-none">↓</span> Latest
        </button>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (the new file compiles; nothing consumes it yet).

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/sticktobottom.tsx
git commit -m "feat(agents): extract shared stick-to-bottom hook + jump-to-latest pill"
```

---

### Task A2: Migrate `agentrow.tsx` onto the hook (pure refactor)

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx` (imports ~line 8-16; scroll block 199-268; pill 522-534)

Behavior must stay identical — the card keeps its exact current follow + pill.

- [ ] **Step 1: Replace the inline scroll state with the hook**

In `agentrow.tsx`, delete these inline pieces:
- `const scrollRef = useRef<HTMLDivElement>(null);` (line ~199)
- `const stickRef = useRef(true);` (line ~200)
- `const [atBottom, setAtBottom] = useState(true);` (line ~202)
- the `useLayoutEffect(() => { ... el.scrollTop = el.scrollHeight; ... }, [entries]);` narration-pin block (lines ~245-250)
- `const onNarrationScroll = () => { ... }` (lines ~251-259)
- `const jumpToBottom = () => { ... }` (lines ~260-268)

Replace them (co-located where the old state was, after `entries` is defined) with:

```tsx
const { scrollRef, onScroll, atBottom, jumpToBottom } = useStickToBottom(entries);
```

Keep `const [tasksOpen, setTasksOpen] = useState(false);` and any other unrelated state.

- [ ] **Step 2: Point the scroll container at the hook's handler**

At line ~445 change `onScroll={onNarrationScroll}` to `onScroll={onScroll}`. (`ref={scrollRef}` is unchanged.)

- [ ] **Step 3: Replace the inline pill with the component**

Replace the pill block at lines ~522-534:

```tsx
                {!atBottom ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            jumpToBottom();
                        }}
                        title="Jump to latest"
                        className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-edge-strong bg-surface-raised px-2.5 py-1 text-[11px] font-medium text-secondary shadow-[0_10px_28px_rgba(0,0,0,0.5)] hover:border-accent hover:text-primary"
                    >
                        <span className="text-[12px] leading-none">↓</span> Latest
                    </button>
                ) : null}
```

with:

```tsx
                {!atBottom ? <JumpToLatestPill onClick={jumpToBottom} /> : null}
```

- [ ] **Step 4: Fix imports**

- Add: `import { JumpToLatestPill, useStickToBottom } from "./sticktobottom";`
- Remove `isNearBottom` from the `./agentsviewmodel` import (line ~16) — it is now only used inside the hook.
- Keep `useLayoutEffect` in the React import (still used by `springSeeded`) and keep `useRef`/`useState`/`useEffect`.

- [ ] **Step 5: Typecheck + run the card's existing tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (in particular, no "isNearBottom declared but never read" and no unused-import error).

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (isNearBottom tests still green; nothing about the card changed semantically).

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/agentrow.tsx
git commit -m "refactor(agents): move cockpit card onto shared stick-to-bottom hook"
```

---

### Task A3: Apply auto-follow + pill to the subagent interior

**Files:**
- Modify: `frontend/app/view/agents/subagentinterior.tsx` (imports line 8-13; scroller line 43-51)

This is the fix: a live-tailing child currently does **not** follow the tail. The hook adds follow + pill.

- [ ] **Step 1: Import and call the hook**

Add to imports:

```tsx
import { JumpToLatestPill, useStickToBottom } from "./sticktobottom";
```

After `const entries = useAtomValue(liveEntriesByIdAtom)[streamId] ?? [];` (line 33), add:

```tsx
    const { scrollRef, onScroll, atBottom, jumpToBottom } = useStickToBottom(entries);
```

- [ ] **Step 2: Wrap the scroller with a relative parent + pill**

Replace the current body scroller (lines 43-51):

```tsx
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                {entries.length > 0 ? (
                    <NarrationTimeline entries={entries} accentLatest active />
                ) : (
                    <div className="flex h-full items-center justify-center text-[12px] text-muted">
                        Loading subagent transcript…
                    </div>
                )}
            </div>
```

with:

```tsx
            <div className="relative min-h-0 flex-1">
                <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-3 py-2">
                    {entries.length > 0 ? (
                        <NarrationTimeline entries={entries} accentLatest active />
                    ) : (
                        <div className="flex h-full items-center justify-center text-[12px] text-muted">
                            Loading subagent transcript…
                        </div>
                    )}
                </div>
                {!atBottom ? <JumpToLatestPill onClick={jumpToBottom} /> : null}
            </div>
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/subagentinterior.tsx
git commit -m "feat(agents): auto-follow + jump-to-latest in the subagent interior"
```

---

### Task A4: Apply auto-follow + pill to the runs worker card

**Files:**
- Modify: `frontend/app/view/agents/runworkercard.tsx` (imports line 11-20; live-feed block 106-111)

Only the **live** feed in `RunWorkerCard` gets follow+pill. The collapsed `PhaseHistory` disclosure (line 148+, `active={false}`) stays as-is.

- [ ] **Step 1: Import and call the hook**

Add to imports:

```tsx
import { JumpToLatestPill, useStickToBottom } from "./sticktobottom";
```

Inside `RunWorkerCard`, after `const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];` (line 33), add:

```tsx
    const { scrollRef, onScroll, atBottom, jumpToBottom } = useStickToBottom(entries);
```

- [ ] **Step 2: Wrap the live feed with a relative parent + pill**

Replace the live-feed block (lines 106-111):

```tsx
                    {/* live feed — capped so a chatty worker doesn't unbalance the rail; scrolls within */}
                    {entries.length > 0 ? (
                        <div className="sc max-h-[260px] overflow-y-auto px-3 pb-2">
                            <NarrationTimeline entries={entries} accentLatest active={working} />
                        </div>
                    ) : null}
```

with:

```tsx
                    {/* live feed — capped so a chatty worker doesn't unbalance the rail; scrolls within */}
                    {entries.length > 0 ? (
                        <div className="relative">
                            <div ref={scrollRef} onScroll={onScroll} className="sc max-h-[260px] overflow-y-auto px-3 pb-2">
                                <NarrationTimeline entries={entries} accentLatest active={working} />
                            </div>
                            {!atBottom ? <JumpToLatestPill onClick={jumpToBottom} /> : null}
                        </div>
                    ) : null}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/runworkercard.tsx
git commit -m "feat(runs): auto-follow + jump-to-latest in the live worker feed"
```

---

### Task A5: CDP visual verification (Track A)

No jsdom render harness exists; verify the DOM behavior on the live dev app.

- [ ] **Step 1: Ensure the dev app is running with a populated cockpit**

Run (per CLAUDE.md; headless `task dev` dies on stdin EOF): `tail -f /dev/null | task dev`
If no live agents, inject: `node scripts/inject-live-agents.mjs <scenario>`

- [ ] **Step 2: Verify the subagent interior**

Open a focused agent with a streaming child → open the child's interior. Confirm:
1. The feed follows the tail while new lines arrive (no manual scroll needed).
2. Scrolling up stops the follow and reveals the "↓ Latest" pill.
3. Clicking the pill jumps to the bottom and resumes following.

Capture: `node scripts/cdp-shot.mjs subagent-follow.png`

- [ ] **Step 3: Verify the runs worker card**

Open the Runs view with a running phase worker. Confirm the same three behaviors in the worker's live feed. Capture: `node scripts/cdp-shot.mjs runs-worker-follow.png`

- [ ] **Step 4: Verify no regression on the cockpit card**

On the Agents cockpit, confirm a streaming card still follows and its pill still works (unchanged from before A2).

Track A is independently shippable at this point.

---

## Track B — Free-text ask answering (gated on the spike)

### Task B1: SPIKE — verify the "Type something" keystroke protocol live

**This gates B3.** No code is committed from this task except a findings note; its output is the exact keystroke sequence the encoder must reproduce. Mirror the established method: drive a real `claude` `AskUserQuestion` picker under a `node-pty` harness, inject candidate keystrokes at the real `KeystrokeDelay` (60ms), and confirm CC **echoes back the exact typed text**. Precedent: the `encodeMultiSelect` (CC v2.1.199) and `encodeMultiQuestion` (CC v2.1.205) verifications recorded in `encode.go` and `docs/deferred.md`.

- [ ] **Step 1: Stand up the harness**

Use a throwaway script under the scratchpad dir (not committed). Spawn `claude` via `node-pty`, prompt it to call `AskUserQuestion` with (a) one single-select question, then separately (b) a two-question batch. Log the raw PTY output so you can see the picker rows and the echoed answer.

- [ ] **Step 2: Answer the questions the four ways and record the sequence**

Determine, at 60ms between single-element writes:
1. **Single-question free-text:** from highlight index 0, how many `ESC[B` reach the "Type something" row (expected: `len(options)`)? Does one `\r` open the input? After typing the string, does one `\r` submit, or is there a "Ready to submit your answers?" review needing a second `\r`?
2. **Multi-question free-text tab:** how is the tab's input opened/typed, and does the tab advance on `\t` (like multi-select) or on `\r` (like single-select)?
3. **Delivery form:** does CC's input accept the string as N single-byte writes spaced by `KeystrokeDelay`, or does it need one bracketed-paste write (`ESC[200~` … text … `ESC[201~`)?
4. **Confirm** CC echoes the exact typed string for a single-question ask and for `[select][free-text]` and `[free-text][select]` batches.

- [ ] **Step 3: Record findings**

Append a short "Free-text protocol (CC vX.Y.Z)" note to the spec's Feature 1 section with the confirmed down-count, open/submit/advance keystrokes, and delivery form. These values are the source of truth for B3.

---

### Task B2: Data model — add `Text` to `AgentAnswerItem` + regenerate bindings

**Files:**
- Modify: `pkg/baseds/baseds.go:117-119`
- Regenerated (do not hand-edit): `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Add the field**

Replace `pkg/baseds/baseds.go:115-119`:

```go
// AgentAnswerItem is one question's answer in a panel-submitted reply. SelectedIndexes
// indexes into that question's Options (MVP: exactly one for single-select).
type AgentAnswerItem struct {
    SelectedIndexes []int `json:"selectedindexes,omitempty"`
}
```

with:

```go
// AgentAnswerItem is one question's answer in a panel-submitted reply. Exactly one of Text or
// SelectedIndexes is set: SelectedIndexes indexes into that question's Options (single-select uses
// one); Text is a free-text answer delivered to Claude Code's "Type something" row.
type AgentAnswerItem struct {
    SelectedIndexes []int  `json:"selectedindexes,omitempty"`
    Text            string `json:"text,omitempty"`
}
```

- [ ] **Step 2: Regenerate TS bindings**

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts` `AgentAnswerItem` now has `text?: string`.

- [ ] **Step 3: Verify Go + TS still compile**

Run: `go build ./pkg/...`
Expected: exit 0.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add pkg/baseds/baseds.go frontend/types/gotypes.d.ts
git commit -m "feat(agentask): add Text field to AgentAnswerItem for free-text answers"
```

---

### Task B3: Go encoding — free text (single-question + multi-question tab)

**Files:**
- Modify: `pkg/agentask/encode.go`
- Test: `pkg/agentask/encode_test.go`

> The concrete keystroke values below reflect the most-likely protocol from the multi-select precedent. **Replace any that Task B1 contradicts** (the down-count is `len(options)`; the uncertain bits are: single-question submit = one `\r` vs. an extra review `\r`; multi-question free-text-tab advance = `\t` vs `\r`; delivery form = per-byte vs bracketed paste). Update both the impl and the test `want` to the B1-confirmed sequence.

- [ ] **Step 1: Write the failing tests (single-question free text)**

Add to `encode_test.go`:

```go
func freeAns(text string) []baseds.AgentAnswerItem {
    return []baseds.AgentAnswerItem{{Text: text}}
}

// Free-text single-question: descend past the N options to the "Type something" row, open it,
// type the string (one byte per element so DeliverAnswer spaces them), submit. Confirmed in the
// Task B1 spike (CC vX.Y.Z).
func TestEncodeFreeTextSingleQuestion(t *testing.T) {
    got, err := EncodeAnswer(singleSelect(2), freeAns("hi"))
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    down := []byte{0x1b, '[', 'B'}
    want := [][]byte{
        down, down,       // -> "Type something" (index len(options)=2)
        {'\r'},           // open the input
        {'h'}, {'i'},     // type the text
        {'\r'},           // submit  // ← confirm vs B1 (extra review \r?)
    }
    if !keysEqual(got, want) {
        t.Fatalf("got %v, want %v", got, want)
    }
}

func TestEncodeFreeTextRejectsBothTextAndIndexes(t *testing.T) {
    ans := []baseds.AgentAnswerItem{{Text: "x", SelectedIndexes: []int{0}}}
    if _, err := EncodeAnswer(singleSelect(2), ans); err == nil {
        t.Fatalf("expected error when both text and selectedindexes are set, got nil")
    }
}

func TestEncodeFreeTextRejectsNewline(t *testing.T) {
    if _, err := EncodeAnswer(singleSelect(2), freeAns("a\nb")); err == nil {
        t.Fatalf("expected error for embedded newline, got nil")
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./pkg/agentask/ -run TestEncodeFreeText -v`
Expected: FAIL (compile error / no free-text handling yet).

- [ ] **Step 3: Implement free-text encoding**

In `encode.go`, add helpers and thread `AgentAnswerItem` (not just `[]int`) into the per-question encoders.

Add near the other helpers:

```go
// validateFreeText rejects the shapes we can't drive: empty text, or embedded CR/LF (v1 is single
// line — a newline would submit or corrupt the picker input).
func validateFreeText(text string) error {
    if text == "" {
        return fmt.Errorf("free-text answer is empty")
    }
    for i := 0; i < len(text); i++ {
        if text[i] == '\r' || text[i] == '\n' {
            return fmt.Errorf("free-text answer must be single-line")
        }
    }
    return nil
}

// typeBytes turns a string into one keystroke-element per byte so DeliverAnswer spaces them with
// KeystrokeDelay (CC's Ink input drops characters delivered in a single tick). Task B1: if CC needs
// bracketed paste instead, return a single element wrapping ESC[200~ ... ESC[201~.
func typeBytes(s string) [][]byte {
    out := make([][]byte, 0, len(s))
    for i := 0; i < len(s); i++ {
        out = append(out, []byte{s[i]})
    }
    return out
}

// freeTextKeys drives CC's "Type something" row for a standalone single-question ask: descend past
// the nOpts options to the input row, open it, type, submit. Verified in Task B1 (CC vX.Y.Z).
func freeTextKeys(nOpts int, text string) [][]byte {
    keys := make([][]byte, 0, nOpts+len(text)+2)
    for i := 0; i < nOpts; i++ {
        keys = append(keys, downArrow) // -> "Type something" (index nOpts)
    }
    keys = append(keys, []byte{enter}) // open the input
    keys = append(keys, typeBytes(text)...)
    keys = append(keys, []byte{enter}) // submit  // ← confirm vs B1
    return keys
}
```

Change `EncodeAnswer` to pass the whole answer item:

```go
    if len(questions) == 1 {
        return encodeSingleQuestion(questions[0], answers[0])
    }
    return encodeMultiQuestion(questions, answers)
```

Change `encodeSingleQuestion` to take the item and branch on `Text`:

```go
func encodeSingleQuestion(q baseds.AgentAskQuestion, a baseds.AgentAnswerItem) ([][]byte, error) {
    if a.Text != "" {
        if len(a.SelectedIndexes) > 0 {
            return nil, fmt.Errorf("answer has both text and selected indexes")
        }
        if err := validateFreeText(a.Text); err != nil {
            return nil, err
        }
        return freeTextKeys(len(q.Options), a.Text), nil
    }
    sel := a.SelectedIndexes
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
```

- [ ] **Step 4: Run to verify single-question tests pass**

Run: `go test ./pkg/agentask/ -run TestEncodeFreeText -v`
Expected: PASS (after aligning `want` with the B1-confirmed sequence).

- [ ] **Step 5: Write the failing multi-question free-text-tab test**

Add to `encode_test.go` (the free-text tab advance keystroke is the B1-confirmed one; templated as `\t` here):

```go
// A [select][free-text] batch: Q1 single-select idx0 (enter auto-advances), Q2 free text (open,
// type, advance to Submit tab), final enter confirms. Advance keystroke confirmed in Task B1.
func TestEncodeMultiQuestionSelectThenFreeText(t *testing.T) {
    got, err := EncodeAnswer(
        []baseds.AgentAskQuestion{qn(2, false), qn(2, false)},
        []baseds.AgentAnswerItem{item(0), {Text: "hi"}},
    )
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    down := []byte{0x1b, '[', 'B'}
    tabk := []byte{'\t'}
    want := [][]byte{
        {'\r'},                  // Q1 idx0: enter (auto-advance)
        down, down, {'\r'},      // Q2: -> "Type something" (idx 2), open
        {'h'}, {'i'},            // type
        tabk,                    // advance off the free-text tab  // ← confirm vs B1 (\t vs \r)
        {'\r'},                  // Submit tab confirm
    }
    if !keysEqual(got, want) {
        t.Fatalf("got %v, want %v", got, want)
    }
}
```

- [ ] **Step 6: Run to verify it fails**

Run: `go test ./pkg/agentask/ -run TestEncodeMultiQuestionSelectThenFreeText -v`
Expected: FAIL (multi-question has no free-text branch yet).

- [ ] **Step 7: Add the free-text branch to `encodeMultiQuestion`**

In the per-question loop of `encodeMultiQuestion`, before the `MultiSelect` branch, handle text:

```go
    for i, q := range questions {
        a := answers[i]
        if a.Text != "" {
            if len(a.SelectedIndexes) > 0 {
                return nil, fmt.Errorf("question %d: answer has both text and selected indexes", i)
            }
            if err := validateFreeText(a.Text); err != nil {
                return nil, fmt.Errorf("question %d: %w", i, err)
            }
            for d := 0; d < len(q.Options); d++ {
                keys = append(keys, downArrow) // -> "Type something"
            }
            keys = append(keys, []byte{enter}) // open the input
            keys = append(keys, typeBytes(a.Text)...)
            keys = append(keys, []byte{tab}) // advance off the free-text tab  // ← confirm vs B1
            continue
        }
        sel := a.SelectedIndexes
        if q.MultiSelect {
            // ... existing multi-select branch, using `sel` ...
        }
        // ... existing single-select branch, using `sel` ...
    }
```

(Keep the existing `sel := answers[i].SelectedIndexes` usages consistent — rename to read from `a` as shown.)

- [ ] **Step 8: Run the full agentask suite**

Run: `go test ./pkg/agentask/ -v`
Expected: PASS (all prior select tests unchanged; the new free-text tests green against the B1 sequence).

- [ ] **Step 9: Freeze the protocol comment**

Update the `freeTextKeys` / multi-question comments to cite the exact CC version from B1 (matching the `encodeMultiSelect`/`encodeMultiQuestion` comment style).

- [ ] **Step 10: Commit**

```bash
git add pkg/agentask/encode.go pkg/agentask/encode_test.go
git commit -m "feat(agentask): encode free-text answers (single-question + multi-question tab)"
```

---

### Task B4: FE pure helpers — carry free text through build + submit gating

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts:577-610`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts:265+`

`texts` is an optional param so existing callers/tests keep working; a non-empty trimmed text for a question takes precedence over its selection.

- [ ] **Step 1: Write failing tests**

Add to `agentsviewmodel.test.ts` inside the `buildAskAnswers` describe (and a new `canSubmitAsk` describe if none exists):

```ts
    it("emits text over selection when a question has free text", () => {
        const questions = [q(), q()];
        const selections = { 0: new Set([1]) };
        const texts = { 1: "  custom answer " };
        expect(buildAskAnswers(questions, selections, texts)).toEqual([
            { selectedindexes: [1] },
            { text: "custom answer" }, // trimmed
        ]);
    });

    it("canSubmitAsk accepts a text-only answer and rejects a blank question", () => {
        const questions = [q(), q()];
        expect(canSubmitAsk(questions, { 0: new Set([0]) }, { 1: "typed" })).toBe(true);
        expect(canSubmitAsk(questions, { 0: new Set([0]) }, { 1: "   " })).toBe(false);
    });
```

(Use the existing `q()` test factory already defined in this file's `buildAskAnswers` describe.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: FAIL (`buildAskAnswers`/`canSubmitAsk` ignore the third arg).

- [ ] **Step 3: Extend the helpers**

Replace `buildAskAnswers` (line 578-580):

```ts
/** Pure: one AgentAnswerItem per question. A non-empty trimmed text wins over the selection and
 *  emits { text }; otherwise emits { selectedindexes } (ascending). */
export function buildAskAnswers(
    questions: AgentAskQuestion[],
    selections: Record<number, Set<number>>,
    texts: Record<number, string> = {}
): AgentAnswerItem[] {
    return questions.map((_, qi) => {
        const text = (texts[qi] ?? "").trim();
        if (text !== "") {
            return { text };
        }
        return { selectedindexes: Array.from(selections[qi] ?? []).sort((a, b) => a - b) };
    });
}
```

Replace `canSubmitAsk` (line 608-610):

```ts
/** Pure: submittable only when every question has at least one selected option or non-empty text. */
export function canSubmitAsk(
    questions: AgentAskQuestion[],
    selections: Record<number, Set<number>>,
    texts: Record<number, string> = {}
): boolean {
    return (
        questions.length > 0 &&
        questions.every((_, qi) => (selections[qi]?.size ?? 0) >= 1 || (texts[qi] ?? "").trim() !== "")
    );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (new tests green; the existing `buildAskAnswers`/`canSubmitAsk` tests still pass since `texts` defaults to `{}`).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts
git commit -m "feat(agents): thread free-text through buildAskAnswers/canSubmitAsk"
```

---

### Task B5: FE answer-state — text atom, setter, submit wiring, exclusion

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx` (the view model: near `answerSelAtom`, `submitAnswer` at 146-160, and the `toggleAnswer` method)

Add a shared `answerTextAtom` mirroring `answerSelAtom`, a setter, and route both into the exclusion + submit paths. Selecting an option clears that question's text; typing clears its selection — so the UI is never ambiguous and `buildAskAnswers`'s text-precedence never hides a stale selection.

- [ ] **Step 1: Add the text atom**

Near the `answerSelAtom` declaration (find `answerSelAtom` in `agents.tsx`), add a sibling:

```ts
    // free-text answers, keyed like answerSelAtom: agentId -> (questionIndex -> text)
    answerTextAtom = atom<Record<string, Record<number, string>>>({});
```

- [ ] **Step 2: Add the setter with mutual exclusion, and clear text on toggle**

Add a method:

```ts
    setAnswerText(agentId: string, qi: number, value: string) {
        const prev = globalStore.get(this.answerTextAtom);
        const forAgent = { ...(prev[agentId] ?? {}), [qi]: value };
        globalStore.set(this.answerTextAtom, { ...prev, [agentId]: forAgent });
        if (value.trim() !== "") {
            // typing clears any selected option for this question (exclusive)
            const sel = globalStore.get(this.answerSelAtom);
            const forSel = { ...(sel[agentId] ?? {}) };
            if (forSel[qi]?.size) {
                forSel[qi] = new Set<number>();
                globalStore.set(this.answerSelAtom, { ...sel, [agentId]: forSel });
            }
        }
    }
```

In the existing `toggleAnswer` method (the one that calls `toggleSelection`), after it writes the new selection, clear that question's text:

```ts
        // selecting an option clears this question's free text (exclusive)
        const txt = globalStore.get(this.answerTextAtom);
        if ((txt[agentId]?.[qi] ?? "") !== "") {
            const forAgent = { ...(txt[agentId] ?? {}), [qi]: "" };
            globalStore.set(this.answerTextAtom, { ...txt, [agentId]: forAgent });
        }
```

- [ ] **Step 3: Wire texts into `submitAnswer`**

In `submitAnswer` (line 146-160) read the texts and pass them to both pure helpers:

```ts
        const sel = globalStore.get(this.answerSelAtom)[agentId] ?? {};
        const txt = globalStore.get(this.answerTextAtom)[agentId] ?? {};
        const oref = agent.ask?.oref;
        if (!canSubmitAsk(qs, sel, txt) || !oref) {
            return;
        }
        fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { oref, answers: buildAskAnswers(qs, sel, txt) }));
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/agents.tsx
git commit -m "feat(agents): free-text answer state, submit wiring, selection/text exclusion"
```

---

### Task B6: FE UI — free-text input in AnswerBar, threaded through render sites

**Files:**
- Modify: `frontend/app/view/agents/answerbar.tsx` (props 183-205; `QuestionGroup` 44-178; `renderGroup` 221-242)
- Modify: `frontend/app/view/agents/agentrow.tsx` (AnswerBar render ~469-480; AgentRow props 111-171)
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (AgentRow render ~737-746)
- Modify: `frontend/app/view/agents/channelsprimitives.tsx` (AnswerBar render ~104)

- [ ] **Step 1: Add `texts`/`onText` to `AnswerBar` and a text row per question**

Extend `AnswerBar`'s props (after `selections`):

```tsx
    texts?: Record<number, string>;
    onText?: (qi: number, value: string) => void;
```

Extend `QuestionGroup`'s props with `text` and `onText`, and render an input under the options (after the options block, before the closing `</div>` of the group). Add this input markup at the end of `QuestionGroup`'s outer `<div>`:

```tsx
            {onText ? (
                <input
                    type="text"
                    value={text ?? ""}
                    onChange={(e) => onText(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    placeholder="or type your own answer…"
                    className={cn(
                        "mt-2 w-full rounded-[8px] border bg-black/20 px-3 py-2 text-[12.5px] text-primary placeholder:text-muted focus:outline-none",
                        (text ?? "").trim() !== "" ? accent.selected : "border-border focus:border-accent/60"
                    )}
                />
            ) : null}
```

Pass them through `renderGroup(qi)`:

```tsx
    const renderGroup = (qi: number) => (
        <QuestionGroup
            question={questions[qi]}
            accent={accent}
            numbered={numbered}
            hideQuestion={hideQuestion}
            selections={selections[qi] ?? new Set()}
            text={texts?.[qi]}
            onText={onText ? (value: string) => onText(qi, value) : undefined}
            onClickOption={(oi) => {
                onToggle(qi, oi);
                if (questions[qi].multiSelect) {
                    return;
                }
                // single-select: jump to the next still-unanswered question, else submit
                const next = questions.findIndex((_, j) => j !== qi && (selections[j]?.size ?? 0) === 0 && (texts?.[j] ?? "").trim() === "");
                if (next === -1) {
                    onSubmit();
                } else {
                    onSelectQuestion?.(next);
                }
            }}
        />
    );
```

(Note the `next` computation now also treats a text-answered question as answered.)

Add `text` and `onText` to `QuestionGroup`'s destructured props and prop type:

```tsx
function QuestionGroup({
    question,
    accent,
    numbered,
    hideQuestion,
    selections,
    onClickOption,
    text,
    onText,
}: {
    question: AgentAskQuestion;
    accent: Accent;
    numbered?: boolean;
    hideQuestion?: boolean;
    selections: Set<number>;
    onClickOption: (oi: number) => void;
    text?: string;
    onText?: (value: string) => void;
}) {
```

- [ ] **Step 2: Thread through `agentrow.tsx`**

Add to `AgentRow`'s destructured props and prop type (mirroring `selections`/`onToggleAnswer`):

```tsx
    texts,
    onAnswerText,
```
```tsx
    texts: Record<number, string>;
    onAnswerText: (qi: number, value: string) => void;
```

Pass them to the `<AnswerBar>` render (~469-480):

```tsx
                        texts={texts}
                        onText={onAnswerText}
```

- [ ] **Step 3: Thread through `cockpitsurface.tsx`**

At the `<AgentRow>` render (~737-746), alongside `selections={answerSel[a.id] ?? {}}` and `onToggleAnswer={(qi, oi) => toggleAnswer(a.id, qi, oi)}`, add:

```tsx
                selections={answerSel[a.id] ?? {}}
                texts={answerText[a.id] ?? {}}
                onToggleAnswer={(qi, oi) => toggleAnswer(a.id, qi, oi)}
                onAnswerText={(qi, value) => model.setAnswerText(a.id, qi, value)}
```

Read `answerText` from the atom next to where `answerSel` is read in this component (find `const answerSel = useAtomValue(model.answerSelAtom)` and add `const answerText = useAtomValue(model.answerTextAtom);`).

- [ ] **Step 4: Thread through `channelsprimitives.tsx`**

At the `<AnswerBar>` render (~104), alongside `selections={answerSel[agent.id] ?? {}}`, add `texts` + `onText`. Read `answerText` from `model.answerTextAtom` the same way the surrounding code reads `answerSel`, and wire `onText={(qi, value) => model.setAnswerText(agent.id, qi, value)}`. (If this component does not currently take single-select-only asks through `AnswerBar`, match whatever `onToggle` wiring already exists.)

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (Any AnswerBar render site missing the new optional props still compiles — `texts`/`onText` are optional; a site without them simply shows no input, which is acceptable for surfaces we're not wiring.)

- [ ] **Step 6: Run the FE agents tests**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/answerbar.tsx frontend/app/view/agents/agentrow.tsx frontend/app/view/agents/cockpitsurface.tsx frontend/app/view/agents/channelsprimitives.tsx
git commit -m "feat(agents): free-text input in the answer panel"
```

---

### Task B7: End-to-end verification (Track B)

Requires a rebuilt backend (the `AgentAnswerItem.Text` field and encoder live in `wavesrv`). Per memory, the dev status reporter routes `wsh` to the packaged Wave, so verify in a packaged build or with the dev terminal's `wsh` pointed at the dev wavesrv.

- [ ] **Step 1: Rebuild backend + run**

Run: `task build:backend`
Then run the app (`tail -f /dev/null | task dev`, or a packaged build).

- [ ] **Step 2: Answer a real single-question ask with free text**

Drive a real Claude Code agent to a single-question `AskUserQuestion`. In the cockpit card, type into "or type your own answer…" and submit. Confirm the terminal's CC picker receives the exact text and CC proceeds with it (not a wrong option).

- [ ] **Step 3: Answer a `[select][free-text]` multi-question batch**

Confirm the select tab and the free-text tab both deliver, the batch submits, and CC echoes the typed text.

- [ ] **Step 4: Confirm the terminal fallback still works**

Submit an answer shape the encoder rejects is not user-reachable (the UI enforces exclusivity), but confirm a normal select-only ask still works unchanged (no regression from the `encodeSingleQuestion` signature change).

---

## Self-review

**Spec coverage:**
- Free-text data model (`Text` on `AgentAnswerItem` + regen) → B2. ✓
- Free-text encoding, single-question + multi-question tab, spike-gated → B1, B3. ✓
- FE free-text input + `buildAskAnswers`/`canSubmitAsk` → B4, B5, B6. ✓
- Error handling / terminal fallback unchanged → B3 (validation errors propagate), B7 step 4. ✓
- Pill already ships in card; extract shared hook; apply to subagent interior + runs worker; leave channels → A1-A4. ✓
- CDP verification for the DOM-heavy hook → A5. ✓
- Independence (Track A ships without Track B) → track split; A5 notes shippable. ✓
- Out of scope (multi-line, text+selection combined, channels pill, Codex) → not implemented. ✓

**Placeholder scan:** The only deliberately-unresolved values are the free-text keystroke specifics (down-count is derived from `len(options)`; submit/advance/delivery-form are the empirical bits). These are genuinely external-protocol facts that Task B1 establishes by live outcome — B3 provides concrete template code and tests with explicit "confirm vs B1" callouts on exactly the uncertain elements. This is the honest structure for an empirically-gated wire protocol, matching how `encodeMultiSelect`/`encodeMultiQuestion` were built.

**Type consistency:** `useStickToBottom` returns `{ scrollRef, onScroll, atBottom, jumpToBottom }` — consumed identically in A2/A3/A4. `AgentAnswerItem` gains `text?` (TS) / `Text` (Go) — used as `{ text }` in `buildAskAnswers` and `a.Text` in `encode.go`. `buildAskAnswers`/`canSubmitAsk` third param is `texts` everywhere. `setAnswerText(agentId, qi, value)` / `answerTextAtom` names match across B5/B6. `encodeSingleQuestion` signature changes from `(q, sel []int)` to `(q, a AgentAnswerItem)` — updated at its only caller (`EncodeAnswer`) in B3 step 3.
