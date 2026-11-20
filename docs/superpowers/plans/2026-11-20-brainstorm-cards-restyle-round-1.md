# Brainstorm cards restyle: Final round 1 fix

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs rendered-bs-question rendered-bs-boards workspace-brainstorm-cards rendered-bs-check rendered-bs-design rendered-bs-review rendered-bs-run rendered-bs-mockup workspace-pane-canvas rendered-bs-rows`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\brainstorm-cards\project

Final round 1 failed 84/85. The failing step is `rendered-bs-rows`'s CanvasUpdated step ("the mark is a bubble with its crop, the note and marked on Main · the canvas; the crop opens Main in the pane"), with `board: false`. It fails on the base too, so this run did not cause it (t-8 reported it as Found not fixed).

Cause: the step waits for the Brainstorm pane's `data-brainstorm-view` to read `"board"`, but `paneView` (`brainstormmodel.ts`) no longer returns a `"board"` view. A crop click now runs `openMarkedBoard` (`renderedbsrows.tsx`). Because the fixture's file has `canvas` equal to the mark's canvas, that goes through `openBrainstormAt(agent, { board })`, then `openBrainstormBoard`, which attaches the canvas at that board and calls `openCanvasWindow(agentId, { board })`. The product behaviour is right and the assert is stale.

### Task 1: The mark step checks the canvas window at Main
**Depends on:** none
**Files:** `scripts/cdp/scenarios-rendered-bs-rows.mjs`

**What to build:** in `rendered-bs-rows`, the CanvasUpdated step's crop-click check asserts what the click does now. After the click, the canvas window (`[data-canvas-window]`) is open on this agent, and the canvas state's `board` is the mark's board (`Main.dc.html`, the board `MARK_LINE` names). Read both through `canvasstore.ts` (`getCanvas(id).board` and `canvasWindowAtom`), as `canvasFacts` in `scenarios-workspace-pane.mjs` does. Do not import from that file; write the few lines through the kit's `agentPage`. Close the window (`closeCanvasWindow`) before `closePaneTabs`, so the steps after this one start from the same state as before. Update the step's title to say the crop opens Main in the canvas window. Leave the bubble assertions (note, `marked on Main · <topic>`, crop `300x76`, right-aligned) unchanged. Change no product code.

**Acceptance:**
- `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs rendered-bs-rows` passes every step. The CanvasUpdated step's detail shows the window open on the agent with board `Main.dc.html`, the window closed again afterwards, and `back` true.
- The pinned-bar step after it still passes: its click brings the mark back.
