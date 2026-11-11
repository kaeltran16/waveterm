// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentobserve

import (
	"io"
	"os"
	"os/exec"
	"testing"
)

// a test binary started with this set blocks on stdin instead of running tests, so a test can read the
// environment of a live process it started
const helperEnvVar = "AGENTOBSERVE_TEST_HELPER"

func TestMain(m *testing.M) {
	if os.Getenv(helperEnvVar) == "1" {
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// startHelper starts a live process with the test's environment plus extra, stopped at cleanup.
func startHelper(t *testing.T, extra ...string) int32 {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(append(os.Environ(), helperEnvVar+"=1"), extra...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = stdin.Close()
		_ = cmd.Wait()
	})
	return int32(cmd.Process.Pid)
}

func TestNestedClaude(t *testing.T) {
	// the test itself may run inside a claude session, which sets CLAUDE_PID for it
	t.Setenv("CLAUDE_PID", "")
	os.Unsetenv("CLAUDE_PID")
	if !NestedClaude(startHelper(t, "CLAUDE_PID=4242")) {
		t.Fatal("a process started by another claude (CLAUDE_PID inherited) should be nested")
	}
	if NestedClaude(startHelper(t)) {
		t.Fatal("a process with no CLAUDE_PID should not be nested")
	}
	if NestedClaude(startHelper(t, "CLAUDE_PID=")) {
		t.Fatal("an empty CLAUDE_PID names no outer claude")
	}
	if NestedClaude(-1) {
		t.Fatal("a pid that cannot be read should not be nested")
	}
}

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
