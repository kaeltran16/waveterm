# Surface review follow-ups, round 4: fix round 2

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make brainstorm-mode step 12b stop failing in Final. Round 2's Final failed it with the UI already back
on the terminal (`view: null, switch: null, terminal: true`) but `meta3` still naming the brainstorm file.

**Architecture:** Scenario-only change. `dismissBrainstorm` (frontend/app/view/agents/brainstormstore.ts) detaches
the pane synchronously, then clears `session:brainstorm` with an awaited `SetMetaCommand`; the pane's button does
not await it (`void dismissBrainstorm(...)`). Step 12b waits up to 3s for the UI, then reads the tab meta once, so
it can read before the write lands. No dismiss-failure warning is in the Final log, so the clear is late, not lost.
The race is on the base: this run did not touch scenarios-brainstorm.mjs or the brainstorm store.

**Tech Stack:** CDP scenarios.

**Effort:** effort:fdea6d43-219b-4cf2-b4ce-51758338103b
**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\79227e05\docs\superpowers\specs\2026-11-10-surface-review-followups-4-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/orchestrate ./pkg/wstore ./pkg/waveobj ./pkg/wshrpc/... ./cmd/wsh/...`
**Check:** `go build ./... && go vet ./pkg/orchestrate ./pkg/wstore ./pkg/waveobj ./pkg/wshrpc/... ./cmd/wsh/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brief-composer-steer-only agent-tree-rail canvas-mark brainstorm-mode brainstorm-answer-boards brainstorm-builder-check`

## Global Constraints

- Keep prettier off `scripts/*.mjs`.
- Never attach to CDP :9222 (another session may drive that dev app). Run scenarios through
  `node scripts/cdp/final-verify.mjs brainstorm-mode`, which boots an isolated app from your tree. Never stop
  `wave-tauri.exe` / `wavesrv.x64.exe` by image name.
- Do not loosen what a step asserts: wait for the state, never drop the check.

---

### Task 1: brainstorm-mode 12b waits for the tab meta to clear
**Files:** `scripts/cdp/scenarios-brainstorm.mjs`

- [ ] In step 12b, replace the single `bsTabMeta` read after Back to terminal with a poll that reads it until it
  is `null` or a bounded wait passes (the 3000 ms the step already gives the UI is enough; reuse an existing wait
  helper or constant in the file if one fits, else a named constant). Record the last value read, as now. The step
  still fails if the meta is not cleared within the wait.
- [ ] Look at the file's other `bsTabMeta` reads (step 0b after reveal, step 11b's `meta2`) and give them the same
  wait only if they read a value an un-awaited write sets; leave any read that already follows an awaited write.
  Name what you changed and why in your report.
- [ ] Acceptance: `node scripts/cdp/final-verify.mjs brainstorm-mode` passes every step. Run it at least twice and
  report both results.
