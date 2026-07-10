// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func TestPlanEmission(t *testing.T) {
	tests := []struct {
		name      string
		ev        ccHookEvent
		wantState string
		wantMT    bool // AttachModelTitle
	}{
		{"prompt submit", ccHookEvent{HookEventName: "UserPromptSubmit"}, baseds.AgentState_Working, true},
		{"stop idle", ccHookEvent{HookEventName: "Stop"}, baseds.AgentState_Idle, true},
		{"notification waiting", ccHookEvent{HookEventName: "Notification"}, baseds.AgentState_Waiting, false},
		{"post tool working", ccHookEvent{HookEventName: "PostToolUse"}, baseds.AgentState_Working, true},
		{"pre bash working", ccHookEvent{HookEventName: "PreToolUse", ToolName: "Bash", ToolInput: json.RawMessage(`{"command":"ls"}`)}, baseds.AgentState_Working, true},
		{"pre ask -> asking", ccHookEvent{HookEventName: "PreToolUse", ToolName: "AskUserQuestion"}, baseds.AgentState_Asking, false},
		// Task now only keeps the parent "working"; the disk store (not a hook delta) tracks subagents.
		{"pre task -> working", ccHookEvent{HookEventName: "PreToolUse", ToolName: "Task", ToolUseID: "t1", ToolInput: json.RawMessage(`{"subagent_type":"Explore"}`)}, baseds.AgentState_Working, true},
		{"subagent stop -> nothing", ccHookEvent{HookEventName: "SubagentStop", ToolUseID: "t1"}, "", false},
		{"unknown event -> nothing", ccHookEvent{HookEventName: "PreCompact"}, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			em := planEmission(tt.ev)
			if em.State != tt.wantState {
				t.Fatalf("state = %q, want %q", em.State, tt.wantState)
			}
			if em.AttachModelTitle != tt.wantMT {
				t.Fatalf("attachModelTitle = %v, want %v", em.AttachModelTitle, tt.wantMT)
			}
		})
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

func TestLastUserPrompt(t *testing.T) {
	// last user turn with human text wins; assistant/ai-title lines and tool_result-only user turns are ignored
	lines := []string{
		`{"type":"assistant","message":{"content":[]}}`,
		`{"type":"user","message":{"content":"first ask"}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","content":"file contents"}]}}`,
		`{"type":"user","message":{"content":[{"type":"text","text":"/commit stage the diff"}]}}`,
		`{"type":"ai-title","aiTitle":"x"}`,
	}
	if got := lastUserPrompt(lines); got != "/commit stage the diff" {
		t.Fatalf("lastUserPrompt = %q, want %q", got, "/commit stage the diff")
	}
}

func TestLastUserPromptStringAndEmpty(t *testing.T) {
	if got := lastUserPrompt([]string{`{"type":"user","message":{"content":"hi there"}}`}); got != "hi there" {
		t.Fatalf("string content = %q, want %q", got, "hi there")
	}
	if got := lastUserPrompt([]string{`{"type":"assistant","message":{"content":"x"}}`}); got != "" {
		t.Fatalf("no user turn -> %q, want empty", got)
	}
	if got := lastUserPrompt([]string{`{"type":"user","message":{"content":[{"type":"tool_result","content":"r"}]}}`}); got != "" {
		t.Fatalf("tool_result-only user turn -> %q, want empty", got)
	}
}

func TestTitleFromPrompt(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"slash command carries skill + ask", "/commit stage the diff", "/commit stage the diff"},
		{"first non-empty line only", "\n\n  do the thing  \nsecond line", "do the thing"},
		{"empty -> empty", "   \n  ", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := titleFromPrompt(tt.in); got != tt.want {
				t.Fatalf("titleFromPrompt(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestTitleFromPromptTruncatedByRune(t *testing.T) {
	got := titleFromPrompt(strings.Repeat("x", 200))
	if len([]rune(got)) != titleMax {
		t.Fatalf("truncated rune-len = %d, want %d", len([]rune(got)), titleMax)
	}
}

func TestAgentHookRegistered(t *testing.T) {
	found, _, err := rootCmd.Find([]string{"agent-hook"})
	if err != nil || found == nil || found.Name() != "agent-hook" {
		t.Fatalf("agent-hook not registered: found=%v err=%v", found, err)
	}
}

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
