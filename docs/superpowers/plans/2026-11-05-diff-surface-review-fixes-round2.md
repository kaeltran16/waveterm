# Diff Surface Review Fixes: Final Round 2 Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-11-05-diff-surface-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/gitinfo ./pkg/wshrpc/...`
**Check:** `task check:ts && go vet ./pkg/gitinfo ./pkg/wshrpc/...`
**Final:** `node scripts/cdp/final-verify.mjs diff-scope diff-states diff-compare git-history diff-review-marks diff-source-row diff-comments`

**Goal:** Make `diff-comments` steps 9a, 9c and 9d pass on the merged result.

**Architecture:** One scenario fix in `scripts/cdp/scenarios-files.mjs`. 9c and 9d fail only because 9a commented on the wrong file, so their counts and prompt text are off.

**Tech Stack:** CDP scenarios (`scripts/cdp`), React 19 + jotai (`frontend/app/view/agents`).

## Global Constraints

- Every constraint of the run's plan (`docs/superpowers/plans/2026-11-05-diff-surface-review-fixes.md`, Global Constraints) holds.
- Prove the fix with `node scripts/cdp/final-verify.mjs diff-comments` (its own isolated dev app), run at least twice, since the failure is timing-dependent.
- Do not weaken an assertion: 9a-9d keep their expected counts, labels and prompt text.

## Review Focus

- The wait added to 9a must prove the agent scope's own load has settled, not the project scope's: both scopes have the same folder, so the same rows are listed.

---

### Task 1: diff-comments 9a waits for the agent scope to settle before opening a file
**Depends on:** none
**Files:** `scripts/cdp/scenarios-files.mjs`

Evidence: Final round 2, `diff-comments`:
- 9a FAIL: `{"listed":true,"agentOpened":false,"onAgent":[true,false,true],"bar":{"count":"2 comments",…}}`.
- 9c FAIL: the count is 2, not 3.
- 9d FAIL: the prompt holds `src/retry/backoff.go:4` with policy.go's "Why 8?" note, and no `policy.go:7-9`.

The same scenario passed in round 1, and round 2 changed only `scenarios-files-states.mjs`, so this depends on timing.

Lead's reading of the cause; confirm it before fixing:
- After clicking the agent row, 9a waits until README.md and legacy.go are listed. The project scope it leaves has the same folder and lists the same rows, so the wait can pass before the agent scope's own load has run.
- `openFile(POLICY)` then clicks policy.go while that load is still running.
- When the load settles, it selects its first file (`firstInList`, tree order, which is `src/retry/backoff.go`) over the click, as an initial load does.
- So the line-4 comment lands on backoff.go, the 7-9 range fails (backoff.go is shorter), and 9c/9d inherit the wrong batch.

- [ ] Confirm the cause in the isolated app: log the open file and the scope key just before and after `openFile(POLICY)` in 9a. If the cause is different, fix that one, and say what it was in your report.
- [ ] Make 9a wait, after the agent row's click, until the store shows the agent scope settled, as diff-states step 11 does (`scripts/cdp/scenarios-files-states.mjs`, its store wait). That means `diffScopeAtom`'s origin is the agent, `filesStateAtom` is non-null with this scope's change list, and the selected row is the working-tree row. Only then call `openFile(POLICY)`, and check that policy.go is the open file before commenting.
- [ ] `node scripts/cdp/final-verify.mjs diff-comments`, twice: every step PASS both times. Commit.
