# Motion sweep follow-ups

Initiative effort:b53dbcba-da9b-427d-8b4c-c8d2a1fb9693, chunks 1-6 (chunk 7, watching flakes, is out of scope).
Follows `docs/reference/motion-system.md` and `DESIGN.md`. Each section states a decision and why.

## 1. One after-mount view-fade wrapper

Today four components do the same thing: a keyed `motion.div` on `viewFade` whose first view lands settled and whose
later keys fade in. `element/viewswap.tsx` (`ViewSwap`, clears an ancestor presence's `initial: false`),
`element/viewfade.tsx` (`ViewFade`, skips the fade under reduced motion), brainstormui.tsx's private `ViewSwap`
(state-derived "moved" flag) and `jarvis/peek/peekfade.tsx` (`PeekFade`, returns null for empty children, default
key `"shown"`).

Decisions:

- **The survivor is `ViewSwap` in `frontend/app/element/viewswap.tsx`**, props unchanged:
  `{ swapKey: string; className?: string; children: ReactNode }`. It is the name the motion reference already
  tells new code to use, and it has the most call-site files, so the fewest call sites move.
- **Reduced motion skips the fade** (decided on the initiative 11-13): it reads `atoms.prefersReducedMotionAtom`
  as viewfade.tsx does, and mounts every view with `initial={false}` when reduced. Its `MotionConfig
  reducedMotion="user"` wrapper goes: it never stopped the opacity tween, and the atom now does.
- **It keeps clearing an ancestor presence's `initial: false`** (the `PresenceContext.Provider` with
  `initial: undefined`), so a former ViewFade/PeekFade site under an `AnimatePresence initial={false}` now fades
  its later views instead of landing them settled. That is the documented intent of all four.
- **Mount detection stays the `mounted` ref** viewswap.tsx uses (set in an effect, read when a keyed view mounts).
  Two of the four already use it; brainstormui's state-derived flag behaves the same and costs a render per swap.
- **Empty children render nothing** (PeekFade's `children == null || children === false` guard moves in): peeks
  pass a section that may be absent, and an empty keyed div would sit in the flow under AutoHeight.
- **No default key.** PeekFade's default `"shown"` becomes an explicit `swapKey="shown"` at its call sites: one
  required prop is simpler than an optional one only peeks use.
- **One data attribute, `data-view-swap={swapKey}`.** `data-view-fade` and `data-peek-fade` go with their
  components, and the scenarios that select them (motion-code, motion-lens, motion-peeks) move to `data-view-swap`,
  scoped by their container where a bare `[data-view-swap]` would now match more than before.
- viewfade.tsx and peekfade.tsx are deleted after grepping every import (frontend, scripts, docs); brainstormui's
  `ViewSwap` export is deleted and brainstormcheck.tsx/brainstormreview.tsx import the shared one.
- motion-system.md's primitives table names one wrapper (the viewfade.tsx row goes), and the Guardrails line that
  says a keyed view swap uses `ViewSwap` gains "and skips the fade under reduced motion". The Guardrails also gain
  the kept-text rule from section 2 (owned by the same task as the table, since both tasks would otherwise edit one
  file at once; section 2's task implements the hook it names).

Not in this run: `finalstagepane.tsx` (the body view swap) and `finalshotsviewer.tsx` (two swaps) inline the same
fade by hand with their own data attributes that scenarios read. The goal names four wrappers; folding these needs
`ViewSwap` to pass data attributes through, so it is recorded as a follow-up rather than widened here.

## 2. Error strips keep their text while they collapse

A strip under `PaneReveal open={error != null}` collapses on its exit, but its child reads the error state, which
is already null, so the strip shrinks blank. briefsheet.tsx solved it with a `lastError` ref.

Decisions:

- **A shared hook `useLastShown<T>(value: T | null | undefined): T | null`** in
  `frontend/app/element/motionhooks.ts`: returns `value` when it is non-null, else the last non-null value it saw
  (null before any). It is a ref, not state, so it adds no render. Six sites use it, so it is extracted per the
  goal's rule.
- Sites: briefsheet.tsx (replaces its inline `lastError`), dagtaskpeek.tsx `actionError`, briefrunsheet.tsx
  `error`, effortcreateform.tsx `titleError` and its save `error`, newruncontrol.tsx footer `error`. The
  `PaneReveal open` stays keyed on the live value; only the drawn text reads the hook.
- **newruncontrol's footer error gets an exit**: under its `AnimatePresence mode="popLayout"` the error span sets
  `exit="exit"` with variants `{ ...errorNudge, exit: microFade.exit }`, a module-level const in newruncontrol.tsx,
  so it fades out the way the summary span beside it does, drawing `useLastShown(error)`. `errorNudge` itself gets
  no `exit` key: `PaneReveal` passes the `"exit"` label down to children with variants, so a token-level exit would
  change every nudged strip in the app.

## 3. Nudge gating edges

- **gitstatepanels.tsx: the Retry one-shot is spent by the read's next outcome, failure or success.** Today only a
  failure panel's mount spends it, so a Retry that succeeds leaves it set. gitstatepanels.tsx exports a function
  that clears the flag, and filessurface.tsx (which owns the read and passes `onRetry`) calls it when a read lands
  without a failure. The flag stays module-level: lifting it into filessurface state is a larger change for the
  same behaviour, and the panels still cannot tell their own mount apart without it.
- **finalstagepane.tsx: the failed note's moment is armed only if the outcome view shows when the stage turns
  failed.** When a kept output (or running tail) is open at that render, `stage.note` is set to null, so returning
  to the outcome shows the note settled inside the body's own view fade. The rerun flag still clears as today.

## 4. Brainstorm

- **The phase dot loses its `layoutId` and `indicatorSlide`** (`brainstormui.tsx`, `Phases`), unless the worker
  finds a path where the phase changes in place on a mounted toolbar (check what keys or remounts the pane between
  design, check and run). Reported finding: the phase changes only across a pane remount, so a dot that never
  travels is dead motion code. `indicatorSlide` stays in motiontokens.ts (other surfaces use it).
- **The answered count ticks where it is shown**: `AnsweredRail`'s line renders the answered number through
  `TickNumber`. The line shows that number only in its partial branch ("3 for you, 1 answered"); "none for you" and
  "N for you, all answered" hold no answered number and keep today's prose. `answeredLine` returns a string today, so it changes to return the parts around the count (shape is
  the worker's call; update brainstormmodel.test.ts and grep every caller). If the worker finds the rail can never
  be mounted while the count changes, it leaves the prose static and says why in its report, per the goal.

## 5. The Waiting region's freshness mark

Restored the way d11601550 restored the session rows': briefsurface.tsx computes a `freshWaiting` set with
`freshKeys` over the waiting queue's keys against the same visit cursor, passes it through briefwaiting.tsx, and
`WaitingRow` (briefrowviews.tsx) takes a `fresh: boolean` prop that adds `fresh-mark` as the other rows do. The
jarvis-motion scenario's step 2 asserts the queue region carries marks for rows newer than the cursor; step 3's
per-region cap check then reads a real count for the queue.

## 6. Scenario steps for moments no scenario asserts

Each listed moment gets a step in its scenario, sampled in-page the way the existing steps are (mutation observer
for the mounted style, a frame loop for the motion):

- motion-dag-peek: the more-toggle microFade, the verify tail's PaneReveal, the clamped note's AutoHeight, and the
  endError/cancelError nudges.
- motion-brief-controls: the start-error and save-error nudges, briefprofile's Save, the Approvals note, the
  Starting/Creating CrossFades.
- motion-lens: the filed toggle, busy labels, start/send-error nudges, the board-actions reveal, the server-down
  fade, the quoting field, the notes-list collapse, the comment bar.
- motion-agent: the find bar reveal, Show earlier turns, the plan preview.
- motion-diff: compare loading -> rows, appendState, the foldedCount and comment-count ticks, Clear, stderr.
- motion-code: the Overview History's nested rows (a session's runs opening under it), with
  project-overview-history.mjs's run/roster stubs exported for it.

Sections 1-5 add their own steps in the scenario that shows each change. A step that finds its moment not playing
is a defect: the task fixes it only when the cause is in a file the task owns, and otherwise (a shared
`element/` primitive, another view) leaves the step failing with what it saw and reports the file and cause, so
concurrent tasks never edit one shared component.
