# Short root for engine worktrees Implementation Plan

> **For agentic workers:** each task carries its design decisions, files, interfaces and acceptance tests; the
> worker writes the implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Engine worktrees live under `os.UserCacheDir()/arc-wt` (`%LOCALAPPDATA%\arc-wt` on Windows) with a
first-8-chars-of-run-id prefix, so Windows tooling stays under 260-char paths inside them.

**Architecture:** `worktreeDir(project, key)` stays the one computed path for every engine tree. It now resolves a
legacy in-project tree first, else `arc-wt\<8><suffix>`, else (prefix owned by another run, per an `arc-wt\<8>.run`
marker) `arc-wt\<full key>`. Creation sites claim the marker through `claimWorktreeDir`. The claude mod guard learns
the new root.

**Tech Stack:** Go (pkg/orchestrate, pkg/wshrpc/wshserver tests), TypeScript (claude mod guard, vitest), Markdown.

**Effort:** effort:0d2feabb-ca35-4e0b-a3f4-b0a850c893e0
**Spec:** `docs/superpowers/specs/2026-10-12-short-worktree-root-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/orchestrate ./pkg/jarvis ./cmd/wsh/cmd ./pkg/wshrpc/wshserver`
**Check:** `go vet ./pkg/orchestrate ./pkg/wshrpc/wshserver && go build ./cmd/wsh/... ./cmd/server/...`

## Global Constraints

- Root: `filepath.Join(os.UserCacheDir(), "arc-wt")`, one code path on every OS, resolved once per process; on a
  `UserCacheDir` error, log once and use the legacy `<project>/.waveterm/worktrees/<key>` layout.
- Directory names: run tree `<8>`, lane `<8>-t-N`, detached `<8>-final`, `<8>-base`, `<8>-bisect`, final stand-in
  `<8>-final-N`; `<8>` = first 8 chars of the 36-char run id. A key without a 36-char UUID prefix maps to
  `arc-wt/<key>` with no marker logic.
- Branch names do not change: `wave/<key>` with the full run id.
- An existing legacy `<project>/.waveterm/worktrees/<key>` always wins; nothing is migrated.
- Marker `arc-wt/<8>.run` holds the full run id, is created with O_CREATE|O_EXCL before the run's first tree, and is
  never deleted. A marker whose content is not this run's id (another run's, empty, or unreadable) sends this run's
  keys to `arc-wt/<full key>`.
- Tests never write into the real user cache dir.
- No new config, no UI change.

## Review Focus

- A run in flight when this ships: its lane tree at the legacy path is reused by the lane's next task, and removed
  from there by cleanup (Task 1 test `TestWorktreeDirLegacyWins` plus an `EnsureRunWorktree` case).
- Another run owns the prefix and has a tree at `arc-wt/<8>-t-1`: this run's cleanup, rewind and stale-final
  removal never touch it (Task 1 test `TestWorktreeDirForeignPrefixNeverShared`).
- A marker left empty by a crash between create and write: treated as another run's, so the path is the full-id
  one and nothing is shared (Task 1 test `TestWorktreeDirEmptyMarker`).
- First run on a machine: `arc-wt` does not exist yet; the first claim creates it (Task 1 test
  `TestClaimWorktreeDirCreatesRoot`).
- A project on another drive than the root's: git worktree add, git inside the tree, and removal work (Task 1
  Windows `subst` test).

---

### Task 1: Resolve engine tree paths under the short root
**Depends on:** none
**Files:** `pkg/orchestrate/worktreeroot.go`, `pkg/orchestrate/worktreeroot_test.go`, `pkg/orchestrate/worktreeroot_windows_test.go`, `pkg/orchestrate/worktree.go`, `pkg/orchestrate/basecheck.go`, `pkg/orchestrate/final.go`, `pkg/orchestrate/maintest_test.go`, `pkg/orchestrate/mutation_test.go`, `pkg/orchestrate/worktree_test.go`, `pkg/orchestrate/progress_test.go`, `pkg/wshrpc/wshserver/maintest_test.go`, `pkg/wshrpc/wshserver/wshserver_landing_test.go`, `pkg/wshrpc/wshserver/wshserver_dag_test.go`, `pkg/wshrpc/wshserver/wshserver_leadcomplete_test.go`

**Interfaces:**
- Produces (package-private, `pkg/orchestrate`):
  - `worktreeDir(projectPath, key string) string` — same signature as today; moves from `worktree.go` to
    `worktreeroot.go`. Reads only: stats the legacy path, reads the marker.
  - `claimWorktreeDir(projectPath, key string) (string, error)` — creates the root (MkdirAll), claims the marker
    when the key has a UUID prefix and no legacy tree exists, and returns exactly what `worktreeDir` returns after
    the claim. Errors name the path that could not be written.
- Produces (exported, required: wshserver tests resolve keys from outside the package):
  - `WorktreeDir(projectPath, key string) string` — `worktreeDir` exported.
  - `UseWorktreeRootForTest(dir string) (restore func())`, in the style of `effortstore.UseRootForTest`. Pointing it
    at a regular file makes every `claimWorktreeDir` fail.

**Design decisions:**
- Split a key into run id + suffix only when its first 36 chars parse as a UUID (`github.com/google/uuid`, already a
  dependency) and the rest is empty or starts with `-`.
- The root comes from a `sync.Once` over `os.UserCacheDir()`; `UseWorktreeRootForTest` overrides it (and an empty
  root means the legacy layout, which is also what the `UserCacheDir` error path yields, logged once).
- Claim race: O_EXCL decides; the loser reads the winner's marker and resolves to the full-id path.
- Creation sites switch from `worktreeDir` to `claimWorktreeDir` and return its error through their existing error
  paths: `CreateRunWorktree` and the re-add in `EnsureRunWorktree` (`worktree.go`), `withDetachedTree`
  (`basecheck.go`, used by the base and bisect trees), `finalTree` (`final.go`; `freeFinalTreeDir` keeps appending
  `-N` to the resolved path). No other caller changes: `cleanup.go`, `rewind.go`, `mutation.go`, `engine.go`,
  `scheduler.go`, `land.go`, `verifier.go` and `dumpRecoveryPatch` keep calling `worktreeDir`.
- Update the comments in `worktree.go` that name `.waveterm/worktrees` (`addWorktree`, `CreateRunWorktree`).
- Test isolation is per test. About 100 orchestrate fixtures use non-UUID keys (`run-1`, `owner-1-t-1`); they used
  to sit in each test's own `t.TempDir()` project and would now collide under one root and outlive the test. The repo
  fixture helpers install a per-test root once per test (a second repo in the same test keeps the first one's root):
  `newGitRepo`/`newGitRepoAt` (`worktree_test.go`) call `t.Cleanup(UseWorktreeRootForTest(t.TempDir()))`, and so
  does wshserver's `newLandingRepo`; any other fixture that runs `git init` itself (`progress_test.go`,
  `wshserver_dag_test.go`, `wshserver_leadcomplete_test.go`) does the same. Neither package uses `t.Parallel`. Both
  TestMains (`pkg/orchestrate/maintest_test.go`, `pkg/wshrpc/wshserver/maintest_test.go`) also set a per-process
  temp root as a backstop, so nothing writes into the real user cache dir.
- Sites that hard-code the legacy tree switch to the resolver (`worktreeDir` in orchestrate, `orchestrate.WorktreeDir`
  in wshserver): `mutation_test.go:801`; `wshserver_landing_test.go:581` and `:637` (`LandPath` equals the run's
  tree); `:697` asserts no landing tree was created, so check `WorktreeDir(projectDir, run.ID)` does not exist instead
  of the now-vacuous `.waveterm/worktrees` stat; `wshserver_dag_test.go:589`, `:698`, `:831` (task tree path).
- `TestCreateRunCancelsWhenTheLandingTreeFails` (`wshserver_landing_test.go`, around :709) fails tree creation by
  writing a file at `.waveterm/worktrees`, which no longer fails anything; point `UseWorktreeRootForTest` at a file
  instead.

**Acceptance (focused tests):**
- [ ] `TestWorktreeDirMapping`: run key -> `<root>/<8>`, `<id>-t-3` -> `<root>/<8>-t-3`, `-final`, `-base`,
  `-bisect`, and a non-UUID key `run-1-t-0` -> `<root>/run-1-t-0`.
- [ ] `TestWorktreeDirLegacyWins`: with `<project>/.waveterm/worktrees/<key>` present, both `worktreeDir` and
  `claimWorktreeDir` return it and no marker is written; with it absent, the short path.
- [ ] `TestWorktreeDirForeignPrefixNeverShared`: a marker naming another run sends `claimWorktreeDir` and
  `worktreeDir` to `<root>/<full key>`; a real tree of the other run at `<root>/<8>-t-1` survives this run's
  `RemoveRunWorktree` and `EnsureRunWorktree` for the same suffix.
- [ ] `TestWorktreeDirEmptyMarker`: an empty marker resolves to the full-id path.
- [ ] `TestClaimWorktreeDirRace`: two goroutines claim different run ids with one prefix; exactly one resolves short,
  the other full-id, and each `worktreeDir` agrees with its claim.
- [ ] `TestClaimWorktreeDirCreatesRoot`: a root that does not exist is created; a root that cannot be created (a
  file in its place) returns an error naming the path.
- [ ] `TestEnsureRunWorktreeUnderShortRoot`: a lane tree is created under the test root on branch `wave/<full key>`
  and the marker holds the full run id.
- [ ] Windows only, `TestWorktreeOnSubstDrive` in `worktreeroot_windows_test.go`: map a free drive letter with
  `subst` to a temp dir holding a git project, create a lane tree under the test root (on another drive letter),
  run `git status` in it, remove it with `RemoveRunWorktree`; `t.Skip` when `subst` fails; always `subst /D` in
  cleanup.
- [ ] `TestCreateRunCancelsWhenTheLandingTreeFails` fails creation through a root that is a file and still cancels
  the run.
- [ ] The full suites pass, not a `-run` subset: `go test ./pkg/orchestrate` and `go test ./pkg/wshrpc/wshserver`
  (`ARC_VERIFY_CHANGED=<file> node scripts/verify.mjs ./pkg/orchestrate ./pkg/wshrpc/wshserver` deals them across
  processes), and the real `%LOCALAPPDATA%\arc-wt` holds nothing the tests made (no `run-1*` tree, no marker of a
  fixture run).

### Task 2: Claude mod guard recognises the new root
**Depends on:** none
**Files:** `claude/arc-mod/hooks/guard-core.ts`, `claude/arc-mod/hooks/guard-core.test.ts`, `cmd/wsh/cmd/claude-mod/hooks/guard-core.ts`

**Design decisions:**
- `ENGINE_TREE` matches either `[\\/]\.waveterm[\\/]worktrees[\\/][^\\/]+` (legacy) or `[\\/]arc-wt[\\/][^\\/]+`;
  update its comment to name both roots.
- Edit `claude/`, then run `task sync:claudemod` to refresh the copy under `cmd/wsh/cmd/claude-mod/`; never edit
  the copy by hand.

**Acceptance (focused tests):**
- [ ] In `guard-core.test.ts`: `git push`, `git worktree add` and `git switch` are refused from
  `C:\Users\k\AppData\Local\arc-wt\b74faed0-t-1\pkg` and `/home/k/.cache/arc-wt/b74faed0-t-1`; the legacy tree
  cases still refuse; `C:\Users\k\my-arc-wtx\repo` and the plain checkout let them through.
- [ ] `npx vitest run claude/arc-mod/hooks/guard-core.test.ts` passes; `claude plugin validate claude/arc-mod`
  passes; after `task sync:claudemod`, `diff claude/arc-mod/hooks/guard-core.ts cmd/wsh/cmd/claude-mod/hooks/guard-core.ts`
  prints nothing.

### Task 3: Docs name the short root
**Depends on:** Task 1
**Chunk:** Plan and implement: short task-worktree root under %LOCALAPPDATA%\arc-wt
**Files:** `docs/orchestrator-guide.md`, `docs/reference/cdp-run-fixtures.md`, `scripts/cdp/scenarios.mjs`

**Design decisions:**
- `docs/orchestrator-guide.md`: every place naming `.waveterm/worktrees` (the run tree around line 46, cleanup
  commands around 62-66, the bisect tree around 363, stalled-task lane trees around 695, the final tree around 774)
  names the new root (`%LOCALAPPDATA%\arc-wt\<first 8 of run id>…`, `os.UserCacheDir()/arc-wt` elsewhere), the
  full-id fallback when another run owns the prefix, and the legacy fallback for runs started before the change.
  Cleanup commands take the new path (`task worktree:cleanup -- %LOCALAPPDATA%\arc-wt\<8>`,
  `git worktree remove <path>` run from the project). Add one sentence on the behaviour change: workers no longer
  find untracked `CLAUDE.md` / `AGENTS.md` in the project's parent directories.
- `docs/reference/cdp-run-fixtures.md:84`: `fstStartLive` runs against the dev app's wavesrv, not Go tests, so the
  run's landing tree is under the real `%LOCALAPPDATA%\arc-wt\<8>`, not `.waveterm/worktrees/` in the temp dir, and
  the teardown's `rmSync` of the temp dir no longer removes it. Read `CancelRunCommand` (`pkg/wshrpc/wshserver`)
  and what it reaches in `pkg/orchestrate` to find whether cancelling a run removes its landing tree.
  - If it does, the doc says the teardown's existing `cancelrun` step removes the tree.
  - If it does not, every scenario in `scripts/cdp/scenarios.mjs` that creates a real run on a temp repo and
    tears down with `cancelrun` + `rmSync` (around lines 1136, 1350, 8172; grep for others) removes the run's
    `landpath` (read from the run before cancelling) after the cancel and before the `rmSync`, and the doc says so.
    A scenario change cannot be run in this task; say so in the report.
- `AGENTS.md` names no `.waveterm/worktrees` and is not changed; `docs/orchestrator-redesign-flaws.md` keeps its
  historical paths.

**Acceptance:**
- [ ] `grep -n "waveterm/worktrees\|waveterm\\\\worktrees" docs/orchestrator-guide.md docs/reference/cdp-run-fixtures.md`
  shows only lines that describe the legacy fallback.
- [ ] Paths and names in the docs match Task 1's code (root, marker name, fallback order).
- [ ] The report states which branch of the cancel question held, with the function that removes (or does not
  remove) the tree; with a scenario change, `node --check scripts/cdp/scenarios.mjs` passes.
