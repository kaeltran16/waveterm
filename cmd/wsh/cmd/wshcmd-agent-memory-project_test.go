// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"
)

func TestResolveProjectCwd(t *testing.T) {
	tests := []struct {
		name    string
		flagCwd string
		inject  bool
		stdin   string
		want    string
	}{
		// the pi extension's path: flag wins and stdin is never touched
		{"flag wins", "/repo", false, "", "/repo"},
		{"flag wins over stdin", "/repo", true, `{"cwd":"/other"}`, "/repo"},
		// the claude SessionStart hook's path: no flag, cwd arrives on stdin
		{"stdin fallback when injecting", "", true, `{"cwd":"/from/hook","hook_event_name":"SessionStart"}`, "/from/hook"},
		// the regression this guards: no flag, no stdin read => the hook no-ops every session
		{"no flag and not injecting reads nothing", "", false, `{"cwd":"/from/hook"}`, ""},
		{"malformed stdin is not fatal", "", true, "not json", ""},
		{"empty stdin", "", true, "", ""},
		{"payload without cwd", "", true, `{"hook_event_name":"SessionStart"}`, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveProjectCwd(tt.flagCwd, tt.inject, strings.NewReader(tt.stdin)); got != tt.want {
				t.Fatalf("resolveProjectCwd(%q, %v, %q) = %q, want %q", tt.flagCwd, tt.inject, tt.stdin, got, tt.want)
			}
		})
	}
}
