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
		stdin   string
		want    string
	}{
		// the pi extension's path: flag wins and stdin is never touched
		{"flag wins", "/repo", "", "/repo"},
		{"flag wins over stdin", "/repo", `{"cwd":"/other"}`, "/repo"},
		// the claude SessionStart hook's path: no flag, cwd arrives on stdin
		{"stdin fallback", "", `{"cwd":"/from/hook","hook_event_name":"SessionStart"}`, "/from/hook"},
		{"malformed stdin is not fatal", "", "not json", ""},
		{"empty stdin", "", "", ""},
		{"payload without cwd", "", `{"hook_event_name":"SessionStart"}`, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveProjectCwd(tt.flagCwd, strings.NewReader(tt.stdin)); got != tt.want {
				t.Fatalf("resolveProjectCwd(%q, %q) = %q, want %q", tt.flagCwd, tt.stdin, got, tt.want)
			}
		})
	}
}

// the manifest is gone, but a settings.json written before it was removed still names --inject, and
// that file is only rewritten on the next install-agent-hooks: the flag has to keep parsing or every
// session start in between hard-errors on an unknown flag.
func TestInjectFlagStillParsesAsANoOp(t *testing.T) {
	defer func() { agentMemoryProjectInject = false }()
	if agentMemoryProjectCmd.Flags().Lookup("inject") == nil {
		t.Fatal("--inject must stay registered for hooks an older build wrote")
	}
	if err := agentMemoryProjectCmd.Flags().Parse([]string{"--inject"}); err != nil {
		t.Fatalf("parsing --inject: %v", err)
	}
	// nothing is emitted for it: with no cwd from either source the command is a no-op
	if got := resolveProjectCwd("", strings.NewReader("")); got != "" {
		t.Fatalf("no cwd should resolve to empty, got %q", got)
	}
}
