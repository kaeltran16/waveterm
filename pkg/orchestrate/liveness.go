// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

// maxSessionLineBytes bounds one transcript line the liveness scan will read. pi writes whole tool
// results as a single JSONL line, so bufio's 64KB default token cap is routinely exceeded — and a
// scan killed by an oversized line reports "marker absent", which flags a perfectly healthy child
// stalled once StallThreshold passes.
const maxSessionLineBytes = 4 << 20

func sessionScanner(f *os.File) *bufio.Scanner {
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), maxSessionLineBytes)
	return sc
}

// sessionPathCache maps a task's dag session marker to the transcript that matched it, so a
// steady-state tick is one stat instead of a walk of every pi session opening every .jsonl. The
// cached mtime is trusted only while it is fresher than StallThreshold: at the exact point it could
// produce a stall verdict the full scan runs again, so a resumed session writing a new file is
// picked up rather than mistaken for silence.
var sessionPathCache sync.Map // marker -> path

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
	if ms, ok := cachedActivity(marker); ok {
		return ms
	}
	var newest int64
	var newestPath string
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
			path := filepath.Join(sessDir, f.Name())
			if !headerCwdMatches(path, cwd) {
				continue
			}
			if marker != "" && !sessionMentions(path, marker) {
				continue
			}
			if info, ierr := f.Info(); ierr == nil {
				ms := info.ModTime().UnixMilli()
				if ms > newest {
					newest = ms
					newestPath = path
				}
			}
		}
	}
	if marker != "" && newestPath != "" {
		sessionPathCache.Store(marker, newestPath)
	}
	return newest
}

// cachedActivity returns the cached transcript's mtime when it is recent enough to be conclusive.
// A cached file that has gone quiet past the threshold, or vanished, falls through to a full scan
// so the stall verdict is never made on a stale cache entry.
func cachedActivity(marker string) (int64, bool) {
	if marker == "" {
		return 0, false
	}
	v, ok := sessionPathCache.Load(marker)
	if !ok {
		return 0, false
	}
	info, err := os.Stat(v.(string))
	if err != nil {
		sessionPathCache.Delete(marker)
		return 0, false
	}
	if time.Since(info.ModTime()) >= StallThreshold {
		return 0, false
	}
	return info.ModTime().UnixMilli(), true
}

// headerCwdMatches reads the first line of a pi session file and reports whether its cwd equals the
// worktree the child runs in. A malformed/empty header simply does not match.
func headerCwdMatches(path, cwd string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	sc := sessionScanner(f)
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
// multi-MB transcript. A scan that dies on an unreadable line reports a match rather than a miss:
// the header cwd already matched, and cross-refreshing a sibling's heartbeat (only possible when
// several children share one cwd, i.e. non-git projects) is a far cheaper wrong answer than
// declaring a live child stalled.
func sessionMentions(path, marker string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	sc := sessionScanner(f)
	for i := 0; i < 200 && sc.Scan(); i++ {
		if strings.Contains(sc.Text(), marker) {
			return true
		}
	}
	if serr := sc.Err(); serr != nil {
		log.Printf("liveness scan %s: %v", path, serr)
		return true
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
