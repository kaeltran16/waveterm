# Arc Agent Hooks — Reconstruction + Auto-Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold Arc's Claude Code hooks (agent-status reporter + AskUserQuestion projection) into `wsh` subcommands and auto-install them into `~/.claude/settings.json` on every app launch, so the cockpit works end-to-end after a normal install with zero manual setup.

**Architecture:** The status reporter is reconstructed as a new `wsh agent-hook` subcommand that reads a Claude Code lifecycle-hook JSON event on stdin, maps it to agent state / subagent deltas, tail-reads the transcript for model + ai-title, and publishes the existing `agent:status` event in-process. The existing `wsh ask` command is taught to unwrap the CC hook envelope so it can be wired directly. A new `wsh install-agent-hooks` command idempotently merges Arc's hook block into the user's `~/.claude/settings.json`, and the Tauri `setup()` fires it (detached) on launch.

**Tech Stack:** Go (cobra `wsh` subcommands, `pkg/baseds`, `pkg/wps`, `pkg/wshrpc`), Rust (Tauri `setup()` spawn), Claude Code hook JSON contract.

## Global Constraints

- **Copied verbatim from spec — apply to every task:**
- Every hook path must be **fail-safe**: any parse/RPC/IO error → exit 0, never break the agent's turn.
- `wsh agent-hook` must **no-op instantly** when `WAVETERM_BLOCKID` is unset (first check), because the global hook fires for every Claude Code session on the machine, not just Arc's.
- Auto-install must be **idempotent and non-destructive**: preserve every existing key/hook in `settings.json`; only add/refresh Arc's own managed entries.
- Managed hook entries are identified by: first command token basename has prefix `wsh` (case-insensitive) **and** the remaining args are exactly one of `agent-hook`, `ask`, `ask --clear`. This must match **version-named** binaries (e.g. `wsh-0.14.5-windows.x64.exe`) so updates self-heal.
- Commands written into `settings.json` use the **absolute** path of the running `wsh` (`os.Executable()`), quoted.
- Reconstructed logic lives in `cmd/wsh/cmd/` as Go with unit tests. Never hand-edit generated files.
- **Git policy (overrides the TDD per-step-commit default):** do NOT commit per step. Each task ends with a checkpoint (stage + summarize). A single commit at the very end requires explicit user approval per repo policy.
- Agent identity string is `claude`.
- Windows-only packaging; keep code POSIX-safe but verify on Windows.

## File Structure

- `cmd/wsh/cmd/wshcmd-agentstatus.go` (modify) — extract a pure event builder + a publish helper reused by `agent-hook`.
- `cmd/wsh/cmd/wshcmd-agentstatus_test.go` (create) — test the pure event builder.
- `cmd/wsh/cmd/wshcmd-agenthook.go` (create) — the reconstructed reporter: CC-event parsing, pure mapping (`planEmission`, `detailForTool`), transcript tail-readers, and the cobra command.
- `cmd/wsh/cmd/wshcmd-agenthook_test.go` (create) — tests for the pure helpers + command registration.
- `cmd/wsh/cmd/wshcmd-ask.go` (modify) — extract `parseAskQuestions` that unwraps the CC hook envelope.
- `cmd/wsh/cmd/wshcmd-ask_test.go` (create) — test both stdin shapes.
- `cmd/wsh/cmd/wshcmd-installhooks.go` (create) — pure `mergeAgentHooks` + `isManagedCommand` + the `install-agent-hooks` cobra command (file IO).
- `cmd/wsh/cmd/wshcmd-installhooks_test.go` (create) — test the pure merge + matcher.
- `src-tauri/src/main.rs` (modify) — resolve the bundled `wsh` binary + fire `install-agent-hooks` detached in `setup()`.
- `docs/agents/{organic-ask-setup,usage-reporting,tab-auto-naming}.md` (modify) — document the `wsh` subcommands + auto-install; mark the old `docs/agents/*.js` hooks superseded.

---

### Task 1: Extract reusable agentstatus publish helper

Refactor the three inline `wps.WaveEvent` publishes in `agentStatusRun` / `publishUsageDelta` / `publishSubagentDelta` behind a pure event builder + a thin publisher, so `agent-hook` (Task 3) can publish without spawning a second `wsh`.

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-agentstatus.go`
- Test: `cmd/wsh/cmd/wshcmd-agentstatus_test.go`

**Interfaces:**
- Produces:
  - `func buildAgentStatusEvent(oref *waveobj.ORef, data baseds.AgentStatusData, persist int) wps.WaveEvent`
  - `func publishAgentStatusData(oref *waveobj.ORef, data baseds.AgentStatusData, persist int) error`

- [ ] **Step 1: Write the failing test**

Create `cmd/wsh/cmd/wshcmd-agentstatus_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

func TestBuildAgentStatusEvent(t *testing.T) {
	oref := &waveobj.ORef{OType: waveobj.OType_Block, OID: "abc"}
	data := baseds.AgentStatusData{ORef: oref.String(), State: baseds.AgentState_Working}

	ev := buildAgentStatusEvent(oref, data, 1)

	if ev.Event != wps.Event_AgentStatus {
		t.Fatalf("event type = %q, want %q", ev.Event, wps.Event_AgentStatus)
	}
	if ev.Persist != 1 {
		t.Fatalf("persist = %d, want 1", ev.Persist)
	}
	if len(ev.Scopes) != 1 || ev.Scopes[0] != "block:abc" {
		t.Fatalf("scopes = %v, want [block:abc]", ev.Scopes)
	}
	if got, ok := ev.Data.(baseds.AgentStatusData); !ok || got.State != baseds.AgentState_Working {
		t.Fatalf("data = %#v, want AgentStatusData{State:working}", ev.Data)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/wsh/cmd/ -run TestBuildAgentStatusEvent -v`
Expected: FAIL — `undefined: buildAgentStatusEvent`.

- [ ] **Step 3: Add the helpers and route the existing publishes through them**

In `cmd/wsh/cmd/wshcmd-agentstatus.go`, add near the top of the func section:

```go
func buildAgentStatusEvent(oref *waveobj.ORef, data baseds.AgentStatusData, persist int) wps.WaveEvent {
	return wps.WaveEvent{
		Event:   wps.Event_AgentStatus,
		Scopes:  []string{oref.String()},
		Persist: persist,
		Data:    data,
	}
}

func publishAgentStatusData(oref *waveobj.ORef, data baseds.AgentStatusData, persist int) error {
	event := buildAgentStatusEvent(oref, data, persist)
	return wshclient.EventPublishCommand(RpcClient, event, &wshrpc.RpcOpts{NoResponse: true})
}
```

Then replace the three inline publish blocks. In `agentStatusRun` replace the `event := wps.WaveEvent{...}` + `EventPublishCommand` block with:

```go
	err = publishAgentStatusData(oref, eventData, 1)
	if err != nil {
		return fmt.Errorf("publishing agentstatus event: %v", err)
	}
```

In `publishUsageDelta` replace its `event := ...` + publish with:

```go
	err := publishAgentStatusData(oref, eventData, 0)
	if err != nil {
		return fmt.Errorf("publishing agentstatus usage event: %v", err)
	}
```

In `publishSubagentDelta` replace its `event := ...` + publish with:

```go
	err := publishAgentStatusData(oref, eventData, 0)
	if err != nil {
		return fmt.Errorf("publishing agentstatus subagent event: %v", err)
	}
```

- [ ] **Step 4: Run tests and build to verify green**

Run: `go test ./cmd/wsh/cmd/ -run TestBuildAgentStatusEvent -v`
Expected: PASS.
Run: `go build ./cmd/wsh/...`
Expected: builds clean (the three call sites still compile).

- [ ] **Step 5: Checkpoint**

Stage and summarize (no commit):

```bash
git add cmd/wsh/cmd/wshcmd-agentstatus.go cmd/wsh/cmd/wshcmd-agentstatus_test.go
git status --short
```

State: "Task 1 done — extracted `buildAgentStatusEvent`/`publishAgentStatusData`; verified by TestBuildAgentStatusEvent + build."

---

### Task 2: agent-hook pure logic (mapping, detail, transcript readers)

All the reporter's decision logic as pure, fully-tested functions — no cobra, no RPC, no stdin.

**Files:**
- Create: `cmd/wsh/cmd/wshcmd-agenthook.go`
- Test: `cmd/wsh/cmd/wshcmd-agenthook_test.go`

**Interfaces:**
- Consumes: `baseds.AgentState_*`, `baseds.SubagentAction_*`, `baseds.AgentSubagentDelta` (from `pkg/baseds`).
- Produces:
  - `type ccHookEvent struct { HookEventName, ToolName, ToolUseID, TranscriptPath string; ToolInput json.RawMessage }`
  - `type agentEmission struct { State, Detail string; AttachModelTitle bool; Subagent *baseds.AgentSubagentDelta }`
  - `func planEmission(ev ccHookEvent) agentEmission`
  - `func detailForTool(name string, input json.RawMessage) string`
  - `func readLastModel(path string) string`
  - `func readLastTitle(path string) string`

- [ ] **Step 1: Write the failing tests**

Create `cmd/wsh/cmd/wshcmd-agenthook_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func TestPlanEmission(t *testing.T) {
	tests := []struct {
		name      string
		ev        ccHookEvent
		wantState string
		wantSub   string // subagent action, "" if none
		wantMT    bool   // AttachModelTitle
	}{
		{"prompt submit", ccHookEvent{HookEventName: "UserPromptSubmit"}, baseds.AgentState_Working, "", true},
		{"stop idle", ccHookEvent{HookEventName: "Stop"}, baseds.AgentState_Idle, "", true},
		{"notification waiting", ccHookEvent{HookEventName: "Notification"}, baseds.AgentState_Waiting, "", false},
		{"post tool working", ccHookEvent{HookEventName: "PostToolUse"}, baseds.AgentState_Working, "", true},
		{"pre bash working", ccHookEvent{HookEventName: "PreToolUse", ToolName: "Bash", ToolInput: json.RawMessage(`{"command":"ls"}`)}, baseds.AgentState_Working, "", true},
		{"pre ask waiting", ccHookEvent{HookEventName: "PreToolUse", ToolName: "AskUserQuestion"}, baseds.AgentState_Waiting, "", false},
		{"pre task starts subagent", ccHookEvent{HookEventName: "PreToolUse", ToolName: "Task", ToolUseID: "t1", ToolInput: json.RawMessage(`{"subagent_type":"Explore"}`)}, baseds.AgentState_Working, baseds.SubagentAction_Start, true},
		{"pre task no id -> no subagent", ccHookEvent{HookEventName: "PreToolUse", ToolName: "Task", ToolInput: json.RawMessage(`{"subagent_type":"Explore"}`)}, baseds.AgentState_Working, "", true},
		{"subagent stop", ccHookEvent{HookEventName: "SubagentStop", ToolUseID: "t1"}, "", baseds.SubagentAction_Stop, false},
		{"subagent stop no id -> nothing", ccHookEvent{HookEventName: "SubagentStop"}, "", "", false},
		{"unknown event -> nothing", ccHookEvent{HookEventName: "PreCompact"}, "", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			em := planEmission(tt.ev)
			if em.State != tt.wantState {
				t.Fatalf("state = %q, want %q", em.State, tt.wantState)
			}
			gotSub := ""
			if em.Subagent != nil {
				gotSub = em.Subagent.Action
			}
			if gotSub != tt.wantSub {
				t.Fatalf("subagent action = %q, want %q", gotSub, tt.wantSub)
			}
			if em.AttachModelTitle != tt.wantMT {
				t.Fatalf("attachModelTitle = %v, want %v", em.AttachModelTitle, tt.wantMT)
			}
		})
	}
}

func TestPlanEmissionTaskType(t *testing.T) {
	em := planEmission(ccHookEvent{HookEventName: "PreToolUse", ToolName: "Task", ToolUseID: "t1", ToolInput: json.RawMessage(`{"subagent_type":"Plan"}`)})
	if em.Subagent == nil || em.Subagent.Type != "Plan" || em.Subagent.Id != "t1" {
		t.Fatalf("subagent = %#v, want {Start t1 Plan}", em.Subagent)
	}
}

func TestDetailForTool(t *testing.T) {
	tests := []struct {
		name, tool, input, want string
	}{
		{"edit", "Edit", `{"file_path":"/a/b/foo.go"}`, "editing foo.go"},
		{"write", "Write", `{"file_path":"C:\\x\\y\\bar.ts"}`, "editing bar.ts"},
		{"read", "Read", `{"file_path":"/a/baz.md"}`, "reading baz.md"},
		{"bash", "Bash", `{"command":"go test ./..."}`, "running go test ./..."},
		{"edit missing path -> tool name", "Edit", `{}`, "Edit"},
		{"other tool -> name", "Grep", `{"pattern":"x"}`, "Grep"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := detailForTool(tt.tool, json.RawMessage(tt.input)); got != tt.want {
				t.Fatalf("detailForTool(%q) = %q, want %q", tt.tool, got, tt.want)
			}
		})
	}
}

func TestDetailForToolBashTruncated(t *testing.T) {
	long := ""
	for i := 0; i < 100; i++ {
		long += "x"
	}
	got := detailForTool("Bash", json.RawMessage(`{"command":"`+long+`"}`))
	if len(got) > len("running ")+60 {
		t.Fatalf("bash detail not truncated: len=%d", len(got))
	}
}

func TestReadLastModelAndTitle(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "transcript.jsonl")
	content := `{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":[]}}
{"type":"ai-title","aiTitle":"First title"}
{"type":"user","message":{"content":"hi"}}
{"type":"assistant","message":{"model":"claude-opus-4-8","content":[]}}
{"type":"ai-title","aiTitle":"Final \"quoted\" title"}
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readLastModel(path); got != "claude-opus-4-8" {
		t.Fatalf("model = %q, want claude-opus-4-8", got)
	}
	if got := readLastTitle(path); got != `Final "quoted" title` {
		t.Fatalf("title = %q, want Final \"quoted\" title", got)
	}
}

func TestReadLastTitleMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.jsonl")
	os.WriteFile(path, []byte(`{"type":"assistant","message":{"model":"m"}}`+"\n"), 0o644)
	if got := readLastTitle(path); got != "" {
		t.Fatalf("title = %q, want empty", got)
	}
	if got := readLastModel("/no/such/file"); got != "" {
		t.Fatalf("model on missing file = %q, want empty", got)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./cmd/wsh/cmd/ -run 'TestPlanEmission|TestDetailForTool|TestReadLast' -v`
Expected: FAIL — `undefined: planEmission` (etc).

- [ ] **Step 3: Write the pure implementation**

Create `cmd/wsh/cmd/wshcmd-agenthook.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

const transcriptTailBytes = 64 * 1024
const bashDetailMax = 60

// ccHookEvent is the subset of the Claude Code lifecycle-hook stdin payload we use.
type ccHookEvent struct {
	HookEventName  string          `json:"hook_event_name"`
	ToolName       string          `json:"tool_name"`
	ToolUseID      string          `json:"tool_use_id"`
	TranscriptPath string          `json:"transcript_path"`
	ToolInput      json.RawMessage `json:"tool_input"`
}

// agentEmission describes what to publish for one hook event. State=="" means no
// parent-state event; Subagent==nil means no subagent delta. Both may be set (a Task
// PreToolUse both keeps the parent "working" and starts a subagent).
type agentEmission struct {
	State            string
	Detail           string
	AttachModelTitle bool
	Subagent         *baseds.AgentSubagentDelta
}

func planEmission(ev ccHookEvent) agentEmission {
	switch ev.HookEventName {
	case "UserPromptSubmit":
		return agentEmission{State: baseds.AgentState_Working, AttachModelTitle: true}
	case "Stop":
		return agentEmission{State: baseds.AgentState_Idle, AttachModelTitle: true}
	case "Notification":
		return agentEmission{State: baseds.AgentState_Waiting}
	case "PostToolUse":
		return agentEmission{State: baseds.AgentState_Working, AttachModelTitle: true}
	case "SubagentStop":
		if ev.ToolUseID != "" {
			return agentEmission{Subagent: &baseds.AgentSubagentDelta{Action: baseds.SubagentAction_Stop, Id: ev.ToolUseID}}
		}
		return agentEmission{}
	case "PreToolUse":
		switch ev.ToolName {
		case "Task":
			em := agentEmission{State: baseds.AgentState_Working, AttachModelTitle: true}
			if ev.ToolUseID != "" {
				em.Subagent = &baseds.AgentSubagentDelta{
					Action: baseds.SubagentAction_Start,
					Id:     ev.ToolUseID,
					Type:   stringField(ev.ToolInput, "subagent_type"),
				}
			}
			return em
		case "AskUserQuestion":
			return agentEmission{State: baseds.AgentState_Waiting}
		default:
			return agentEmission{State: baseds.AgentState_Working, Detail: detailForTool(ev.ToolName, ev.ToolInput), AttachModelTitle: true}
		}
	}
	return agentEmission{}
}

func detailForTool(name string, input json.RawMessage) string {
	switch name {
	case "Edit", "Write", "MultiEdit":
		if fp := stringField(input, "file_path"); fp != "" {
			return "editing " + filepath.Base(fp)
		}
	case "Read":
		if fp := stringField(input, "file_path"); fp != "" {
			return "reading " + filepath.Base(fp)
		}
	case "Bash":
		if cmd := stringField(input, "command"); cmd != "" {
			return "running " + truncate(cmd, bashDetailMax)
		}
	}
	return name
}

func stringField(raw json.RawMessage, field string) string {
	if len(raw) == 0 {
		return ""
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return ""
	}
	if s, ok := m[field].(string); ok {
		return s
	}
	return ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// tailLines returns the lines in the last transcriptTailBytes of path, dropping the
// partial leading line that a mid-file read produces. Any error yields nil.
func tailLines(path string) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil
	}
	start := int64(0)
	if st.Size() > transcriptTailBytes {
		start = st.Size() - transcriptTailBytes
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil
	}
	lines := strings.Split(string(data), "\n")
	if start > 0 && len(lines) > 0 {
		lines = lines[1:]
	}
	return lines
}

func readLastModel(path string) string {
	model := ""
	for _, ln := range tailLines(path) {
		ln = strings.TrimSpace(ln)
		if ln == "" {
			continue
		}
		var rec struct {
			Message struct {
				Model string `json:"model"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(ln), &rec) == nil && rec.Message.Model != "" {
			model = rec.Message.Model
		}
	}
	return model
}

func readLastTitle(path string) string {
	title := ""
	for _, ln := range tailLines(path) {
		ln = strings.TrimSpace(ln)
		if ln == "" {
			continue
		}
		var rec struct {
			Type    string `json:"type"`
			AiTitle string `json:"aiTitle"`
		}
		if json.Unmarshal([]byte(ln), &rec) == nil && rec.Type == "ai-title" && rec.AiTitle != "" {
			title = rec.AiTitle
		}
	}
	return title
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./cmd/wsh/cmd/ -run 'TestPlanEmission|TestDetailForTool|TestReadLast' -v`
Expected: PASS (all cases).

- [ ] **Step 5: Checkpoint**

```bash
git add cmd/wsh/cmd/wshcmd-agenthook.go cmd/wsh/cmd/wshcmd-agenthook_test.go
git status --short
```

State: "Task 2 done — pure agent-hook logic (planEmission, detailForTool, transcript readers) with table tests green."

---

### Task 3: Wire the `wsh agent-hook` command

Add the cobra command that reads stdin, gates on `WAVETERM_BLOCKID`, sets up RPC (swallowing failure), and publishes via the Task 1 helper. All error paths return nil.

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-agenthook.go`
- Test: `cmd/wsh/cmd/wshcmd-agenthook_test.go`

**Interfaces:**
- Consumes: `planEmission`, `readLastModel`, `readLastTitle` (Task 2); `publishAgentStatusData` (Task 1); `resolveBlockArg`, `setupRpcClient`, `wshutil.WaveJwtTokenVarName` (existing, `cmd/wsh/cmd/wshcmd-root.go`).
- Produces: the registered `agent-hook` cobra subcommand.

- [ ] **Step 1: Write the failing test (command registered)**

Append to `cmd/wsh/cmd/wshcmd-agenthook_test.go`:

```go
func TestAgentHookRegistered(t *testing.T) {
	found, _, err := rootCmd.Find([]string{"agent-hook"})
	if err != nil || found == nil || found.Name() != "agent-hook" {
		t.Fatalf("agent-hook not registered: found=%v err=%v", found, err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/wsh/cmd/ -run TestAgentHookRegistered -v`
Expected: FAIL — `agent-hook` resolves to the root command (name mismatch), not the subcommand.

- [ ] **Step 3: Add the command + run function**

Append to `cmd/wsh/cmd/wshcmd-agenthook.go`. Add these imports to the existing import block: `"time"`, `"github.com/wavetermdev/waveterm/pkg/util/wavebase"` is **not** needed; add `"github.com/wavetermdev/waveterm/pkg/wshutil"` and `"github.com/spf13/cobra"`. Then:

```go
var agentHookCmd = &cobra.Command{
	Use:                   "agent-hook",
	Short:                 "Claude Code lifecycle hook: report agent status to the Arc cockpit",
	Args:                  cobra.NoArgs,
	RunE:                  agentHookRun,
	Hidden:                true,
	DisableFlagsInUseLine: true,
	SilenceErrors:         true,
	SilenceUsage:          true,
}

func init() {
	rootCmd.AddCommand(agentHookCmd)
}

// agentHookRun always returns nil: a hook must never break the agent's turn.
func agentHookRun(cmd *cobra.Command, args []string) error {
	if os.Getenv("WAVETERM_BLOCKID") == "" {
		return nil // not inside an Arc block; near-instant no-op
	}
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return nil
	}
	var ev ccHookEvent
	if json.Unmarshal(raw, &ev) != nil {
		return nil
	}
	em := planEmission(ev)
	if em.State == "" && em.Subagent == nil {
		return nil
	}
	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" {
		return nil
	}
	if setupRpcClient(nil, jwt) != nil {
		return nil
	}
	oref, err := resolveBlockArg()
	if err != nil {
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
	return nil
}
```

- [ ] **Step 4: Run test + build to verify green**

Run: `go test ./cmd/wsh/cmd/ -run TestAgentHookRegistered -v`
Expected: PASS.
Run: `go build ./cmd/wsh/...`
Expected: builds clean.

- [ ] **Step 5: Checkpoint**

```bash
git add cmd/wsh/cmd/wshcmd-agenthook.go cmd/wsh/cmd/wshcmd-agenthook_test.go
git status --short
```

State: "Task 3 done — `wsh agent-hook` wired, fail-safe, gated on WAVETERM_BLOCKID; registration test + build green."

---

### Task 4: Teach `wsh ask` to unwrap the CC hook envelope

Extract stdin parsing into a pure `parseAskQuestions` that accepts either the raw `{questions:[...]}` shape (legacy) or the full CC hook envelope `{tool_input:{questions:[...]}}`, so `settings.json` can point `PreToolUse/AskUserQuestion` straight at `wsh ask`.

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-ask.go`
- Test: `cmd/wsh/cmd/wshcmd-ask_test.go`

**Interfaces:**
- Produces: `func parseAskQuestions(raw []byte) ([]baseds.AgentAskQuestion, error)`
- Consumes: `baseds.AgentAskQuestion`, `baseds.AgentAskOption`.

- [ ] **Step 1: Write the failing test**

Create `cmd/wsh/cmd/wshcmd-ask_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import "testing"

func TestParseAskQuestionsDirectShape(t *testing.T) {
	raw := []byte(`{"questions":[{"question":"Q1?","header":"H","multiSelect":true,"options":[{"label":"A","description":"da"},{"label":"B"}]}]}`)
	qs, err := parseAskQuestions(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(qs) != 1 || qs[0].Question != "Q1?" || qs[0].Header != "H" || !qs[0].MultiSelect {
		t.Fatalf("bad question: %#v", qs)
	}
	if len(qs[0].Options) != 2 || qs[0].Options[0].Label != "A" || qs[0].Options[0].Description != "da" {
		t.Fatalf("bad options: %#v", qs[0].Options)
	}
}

func TestParseAskQuestionsHookEnvelope(t *testing.T) {
	raw := []byte(`{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Q?","options":[{"label":"Yes"}]}]}}`)
	qs, err := parseAskQuestions(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(qs) != 1 || qs[0].Question != "Q?" || len(qs[0].Options) != 1 || qs[0].Options[0].Label != "Yes" {
		t.Fatalf("envelope not unwrapped: %#v", qs)
	}
}

func TestParseAskQuestionsEmpty(t *testing.T) {
	if _, err := parseAskQuestions([]byte(`{"questions":[]}`)); err == nil {
		t.Fatal("expected error for zero questions")
	}
	if _, err := parseAskQuestions([]byte(`not json`)); err == nil {
		t.Fatal("expected error for invalid json")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/wsh/cmd/ -run TestParseAskQuestions -v`
Expected: FAIL — `undefined: parseAskQuestions`.

- [ ] **Step 3: Extract `parseAskQuestions` and call it from `askRun`**

In `cmd/wsh/cmd/wshcmd-ask.go`, add the function (add `"encoding/json"` already imported):

```go
func parseAskQuestions(raw []byte) ([]baseds.AgentAskQuestion, error) {
	// unwrap the Claude Code hook envelope if present; else treat raw as the questions container
	payload := raw
	var env struct {
		ToolInput json.RawMessage `json:"tool_input"`
	}
	if json.Unmarshal(raw, &env) == nil && len(env.ToolInput) > 0 {
		payload = env.ToolInput
	}

	var in struct {
		Questions []struct {
			Question    string `json:"question"`
			Header      string `json:"header"`
			MultiSelect bool   `json:"multiSelect"`
			Options     []struct {
				Label       string `json:"label"`
				Description string `json:"description"`
			} `json:"options"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(payload, &in); err != nil {
		return nil, fmt.Errorf("no questions on stdin: %w", err)
	}
	if len(in.Questions) == 0 {
		return nil, fmt.Errorf("no questions provided")
	}

	questions := make([]baseds.AgentAskQuestion, len(in.Questions))
	for i, q := range in.Questions {
		opts := make([]baseds.AgentAskOption, len(q.Options))
		for j, o := range q.Options {
			opts[j] = baseds.AgentAskOption{Label: o.Label, Description: o.Description}
		}
		questions[i] = baseds.AgentAskQuestion{
			Question:    q.Question,
			Header:      q.Header,
			MultiSelect: q.MultiSelect,
			Options:     opts,
		}
	}
	return questions, nil
}
```

Then in `askRun`, replace the stdin read + the inline `var in struct{...}` unmarshal + questions-build block (everything from `raw, err := io.ReadAll(os.Stdin)` through the `questions := make(...)` loop) with:

```go
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return fmt.Errorf("reading stdin: %w", err)
	}
	questions, err := parseAskQuestions(raw)
	if err != nil {
		return err
	}
```

Leave the trailing `AskCommand(...)` call unchanged.

- [ ] **Step 4: Run test + build to verify green**

Run: `go test ./cmd/wsh/cmd/ -run TestParseAskQuestions -v`
Expected: PASS.
Run: `go build ./cmd/wsh/...`
Expected: builds clean.

- [ ] **Step 5: Checkpoint**

```bash
git add cmd/wsh/cmd/wshcmd-ask.go cmd/wsh/cmd/wshcmd-ask_test.go
git status --short
```

State: "Task 4 done — `wsh ask` unwraps the CC hook envelope; both stdin shapes tested."

---

### Task 5: `wsh install-agent-hooks` — idempotent settings.json merge

Pure `mergeAgentHooks` + `isManagedCommand`, then the command that reads/creates/parses/merges/atomically-writes `~/.claude/settings.json`.

**Files:**
- Create: `cmd/wsh/cmd/wshcmd-installhooks.go`
- Test: `cmd/wsh/cmd/wshcmd-installhooks_test.go`

**Interfaces:**
- Produces:
  - `func mergeAgentHooks(existing map[string]any, wshExe string) map[string]any`
  - `func isManagedCommand(command string) bool`
  - the registered `install-agent-hooks` cobra subcommand.

- [ ] **Step 1: Write the failing tests**

Create `cmd/wsh/cmd/wshcmd-installhooks_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import "testing"

const testWsh = `C:\a\bin\wsh-0.14.5-windows.x64.exe`

// count managed command entries across all events in a merged config
func countManaged(t *testing.T, cfg map[string]any) int {
	t.Helper()
	n := 0
	hooks, _ := cfg["hooks"].(map[string]any)
	for _, groups := range hooks {
		gs, _ := groups.([]any)
		for _, g := range gs {
			gm, _ := g.(map[string]any)
			hs, _ := gm["hooks"].([]any)
			for _, h := range hs {
				hm, _ := h.(map[string]any)
				if c, _ := hm["command"].(string); isManagedCommand(c) {
					n++
				}
			}
		}
	}
	return n
}

func TestIsManagedCommand(t *testing.T) {
	cases := map[string]bool{
		`"C:\a\bin\wsh-0.14.5-windows.x64.exe" agent-hook`: true,
		`"C:\a\bin\wsh.exe" ask`:                           true,
		`"/usr/local/bin/wsh" ask --clear`:                 true,
		`wsh agent-hook`:                                   true,
		`"C:\a\bin\wsh.exe" ask --other`:                   false,
		`node /x/ask-hook.js`:                              false,
		`mytool agent-hook`:                                false,
		``:                                                 false,
	}
	for cmd, want := range cases {
		if got := isManagedCommand(cmd); got != want {
			t.Fatalf("isManagedCommand(%q) = %v, want %v", cmd, got, want)
		}
	}
}

func TestMergeAgentHooksEmpty(t *testing.T) {
	got := mergeAgentHooks(map[string]any{}, testWsh)
	if n := countManaged(t, got); n != 8 {
		t.Fatalf("managed entries = %d, want 8", n)
	}
}

func TestMergeAgentHooksIdempotent(t *testing.T) {
	once := mergeAgentHooks(map[string]any{}, testWsh)
	twice := mergeAgentHooks(once, testWsh)
	if n := countManaged(t, twice); n != 8 {
		t.Fatalf("managed entries after 2x = %d, want 8", n)
	}
}

func TestMergeAgentHooksPreservesUnrelated(t *testing.T) {
	existing := map[string]any{
		"theme": "dark",
		"env":   map[string]any{"FOO": "1"},
		"hooks": map[string]any{
			"PreToolUse": []any{
				map[string]any{
					"matcher": "Bash",
					"hooks":   []any{map[string]any{"type": "command", "command": "node /my/own/hook.js"}},
				},
			},
		},
	}
	got := mergeAgentHooks(existing, testWsh)
	if got["theme"] != "dark" {
		t.Fatal("theme not preserved")
	}
	if _, ok := got["env"].(map[string]any); !ok {
		t.Fatal("env not preserved")
	}
	// user's Bash hook must survive
	hooks := got["hooks"].(map[string]any)
	pre := hooks["PreToolUse"].([]any)
	foundUser := false
	for _, g := range pre {
		gm := g.(map[string]any)
		hs := gm["hooks"].([]any)
		for _, h := range hs {
			if h.(map[string]any)["command"] == "node /my/own/hook.js" {
				foundUser = true
			}
		}
	}
	if !foundUser {
		t.Fatal("user hook was clobbered")
	}
	if n := countManaged(t, got); n != 8 {
		t.Fatalf("managed entries = %d, want 8", n)
	}
}

func TestMergeAgentHooksRefreshesStalePath(t *testing.T) {
	old := mergeAgentHooks(map[string]any{}, `C:\old\bin\wsh-0.14.4-windows.x64.exe`)
	refreshed := mergeAgentHooks(old, testWsh)
	if n := countManaged(t, refreshed); n != 8 {
		t.Fatalf("managed entries = %d, want 8 (stale not replaced)", n)
	}
	// no command should still reference the old path
	hooks := refreshed["hooks"].(map[string]any)
	for _, groups := range hooks {
		for _, g := range groups.([]any) {
			for _, h := range g.(map[string]any)["hooks"].([]any) {
				c := h.(map[string]any)["command"].(string)
				if strings_Contains(c, "0.14.4") {
					t.Fatalf("stale path still present: %q", c)
				}
			}
		}
	}
}

// tiny local helper so the test file needs no extra import
func strings_Contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./cmd/wsh/cmd/ -run 'TestIsManagedCommand|TestMergeAgentHooks' -v`
Expected: FAIL — `undefined: mergeAgentHooks` / `isManagedCommand`.

- [ ] **Step 3: Implement the merge + command**

Create `cmd/wsh/cmd/wshcmd-installhooks.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

// managedHook is one (event, matcher) hook Arc owns in the user's settings.json.
type managedHook struct {
	Event   string
	Matcher string // "" => no matcher key (matches all)
	Args    string // wsh subcommand + flags, e.g. "agent-hook", "ask", "ask --clear"
	Timeout int
}

// order is deterministic so re-runs produce stable output
var managedHooks = []managedHook{
	{"PreToolUse", "", "agent-hook", 10},
	{"PreToolUse", "AskUserQuestion", "ask", 3600},
	{"PostToolUse", "", "agent-hook", 10},
	{"PostToolUse", "AskUserQuestion", "ask --clear", 10},
	{"Notification", "", "agent-hook", 10},
	{"Stop", "", "agent-hook", 10},
	{"SubagentStop", "", "agent-hook", 10},
	{"UserPromptSubmit", "", "agent-hook", 10},
}

func managedEventOrder() []string {
	seen := map[string]bool{}
	var order []string
	for _, mh := range managedHooks {
		if !seen[mh.Event] {
			seen[mh.Event] = true
			order = append(order, mh.Event)
		}
	}
	return order
}

// isManagedCommand reports whether a hook command string is one Arc wrote: the first
// token's basename starts with "wsh" and the remaining args are exactly one of our
// subcommands. Path- and version-independent so app updates self-heal.
func isManagedCommand(command string) bool {
	exe, rest := splitFirstToken(command)
	if exe == "" {
		return false
	}
	base := strings.ToLower(filepath.Base(exe))
	if !strings.HasPrefix(base, "wsh") {
		return false
	}
	switch strings.TrimSpace(rest) {
	case "agent-hook", "ask", "ask --clear":
		return true
	}
	return false
}

// splitFirstToken splits a command string into its first token (respecting a leading
// double-quoted path) and the remainder.
func splitFirstToken(command string) (string, string) {
	command = strings.TrimSpace(command)
	if command == "" {
		return "", ""
	}
	if command[0] == '"' {
		if end := strings.IndexByte(command[1:], '"'); end >= 0 {
			return command[1 : 1+end], strings.TrimSpace(command[end+2:])
		}
		return command[1:], ""
	}
	if sp := strings.IndexByte(command, ' '); sp >= 0 {
		return command[:sp], strings.TrimSpace(command[sp+1:])
	}
	return command, ""
}

func quotePath(p string) string {
	return `"` + p + `"`
}

func buildManagedGroup(mh managedHook, wshExe string) map[string]any {
	group := map[string]any{
		"hooks": []any{
			map[string]any{
				"type":    "command",
				"command": quotePath(wshExe) + " " + mh.Args,
				"timeout": mh.Timeout,
			},
		},
	}
	if mh.Matcher != "" {
		group["matcher"] = mh.Matcher
	}
	return group
}

func groupIsManaged(group any) bool {
	gm, ok := group.(map[string]any)
	if !ok {
		return false
	}
	hs, ok := gm["hooks"].([]any)
	if !ok {
		return false
	}
	for _, h := range hs {
		hm, ok := h.(map[string]any)
		if !ok {
			continue
		}
		if c, ok := hm["command"].(string); ok && isManagedCommand(c) {
			return true
		}
	}
	return false
}

// mergeAgentHooks returns a copy of existing with Arc's managed hook entries added or
// refreshed, preserving every other key and every non-managed hook group.
func mergeAgentHooks(existing map[string]any, wshExe string) map[string]any {
	// deep copy via round-trip so the caller's map is never mutated
	out := map[string]any{}
	if b, err := json.Marshal(existing); err == nil {
		_ = json.Unmarshal(b, &out)
	}

	hooks, _ := out["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
		out["hooks"] = hooks
	}

	for _, event := range managedEventOrder() {
		var kept []any
		if groups, ok := hooks[event].([]any); ok {
			for _, g := range groups {
				if !groupIsManaged(g) {
					kept = append(kept, g)
				}
			}
		}
		for _, mh := range managedHooks {
			if mh.Event == event {
				kept = append(kept, buildManagedGroup(mh, wshExe))
			}
		}
		hooks[event] = kept
	}
	return out
}

var installAgentHooksCmd = &cobra.Command{
	Use:                   "install-agent-hooks",
	Short:                 "install Arc's Claude Code hooks into ~/.claude/settings.json (idempotent)",
	Args:                  cobra.NoArgs,
	RunE:                  installAgentHooksRun,
	Hidden:                true,
	DisableFlagsInUseLine: true,
}

func init() {
	rootCmd.AddCommand(installAgentHooksCmd)
}

func installAgentHooksRun(cmd *cobra.Command, args []string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolving home dir: %w", err)
	}
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	path := filepath.Join(dir, "settings.json")

	existing := map[string]any{}
	if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) > 0 {
		if err := json.Unmarshal(b, &existing); err != nil {
			return fmt.Errorf("parsing %s: %w", path, err)
		}
	}

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolving wsh path: %w", err)
	}

	merged := mergeAgentHooks(existing, exe)
	out, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding settings: %w", err)
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(out, '\n'), 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("replacing %s: %w", path, err)
	}
	fmt.Printf("installed Arc agent hooks into %s\n", path)
	return nil
}
```

- [ ] **Step 4: Run tests + build to verify green**

Run: `go test ./cmd/wsh/cmd/ -run 'TestIsManagedCommand|TestMergeAgentHooks' -v`
Expected: PASS.
Run: `go build ./cmd/wsh/...`
Expected: builds clean.

- [ ] **Step 5: Checkpoint**

```bash
git add cmd/wsh/cmd/wshcmd-installhooks.go cmd/wsh/cmd/wshcmd-installhooks_test.go
git status --short
```

State: "Task 5 done — `wsh install-agent-hooks` merges idempotently, preserves user config, refreshes stale paths; pure merge + matcher tested."

---

### Task 6: Fire `install-agent-hooks` from the Tauri app on launch

Resolve the bundled (version-named) `wsh` binary and spawn `install-agent-hooks` detached, output discarded, failure ignored — in `setup()`, on every launch, dev and packaged alike.

**Files:**
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `paths::resolve_app_path` output (`app_path`), already computed in `setup()`.
- Produces: `fn find_wsh_binary(bin_dir: &Path) -> Option<PathBuf>`; `fn install_agent_hooks(app_path: &Path)`.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/main.rs` (the file has no tests today; create the module). First add near the other `use` lines at top: nothing new required. Append at end of file:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finds_versioned_wsh_binary() {
        let dir = std::env::temp_dir().join(format!("arc-wsh-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        fs::write(dir.join("wavesrv.x64.exe"), b"x").unwrap();
        fs::write(dir.join("wsh-0.14.5-windows.x64.exe"), b"x").unwrap();

        let got = find_wsh_binary(&dir).expect("should find wsh");
        assert_eq!(got.file_name().unwrap(), "wsh-0.14.5-windows.x64.exe");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn returns_none_when_no_wsh() {
        let dir = std::env::temp_dir().join(format!("arc-wsh-none-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        fs::write(dir.join("wavesrv.x64.exe"), b"x").unwrap();
        assert!(find_wsh_binary(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml find`
Expected: FAIL — `cannot find function find_wsh_binary`.

- [ ] **Step 3: Implement resolver + spawn, and call it in setup()**

In `src-tauri/src/main.rs`, add functions above `fn main()`:

```rust
// The bundle ships wsh version-named (e.g. wsh-0.14.5-windows.x64.exe), not a plain
// wsh.exe — find it by pattern in {app_path}/bin.
fn find_wsh_binary(bin_dir: &std::path::Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(bin_dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("wsh") && name.ends_with("windows.x64.exe") {
            return Some(entry.path());
        }
    }
    None
}

// Fire-and-forget: idempotently provision Arc's Claude Code hooks into the user's
// ~/.claude/settings.json. Runs every launch; wsh does the idempotent merge. Any
// failure is ignored — a missing hook only means degraded cockpit display.
fn install_agent_hooks(app_path: &std::path::Path) {
    let bin = app_path.join("bin");
    let Some(wsh) = find_wsh_binary(&bin) else {
        println!("[tauri] wsh not found under {:?}; skipping hook install", bin);
        return;
    };
    let mut cmd = Command::new(&wsh);
    cmd.arg("install-agent-hooks")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(_) => println!("[tauri] triggered agent-hooks install via {:?}", wsh),
        Err(e) => println!("[tauri] agent-hooks install spawn failed: {}", e),
    }
}
```

Then in `setup()`, right after `let app_path = paths::resolve_app_path(is_dev, manifest_dir, &resource_dir);` and before `spawn_wavesrv`, add:

```rust
            install_agent_hooks(&app_path);
```

(Passing `&app_path` before it is moved into `spawn_wavesrv` — `spawn_wavesrv` takes `app_path` by value below, so this call must come first, which it does.)

- [ ] **Step 4: Run test + build to verify green**

Run: `cargo test --manifest-path src-tauri/Cargo.toml find`
Expected: PASS (both `find_*` tests).
Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds clean.

- [ ] **Step 5: Checkpoint**

```bash
git add src-tauri/src/main.rs
git status --short
```

State: "Task 6 done — Tauri setup() resolves the version-named wsh and fires install-agent-hooks detached; resolver unit-tested."

---

### Task 7: Documentation

Update the agent docs to describe the `wsh`-native hooks + auto-install and mark the standalone JS hooks as superseded (kept for reference this release).

**Files:**
- Modify: `docs/agents/organic-ask-setup.md`
- Modify: `docs/agents/usage-reporting.md`
- Modify: `docs/agents/tab-auto-naming.md`

- [ ] **Step 1: Update `organic-ask-setup.md`**

Replace the "## Setup" section's manual registration snippet with the auto-install description. Insert after the "## How it works" section, before "### 2. Open the Agents panel":

```markdown
## Setup — automatic

As of the `wsh`-native hooks, **no manual setup is required.** On every launch the
Arc app runs `wsh install-agent-hooks`, which idempotently merges Arc's hook block
into your user-level `~/.claude/settings.json` (preserving all other settings). The
ask interception is registered as:

- `PreToolUse` / `AskUserQuestion` → `wsh ask` (projects the question into the panel)
- `PostToolUse` / `AskUserQuestion` → `wsh ask --clear` (removes the panel copy)

`wsh ask` reads the Claude Code hook envelope directly (unwrapping `tool_input`), so
no wrapper script is needed. The legacy `docs/agents/ask-hook.js` /
`ask-clear-hook.js` are superseded by the `wsh` subcommands and kept only for
reference; a packaged install never used them (it ships only `bin/`, not `docs/`).

To (re)provision manually: run `wsh install-agent-hooks` from any Arc terminal.
```

- [ ] **Step 2: Update `usage-reporting.md` and `tab-auto-naming.md` reporter references**

In `usage-reporting.md`, in the "## Why usage rides the statusLine, not the hook reporter" section, replace the sentence naming `agent_status_reporter.py` (external repo `agent-status-spike`) with:

```markdown
Agent **state** (working / waiting / idle) and the **subagent tree** are driven by
`wsh agent-hook` (in-repo, `cmd/wsh/cmd/wshcmd-agenthook.go`), wired into Claude Code
lifecycle hooks (`PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SubagentStop`,
`UserPromptSubmit`) and auto-installed by the Arc app. Those hook payloads **do not
carry usage numbers**.
```

In `tab-auto-naming.md`, in "## Why the title rides the hook reporter" and "## Reporter implementation (external)", replace references to `agent_status_reporter.py` / `read_last_title` / `agent-status-spike` with the `wsh agent-hook` equivalents (`readLastTitle` / `readLastModel` in `cmd/wsh/cmd/wshcmd-agenthook.go`), and note the reporter is now in-repo and auto-installed rather than external. Keep the data-flow diagram; change only the producer line from `agent_status_reporter.py : read_last_title()` to `wsh agent-hook : readLastTitle()`.

- [ ] **Step 3: Verify no stale external-reporter claims remain**

Run: `grep -rn "agent-status-spike\|agent_status_reporter" docs/agents/`
Expected: no matches (all replaced), OR only clearly-labeled historical notes.

- [ ] **Step 4: Checkpoint**

```bash
git add docs/agents/organic-ask-setup.md docs/agents/usage-reporting.md docs/agents/tab-auto-naming.md
git status --short
```

State: "Task 7 done — docs describe the wsh-native hooks + auto-install; external-reporter references removed."

---

### Task 8: Full verification + single approval-gated commit

**Files:** none (verification + commit).

- [ ] **Step 1: Run the full Go + Rust test suites**

Run: `go test ./cmd/wsh/...`
Expected: PASS (all new + existing).
Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 2: Build the backend binaries**

Run: `task build:backend`
Expected: builds `wsh` + `wavesrv` into `dist/bin/` clean.

- [ ] **Step 3: Live smoke over CDP (per CLAUDE.md visual verification)**

- Run `task dev` (rebuilds `src-tauri`, activating the launch-time install trigger).
- Confirm `~/.claude/settings.json` now contains the 8 managed entries pointing at the versioned `wsh` path, with any pre-existing keys/hooks intact.
- Launch a Claude Code agent inside an Arc terminal block. Confirm: the sidebar row relabels to the ai-title within a turn; state cycles working → idle; an `AskUserQuestion` surfaces in the Agents panel.
- Capture: `node scripts/cdp-shot.mjs` and eyeball the cockpit.

Expected: cockpit populates with no manual setup.

- [ ] **Step 4: Self-review the diff**

Run: `git diff --stat` and `git diff`
Confirm: no debug prints beyond the intentional `[tauri]` logs, no commented-out code, no unrelated changes.

- [ ] **Step 5: Request approval, then commit**

Present to the user: files to commit (M/A per path), and the proposed message:

```
feat(cockpit): wsh-native agent hooks + auto-install into ~/.claude

Reconstruct the agent-status reporter as `wsh agent-hook` and provision all
Claude Code hooks (agent-hook, ask, ask --clear) into the user's settings.json
idempotently on launch, so the cockpit works after a normal install with no
manual setup.
```

Ask: "Awaiting approval. Proceed with the commit? (yes/no)" — do **not** commit until the user approves.

---

## Self-Review

**1. Spec coverage:**
- Reconstruct reporter → Tasks 2–3 (`wsh agent-hook`, mapping table, transcript readers). ✓
- Ask hooks folded into wsh → Task 4 (`wsh ask` envelope unwrap). ✓
- Auto-install / idempotent merge → Task 5 (`install-agent-hooks`, `mergeAgentHooks`). ✓
- Absolute version-named wsh path + self-heal matcher → Task 5 (`isManagedCommand` prefix) + Task 6 (`find_wsh_binary`). ✓
- Tauri launch trigger, dev + packaged → Task 6. ✓
- Fail-safe / no-op outside Arc → Task 3 (WAVETERM_BLOCKID gate, always-nil returns). ✓
- In-process publish (no second wsh spawn) → Task 1 (`publishAgentStatusData`). ✓
- Docs + retire JS hooks → Task 7. ✓
- Risk 1 (SubagentStop correlation) → Task 2 best-effort (`ToolUseID != ""` guards, else nothing). ✓
- Risk 2 (global hook tax) → Task 3 instant no-op. ✓

**2. Placeholder scan:** No TBD/TODO; every code step contains complete code; every command has expected output. ✓

**3. Type consistency:** `buildAgentStatusEvent`/`publishAgentStatusData` (Task 1) consumed unchanged in Task 3. `planEmission`/`detailForTool`/`readLastModel`/`readLastTitle` (Task 2) consumed unchanged in Task 3. `parseAskQuestions` (Task 4) self-contained. `mergeAgentHooks`/`isManagedCommand` (Task 5) consumed by test + command in same task. `find_wsh_binary`/`install_agent_hooks` (Task 6) self-contained. `ccHookEvent`/`agentEmission` field names identical across Tasks 2–3. ✓

**Note on a known assumption:** `ccHookEvent.ToolUseID` depends on Claude Code including `tool_use_id` in `PreToolUse`/`SubagentStop` payloads. If absent, subagent deltas are simply not emitted (guarded) and the subagent tree self-clears at the parent's `idle` — the documented v1 best-effort behavior. No task fails as a result.
