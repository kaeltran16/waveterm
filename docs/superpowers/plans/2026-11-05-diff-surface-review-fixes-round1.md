# Diff Surface Review Fixes: Final Round 1 Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-11-05-diff-surface-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/gitinfo ./pkg/wshrpc/...`
**Check:** `task check:ts && go vet ./pkg/gitinfo ./pkg/wshrpc/...`
**Final:** `node scripts/cdp/final-verify.mjs diff-scope diff-states diff-compare git-history diff-review-marks diff-source-row diff-comments`

**Goal:** Make the two failing `diff-states` Final steps (7 "diff read failure" and 11 "asking agent waits") pass, fixing the product where the product is wrong and the step where the step is wrong.

**Architecture:** Final passed 82 of 84 steps on the merged result. The two failures are independent but share `scripts/cdp/scenarios-files-states.mjs`, so they run one after the other.

**Tech Stack:** CDP scenarios (`scripts/cdp`), React 19 + jotai + vitest (`frontend/app/view/agents`).

## Global Constraints

- Every constraint of the run's plan (`docs/superpowers/plans/2026-11-05-diff-surface-review-fixes.md`, Global Constraints) holds.
- Prove each fix with `node scripts/cdp/final-verify.mjs diff-states` (its own isolated dev app). The shared dev app on :9222 belongs to other sessions.
- Do not weaken an assertion to make a step pass: each step must still fail when its behavior is broken.

## Review Focus

- Step 7's new mechanism leaves the fixture as it found it (the deleted `src/old.py` deleted again, no deny ACE left behind), even when the step fails midway: the later steps depend on that.
- Step 11's fix names the root cause it found and whether it was the product or the step; a product fix carries a unit test that fails without it.

---

### Task 1: diff-states step 7 reads a really unreadable file
**Depends on:** none
**Files:** `scripts/cdp/scenarios-files-states.mjs`

Decision (lead): keep `gitinfo.FileInWorktree` answering `Missing` for a directory. A tracked file whose path is now a folder is what `git status` itself reports as deleted, so the pane drawing a deleted file is correct, and the step's folder mechanism never exercised F20's failure state. The step needs a file git still lists whose bytes the read cannot get.

Evidence: Final round 1, `diff-states` step 7 FAIL `{"picked":true,"diff":true,"failed":false,"failedText":"src/old.py+0−21/1123def old():    return 1…","recovered":true}`.

- [ ] Change step 7's mechanism (keep its title's claim: "Couldn’t read this file" with Retry, and Retry reads it once restored). Recommended: write `src/old.py` back with modified content (e.g. `def old():\n    return 3\n`), press `r` and wait for its diff so git's index stat is refreshed. Then deny read-data only, `icacls <file> /deny "%USERNAME%:(RD)"`, so the stat still succeeds and `os.ReadFile` fails. Press `r` and expect `emptyIs("failed")` plus `[data-diff-retry]`. In `finally`, remove the deny ACE (`icacls <file> /remove:d "%USERNAME%"`), then click Retry and expect the diff editor. Delete `src/old.py` again so later steps see the fixture's deleted file. If `git status` itself fails on the unreadable file so the row is dropped, or the stat fails too, use an exclusive lock held by a child process instead (`[IO.File]::Open(path,'Open','ReadWrite','None')` in a PowerShell child kept alive until `finally`). Say which mechanism you used and why in your report.
- [ ] Update the step's title so it describes the new mechanism.
- [ ] `node scripts/cdp/final-verify.mjs diff-states`: step 7 PASS, and steps 8-10 still PASS. Commit.

### Task 2: diff-states step 11 opens the asking agent's diff
**Depends on:** Task 1 (both edit `scripts/cdp/scenarios-files-states.mjs`)
**Files:** `scripts/cdp/scenarios-files-states.mjs`, `frontend/app/view/agents/githistorystore.ts`, `frontend/app/view/agents/githistorystore.test.ts`, `frontend/app/view/agents/filesstore.ts`, `frontend/app/view/agents/filesstore.test.ts`

Evidence: Final round 1, `diff-states` step 11 FAIL `{"asked":{"asking":true,"trusted":true,"prompted":true,"seen":["working","asking"]},"listed":true,"scoped":true,"opened":false,"drafting":false,"waiting":false,"bar":{"kind":"none",…},"prompts":0}`. The agent launched and reached `asking`, and Diff scoped to it. Then `pickFile(h, STATES.deleted)` or the diff editor wait failed, so no comment was drafted. The step passed in Task 11's own run, before Tasks 7 and 12 merged. Task 7 (F4: a scope change resets the selection to the default row; `settleSelection` waits while `filesStateAtom` is null) and Task 12 (subject states, the ended-scope `focusFollowAgent` guard) are the changes since.

- [ ] Diagnose in the isolated app: under the agent's scope, which history row is selected, what the commit pane lists, and whether a `src/old.py` row exists. One hypothesis: the agent's "Since session start" range anchors at HEAD, the fixture's empty commit (`STATES.noFiles`). The selection then lands on that commit's row ("Pick a file", no rows) rather than the synthetic session row. Another: the row is listed but its pair never draws.
- [ ] If the product is wrong, fix it in the store with a failing-first unit test beside it. An agent scope must open on its "Since session start" row, which lists the working-tree edit, as spec F4 says ("takes `defaultSelection` (the synthetic … "Since session start" row when present)"). If the step is wrong (it races the scope's load, or relies on a selection the spec does not promise), fix the step so it selects the row it needs explicitly and waits for the load to settle. Either way, name the root cause in your report.
- [ ] `node scripts/cdp/final-verify.mjs diff-states`: all 11 steps PASS. Commit.
