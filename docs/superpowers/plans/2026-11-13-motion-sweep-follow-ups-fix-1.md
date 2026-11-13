# Motion sweep follow-ups: fix round 1

**Goal:** Make the failed Final step pass (brainstorm-check-review step 3, `entered: false`), and close the one
in-goal gap a worker found: two error strips that still collapse blank.

**Architecture:** Frontend and CDP scenarios only. The run's plan and spec still hold:
`docs/superpowers/plans/2026-11-13-motion-sweep-follow-ups.md`, `docs/superpowers/specs/2026-11-13-motion-sweep-follow-ups-design.md`.

**Tech Stack:** TypeScript, React 19, motion/react, jotai, CDP scenarios (node).

**Effort:** effort:b53dbcba-da9b-427d-8b4c-c8d2a1fb9693
**Spec:** `docs/superpowers/specs/2026-11-13-motion-sweep-follow-ups-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/agentask`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs motion-peeks motion-brief motion-run-sheet motion-dag-peek motion-brief-controls motion-lens motion-agent motion-diff motion-code jarvis-motion motion-brainstorm brainstorm-check-review motion-final project-overview`

## Global Constraints

- Follow `docs/reference/motion-system.md` and `DESIGN.md`; motion values come from `motiontokens.ts`.
- Edit only the files on your task's Files line. Never weaken a step to pass: a step keeps asserting what its text
  says.
- Check UI with `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs <scenario...>`, never `task verify:ui`.
- Lint/format only the files you touched: `npx eslint <paths>`, `npx prettier --check <paths>` (not on
  `scripts/*.mjs`).

## Review Focus

- Task 1's fix must name the cause it proved (with the state it captured at the failing Enter), not a guess; a resend
  or longer wait is acceptable only when the capture shows the first key never reached the page.
- Task 2: a strip's PaneReveal `open` still follows the live error, so a cleared error collapses, and a new error
  after a cleared one shows the new text, not the held old one.

---

### Task 1: brainstorm-check-review step 3, Enter does not open the row
**Depends on:** none
**Files:** `scripts/cdp/scenarios-brainstorm-review.mjs`, `frontend/app/store/keybindings/bindings.ts`

Final round 1 failed this one step (234/235): `{"prompt":true,"clickCursor":true,"jCursor":true,"entered":false,
"y":{"row":"grain","label":"Keep the change","pressed":true,"sent":0},"jCursor2":true,"u":{...,"pressed":true}}`
(out: `%LOCALAPPDATA%/dev.arc.app/data/final-shots/7ec830b2-780c-4775-9c1d-8eeda39f76d4/1/shots.json`). So j, y and u
reached the review and only Enter did nothing. This run did not touch the review's keys; the step passed in every
earlier Final, and passed when the lead re-ran `motion-brainstorm brainstorm-check-review` alone on the merged
tree (23/23). It is order- or load-dependent: in the failed Final 11 scenarios ran before it, on a machine short of
memory.

The Enter binding is `agent:brainstorm-review-open` in `bindings.ts` (~line 1228). It refuses in three ways that j/y/u
do not: `codePeekFocused()` is true (then `codepeek:open` takes Enter), `document.activeElement` is a BUTTON (it
returns false so the button presses itself), or `reviewRow()` is null.

1. Reproduce: run the Final list's scenarios in order up to and including brainstorm-check-review, under CPU stress
   if a plain run passes (back to back in one isolated app; the scenario order is the **Final:** line above).
2. Make step 3 capture, at the Enter, `document.activeElement` (tag and data attributes), `codePeekFocusedAtom`, the
   review cursor, and whether a capture-phase keydown listener saw the Enter; put it in the step's detail so a
   future failure names its own cause.
3. Fix the proven cause where it lies: a stale `codePeekFocusedAtom` or wrong guard in `bindings.ts`, or the
   scenario leaving focus on a button or reading before the toggle renders. If the capture shows the key never
   reached the page, the step may resend it once after proving that, and must say so in its detail.
4. If no run reproduces it, land step 2's capture alone and report the runs you made (count, order, stress).

Acceptance: brainstorm-check-review passes in the full Final order; bindings.test.ts passes if `bindings.ts` changed
(`npx vitest run frontend/app/store/keybindings/bindings.test.ts`).

### Task 2: the dag end and cancel error strips keep their text while they collapse
**Depends on:** none
**Files:** `frontend/app/view/orchestrate/dagfinalpeek.tsx`, `frontend/app/view/orchestrate/daggraph-header.tsx`, `scripts/cdp/scenarios-motion-dag-peek.mjs`

Spec section 2, two sites Task 2 of the run's plan did not list (found by t-7): `dagfinalpeek.tsx` `endError` (string
or null, under `PaneReveal open={endError != null}`) and `daggraph-header.tsx` `cancelError` (string, `""` when none,
under `PaneReveal open={cancelError !== ""}`). Draw each strip's text through `useLastShown` from
`frontend/app/element/motionhooks.ts` (for `cancelError`, pass `cancelError || null`), as `dagtaskpeek.tsx` does for
`actionError`; the PaneReveal `open` stays on the live value.

In motion-dag-peek, extend steps 14 and 15 (endError, cancelError) or add steps after them: clear the error through
the UI and sample every frame until the strip detaches, asserting each attached frame shows the error text and at
least one frame is mid-collapse, the way motion-dag-peek step 4b does for `actionError`. t-7 notes that step 15 leaves
the cancelError strip showing and that clearing it via Cancel then "Keep running" did not find the second confirm
within 3s (undiagnosed); the confirm buttons end in key hints, so match by prefix (`clickConfirm` in that file). If a
strip has no UI path that clears its error, say so in the report and assert the other.

Acceptance: motion-dag-peek passes in the live dev app; Check is clean.
