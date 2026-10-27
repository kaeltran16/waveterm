# Monitor tasks: fix round 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `node scripts/verify.mjs ./pkg/resmon`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs monitor-tasks shell-tasks`
**Prototype:** C:\Users\kael02\AppData\Local\arc-wt\0bb9fc91\.superpowers\design\monitor-tasks\project\Main.dc.html

**Goal:** Stop the final stage's vitest run from failing on `final-verify.test.mjs > final-verify.mjs build slots > skips a slot whose exe a dev app started without the lock is running`.

**Architecture:** That test copies `node.exe` into a temp `target/debug/wave-tauri.exe`, launches it, and waits for it to print `up`. Windows scans a freshly written exe on its first launch. While the final stage runs the whole vitest suite, that scan pushed the test past vitest's default 5000 ms. The test was abandoned before its `finally` could kill the app. The still-running exe then made the `afterEach` `rmSync` of the temp dir fail with EPERM. The slot logic itself is not slow (`acquireBuildSlot` and `slotExeRunning` in `scripts/cdp/final-verify.mjs` only open sockets and files). The neighbouring process-spawning tests in the same `describe` already pass `30_000` as their timeout, and this one was left without it. This failure predates the run, which did not touch either file.

**Tech Stack:** vitest.

## Global Constraints

- Only `scripts/cdp/final-verify.test.mjs` changes, and no product code.
- Format the `.mjs` file by hand with 4-space indents. Never run prettier on it.

## Review Focus

- A slow first launch: the test still asserts slot 1 while the exe runs and slot 0 after it exits. A longer wait must not weaken either assertion.

---

### Task 1: Give the slot-skip test the suite's spawn timeout

**Depends on:** none

**Files:** `scripts/cdp/final-verify.test.mjs`

- [ ] **Step 1:** Pass `30_000` as the timeout argument of the `it.skipIf(process.platform !== "win32")("skips a slot whose exe a dev app started without the lock is running", ...)` call, the value its siblings in `describe("final-verify.mjs build slots")` use. Add a one-line lower-case comment saying why: windows scans the freshly copied exe on its first launch, which can outlast the default timeout under a full suite.
- [ ] **Step 2:** Leave every assertion and the `finally` that kills the app unchanged.
- [ ] **Step 3:** Run `npx vitest run scripts/cdp/final-verify.test.mjs`. Expected: PASS, with the test reported as run, not skipped, on Windows.
- [ ] **Step 4:** Commit `test(final-verify): give the slot-skip test the spawn timeout`.
