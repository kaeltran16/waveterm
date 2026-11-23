# Brainstorm mockups, round 1: drop what the thumbnails left behind

Removing the turn thumbnails left two pieces with no remaining job: the poller still reads every turn canvas's
`canvas.json` to size thumbnails that are gone, and one scenario still queries the deleted thumbnail attribute.

**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\6c1bf3f3\docs\superpowers\specs\2026-11-23-brainstorm-mockups-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs brainstorm-answer-boards brainstorm-mode brainstorm-builder-ask brainstorm-working motion-lens workspace-brainstorm-question`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\brainstorm-mockups\project\Prototype.dc.html

### Task 1: Stop reading turn canvases for thumbnails that are gone
**Depends on:** none
**Files:** `frontend/app/view/agents/brainstormpoller.ts`, `frontend/app/view/agents/brainstormpoller.test.ts`, `frontend/app/view/agents/brainstormstore.ts`, `frontend/app/view/agents/brainstormstore.test.ts`, `frontend/app/view/agents/renderedbrainstormmodel.test.ts`, `scripts/cdp/scenarios-workspace-brainstorm-question.mjs`

**What to build:** `BrainstormState.turn.canvases` existed only to size this turn's board thumbnails, which the run
replaced with name chips; `readTurnCanvases` (called from the poll tick, `brainstormpoller.ts` ~L313) is now its
only writer and nothing reads it. Remove the field and the `canvas.json` reads that fill it. Keep whatever the
turn chips still need: if they rely on the poller serving the design folder (`base`) once this turn wrote a board,
that serve stays; if `turn.read` then has no job left, it goes too. Delete the tests of the removed behaviour in the
same change. In `scenarios-workspace-brainstorm-question.mjs` (~L253, the `thumbs` probe) drop the dead
`[data-brainstorm-thumb]` half of the selector, keeping the iframe check.

**Acceptance:**
- a poll tick after the agent wrote this turn's boards fetches no `canvas.json` for those boards' canvases
- `turn.canvases` and every reference to it are gone; this turn's board chips still draw and open the window on
  their canvas (brainstorm-working's turn-chip step passes)
- `[data-brainstorm-thumb]` appears nowhere in `frontend/` or `scripts/`; workspace-brainstorm-question passes
