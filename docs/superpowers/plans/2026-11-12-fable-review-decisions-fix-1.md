# Fable review decisions, batch 10: fix round 1

The final stage failed on the merged result: Verify's `cargo test` stopped in the `wave-tauri` build script with
`glob pattern ../dist/bin/wsh-*-windows.x64.exe path not found`. Nothing in the run's four tasks caused it. The
defect is on the base, and it holds the land, so this round fixes it.

Root cause, reproduced in the landing tree: with `ARC_VERIFY_CHANGED` unset (the final stage), `scripts/verify.mjs`
runs the whole vitest suite after the Go tests. `scripts/cdp/final-verify.test.mjs` spawns the real
`final-verify.mjs` CLI through its `run()` helper (`execFile(process.execPath, [SCRIPT, ...args], { env, timeout })`)
with no `cwd`, so the child runs in the tree under test. The CLI's `main()` calls
`unlinkBuildJunctions(process.cwd())`, which removes that tree's `dist/bin` and `src-tauri/target` junctions (Setup
made them; `node_modules` is not in `BUILD_JUNCTIONS`, so it survives). `cargo test` then cold-builds into a fresh
`src-tauri/target`, and tauri-build fails on the missing `dist/bin` resources. A per-merge Verify is scoped
(`vitest related`) and never ran this test, which is why every task's Verify passed. Plain
`go test ./pkg/wavevault ./pkg/effortstore` leaves the junctions alone; `node scripts/verify.mjs` with the same
packages removes them.

### Task 1: final-verify's tests never run the CLI in the repo tree
**Depends on:** none
**Files:** `scripts/cdp/final-verify.test.mjs`

Make every spawn of the real CLI in `final-verify.test.mjs` run in a scratch directory, never the test process's
cwd: give `run()` a `cwd` (a fresh `mkdtempSync` dir under `tmpdir()` when the caller has none, removed after the
call, or the test's own `dir` where it has one). Do not change `final-verify.mjs`: unlinking the junctions in its
cwd is what a real final stage needs (its build must not write into the main checkout).

Before changing anything, check what the CLI reads relative to its cwd before it exits in these tests (the fake
dev command and `ARC_FINAL_OUT` are absolute paths), so a test that passes today still passes for the same reason.

Regression test: in the existing "is unverified when the dev app never answers CDP" case (or a new case in the
same style), build a scratch tree with a `dist/bin` junction to a scratch target, run the CLI with that tree as
`cwd`, and assert the junction is gone and the target's file is still there. That pins `run()` to the cwd it is
given: with today's `run()` the junction survives and the test fails. Running the file must leave the repo's own
junctions in place: after `npx vitest run scripts/cdp/final-verify.test.mjs`,
`cmd /c "dir /AL dist src-tauri"` still lists `bin` and `target` in a tree where Setup made them.
Note for the worker: in your own tree, running this test file before your fix strips your tree's `dist/bin` and
`src-tauri/target` links; re-run `node scripts/worktree-junctions.mjs prepare` after, and delete a cold
`src-tauri/target` real directory cargo made first if you need the junction back.

Prove it with `npx vitest run scripts/cdp/final-verify.test.mjs`, then the plan's Verify unscoped:
`node scripts/verify.mjs ./pkg/wavevault ./pkg/effortstore && cargo test --manifest-path src-tauri/Cargo.toml`.
