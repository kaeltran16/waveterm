# Monitor tasks: fix round 3

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `node scripts/verify.mjs ./pkg/resmon`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs monitor-tasks shell-tasks`
**Prototype:** C:\Users\kael02\AppData\Local\arc-wt\0bb9fc91\.superpowers\design\monitor-tasks\project\Main.dc.html

**Goal:** Stop the full vitest suite failing on any of the process-starting tests in `scripts/cdp/final-verify.test.mjs`.

**Architecture:** Each of the last three rounds failed on a different test in this file, and every one was a test that starts a real process (`run(...)` on `final-verify.mjs`, or `spawn(...)`). Under the full suite's load such a start can take several seconds and run past vitest's 5000 ms default. The tests that already pass `30_000` have stopped failing. Four process-starting tests still use the default. The 30 s is only a ceiling for a slow machine: none of them changes how long it takes when it passes.

**Tech Stack:** vitest.

## Global Constraints

- Only `scripts/cdp/final-verify.test.mjs` changes, and no product code.
- Leave every assertion unchanged, and every timeout already set (`30_000` or `60_000`).
- Format the `.mjs` file by hand with 4-space indents. Never run prettier on it.

## Review Focus

- A test that starts a process and still uses the 5 s default: after this task, there is none left in the file.

---

### Task 1: The spawn timeout on every process-starting test

**Depends on:** none

**Files:** `scripts/cdp/final-verify.test.mjs`

- [ ] **Step 1:** Pass `30_000` as the timeout argument of these four `it(...)` calls:
  - `describe("final-verify.mjs")`: "is unverified when ARC_FINAL_OUT is not set"
  - `describe("final-verify.mjs")`: "starts the dev app on its own vite port, target dir, store and no global install"
  - `describe("final-verify.mjs build slots")`: "is unverified when other final stages keep every slot past the wait"
  - `describe("final-verify.mjs build slots")`: "is free once the stage holding it is killed"
- [ ] **Step 2:** Grep the file for `run(` and `spawn(`. Every `it` whose body calls either must end with a timeout argument. Add `30_000` to any this list missed.
- [ ] **Step 3:** Run `npx vitest run scripts/cdp/final-verify.test.mjs`. Expected: 34 passed.
- [ ] **Step 4:** Commit `test(final-verify): spawn timeout on every process-starting test`.
