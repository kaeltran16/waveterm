# Board graph layout: round 2 fixes

**Spec:** `docs/superpowers/specs/2026-11-26-board-graph-layout-design.md` (D2: the turn's counts stay truthful; D8: an edit with `graph` redraws the drawing in view)
**Verify:** `node scripts/verify.mjs ./pkg/boarddrawer ./pkg/wshrpc/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/boarddrawer ./pkg/wshrpc/...`
**Final:** `node scripts/cdp/final-verify.mjs boards-ask`

### Task 1: A redraw reports the shapes it removes
**Depends on:** none
**Files:** `pkg/boarddrawer/answer.go`, `pkg/boarddrawer/answer_test.go`

An edit with `graph` deletes every live shape of the drawing in view (D8), but `Answer.Removed` stays 0, so the turn under-reports the redraw. After the existing checks pass (the refusal of `update`/`remove` beside a graph and the `MaxShapes` bound keep reading the reply's own counts), set `Removed` for an edit with `graph` to the number of shapes the scene puts in the drawing in view (`scene.FrameOf[id] == drawing`, the frame itself excluded). An edit without `graph` and a new drawing keep `Removed = len(remove)`.

**Acceptance:**
- An edit with `graph` on a scene whose drawing in view holds N shapes, beside shapes of another drawing and loose shapes, yields `Removed == N`; a row joined to the existing graph table.
- An edit with `graph` whose drawing has no shapes yields `Removed == 0`; existing rows stay green.

### Task 2: The live app shows a redraw edit landing laid out
**Depends on:** none
**Files:** `scripts/cdp/scenarios-boards-ask.mjs`

Nothing in the live app exercises an edit with `graph`; `applyAnswer`'s redraw is unit-tested only. Add a step after step 21 on the same board: feed an edit answer with `drawingid` = step 21's drawing and `graph` = the `WORKER_GRAPH` fixture plus one node and one labeled edge (e.g. a "queued" state with "enqueue" into "idle"), through the existing `feedAnswer`.

**Acceptance:**
- The new step passes only when the board still has exactly one drawing, with the same frame id and title as step 21's, whose labeled boxes and arrows number the new graph's nodes and edges, with none of step 21's old shape ids live, and `textOverlaps` on its elements is empty.
- It screenshots the redrawn board (`SHOT("G2", "redrawn")`).
