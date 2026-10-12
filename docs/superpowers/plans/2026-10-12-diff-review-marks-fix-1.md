# Diff review marks: fix round 1

**Goal:** Make the `code-diff` CDP scenario pass under `final-verify.mjs`, which boots a fresh dev store with no registered projects.

**Cause (verified):** Final failed only in `code-diff` (3/3 steps; `path=(none)`). `codeDiff.arrange` (`scripts/cdp/scenarios.mjs`, `const codeDiff`) returns `{}` and never registers a project, so on a fresh store the Code surface shows "No registered projects", `chooseProjectRow` finds no row, and no `[data-code-changed-row]` appears. The Code surface imports none of the files this run changed (`diffpane.tsx`, `changedfilelist.tsx`, `reviewmarks.ts`, ...); the scenario only ever passed against a hand-populated dev store. `diff-review-marks` and `diff-compare` both passed.

### Task 1: code-diff arranges its own repo

**Depends on:** none

**Files:** `scripts/cdp/scenarios.mjs`

Change only `const codeDiff` in that file.

Follow the arrange/teardown pattern `diffCompare` already uses in the same file (`mkdtempSync` + the file's `git(dir, ...)` helper + `h.rpc("createproject", ...)` + `waitForProjectInConfig` + reload-and-wait for `window.TabRpcClient`, then `deleteproject` + `rmSync` in teardown, each wrapped so teardown never throws).

- [ ] **Step 1:** In `codeDiff.arrange(h)`: create a temp git repo (`verify-code-diff-` prefix), commit a small file (e.g. `policy.go` returning 3), then edit it in the working tree (return 8) without committing, so the Changed column lists exactly that file. Register it with `createproject` under a fixed name `verify-code-diff`, wait for it with `waitForProjectInConfig(h, name)`, reload the page and wait until the app is up, as `diffCompare` does. Return `{ dir, name }`.
- [ ] **Step 2:** In `assert`, pick the scenario's own project, not `rows[0]`: after `openProjectPicker`, click the picker row whose text contains `verify-code-diff` (scope the query to the picker's container, as `chooseProjectRow` does: an unscoped query hits the app bar's search button). If the picker does not open because the project is already selected, carry on. Leave `chooseProjectRow` itself unchanged; its other callers rely on it. Expect the opened row's path to be `policy.go`, and put that in the step-1 check (`rowPath === "policy.go"`).
- [ ] **Step 3:** In `teardown(h, ctx)`: keep `h.goto("cockpit")`, then `deleteproject` on `ctx.name` and `rmSync(ctx.dir, { recursive: true, force: true })`, each in its own try/catch like `diffCompare`'s teardown.
- [ ] **Step 4:** Run `ARC_FINAL_OUT=<a tmp dir> node scripts/cdp/final-verify.mjs code-diff`. Expect all 3 steps of `code-diff` to PASS and `cdp-shots/code-diff.png` to show the Monaco diff editor on `policy.go`. Do not run prettier on `scripts/*.mjs` (AGENTS.md).
- [ ] **Step 5:** Commit `scripts/cdp/scenarios.mjs` with `test(cdp): code-diff registers its own repo`.
