# Workspace pane polish, fix round 1: one diff sign per wrapped line

Final failed on the merged result 2a3acf7: in the workspace pane's Changes tab, a wrapped added line draws its `+`
on every visual row (9 rows, 9 signs), so one added line reads as nine. Monaco draws the diff indicator as a
`linesDecorationsClassName`, which repeats on every view line of a wrapped model line; its inline deleted-code view
zone likewise draws one `−` per visual row (`result.heightInLines`, ignoring `viewLineCounts`). The step passed
because it only checked that some sign sat near the first row.

## Decisions beyond the design

1. **With wrap on, the pane draws its own signs and Monaco draws none.** `paneOptions(..., wrap=true)` sets
   `renderIndicators: false`, and `DiffPane` adds model decorations using `firstLineDecorationClassName`, so a wrapped
   line's sign appears only on its first row. It reuses Monaco's own class names
   (`insert-sign codicon codicon-diff-insert`, `delete-sign codicon codicon-diff-remove`), so the signs look the
   same as today's and need no new CSS. Why: Monaco has no option to draw an indicator once per line, and
   `firstLineDecorationClassName` is its documented way to do that.
2. **Deleted lines in the inline (unified) view get no sign when wrap is on.** They are view zones that Monaco
   renders itself, with no decoration hook. Drawing a sign there would mean patching Monaco's DOM after each render.
   Their red band still marks them. In the split view a deleted line is a model line in the original editor and gets
   its one sign there. Why: one sign per line is the requirement, and a red band with no sign does not misstate the
   count, while nine signs did. The Diff surface is unwrapped, so it keeps Monaco's indicators unchanged.
3. **The leftover transcript mark is removed in this round.** `markFromTranscript`, `CanvasState.markFrom` and
   the `markFrom === "transcript"` branch in `canvassend.ts` have had no production caller since Task 6 (three
   task reports flagged this). Plan decision 12 removes such dead code. The two tasks share no file, so they run
   side by side.

### Task 1: one diff sign per wrapped line in the pane's Changes tab
**Depends on:** none
**Files:** `frontend/app/view/agents/diffoptions.ts`, `frontend/app/view/agents/diffoptions.test.ts`, `frontend/app/view/agents/diffpane.tsx`, `scripts/cdp/scenarios-workspace-pane.mjs`

**What to build:** in the workspace pane's Changes tab (`DiffPane` with `wrap`), each inserted line shows exactly
one `+`, on the first visual row of the line however many rows it wraps to. In the split view each deleted line
in the original editor shows exactly one `−` the same way. `paneOptions` with `wrap` turns Monaco's
`renderIndicators` off; the new-file rule (`renderIndicators: !newFile`) still holds when wrap is off. While wrap is
on, `DiffPane` keeps a decorations collection on the modified editor (inserted lines) and one on the original
editor (deleted lines). It refreshes them on every `onDidUpdateDiff` from `getLineChanges()` and clears them when the
editor unmounts. Each decoration uses `firstLineDecorationClassName` with Monaco's sign classes above. A new file
draws no signs, as today. With wrap off (the Diff surface) nothing changes: no own decorations, Monaco's
indicators as before. Bands and line numbers stay as they are.

**Acceptance:**
- `diffoptions.test.ts`: `paneOptions(false, false, false, true).renderIndicators` is false;
  `paneOptions(false, false, false, false).renderIndicators` is true; a new file is false either way.
- The `workspace-pane` step "the Changes tab's diff wraps a long line, its band, number and sign kept, with no
  sideways scroll" now requires exactly one `diff-insert` sign in the modified editor's margin for the long line,
  near its first row. It also requires that no sign lies beside any continuation row. On 2a3acf7 the step fails, as
  `signs:9` shows, and with this task it passes. `workspace-changes` (the Diff surface, unwrapped) still passes
  unchanged.

### Task 2: drop the transcript-mark leftovers
**Depends on:** none
**Files:** `frontend/app/view/agents/canvasstore.ts`, `frontend/app/view/agents/canvasstore.test.ts`, `frontend/app/view/agents/canvassend.ts`, `frontend/app/view/agents/canvassend.test.ts`

**What to build:** delete `markFromTranscript`, the `markFrom` field of `CanvasState` and every place that sets
or clears it (`withTab`, `setMarking`), and the `markFrom === "transcript"` branch at the end of `sendCanvasMark`.
Delete the tests that exist only for them and drop `markFrom` from the assertions that mention it: the "a mark from
the transcript" tests in both test files. Grep `markFrom` across `frontend/` and `scripts/` first; every
reference found must go. Behaviour does not change: no caller reaches the branch today.

**Acceptance:**
- `grep -rn "markFrom" frontend scripts` finds nothing.
- `canvasstore.test.ts` and `canvassend.test.ts` pass, and the Check passes.
- `canvas-mark` and `rendered-bs-mockup` still pass.
