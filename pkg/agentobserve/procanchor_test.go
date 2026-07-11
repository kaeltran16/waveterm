// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentobserve

import "testing"

func TestBlockIDFromEnv(t *testing.T) {
	env := []string{"PATH=/bin", "WAVETERM_BLOCKID=df9292f9-1234", "HOME=/root"}
	if got := blockIDFromEnv(env); got != "df9292f9-1234" {
		t.Fatalf("blockIDFromEnv = %q", got)
	}
	if got := blockIDFromEnv([]string{"PATH=/bin"}); got != "" {
		t.Fatalf("blockIDFromEnv(none) = %q, want empty", got)
	}
}

func TestIsHelperCmdline(t *testing.T) {
	if !isHelperCmdline(`"C:\...\claude.exe" --chrome-native-host`) {
		t.Fatal("chrome-native-host should be a helper")
	}
	if isHelperCmdline(`"C:\...\claude.exe" --dangerously-skip-permissions "goal"`) {
		t.Fatal("a real agent invocation is not a helper")
	}
}

func TestNormalizeBlockID(t *testing.T) {
	if NormalizeBlockID("block:abc") != "abc" {
		t.Fatal("should strip block: prefix")
	}
	if NormalizeBlockID("abc") != "abc" {
		t.Fatal("bare uuid unchanged")
	}
}

func TestIsClaudeProc(t *testing.T) {
	for _, n := range []string{"claude", "claude.exe", "Claude.exe", "CLAUDE"} {
		if !isClaudeProc(n) {
			t.Fatalf("%q should be claude", n)
		}
	}
	for _, n := range []string{"node", "node.exe", "claudia"} {
		if isClaudeProc(n) {
			t.Fatalf("%q should not be claude", n)
		}
	}
}
