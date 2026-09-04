// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentobserve"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// DAG-spawned children run directly in their worktree (run.ProjectPath) and never
// populate phase workerorefs — workerCwd must resolve via ProjectPath for them,
// otherwise the liveness probe finds no session and flags active children stalled.
func TestWorkerCwdResolvesDagChildWorktree(t *testing.T) {
	run := &waveobj.Run{
		DagORef:     "dag:8eb04fc3-eddc-47ff-a518-f03319d03d7f",
		ProjectPath: `C:\Users\cktra\Projects\waveterm\.waveterm\worktrees\847eb8a7-77f2-4bb4-a78c-92a5a914a8de-t-ev-1`,
	}
	got := workerCwd(run)
	if got != run.ProjectPath {
		t.Fatalf("dag child: want %q, got %q", run.ProjectPath, got)
	}
}

// writeClaudeSession writes a fake claude transcript under root at the projects dir claude derives
// from cwd. The opening lines mirror a real file: session scaffolding (last-prompt / mode /
// permission-mode / file-history-snapshot) carrying no cwd at all, with the first cwd and the spawn
// prompt arriving only on the user record.
func writeClaudeSession(t *testing.T, root, cwd, id, prompt string, mtime time.Time) string {
	t.Helper()
	dir := filepath.Join(root, agentobserve.SlugifyCwd(cwd))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	lines := []string{
		`{"type":"last-prompt","sessionId":"` + id + `"}`,
		`{"type":"mode","mode":"normal"}`,
		`{"type":"permission-mode","permissionMode":"bypassPermissions"}`,
		`{"type":"file-history-snapshot","messageId":"m1"}`,
	}
	rec, err := json.Marshal(map[string]any{
		"type":       "user",
		"cwd":        cwd,
		"entrypoint": "cli",
		"message":    map[string]string{"role": "user", "content": prompt},
	})
	if err != nil {
		t.Fatal(err)
	}
	lines = append(lines, string(rec))
	path := filepath.Join(dir, id+".jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	return path
}

// writeCodexSession writes a fake codex rollout under root's date-nested layout: the cwd lives in the
// session_meta payload and the prompt arrives as a later event_msg.
func writeCodexSession(t *testing.T, root, cwd, id, prompt string, mtime time.Time) string {
	t.Helper()
	dir := filepath.Join(root, "2026", "09", "04")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	meta, err := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]any{"id": id, "cwd": cwd}})
	if err != nil {
		t.Fatal(err)
	}
	msg, err := json.Marshal(map[string]any{"type": "event_msg", "payload": map[string]any{"type": "user_message", "message": prompt}})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rollout-2026-09-04T00-00-00-"+id+".jsonl")
	if err := os.WriteFile(path, []byte(string(meta)+"\n"+string(msg)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	return path
}

// A claude child writes no pi session, so the pi-only scan reported no activity and the engine flagged
// every one of them stalled at the threshold. Its own transcript is the heartbeat.
func TestLastActivityTracksClaudeChild(t *testing.T) {
	root := t.TempDir()
	prev := sessionsRootFor
	sessionsRootFor = func(runtime string) string {
		if runtime != "claude" {
			t.Fatalf("claude child probed runtime %q", runtime)
		}
		return root
	}
	defer func() { sessionsRootFor = prev }()

	worktree := filepath.Join(t.TempDir(), "wt-t-0")
	marker := dagSessionMarker("dag-1", "t-0")
	fresh := time.Now().Add(-1 * time.Minute)
	writeClaudeSession(t, root, worktree, "sess-1", "Goal: do the thing\n\n"+marker, fresh)

	run := &waveobj.Run{Runtime: "claude", DagORef: "dag-1", ProjectPath: worktree}
	got, tracked := lastActivityForRun(run, marker)
	if !tracked {
		t.Fatal("claude must be a tracked runtime")
	}
	if got != fresh.UnixMilli() {
		t.Fatalf("want claude transcript mtime %d, got %d", fresh.UnixMilli(), got)
	}
	if got, _ := lastActivityForRun(run, dagSessionMarker("dag-1", "t-9")); got != 0 {
		t.Fatalf("a sibling task's marker must not match this transcript, got %d", got)
	}
}

// codex nests rollouts under date dirs and puts cwd in the session_meta payload, so neither the
// two-level walk nor the top-level-cwd header read the pi scan used would find it.
func TestLastActivityTracksCodexChild(t *testing.T) {
	root := t.TempDir()
	prev := sessionsRootFor
	sessionsRootFor = func(string) string { return root }
	defer func() { sessionsRootFor = prev }()

	worktree := filepath.Join(t.TempDir(), "wt-t-1")
	marker := dagSessionMarker("dag-1", "t-1")
	fresh := time.Now().Add(-2 * time.Minute)
	writeCodexSession(t, root, worktree, "sess-2", "Goal: do the thing\n\n"+marker, fresh)
	// a rollout for another cwd carrying the same marker must not count as this child's heartbeat
	writeCodexSession(t, root, filepath.Join(t.TempDir(), "elsewhere"), "sess-3", "other\n\n"+marker, time.Now())

	run := &waveobj.Run{Runtime: "codex", DagORef: "dag-1", ProjectPath: worktree}
	got, tracked := lastActivityForRun(run, marker)
	if !tracked {
		t.Fatal("codex must be a tracked runtime")
	}
	if got != fresh.UnixMilli() {
		t.Fatalf("want codex rollout mtime %d, got %d", fresh.UnixMilli(), got)
	}
}

// A runtime whose transcripts liveness cannot read must report untracked, never a frozen timestamp:
// the caller's stall verdict is what kills a healthy child.
func TestLastActivityUntrackedRuntimes(t *testing.T) {
	prev := sessionsRootFor
	sessionsRootFor = func(string) string { return t.TempDir() }
	defer func() { sessionsRootFor = prev }()

	for _, rt := range []string{"opencode", "gemini"} {
		run := &waveobj.Run{Runtime: rt, DagORef: "dag-1", ProjectPath: t.TempDir()}
		got, tracked := lastActivityForRun(run, dagSessionMarker("dag-1", "t-0"))
		if tracked || got != 0 {
			t.Fatalf("runtime %q: want (0,false), got (%d,%v)", rt, got, tracked)
		}
	}
	// an unresolvable cwd is equally unobservable
	if got, tracked := lastActivityForRun(&waveobj.Run{Runtime: "claude"}, "m"); tracked || got != 0 {
		t.Fatalf("unresolvable cwd: want (0,false), got (%d,%v)", got, tracked)
	}
}
