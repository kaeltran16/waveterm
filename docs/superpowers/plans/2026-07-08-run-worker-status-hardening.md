# Run-worker Status Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a run worker's coarse lifecycle (working → idle) fully backend-owned so a finished worker can never linger as "working," add opt-in diagnostics to the reporter hook, stop coexisting installs from churning each other's hook config, and verify cross-install status routing live.

**Architecture:** The backend already emits a retained `agent:status = working` when it spawns a run worker; this plan adds the matching `idle` from the block controller's process-exit path (scoped to agent sessions), extracts the event constructor so spawn and exit stay consistent, gives `wsh agent-hook` a file log gated by an env flag, and makes `wsh install-agent-hooks` skip rewriting an already-healthy config. A final live task drives a real run worker and a cross-install reporter scenario using the new hook log as evidence.

**Tech Stack:** Go (backend: `pkg/blockcontroller`, `pkg/jarvis`, `cmd/wsh`), Rust (Tauri shell: `src-tauri`), the `wps` pub/sub broker, `waveobj`/`wstore` object store, CDP-driven live verification (`scripts/cdp-*.mjs`).

## Global Constraints

- **Never hand-edit generated files.** No wire-protocol / `waveobj` type change in this plan, so `task generate` is NOT run. If a step seems to need a generated-type change, stop — it is out of scope.
- **`pkg/baseds` must stay dependency-free.** It imports nothing (pure data structures). Do NOT add the shared event constructor there — it would have to import `pkg/wps`. The constructor goes in `pkg/blockcontroller` (which already imports `wps` and `waveobj`).
- **A lifecycle hook must stay silent to Claude.** `agent-hook` must never write to stdout/stderr and must always return `nil`; diagnostic output goes only to a file. Preserve the existing near-instant no-op when not in an Arc block.
- **Agent-session tab meta key is the literal `"session:agent"`** (no generated constant); its value is the runtime (`"claude"`, `"codex"`). Match the existing literals in `pkg/jarvis/runexec.go:60-63`.
- **Go build/test:** `go build ./...`, `go test ./pkg/...`, `go test ./cmd/...`. Backend binaries: `task build:backend`. Typecheck FE (not needed here) uses the `node --stack-size=4000` tsc workaround, not `npx tsc`.
- **Git rule (repo owner):** do NOT commit without explicit approval. The per-task `Commit` steps below are checkpoints — at execution, get the owner's approval per commit or batch and get approval at the end. Commit messages follow conventional commits (`type(scope): description`); do not add a co-author.

---

### Task 1: Shared `agent:status` event constructor

Extract the event shape currently inlined in `pkg/jarvis/runexec.go` into one exported constructor in `pkg/blockcontroller`, so the spawn (`working`) and the new exit (`idle`) events cannot drift. `pkg/jarvis` already imports `pkg/blockcontroller`, so re-pointing the existing helper is a safe, cycle-free refactor.

**Files:**
- Modify: `pkg/blockcontroller/blockcontroller.go` (add exported `AgentStatusEvent`; add `baseds` import)
- Modify: `pkg/jarvis/runexec.go:81-94` (`initialWorkerStatusEvent` delegates to the new constructor)
- Test: `pkg/blockcontroller/blockcontroller_test.go` (create if absent) and existing `pkg/jarvis/runexec_test.go` (must stay green)

**Interfaces:**
- Produces: `func AgentStatusEvent(blockId, state, agent string, ts int64) wps.WaveEvent` in package `blockcontroller`. Returns a retained (`Persist: 1`) `wps.WaveEvent` with `Event = wps.Event_AgentStatus`, `Scopes = ["block:<blockId>"]`, and `Data = baseds.AgentStatusData{ORef: "block:<blockId>", State: state, Agent: agent, Ts: ts}`.
- Consumes (Task 2 uses this): the same `AgentStatusEvent` for the idle-on-exit event.

- [ ] **Step 1: Write the failing test for the constructor**

Create `pkg/blockcontroller/blockcontroller_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

func TestAgentStatusEvent(t *testing.T) {
	ev := AgentStatusEvent("abc", baseds.AgentState_Idle, "codex", 1717000000000)
	if ev.Event != wps.Event_AgentStatus {
		t.Fatalf("event = %q, want %q", ev.Event, wps.Event_AgentStatus)
	}
	if ev.Persist != 1 {
		t.Errorf("persist = %d, want 1", ev.Persist)
	}
	if len(ev.Scopes) != 1 || ev.Scopes[0] != "block:abc" {
		t.Errorf("scopes = %v, want [block:abc]", ev.Scopes)
	}
	data, ok := ev.Data.(baseds.AgentStatusData)
	if !ok {
		t.Fatalf("data type = %T, want baseds.AgentStatusData", ev.Data)
	}
	if data.State != baseds.AgentState_Idle || data.ORef != "block:abc" || data.Agent != "codex" || data.Ts != 1717000000000 {
		t.Errorf("data = %#v, want idle/block:abc/codex/ts", data)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/blockcontroller/ -run TestAgentStatusEvent -v`
Expected: FAIL — `undefined: AgentStatusEvent`.

- [ ] **Step 3: Implement the constructor**

In `pkg/blockcontroller/blockcontroller.go`, add `"github.com/wavetermdev/waveterm/pkg/baseds"` to the import block (keep imports grouped/sorted as in the file), and add near the other package-level funcs:

```go
// AgentStatusEvent builds the retained agent:status event the roster keys off. Shared by the
// run-worker spawn emit (working) and the process-exit emit (idle) so their shape cannot drift.
// Persist:1 so a late-subscribing frontend replays the last state.
func AgentStatusEvent(blockId, state, agent string, ts int64) wps.WaveEvent {
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId).String()
	return wps.WaveEvent{
		Event:   wps.Event_AgentStatus,
		Scopes:  []string{oref},
		Persist: 1,
		Data: baseds.AgentStatusData{
			ORef:  oref,
			State: state,
			Agent: agent,
			Ts:    ts,
		},
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/blockcontroller/ -run TestAgentStatusEvent -v`
Expected: PASS.

- [ ] **Step 5: Re-point the jarvis helper to the shared constructor**

In `pkg/jarvis/runexec.go`, replace the body of `initialWorkerStatusEvent` (lines 81-94) with a delegation, and drop the now-unused `baseds`/`wps`/`waveobj` construction if they become unused (keep imports that other funcs in the file still need — `SpawnClaudeWorker` still calls `wps.Broker.Publish`, and `waveobj` is used throughout, so only remove `baseds` if nothing else references it):

```go
// initialWorkerStatusEvent is the retained agent:status the backend emits at spawn so a run worker
// enters the cockpit roster without waiting on the external reporter hook. Delegates to the shared
// constructor so spawn (working) and exit (idle) events share one shape.
func initialWorkerStatusEvent(blockId string, ts int64) wps.WaveEvent {
	return blockcontroller.AgentStatusEvent(blockId, baseds.AgentState_Working, "claude", ts)
}
```

Verify `baseds` is still imported in `runexec.go` (it is used above via `baseds.AgentState_Working`). Leave the `import` block otherwise unchanged.

- [ ] **Step 6: Run both packages' tests to verify no regression**

Run: `go test ./pkg/jarvis/ -run TestInitialWorkerStatusEvent -v && go test ./pkg/blockcontroller/ -run TestAgentStatusEvent -v && go build ./...`
Expected: both tests PASS (the existing jarvis test still asserts working/block:abc/claude/persist1), build succeeds.

- [ ] **Step 7: Commit**

```bash
git add pkg/blockcontroller/blockcontroller.go pkg/blockcontroller/blockcontroller_test.go pkg/jarvis/runexec.go
git commit -m "refactor(runs): extract shared agent:status event constructor"
```

---

### Task 2: Emit idle on agent-worker process exit

Publish a retained `agent:status = idle` when an agent-session block's process exits, scoped to tabs tagged `session:agent`. This closes the working@spawn → idle@exit loop so a finished/killed/crashed worker cannot linger as "working," independent of the reporter hook.

**Files:**
- Modify: `pkg/blockcontroller/shellcontroller.go` (add `idleOnExitEvent` + `emitAgentIdleOnExit`; call from the wait-loop at ~line 619)
- Test: `pkg/blockcontroller/blockcontroller_test.go` (add cases for the pure decision func)

**Interfaces:**
- Consumes: `AgentStatusEvent` (Task 1).
- Produces: `func idleOnExitEvent(blockId string, tabMeta waveobj.MetaMapType, ts int64) *wps.WaveEvent` — returns the idle event when `tabMeta["session:agent"]` is non-empty (using that value as the agent), else `nil` (not an agent session → no emit). And `func emitAgentIdleOnExit(blockId string)` — the DB-backed wrapper that resolves the tab, calls `idleOnExitEvent`, and publishes when non-nil.

- [ ] **Step 1: Write the failing test for the decision func**

Add to `pkg/blockcontroller/blockcontroller_test.go`:

```go
func TestIdleOnExitEvent(t *testing.T) {
	// agent session -> idle event carrying the runtime as agent
	meta := waveobj.MetaMapType{"session:agent": "claude"}
	ev := idleOnExitEvent("blk1", meta, 42)
	if ev == nil {
		t.Fatal("agent session should produce an idle event, got nil")
	}
	data := ev.Data.(baseds.AgentStatusData)
	if data.State != baseds.AgentState_Idle || data.ORef != "block:blk1" || data.Agent != "claude" {
		t.Errorf("data = %#v, want idle/block:blk1/claude", data)
	}

	// codex runtime preserved
	if ev := idleOnExitEvent("blk1", waveobj.MetaMapType{"session:agent": "codex"}, 42); ev == nil || ev.Data.(baseds.AgentStatusData).Agent != "codex" {
		t.Errorf("codex runtime not preserved: %#v", ev)
	}

	// plain terminal (no session:agent) -> no emit
	if ev := idleOnExitEvent("blk1", waveobj.MetaMapType{}, 42); ev != nil {
		t.Errorf("non-agent block should emit nothing, got %#v", ev)
	}
}
```

Add `"github.com/wavetermdev/waveterm/pkg/waveobj"` to the test file imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/blockcontroller/ -run TestIdleOnExitEvent -v`
Expected: FAIL — `undefined: idleOnExitEvent`.

- [ ] **Step 3: Implement the decision func and the DB-backed wrapper**

In `pkg/blockcontroller/shellcontroller.go`, add (near `checkCloseOnExit`, which already uses `wstore` + a timeout context — mirror its style):

```go
// idleOnExitEvent returns the retained idle status to publish when an agent-session block exits,
// or nil when the block is not an agent session (no session:agent tab meta). Pure: no I/O.
func idleOnExitEvent(blockId string, tabMeta waveobj.MetaMapType, ts int64) *wps.WaveEvent {
	agent := tabMeta.GetString("session:agent", "")
	if agent == "" {
		return nil // not an agent session — do not promote a plain terminal to an idle "agent"
	}
	ev := AgentStatusEvent(blockId, baseds.AgentState_Idle, agent, ts)
	return &ev
}

// emitAgentIdleOnExit publishes idle for a run/agent worker whose process just exited, so the
// cockpit roster stops showing it as "working" even if the reporter hook never fires. No-op for
// non-agent blocks. Fire-and-forget: called from the shell-proc wait loop.
func emitAgentIdleOnExit(blockId string) {
	ctx, cancelFn := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancelFn()
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return // tab already gone: the roster row is gone too, so no stale "working" can persist
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return
	}
	if ev := idleOnExitEvent(blockId, tab.Meta, time.Now().UnixMilli()); ev != nil {
		wps.Broker.Publish(*ev)
	}
}
```

Ensure `shellcontroller.go` imports `baseds` (`github.com/wavetermdev/waveterm/pkg/baseds`); it already imports `context`, `time`, `wps`, `waveobj`, and `wstore`. Add `baseds` to the import block if missing.

- [ ] **Step 4: Wire the emit into the shell-proc wait loop**

In `pkg/blockcontroller/shellcontroller.go`, in the wait goroutine, immediately after the existing `go checkCloseOnExit(bc.BlockId, exitCode)` (currently line 619) add:

```go
		go emitAgentIdleOnExit(bc.BlockId)
```

Placing it next to `checkCloseOnExit` reuses the established fire-and-forget-on-exit pattern and guarantees it runs on graceful exit, kill, and crash (the whole wait loop runs in all three cases).

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./pkg/blockcontroller/ -run TestIdleOnExitEvent -v && go build ./...`
Expected: PASS, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add pkg/blockcontroller/shellcontroller.go pkg/blockcontroller/blockcontroller_test.go
git commit -m "fix(runs): emit idle on agent-worker exit so finished workers clear from roster"
```

---

### Task 3: Opt-in `agent-hook` diagnostics

`agentHookRun` returns `nil` on every failure path with no trace (`cmd/wsh/cmd/wshcmd-agenthook.go:279-333`), so a status that never arrives is undiagnosable. Add file logging gated by `WAVETERM_HOOK_DEBUG`; when unset, behavior is byte-for-byte unchanged.

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-agenthook.go` (add `hookDebugLine`; instrument each branch)
- Test: `cmd/wsh/cmd/wshcmd-agenthook_test.go` (add `TestHookDebugLine`)

**Interfaces:**
- Produces: `func hookDebugLine(msg string)` — when `WAVETERM_HOOK_DEBUG` is non-empty, appends one line `"<RFC3339> <msg>\n"` to `<UserHomeDir>/.claude/arc-hook-debug.log`; otherwise does nothing. Never writes to stdout/stderr; never returns an error (best-effort).

**Design note (path choice):** The spec suggested "under the data dir," but the data dir is only knowable from the JWT socket path — and a broken/absent JWT is one of the failures being diagnosed. `~/.claude/` is always resolvable (`os.UserHomeDir`) and is where `settings.json` already lives, so the log is inheritance-independent of the wavesrv connection. This is the deliberate deviation from the spec wording; the goal ("log even when RPC fails") is preserved.

- [ ] **Step 1: Write the failing test**

Add to `cmd/wsh/cmd/wshcmd-agenthook_test.go`:

```go
func TestHookDebugLine(t *testing.T) {
	home := t.TempDir()
	// os.UserHomeDir reads HOME on unix, USERPROFILE on windows — set both so the test is OS-agnostic.
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	logPath := filepath.Join(home, ".claude", "arc-hook-debug.log")

	// flag unset -> no file written
	t.Setenv("WAVETERM_HOOK_DEBUG", "")
	hookDebugLine("should-not-appear")
	if _, err := os.Stat(logPath); !os.IsNotExist(err) {
		t.Fatalf("log file should not exist when flag unset, stat err = %v", err)
	}

	// flag set -> line appended
	t.Setenv("WAVETERM_HOOK_DEBUG", "1")
	hookDebugLine("branch=no-blockid")
	b, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("reading log: %v", err)
	}
	if !strings.Contains(string(b), "branch=no-blockid") {
		t.Fatalf("log missing message, got %q", string(b))
	}
}
```

(The test file already imports `os`, `path/filepath`, `strings`, `testing`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./cmd/wsh/cmd/ -run TestHookDebugLine -v`
Expected: FAIL — `undefined: hookDebugLine`.

- [ ] **Step 3: Implement `hookDebugLine`**

In `cmd/wsh/cmd/wshcmd-agenthook.go`, add (and ensure `time`, `os`, `path/filepath` are imported — `os`, `time`, `path/filepath` already are):

```go
// hookDebugLine appends one diagnostic line to ~/.claude/arc-hook-debug.log when WAVETERM_HOOK_DEBUG
// is set. Best-effort and silent: a lifecycle hook must never write to stdout/stderr or fail the turn.
// The path is home-relative (not data-dir) so logging works even when the JWT/socket is unavailable —
// which is exactly the failure being diagnosed.
func hookDebugLine(msg string) {
	if os.Getenv("WAVETERM_HOOK_DEBUG") == "" {
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(dir, "arc-hook-debug.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(time.Now().Format(time.RFC3339) + " " + msg + "\n")
}
```

- [ ] **Step 4: Instrument each branch of `agentHookRun`**

Edit `agentHookRun` (`cmd/wsh/cmd/wshcmd-agenthook.go:278-335`) to log the branch taken. Keep every `return nil` — only add `hookDebugLine` calls before them and one on success:

```go
func agentHookRun(cmd *cobra.Command, args []string) error {
	if os.Getenv("WAVETERM_BLOCKID") == "" {
		return nil // not inside an Arc block; near-instant no-op (not logged: not an error)
	}
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		hookDebugLine("skip: read stdin failed")
		return nil
	}
	var ev ccHookEvent
	if json.Unmarshal(raw, &ev) != nil {
		hookDebugLine("skip: unmarshal hook event failed")
		return nil
	}
	em := planEmission(ev)
	if em.State == "" && em.Subagent == nil {
		hookDebugLine("skip: no emission for event=" + ev.HookEventName)
		return nil
	}
	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" {
		hookDebugLine("skip: no jwt in env (WAVETERM_BLOCKID set) event=" + ev.HookEventName)
		return nil
	}
	if setupRpcClient(nil, jwt) != nil {
		hookDebugLine("skip: setupRpcClient failed event=" + ev.HookEventName)
		return nil
	}
	oref, err := resolveBlockArg()
	if err != nil {
		hookDebugLine("skip: resolveBlockArg failed event=" + ev.HookEventName)
		return nil
	}
	if em.State != "" {
		data := baseds.AgentStatusData{
			ORef:           oref.String(),
			State:          em.State,
			Detail:         em.Detail,
			Agent:          "claude",
			TranscriptPath: ev.TranscriptPath,
			Ts:             time.Now().UnixMilli(),
		}
		if em.AttachModelTitle && ev.TranscriptPath != "" {
			data.Model = readLastModel(ev.TranscriptPath)
			data.Title = readLastTitle(ev.TranscriptPath)
			if data.Title == "" {
				data.Title = titleFromPrompt(readLastUserPrompt(ev.TranscriptPath))
			}
		}
		_ = publishAgentStatusData(oref, data, 1)
	}
	if em.Subagent != nil {
		data := baseds.AgentStatusData{
			ORef:     oref.String(),
			Agent:    "claude",
			Ts:       time.Now().UnixMilli(),
			Subagent: em.Subagent,
		}
		_ = publishAgentStatusData(oref, data, 0)
	}
	hookDebugLine("published event=" + ev.HookEventName + " state=" + em.State + " oref=" + oref.String())
	return nil
}
```

- [ ] **Step 5: Run the test + build**

Run: `go test ./cmd/wsh/cmd/ -run 'TestHookDebugLine|TestPlanEmission' -v && go build ./...`
Expected: PASS (both), build succeeds.

- [ ] **Step 6: Commit**

```bash
git add cmd/wsh/cmd/wshcmd-agenthook.go cmd/wsh/cmd/wshcmd-agenthook_test.go
git commit -m "feat(agents): opt-in agent-hook diagnostic log for status routing"
```

---

### Task 4: Stop install-agent-hooks from churning a healthy config

`main.rs` re-runs `install-agent-hooks` every launch, and the command unconditionally rewrites the managed groups with the running install's `wsh` path — so two coexisting installs overwrite each other on every launch. Make the install a no-op when the existing config is already healthy (all managed hooks present with an existing exe, and the managed statusLine present with an existing exe), while still self-healing a stale/missing config.

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-installhooks.go` (add `configIsHealthy`; early-return in `installAgentHooksRun`)
- Test: `cmd/wsh/cmd/wshcmd-installhooks_test.go` (add `TestConfigIsHealthy`)

**Interfaces:**
- Consumes: existing `isManagedCommand`, `splitFirstToken`, `isManagedStatusLine`, `managedEventOrder`, `managedHooks`, `mergeAgentHooks`, `mergeStatusLine`.
- Produces: `func configIsHealthy(existing map[string]any, exeExists func(string) bool) bool` — true iff (a) the count of managed hook commands equals `len(managedHooks)` and every managed command's first-token exe passes `exeExists`, and (b) `statusLine.command` is a managed wrapper whose exe passes `exeExists`. The `exeExists` func is injected for testability.

- [ ] **Step 1: Write the failing test**

Add to `cmd/wsh/cmd/wshcmd-installhooks_test.go`:

```go
func TestConfigIsHealthy(t *testing.T) {
	full := mergeStatusLine(mergeAgentHooks(map[string]any{}, testWsh), testWsh)

	// all managed present + exe exists -> healthy
	if !configIsHealthy(full, func(string) bool { return true }) {
		t.Fatal("full config with present exe should be healthy")
	}
	// exe missing on disk -> not healthy (must heal to repoint)
	if configIsHealthy(full, func(string) bool { return false }) {
		t.Fatal("full config with missing exe should NOT be healthy")
	}
	// empty config -> not healthy
	if configIsHealthy(map[string]any{}, func(string) bool { return true }) {
		t.Fatal("empty config should NOT be healthy")
	}
	// hooks present but statusLine absent -> not healthy
	hooksOnly := mergeAgentHooks(map[string]any{}, testWsh)
	if configIsHealthy(hooksOnly, func(string) bool { return true }) {
		t.Fatal("config missing managed statusLine should NOT be healthy")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./cmd/wsh/cmd/ -run TestConfigIsHealthy -v`
Expected: FAIL — `undefined: configIsHealthy`.

- [ ] **Step 3: Implement `configIsHealthy`**

In `cmd/wsh/cmd/wshcmd-installhooks.go`, add:

```go
// configIsHealthy reports whether existing already carries Arc's full managed hook set and managed
// statusLine, all referencing a wsh binary that exists on disk (per exeExists). When true the install
// can skip its rewrite, so a coexisting install does not clobber a working config every launch.
// When any managed hook is missing or its exe is gone, it returns false and the caller heals (rewrites).
func configIsHealthy(existing map[string]any, exeExists func(string) bool) bool {
	hooks, _ := existing["hooks"].(map[string]any)
	if hooks == nil {
		return false
	}
	count := 0
	for _, event := range managedEventOrder() {
		groups, _ := hooks[event].([]any)
		for _, g := range groups {
			gm, ok := g.(map[string]any)
			if !ok {
				continue
			}
			hs, _ := gm["hooks"].([]any)
			for _, h := range hs {
				hm, ok := h.(map[string]any)
				if !ok {
					continue
				}
				c, _ := hm["command"].(string)
				if !isManagedCommand(c) {
					continue
				}
				exe, _ := splitFirstToken(c)
				if !exeExists(exe) {
					return false
				}
				count++
			}
		}
	}
	if count != len(managedHooks) {
		return false
	}
	sl, _ := existing["statusLine"].(map[string]any)
	if sl == nil {
		return false
	}
	slc, _ := sl["command"].(string)
	if !isManagedStatusLine(slc) {
		return false
	}
	exe, _ := splitFirstToken(slc)
	return exeExists(exe)
}
```

- [ ] **Step 4: Early-return in `installAgentHooksRun` when healthy**

In `installAgentHooksRun` (`cmd/wsh/cmd/wshcmd-installhooks.go:238-277`), after `existing` is parsed and before computing `exe`/`merged`, add:

```go
	if configIsHealthy(existing, func(p string) bool {
		_, err := os.Stat(p)
		return err == nil
	}) {
		fmt.Printf("Arc agent hooks already installed in %s (skipping)\n", path)
		return nil
	}
```

Everything below (resolve `exe`, `mergeAgentHooks`, `mergeStatusLine`, atomic write) is unchanged and still runs when the config is not healthy.

- [ ] **Step 5: Run the test suite for the package + build**

Run: `go test ./cmd/wsh/cmd/ -run 'TestConfigIsHealthy|TestIsManagedCommand|TestMergeAgentHooks' -v && go build ./...`
Expected: PASS (all), build succeeds.

- [ ] **Step 6: Commit**

```bash
git add cmd/wsh/cmd/wshcmd-installhooks.go cmd/wsh/cmd/wshcmd-installhooks_test.go
git commit -m "fix(agents): skip hook reinstall when config is already healthy"
```

---

### Task 5: Live verification + record findings

Drive the real dev app to prove the backend backstop (Task 2) and run the cross-install reporter experiment (spec Part 2b) using the new hook log (Task 3) as evidence. This is a verification task — no new production code unless 2b surfaces a confirmed break; if it does, add a task rather than patching ad hoc.

**Files:**
- Modify: `docs/agents/runs-pipeline-known-issues.md` (mark residual A resolved; record the 2b finding)

- [ ] **Step 1: Build backend with the changes**

Run: `task build:backend`
Expected: builds `wavesrv` + `wsh` into `dist/bin/` with no errors.

- [ ] **Step 2: Start the dev app**

Per CLAUDE.md, run `task dev` (background) and use the CDP shot/inject scripts. If launching from the Bash tool, use `tail -f /dev/null | task dev` (see memory: `taskdev-stdin-eof`) and ensure Vite's port 5174 is free first (memory: `taskdev-restart-vite-port`).

- [ ] **Step 3: Verify idle-on-exit with the reporter hook out of the picture**

Start a run worker (via the Runs composer, or a short-lived orchestrator/pipeline goal whose worker exits quickly). Watch the roster row over CDP (`scripts/cdp-shot.mjs` and/or `Runtime.evaluate` reading `liveAgentsAtom`). Confirm: the row appears as `working` at spawn and transitions to `idle` after the worker process exits — even if no `Stop` hook fired. To isolate the backend path, you may temporarily point `~/.claude/settings.json` hooks at a non-existent wsh (or unset them) so only the backend emit can move the state.
Expected: row goes `working` → `idle` on exit with no hook involvement.

- [ ] **Step 4: Cross-install reporter experiment (spec 2b)**

Enable the hook log: set `WAVETERM_HOOK_DEBUG=1` in the environment the app/agent launches under. Ensure a *second* install (e.g. packaged Arc vs. this dev build) was the last to run `install-agent-hooks`, so its `wsh` path is stamped in `~/.claude/settings.json`. Launch a *manual* (non-run) agent in the app under test and take one normal turn. Read `~/.claude/arc-hook-debug.log` and determine the exact outcome per event: did the hook run, find `WAVETERM_BLOCKID` + JWT, pass `setupRpcClient`, resolve the block, and publish?
Expected: one of —
  (a) log shows `published …` lines → routing works across installs; the earlier inconsistency was the missing idle, now fixed by Task 2. Record this.
  (b) log shows a specific `skip: …` branch → a real break is identified. Record the branch; add a follow-up task to fix that root cause (do not fix inline in this verification task).

- [ ] **Step 5: Record findings in the known-issues doc**

Update `docs/agents/runs-pipeline-known-issues.md`: move residual A ("retained working never cleared on exit") to resolved, citing the Task 2 backend emit; and add a short subsection recording the Step 4 outcome (a or b) with the log evidence. Keep the doc's existing style (dated, evidence-cited).

- [ ] **Step 6: Commit**

```bash
git add docs/agents/runs-pipeline-known-issues.md
git commit -m "docs(runs): record idle-on-exit fix and cross-install routing finding"
```

---

## Self-Review

**Spec coverage:**
- Part 1 (deterministic idle-on-exit, scoped to `session:agent`, reuse `idle`, shared helper) → Tasks 1 + 2.
- Part 2a (agent-hook observability) → Task 3.
- Part 2b (live cross-install reproduction + contingent fix) → Task 5 Step 4 (+ follow-up task if a break is found).
- Part 2c (install churn / exe-exists guard, incl. statusLine) → Task 4.
- Testing section (Go unit for helper/guard/install/hook-log; live CDP) → Tasks 1-4 unit steps + Task 5.
- Files-touched list → all covered; no `task generate`, no DB migration (honored: no `waveobj`/wire changes).

**Placeholder scan:** No TBD/TODO; every code step shows complete code; no "handle errors appropriately" hand-waves (error branches shown explicitly). Task 5 is verification and legitimately branches on an unknown outcome (a/b), with the contingent path deferred to a new task rather than a placeholder.

**Type consistency:** `AgentStatusEvent(blockId, state, agent string, ts int64) wps.WaveEvent` defined in Task 1, consumed in Task 2. `idleOnExitEvent(...) *wps.WaveEvent` and `emitAgentIdleOnExit(string)` consistent between Task 2 steps 1/3/4. `hookDebugLine(string)` consistent across Task 3. `configIsHealthy(map[string]any, func(string) bool) bool` consistent across Task 4. Tab-meta key literal `"session:agent"` used consistently. `baseds.AgentState_Idle` / `AgentState_Working` are the real constants (verified in `pkg/baseds/baseds.go`).
