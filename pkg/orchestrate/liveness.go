// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentobserve"
	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// StallThreshold is how long a running child may go without a transcript write before the engine flags
// it stalled. A headless worker writes its session on every token, so silence this long means the
// child is not progressing (provider hang, dead process) — and nothing else ever notices.
const StallThreshold = 15 * time.Minute

// sessionsRootFor resolves a worker runtime's transcript root (a var so tests can point the scan at a
// temp dir). agentsessions owns where every runtime writes, so liveness asks it rather than keeping a
// second copy of those paths.
var sessionsRootFor = agentsessions.SessionRoot

// livenessRuntimes are the worker runtimes whose transcripts read as a heartbeat: an append-only
// JSONL that records its cwd and the spawn prompt, so the file's mtime is progress and the dag marker
// is identity. opencode is deliberately absent — its cwd lives in a session-info file whose prompt is
// in sibling part files the marker never reaches, and whether that file is rewritten as the session
// progresses is unverified; a frozen mtime there would stall healthy children, which is exactly the
// failure this scan exists to prevent.
var livenessRuntimes = map[string]bool{"claude": true, "codex": true, "pi": true}

// defaultWorkerRuntime mirrors runroute.NormalizeLegacy's default: a child run persisted before the
// route carried a runtime ran claude.
const defaultWorkerRuntime = "claude"

// sessionHeaderLine is the union of the ways a worker transcript records its working directory: pi's
// v3 header line and claude's records carry cwd at the top level, codex nests it in the session_meta
// payload. One shape covers all three; a line carrying neither yields "".
type sessionHeaderLine struct {
	Cwd     string `json:"cwd"`
	Payload struct {
		Cwd string `json:"cwd"`
	} `json:"payload"`
}

// maxSessionLineBytes bounds one transcript line the liveness scan will read. An agent writes whole
// tool results as a single JSONL line, so bufio's 64KB default token cap is routinely exceeded — and
// a scan killed by an oversized line reports "marker absent", which flags a perfectly healthy child
// stalled once StallThreshold passes.
const maxSessionLineBytes = 4 << 20

// maxCwdScanLines bounds the search for a transcript's cwd. pi and codex record it on their first
// line, but claude opens with session scaffolding (last-prompt / mode / permission-mode /
// file-history-snapshot) that carries none, so a header-only read never matches a claude child.
const maxCwdScanLines = 50

func sessionScanner(f *os.File) *bufio.Scanner {
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), maxSessionLineBytes)
	return sc
}

// sessionPathCache maps a task's dag session marker to the transcript that matched it, so a
// steady-state tick is one stat instead of a walk of every session opening every .jsonl. The
// cached mtime is trusted only while it is fresher than StallThreshold: at the exact point it could
// produce a stall verdict the full scan runs again, so a resumed session writing a new file is
// picked up rather than mistaken for silence.
var sessionPathCache sync.Map // marker -> path

// lastActivityForRun returns the newest write time of the child's own worker transcript (the
// heartbeat a headless agent actually emits) and whether the child's runtime is observable at all.
// A false second return means there is no activity source: the caller must report freshness unknown
// rather than age a frozen timestamp into a stall, because a wrong stall verdict costs the lead a
// retry that kills live work while a missed one only costs a timeout. When marker is non-empty the
// transcript must also mention it: siblings spawned into the same cwd (non-git projects) would
// otherwise refresh each other's heartbeat.
func lastActivityForRun(run *waveobj.Run, marker string) (int64, bool) {
	if run == nil {
		return 0, false
	}
	runtime := run.Runtime
	if runtime == "" {
		runtime = defaultWorkerRuntime
	}
	if !livenessRuntimes[runtime] {
		return 0, false
	}
	root := sessionsRootFor(runtime)
	if root == "" {
		return 0, false
	}
	// the run's first worker block cwd is the worktree the session was spawned in
	cwd := workerCwd(run)
	if cwd == "" {
		return 0, false
	}
	if ms, ok := cachedActivity(marker); ok {
		return ms, true
	}
	newest, newestPath := scanSessions(scanRoot(runtime, root, cwd), cwd, marker)
	if marker != "" && newestPath != "" {
		sessionPathCache.Store(marker, newestPath)
	}
	return newest, true
}

// scanRoot narrows a runtime's walk when the runtime encodes cwd into its directory layout: claude
// names one projects dir per cwd, so a child's worktree owns a directory and the walk skips every
// other project. That encoding is lossy (agentobserve.SlugifyCwd), so a missing dir falls back to the
// whole root rather than reporting no activity.
func scanRoot(runtime, root, cwd string) string {
	if runtime != "claude" {
		return root
	}
	dir := filepath.Join(root, agentobserve.SlugifyCwd(cwd))
	if st, err := os.Stat(dir); err == nil && st.IsDir() {
		return dir
	}
	return root
}

// scanSessions walks a transcript root for the newest .jsonl whose recorded cwd is the child's
// worktree and whose opening lines mention the task marker. The walk is recursive because the layouts
// differ in depth — codex nests rollouts under date directories, claude and pi sit one level down —
// and the cwd+marker check, not the path, is what identifies a transcript.
func scanSessions(root, cwd, marker string) (int64, string) {
	var newest int64
	var newestPath string
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		if !sessionCwdMatches(path, cwd) {
			return nil
		}
		if marker != "" && !sessionMentions(path, marker) {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		if ms := info.ModTime().UnixMilli(); ms > newest {
			newest, newestPath = ms, path
		}
		return nil
	})
	return newest, newestPath
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

// sessionCwdMatches reports whether a transcript records the worktree the child runs in. Where the
// cwd sits is runtime-specific, so the opening lines are scanned until one yields a cwd rather than
// only the first line being read. A transcript that names none does not match.
func sessionCwdMatches(path, cwd string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	sc := sessionScanner(f)
	for i := 0; i < maxCwdScanLines && sc.Scan(); i++ {
		var h sessionHeaderLine
		if json.Unmarshal(sc.Bytes(), &h) != nil {
			continue
		}
		found := h.Cwd
		if found == "" {
			found = h.Payload.Cwd
		}
		if found == "" {
			continue
		}
		return filepath.Clean(found) == filepath.Clean(cwd)
	}
	return false
}

// dagSessionMarker is embedded at the end of every DAG child's prompt and recorded verbatim in its
// transcript, giving liveness a per-task identity that survives shared cwds (non-git projects spawn
// every sibling into owner.ProjectPath).
func dagSessionMarker(dagOID, taskID string) string {
	return fmt.Sprintf("[wave:dag %s %s]", dagOID, taskID)
}

// sessionMentions scans the opening lines of a transcript for the marker substring. Bounded read:
// the prompt (and therefore the marker) lands in the first user message, never deep in a
// multi-MB transcript. A scan that dies on an unreadable line reports a match rather than a miss:
// the cwd already matched, and cross-refreshing a sibling's heartbeat (only possible when
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

// workerCwd resolves the worktree a run's child session runs in. A DAG-spawned child runs
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
