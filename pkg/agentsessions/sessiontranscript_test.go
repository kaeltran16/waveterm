// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agentobserve"
)

// a worker launched with --session-id writes a transcript named by that id, so the lookup opens it by
// name and never hands back a sibling session that shares the cwd.
func TestTranscriptForSession(t *testing.T) {
	const (
		own       = "0b6f7c1e-4d2a-4f3b-9c8d-1a2b3c4d5e6f"
		sibling   = "5d1c2b3a-6e7f-4a8b-9c0d-1e2f3a4b5c6d"
		elsewhere = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
	)
	cwd := filepath.Join(t.TempDir(), "wt-t-1")
	claudeRoot, piRoot := t.TempDir(), t.TempDir()
	claudeOwn := touchTranscript(t, filepath.Join(claudeRoot, agentobserve.SlugifyCwd(cwd), own+".jsonl"))
	touchTranscript(t, filepath.Join(claudeRoot, agentobserve.SlugifyCwd(cwd), sibling+".jsonl"))
	// SlugifyCwd is lossy, so claude's projects dir for a cwd is not always the one it computes
	claudeElsewhere := touchTranscript(t, filepath.Join(claudeRoot, "another-slug", elsewhere+".jsonl"))
	piOwn := touchTranscript(t, filepath.Join(piRoot, "--wt-t-1--", "2026-09-15T03-10-10-831Z_"+own+".jsonl"))
	touchTranscript(t, filepath.Join(piRoot, "--wt-t-1--", "2026-09-15T03-11-00-000Z_"+sibling+".jsonl"))

	cases := []struct {
		name, root, runtime, session, want string
	}{
		{"claude, named in the cwd's projects dir", claudeRoot, "claude", own, claudeOwn},
		{"claude, in another projects dir", claudeRoot, "claude", elsewhere, claudeElsewhere},
		{"pi, the id after the timestamp", piRoot, "pi", own, piOwn},
		{"not written yet", piRoot, "pi", elsewhere, ""},
		{"no session id", claudeRoot, "claude", "", ""},
		{"no root", "", "claude", own, ""},
		{"runtime without a session reader", claudeRoot, "codex", own, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := TranscriptForSession(tc.root, tc.runtime, cwd, tc.session); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func touchTranscript(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}
