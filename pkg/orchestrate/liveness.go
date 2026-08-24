// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// StallThreshold is how long a running child may go without a transcript write before the engine flags
// it stalled. A headless worker writes its pi session on every token, so silence this long means the
// child is not progressing (provider hang, dead process) — and nothing else ever notices.
const StallThreshold = 15 * time.Minute

// piSessionsRoot is the pi agent session storage root (overridable in tests). Mirrors the root the
// agentsessions package scans (`<home>/.pi/agent/sessions`).
var piSessionsRoot = func() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".pi", "agent", "sessions")
}

// piSessionHeader is the v3 session header line's shape — only cwd is needed for liveness matching.
type piSessionHeader struct {
	Cwd string `json:"cwd"`
}

// lastActivityForRun returns the newest write time of the run's worker pi sessions (the child's
// transcript file mtimes — the heartbeat a headless agent actually emits), or 0 when no session
// matches. Only the first line of each candidate file is read (the v3 header carries cwd), so a tick
// is stat+header-cheap even for multi-MB sessions. When marker is non-empty the session must also
// mention it in its first lines: siblings spawned into the same cwd (non-git projects) would
// otherwise refresh each other's heartbeat.
func lastActivityForRun(run *waveobj.Run, marker string) int64 {
	if run == nil {
		return 0
	}
	root := piSessionsRoot()
	if root == "" {
		return 0
	}
	// the run's first worker block cwd is the worktree the pi session was spawned in
	cwd := workerCwd(run)
	if cwd == "" {
		return 0
	}
	var newest int64
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		sessDir := filepath.Join(root, e.Name())
		files, ferr := os.ReadDir(sessDir)
		if ferr != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			if !headerCwdMatches(filepath.Join(sessDir, f.Name()), cwd) {
				continue
			}
			if marker != "" && !sessionMentions(filepath.Join(sessDir, f.Name()), marker) {
				continue
			}
			if info, ierr := f.Info(); ierr == nil {
				ms := info.ModTime().UnixMilli()
				if ms > newest {
					newest = ms
				}
			}
		}
	}
	return newest
}

// headerCwdMatches reads the first line of a pi session file and reports whether its cwd equals the
// worktree the child runs in. A malformed/empty header simply does not match.
func headerCwdMatches(path, cwd string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		return false
	}
	var h piSessionHeader
	if json.Unmarshal(sc.Bytes(), &h) != nil || h.Cwd == "" {
		return false
	}
	return filepath.Clean(h.Cwd) == filepath.Clean(cwd)
}

// dagSessionMarker is embedded at the end of every DAG child's prompt and recorded verbatim in its
// transcript, giving liveness a per-task identity that survives shared cwds (non-git projects spawn
// every sibling into owner.ProjectPath).
func dagSessionMarker(dagOID, taskID string) string {
	return fmt.Sprintf("[wave:dag %s %s]", dagOID, taskID)
}

// sessionMentions scans the opening lines of a pi session for the marker substring. Bounded read:
// the prompt (and therefore the marker) lands in the first user message, never deep in a
// multi-MB transcript.
func sessionMentions(path, marker string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for i := 0; i < 200 && sc.Scan(); i++ {
		if strings.Contains(sc.Text(), marker) {
			return true
		}
	}
	return false
}

// workerCwd resolves the worktree a run's child pi session runs in. A DAG-spawned child runs
// directly in run.ProjectPath (its worktree) and never populates phase workerorefs, so that short-
// circuits. Regular runs resolve the first worker block's cwd. Empty when unresolvable.
func workerCwd(run *waveobj.Run) string {
	if run.DagORef != "" && run.ProjectPath != "" {
		return run.ProjectPath
	}
	for _, p := range run.Phases {
		for _, oref := range p.WorkerOrefs {
			if !strings.HasPrefix(oref, "tab:") {
				continue
			}
			tab, err := wstore.DBMustGet[*waveobj.Tab](context.Background(), strings.TrimPrefix(oref, "tab:"))
			if err != nil || len(tab.BlockIds) == 0 {
				continue
			}
			block, berr := wstore.DBMustGet[*waveobj.Block](context.Background(), tab.BlockIds[0])
			if berr != nil {
				continue
			}
			cwd := block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
			if cwd == "" {
				cwd = block.Meta.GetString(waveobj.MetaKey_File, "")
			}
			if cwd != "" {
				return cwd
			}
		}
	}
	return ""
}
