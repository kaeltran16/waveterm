// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"regexp"
	"testing"
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
