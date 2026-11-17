# Fix round 1: the two agent-rendered steps the Final failed

**Effort:** effort:f283ad11-bcef-4053-b3f8-cda2e04998a2
**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\f860511c\docs\superpowers\specs\2026-11-17-rendered-midturn-and-fixes-design.md`

The Final on 8e59bd1 passed 87/89 steps. On a rerun it passed 88/89 and failed `rendered: show earlier` again.
Both failures are in `agent-rendered`, and t-9's stressed loop on the base after t-7 saw the same two:

- `rendered: show earlier` failed with `before.rows: 201`, while the step allows at most `RENDER_CAP` (200). t-7's
  `RenderedView` now always passes the timeline a tail of `<QueuedFoot>` plus the working line. With nothing waiting,
  the foot still draws an empty `<div data-queued-foot>`, so the feed's list holds one extra child. t-9 saw it fail
  in 31 of 31 runs. That makes it a regression from this run, not a flake.
- `rendered: box shape` read the placeholder `Message rendered-a-…` where `Reply to <name>` is expected, so
  `composerBox` saw `hasTranscript` false: A's entries were still empty when the step read the box. The step waits
  only for the view to mount, never for A's transcript. t-9 saw it fail in 3 of 20 warm and 7 of 11 cold stressed
  runs.

Decision (lead): an idle feed draws exactly the rows it did before this run. The queued foot adds an element only
while something waits, and the tail is `null` when there is neither a foot nor a working line. The box-shape check
waits for A's transcript to be drawn before it reads the box, because the placeholder it pins depends on the
transcript. That is the check's precondition, not a looser assertion.

### Task 1: The idle feed draws no empty queue foot, and the box-shape check waits for A's transcript
**Files:** `frontend/app/view/agents/renderedview.tsx`, `scripts/cdp/scenarios-agent-rendered.mjs`

**What to build:** in `RenderedView`, the tail carries the queued foot only while it has items, and it is `null`
when there is no foot and no working line, so the timeline's list gets no empty child. In the `rendered: box shape`
step, wait (the scenario's `wait` with its usual `WAIT_MS`) until A's transcript is drawn (its `PROMPT` text in
`RV`, as the "timeline fills" step waits) before reading the box. Leave every assertion as it is. If the placeholder
still reads `Message …` once A's transcript is drawn, that is a real defect in how the box learns it has a
transcript: fix it in `renderedview.tsx`, not in the check.

**Acceptance:**
- `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs agent-rendered agent-queued` passes every step,
  `rendered: show earlier` with `before.rows <= 200` and `rendered: box shape` with the `Reply to <name>`
  placeholder.
- Under CPU stress, using t-9's loop (`%TEMP%\t9-flake\_t9-loop.mjs`: one isolated dev app, `agent-rendered` back
  to back, a page reload before each run, busy threads started after attach), both steps pass in 10 consecutive
  runs. Report the counts.
- `agent-queued`'s steps still draw the foot and its line where they did: the foot's items and the line sit above
  the working line, which the existing `footAboveWorking` field checks.
