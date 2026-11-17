// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"regexp"
	"testing"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

func TestToolKeyStableAcrossKeyOrder(t *testing.T) {
	a := toolKey("Edit", json.RawMessage(`{"a":1,"b":{"x":1,"y":2}}`))
	b := toolKey("Edit", json.RawMessage(`{ "b": {"y":2,"x":1}, "a": 1 }`))
	if a != b {
		t.Fatalf("key order changed the key: %q vs %q", a, b)
	}
	if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(a) {
		t.Fatalf("key = %q, want 16 hex chars", a)
	}
	if other := toolKey("Write", json.RawMessage(`{"a":1,"b":{"x":1,"y":2}}`)); other == a {
		t.Fatalf("another tool name gave the same key %q", a)
	}
	if other := toolKey("Edit", json.RawMessage(`{"a":2,"b":{"x":1,"y":2}}`)); other == a {
		t.Fatalf("another input gave the same key %q", a)
	}
}

func TestToolKeyKeepsLargeIntegersExact(t *testing.T) {
	a := toolKey("Bash", json.RawMessage(`{"n":9007199254740993}`))
	b := toolKey("Bash", json.RawMessage(`{"n":9007199254740992}`))
	if a == b {
		t.Fatalf("integers beyond 2^53 collapsed to one key %q", a)
	}
}

func TestToolKeyWithoutInput(t *testing.T) {
	if got := toolKey("Bash", nil); len(got) != 16 {
		t.Fatalf("key for a call with no input = %q, want 16 hex chars", got)
	}
}

func TestParsePermissionRequest(t *testing.T) {
	withSuggestions := []byte(`{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"go test ./..."},"permission_suggestions":[{"type":"addRules"}]}`)
	got, err := parsePermissionRequest(withSuggestions)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got.ToolName != "Bash" {
		t.Fatalf("ToolName = %q", got.ToolName)
	}
	if got.ToolInput != `{"command":"go test ./..."}` {
		t.Fatalf("ToolInput = %q", got.ToolInput)
	}
	if !got.HasSuggestions {
		t.Fatalf("HasSuggestions = false, want true")
	}
	if want := toolKey("Bash", json.RawMessage(`{"command":"go test ./..."}`)); got.ToolKey != want {
		t.Fatalf("ToolKey = %q, want %q", got.ToolKey, want)
	}

	for _, body := range []string{
		`{"tool_name":"Edit","tool_input":{"file_path":"a.go"}}`,
		`{"tool_name":"Edit","tool_input":{"file_path":"a.go"},"permission_suggestions":[]}`,
		`{"tool_name":"Edit","tool_input":{"file_path":"a.go"},"permission_suggestions":null}`,
	} {
		got, err := parsePermissionRequest([]byte(body))
		if err != nil {
			t.Fatalf("parse %s: %v", body, err)
		}
		if got.HasSuggestions {
			t.Fatalf("HasSuggestions = true for %s", body)
		}
	}
}

// claude raises a permission request for its question dialog, then reports the answered call's PostToolUse with
// answers and annotations added to the input; the keys must still agree, or the request outlives the question
// and the cockpit shows "Allow AskUserQuestion?" once the ask card goes
func TestAskUserQuestionKeySurvivesAnswers(t *testing.T) {
	questions := `{"questions":[{"question":"Proceed?","header":"Go","options":[{"label":"Yes"},{"label":"No"}],"multiSelect":false}]}`
	req, err := parsePermissionRequest([]byte(`{"hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":` + questions + `}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	answered := `{"questions":[{"question":"Proceed?","header":"Go","options":[{"label":"Yes"},{"label":"No"}],"multiSelect":false}],"answers":{"Proceed?":"Yes"},"annotations":{}}`
	_, postKey := hookStatusIdentity(ccHookEvent{HookEventName: "PostToolUse", ToolName: "AskUserQuestion", ToolInput: json.RawMessage(answered)})
	if postKey != req.ToolKey {
		t.Fatalf("PostToolUse key %q != PermissionRequest key %q", postKey, req.ToolKey)
	}
	other := `{"questions":[{"question":"Stop?","header":"Go","options":[{"label":"Yes"}],"multiSelect":false}]}`
	if toolKey("AskUserQuestion", json.RawMessage(other)) == req.ToolKey {
		t.Fatal("another question gave the same key")
	}
}

func TestParsePermissionRequestRejectsBadPayloads(t *testing.T) {
	for _, body := range []string{``, `not json`, `{"tool_input":{"command":"ls"}}`, `{"tool_name":""}`} {
		if _, err := parsePermissionRequest([]byte(body)); err == nil {
			t.Fatalf("parse %q: want an error", body)
		}
	}
}

func TestPermissionCommandRegistered(t *testing.T) {
	found, _, err := rootCmd.Find([]string{"permission"})
	if err != nil || found == nil || found.Name() != "permission" {
		t.Fatalf("permission not registered: found=%v err=%v", found, err)
	}
	if !found.Hidden {
		t.Fatalf("permission must be hidden")
	}
}

// the hooks are installed in the user's global settings, so a claude outside Arc runs them too: there they
// must exit 0 with nothing to do, as agent-hook does, not fail on every prompt
func TestHookCommandsNoOpOutsideArc(t *testing.T) {
	t.Setenv(wshutil.WaveJwtTokenVarName, "")
	run := func(c *cobra.Command) error {
		if c.PreRunE != nil {
			if err := c.PreRunE(c, nil); err != nil {
				return err
			}
		}
		return c.RunE(c, nil)
	}
	if err := run(permissionCmd); err != nil {
		t.Fatalf("permission outside Arc: %v", err)
	}
	if err := run(askCmd); err != nil {
		t.Fatalf("ask outside Arc: %v", err)
	}
	askClear = true
	t.Cleanup(func() { askClear = false })
	if err := run(askCmd); err != nil {
		t.Fatalf("ask --clear outside Arc: %v", err)
	}
	// pi's bridge waits for an answer and must hear that none can come
	askClear, askWait = false, true
	t.Cleanup(func() { askWait = false })
	if err := run(askCmd); err == nil {
		t.Fatal("ask --wait outside Arc succeeded, want an error")
	}
}
