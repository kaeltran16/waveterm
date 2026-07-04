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
