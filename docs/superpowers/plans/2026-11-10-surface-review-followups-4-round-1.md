# Surface review follow-ups, round 4: fix round 1

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish F5 of `C:/Users/kael02/IdeaProjects/waveterm/cdp-shots/review/followups-4/report.md` on the two
agent-tree-rail tabs it did not cover: the tree-rail lead and landed-run lead D still point at made-up blocks, so
their rows and headers read `error getting block: not found` / `failed to start`.

**Architecture:** Scenario-only change in agent-tree-rail, the same shape the run's Task 6 used for the worker tab
(spec D8): a real shell block made in arrange, closed in teardown.

**Tech Stack:** CDP scenarios.

**Effort:** effort:fdea6d43-219b-4cf2-b4ce-51758338103b
**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\79227e05\docs\superpowers\specs\2026-11-10-surface-review-followups-4-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/orchestrate ./pkg/wstore ./pkg/waveobj ./pkg/wshrpc/... ./cmd/wsh/...`
**Check:** `go build ./... && go vet ./pkg/orchestrate ./pkg/wstore ./pkg/waveobj ./pkg/wshrpc/... ./cmd/wsh/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brief-composer-steer-only agent-tree-rail canvas-mark brainstorm-mode brainstorm-answer-boards brainstorm-builder-check`

## Global Constraints

- Keep prettier off `scripts/*.mjs`.
- Never attach to CDP :9222 (another session may drive that dev app). Run scenarios through
  `node scripts/cdp/final-verify.mjs agent-tree-rail`, which boots an isolated app from your tree. Never stop
  `wave-tauri.exe` / `wavesrv.x64.exe` by image name.
- Before fixing, confirm the finding still happens on your tree; if it does not, say so and change nothing.

---

### Task 1: agent-tree-rail's lead tabs are real blocks (F5, remaining tabs)
**Chunk:** agent-tree-rail fixture: the tree-rail lead (fx-blk-lead) and landed-run lead D (fx-blk-tree-lead-d) point at made-up blocks, so their tree rows and headers read 'error getting block: not found' / 'failed to start' in the 9c rows and the P12 shot (same defect as chunk 83, other tabs; from run 79227e05 t-6)
**Files:** `scripts/cdp/scenarios-agent.mjs`

Implements spec D8 for the two lead tabs.

- [ ] Confirm live first: run agent-tree-rail and record the error text on the tree-rail lead's row (9c rows) and
  lead D's row and header (`agent-tree-rail-p12-run-name.png`).
- [ ] In agent-tree-rail only, give the tree-rail lead (`TREE_RAIL_LEAD_ID`, block `fx-blk-lead`) and
  `LANDED_LEAD` (block `fx-blk-tree-lead-d`) real shell blocks made in arrange with the existing
  `openCanvasTerminal` helper (as `ctx.workerTerm` already is), closed in teardown also when a step fails. Pass the
  lead's block through `treeRailRoster`'s `leadExtra` argument where agent-tree-rail builds its roster. Do not edit
  `scenarios-shared.mjs`'s default `fx-blk-lead`: `scenarios-cockpit.mjs` (`CACHE_MISS_OREF`) and other scenarios
  rely on it.
- [ ] Add one step (or extend P12 and the 9c2 header step) asserting neither lead's tree row nor header shows
  `failed to start` or `error getting block`. If arrange could not make a block, the step fails naming the error.
- [ ] Acceptance: `node scripts/cdp/final-verify.mjs agent-tree-rail` passes every step, the new no-error
  assertions included, and the P12 shot shows no error text.
