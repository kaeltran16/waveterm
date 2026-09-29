# Narration timeline polish, fix round 1

**Verify:** `node scripts/verify.mjs ./pkg/util/utilfn/`
**Final:** `node scripts/cdp/final-verify.mjs narration-feed surface-smoke`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/narration-timeline/project/Main.dc.html

**Goal:** Stop one final-verify test from timing out under full-suite load, so Verify passes on the merged result.

**Spec:** `docs/superpowers/specs/2026-09-29-narration-timeline-polish-design.md` (unchanged by this round)

## What failed

Round 1's final-stage Verify ran the whole vitest suite, and one test failed:
`scripts/cdp/final-verify.test.mjs > final-verify.mjs > is unverified when the dev app never answers CDP, and
stops the process it started` with "Test timed out in 5000ms". Every other test (3516) passed.

This run did not touch `scripts/cdp/final-verify.mjs` or its test. The test spawns the real CLI, which waits
`ARC_FINAL_BOOT_MS=3000` for a fake dev app and then stops it. Run alone it takes 3.3-3.4s (three runs, all
passing), which leaves under 2s of slack against vitest's default 5000ms. Under the full suite's parallel load
(collect 90s) that slack runs out. The same file's other spawn-heavy test, "runs two final stages one after the
other", already passes an explicit `30_000` timeout; this one lacks it.

## Global Constraints

- Touch only `scripts/cdp/final-verify.test.mjs`. Do not change `scripts/cdp/final-verify.mjs`, the boot wait, or
  any assertion.
- Never run prettier on `scripts/*.mjs` (it reindents the hand-formatted 4-space files).

## Review Focus

- The test must still fail when its intent is violated: the assertions (`killed` false, exit `EXIT_UNVERIFIED`,
  last line matching `dev app did not answer on :<port>`, the fake dev process stopped) stay exactly as they are.

---

### Task 1: Give the no-CDP final-verify test the same timeout as its sibling

**Depends on:** none

**Files:**
- Modify: `scripts/cdp/final-verify.test.mjs` (the `it("is unverified when the dev app never answers CDP, and stops
  the process it started", ...)` block)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Add the timeout**

The block currently ends:

```js
        expect(existsSync(pidFile)).toBe(true);
        expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    });
```

Change its closing line to pass vitest a 30s timeout, matching "runs two final stages one after the other":

```js
        expect(existsSync(pidFile)).toBe(true);
        expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    }, 30_000);
```

The `run()` helper already kills the child at 30s (`execFile(..., { timeout: 30_000 })`), so the test's own limit
now matches the CLI's.

- [ ] **Step 2: Run the file**

Run: `npx vitest run scripts/cdp/final-verify.test.mjs`
Expected: 14 passed.

- [ ] **Step 3: Commit**

```bash
git add scripts/cdp/final-verify.test.mjs
git commit -m "test(cdp): give the no-CDP final-verify test a 30s timeout so full-suite load cannot trip it"
```
