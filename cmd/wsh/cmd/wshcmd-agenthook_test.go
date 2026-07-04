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
		{"pre ask -> asking", ccHookEvent{HookEventName: "PreToolUse", ToolName: "AskUserQuestion"}, baseds.AgentState_Asking, "", false},
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

func TestAgentHookRegistered(t *testing.T) {
	found, _, err := rootCmd.Find([]string{"agent-hook"})
	if err != nil || found == nil || found.Name() != "agent-hook" {
		t.Fatalf("agent-hook not registered: found=%v err=%v", found, err)
	}
}
