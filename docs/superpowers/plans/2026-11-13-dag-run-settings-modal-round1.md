# DAG Run settings modal: Final round 1 fix plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `motion-dag-peek` steps 8 and 10 pass in the Final, where they run after `dag-run-settings` and `dag-lifecycle` in one app.

**Architecture:** Step 7 puts a page-only `finalizing` dag in the page with `injectPageDag` at the stored version + 1. The scenario's run is live (t-1 is a real dispatch), so the engine keeps writing that dag; WOS drops a pushed update only when its version is not newer (`frontend/app/store/wos.ts` `updateWaveObject`), so the second engine write after the injection replaces the page copy. In the Final it did: step 7's pill settled on `blocked`, step 8's final card read `waiting` with no `[data-final-end]` (`finalCard: false`), and step 10's `undoPageDag` changed nothing on the pill (`flashFrames: 0`). The same steps passed when the scenario ran alone (t-3's own check, 11/11), so this is a timing race with live engine writes, not the modal. The fix makes the injection outrank engine writes until `undoPageDag` puts the stored dag back (`reloadWaveObject` sets the value without a version check).

**Tech Stack:** CDP scenarios under `scripts/cdp/`.

**Verify:** `node scripts/verify.mjs ./pkg/jarvis`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs dag-run-settings dag-lifecycle motion-dag-peek autonomous-runs`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\run-settings-polish\project

## Global Constraints

- Scenario files only; no product code changes.
- Keep prettier off `scripts/*.mjs` (4-space hand formatting).

## Review Focus

1. The other `injectPageDag` callers keep today's behavior (version + 1) unless they opt in.
2. Step 10's flash still comes from a real status change (the undo's reload), not from the injection.

---

### Task 1: Page-only dag injection outranks live engine writes in motion-dag-peek
**Files:** `scripts/cdp/scenarios-runs.mjs`, `scripts/cdp/scenarios-motion-dag-peek.mjs`

- [ ] **Step 1:** In `scenarios-runs.mjs`, `injectPageDag(h, runId, { tasks, digest, next, fields, ahead = 1 })` (~line 1511): the injected version is `dag.version + ahead` (used for both the WOS value and the digest's `dagversion`). Extend the comment above it: a large `ahead` keeps the page copy until `undoPageDag`, since WOS drops any pushed update whose version is not newer, for a scenario whose run is live and still writing its dag. Every existing caller keeps the default.
- [ ] **Step 2:** In `scenarios-motion-dag-peek.mjs` step 7 (~line 255), pass `ahead: 1000000` (a named constant in the file, with a one-line why: the run is live and the engine's writes would replace the finalizing copy before steps 8-10). Steps 8-10 are unchanged; step 10's `undoPageDag` reload is what brings the stored dag, and its status change, back.
- [ ] **Step 3:** `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs dag-run-settings dag-lifecycle motion-dag-peek` → every step passes, including motion-dag-peek 8 (`finalCard: true`, the form fades in) and 10 (`flashFrames > 0`, all `anim: "none"`, `rShook: 0`).
- [ ] **Step 4:** Commit.
