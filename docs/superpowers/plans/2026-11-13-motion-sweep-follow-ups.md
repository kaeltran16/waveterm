# Motion sweep follow-ups Implementation Plan

**Goal:** Close chunks 1-6 of the "Motion sweep follow-ups" initiative: one view-fade wrapper, error strips that keep
their text while collapsing, two nudge gating fixes, the brainstorm phase dot and answered count, the Waiting
region's freshness mark, and scenario steps for the sweep's unasserted moments.

**Architecture:** Frontend-only (React 19 + motion/react + jotai). Shared motion pieces live in
`frontend/app/element/` (`viewswap.tsx`, `motionhooks.ts`, `motiontokens.ts`); every behaviour is proven by a step in
a CDP scenario under `scripts/cdp/`, run by the Final line against the live app.

**Tech Stack:** TypeScript, React 19, motion/react, jotai, vitest, CDP scenarios (node).

**Effort:** effort:b53dbcba-da9b-427d-8b4c-c8d2a1fb9693
**Spec:** `docs/superpowers/specs/2026-11-13-motion-sweep-follow-ups-design.md` (every decision and its why)
**Verify:** `node scripts/verify.mjs ./pkg/agentask`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs motion-peeks motion-brief motion-run-sheet motion-dag-peek motion-brief-controls motion-lens motion-agent motion-diff motion-code jarvis-motion motion-brainstorm brainstorm-check-review motion-final project-overview`

## Global Constraints

- Follow `docs/reference/motion-system.md` and `DESIGN.md`. Motion values come from `motiontokens.ts`; never inline a
  duration, ease or keyframe.
- A component that branches on reduced motion reads `atoms.prefersReducedMotionAtom`, never motion's
  `useReducedMotion`.
- No new design tokens. Comments say why, lower case, only where needed.
- Scenario steps sample in-page the way the file's existing steps do (a MutationObserver for the style a node mounts
  with, a frame loop for the motion), and each step's text says what it asserts.
- A scenario step that finds its moment not playing is a defect. Edit only the files on your task's Files lines: fix
  the cause there when it lies there; when it lies in any other file (a shared `frontend/app/element/` primitive such as
  PaneReveal or AutoHeight, or another view), leave the step failing with what it saw and name the file and cause in
  your report, so the lead routes the fix. Never weaken a step to pass.
- Lint/format only the files you touched: `npx eslint <paths>`, `npx prettier --check <paths>` (not on
  `scripts/*.mjs`).

## Review Focus

- Reduced motion on every former ViewSwap site (Diff history/compare/storage, Brief behind/peek/sheet): a swap must
  land at opacity 1 with no frame between (Task 1's motion-brief step).
- A former ViewFade/PeekFade site under an `AnimatePresence initial={false}` must still fade its later views now that
  the merged wrapper clears that context (Task 1's motion-peeks/motion-code steps keep passing).
- A second error after the first cleared must draw the new text, not the held one (Task 2's hook test).
- A Retry that succeeds followed by a failure later must mount the panel settled, while a Retry that fails still
  nudges (Task 3's motion-diff steps).
- The brainstorm answered line at "none for you" and at "all answered" reads the same prose as today, with no TickNumber (Task 4's model test and its all-answered scenario step).

---

### Task 1: One view-fade wrapper
**Depends on:** none
**Chunk:** Merge the four after-mount view-fade wrappers into one (ViewSwap, ViewFade, brainstormui ViewSwap, PeekFade)
**Files:** `frontend/app/element/viewswap.tsx`, `frontend/app/element/viewfade.tsx`, `frontend/app/view/jarvis/peek/peekfade.tsx`, `frontend/app/view/agents/brainstormui.tsx`, `frontend/app/view/agents/brainstormcheck.tsx`, `frontend/app/view/agents/brainstormreview.tsx`, `frontend/app/view/agents/canvaspane.tsx`, `frontend/app/view/agents/docreviewdialog.tsx`, `frontend/app/view/agents/projectbranches.tsx`, `frontend/app/view/agents/projecthistory.tsx`, `frontend/app/view/agents/workflowlensview.tsx`
**Files:** `frontend/app/view/code/codepeekcard.tsx`, `frontend/app/view/code/codesearchpane.tsx`, `frontend/app/view/code/codesymbolspane.tsx`, `frontend/app/view/jarvis/peek/peekagent.tsx`, `frontend/app/view/jarvis/peek/peekeffort.tsx`, `frontend/app/view/jarvis/peek/peekrun.tsx`, `frontend/app/view/jarvis/peekitem.tsx`, `docs/reference/motion-system.md`, `scripts/cdp/scenarios-motion-peeks.mjs`, `scripts/cdp/scenarios-motion-lens.mjs`, `scripts/cdp/scenarios-motion-code.mjs`, `scripts/cdp/scenarios-motion-brief.mjs`

Spec section 1. Produces (Task 4 relies on it): `export function ViewSwap({ swapKey, className, children }: { swapKey: string; className?: string; children: ReactNode })` in `frontend/app/element/viewswap.tsx`, rendering `data-view-swap={swapKey}`.

- Rewrite `viewswap.tsx`: read `atoms.prefersReducedMotionAtom`; `initial={mounted.current && !reduce ? "initial" : false}`; keep the `PresenceContext.Provider` that clears `initial`; drop the `MotionConfig` wrapper; return null for `children == null || children === false`. Update its header comment.
- Move every `ViewFade` (`fadeKey` -> `swapKey`) and `PeekFade` call site to it; PeekFade sites that passed no key pass `swapKey="shown"`. Delete brainstormui.tsx's `ViewSwap` and its now-unused imports; brainstormcheck.tsx and brainstormreview.tsx import from `@/app/element/viewswap`. Leave brainstormui's `Phases` alone (Task 4 owns it).
- Grep `viewfade`, `peekfade`, `ViewFade`, `PeekFade`, `data-view-fade`, `data-peek-fade` across `frontend/`, `scripts/` and `docs/reference/` (type imports and re-exports included), then delete `viewfade.tsx` and `peekfade.tsx`. Zero matches must remain in those three trees (this run's own spec and plan under `docs/superpowers/` name them on purpose and stay as they are).
- Scenarios: motion-code, motion-lens and motion-peeks select `data-view-swap` instead; scope a selector by its container wherever a bare `[data-view-swap]` now matches more nodes than the old attribute did (peekitem's body vs its sections in motion-peeks).
- motion-system.md: the primitives table keeps one row for `ViewSwap` (keyed fade, first view settled, clears an ancestor presence's `initial: false`, skips the fade under reduced motion) and drops the viewfade.tsx row; the Guardrails line about `ViewSwap` says it also skips under reduced motion; add a Guardrails line: "An error strip that collapses on its exit draws `useLastShown(error)` (`motionhooks.ts`), not the live error, which is already null when the exit plays." (Task 2 adds that hook in this run.)
- Add a motion-brief step: under emulated `prefers-reduced-motion: reduce`, a Brief view swap (the band's or behind list's `data-view-swap` key change the scenario already drives) mounts at opacity 1 with no frame below 1; restore the emulation after.
- Acceptance: `task check:ts` clean; motion-peeks, motion-lens, motion-code, motion-brief, motion-diff and motion-brainstorm pass in the live dev app (`node scripts/cdp/final-verify.mjs motion-peeks motion-lens motion-code motion-brief motion-diff motion-brainstorm` with `ARC_FINAL_OUT` set to a temp dir).

### Task 2: Error strips keep their text while they collapse
**Depends on:** none
**Chunk:** Error strips go blank during their exit because children read the already-cleared error
**Files:** `frontend/app/element/motionhooks.ts`, `frontend/app/element/motionhooks.test.ts`, `frontend/app/view/jarvis/briefsheet.tsx`, `frontend/app/view/orchestrate/dagtaskpeek.tsx`, `frontend/app/view/jarvis/briefrunsheet.tsx`, `frontend/app/view/jarvis/effortcreateform.tsx`, `frontend/app/view/jarvis/newruncontrol.tsx`, `scripts/cdp/scenarios-motion-dag-peek.mjs`, `scripts/cdp/scenarios-motion-run-sheet.mjs`, `scripts/cdp/scenarios-motion-brief-controls.mjs`

Spec section 2. Produces: `export function useLastShown<T>(value: T | null | undefined): T | null` in `motionhooks.ts` (a ref: returns `value` when non-null, else the last non-null value seen, null before any).

- Test first. The repo has no renderHook harness, and `motionhooks.test.ts` exists (it tests the pure helpers `nextChangeFlash`/`initialChangeFlashState`). Follow that pattern: export a pure helper `nextLastShown<T>(held: T | null, value: T | null | undefined): T | null` beside `useChangeFlash`, which the hook calls, and append its tests to the existing `motionhooks.test.ts` with Edit (never Write, which would replace the file): null before any value; returns the live value; holds the last value after null/undefined; a second, different value replaces the held one. Run `npx vitest run frontend/app/element/motionhooks.test.ts`: the new tests fail before the helper exists, pass after, and the existing ones still pass.
- Apply it: briefsheet.tsx (replace the inline `lastError`/`shownError`), dagtaskpeek.tsx `actionError`, briefrunsheet.tsx `error`, effortcreateform.tsx `titleError` and save `error`. `PaneReveal open` stays on the live value; only the drawn text reads the hook.
- newruncontrol.tsx footer: the error span draws `useLastShown(error)` and exits: `exit="exit"` with a module-level `const` of `{ ...errorNudge, exit: microFade.exit }`. Do not add `exit` to `errorNudge` in motiontokens.ts (PaneReveal's `exit` label would reach every nudged strip).
- Scenario steps, one per site, each asserting the strip's text is non-empty on every sampled frame of its exit until it detaches: motion-dag-peek (a refused retry's alert, then a successful action clears it), motion-run-sheet (briefrunsheet's save error, then a save that lands), motion-brief-controls (new initiative title error cleared by typing a title; save error cleared by a retry; New run footer error cleared, fading out while attached).
- Acceptance: vitest test above passes; `task check:ts` clean; motion-dag-peek, motion-run-sheet, motion-brief-controls pass in the live dev app.

### Task 3: Nudge gating edges
**Depends on:** none
**Chunk:** Nudge gating edges: a stale Retry flag in gitstatepanels, an armed failed-note nudge in finalstagepane
**Files:** `frontend/app/view/agents/gitstatepanels.tsx`, `frontend/app/view/agents/filessurface.tsx`, `frontend/app/view/agents/finalstagepane.tsx`, `scripts/cdp/scenarios-motion-diff.mjs`, `scripts/cdp/scenarios-motion-final.mjs`

Spec section 3.

- gitstatepanels.tsx exports a function that clears the module-level `retryPending` one-shot (update the comment above the flag: the next read outcome spends it); filessurface.tsx calls it when a git read lands without a failure. Find where filessurface learns a read succeeded; call it there once per landed read, not per render.
- finalstagepane.tsx: when the stage turns failed and `body !== "outcome"` on that render, set `stage.note` to null (rerun flag still clears as today).
- motion-diff steps: (a) Retry -> the read succeeds -> a later stubbed failure mounts the failure panel at opacity 1 with no headline x motion; (b) Retry -> the read fails -> the panel still enters as a card and nudges (guards the existing behaviour).
- motion-final step: with a kept output open, the stage turns failed after a rerun; closing the kept output shows the note with no x motion (`moved === 0`).
- Acceptance: `task check:ts` clean; motion-diff and motion-final pass in the live dev app.

### Task 4: Brainstorm phase dot and answered count
**Depends on:** Task 1
**Chunk:** Brainstorm: the phase dot's layoutId never travels; the 'answered' count was not addressed
**Files:** `frontend/app/view/agents/brainstormui.tsx`, `frontend/app/view/agents/brainstormreview.tsx`, `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `scripts/cdp/scenarios-motion-brainstorm.mjs`, `scripts/cdp/scenarios-brainstorm-review.mjs`

Spec section 4.

- First confirm the phase changes only across a pane remount: trace what renders `Phases` (brainstormui.tsx) for design, check and run, and whether any path re-renders a mounted toolbar with a new current phase. If none, remove `layoutId={`brainstorm-phase:${topic}`}` and `transition={indicatorSlide}` (and the `indicatorSlide` import if unused; the token stays). If one exists, keep it and add a motion-brainstorm step that moves the dot on that path. Say which in the report.
- Answered count: today `answeredLine` (brainstormmodel.ts) prints the answered number only in the partial branch, `0 < answered < forYou` ("3 for you, 1 answered"); `forYou === 0` prints "none for you" and `answered === forYou` prints "N for you, all answered", which hold no answered number. Only the partial branch renders the answered number through `TickNumber` (value = answered) inside `data-brainstorm-answered-line`; the other branches render today's prose unchanged. Change `answeredLine` to return the prose around that number (shape is yours; grep every caller and test). Model tests: the full text for `forYou === 0`, `answered < forYou`, `answered === forYou`, each with and without `calls`, reads exactly as today's strings, and the partial case exposes the answered number separately. If you find the rail cannot be mounted while the count changes, leave it static and explain in the report.
- Scenario (scenarios-brainstorm-review.mjs, brainstorm-check-review): in its existing all-answered fixture assert the answered line's text is unchanged and holds no TickNumber; add a partial-state fixture (the builder check asks 3 questions for you and 1 is answered) and assert the line holds a TickNumber whose value === 1 and the line reads "3 for you, 1 answered".
- Acceptance: `npx vitest run frontend/app/view/agents/brainstormmodel.test.ts` passes; `task check:ts` clean; motion-brainstorm and brainstorm-check-review pass in the live dev app.

### Task 5: The Waiting region's freshness mark
**Depends on:** none
**Chunk:** Restore the Waiting region's freshness mark (dropped in 168e1db72, spec 2026-09-11 section 2)
**Files:** `frontend/app/view/jarvis/briefsurface.tsx`, `frontend/app/view/jarvis/briefwaiting.tsx`, `frontend/app/view/jarvis/briefrowviews.tsx`, `frontend/app/view/jarvis/briefprimitives.tsx`, `scripts/cdp/scenarios-brief.mjs`

Spec section 5. Read `git show d11601550` first and mirror it.

- briefsurface.tsx: `freshWaiting` via `freshKeys` over the waiting queue's row keys, memoized like `freshInitiatives`/`freshSessions`; pass it through briefwaiting.tsx; `WaitingRow` takes `fresh: boolean` and adds `fresh-mark` as `SessionRow` does.
- jarvis-motion step 2: assert the queue region has at least one row with `fresh-mark` and only rows newer than the visit cursor carry it (extend the fixture's waiting items if none is newer). Step 3's per-region cap must then read a non-zero queue count before the cap applies.
- Acceptance: `npx vitest run frontend/app/view/jarvis/freshrows.test.ts` passes; `task check:ts` clean; jarvis-motion passes in the live dev app.

### Task 6: motion-diff steps
**Depends on:** Task 3
**Chunk:** Scenario steps for the sweep's moments no scenario asserts
**Files:** `scripts/cdp/scenarios-motion-diff.mjs`

Spec section 6: steps for compare loading -> rows, appendState, the foldedCount and comment-count ticks, Clear, and stderr. Each step names the moment and asserts it plays (and lands settled). Acceptance: motion-diff passes in the live dev app.

### Task 7: motion-dag-peek steps
**Depends on:** Task 2
**Chunk:** Scenario steps for the sweep's moments no scenario asserts
**Files:** `scripts/cdp/scenarios-motion-dag-peek.mjs`

Spec section 6: the more-toggle microFade, the verify tail's PaneReveal, the clamped note's AutoHeight, the endError and cancelError nudges. Acceptance: motion-dag-peek passes in the live dev app.

### Task 8: motion-brief-controls steps
**Depends on:** Task 2
**Chunk:** Scenario steps for the sweep's moments no scenario asserts
**Files:** `scripts/cdp/scenarios-motion-brief-controls.mjs`

Spec section 6: the start-error and save-error nudges, briefprofile's Save, the Approvals note, the Starting and Creating CrossFades. Acceptance: motion-brief-controls passes in the live dev app.

### Task 9: motion-lens steps
**Depends on:** Task 1
**Chunk:** Scenario steps for the sweep's moments no scenario asserts
**Files:** `scripts/cdp/scenarios-motion-lens.mjs`

Spec section 6: the filed toggle, busy labels, start/send-error nudges, the board-actions reveal, the server-down fade, the quoting field, the notes-list collapse, the comment bar. Acceptance: motion-lens passes in the live dev app.

### Task 10: motion-agent steps
**Depends on:** none
**Chunk:** Scenario steps for the sweep's moments no scenario asserts
**Files:** `scripts/cdp/scenarios-motion-agent.mjs`

Spec section 6: the find bar reveal, Show earlier turns, the plan preview. Acceptance: motion-agent passes in the live dev app.

### Task 11: motion-code history steps
**Depends on:** Task 1
**Chunk:** Scenario steps for the sweep's moments no scenario asserts
**Files:** `scripts/cdp/scenarios-motion-code.mjs`, `scripts/cdp/project-overview-history.mjs`

Spec section 6: export the run and roster stubs from project-overview-history.mjs (`installRuns`, `restoreRuns`, `setMockRoster`, `restoreMockRoster` and whatever they need), without changing its own steps' behaviour; add a motion-code step that opens a session's runs under it in the Overview History and asserts the nested rows reveal through PaneReveal (height from 0, opacity to 1, settled), restoring the stubs after. Acceptance: motion-code and project-overview (the scenario that runs project-overview-history's steps) pass in the live dev app.
