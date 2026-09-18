# Orchestrator Redesign Slice 4c: Setup and Merge-Point Verify

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine runs a plan's `**Setup:**` command in every new task worktree, and its `**Verify:**` command in the project checkout after every squash merge. A failing Verify puts the task in `verify-failed` and wakes the lead, and `dag merge <task> --continue` re-runs it. Merges in one checkout wait for the running Verify, and `dag status` carries the run-end report numbers.

**Architecture:**
- Task worktree removal first unlinks every junction and symlink inside the tree. `git worktree remove --force` deletes through a junction on Windows (probed 2026-09-15), and `task worktree:prepare` junctions the main checkout's `node_modules`, `src-tauri/target` and `dist/bin` into a worktree. The howto claimed this fix as `f927dea9`; that commit is not in the repository.
- `TaskGroup` stores the plan's `Verify` and `Setup`. `execPlanCommand` runs either through `cmd.exe /d /s /c` or `sh -c` with a timeout and keeps the output tail.
- Setup runs synchronously at dispatch, only when `EnsureRunWorktree` created the tree. A failure removes the tree and fails the task with kind `setup`.
- A squash merge persists the task as `verifying` when the dag has a Verify line. Verify runs in a goroutine, never under the dag mutation lock. It records `done` or `verify-failed`, then ticks the dag.
- A per-project in-memory landing claim serializes a merge and the Verify after it. `AutoMergeReady` holds a dag's later merges while one of its tasks is `verifying` or `verify-failed`, and restarts a `verifying` task whose Verify died with the server.
- `DeriveTaskStates` no longer re-derives `blocked-merge`, `verifying` or `verify-failed` from a done child. Today a done child flips `blocked-merge` back to `done` on the next tick. The merge stamp therefore writes `done` or `verifying` itself.
- `dag merge --continue` moves into `orchestrate.ContinueMerge`, which handles both a resolved conflict and a failed Verify.

**Tech Stack:** Go (`pkg/orchestrate`, `pkg/waveobj`, `pkg/wshrpc`, codegen via `task generate`), cobra (`cmd/wsh`), React 19 + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md` §4 (Worktrees and Setup, Tests, Merges, End of run and report), §2 (Judgment events: the Verify wake line), §12 (Merge-point Verify tests), §13 (slice 4c), §14 (`VerifyTimeout`).

## Global Constraints

- **Constants:**
  - `VerifyTimeout = 20 * time.Minute` (spec §14)
  - `SetupTimeout = 2 * time.Minute` (chosen here, not measured: Setup runs under the dag mutation lock, so it is for preparing a tree, not installing)
  - `MaxPlanOutputLen = 1000` (chosen here: the kept tail of a failing command's output)
  - `planCommandWaitDelay = 5 * time.Second` (chosen here: bounds the wait for a killed shell's children holding the output pipe)
- **Wake line** (spec §2): `wake: Verify failed after merging task t-5 (exit 1). wsh jarvis dag status`, and `(timed out after 20m)` for a timeout. A Setup failure uses the existing `wake: task t-1 failed (setup), retry spent. wsh jarvis dag status`.
- **Task states added:** `verifying` (merged, Verify running) and `verify-failed` (merged, Verify failed or timed out). A dependent waits on both, because `depSatisfied` requires `done`.
- **Failure kind added:** `setup` (spec §4 names it).
- **Digest:** a `verify-failed` task reads wait reason `verify` and human action `resolve-merge` (the same fix-in-tree-then-`--continue` action as a conflict). A running Verify with nothing else to do reads next step `verify-wait`.
- **Run events added:** `task-verify-started` (`taskid`), `task-verify-passed` (`taskid`, `ms`), `task-verify-failed` (`taskid`, `reason`, `detail`).
- **Not in this slice:** lanes, lane-tip merges and the spec/plan fold (4d). Verify runs at today's per-task merge points.
- **Known limits, recorded in `docs/deferred.md` by Task 7:** a timeout kills the shell but not the processes it started, and a persisted `verify-failed` task holds only its own dag's merges, not another run's in the same checkout.
- No emojis. Comments are lower case and say why, never what.
- Never hand-edit generated files. Run `task generate` after changing a `wshrpc` or `waveobj` type.
- Go tests for `orchestrate` and `wshserver` need CGO flags. From PowerShell at the repo root:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  ```
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (`npx tsc` overflows).
- The working tree holds another session's uncommitted files: `frontend/app/view/jarvis/*`, `docs/prototype/jarvis-compact-attention.html`, `scripts/cdp/scenarios.mjs`, and the version bump in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`. Never stage them.
- Two commits: Task 1 on its own (a safety fix that stands alone), then Tasks 2-7 as one commit with this plan folded in. No co-author trailer, no push.
- Tests that create a file already present in the package must use a new file name: the Write tool replaces an existing file. Add to an existing test file with Edit.

## Task order

1. Junction-safe worktree removal.
2. Plan commands on the dag, and Setup at dispatch.
3. Verify after each squash merge.
4. `dag merge --continue` on a failed Verify, and `dag forward` for it.
5. Digest, report numbers and `dag status`.
6. Frontend: states, actions, timeline rows, next step, report chips.
7. Docs, full verification, commit.

---

### Task 1: Junction-safe worktree removal

**Files:**
- Modify: `pkg/orchestrate/worktree.go` (`RemoveRunWorktree`, new `unlinkReparsePoints`)
- Create: `pkg/orchestrate/worktree_junction_windows_test.go`
- Modify: `docs/orchestrator-howto.md` (the junction section's false commit reference)

**Interfaces:**
- Consumes: nothing new.
- Produces: `func unlinkReparsePoints(wt string) error`. `RemoveRunWorktree` keeps its signature and calls it before `git worktree remove --force`.

Probed facts this task relies on (2026-09-15, Go 1.26 on Windows 11):
- `git worktree remove --force` on a tree holding a junction exits 0 and empties the junction's target.
- `os.Lstat` and `filepath.WalkDir` report a junction as `ModeIrregular`, not `ModeSymlink` and not a directory, so `WalkDir` does not descend into it.
- `os.Remove` on a junction removes the link and leaves the target intact.

- [ ] **Step 1: Write the failing test**

Create `pkg/orchestrate/worktree_junction_windows_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package orchestrate

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func mklinkJunction(t *testing.T, link, target string) {
	t.Helper()
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Fatalf("mklink /J %s %s: %v\n%s", link, target, err, out)
	}
}

// task worktree:prepare junctions the main checkout's node_modules, src-tauri/target and dist/bin into a
// worktree, and git worktree remove --force deletes through a junction on Windows.
func TestRemoveRunWorktreeLeavesJunctionTargetsIntact(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, err := CreateRunWorktree(context.Background(), dir, "run-1", base)
	if err != nil {
		t.Fatal(err)
	}
	shared := t.TempDir()
	keep := filepath.Join(shared, "keep.txt")
	if err := os.WriteFile(keep, []byte("keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mklinkJunction(t, filepath.Join(wt, "node_modules"), shared)
	if err := os.MkdirAll(filepath.Join(wt, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	mklinkJunction(t, filepath.Join(wt, "dist", "bin"), shared)

	if err := RemoveRunWorktree(context.Background(), dir, "run-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("worktree must be removed, stat err = %v", err)
	}
	if b, err := os.ReadFile(keep); err != nil || string(b) != "keep\n" {
		t.Fatalf("a junction target must survive worktree removal, got %q err %v", b, err)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

From PowerShell at the repo root, with `CGO_CFLAGS` set as in Global Constraints:

Run: `go test ./pkg/orchestrate -run TestRemoveRunWorktreeLeavesJunctionTargetsIntact -count=1`
Expected: FAIL with `a junction target must survive worktree removal, got "" err open ...keep.txt: The system cannot find the file specified.`

- [ ] **Step 3: Implement**

In `pkg/orchestrate/worktree.go`, add `"io/fs"` to the imports, then replace the head of `RemoveRunWorktree`:

```go
// RemoveRunWorktree removes the linked worktree and its branch.
func RemoveRunWorktree(ctx context.Context, projectPath, runID string) error {
	wt := worktreeDir(projectPath, runID)
	if _, err := os.Stat(wt); err != nil {
		return nil // nothing to remove
	}
	if _, err := git(ctx, projectPath, "worktree", "remove", "--force", wt); err != nil {
```

with:

```go
// RemoveRunWorktree removes the linked worktree and its branch.
func RemoveRunWorktree(ctx context.Context, projectPath, runID string) error {
	wt := worktreeDir(projectPath, runID)
	if _, err := os.Stat(wt); err != nil {
		return nil // nothing to remove
	}
	// before git sees the tree: its forced removal deletes through a junction into the target
	if err := unlinkReparsePoints(wt); err != nil {
		return fmt.Errorf("removing worktree: %w", err)
	}
	if _, err := git(ctx, projectPath, "worktree", "remove", "--force", wt); err != nil {
```

Add below `isWorktreeRegistered`:

```go
// unlinkReparsePoints removes every symlink and junction inside wt without following it. A junction
// reads as ModeIrregular rather than ModeSymlink, so both bits are checked; WalkDir does not descend
// into either.
func unlinkReparsePoints(wt string) error {
	return filepath.WalkDir(wt, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == wt || d.Type()&(fs.ModeSymlink|fs.ModeIrregular) == 0 {
			return nil
		}
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("unlinking %s: %w", path, err)
		}
		return nil
	})
}
```

- [ ] **Step 4: Run the package tests**

Run: `go test ./pkg/orchestrate -count=1`
Expected: PASS, including `TestRemoveRunWorktreeLeavesJunctionTargetsIntact` and the existing worktree and cleanup tests.

- [ ] **Step 5: Correct the howto**

In `docs/orchestrator-howto.md`, replace:

```
`ModeSymlink`, so a check for symlinks alone finds nothing. Committed as `f927dea9`.
```

with:

```
`ModeSymlink`, so a check for symlinks alone finds nothing. An earlier version of this section cited a
commit, `f927dea9`, that never reached the repository. The fix landed on 2026-09-15, as the first task of
the orchestrator redesign's slice 4c plan.
```

- [ ] **Step 6: Commit**

```bash
gofmt -l pkg/orchestrate
git add pkg/orchestrate/worktree.go pkg/orchestrate/worktree_junction_windows_test.go docs/orchestrator-howto.md
git commit -m "fix(orchestrate): unlink junctions before removing a task worktree, so cleanup cannot delete the main checkout's node_modules through them"
```

`gofmt -l` must print nothing.

---

### Task 2: Plan commands on the dag, and Setup at dispatch

**Files:**
- Modify: `pkg/waveobj/wtype.go` (`TaskGroup.Verify`, `TaskGroup.Setup`)
- Modify: `pkg/waveobj/runevent.go` (the `task-spawned` detail line gains `setupms`)
- Modify: `pkg/orchestrate/dag.go` (`SameDagProposal`)
- Create: `pkg/orchestrate/plancmd.go`, `pkg/orchestrate/plancmd_windows.go`, `pkg/orchestrate/plancmd_other.go`
- Create: `pkg/orchestrate/plancmd_test.go`
- Modify: `pkg/orchestrate/worktree.go` (`EnsureRunWorktree` reports whether it created the tree)
- Modify: `pkg/orchestrate/worktree_test.go`, `pkg/orchestrate/mutation_test.go` (call sites)
- Modify: `pkg/orchestrate/retry.go` (`FailureKindSetup`)
- Modify: `pkg/orchestrate/engine.go` (Setup at dispatch)
- Create: `pkg/orchestrate/setup_test.go`
- Modify: `pkg/orchestrate/dag_test.go` (append a test)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`loadDagPlan` returns the plan; the group carries its commands)
- Modify: `pkg/wshrpc/wshserver/wshserver_dagplan_test.go` (append a subtest)
- Modify: `docs/orchestrator-howto.md` ("The engine does not run it for you")
- Regenerate: `task generate` (updates `frontend/types/gotypes.d.ts`)

**Interfaces:**
- Consumes: `jarvis.Plan.Verify`, `jarvis.Plan.Setup` (S4a).
- Produces:
  - `TaskGroup.Verify string` (`json:"verify,omitempty"`), `TaskGroup.Setup string` (`json:"setup,omitempty"`)
  - `const SetupTimeout`, `const VerifyTimeout`, `const MaxPlanOutputLen`
  - `type planCommandError struct { exitCode int; timeout time.Duration; output string }` with `reason() string` (`"exit 1"` or `"timed out after 20m"`) and `Error() string` (`reason()`, then `": "` and the output when there is any)
  - `var runPlanCommand func(ctx context.Context, dir, command string, timeout time.Duration) error`, defaulting to `execPlanCommand`
  - `func shellCommand(ctx context.Context, command string) *exec.Cmd` (per platform)
  - `func EnsureRunWorktree(ctx context.Context, projectPath, runID, baseCommit string) (string, bool, error)`: the bool is true when this call created the tree
  - `const FailureKindSetup = "setup"`
  - test helpers in `setup_test.go`, used again by Tasks 3 and 4: `type planCall struct{ dir, command string }`, `type planCalls` with `list() []planCall`, `stubPlanCommand(t, fn func(ctx context.Context, dir, command string) error) *planCalls`, and `(*mergeFixture).setPlanCommands(t, verify, setup string)`

- [ ] **Step 1: Write the failing plan-command tests**

Create `pkg/orchestrate/plancmd_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestPlanCommandPassesQuotedArgumentsThrough(t *testing.T) {
	dir := newGitRepo(t)
	if err := execPlanCommand(context.Background(), dir, `git config wave.probe "two words"`, time.Minute); err != nil {
		t.Fatal(err)
	}
	if got := gitCmd(t, dir, "config", "wave.probe"); got != "two words" {
		t.Fatalf("the shell must hand the command over unchanged, got %q", got)
	}
}

func TestPlanCommandReportsExitCodeAndOutput(t *testing.T) {
	err := execPlanCommand(context.Background(), newGitRepo(t), "git no-such-subcommand", time.Minute)
	var pe *planCommandError
	if !errors.As(err, &pe) {
		t.Fatalf("want a planCommandError, got %v", err)
	}
	if pe.reason() != "exit 1" || !strings.Contains(pe.output, "no-such-subcommand") {
		t.Fatalf("want exit 1 with git's message, got %q / %q", pe.reason(), pe.output)
	}
}

func TestPlanCommandTimesOut(t *testing.T) {
	slow := "sleep 5"
	if runtime.GOOS == "windows" {
		slow = "ping -n 6 127.0.0.1 >NUL 2>&1"
	}
	err := execPlanCommand(context.Background(), t.TempDir(), slow, 200*time.Millisecond)
	var pe *planCommandError
	if !errors.As(err, &pe) || pe.reason() != "timed out after 200ms" {
		t.Fatalf("want a timeout, got %v", err)
	}
}

func TestTailBufferKeepsTheEnd(t *testing.T) {
	b := &tailBuffer{max: 5}
	b.Write([]byte("abc"))
	b.Write([]byte("defgh"))
	if got := b.String(); got != "defgh" {
		t.Fatalf("want the last 5 bytes, got %q", got)
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test ./pkg/orchestrate -run 'TestPlanCommand|TestTailBuffer' -count=1`
Expected: build FAIL with `undefined: execPlanCommand`.

- [ ] **Step 3: Implement the plan command runner**

Create `pkg/orchestrate/plancmd.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const (
	// SetupTimeout bounds a plan's Setup command. It runs under the dag mutation lock, so Setup is for
	// preparing a worktree (junctions, a config file), not for an install.
	SetupTimeout = 2 * time.Minute
	// VerifyTimeout bounds a plan's Verify command at a merge point.
	VerifyTimeout = 20 * time.Minute
	// MaxPlanOutputLen is how much of a failing command's output is kept: the tail, where a test runner
	// prints its failures.
	MaxPlanOutputLen = 1000
	// a killed shell's children can hold its output pipe open; this bounds the wait for them.
	planCommandWaitDelay = 5 * time.Second
)

// planCommandError is a Setup or Verify command that did not exit 0.
type planCommandError struct {
	exitCode int           // -1 when there is no exit code to report
	timeout  time.Duration // set when the command was killed at its timeout
	output   string
}

// reason is the short cause a wake line carries.
func (e *planCommandError) reason() string {
	if e.timeout > 0 {
		return "timed out after " + shortDuration(e.timeout)
	}
	return fmt.Sprintf("exit %d", e.exitCode)
}

func (e *planCommandError) Error() string {
	if e.output == "" {
		return e.reason()
	}
	return e.reason() + ": " + e.output
}

func shortDuration(d time.Duration) string {
	if d >= time.Minute && d%time.Minute == 0 {
		return fmt.Sprintf("%dm", int(d/time.Minute))
	}
	return d.String()
}

// runPlanCommand runs a plan command through the platform shell in dir. A var so engine tests can
// script Setup and Verify without running anything.
var runPlanCommand = execPlanCommand

func execPlanCommand(ctx context.Context, dir, command string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	c := shellCommand(ctx, command)
	c.Dir = dir
	c.WaitDelay = planCommandWaitDelay
	out := &tailBuffer{max: MaxPlanOutputLen}
	c.Stdout, c.Stderr = out, out
	err := c.Run()
	if err == nil {
		return nil
	}
	pe := &planCommandError{exitCode: -1, output: out.String()}
	var exitErr *exec.ExitError
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		pe.timeout = timeout
	case errors.As(err, &exitErr):
		pe.exitCode = exitErr.ExitCode()
	case pe.output == "":
		pe.output = err.Error()
	}
	return pe
}

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	max int
	buf []byte
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.buf = append(b.buf, p...)
	if over := len(b.buf) - b.max; over > 0 {
		b.buf = append(b.buf[:0], b.buf[over:]...)
	}
	return len(p), nil
}

// String drops a multi-byte character the cut went through rather than rendering half of it.
func (b *tailBuffer) String() string {
	return strings.TrimSpace(strings.ToValidUTF8(string(b.buf), ""))
}
```

Create `pkg/orchestrate/plancmd_windows.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package orchestrate

import (
	"context"
	"os/exec"
	"syscall"
)

// shellCommand sets the whole command line: /s strips only the outer quotes, so quotes inside a plan
// command reach the program unchanged, which Go's per-argument escaping does not guarantee for cmd.exe.
func shellCommand(ctx context.Context, command string) *exec.Cmd {
	c := exec.CommandContext(ctx, "cmd.exe")
	c.SysProcAttr = &syscall.SysProcAttr{CmdLine: `cmd.exe /d /s /c "` + command + `"`}
	return c
}
```

Create `pkg/orchestrate/plancmd_other.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package orchestrate

import (
	"context"
	"os/exec"
)

func shellCommand(ctx context.Context, command string) *exec.Cmd {
	return exec.CommandContext(ctx, "sh", "-c", command)
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `go test ./pkg/orchestrate -run 'TestPlanCommand|TestTailBuffer' -count=1`
Expected: PASS (the timeout test takes about a second).

- [ ] **Step 5: Store the plan's commands on the group**

In `pkg/waveobj/wtype.go`, add at the end of `TaskGroup`, after the `NotifiedCondition` block:

```go
	NotifiedCondition string `json:"notifiedcondition,omitempty"`

	// Verify and Setup are the plan's commands (jarvis.PlanFormat). Setup runs in each new task worktree
	// before its worker spawns; Verify runs in the project checkout after each squash merge. Both are
	// empty for a dag submitted as JSON, which is then prepared by nobody and reported unverified.
	Verify string `json:"verify,omitempty"`
	Setup  string `json:"setup,omitempty"`
}
```

In `pkg/orchestrate/dag.go`, `SameDagProposal`, replace:

```go
	if a.Title != b.Title || a.Parallelism != b.Parallelism || a.MergeRequired != b.MergeRequired || len(a.Tasks) != len(b.Tasks) {
```

with:

```go
	if a.Title != b.Title || a.Parallelism != b.Parallelism || a.MergeRequired != b.MergeRequired ||
		a.Verify != b.Verify || a.Setup != b.Setup || len(a.Tasks) != len(b.Tasks) {
```

Append to `pkg/orchestrate/dag_test.go`:

```go
func TestSameDagProposalComparesPlanCommands(t *testing.T) {
	a, err := NewTaskGroup("run", "channel", "title", 1, true, []waveobj.TaskNode{{ID: "t-1", Label: "one"}}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	b := a
	b.Verify = "task test"
	if SameDagProposal(&a, &b) {
		t.Fatal("a resubmitted plan with a different Verify is a different proposal")
	}
	b.Verify, b.Setup = "", "task worktree:prepare"
	if SameDagProposal(&a, &b) {
		t.Fatal("a resubmitted plan with a different Setup is a different proposal")
	}
}
```

In `pkg/wshrpc/wshserver/wshserver_dag.go`, replace `loadDagPlan` with:

```go
// loadDagPlan fills a submit's tasks, and its title and width when unset, from its plan file, and
// returns the plan for its Verify and Setup commands. wavesrv does not share the caller's cwd, so only an
// absolute path names the file the caller meant.
func loadDagPlan(data *wshrpc.CommandDagSubmitData) (jarvis.Plan, error) {
	if !filepath.IsAbs(data.PlanPath) {
		return jarvis.Plan{}, fmt.Errorf("planpath %q must be absolute", data.PlanPath)
	}
	if len(data.Tasks) > 0 {
		return jarvis.Plan{}, fmt.Errorf("pass tasks or planpath, not both")
	}
	src, err := os.ReadFile(data.PlanPath)
	if err != nil {
		return jarvis.Plan{}, fmt.Errorf("reading plan: %w", err)
	}
	plan, err := jarvis.ParsePlan(string(src))
	if err != nil {
		return jarvis.Plan{}, fmt.Errorf("plan %s: %w", data.PlanPath, err)
	}
	data.Tasks = plan.Tasks
	if data.Title == "" {
		data.Title = plan.Title
	}
	if data.Title == "" {
		data.Title = strings.TrimSuffix(filepath.Base(data.PlanPath), filepath.Ext(data.PlanPath))
	}
	if data.Parallelism == 0 {
		data.Parallelism = orchestrate.DefaultParallelism(plan.Tasks)
	}
	return plan, nil
}
```

In `DagSubmitCommand`, replace:

```go
	if data.PlanPath != "" {
		if err := loadDagPlan(&data); err != nil {
			return nil, err
		}
	}
```

with:

```go
	var plan jarvis.Plan
	if data.PlanPath != "" {
		loaded, err := loadDagPlan(&data)
		if err != nil {
			return nil, err
		}
		plan = loaded
	}
```

and replace:

```go
	proposed, err := orchestrate.NewTaskGroup(data.RunId, data.ChannelId, data.Title, parallelism, mergeRequired, data.Tasks, time.Now().UnixMilli(), workerRoute)
	if err != nil {
		return nil, err
	}
```

with:

```go
	proposed, err := orchestrate.NewTaskGroup(data.RunId, data.ChannelId, data.Title, parallelism, mergeRequired, data.Tasks, time.Now().UnixMilli(), workerRoute)
	if err != nil {
		return nil, err
	}
	proposed.Verify, proposed.Setup = plan.Verify, plan.Setup
```

In `pkg/wshrpc/wshserver/wshserver_dagplan_test.go`, add a subtest after the `"a rejected plan leaves the run free to take a valid one"` subtest, before the function's closing brace:

```go
	t.Run("the plan's Verify and Setup commands are stored on the dag", func(t *testing.T) {
		channelId, runId := newRun(t)
		src := "**Verify:** `task test`\n**Setup:** `task worktree:prepare`\n\n### Task 1: input\n"
		g, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, PlanPath: writePlan(t, "plan.md", src)})
		if err != nil {
			t.Fatal(err)
		}
		if g.Verify != "task test" || g.Setup != "task worktree:prepare" {
			t.Fatalf("verify %q, setup %q", g.Verify, g.Setup)
		}
	})
```

Run `task generate`, then:

Run: `go test ./pkg/orchestrate -run TestSameDagProposalComparesPlanCommands -count=1` and `go test ./pkg/wshrpc/wshserver -run TestDagSubmitFromPlanPath -count=1`
Expected: PASS.

- [ ] **Step 6: Report whether a worktree was created**

In `pkg/orchestrate/worktree.go`, replace `EnsureRunWorktree` with:

```go
// EnsureRunWorktree returns a usable linked worktree for runID at baseCommit, and whether this call
// created it, so one-time preparation runs only on a fresh tree. An existing tree is reused only when its
// branch still exists and the tree is clean — a clean tree whose head sits past baseCommit is committed
// child work that merge needs later, so it stays; anything dirty or unverifiable gets its uncommitted
// state dumped to a recovery patch and is rebuilt from baseCommit.
func EnsureRunWorktree(ctx context.Context, projectPath, runID, baseCommit string) (string, bool, error) {
	wt := worktreeDir(projectPath, runID)
	if _, err := os.Stat(wt); err == nil {
		usable := false
		if _, err := WorktreeHeadCommit(ctx, projectPath, runID); err == nil {
			status, serr := git(ctx, wt, "status", "--porcelain")
			// any dirt forces a rebuild (dump first); a clean tree is reused even when its head
			// sits past baseCommit — that divergence is committed child work merge needs later
			if serr == nil && strings.TrimSpace(status) == "" {
				usable = true
			}
		}
		if usable {
			return wt, false, nil
		}
		DumpRecoveryPatch(ctx, projectPath, runID) // best effort; rebuild proceeds either way
		if err := RemoveRunWorktree(ctx, projectPath, runID); err != nil {
			return "", false, fmt.Errorf("recreating stale worktree: %w", err)
		}
	}
	wt, err := CreateRunWorktree(ctx, projectPath, runID, baseCommit)
	return wt, err == nil, err
}
```

In `pkg/orchestrate/worktree_test.go`:
- `TestEnsureRunWorktreeReusesCleanTree`: replace `got, err := EnsureRunWorktree(context.Background(), dir, key, base)` with `got, created, err := EnsureRunWorktree(context.Background(), dir, key, base)`, and after its `if err != nil { t.Fatal(err) }` add:
  ```go
	if created {
		t.Fatal("a reused tree was not created by this call")
	}
  ```
- `TestEnsureRunWorktreeKeepsCommittedWorkWhenBaseAdvanced`: replace `got, err := EnsureRunWorktree(context.Background(), dir, key, newBase)` with `got, _, err := EnsureRunWorktree(context.Background(), dir, key, newBase)`.
- `TestEnsureRunWorktreeRecreatesDirtyAndDumpsPatch`: replace
  ```go
	if _, err := EnsureRunWorktree(context.Background(), dir, key, base); err != nil {
		t.Fatal(err)
	}
  ```
  with
  ```go
	if _, created, err := EnsureRunWorktree(context.Background(), dir, key, base); err != nil || !created {
		t.Fatalf("a dirty tree is rebuilt, so this call creates it: created=%v err=%v", created, err)
	}
  ```

In `pkg/orchestrate/mutation_test.go`, replace `if _, err := EnsureRunWorktree(ctx, projectDir, TaskWorktreeKey(owner.ID, "t-0"), owner.BaseCommit); err != nil {` with `if _, _, err := EnsureRunWorktree(ctx, projectDir, TaskWorktreeKey(owner.ID, "t-0"), owner.BaseCommit); err != nil {`.

- [ ] **Step 7: Write the failing Setup tests**

Create `pkg/orchestrate/setup_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

type planCall struct{ dir, command string }

// planCalls records the Setup and Verify commands the engine ran. Verify runs on its own goroutine, so
// reads go through list.
type planCalls struct {
	mu    sync.Mutex
	calls []planCall
}

func (p *planCalls) list() []planCall {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]planCall(nil), p.calls...)
}

func stubPlanCommand(t *testing.T, fn func(ctx context.Context, dir, command string) error) *planCalls {
	t.Helper()
	p := &planCalls{}
	orig := runPlanCommand
	runPlanCommand = func(ctx context.Context, dir, command string, _ time.Duration) error {
		p.mu.Lock()
		p.calls = append(p.calls, planCall{dir, command})
		p.mu.Unlock()
		return fn(ctx, dir, command)
	}
	t.Cleanup(func() { runPlanCommand = orig })
	return p
}

// setPlanCommands gives the fixture's dag the plan-level commands a plan file would.
func (f *mergeFixture) setPlanCommands(t *testing.T, verify, setup string) {
	t.Helper()
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Verify, cur.Setup = verify, setup
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

const setupCmd = "task worktree:prepare"

func TestDispatchRunsSetupInTheNewWorktreeBeforeTheWorker(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, "", setupCmd)
	var spawned []string
	spawnedAtSetup := -1
	calls := stubPlanCommand(t, func(context.Context, string, string) error {
		spawnedAtSetup = len(spawned)
		return nil
	})
	stubSpawn(t, &spawned)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	wt := worktreeDir(f.project, TaskWorktreeKey(f.ownerID, "t-0"))
	if got := calls.list(); len(got) != 1 || got[0].dir != wt || got[0].command != setupCmd {
		t.Fatalf("want Setup once in %s, got %+v", wt, got)
	}
	if spawnedAtSetup != 0 || len(spawned) != 1 {
		t.Fatalf("Setup runs before the worker spawns: spawns at setup %d, after %d", spawnedAtSetup, len(spawned))
	}
}

func TestSetupFailureFailsTheTaskDropsItsWorktreeAndWakesTheLead(t *testing.T) {
	lead := newFakeLead(t)
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, "", setupCmd)
	stubPlanCommand(t, func(context.Context, string, string) error {
		return &planCommandError{exitCode: 1, output: "task: not found"}
	})
	var spawned []string
	stubSpawn(t, &spawned)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	task := f.dag(t).Tasks[0]
	if task.State != TaskState_Failed || task.LastFailureKind != FailureKindSetup {
		t.Fatalf("want failed (setup), got %s (%s)", task.State, task.LastFailureKind)
	}
	if len(spawned) != 0 {
		t.Fatalf("no worker spawns into an unprepared tree, got %d", len(spawned))
	}
	if _, err := os.Stat(worktreeDir(f.project, TaskWorktreeKey(f.ownerID, "t-0"))); !os.IsNotExist(err) {
		t.Fatalf("a half-prepared tree must go, so a retry sets up a new one; stat err = %v", err)
	}
	want := "wake: task t-0 failed (setup), retry spent. wsh jarvis dag status"
	if len(lead.sends) != 1 || lead.sends[0] != want {
		t.Fatalf("want %q, got %q", want, lead.sends)
	}
}

func TestNoSetupLineRunsNothing(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	calls := stubPlanCommand(t, func(context.Context, string, string) error { return nil })
	var spawned []string
	stubSpawn(t, &spawned)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if got := calls.list(); len(got) != 0 {
		t.Fatalf("a plan without Setup runs no command, got %+v", got)
	}
}
```

- [ ] **Step 8: Run them to verify they fail**

Run: `go test ./pkg/orchestrate -run 'TestDispatchRunsSetup|TestSetupFailure|TestNoSetupLine' -count=1`
Expected: FAIL (`undefined: FailureKindSetup` at build, and once that exists, `want Setup once`).

- [ ] **Step 9: Run Setup at dispatch**

In `pkg/orchestrate/retry.go`, add to the dispatch failure kinds:

```go
	FailureKindWorktree   = "worktree-failed"
	FailureKindSetup      = "setup" // the plan's Setup command failed in a new worktree
	FailureKindSpawn      = "spawn-failed"
```

In `pkg/orchestrate/engine.go`, `scheduleLocked`, replace:

```go
		cwd := owner.ProjectPath
		var worktreeMs int64
		if IsGitRepo(owner.ProjectPath) {
			wtStart := time.Now()
			wt, werr := EnsureRunWorktree(spawnCtx, owner.ProjectPath, TaskWorktreeKey(owner.ID, taskID), spawnBase)
			worktreeMs = time.Since(wtStart).Milliseconds()
			if werr != nil {
				failDispatch(ctx, g, taskID, FailureKindWorktree, werr, &afterCommit)
				continue
			}
			cwd = wt
		}
```

with:

```go
		cwd := owner.ProjectPath
		var worktreeMs, setupMs int64
		if IsGitRepo(owner.ProjectPath) {
			key := TaskWorktreeKey(owner.ID, taskID)
			wtStart := time.Now()
			wt, created, werr := EnsureRunWorktree(spawnCtx, owner.ProjectPath, key, spawnBase)
			worktreeMs = time.Since(wtStart).Milliseconds()
			if werr != nil {
				failDispatch(ctx, g, taskID, FailureKindWorktree, werr, &afterCommit)
				continue
			}
			if created && g.Setup != "" {
				setupStart := time.Now()
				serr := runPlanCommand(context.WithoutCancel(ctx), wt, g.Setup, SetupTimeout)
				setupMs = time.Since(setupStart).Milliseconds()
				if serr != nil {
					// only a new tree is set up, so a retry would reuse this half-prepared one as-is
					if rerr := RemoveRunWorktree(context.WithoutCancel(ctx), owner.ProjectPath, key); rerr != nil {
						log.Printf("schedule dag %s task %s: removing worktree after setup failure: %v", g.OID, taskID, rerr)
					}
					failDispatch(ctx, g, taskID, FailureKindSetup, serr, &afterCommit)
					continue
				}
			}
			cwd = wt
		}
```

and in the same function replace:

```go
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskSpawned, nil, map[string]any{"taskid": spawnedTaskID, "worktreems": worktreeMs, "spawnms": spawnMs})
```

with:

```go
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskSpawned, nil, map[string]any{"taskid": spawnedTaskID, "worktreems": worktreeMs, "setupms": setupMs, "spawnms": spawnMs})
```

In `pkg/waveobj/runevent.go`, replace `//   task-spawned:     "taskid" string, "worktreems" int64, "spawnms" int64` with `//   task-spawned:     "taskid" string, "worktreems" int64, "setupms" int64, "spawnms" int64`.

- [ ] **Step 10: Run the package tests**

Run: `go test ./pkg/orchestrate -count=1` and `go test ./pkg/wshrpc/wshserver -count=1`
Expected: PASS.

- [ ] **Step 11: Update the howto**

In `docs/orchestrator-howto.md`, replace:

```
and spends its one question asking you why. **The engine does not run it for you** — `CreateRunWorktree`
is a plain `git worktree add` — so if your tasks need `node_modules`, say so in the task description.
```

with:

```
and spends its one question asking you why. **The engine runs it for you when the plan says so:** a plan
line `` **Setup:** `task worktree:prepare` `` runs in every new task worktree before its worker starts, and
a Setup that fails fails the task with kind `setup`.
```

No commit: Tasks 2-7 land together in Task 7.

---

### Task 3: Verify after each squash merge

**Files:**
- Modify: `pkg/waveobj/wtype.go` (`TaskNode.VerifyError`, the `State` comment)
- Modify: `pkg/waveobj/runevent.go` (three verify kinds)
- Modify: `pkg/orchestrate/dag.go` (states, `landingState`, `DeriveTaskStates`, `RecomputeDagStatus`, `NewTaskGroup`)
- Modify: `pkg/orchestrate/queue.go` (`verifyFailedWake`)
- Create: `pkg/orchestrate/verify.go`
- Modify: `pkg/orchestrate/mergetask.go` (claim, stamp state, hand off to Verify, `AutoMergeReady`)
- Modify: `pkg/orchestrate/mutation.go` (cancel stops Verify)
- Modify: `pkg/orchestrate/dag_test.go` (append a test)
- Create: `pkg/orchestrate/verify_test.go`
- Regenerate: `task generate`

**Interfaces:**
- Consumes: `runPlanCommand`, `planCommandError`, `VerifyTimeout`, `TaskGroup.Verify`, `stubPlanCommand`, `planCalls`, `(*mergeFixture).setPlanCommands` (Task 2); `stubMerge`, `stubSpawn`, `newMergeFixture` (`mergetask_test.go`); `newFakeLead` (`wake_test.go`).
- Produces:
  - `const TaskState_Verifying = "verifying"`, `const TaskState_VerifyFailed = "verify-failed"`
  - `TaskNode.VerifyError string` (`json:"verifyerror,omitempty"`)
  - `waveobj.RunEventKindTaskVerifyStarted`, `RunEventKindTaskVerifyPassed`, `RunEventKindTaskVerifyFailed`
  - `var errProjectBusy`, `type landing`, `func claimProject(projectPath, dagID, taskID string) (*landing, error)`, `func releaseProject(projectPath string, l *landing)`, `func stopDagVerify(dagID string)`
  - `func startVerify(channelID, dagID, runID, taskID, projectPath, command string, l *landing)`
  - `func landAfterMerge(channelID string, owner *waveobj.Run, taskID, verify string, l *landing)`
  - `var verifyFinished func(dagID, taskID string)`: called when a Verify run has recorded its result and ticked its dag
  - `func FinishMergedTask(ctx context.Context, channelID, dagID, childRunID, taskID, sha string) (string, error)`: now also returns the Verify command the task waits on
  - `func verifyFailedWake(taskID, reason string) string`
  - test helpers in `verify_test.go`, used again by Task 4: `const verifyCmd`, `awaitVerify(t) func()`, `type blockingVerify` with `waitStarted(t)` and `open()`, `stubBlockingVerify(t) (*blockingVerify, *planCalls)`

- [ ] **Step 1: States, the derive guard and the event kinds**

In `pkg/orchestrate/dag.go`, extend the task states:

```go
	TaskState_BlockedMerge = "blocked-merge"
	TaskState_Verifying    = "verifying"     // merged; the plan's Verify is running in the project checkout
	TaskState_VerifyFailed = "verify-failed" // merged, and Verify failed or timed out; fixed in the project tree, then `dag merge --continue`
)

// landingState reports a state the merge path wrote after the child finished. Deriving from the done child
// would read done and erase the conflict or the failed Verify the task is waiting on.
func landingState(state string) bool {
	return state == TaskState_BlockedMerge || state == TaskState_Verifying || state == TaskState_VerifyFailed
}
```

In `DeriveTaskStates`, replace:

```go
		if t.RunID == "" {
			continue
		}
		r, ok := runs[t.RunID]
```

with:

```go
		if t.RunID == "" || landingState(t.State) {
			continue
		}
		r, ok := runs[t.RunID]
```

In `RecomputeDagStatus`, replace `case TaskState_Failed, TaskState_BlockedMerge:` with `case TaskState_Failed, TaskState_BlockedMerge, TaskState_VerifyFailed:`.

In `NewTaskGroup`, after the `CleanupPending || CleanupError` check, add:

```go
		if t.VerifyError != "" {
			return waveobj.TaskGroup{}, fmt.Errorf("task %q verifyerror must be empty", t.ID)
		}
```

In `pkg/waveobj/wtype.go`, `TaskNode`: replace the `State` comment `// pending|ready|running|stalled|done|failed|cancelled|skipped|blocked-merge` with `// pending|ready|running|stalled|done|failed|cancelled|skipped|blocked-merge|verifying|verify-failed`, and after `CleanupError` add:

```go
	CleanupError   string `json:"cleanuperror,omitempty"`
	// VerifyError is why the plan's Verify failed after this task merged: the exit code or the timeout,
	// then the tail of the command's output. Cleared when Verify passes.
	VerifyError string `json:"verifyerror,omitempty"`
```

In `pkg/waveobj/runevent.go`, add after the `RunEventKindLeadWakeFailed` line:

```go
	RunEventKindLeadWakeFailed = "lead-wake-failed"

	// merge-point Verify (orchestrator redesign §4): the plan's Verify command, run in the project
	// checkout after a task's squash merge.
	//   task-verify-started  "taskid"
	//   task-verify-passed   "taskid", "ms"
	//   task-verify-failed   "taskid", "reason" ("exit 1" or "timed out after 20m"), "detail"
	RunEventKindTaskVerifyStarted = "task-verify-started"
	RunEventKindTaskVerifyPassed  = "task-verify-passed"
	RunEventKindTaskVerifyFailed  = "task-verify-failed"
```

In `pkg/orchestrate/queue.go`, after `mergeConflictWake`:

```go
// verifyFailedWake names the exit code or the timeout, so the lead knows whether to read a failing test or
// look for a hang before it reads the digest.
func verifyFailedWake(taskID, reason string) string {
	return fmt.Sprintf("wake: Verify failed after merging task %s (%s). wsh jarvis dag status", taskID, reason)
}
```

Append to `pkg/orchestrate/dag_test.go`:

```go
func TestDeriveTaskStatesKeepsLandingStates(t *testing.T) {
	for _, state := range []string{TaskState_BlockedMerge, TaskState_Verifying, TaskState_VerifyFailed} {
		g := mustGroup(t, mkTasks())
		g.Tasks[0].State = state
		g.Tasks[0].RunID = "r-0"
		DeriveTaskStates(g, map[string]*waveobj.Run{"r-0": {ID: "r-0", Status: jarvis.RunStatus_Done}})
		if g.Tasks[0].State != state {
			t.Fatalf("a done child must not overwrite %s, got %s", state, g.Tasks[0].State)
		}
	}
}
```

Run: `go test ./pkg/orchestrate -run 'TestDeriveTaskStates' -count=1`
Expected: PASS for both `TestDeriveTaskStatesFromRuns` and `TestDeriveTaskStatesKeepsLandingStates`.

- [ ] **Step 2: The landing claim and the Verify run**

Create `pkg/orchestrate/verify.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// errProjectBusy is a merge that has to wait: another task's merge or Verify holds the project checkout.
var errProjectBusy = errors.New("project checkout is busy")

// landing is one task's claim on its project checkout, from its squash merge through the Verify after it.
type landing struct {
	dagID  string
	taskID string
	cancel context.CancelFunc // set once Verify starts
}

// landings serializes merges and their Verify runs per project checkout: a merge landing mid-Verify would
// be judged by a test run that started before it. In memory only: a restart kills the Verify the claim
// covered, and AutoMergeReady restarts it from the persisted verifying state.
var landings = struct {
	sync.Mutex
	byProject map[string]*landing
}{byProject: make(map[string]*landing)}

// claimProject reserves projectPath for one landing, or names the landing that holds it.
func claimProject(projectPath, dagID, taskID string) (*landing, error) {
	key := filepath.Clean(projectPath)
	landings.Lock()
	defer landings.Unlock()
	if cur := landings.byProject[key]; cur != nil {
		return nil, fmt.Errorf("%w: task %s of dag %s is landing", errProjectBusy, cur.taskID, cur.dagID)
	}
	l := &landing{dagID: dagID, taskID: taskID}
	landings.byProject[key] = l
	return l, nil
}

func releaseProject(projectPath string, l *landing) {
	key := filepath.Clean(projectPath)
	landings.Lock()
	defer landings.Unlock()
	if landings.byProject[key] == l {
		delete(landings.byProject, key)
	}
}

// stopDagVerify kills a cancelled dag's running Verify: nothing will read its result.
func stopDagVerify(dagID string) {
	landings.Lock()
	defer landings.Unlock()
	for _, l := range landings.byProject {
		if l.dagID == dagID && l.cancel != nil {
			l.cancel()
		}
	}
}

// verifyFinished is called once a Verify run has recorded its result and ticked its dag. A var so tests
// can wait for it.
var verifyFinished = func(dagID, taskID string) {}

// startVerify runs Verify in the project checkout for a task the caller moved to verifying, and releases l
// once the result is recorded. It runs on its own goroutine because Verify takes minutes and neither the
// watchdog tick nor an RPC handler can wait on it, and it holds no dag lock while the command runs.
func startVerify(channelID, dagID, runID, taskID, projectPath, command string, l *landing) {
	ctx, cancel := context.WithCancel(context.Background())
	landings.Lock()
	l.cancel = cancel
	landings.Unlock()
	appendRunEvent(ctx, channelID, runID, waveobj.RunEventKindTaskVerifyStarted, nil, map[string]any{"taskid": taskID})
	go func() {
		defer verifyFinished(dagID, taskID)
		start := time.Now()
		verr := runPlanCommand(ctx, projectPath, command, VerifyTimeout)
		cancel()
		bg := context.Background()
		if err := WithDagMutation(dagID, func() error {
			return recordVerifyLocked(bg, dagID, taskID, verr, time.Since(start).Milliseconds())
		}); err != nil {
			log.Printf("dag %s task %s: recording verify: %v", dagID, taskID, err)
		}
		releaseProject(projectPath, l)
		// the next merge was held for this Verify, and a pass unblocks dependents
		if err := Schedule(bg, dagID); err != nil {
			log.Printf("dag %s: schedule after verify: %v", dagID, err)
		}
	}()
}

// recordVerifyLocked moves a verifying task to done or verify-failed. A task that is no longer verifying,
// because its dag was cancelled, records nothing. The caller holds the dag mutation lock.
func recordVerifyLocked(ctx context.Context, dagID, taskID string, verr error, ms int64) error {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return err
	}
	task := taskByID(g, taskID)
	if g.Status == DagStatus_Cancelled || task == nil || task.State != TaskState_Verifying {
		return nil
	}
	reason := ""
	if verr == nil {
		task.State, task.VerifyError = TaskState_Done, ""
	} else {
		reason = "error"
		var pe *planCommandError
		if errors.As(verr, &pe) {
			reason = pe.reason()
		}
		task.State, task.VerifyError = TaskState_VerifyFailed, verr.Error()
	}
	RecomputeDagStatus(g)
	g.UpdatedTs = time.Now().UnixMilli()
	if err := wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, dagID))
	if verr == nil {
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskVerifyPassed, nil, map[string]any{"taskid": taskID, "ms": ms})
		return nil
	}
	appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskVerifyFailed, nil, map[string]any{
		"taskid": taskID, "reason": reason, "detail": truncateText(verr.Error(), MaxFailureDetailLen),
	})
	PostWake(ctx, g.ChannelId, g.RunID, verifyFailedWake(taskID, reason))
	return nil
}

// resumeVerify restarts a Verify the server lost: the task was persisted verifying and nothing holds its
// project. A Verify still running holds the claim, so this starts nothing.
func resumeVerify(ctx context.Context, g *waveobj.TaskGroup, taskID string) {
	owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
	if err != nil {
		return
	}
	l, err := claimProject(owner.ProjectPath, g.OID, taskID)
	if err != nil {
		return
	}
	startVerify(g.ChannelId, g.OID, g.RunID, taskID, owner.ProjectPath, g.Verify, l)
}

// rerunVerify re-runs Verify for a task whose Verify failed, after the caller committed a fix.
func rerunVerify(ctx context.Context, channelID string, owner *waveobj.Run, taskID string) error {
	l, err := claimProject(owner.ProjectPath, owner.DagORef, taskID)
	if err != nil {
		return err
	}
	var verify string
	err = WithDagMutation(owner.DagORef, func() error {
		g, gerr := wstore.GetDag(ctx, owner.DagORef)
		if gerr != nil {
			return gerr
		}
		task := taskByID(g, taskID)
		if task == nil || task.State != TaskState_VerifyFailed {
			return fmt.Errorf("task %s is no longer verify-failed", taskID)
		}
		task.State, task.VerifyError = TaskState_Verifying, ""
		RecomputeDagStatus(g)
		g.UpdatedTs = time.Now().UnixMilli()
		if uerr := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
			*cur = *g
			return nil
		}); uerr != nil {
			return uerr
		}
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
		verify = g.Verify
		return nil
	})
	if err != nil {
		releaseProject(owner.ProjectPath, l)
		return err
	}
	startVerify(channelID, owner.DagORef, owner.ID, taskID, owner.ProjectPath, verify, l)
	return nil
}
```

`rerunVerify` has no caller until Task 4. `go vet` does not flag an unused unexported function, so the package still builds.

- [ ] **Step 3: Write the failing Verify tests**

Create `pkg/orchestrate/verify_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const verifyCmd = "task test"

// awaitVerify returns a func that blocks until one more Verify run has recorded its result and ticked
// its dag.
func awaitVerify(t *testing.T) func() {
	t.Helper()
	done := make(chan struct{}, 16)
	orig := verifyFinished
	verifyFinished = func(string, string) { done <- struct{}{} }
	t.Cleanup(func() { verifyFinished = orig })
	return func() {
		t.Helper()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("verify did not finish")
		}
	}
}

// blockingVerify is a Verify that reports each start and passes only once released, or fails when its
// context is cancelled. A test that fails before releasing leaves it blocked, holding only its own
// temporary project.
type blockingVerify struct {
	started chan struct{}
	release chan struct{}
}

func stubBlockingVerify(t *testing.T) (*blockingVerify, *planCalls) {
	t.Helper()
	b := &blockingVerify{started: make(chan struct{}, 16), release: make(chan struct{})}
	calls := stubPlanCommand(t, func(ctx context.Context, _, _ string) error {
		b.started <- struct{}{}
		select {
		case <-b.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	return b, calls
}

func (b *blockingVerify) open() { close(b.release) }

func (b *blockingVerify) waitStarted(t *testing.T) {
	t.Helper()
	select {
	case <-b.started:
	case <-time.After(10 * time.Second):
		t.Fatal("verify did not start")
	}
}

func (f *mergeFixture) projectPath(t *testing.T) string {
	t.Helper()
	owner, err := wstore.GetRun(f.ctx, f.channel, f.ownerID)
	if err != nil {
		t.Fatal(err)
	}
	return owner.ProjectPath
}

func landedSha(context.Context, string, string, string) (string, error) { return "sha-1", nil }

func TestVerifyPassAfterMergeUnblocksDependent(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{
		{ID: "t-0", Label: "first"},
		{ID: "t-1", Label: "second", Deps: []string{"t-0"}},
	})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	stubMerge(t, landedSha)
	verify, calls := stubBlockingVerify(t)
	var spawned []string
	stubSpawn(t, &spawned)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	verify.waitStarted(t)
	g := f.dag(t)
	if g.Tasks[0].State != TaskState_Verifying || !g.Tasks[0].Merged {
		t.Fatalf("a merged task waits on Verify, got %s merged=%v", g.Tasks[0].State, g.Tasks[0].Merged)
	}
	if g.Tasks[1].State != TaskState_Pending || len(spawned) != 0 {
		t.Fatalf("the dependent waits for Verify to pass, got %s with %d spawns", g.Tasks[1].State, len(spawned))
	}
	verify.open()
	await()

	g = f.dag(t)
	if g.Tasks[0].State != TaskState_Done || g.Tasks[0].VerifyError != "" {
		t.Fatalf("a passing Verify leaves the task done, got %s %q", g.Tasks[0].State, g.Tasks[0].VerifyError)
	}
	if got := calls.list(); len(got) != 1 || got[0].dir != f.projectPath(t) || got[0].command != verifyCmd {
		t.Fatalf("want Verify once in the project checkout, got %+v", got)
	}
	if g.Tasks[1].State != TaskState_Running {
		t.Fatalf("the dependent dispatches once Verify passes, got %s", g.Tasks[1].State)
	}
}

func TestVerifyFailureBlocksTheDagAndWakesTheLead(t *testing.T) {
	lead := newFakeLead(t)
	f := newMergeFixture(t, []waveobj.TaskNode{
		{ID: "t-0", Label: "first"},
		{ID: "t-1", Label: "second", Deps: []string{"t-0"}},
	})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	stubMerge(t, landedSha)
	stubPlanCommand(t, func(context.Context, string, string) error {
		return &planCommandError{exitCode: 1, output: "FAIL pkg/orchestrate"}
	})
	var spawned []string
	stubSpawn(t, &spawned)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await()

	g := f.dag(t)
	if task := g.Tasks[0]; task.State != TaskState_VerifyFailed || task.VerifyError != "exit 1: FAIL pkg/orchestrate" {
		t.Fatalf("want verify-failed with the reason and output, got %s %q", task.State, task.VerifyError)
	}
	if g.Status != DagStatus_Blocked || g.Tasks[1].State != TaskState_Pending || len(spawned) != 0 {
		t.Fatalf("a failed Verify blocks the dag and its dependents, got %s / %s / %d spawns", g.Status, g.Tasks[1].State, len(spawned))
	}
	want := "wake: Verify failed after merging task t-0 (exit 1). wsh jarvis dag status"
	if len(lead.sends) != 1 || lead.sends[0] != want {
		t.Fatalf("want %q, got %q", want, lead.sends)
	}
}

func TestVerifyTimeoutIsAFailure(t *testing.T) {
	lead := newFakeLead(t)
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	stubMerge(t, landedSha)
	stubPlanCommand(t, func(context.Context, string, string) error {
		return &planCommandError{exitCode: -1, timeout: VerifyTimeout}
	})
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await()

	if got := f.dag(t).Tasks[0].State; got != TaskState_VerifyFailed {
		t.Fatalf("a Verify past its timeout fails the task, got %s", got)
	}
	want := "wake: Verify failed after merging task t-0 (timed out after 20m). wsh jarvis dag status"
	if len(lead.sends) != 1 || lead.sends[0] != want {
		t.Fatalf("want %q, got %q", want, lead.sends)
	}
}

func TestNextMergeWaitsForRunningVerify(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}, {ID: "t-1", Label: "second"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	f.finish(t, "t-1")
	merges := stubMerge(t, landedSha)
	verify, _ := stubBlockingVerify(t)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	verify.waitStarted(t)
	// a watchdog tick while t-0's Verify runs
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if *merges != 1 {
		t.Fatalf("a merge must wait for the running Verify, got %d merges", *merges)
	}
	verify.open()
	await() // t-0's Verify; its tick lands t-1
	await() // t-1's Verify

	g := f.dag(t)
	if *merges != 2 || g.Tasks[0].State != TaskState_Done || g.Tasks[1].State != TaskState_Done {
		t.Fatalf("both tasks land and verify in turn, got %d merges, %s, %s", *merges, g.Tasks[0].State, g.Tasks[1].State)
	}
}

func TestVerifyDoesNotHoldTheDagLock(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	stubMerge(t, landedSha)
	verify, _ := stubBlockingVerify(t)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	verify.waitStarted(t)
	locked := make(chan struct{})
	go func() {
		_ = WithDagMutation(f.dagID, func() error { return nil })
		close(locked)
	}()
	select {
	case <-locked:
	case <-time.After(5 * time.Second):
		t.Fatal("a tick must get the dag lock while Verify runs")
	}
	verify.open()
	await()
}

func TestTickRestartsAVerifyTheServerLost(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	// what a restart leaves: merged and persisted verifying, with no Verify running
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[0].State, cur.Tasks[0].Merged = TaskState_Verifying, true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	calls := stubPlanCommand(t, func(context.Context, string, string) error { return nil })
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await()

	if n := len(calls.list()); n != 1 {
		t.Fatalf("the tick restarts the lost Verify once, got %d runs", n)
	}
	if got := f.dag(t).Tasks[0].State; got != TaskState_Done {
		t.Fatalf("the restarted Verify records its pass, got %s", got)
	}
}

func TestMergeWithoutVerifyLineIsDone(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.finish(t, "t-0")
	stubMerge(t, landedSha)
	calls := stubPlanCommand(t, func(context.Context, string, string) error { return nil })

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	task := f.dag(t).Tasks[0]
	if !task.Merged || task.State != TaskState_Done || len(calls.list()) != 0 {
		t.Fatalf("no Verify line: the merge is the end, got merged=%v %s with %d runs", task.Merged, task.State, len(calls.list()))
	}
}

func TestCancelStopsARunningVerify(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	stubMerge(t, landedSha)
	verify, _ := stubBlockingVerify(t)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	verify.waitStarted(t)
	if err := Cancel(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await() // returns only if cancel stopped the blocked Verify

	g := f.dag(t)
	if g.Status != DagStatus_Cancelled || g.Tasks[0].State != TaskState_Verifying {
		t.Fatalf("a cancelled dag records no Verify result, got %s / %s", g.Status, g.Tasks[0].State)
	}
}

func TestManualMergeRefusesWhileVerifyRuns(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}, {ID: "t-1", Label: "second"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	f.finish(t, "t-1")
	stubMerge(t, landedSha)
	verify, _ := stubBlockingVerify(t)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	verify.waitStarted(t)
	err := MergeTask(f.ctx, f.channel, f.ownerID, "t-1")
	if !errors.Is(err, errProjectBusy) || !strings.Contains(err.Error(), "task t-0") {
		t.Fatalf("a merge while t-0's Verify runs must say who holds the checkout, got %v", err)
	}
	verify.open()
	await()
	await()
}
```

- [ ] **Step 4: Run them to verify they fail**

Run: `go test ./pkg/orchestrate -run 'TestVerify|TestNextMergeWaits|TestTickRestarts|TestMergeWithoutVerify|TestCancelStops|TestManualMergeRefuses' -count=1`
Expected: FAIL. `TestVerifyPassAfterMergeUnblocksDependent` times out in `waitStarted` with `verify did not start`, because nothing runs Verify yet.

- [ ] **Step 5: Hand a landed merge to Verify**

In `pkg/orchestrate/mergetask.go`, replace `mergeTaskEntry` with:

```go
func mergeTaskEntry(ctx context.Context, channelID, ownerRunID, taskID string, requireCleanIndex bool) error {
	if channelID == "" || ownerRunID == "" || taskID == "" {
		return fmt.Errorf("channelid, runid and taskid are required")
	}
	owner, err := wstore.GetRun(ctx, channelID, ownerRunID)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	if owner.DagORef == "" {
		return fmt.Errorf("run has no dag")
	}
	l, err := claimProject(owner.ProjectPath, owner.DagORef, taskID)
	if err != nil {
		return err
	}
	var verify string
	err = withDagMutation(owner.DagORef, func() error {
		var lerr error
		verify, lerr = mergeTaskLocked(ctx, channelID, owner, taskID, requireCleanIndex)
		return lerr
	})
	landAfterMerge(channelID, owner, taskID, verify, l)
	return err
}

// landAfterMerge hands the project claim to the Verify a landed merge waits on, or releases it.
func landAfterMerge(channelID string, owner *waveobj.Run, taskID, verify string, l *landing) {
	if verify == "" {
		releaseProject(owner.ProjectPath, l)
		return
	}
	startVerify(channelID, owner.DagORef, owner.ID, taskID, owner.ProjectPath, verify, l)
}
```

Change `mergeTaskLocked` to return the Verify command: its signature becomes

```go
func mergeTaskLocked(ctx context.Context, channelID string, owner *waveobj.Run, taskID string, requireCleanIndex bool) (string, error) {
```

every `return err`, `return nil` and `return fmt.Errorf(...)`/`return errIndexNotClean`/`return cerr`/`return derr` in its body gains a leading `"", ` (for example `return "", fmt.Errorf("no task %q", taskID)`), the `task.Merged` branch becomes

```go
	if task.Merged {
		if !task.CleanupPending && task.CleanupError == "" {
			return "", nil
		}
		return "", CleanupMergedTask(ctx, channelID, g, taskID)
	}
```

and its last line stays `return FinishMergedTask(ctx, channelID, owner.DagORef, childRunID, taskID, sha)`.

Replace `FinishMergedTask` with:

```go
// FinishMergedTask stamps a landed merge and then removes the worktree. It returns the plan's Verify
// command when the task now waits on it, even when the cleanup failed: the merge landed either way. The
// caller holds the dag mutation lock.
func FinishMergedTask(ctx context.Context, channelID, dagID, childRunID, taskID, sha string) (string, error) {
	if err := persistMergedTask(ctx, channelID, dagID, childRunID, taskID, sha); err != nil {
		return "", err
	}
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return "", err
	}
	appendRunEvent(ctx, channelID, g.RunID, waveobj.RunEventKindTaskMerged, nil, map[string]any{"taskid": taskID, "commit": sha})
	appendRunEvent(ctx, channelID, g.RunID, waveobj.RunEventKindTaskCleanupPending, nil, map[string]any{"taskid": taskID})
	return g.Verify, CleanupMergedTask(ctx, channelID, g, taskID)
}
```

In `persistMergedTask`, replace:

```go
			task.Merged = true
			task.CleanupPending = true
			task.CleanupError = ""
			RecomputeDagStatus(cur)
```

with:

```go
			task.Merged = true
			task.CleanupPending = true
			task.CleanupError = ""
			// written here, not derived: a continued conflict leaves blocked-merge, which nothing re-derives
			task.State = TaskState_Done
			if cur.Verify != "" {
				task.State = TaskState_Verifying
			}
			RecomputeDagStatus(cur)
```

Replace `AutoMergeReady` with:

```go
// AutoMergeReady lands every task whose work is finished and whose gate, if it has one, a human
// already released. Under MergeRequired the merge is what unblocks a dependent, so leaving it to the
// lead put a language model on the critical path of every edge in the dag; dispatch has always been
// the watchdog's job and this makes the merge match. A conflict still stops at the human: the task
// goes blocked-merge exactly as it does from the RPC, and is not retried on the next tick. A merge also
// waits for the Verify of the one before it, and a failed Verify holds every later merge until it passes.
func AutoMergeReady(ctx context.Context, dagID string) {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil || g.Status == DagStatus_Cancelled || !g.MergeRequired {
		return
	}
	if ids := tasksInState(g, TaskState_Verifying); len(ids) > 0 {
		resumeVerify(ctx, g, ids[0])
		return
	}
	if len(tasksInState(g, TaskState_VerifyFailed)) > 0 {
		return
	}
	ready := autoMergeable(g)
	if len(ready) == 0 {
		return
	}
	owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
	if err != nil {
		return
	}
	for _, taskID := range ready {
		err := mergeTaskEntry(ctx, g.ChannelId, owner.ID, taskID, true)
		switch {
		case err == nil, errors.Is(err, ErrMergeConflict):
		case errors.Is(err, errProjectBusy):
			// a landing holds the checkout; its Verify ticks the dag when it finishes
			return
		case errors.Is(err, errIndexNotClean):
			// the human is mid-edit in the project tree; the tasks stay merge-ready for them and
			// the next tick retries. Reported once per tick, not once per task.
			log.Printf("dag %s: holding %d merge(s), project index is not clean", g.ID, len(ready))
			return
		default:
			log.Printf("dag %s: auto-merging task %s: %v", g.ID, taskID, err)
		}
	}
}
```

In `pkg/wshrpc/wshserver/wshserver_dag.go`, `DagMergeContinueCommand` still calls `orchestrate.FinishMergedTask` and no longer compiles against the new signature. Task 4 replaces that handler; until then change its last statement to:

```go
	return orchestrate.WithDagMutation(owner.DagORef, func() error {
		_, ferr := orchestrate.FinishMergedTask(ctx, data.ChannelId, owner.DagORef, child.ID, data.TaskId, sha)
		return ferr
	})
```

In `pkg/orchestrate/mutation.go`, `cancelLocked`, after `appendRunEvent(ctx, gCopy.ChannelId, gCopy.RunID, waveobj.RunEventKindDagCancelled, nil, map[string]any{"source": "cancel"})`, add:

```go
	stopDagVerify(dagID)
```

Run `task generate`.

- [ ] **Step 6: Run the tests**

Run: `go test ./pkg/orchestrate -count=1` and `go test ./pkg/wshrpc/wshserver -count=1`
Expected: PASS, including every existing merge, cleanup, notify and queue test.

---

### Task 4: `dag merge --continue` on a failed Verify, and `dag forward` for it

**Files:**
- Modify: `pkg/orchestrate/mergetask.go` (`ContinueMerge`, `continueBlockedMerge`, `continueMerge` seam)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`DagMergeContinueCommand` delegates)
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (the `DagMergeContinueCommand` interface comment)
- Modify: `pkg/orchestrate/queue.go` (`ForwardTask`)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`dagMergeCmd` help and confirmation)
- Create: `pkg/orchestrate/continue_test.go`
- Regenerate: `task generate`

**Interfaces:**
- Consumes: `claimProject`, `releaseProject`, `landAfterMerge`, `rerunVerify`, `FinishMergedTask` (Task 3); `stubPlanCommand`, `setPlanCommands` (Task 2); `verifyCmd`, `awaitVerify`, `landedSha` (Task 3 tests).
- Produces:
  - `func ContinueMerge(ctx context.Context, channelID, ownerRunID, taskID string) error`
  - `var continueMerge = MergeContinue` (test seam for the resolved-conflict commit)

- [ ] **Step 1: Write the failing tests**

Create `pkg/orchestrate/continue_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestContinueReRunsAFailedVerify(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}, {ID: "t-1", Label: "second"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	f.finish(t, "t-1")
	merges := stubMerge(t, landedSha)
	var failing atomic.Bool
	failing.Store(true)
	stubPlanCommand(t, func(context.Context, string, string) error {
		if failing.Load() {
			return &planCommandError{exitCode: 1, output: "FAIL"}
		}
		return nil
	})
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await()
	if got := f.dag(t).Tasks[0].State; got != TaskState_VerifyFailed {
		t.Fatalf("setup: want verify-failed, got %s", got)
	}
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if *merges != 1 {
		t.Fatalf("a failed Verify holds later merges, got %d merges", *merges)
	}

	// the lead committed a fix in the project tree
	failing.Store(false)
	if err := ContinueMerge(f.ctx, f.channel, f.ownerID, "t-0"); err != nil {
		t.Fatal(err)
	}
	await() // t-0's re-run passes; its tick lands t-1
	await() // t-1's Verify

	g := f.dag(t)
	if g.Tasks[0].State != TaskState_Done || g.Tasks[0].VerifyError != "" {
		t.Fatalf("a passing re-run clears the failure, got %s %q", g.Tasks[0].State, g.Tasks[0].VerifyError)
	}
	if *merges != 2 || g.Tasks[1].State != TaskState_Done {
		t.Fatalf("the held merge lands once Verify passes, got %d merges and %s", *merges, g.Tasks[1].State)
	}
}

func TestContinueAfterConflictRunsVerify(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	stubMerge(t, func(context.Context, string, string, string) (string, error) { return "", ErrMergeConflict })
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if got := f.dag(t).Tasks[0].State; got != TaskState_BlockedMerge {
		t.Fatalf("setup: want blocked-merge, got %s", got)
	}
	orig := continueMerge
	continueMerge = func(context.Context, string, string, string) (string, error) { return "sha-2", nil }
	t.Cleanup(func() { continueMerge = orig })
	calls := stubPlanCommand(t, func(context.Context, string, string) error { return nil })
	await := awaitVerify(t)

	if err := ContinueMerge(f.ctx, f.channel, f.ownerID, "t-0"); err != nil {
		t.Fatal(err)
	}
	await()

	task := f.dag(t).Tasks[0]
	if !task.Merged || task.State != TaskState_Done || len(calls.list()) != 1 {
		t.Fatalf("a continued merge is verified like any other, got merged=%v %s with %d runs", task.Merged, task.State, len(calls.list()))
	}
}

func TestForwardTaskAcceptsAFailedVerify(t *testing.T) {
	lead := newFakeLead(t)
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[0].State, cur.Tasks[0].Merged = TaskState_VerifyFailed, true
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := ForwardTask(f.ctx, f.dagID, "t-0", "the fix needs a product call"); err != nil {
		t.Fatal(err)
	}
	if lead.countKind(waveobj.RunEventKindTaskForwarded) != 1 {
		t.Fatalf("want one task-forwarded row, got %+v", lead.rows)
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test ./pkg/orchestrate -run 'TestContinue|TestForwardTaskAcceptsAFailedVerify' -count=1`
Expected: build FAIL with `undefined: ContinueMerge` and `undefined: continueMerge`.

- [ ] **Step 3: Implement**

In `pkg/orchestrate/mergetask.go`, below `var mergeWorktree = MergeRunWorktree`, add:

```go
// continueMerge commits a squash merge the caller resolved; a seam so tests skip the real conflict.
var continueMerge = MergeContinue
```

Add below `MergeTask`:

```go
// ContinueMerge is `dag merge <task> --continue`, the lead's way out of the two landing failures it is
// woken for: it commits a squash merge the caller resolved after a conflict, or re-runs Verify at the
// project's HEAD after the caller committed a fix. Either way the next merge waits for that Verify.
func ContinueMerge(ctx context.Context, channelID, ownerRunID, taskID string) error {
	if channelID == "" || ownerRunID == "" || taskID == "" {
		return fmt.Errorf("channelid, runid and taskid are required")
	}
	owner, err := wstore.GetRun(ctx, channelID, ownerRunID)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	if owner.DagORef == "" {
		return fmt.Errorf("run has no dag")
	}
	g, err := wstore.GetDag(ctx, owner.DagORef)
	if err != nil {
		return err
	}
	task := taskByID(g, taskID)
	if task == nil {
		return fmt.Errorf("no task %q", taskID)
	}
	switch {
	case task.State == TaskState_VerifyFailed:
		return rerunVerify(ctx, channelID, owner, taskID)
	case task.Merged:
		if !task.CleanupPending && task.CleanupError == "" {
			return nil
		}
		return withDagMutation(owner.DagORef, func() error {
			return CleanupMergedTask(ctx, channelID, g, taskID)
		})
	case task.State == TaskState_BlockedMerge:
		return continueBlockedMerge(ctx, channelID, owner, task)
	}
	return fmt.Errorf("task %s is %s, want blocked-merge or verify-failed", taskID, task.State)
}

// continueBlockedMerge commits the resolved project state of a conflicted squash merge, stamps it like
// any merge, and hands the checkout to Verify when the plan has one.
func continueBlockedMerge(ctx context.Context, channelID string, owner *waveobj.Run, task *waveobj.TaskNode) error {
	if task.RunID == "" {
		return fmt.Errorf("task %s has no child run", task.ID)
	}
	l, err := claimProject(owner.ProjectPath, owner.DagORef, task.ID)
	if err != nil {
		return err
	}
	mergeMsg := task.Label
	if mergeMsg == "" {
		mergeMsg = task.ID
	}
	appendRunEvent(ctx, channelID, owner.ID, waveobj.RunEventKindTaskMergeContinued, nil, map[string]any{"taskid": task.ID})
	sha, err := continueMerge(ctx, owner.ProjectPath, TaskWorktreeKey(owner.ID, task.ID), mergeMsg)
	if err != nil {
		releaseProject(owner.ProjectPath, l)
		return err
	}
	var verify string
	// the stamp is a dag write, and the engine reverts any dag write made outside this lock
	err = withDagMutation(owner.DagORef, func() error {
		var ferr error
		verify, ferr = FinishMergedTask(ctx, channelID, owner.DagORef, task.RunID, task.ID, sha)
		return ferr
	})
	landAfterMerge(channelID, owner, task.ID, verify, l)
	return err
}
```

In `pkg/wshrpc/wshserver/wshserver_dag.go`, replace the whole `DagMergeContinueCommand` (its doc comment and body) with:

```go
// DagMergeContinueCommand is `dag merge <task> --continue`: it finishes a squash merge the caller
// resolved after a conflict, or re-runs Verify after the caller committed a fix.
func (ws *WshServer) DagMergeContinueCommand(ctx context.Context, data wshrpc.CommandDagMergeData) error {
	return orchestrate.ContinueMerge(ctx, data.ChannelId, data.RunId, data.TaskId)
}
```

Remove any import the file no longer uses after this change; `go build ./pkg/wshrpc/wshserver` names it.

In `pkg/wshrpc/wshrpctypes_dag.go`, replace the comment on `DagMergeContinueCommand` (`// finish a squash merge after manual conflict resolution`) with `// finish a resolved squash merge, or re-run a failed Verify`.

In `pkg/orchestrate/queue.go`, `ForwardTask`, replace:

```go
	switch task.State {
	case TaskState_Failed, TaskState_Stalled, TaskState_BlockedMerge:
```

with:

```go
	switch task.State {
	case TaskState_Failed, TaskState_Stalled, TaskState_BlockedMerge, TaskState_VerifyFailed:
```

and its final line with:

```go
	return fmt.Errorf("task %s has no question, failure, stall, merge conflict or failed Verify to forward (state %q)", taskID, task.State)
```

In `cmd/wsh/cmd/wshcmd-jarvisdag.go`, replace `dagMergeCmd`'s `Long` with:

```go
	Long: "Squash-merge a finished task's worktree back into the project branch. On a squash\n" +
		"conflict the task enters blocked-merge: resolve the conflicts in the project tree, then\n" +
		"re-run with --continue so the engine commits the resolved state. When the plan's Verify\n" +
		"fails after a merge the task enters verify-failed: fix it in the project tree, commit, then\n" +
		"re-run with --continue so the engine runs Verify again.",
```

replace:

```go
		if cont {
			return wshclient.DagMergeContinueCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 60_000})
		}
```

with:

```go
		if cont {
			if err := wshclient.DagMergeContinueCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 60_000}); err != nil {
				return err
			}
			fmt.Printf("task %s continued; the plan's Verify, if it has one, runs next and a failure wakes you\n", args[0])
			return nil
		}
```

and replace the flag help `"finish a blocked squash merge after manual conflict resolution"` with `"finish a resolved squash merge, or re-run a failed Verify after committing the fix"`.

Run `task generate`.

- [ ] **Step 4: Run the tests**

Run: `go test ./pkg/orchestrate -count=1`, `go test ./pkg/wshrpc/wshserver -count=1`, `go test ./cmd/wsh/cmd -count=1`
Expected: PASS. `TestDagMergeContinueFinishesBlockedMerge` still passes: its `unresolved conflict` and `want blocked-merge` assertions match the moved code's messages.

---

### Task 5: Digest, report numbers and `dag status`

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (`DagStatusDigest.Report`, `DagReportDigest`, `DagLandedCommit`, enum comments)
- Modify: `pkg/orchestrate/digest.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`dagDigestRetainedKinds`)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`dagStatusLines`)
- Create: `pkg/orchestrate/digestverify_test.go`
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag_test.go` (append a test)
- Regenerate: `task generate`

**Interfaces:**
- Consumes: `TaskState_Verifying`, `TaskState_VerifyFailed`, `TaskNode.VerifyError` (Task 3); `TaskGroup.Verify` (Task 2).
- Produces:
  - `DagStatusDigest.Report DagReportDigest` (`json:"report"`)
  - `DagReportDigest{WorkerMs int64 "workerms"; Commits []DagLandedCommit "commits,omitempty"; Unverified bool "unverified,omitempty"; Answered int "answered"; Forwarded int "forwarded"}`
  - `DagLandedCommit{TaskId string "taskid"; Commit string "commit"}`
  - digest: wait reason `verify`, next kind `verify-wait`, `resolve-merge` as the action on `verify-failed`

- [ ] **Step 1: Write the failing digest tests**

Create `pkg/orchestrate/digestverify_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestDigestVerifyFailedNeedsTheLead(t *testing.T) {
	g := digestGroup(t, true, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_VerifyFailed})
	g.Tasks[0].Merged = true
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Health != "needs-you" {
		t.Fatalf("a failed Verify needs the lead, got %q", d.Health)
	}
	if d.Next.Kind != "human-action" || !reflect.DeepEqual(d.Next.TaskIds, []string{"t-0"}) || !reflect.DeepEqual(d.Next.Actions, []string{"resolve-merge"}) {
		t.Fatalf("next step must name the failed task and the fix-then-continue action, got %+v", d.Next)
	}
	if d.Tasks[0].WaitReason != "verify" || !reflect.DeepEqual(d.Tasks[0].HumanActions, []string{"resolve-merge"}) {
		t.Fatalf("task row must read verify / resolve-merge, got %+v", d.Tasks[0])
	}
}

func TestDigestRunningVerifyIsAWait(t *testing.T) {
	g := digestGroup(t, true, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Verifying})
	g.Tasks[0].Merged = true
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Health != "healthy" || d.Next.Kind != "verify-wait" || !reflect.DeepEqual(d.Next.TaskIds, []string{"t-0"}) {
		t.Fatalf("a running Verify is the engine's move, got health %q next %+v", d.Health, d.Next)
	}
	if d.Tasks[0].WaitReason != "verify" {
		t.Fatalf("task row must read verify, got %q", d.Tasks[0].WaitReason)
	}
}

func TestDigestReportNumbers(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Done, "t-2": TaskState_Running})
	g.Tasks[0].Merged = true
	g.Verify = "task test"
	runs := []*waveobj.Run{
		childRun("run-t-0", []waveobj.RunPhase{phase("quick", 1000, 61_000)}),
		childRun("run-t-1", []waveobj.RunPhase{phase("quick", 2000, 32_000)}),
	}
	runs[0].EndCommit = "sha-0"
	retained := []waveobj.RunEvent{
		retainedEvent(waveobj.RunEventKindChildAnswered, "t-2", 3000),
		retainedEvent(waveobj.RunEventKindChildAnswered, "t-2", 4000),
		retainedEvent(waveobj.RunEventKindTaskForwarded, "t-1", 5000),
	}
	r := BuildDigest(digestSnapshot(g, runs, nil, retained, digestNow)).Report
	if r.WorkerMs != 90_000 {
		t.Fatalf("worker time sums the tasks' run time, got %d", r.WorkerMs)
	}
	if !reflect.DeepEqual(r.Commits, []wshrpc.DagLandedCommit{{TaskId: "t-0", Commit: "sha-0"}}) {
		t.Fatalf("only merged tasks' commits are landed, got %+v", r.Commits)
	}
	if r.Unverified || r.Answered != 2 || r.Forwarded != 1 {
		t.Fatalf("want verified, 2 answered, 1 forwarded, got %+v", r)
	}
}

func TestDigestReportUnverified(t *testing.T) {
	cases := []struct {
		name   string
		merge  bool
		verify string
		want   bool
	}{
		{"a Verify line on a git project", true, "task test", false},
		{"no Verify line", true, "", true},
		{"no merge points to verify at", false, "task test", true},
	}
	for _, c := range cases {
		g := digestGroup(t, c.merge, plainTasks())
		g.Verify = c.verify
		if got := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow)).Report.Unverified; got != c.want {
			t.Fatalf("%s: unverified = %v, want %v", c.name, got, c.want)
		}
	}
}
```

Append to `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`:

```go
func TestDagStatusLinesCarriesTheReportAndVerifyFailure(t *testing.T) {
	g := &waveobj.TaskGroup{
		ID: "dag-1", Status: "blocked", Parallelism: 1,
		Tasks: []waveobj.TaskNode{{ID: "t-0", Label: "a", State: "verify-failed", VerifyError: "exit 1: FAIL pkg/orchestrate"}},
	}
	rtn := &wshrpc.CommandDagStatusRtnData{
		Group: g,
		Digest: wshrpc.DagStatusDigest{
			Counts:    wshrpc.DagStatusCounts{Total: 1},
			Tasks:     []wshrpc.DagTaskDigest{{TaskId: "t-0", HumanActions: []string{"resolve-merge"}}},
			Durations: wshrpc.DagDurationDigest{ElapsedMs: 12 * 60_000},
			Report: wshrpc.DagReportDigest{
				WorkerMs: 34 * 60_000, Answered: 1, Forwarded: 2, Unverified: true,
				Commits: []wshrpc.DagLandedCommit{{TaskId: "t-0", Commit: "0123456789abcdef"}},
			},
		},
	}
	joined := strings.Join(dagStatusLines(rtn, 0), "\n")
	for _, want := range []string{
		"report  elapsed=12m  workers=34m  commits=1  answered=1  forwarded=2  unverified",
		"landed  t-0 0123456",
		"t-0 verify failed: exit 1: FAIL pkg/orchestrate",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("status must show %q, got:\n%s", want, joined)
		}
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test ./pkg/orchestrate -run TestDigest -count=1` and `go test ./cmd/wsh/cmd -run TestDagStatusLines -count=1`
Expected: build FAIL with `unknown field Report` / `undefined: wshrpc.DagLandedCommit`.

- [ ] **Step 3: Add the report types**

In `pkg/wshrpc/wshrpctypes_dag.go`, replace `DagStatusDigest` with:

```go
type DagStatusDigest struct {
	DagVersion int               `json:"dagversion"`
	Health     string            `json:"health"` // needs-you | stalled | healthy | done | cancelled
	Counts     DagStatusCounts   `json:"counts"`
	Next       DagNextStep       `json:"next"`
	Tasks      []DagTaskDigest   `json:"tasks"`
	Durations  DagDurationDigest `json:"durations"`
	Report     DagReportDigest   `json:"report"`
}

// DagReportDigest is what the lead writes its run-end report from, and what the run card shows.
type DagReportDigest struct {
	WorkerMs   int64             `json:"workerms"`             // the tasks' run time, summed
	Commits    []DagLandedCommit `json:"commits,omitempty"`    // merged tasks' squash commits, in dag order
	Unverified bool              `json:"unverified,omitempty"` // no merge point ran a Verify: no Verify line, or nothing to merge into
	Answered   int               `json:"answered"`             // child questions answered, by the lead or the human
	Forwarded  int               `json:"forwarded"`            // judgments handed to the human
}

type DagLandedCommit struct {
	TaskId string `json:"taskid"`
	Commit string `json:"commit"`
}
```

In the same file, change the `DagNextStep.Kind` comment to `// human-action | merge-ready | dispatch | parallelism-wait | verify-wait | dependency-wait | cleanup-wait | terminal`, and the `DagTaskDigest.WaitReason` comment to `// none | dependency | parallelism | gate | ask | failure | merge | verify | cleanup | terminal`.

- [ ] **Step 4: Derive the digest**

In `pkg/orchestrate/digest.go`:

In `BuildDigest`, replace:

```go
		Durations:  buildDurations(sn),
	}
```

with:

```go
		Durations:  buildDurations(sn),
	}
	d.Report = buildReport(sn, d.Durations)
```

In `taskAttention`, replace `if t.State == TaskState_Failed || t.State == TaskState_BlockedMerge {` with `if t.State == TaskState_Failed || t.State == TaskState_BlockedMerge || t.State == TaskState_VerifyFailed {`.

In `buildNext`, after the blocked-merge step:

```go
	if ids := tasksInState(g, TaskState_BlockedMerge); len(ids) > 0 {
		return humanActionStep("resolve-merge", ids, digestActionResolveMerge)
	}
	if ids := tasksInState(g, TaskState_VerifyFailed); len(ids) > 0 {
		return humanActionStep("resolve-verify", ids, digestActionResolveMerge)
	}
```

and after step 4b (the `mergeReadyIDs` step), before step 5:

```go
	// 4c. a merged task's Verify is running; the next merge and its dependents wait on it
	if ids := tasksInState(g, TaskState_Verifying); len(ids) > 0 {
		return wshrpc.DagNextStep{Kind: "verify-wait", TaskIds: ids}
	}
```

In `taskWaitReason`, add a case before `case TaskState_Done:`:

```go
	case TaskState_Verifying, TaskState_VerifyFailed:
		return "verify"
```

In `taskHumanActions`, replace `case t.State == TaskState_BlockedMerge:` with `case t.State == TaskState_BlockedMerge || t.State == TaskState_VerifyFailed:`.

Add after `buildDurations`:

```go
// buildReport gathers the run-end numbers. Worker time sums the per-task run time already derived for
// Durations, so the two cannot disagree.
func buildReport(sn DagDigestSnapshot, durations wshrpc.DagDurationDigest) wshrpc.DagReportDigest {
	g := sn.Group
	r := wshrpc.DagReportDigest{Unverified: !g.MergeRequired || g.Verify == ""}
	for _, td := range durations.Tasks {
		r.WorkerMs += td.RunMs
	}
	endCommit := map[string]string{}
	for _, run := range sn.Runs {
		if run != nil {
			endCommit[run.ID] = run.EndCommit
		}
	}
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if c := endCommit[t.RunID]; t.Merged && c != "" {
			r.Commits = append(r.Commits, wshrpc.DagLandedCommit{TaskId: t.ID, Commit: c})
		}
	}
	for _, ev := range sn.Retained {
		switch ev.Kind {
		case waveobj.RunEventKindChildAnswered:
			r.Answered++
		case waveobj.RunEventKindTaskForwarded:
			r.Forwarded++
		}
	}
	return r
}
```

In `pkg/wshrpc/wshserver/wshserver_dag.go`, replace the comment `// dagDigestRetainedKinds are the lifecycle boundaries the digest derives durations and retries from.` with `// dagDigestRetainedKinds are the lifecycle rows the digest derives durations, retries and the report's counts from.`, and add two entries after `waveobj.RunEventKindDagCancelled,`:

```go
	waveobj.RunEventKindDagCancelled,
	waveobj.RunEventKindChildAnswered,
	waveobj.RunEventKindTaskForwarded,
}
```

- [ ] **Step 5: Print the report in `dag status`**

In `cmd/wsh/cmd/wshcmd-jarvisdag.go`, `dagStatusLines`, replace:

```go
	lines := []string{line}
	if len(g.Tasks) == 0 {
		return lines
	}
```

with:

```go
	lines := []string{line, reportLine(d)}
	if len(d.Report.Commits) > 0 {
		landed := make([]string, len(d.Report.Commits))
		for i, c := range d.Report.Commits {
			landed[i] = c.TaskId + " " + c.Commit[:min(7, len(c.Commit))]
		}
		lines = append(lines, "landed  "+strings.Join(landed, ", "))
	}
	if len(g.Tasks) == 0 {
		return lines
	}
```

and replace the end of the function:

```go
	for _, row := range strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n") {
		lines = append(lines, row)
	}
	return lines
}
```

with:

```go
	for _, row := range strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n") {
		lines = append(lines, row)
	}
	// the lead fixes a failed Verify from its output, so the whole kept tail is printed
	for _, t := range g.Tasks {
		if t.State == orchestrate.TaskState_VerifyFailed && t.VerifyError != "" {
			lines = append(lines, fmt.Sprintf("%s verify failed: %s", t.ID, t.VerifyError))
		}
	}
	return lines
}

// reportLine carries what the lead's run-end report is written from.
func reportLine(d wshrpc.DagStatusDigest) string {
	line := fmt.Sprintf("report  elapsed=%s  workers=%s  commits=%d  answered=%d  forwarded=%d",
		durOrZero(d.Durations.ElapsedMs), durOrZero(d.Report.WorkerMs), len(d.Report.Commits), d.Report.Answered, d.Report.Forwarded)
	if d.Report.Unverified {
		line += "  unverified"
	}
	return line
}

func durOrZero(ms int64) string {
	if s := compactDur(ms); s != "" {
		return s
	}
	return "0s"
}
```

Run `task generate`.

- [ ] **Step 6: Run the tests**

Run: `go test ./pkg/orchestrate -count=1`, `go test ./pkg/wshrpc/wshserver -count=1`, `go test ./cmd/wsh/cmd -count=1`
Expected: PASS, including the existing digest tests and `TestDagStatusLinesUsesDigest`.

---

### Task 6: Frontend: states, actions, timeline rows, next step, report chips

**Files:**
- Modify: `frontend/app/view/orchestrate/daggraph.tsx` (`STATE_TONE`, the `runAction` comment)
- Modify: `frontend/app/view/orchestrate/dagstore.ts` (`ACTION_BY_STATE`)
- Modify: `frontend/app/view/orchestrate/workertasksort.ts`
- Modify: `frontend/app/view/orchestrate/attentionqueue.ts`
- Modify: `frontend/app/view/agents/runtimeline.ts` (`RUN_GROUP_KINDS`, `KIND_TITLE`, `KIND_TONE`)
- Modify: `frontend/app/view/orchestrate/timelinefilter.ts` (`ATTENTION_KINDS`, `TASK_TARGET_KINDS`)
- Modify: `frontend/app/view/orchestrate/dagdigest.ts` (`nextStepText`, `formatElapsed` moved here, `reportChips`)
- Modify: `frontend/app/view/orchestrate/dagoverview.tsx` (report chips; its local `formatElapsed` removed)
- Tests: `dagstore.test.ts`, `workertasksort.test.ts`, `attentionqueue.test.ts`, `timelinefilter.test.ts`, `dagdigest.test.ts` (all in `frontend/app/view/orchestrate/`), `frontend/app/view/agents/runtimeline.test.ts`. Add to each with Edit; all exist.

**Interfaces:**
- Consumes: the generated `TaskNode.verifyerror`, `TaskGroup.verify`/`setup`, `DagStatusDigest.report`, `DagReportDigest`, `DagLandedCommit` types from `task generate` (Tasks 2, 3, 5); task states `verifying`/`verify-failed`; digest wait reason `verify` and next kind `verify-wait`; event kinds `task-verify-started`/`-passed`/`-failed`.
- Produces: `export function formatElapsed(ms: number): string` and `export function reportChips(report: DagReportDigest | undefined): string[]` in `dagdigest.ts`.

- [ ] **Step 1: Write the failing tests**

In `frontend/app/view/orchestrate/dagstore.test.ts`, add inside `describe("buildViewData", ...)`, after `"flags gate and failure states"`:

```ts
    it("offers resolve on a failed Verify, which re-runs it through merge --continue", () => {
        const failed = { ...group, tasks: [{ id: "t-0", label: "setup", state: "verify-failed", merged: true }] } as any;
        expect(buildViewData(failed, owner, harnesses).nodes[0].actions).toEqual(["resolve"]);
    });
```

In `frontend/app/view/orchestrate/workertasksort.test.ts`, add inside `describe("workerBucket", ...)`:

```ts
    it("buckets a failed Verify as attention and a running one as running", () => {
        expect(workerBucket(td("verify"), node("verify-failed"))).toBe("attention");
        expect(workerBucket(td("verify"), node("verifying"))).toBe("running");
    });
```

In `frontend/app/view/orchestrate/attentionqueue.test.ts`, add inside `describe("attentionQueue membership", ...)`:

```ts
    it("queues a failed Verify against the task", () => {
        const [entry] = queue(
            [node("t-1", { state: "verify-failed", runid: "r1", merged: true })],
            [row("t-1", { waitreason: "verify", mergestate: "merged", humanactions: ["resolve-merge"] })]
        );
        expect(entry).toMatchObject({ taskId: "t-1", detail: "verify-failed", actions: ["resolve-merge"], target: "task" });
    });
```

In `frontend/app/view/orchestrate/timelinefilter.test.ts`, add inside the `filterEvents` describe that holds `"a wake that landed is not attention"`:

```ts
    it("a failed Verify is attention; a passing one is not", () => {
        expect(ATTENTION_KINDS.has("task-verify-failed")).toBe(true);
        expect(ATTENTION_KINDS.has("task-verify-passed")).toBe(false);
    });
```

and inside `describe("eventClickTarget", ...)`:

```ts
    it("routes Verify rows to merge state", () => {
        expect(eventClickTarget(ev("task-verify-failed", { taskid: "t-6" }))).toEqual({ kind: "merge", taskId: "t-6" });
    });
```

In `frontend/app/view/agents/runtimeline.test.ts`, add after `describe("eventKindTitle", ...)`:

```ts
describe("verify rows", () => {
    it("names and tones the merge-point Verify rows", () => {
        expect(eventKindTitle("task-verify-started")).toBe("Verify started");
        expect(eventKindTitle("task-verify-passed")).toBe("Verify passed");
        expect(eventKindTitle("task-verify-failed")).toBe("Verify failed");
        expect(toneFor("task-verify-started")).toBe("text-muted");
        expect(toneFor("task-verify-passed")).toBe("text-success");
        expect(toneFor("task-verify-failed")).toBe("text-warning");
    });
});
```

In `frontend/app/view/orchestrate/dagdigest.test.ts`, add `formatElapsed` and `reportChips` to the import list from `"./dagdigest"`, and append:

```ts
describe("reportChips", () => {
    it("shows only the numbers that carry news, and flags an untested run", () => {
        expect(reportChips(undefined)).toEqual([]);
        expect(
            reportChips({
                workerms: 34 * 60_000,
                commits: [{ taskid: "t-0", commit: "abc" }],
                answered: 1,
                forwarded: 0,
                unverified: true,
            })
        ).toEqual(["workers 34m", "landed 1", "answered 1", "unverified"]);
    });
});

describe("formatElapsed", () => {
    it("renders seconds, minutes and hours", () => {
        expect(formatElapsed(45_000)).toBe("45s");
        expect(formatElapsed(12 * 60_000)).toBe("12m");
        expect(formatElapsed(65 * 60_000)).toBe("1h5m");
    });
});

describe("nextStepText verify-wait", () => {
    it("names the task whose Verify is running", () => {
        const briefs = new Map([["t-0", { label: "scaffold", state: "verifying" }]]);
        expect(nextStepText({ kind: "verify-wait", taskids: ["t-0"] }, briefs)).toBe("running Verify after scaffold");
    });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run frontend/app/view/orchestrate frontend/app/view/agents/runtimeline.test.ts`
Expected: FAIL on each new test (`reportChips is not a function`, `expected [] to equal ["resolve"]`, and so on).

- [ ] **Step 3: Implement**

`frontend/app/view/orchestrate/daggraph.tsx`: in `STATE_TONE`, after the `"blocked-merge"` entry add:

```ts
    verifying: "border-accent/60 bg-accent/15 text-accent-soft",
    "verify-failed": "border-warning/70 bg-warning/15 text-warning",
```

and in the `runAction` comment replace `"resolve" finishes a blocked squash merge the human resolved in the` / `// project tree;` with `"resolve" is merge --continue: it finishes a squash merge the human resolved in the project` / `// tree, or re-runs a failed Verify after their fix;`.

`frontend/app/view/orchestrate/dagstore.ts`, `ACTION_BY_STATE`:

```ts
const ACTION_BY_STATE: Record<string, string[]> = {
    "blocked-merge": ["resolve"],
    "verify-failed": ["resolve"],
    failed: ["retry", "skip"],
    stalled: ["retry", "skip"],
};
```

`frontend/app/view/orchestrate/workertasksort.ts`, the `switch (node.state)`:

```ts
        case "failed":
        case "stalled":
        case "blocked-merge":
        case "verify-failed":
            return "attention";
        case "running":
        case "verifying":
            return "running";
```

`frontend/app/view/orchestrate/attentionqueue.ts`, `needsAttention`: replace `if (task.state === "failed" || task.state === "stalled" || task.state === "blocked-merge") {` with `if (task.state === "failed" || task.state === "stalled" || task.state === "blocked-merge" || task.state === "verify-failed") {`.

`frontend/app/view/agents/runtimeline.ts`: add `"task-verify-started"`, `"task-verify-passed"`, `"task-verify-failed"` to `RUN_GROUP_KINDS` after `"lead-wake-failed"`; add to `KIND_TITLE` after `"lead-wake-failed"`:

```ts
    "task-verify-started": "Verify started",
    "task-verify-passed": "Verify passed",
    "task-verify-failed": "Verify failed",
```

and to `KIND_TONE`: `"task-verify-passed": "text-success",` after `"task-merge-continued"`, `"task-verify-failed": "text-warning",` after `"lead-wake-failed"`, `"task-verify-started": "text-muted",` after `"lead-woken"`.

`frontend/app/view/orchestrate/timelinefilter.ts`: add `"task-verify-failed",` to `ATTENTION_KINDS` after `"task-merge-blocked"`; add to `TASK_TARGET_KINDS` after `"task-merged": "merge",`:

```ts
    "task-verify-started": "merge",
    "task-verify-passed": "merge",
    "task-verify-failed": "merge",
```

`frontend/app/view/orchestrate/dagdigest.ts`: in `nextStepText`, add before `case "dependency-wait":`:

```ts
        case "verify-wait":
            return "running Verify" + (named ? ` after ${named}` : "");
```

and add after `nextStepText`:

```ts
// formatElapsed is the overview's short clock ("45s", "12m", "1h5m").
export function formatElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) {
        return `${s}s`;
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
        return `${m}m`;
    }
    return `${Math.floor(m / 60)}h${m % 60}m`;
}

// reportChips is the run card's copy of the numbers the lead reports from. A zero carries no news and is
// left out; an untested run is always said.
export function reportChips(report: DagReportDigest | undefined): string[] {
    if (report == null) {
        return [];
    }
    const chips: string[] = [];
    if (report.workerms > 0) {
        chips.push(`workers ${formatElapsed(report.workerms)}`);
    }
    if (report.commits?.length) {
        chips.push(`landed ${report.commits.length}`);
    }
    if (report.answered > 0) {
        chips.push(`answered ${report.answered}`);
    }
    if (report.forwarded > 0) {
        chips.push(`forwarded ${report.forwarded}`);
    }
    if (report.unverified) {
        chips.push("unverified");
    }
    return chips;
}
```

`frontend/app/view/orchestrate/dagoverview.tsx`: add `formatElapsed,` and `reportChips,` to the import list from `"./dagdigest"`; delete the local `function formatElapsed(ms: number): string { ... }`; replace:

```tsx
                    {elapsed ? <span>{formatElapsed(elapsed)}</span> : null}
```

with:

```tsx
                    {elapsed ? <span>{formatElapsed(elapsed)}</span> : null}
                    {(counts ? reportChips(digest?.report) : []).map((chip) => (
                        <span key={chip}>{chip}</span>
                    ))}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run frontend/app/view/orchestrate frontend/app/view/agents/runtimeline.test.ts`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 7: Docs, full verification, commit

**Files:**
- Modify: `docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md` (status line, §14 constants)
- Modify: `docs/deferred.md` (new entry at the top)
- Modify: `docs/open-issues.md` (mirror row)

- [ ] **Step 1: Update the spec**

Replace the status line:

```
**Status:** Design approved in conversation 2026-09-14. Slices 1-3 built (b3540636, e9e480b3, 2ce4161b). Slice 4 is split into 4a-4d (§13).
```

with:

```
**Status:** Design approved in conversation 2026-09-14. Slices 1-3 built (b3540636, e9e480b3, 2ce4161b). Slice 4 is split into 4a-4d (§13); 4a and 4b are built (eb5a3654, 48d5d5bd), and 4c is built from `docs/superpowers/plans/2026-09-15-orchestrator-redesign-s4c-setup-merge-verify.md`.
```

In §14, replace:

```
  - `VerifyTimeout = 20m`
```

with:

```
  - `VerifyTimeout = 20m`
  - `SetupTimeout = 2m` (slice 4c): Setup runs under the dag mutation lock, so it prepares a tree and does not install
  - `MaxPlanOutputLen = 1000` bytes (slice 4c): the tail of a failing Setup or Verify kept for the lead
```

- [ ] **Step 2: Record the deferrals**

In `docs/deferred.md`, insert above `## Codex and opencode run workers (2026-09-14)`:

```markdown
## Merge-point Verify: a timeout kills the shell only, and a failed Verify holds only its own run's merges (2026-09-15)

Slice 4c of the orchestrator redesign (`docs/superpowers/plans/2026-09-15-orchestrator-redesign-s4c-setup-merge-verify.md`)
runs a plan's Setup and Verify commands through the platform shell and serializes merges per project checkout.

- **What was deferred:**
  - At `SetupTimeout` or `VerifyTimeout`, `execPlanCommand` (`pkg/orchestrate/plancmd.go`) kills the shell it
    started (`cmd.exe` or `sh`). A test runner the shell started keeps running until it exits on its own;
    `WaitDelay` only stops the engine waiting for it.
  - The landing claim (`pkg/orchestrate/verify.go`) serializes a merge and its Verify across every dag in one
    checkout, but a persisted `verify-failed` task holds only its own dag's later merges. A second orchestrator
    run in the same checkout would land on top of the failure.
- **Why:** both need machinery that one run per checkout does not: a process tree kill (a Windows job object,
  a Unix process group), and a store scan across dags by project path.
- **Where to pick it up:** `pkg/shellexec/jobobject_windows.go` already kills a process tree through a job
  object; export it and attach it in `execPlanCommand` after `Start`. For the hold, have `AutoMergeReady` scan
  the non-terminal dags whose owner run has the same `ProjectPath`.
```

In `docs/open-issues.md`, add a row directly after the row that starts `| Codex and opencode cannot run leads or task workers |`:

```markdown
| A merge-point Verify timeout kills the shell but not its children, and one run's failed Verify does not hold another run's merges in the same checkout | limitation | M | `docs/deferred.md` 2026-09-15 entry, with where each fix plugs in. **Deferred 2026-09-15 by orchestrator redesign slice 4c**: one run per checkout needs neither |
```

- [ ] **Step 3: Verify everything**

From PowerShell at the repo root:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/orchestrate/... ./pkg/wshrpc/... ./pkg/waveobj/... ./pkg/jarvis/... ./cmd/wsh/... -count=1
gofmt -l pkg cmd
go vet ./pkg/orchestrate/... ./pkg/wshrpc/... ./cmd/wsh/...
task generate
git status --short
```

Expected: every test PASSes; `gofmt -l` prints nothing; `go vet` reports nothing new; after `task generate`, `git status --short` shows no generated file changed beyond what Tasks 2-5 already regenerated.

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
```

Expected: tsc exit 0. vitest: every test in files this slice touched passes. A failure in a file this slice did not touch (the other session's `frontend/app/view/jarvis/*` edits are uncommitted) is recorded in the commit report, not fixed here.

Not live-checked: the dev app's `wavesrv` and `wsh` are not rebuilt. Setup and Verify against a real run are the effort's Live acceptance chunk.

- [ ] **Step 4: Tick the effort chunk**

```bash
wsh effort chunk status aeabb4ad-a19c-4f5d-bba2-44586b73af16 "S4c Setup + merge-point Verify - verify-failed, merge --continue, per-project merge queue, report numbers (plan)" done --note "<commit sha and date>: Setup in new worktrees, Verify after each merge, verify-failed + merge --continue, per-project landing claim, report numbers. Junction-safe removal landed first as <task 1 sha>. Verified: <the test commands that passed>. Not live-checked."
```

- [ ] **Step 5: Commit**

Stage only this slice's files. Run `git status --short` first and stage each path below that it lists as changed, plus any generated file `task generate` rewrote:

```bash
git add pkg/waveobj/wtype.go pkg/waveobj/runevent.go \
  pkg/orchestrate/dag.go pkg/orchestrate/dag_test.go pkg/orchestrate/plancmd.go pkg/orchestrate/plancmd_windows.go \
  pkg/orchestrate/plancmd_other.go pkg/orchestrate/plancmd_test.go pkg/orchestrate/worktree.go pkg/orchestrate/worktree_test.go \
  pkg/orchestrate/mutation.go pkg/orchestrate/mutation_test.go pkg/orchestrate/retry.go pkg/orchestrate/engine.go \
  pkg/orchestrate/setup_test.go pkg/orchestrate/queue.go pkg/orchestrate/verify.go pkg/orchestrate/verify_test.go \
  pkg/orchestrate/mergetask.go pkg/orchestrate/continue_test.go pkg/orchestrate/digest.go pkg/orchestrate/digestverify_test.go \
  pkg/wshrpc/wshrpctypes_dag.go pkg/wshrpc/wshserver/wshserver_dag.go pkg/wshrpc/wshserver/wshserver_dagplan_test.go \
  cmd/wsh/cmd/wshcmd-jarvisdag.go cmd/wsh/cmd/wshcmd-jarvisdag_test.go frontend/types/gotypes.d.ts \
  frontend/app/view/orchestrate/daggraph.tsx frontend/app/view/orchestrate/dagstore.ts frontend/app/view/orchestrate/dagstore.test.ts \
  frontend/app/view/orchestrate/workertasksort.ts frontend/app/view/orchestrate/workertasksort.test.ts \
  frontend/app/view/orchestrate/attentionqueue.ts frontend/app/view/orchestrate/attentionqueue.test.ts \
  frontend/app/view/orchestrate/timelinefilter.ts frontend/app/view/orchestrate/timelinefilter.test.ts \
  frontend/app/view/orchestrate/dagdigest.ts frontend/app/view/orchestrate/dagdigest.test.ts frontend/app/view/orchestrate/dagoverview.tsx \
  frontend/app/view/agents/runtimeline.ts frontend/app/view/agents/runtimeline.test.ts \
  docs/orchestrator-howto.md docs/deferred.md docs/open-issues.md \
  docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md \
  docs/superpowers/plans/2026-09-15-orchestrator-redesign-s4c-setup-merge-verify.md
git diff --cached --stat
git commit -m "feat(orchestrate): run the plan's Setup in each new worktree and its Verify after each merge, so a broken merge point wakes the lead and holds later merges until the fix passes"
```

`git diff --cached --stat` must list none of the other session's files named in Global Constraints.

---

## Self-review notes

- **Spec coverage (§4 Worktrees and Setup, Tests, Merges, End of run; §12 Merge-point Verify):**
  - Setup after `worktree add`, failure kind `setup` as a judgment event: Task 2.
  - Verify after each squash merge, in the project checkout: Task 3.
  - `verify-failed` on non-zero exit or `VerifyTimeout`, wake: Task 3.
  - Merges serialized per project, next merge waits on the running Verify, lock not held: Task 3.
  - `--continue` re-runs Verify and releases the queue on a pass: Task 4.
  - No Verify line means no check and "unverified": Tasks 3 and 5.
  - Report numbers in `dag status` and on the run card: Tasks 5 and 6.
- **Beyond the spec, and why:**
  - The `verifying` state makes a Verify in flight persist across restart, and makes dependents wait on it.
  - The `DeriveTaskStates` guard is required for `verify-failed` to hold. It also stops `blocked-merge` flipping back to `done`.
  - Junction-safe removal is required before the engine runs `task worktree:prepare`.
- **Deferred:** the process-tree kill and cross-run hold (Task 7, `docs/deferred.md`). Lanes, lane-tip merges and the spec/plan fold are slice 4d.
