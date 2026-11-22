// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentworker

import (
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
)

func TestComposeLaunch(t *testing.T) {
	tests := []struct {
		name     string
		opts     SessionOptions
		parent   Parent
		harness  string
		bin      string
		baseArgs []string
	}{
		{"claude defaults to the parent's harness, model and mode",
			SessionOptions{}, Parent{Harness: "claude", Model: "opus", PermissionMode: "acceptEdits"},
			"claude", "claude", []string{"--model", "opus", "--permission-mode", "acceptEdits"}},
		{"a parent model the route rejects falls back to the harness default",
			SessionOptions{}, Parent{Harness: "claude", Model: "gpt-4o", PermissionMode: "plan"},
			"claude", "claude", []string{"--permission-mode", "plan"}},
		{"another harness does not inherit the parent's model",
			SessionOptions{Harness: "pi"}, Parent{Harness: "claude", Model: "opus", PermissionMode: "default"},
			"pi", "pi", nil},
		{"pi defaults to the parent's pi model",
			SessionOptions{}, Parent{Harness: "pi", Model: "openai/gpt-4o"},
			"pi", "pi", []string{"--model", "openai/gpt-4o"}},
		{"an explicit model wins over the parent's",
			SessionOptions{Model: "sonnet"}, Parent{Harness: "claude", Model: "opus", PermissionMode: "default"},
			"claude", "claude", []string{"--model", "sonnet", "--permission-mode", "default"}},
		{"a claude parent with no reported mode counts as default",
			SessionOptions{}, Parent{Harness: "claude"},
			"claude", "claude", []string{"--permission-mode", "default"}},
		{"a stricter mode is accepted",
			SessionOptions{PermissionMode: "plan"}, Parent{Harness: "claude", PermissionMode: "acceptEdits"},
			"claude", "claude", []string{"--permission-mode", "plan"}},
		{"the parent's own rung is accepted",
			SessionOptions{PermissionMode: "auto"}, Parent{Harness: "claude", PermissionMode: "auto"},
			"claude", "claude", []string{"--permission-mode", "auto"}},
		{"manual is the default rung",
			SessionOptions{PermissionMode: "default"}, Parent{Harness: "claude", PermissionMode: "manual"},
			"claude", "claude", []string{"--permission-mode", "default"}},
		{"a pi parent allows any mode",
			SessionOptions{Harness: "claude", PermissionMode: "bypassPermissions"}, Parent{Harness: "pi"},
			"claude", "claude", []string{"--permission-mode", "bypassPermissions"}},
		{"a claude worker of a pi parent defaults to bypassPermissions",
			SessionOptions{Harness: "claude"}, Parent{Harness: "pi"},
			"claude", "claude", []string{"--permission-mode", "bypassPermissions"}},
		{"every claude option maps to its flag",
			SessionOptions{Model: "haiku", Reasoning: "high", SystemPrompt: "be terse", AppendSystemPrompt: "and kind", Tools: "Bash,Read", PermissionMode: "dontAsk"},
			Parent{Harness: "claude", PermissionMode: "default"},
			"claude", "claude", []string{"--tools", "Bash,Read", "--model", "haiku", "--effort", "high",
				"--system-prompt", "be terse", "--append-system-prompt", "and kind", "--permission-mode", "dontAsk"}},
		{"every pi option maps to its flag",
			SessionOptions{Model: "anthropic/claude-sonnet", Reasoning: "low", SystemPrompt: "be terse", AppendSystemPrompt: "and kind", Tools: "read,grep"},
			Parent{Harness: "pi"},
			"pi", "pi", []string{"--tools", "read,grep", "--model", "anthropic/claude-sonnet", "--thinking", "low",
				"--system-prompt", "be terse", "--append-system-prompt", "and kind"}},
		{"system prompts of exactly the cap fit",
			SessionOptions{Harness: "pi", SystemPrompt: strings.Repeat("a", 8*1024), AppendSystemPrompt: strings.Repeat("b", 8*1024)},
			Parent{Harness: "pi"},
			"pi", "pi", []string{"--system-prompt", strings.Repeat("a", 8*1024), "--append-system-prompt", strings.Repeat("b", 8*1024)}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			l, err := ComposeLaunch(tt.opts, tt.parent)
			if err != nil {
				t.Fatalf("ComposeLaunch: %v", err)
			}
			if l.Harness != tt.harness || l.Bin != tt.bin || !reflect.DeepEqual(l.BaseArgs, tt.baseArgs) {
				t.Errorf("launch = %+v, want harness %q bin %q args %q", l, tt.harness, tt.bin, tt.baseArgs)
			}
		})
	}
}

func TestComposeLaunchRefuses(t *testing.T) {
	tests := []struct {
		name   string
		opts   SessionOptions
		parent Parent
		want   []string // each must appear in the error
	}{
		{"a model the route rejects",
			SessionOptions{Model: "gpt-4o"}, Parent{Harness: "claude"}, []string{"gpt-4o"}},
		{"a looser mode, naming both",
			SessionOptions{PermissionMode: "bypassPermissions"}, Parent{Harness: "claude", PermissionMode: "acceptEdits"},
			[]string{"bypassPermissions", "acceptEdits"}},
		{"a looser mode than an unreported parent's default",
			SessionOptions{PermissionMode: "acceptEdits"}, Parent{Harness: "claude"}, []string{"acceptEdits", "default"}},
		{"a permission mode for a pi worker, naming the option and the harness",
			SessionOptions{PermissionMode: "plan"}, Parent{Harness: "pi"}, []string{"--permission-mode", "pi"}},
		{"an unknown permission mode",
			SessionOptions{PermissionMode: "yolo"}, Parent{Harness: "claude"}, []string{"yolo"}},
		{"an unknown parent permission mode",
			SessionOptions{}, Parent{Harness: "claude", PermissionMode: "yolo"}, []string{"yolo"}},
		{"a harness that cannot run a worker",
			SessionOptions{Harness: "codex"}, Parent{Harness: "claude"}, []string{"codex"}},
		{"a parent harness that cannot run a worker",
			SessionOptions{}, Parent{Harness: "codex"}, []string{"codex"}},
		{"no harness at all",
			SessionOptions{}, Parent{}, []string{"harness"}},
		{"system prompts over the cap",
			SessionOptions{SystemPrompt: strings.Repeat("a", 8*1024), AppendSystemPrompt: strings.Repeat("b", 8*1024+1)},
			Parent{Harness: "claude"}, []string{"system prompt"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			l, err := ComposeLaunch(tt.opts, tt.parent)
			if err == nil {
				t.Fatalf("ComposeLaunch = %+v, want an error", l)
			}
			for _, w := range tt.want {
				if !strings.Contains(err.Error(), w) {
					t.Errorf("error %q does not name %q", err, w)
				}
			}
		})
	}
}

// claude's --tools is variadic: every argument up to the next flag is a tool name
func TestComposeLaunchToolsNeverSwallowThePrompt(t *testing.T) {
	parents := []Parent{{Harness: "claude"}, {Harness: "pi"}}
	for _, parent := range parents {
		opts := SessionOptions{Harness: "claude", Tools: "Read"}
		l, err := ComposeLaunch(opts, parent)
		if err != nil {
			t.Fatalf("ComposeLaunch: %v", err)
		}
		resume, ok := jarvis.ResumeWorkerArgs(l.Harness, "sess", l.BaseArgs, "the prompt")
		if !ok {
			t.Fatalf("ResumeWorkerArgs refused %q", l.Harness)
		}
		for _, args := range [][]string{FirstStartArgs(l, "sess", "the prompt"), resume} {
			i := slices.Index(args, "--tools")
			if i < 0 || i+2 >= len(args) {
				t.Fatalf("args %q: --tools missing or last", args)
			}
			if next := args[i+2]; !strings.HasPrefix(next, "--") {
				t.Errorf("args %q: %q follows the tools and would be read as a tool", args, next)
			}
		}
	}
}

func TestFirstStartArgs(t *testing.T) {
	l := Launch{Harness: "claude", Bin: "claude", BaseArgs: []string{"--permission-mode", "plan"}}
	got := FirstStartArgs(l, "sess-1", "do the task")
	want := []string{"--permission-mode", "plan", "--session-id", "sess-1", "do the task"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("FirstStartArgs = %q, want %q", got, want)
	}
	got[0] = "changed"
	if l.BaseArgs[0] != "--permission-mode" {
		t.Errorf("FirstStartArgs wrote through to BaseArgs: %q", l.BaseArgs)
	}
}
