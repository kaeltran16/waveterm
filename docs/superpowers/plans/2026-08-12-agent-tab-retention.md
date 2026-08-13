# Agent Tab Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent-session tabs (tab meta `session:agent`) close automatically 2s after the agent process exits, on any exit code, unless the block opts out.

**Architecture:** Flip the close-on-exit default for agent-session blocks inside the existing `checkCloseOnExit` exit path in `pkg/blockcontroller/shellcontroller.go`. A new pure decision helper `agentShouldCloseOnExit(blockMeta, tabMeta, exitCode)` carries the policy (unit-testable, no I/O); the existing exit hook fetches the tab (same `DBFindTabForBlockId` pattern as `emitAgentIdleOnExit`) and calls it. `DeleteBlock` (recursive) already removes the now-empty parent tab, so tab cleanup needs no new plumbing.

**Tech Stack:** Go (wavesrv backend), SQLite-backed wstore. No codegen, no frontend changes, no new dependencies.

## Global Constraints

- New meta key: `cmd:keeponexit` (constant `MetaKey_CmdKeepOnExit` in `pkg/waveobj/metaconsts.go`). Freeform `MetaMapType` key — do NOT add a `wtypemeta` field and do NOT run `task generate`.
- `session:agent` is read from the **tab's** meta (`MetaKey_SessionAgent`, already defined at `metaconsts.go:151`), never from block meta.
- Agent blocks close on **any** exit code. Non-agent blocks keep existing semantics exactly: close only with `cmd:closeonexit` AND exit code 0, or `cmd:closeonexitforce`.
- `cmd:closeonexitforce` overrides `cmd:keeponexit`.
- Grace: existing `cmd:closeonexitdelay` (default 2000ms), clamped at >= 0.
- If the tab is already gone at exit time, do nothing.
- Existing tests must stay green: `go test ./pkg/blockcontroller/...` and `go test ./pkg/...` (the full suite needs `CGO_CFLAGS` — see Task 2 step 5 for the exact Windows-style path requirement).

---

### Task 1: Decision helper + meta constant + unit tests

**Files:**
- Modify: `pkg/waveobj/metaconsts.go` (add one constant after `MetaKey_CmdCloseOnExitDelay`, line ~51)
- Modify: `pkg/blockcontroller/shellcontroller.go` (add pure helper next to `idleOnExitEvent`, ~line 660)
- Modify: `pkg/blockcontroller/blockcontroller_test.go` (append test — file exists, use append/edit, never whole-file write)

**Interfaces:**
- Produces: `func agentShouldCloseOnExit(blockMeta waveobj.MetaMapType, tabMeta waveobj.MetaMapType, exitCode int) bool` — returns true when an exited block should be deleted. Consumed by Task 2's `checkCloseOnExit`.
- Produces: `waveobj.MetaKey_CmdKeepOnExit = "cmd:keeponexit"` constant.

- [ ] **Step 1: Write the failing test**

Append this test to `pkg/blockcontroller/blockcontroller_test.go` (after `TestIdleOnExitEvent`; keep the existing imports — `waveobj` and `testing` are already imported):

```go
func TestAgentShouldCloseOnExit(t *testing.T) {
	agentTab := waveobj.MetaMapType{"session:agent": "claude"}
	plainTab := waveobj.MetaMapType{}
	tests := []struct {
		name     string
		block    waveobj.MetaMapType
		tab      waveobj.MetaMapType
		exitCode int
		want     bool
	}{
		{"agent clean exit closes", waveobj.MetaMapType{}, agentTab, 0, true},
		{"agent nonzero exit closes", waveobj.MetaMapType{}, agentTab, 1, true},
		{"agent keeponexit keeps", waveobj.MetaMapType{"cmd:keeponexit": true}, agentTab, 0, false},
		{"agent keeponexit keeps on nonzero too", waveobj.MetaMapType{"cmd:keeponexit": true}, agentTab, 1, false},
		{"agent force closes over keeponexit", waveobj.MetaMapType{"cmd:keeponexit": true, "cmd:closeonexitforce": true}, agentTab, 1, true},
		{"plain terminal no flags keeps", waveobj.MetaMapType{}, plainTab, 0, false},
		{"plain closeonexit clean exit closes", waveobj.MetaMapType{"cmd:closeonexit": true}, plainTab, 0, true},
		{"plain closeonexit nonzero keeps", waveobj.MetaMapType{"cmd:closeonexit": true}, plainTab, 1, false},
		{"plain force closes", waveobj.MetaMapType{"cmd:closeonexitforce": true}, plainTab, 1, true},
	}
	for _, tc := range tests {
		got := agentShouldCloseOnExit(tc.block, tc.tab, tc.exitCode)
		if got != tc.want {
			t.Errorf("%s: agentShouldCloseOnExit(%v, %v, %d) = %v, want %v", tc.name, tc.block, tc.tab, tc.exitCode, got, tc.want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/blockcontroller/...`
Expected: FAIL — build error `undefined: agentShouldCloseOnExit` (the test can't compile yet; that is the correct failing state).

- [ ] **Step 3: Add the meta constant**

In `pkg/waveobj/metaconsts.go`, directly after `MetaKey_CmdCloseOnExitDelay` (line ~51):

```go
	MetaKey_CmdKeepOnExit                    = "cmd:keeponexit"
```

Match the existing alignment of the `MetaKey_` block (run `gofmt -w pkg/waveobj/metaconsts.go` if alignment shifts).

- [ ] **Step 4: Write the minimal implementation**

In `pkg/blockcontroller/shellcontroller.go`, immediately above `checkCloseOnExit` (near line ~696), add:

```go
// agentShouldCloseOnExit reports whether an exited block should be deleted. Agent-session
// blocks (tab meta session:agent) close on any exit code unless the block opts out with
// cmd:keeponexit. Non-agent blocks keep the historical opt-in semantics. Pure: no I/O.
func agentShouldCloseOnExit(blockMeta waveobj.MetaMapType, tabMeta waveobj.MetaMapType, exitCode int) bool {
	if blockMeta.GetBool(waveobj.MetaKey_CmdCloseOnExitForce, false) {
		return true
	}
	if tabMeta.GetString(waveobj.MetaKey_SessionAgent, "") != "" {
		return !blockMeta.GetBool(waveobj.MetaKey_CmdKeepOnExit, false)
	}
	closeOnExit := blockMeta.GetBool(waveobj.MetaKey_CmdCloseOnExit, false)
	return closeOnExit && exitCode == 0
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./pkg/blockcontroller/...`
Expected: PASS (all tests, including the pre-existing `TestAgentStatusEvent` / `TestIdleOnExitEvent`).

- [ ] **Step 6: Commit**

```bash
git add pkg/waveobj/metaconsts.go pkg/blockcontroller/shellcontroller.go pkg/blockcontroller/blockcontroller_test.go
git commit -m "feat(blockcontroller): close agent-session tabs on exit by default"
```

---

### Task 2: Wire the decision into checkCloseOnExit

**Files:**
- Modify: `pkg/blockcontroller/shellcontroller.go` — `checkCloseOnExit` (~line 696): replace the two meta reads with a tab lookup + the pure helper.

**Interfaces:**
- Consumes: `agentShouldCloseOnExit(blockMeta, tabMeta, exitCode) bool` from Task 1; `wstore.DBFindTabForBlockId(ctx, blockId) (string, error)`; `wstore.DBMustGet[*waveobj.Tab](ctx, tabId)`; `waveobj.MetaKey_SessionAgent`.

- [ ] **Step 1: Rewrite the decision block**

Current code in `checkCloseOnExit` (after the `DBMustGet[*waveobj.Block]` error check):

```go
	closeOnExit := blockData.Meta.GetBool(waveobj.MetaKey_CmdCloseOnExit, false)
	closeOnExitForce := blockData.Meta.GetBool(waveobj.MetaKey_CmdCloseOnExitForce, false)
	if !closeOnExitForce && !(closeOnExit && exitCode == 0) {
		return
	}
```

Replace with (tab lookup mirrors `emitAgentIdleOnExit`, which sits ~30 lines above):

```go
	tabMeta := waveobj.MetaMapType{}
	tabId, tabErr := wstore.DBFindTabForBlockId(ctx, blockId)
	if tabErr == nil {
		if tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId); err == nil {
			tabMeta = tab.Meta
		}
	}
	if !agentShouldCloseOnExit(blockData.Meta, tabMeta, exitCode) {
		return
	}
```

Leave the rest of the function (delay read, `time.Sleep`, `wshclient.DeleteBlockCommand`) unchanged.

- [ ] **Step 2: Build the package**

Run: `go build ./pkg/blockcontroller/`
Expected: no output, exit 0.

- [ ] **Step 3: Run the package tests**

Run: `go test ./pkg/blockcontroller/...`
Expected: PASS.

- [ ] **Step 4: Run the full backend suite**

The full suite needs the sqlite-vec CGO header with a **Windows-style** path (a Git-Bash POSIX path like `/c/Users/...` silently fails). From the repo root, run:

```bash
CGO_CFLAGS="-O2 -g -IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./pkg/...
```

Expected: PASS (baseline is clean; any failure is real).

- [ ] **Step 5: Rebuild the dev backend binary**

Run: `task build:backend`
Expected: builds `dist/bin/wavesrv.x64.exe` + `wsh`. (Run in the main repo, not a worktree — the dev app spawns wavesrv from the main repo's `dist/bin`.)

- [ ] **Step 6: Manual dev-app verification**

With the dev app running (`task dev`, restarted after the build so it picks up the new wavesrv):

1. Launch a real agent session from the cockpit (New Agent flow) with a trivial prompt (e.g. "reply ok"), or any path that stamps `session:agent` on the tab.
2. When the agent exits, confirm the tab closes ~2s later and the roster row disappears.
3. Open a plain terminal tab and run `cmd /c exit 0` — confirm it does NOT close (non-agent behavior unchanged).
4. Optional: `wsh setmeta -b <blockid> cmd:keeponexit=true` on an agent block before it exits — confirm the tab stays.

- [ ] **Step 7: Commit**

```bash
git add pkg/blockcontroller/shellcontroller.go
git commit -m "feat(blockcontroller): auto-close agent tabs on process exit"
```

---

## Self-Review Notes

- **Spec coverage:** Behavior (1) → Task 1 helper + Task 2 wiring; opt-out key → Task 1; non-agent unchanged → Task 1 test cases + Task 2 step 6; roster ordering (idle emit fires before the 2s-delayed delete) → no code needed, verified by the unchanged call sites in the exit hook (`emitAgentIdleOnExit` and `checkCloseOnExit` are both fired at exit); testing (4) → Task 1 table tests + Task 2 steps 2-6.
- **No placeholders:** every step has concrete code or an exact command.
- **Type consistency:** `agentShouldCloseOnExit(blockMeta, tabMeta, exitCode) bool` is defined in Task 1 and consumed identically in Task 2; `MetaKey_CmdKeepOnExit` constant name used in both tasks; existing `MetaKey_CmdCloseOnExit*` and `MetaKey_SessionAgent` constants referenced by their defined names.
