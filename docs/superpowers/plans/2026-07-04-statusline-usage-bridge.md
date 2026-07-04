# StatusLine Usage Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-provision the Claude Code statusLine → Wave usage bridge from inside the app, with zero manual file editing, preserving the user's existing terminal statusline.

**Architecture:** Extend the existing `wsh install-agent-hooks` pass (fired on every launch by the Tauri shell) to also own `statusLine.command`, pointing it at a new `wsh statusline` wrapper. The wrapper carries the user's original command base64-encoded in its own argv, publishes the usage delta to Wave from the statusLine JSON, and delegates to the original command for display.

**Tech Stack:** Go (cobra CLI in `cmd/wsh`), the existing wshrpc publish path (`baseds.AgentUsage` → `agent:status` WaveEvent).

## Global Constraints

- Wrapper must **never error and never block the visible line**: `wsh statusline` always exits 0, same contract as `wsh agent-hook` (`cmd/wsh/cmd/wshcmd-agenthook.go:198`).
- Rate-limit fields are **subscriber-only**: emit `nil` when absent, never `0` (`AgentUsage.FiveHourPct`/`WeekPct`/resets are `*` pointers; nil = "unknown").
- Usage events are **ephemeral**: publish with `Persist:0` (`publishAgentStatusData(oref, data, 0)`).
- Installer edits stay **idempotent and preserve every other settings key**, mirroring `mergeAgentHooks` (deep-copy round-trip via `json.Marshal`/`Unmarshal`).
- Do **not** hand-edit generated files. Nothing here touches generated bindings.
- `AgentUsage` field names are exact: `ContextPct float64`, `ContextMax int`, `CostUSD float64`, `FiveHourPct *float64`, `FiveHourReset *int64`, `WeekPct *float64`, `WeekReset *int64` (`pkg/baseds/baseds.go:62`).

---

## File Structure

- `cmd/wsh/cmd/wshcmd-statusline.go` (create) — `parseStatusLineUsage` (pure JSON→`*AgentUsage`), the `statusline` cobra command, `runInner` (delegate to the user's command), `publishStatusLineUsage` (best-effort RPC publish).
- `cmd/wsh/cmd/wshcmd-statusline_test.go` (create) — tests for `parseStatusLineUsage` and `runInner`.
- `cmd/wsh/cmd/wshcmd-agentstatus.go` (modify) — extract `publishUsage(oref, *AgentUsage) error` from `publishUsageDelta` so both the flag path and the statusLine path share it.
- `cmd/wsh/cmd/wshcmd-installhooks.go` (modify) — add `isManagedStatusLine`, `encodeInner`/`decodeInner`, `recoverInner`, `mergeStatusLine`; call `mergeStatusLine` inside `installAgentHooksRun`.
- `cmd/wsh/cmd/wshcmd-installhooks_test.go` (modify) — add statusLine merge tests.
- `docs/agents/usage-reporting.md` (modify) — replace the manual-edit Setup section with the auto-wrap mechanism.

---

## Task 1: `parseStatusLineUsage` — statusLine JSON → `*AgentUsage`

Pure function, no RPC. Returns `nil` when `context_window.used_percentage` is absent (the gate: a session with no context data reports nothing).

**Files:**
- Create: `cmd/wsh/cmd/wshcmd-statusline.go`
- Test: `cmd/wsh/cmd/wshcmd-statusline_test.go`

**Interfaces:**
- Consumes: `baseds.AgentUsage` (`pkg/baseds/baseds.go:62`).
- Produces: `func parseStatusLineUsage(raw []byte) *baseds.AgentUsage`.

- [ ] **Step 1: Write the failing test**

Create `cmd/wsh/cmd/wshcmd-statusline_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import "testing"

func TestParseStatusLineUsageFull(t *testing.T) {
	raw := []byte(`{"context_window":{"used_percentage":42.5,"context_window_size":1000000},
		"rate_limits":{"five_hour":{"used_percentage":63,"resets_at":1750700000},
		"seven_day":{"used_percentage":18,"resets_at":1751200000}},
		"cost":{"total_cost_usd":1.23}}`)
	u := parseStatusLineUsage(raw)
	if u == nil {
		t.Fatal("expected usage, got nil")
	}
	if u.ContextPct != 42.5 || u.ContextMax != 1000000 || u.CostUSD != 1.23 {
		t.Fatalf("scalar fields wrong: %+v", u)
	}
	if u.FiveHourPct == nil || *u.FiveHourPct != 63 || u.FiveHourReset == nil || *u.FiveHourReset != 1750700000 {
		t.Fatalf("five_hour wrong: %+v", u)
	}
	if u.WeekPct == nil || *u.WeekPct != 18 || u.WeekReset == nil || *u.WeekReset != 1751200000 {
		t.Fatalf("seven_day wrong: %+v", u)
	}
}

func TestParseStatusLineUsageNoRateLimits(t *testing.T) {
	raw := []byte(`{"context_window":{"used_percentage":10,"context_window_size":200000}}`)
	u := parseStatusLineUsage(raw)
	if u == nil {
		t.Fatal("expected usage, got nil")
	}
	if u.FiveHourPct != nil || u.WeekPct != nil {
		t.Fatalf("rate limits should be nil for API-key session: %+v", u)
	}
}

func TestParseStatusLineUsageNoContextIsNil(t *testing.T) {
	if u := parseStatusLineUsage([]byte(`{"cost":{"total_cost_usd":1}}`)); u != nil {
		t.Fatalf("expected nil when no context pct, got %+v", u)
	}
	if u := parseStatusLineUsage([]byte(`not json`)); u != nil {
		t.Fatalf("expected nil on bad json, got %+v", u)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/wsh/cmd/ -run TestParseStatusLineUsage -v`
Expected: FAIL — `undefined: parseStatusLineUsage`.

- [ ] **Step 3: Write minimal implementation**

Create `cmd/wsh/cmd/wshcmd-statusline.go` with the parse function and its imports (the command and helpers land in Task 3; this compiles on its own):

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// slPayload is the subset of the Claude Code statusLine stdin JSON we consume.
type slPayload struct {
	ContextWindow struct {
		UsedPct     *float64 `json:"used_percentage"`
		WindowSize  int      `json:"context_window_size"`
	} `json:"context_window"`
	RateLimits struct {
		FiveHour *struct {
			UsedPct  float64 `json:"used_percentage"`
			ResetsAt int64   `json:"resets_at"`
		} `json:"five_hour"`
		SevenDay *struct {
			UsedPct  float64 `json:"used_percentage"`
			ResetsAt int64   `json:"resets_at"`
		} `json:"seven_day"`
	} `json:"rate_limits"`
	Cost struct {
		TotalCostUSD float64 `json:"total_cost_usd"`
	} `json:"cost"`
}

// parseStatusLineUsage extracts an AgentUsage from the statusLine JSON. Returns nil when
// context_window.used_percentage is absent — a session with no context data reports nothing
// rather than a misleading zero. Rate-limit fields stay nil when absent (subscriber-only).
func parseStatusLineUsage(raw []byte) *baseds.AgentUsage {
	var p slPayload
	if json.Unmarshal(raw, &p) != nil {
		return nil
	}
	if p.ContextWindow.UsedPct == nil {
		return nil
	}
	u := &baseds.AgentUsage{
		ContextPct: *p.ContextWindow.UsedPct,
		ContextMax: p.ContextWindow.WindowSize,
		CostUSD:    p.Cost.TotalCostUSD,
	}
	if p.RateLimits.FiveHour != nil {
		pct := p.RateLimits.FiveHour.UsedPct
		reset := p.RateLimits.FiveHour.ResetsAt
		u.FiveHourPct = &pct
		u.FiveHourReset = &reset
	}
	if p.RateLimits.SevenDay != nil {
		pct := p.RateLimits.SevenDay.UsedPct
		reset := p.RateLimits.SevenDay.ResetsAt
		u.WeekPct = &pct
		u.WeekReset = &reset
	}
	return u
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./cmd/wsh/cmd/ -run TestParseStatusLineUsage -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add cmd/wsh/cmd/wshcmd-statusline.go cmd/wsh/cmd/wshcmd-statusline_test.go
git commit -m "feat(wsh): parse statusLine JSON into AgentUsage"
```

---

## Task 2: Installer owns the statusLine slot

Add statusLine wrap/unwrap to the same idempotent `install-agent-hooks` pass. The user's original command is carried base64-encoded as `--inner=<b64>`, so re-wrapping recovers it instead of nesting.

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-installhooks.go`
- Test: `cmd/wsh/cmd/wshcmd-installhooks_test.go`

**Interfaces:**
- Consumes: `splitFirstToken`, `quotePath` (`cmd/wsh/cmd/wshcmd-installhooks.go:69,86`).
- Produces: `isManagedStatusLine(command string) bool`, `encodeInner(string) string`, `decodeInner(string) string`, `recoverInner(command string) string`, `mergeStatusLine(existing map[string]any, wshExe string) map[string]any`.

- [ ] **Step 1: Write the failing tests**

Append to `cmd/wsh/cmd/wshcmd-installhooks_test.go`:

```go
func TestIsManagedStatusLine(t *testing.T) {
	cases := map[string]bool{
		`"C:\a\bin\wsh-0.14.5-windows.x64.exe" statusline --inner=YmFzaCB4`: true,
		`"/usr/local/bin/wsh" statusline --inner=`:                          true,
		`wsh statusline`:                                                    true,
		`bash /c/Users/x/statusline-command.sh`:                            false,
		`"C:\a\bin\wsh.exe" agent-hook`:                                     false,
		``:                                                                  false,
	}
	for cmd, want := range cases {
		if got := isManagedStatusLine(cmd); got != want {
			t.Fatalf("isManagedStatusLine(%q) = %v, want %v", cmd, got, want)
		}
	}
}

func TestMergeStatusLineWrapsUnmanaged(t *testing.T) {
	existing := map[string]any{
		"statusLine": map[string]any{"type": "command", "command": `bash /c/Users/x/sl.sh`},
	}
	got := mergeStatusLine(existing, testWsh)
	sl := got["statusLine"].(map[string]any)
	cmd := sl["command"].(string)
	if !isManagedStatusLine(cmd) {
		t.Fatalf("command not managed after wrap: %q", cmd)
	}
	if inner := recoverInner(cmd); inner != `bash /c/Users/x/sl.sh` {
		t.Fatalf("inner not preserved: %q", inner)
	}
	if sl["type"] != "command" {
		t.Fatal("type not set to command")
	}
}

func TestMergeStatusLineEmpty(t *testing.T) {
	got := mergeStatusLine(map[string]any{}, testWsh)
	sl := got["statusLine"].(map[string]any)
	cmd := sl["command"].(string)
	if !isManagedStatusLine(cmd) {
		t.Fatalf("command not managed: %q", cmd)
	}
	if inner := recoverInner(cmd); inner != "" {
		t.Fatalf("expected empty inner, got %q", inner)
	}
}

func TestMergeStatusLineIdempotentNoNest(t *testing.T) {
	existing := map[string]any{
		"statusLine": map[string]any{"type": "command", "command": `bash /c/Users/x/sl.sh`},
	}
	once := mergeStatusLine(existing, testWsh)
	twice := mergeStatusLine(once, testWsh)
	inner := recoverInner(twice["statusLine"].(map[string]any)["command"].(string))
	if inner != `bash /c/Users/x/sl.sh` {
		t.Fatalf("re-wrap nested or lost inner: %q", inner)
	}
}

func TestMergeStatusLineRefreshesPath(t *testing.T) {
	existing := map[string]any{
		"statusLine": map[string]any{"type": "command", "command": `bash /x/sl.sh`},
	}
	old := mergeStatusLine(existing, `C:\old\bin\wsh-0.14.4-windows.x64.exe`)
	refreshed := mergeStatusLine(old, testWsh)
	cmd := refreshed["statusLine"].(map[string]any)["command"].(string)
	if strings_Contains(cmd, "0.14.4") {
		t.Fatalf("stale path still present: %q", cmd)
	}
	if inner := recoverInner(cmd); inner != `bash /x/sl.sh` {
		t.Fatalf("inner lost on refresh: %q", inner)
	}
}

func TestMergeStatusLinePreservesOtherKeys(t *testing.T) {
	existing := map[string]any{"theme": "dark", "statusLine": map[string]any{"command": `bash /x.sh`}}
	got := mergeStatusLine(existing, testWsh)
	if got["theme"] != "dark" {
		t.Fatal("theme not preserved")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./cmd/wsh/cmd/ -run TestMergeStatusLine -v; go test ./cmd/wsh/cmd/ -run TestIsManagedStatusLine -v`
Expected: FAIL — `undefined: isManagedStatusLine` / `mergeStatusLine` / `recoverInner`.

- [ ] **Step 3: Write the implementation**

Add to `cmd/wsh/cmd/wshcmd-installhooks.go` (add `"encoding/base64"` to the import block):

```go
// isManagedStatusLine reports whether a statusLine command is Arc's wrapper: first token's
// basename starts with "wsh" and the remainder begins with "statusline". Path/version-independent.
func isManagedStatusLine(command string) bool {
	exe, rest := splitFirstToken(command)
	if exe == "" {
		return false
	}
	if !strings.HasPrefix(strings.ToLower(filepath.Base(exe)), "wsh") {
		return false
	}
	return strings.HasPrefix(strings.TrimSpace(rest), "statusline")
}

func encodeInner(inner string) string {
	return base64.StdEncoding.EncodeToString([]byte(inner))
}

func decodeInner(b64 string) string {
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return ""
	}
	return string(data)
}

// recoverInner extracts the base64 --inner= value from a managed statusLine command, decoded
// back to the user's original command (empty string if none / unparseable).
func recoverInner(command string) string {
	_, rest := splitFirstToken(command)
	for _, f := range strings.Fields(strings.TrimSpace(rest)) {
		if strings.HasPrefix(f, "--inner=") {
			return decodeInner(strings.TrimPrefix(f, "--inner="))
		}
	}
	return ""
}

// mergeStatusLine returns a copy of existing with statusLine.command wrapped by Arc's
// "wsh statusline --inner=<b64>", carrying the user's original command so their terminal
// statusline display is unchanged. Idempotent: re-wrapping recovers the original instead of nesting.
func mergeStatusLine(existing map[string]any, wshExe string) map[string]any {
	out := map[string]any{}
	if b, err := json.Marshal(existing); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	sl, _ := out["statusLine"].(map[string]any)
	if sl == nil {
		sl = map[string]any{}
	}
	inner := ""
	if cur, _ := sl["command"].(string); cur != "" {
		if isManagedStatusLine(cur) {
			inner = recoverInner(cur)
		} else {
			inner = cur
		}
	}
	sl["type"] = "command"
	sl["command"] = quotePath(wshExe) + " statusline --inner=" + encodeInner(inner)
	out["statusLine"] = sl
	return out
}
```

Then wire it into `installAgentHooksRun` — change the merge line (currently `merged := mergeAgentHooks(existing, exe)`):

```go
	merged := mergeAgentHooks(existing, exe)
	merged = mergeStatusLine(merged, exe)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./cmd/wsh/cmd/ -run 'TestMergeStatusLine|TestIsManagedStatusLine|TestMergeAgentHooks|TestIsManagedCommand' -v`
Expected: PASS (all statusLine + existing hook tests green — the existing hook tests confirm the new merge didn't disturb them).

- [ ] **Step 5: Commit**

```bash
git add cmd/wsh/cmd/wshcmd-installhooks.go cmd/wsh/cmd/wshcmd-installhooks_test.go
git commit -m "feat(wsh): auto-wrap statusLine command in install-agent-hooks"
```

---

## Task 3: `wsh statusline` command — publish + delegate

The runtime wrapper. Reads stdin once; concurrently publishes usage and runs the inner command; writes the inner's stdout through; always exits 0.

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-statusline.go` (add command + helpers)
- Modify: `cmd/wsh/cmd/wshcmd-agentstatus.go` (extract `publishUsage`)
- Test: `cmd/wsh/cmd/wshcmd-statusline_test.go` (add `runInner` test)

**Interfaces:**
- Consumes: `parseStatusLineUsage` (Task 1); `setupRpcClient(wshutil.ServerImpl, string) error` (`wshcmd-root.go:153`); `resolveBlockArg() (*waveobj.ORef, error)` (`wshcmd-root.go:115`); `publishAgentStatusData(*waveobj.ORef, baseds.AgentStatusData, int) error` (`wshcmd-agentstatus.go:89`); `wshutil.WaveJwtTokenVarName`.
- Produces: `func publishUsage(oref *waveobj.ORef, usage *baseds.AgentUsage) error`; the registered `statusline` cobra command; `func runInner(inner string, stdin []byte) []byte`.

- [ ] **Step 1: Extract `publishUsage` from `publishUsageDelta`**

In `cmd/wsh/cmd/wshcmd-agentstatus.go`, add this helper:

```go
func publishUsage(oref *waveobj.ORef, usage *baseds.AgentUsage) error {
	eventData := baseds.AgentStatusData{
		ORef:  oref.String(),
		Ts:    time.Now().UnixMilli(),
		Usage: usage,
	}
	// Persist:0 — usage deltas are ephemeral; a retained usage event would evict the
	// retained Persist:1 parent-state event that a late subscriber must replay.
	return publishAgentStatusData(oref, eventData, 0)
}
```

Then replace the tail of `publishUsageDelta` (from the `eventData := ...` block through the `publishAgentStatusData(...)` call at `wshcmd-agentstatus.go:159-171`) with:

```go
	if err := publishUsage(oref, usage); err != nil {
		return fmt.Errorf("publishing agentstatus usage event: %v", err)
	}
	fmt.Printf("agentstatus usage set\n")
	return nil
```

- [ ] **Step 2: Run existing usage tests / build to confirm no regression**

Run: `go build ./cmd/wsh/... && go vet ./cmd/wsh/cmd/`
Expected: builds clean (the flag path still publishes via the shared helper).

- [ ] **Step 3: Write the failing `runInner` test**

First widen the test file's import from `import "testing"` to a block:

```go
import (
	"strings"
	"testing"
)
```

Then append to `cmd/wsh/cmd/wshcmd-statusline_test.go`:

```go
func TestRunInnerPassesThrough(t *testing.T) {
	out := string(runInner("echo hello-arc", nil))
	if !strings.Contains(out, "hello-arc") {
		t.Fatalf("inner stdout not passed through: %q", out)
	}
}

func TestRunInnerEmptyIsNoop(t *testing.T) {
	if out := runInner("", []byte("x")); len(out) != 0 {
		t.Fatalf("empty inner should produce no output, got %q", out)
	}
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `go test ./cmd/wsh/cmd/ -run TestRunInner -v`
Expected: FAIL — `undefined: runInner`.

- [ ] **Step 5: Implement the command + helpers**

Add to `cmd/wsh/cmd/wshcmd-statusline.go`. Extend the import block to:

```go
import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)
```

Then add:

```go
var statusLineInner string

var statusLineCmd = &cobra.Command{
	Use:                   "statusline",
	Short:                 "Claude Code statusLine wrapper: publish usage to the Arc cockpit, then delegate",
	Args:                  cobra.NoArgs,
	RunE:                  statusLineRun,
	Hidden:                true,
	DisableFlagsInUseLine: true,
	SilenceErrors:         true,
	SilenceUsage:          true,
}

func init() {
	rootCmd.AddCommand(statusLineCmd)
	statusLineCmd.Flags().StringVar(&statusLineInner, "inner", "", "base64 of the user's original statusLine command to delegate to")
}

// runInner runs the user's original statusLine command via the platform shell, feeding it the
// same stdin JSON, and returns its stdout. Empty inner => no output. Best-effort: errors yield
// whatever stdout was produced (possibly none).
func runInner(inner string, stdin []byte) []byte {
	if inner == "" {
		return nil
	}
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.Command("cmd", "/c", inner)
	} else {
		c = exec.Command("sh", "-c", inner)
	}
	c.Stdin = bytes.NewReader(stdin)
	out, _ := c.Output()
	return out
}

// publishStatusLineUsage best-effort publishes the usage delta parsed from the statusLine JSON.
// Silent on every failure (no block env, no JWT, RPC down, no context data) — a dropped publish
// self-heals on the next statusLine render.
func publishStatusLineUsage(raw []byte) {
	if os.Getenv("WAVETERM_BLOCKID") == "" {
		return
	}
	usage := parseStatusLineUsage(raw)
	if usage == nil {
		return
	}
	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" {
		return
	}
	if setupRpcClient(nil, jwt) != nil {
		return
	}
	oref, err := resolveBlockArg()
	if err != nil {
		return
	}
	_ = publishUsage(oref, usage)
}

// statusLineRun always returns nil: a statusLine command must never break Claude Code's render.
func statusLineRun(cmd *cobra.Command, args []string) error {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return nil
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		publishStatusLineUsage(raw)
	}()

	inner := decodeInner(statusLineInner)
	if out := runInner(inner, raw); len(out) > 0 {
		_, _ = os.Stdout.Write(out)
	}

	// let the publish finish (it overlaps the inner run, so this is usually already closed),
	// but never hang the render if the backend is unreachable.
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
	}
	return nil
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `go test ./cmd/wsh/cmd/ -run 'TestRunInner|TestParseStatusLineUsage' -v && go build ./cmd/wsh/...`
Expected: PASS (all) and a clean build.

- [ ] **Step 7: Manual end-to-end verification**

Build wsh and confirm the wrapper both publishes and passes through. From a Wave terminal block (so `WAVETERM_BLOCKID`/`WAVETERM_JWT` are set):

```bash
task build:backend
INNER=$(printf '%s' 'echo "[my custom line]"' | base64)
echo '{"context_window":{"used_percentage":42.5,"context_window_size":1000000},"cost":{"total_cost_usd":1.23}}' \
  | dist/bin/wsh statusline --inner="$INNER"
```
Expected: prints `[my custom line]` (delegation works); the cockpit Usage surface / focus-view context bar populates within a few seconds (publish works). A non-Wave shell prints only the inner line and publishes nothing.

- [ ] **Step 8: Commit**

```bash
git add cmd/wsh/cmd/wshcmd-statusline.go cmd/wsh/cmd/wshcmd-statusline_test.go cmd/wsh/cmd/wshcmd-agentstatus.go
git commit -m "feat(wsh): statusline wrapper publishes usage and delegates to user command"
```

---

## Task 4: Update usage-reporting doc

Replace the manual-edit Setup section with the auto-wrap mechanism; keep data-flow and field-mapping.

**Files:**
- Modify: `docs/agents/usage-reporting.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Rewrite the "Setup" section**

Replace the entire `## Setup` section (the bash snippet + field-parsing blocks, currently `usage-reporting.md:75-111`) with:

```markdown
## Setup (automatic)

Provisioning is automatic — there is nothing to hand-edit. On every launch the Arc
app runs `wsh install-agent-hooks`, which (besides the lifecycle hooks) wraps your
`statusLine.command` in `~/.claude/settings.json`:

    statusLine.command  →  "<wsh>" statusline --inner=<base64 of your original command>

`wsh statusline` reads the statusLine JSON on stdin, publishes the usage delta to
Wave, and then runs your original command with the same stdin — so your terminal
statusline display is unchanged. The wrap is idempotent: re-running decodes
`--inner=` to recover your true original instead of nesting, and refreshes the `wsh`
path so app updates self-heal. If you change your statusLine later, the next launch
re-wraps the new value.

To (re)provision manually from any Arc terminal: `wsh install-agent-hooks`.
```

- [ ] **Step 2: Fix the "Why usage rides the statusLine" note**

In the `## Why usage rides the statusLine, not the hook reporter` section, update the sentence that says the numbers were only printed to the terminal — append: "This is now bridged automatically by the Arc-managed `wsh statusline` wrapper (see Setup)."

- [ ] **Step 3: Commit**

```bash
git add docs/agents/usage-reporting.md
git commit -m "docs(agents): usage bridge is now auto-provisioned via wsh statusline"
```

---

## Self-Review

**1. Spec coverage:**
- App auto-provisions on launch, no manual edit → Task 2 (`mergeStatusLine` wired into `installAgentHooksRun`, fired by existing Tauri caller). ✓
- Preserve user's existing statusline display → Task 3 (`runInner` delegates, stdout passthrough) + Task 2 (`--inner=` carries original). ✓
- Full data (context/cost/plan gauges), subscriber-only nil gating → Task 1 (`parseStatusLineUsage`). ✓
- Route through `wsh`, no jq/bash dependency → Task 1/3 (Go JSON parse). ✓
- Base64 original in argv, no side files, no nesting → Task 2 (`encodeInner`/`recoverInner`, idempotent test). ✓
- Never error / never block the line → Task 3 (`statusLineRun` returns nil, 500ms publish cap, concurrent inner). ✓
- Flag-based `wsh agentstatus --usage` retained → Task 3 Step 1 keeps `publishUsageDelta`, only extracts shared `publishUsage`. ✓
- Installer idempotent, preserves other keys → Task 2 tests (`TestMergeStatusLinePreservesOtherKeys`, `TestMergeStatusLineIdempotentNoNest`, existing hook tests still pass). ✓
- Docs updated → Task 4. ✓
- Tests: installer merge + JSON→AgentUsage extraction → Tasks 1 & 2. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output. ✓

**3. Type consistency:** `parseStatusLineUsage([]byte) *baseds.AgentUsage` (Task 1) consumed by `publishStatusLineUsage` (Task 3). `publishUsage(*waveobj.ORef, *baseds.AgentUsage) error` (Task 3 Step 1) consumed by both `publishUsageDelta` and `publishStatusLineUsage`. `decodeInner`/`encodeInner`/`recoverInner`/`isManagedStatusLine`/`mergeStatusLine` (Task 2) — `decodeInner` reused by Task 3's `statusLineRun`. `runInner(string, []byte) []byte` consistent between test (Task 3 Step 3) and impl (Step 5). `AgentUsage` field names match `pkg/baseds/baseds.go:62` exactly. ✓
```
