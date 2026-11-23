# Boards, better: round 1 (an edited drawing's frame fits its measured text)

**Effort:** effort:27c79c5d-a564-4361-84df-9521ea1505e6
**Spec:** `docs/superpowers/specs/2026-11-20-boards-better-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/boarddrawer ./pkg/boardstore ./pkg/wshrpc/...`
**Check:** `go build ./... && go vet ./pkg/boarddrawer ./pkg/wshrpc/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs boards-ask boards-workspace`

One defect the run left: `applyAnswer` (`frontend/app/view/boards/boardmodel.ts`, `landEdit`) refits an edited
drawing's frame to its children, and only afterwards `landAnswer` (`boardconvert.ts`, `measure`) re-wraps and
re-measures the answer's changed text. A free text (no container) whose update makes it wider or taller than
before can then reach past the frame, which Excalidraw clips by `frameId`, so part of the text is hidden.

### Task 1: An edited drawing's frame fits its text as measured
**Depends on:** none
**Files:** `frontend/app/view/boards/boardmodel.ts`, `frontend/app/view/boards/boardmodel.test.ts`, `frontend/app/view/boards/boardconvert.ts`

**What to build:** when an answer edits a drawing, the frame is fitted to its children after their text is
measured, so every child of the edited drawing lies inside its frame with `FRAME_PADDING` around the outermost
one. Keep one frame-fit rule (`padded` around the children's union bounds) used by both the new-drawing and the
edit path; how the measured text reaches the fit (a measuring function handed to `applyAnswer`, or a refit
exported from `boardmodel.ts` and called by `landAnswer` after `measure`) is the worker's call, as long as
`boardmodel.ts` and its tests still do not load the Excalidraw runtime. The closed-board applier and the live
canvas both land through `landAnswer`, so both get the fix.

**Acceptance:**
- An edit whose update gives a free text in the drawing a wider measured box than its old one leaves the frame
  enclosing that text's measured box with `FRAME_PADDING` on the grown side: a unit test through the model's
  public functions with a stub measurement (no Excalidraw runtime).
- An edit with no changed text fits its frame exactly as before (the existing edit tests keep passing unchanged).
- A new drawing's frame is unchanged by this task.
