// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentobserve

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// candidate is one transcript file under a project dir, with the fields discovery ranks on.
type candidate struct {
	Path    string
	Cwd     string
	ModTime time.Time
	StartMs int64 // session-start (first-record timestamp), 0 if unknown
}

// Resolution is the outcome of discovery for one block: the chosen transcript, how it was chosen, and
// how many transcripts in the dir shared the block's cwd. MatchCount > 1 means the cwd alone was
// ambiguous — the create-time tiebreaker had to disambiguate — which the pilot records as a metric
// (this is exactly the case the hook resolves for free).
type Resolution struct {
	Path       string `json:"path,omitempty"`
	MatchCount int    `json:"matchcount"`
	Method     string `json:"method"` // "createtime" | "mtime" | "none"
}

// sameCwd reports whether two working directories are the same location. Paths are cleaned and
// compared case-insensitively — the pilot is Windows-only, where the filesystem is case-insensitive
// and Claude Code may record a differently-cased drive/segment than the block reports.
func sameCwd(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

// pickActive chooses the transcript for blockCwd from the candidates. Among those whose in-record cwd
// matches (guarding the lossy slug): if aroundMs > 0 (the agent's process create time), pick the
// session whose start is closest to it — this separates concurrent agents that share a cwd, which
// mtime alone cannot. Otherwise fall back to the most recently modified. Also reports the match count
// (ambiguity) and which method decided it.
func pickActive(cands []candidate, blockCwd string, aroundMs int64) Resolution {
	var matches []candidate
	for _, c := range cands {
		if c.Cwd != "" && sameCwd(c.Cwd, blockCwd) {
			matches = append(matches, c)
		}
	}
	res := Resolution{MatchCount: len(matches), Method: "none"}
	if len(matches) == 0 {
		return res
	}
	if aroundMs > 0 {
		best := matches[0]
		bestDelta := absInt64(best.StartMs - aroundMs)
		for _, c := range matches[1:] {
			if d := absInt64(c.StartMs - aroundMs); d < bestDelta {
				best, bestDelta = c, d
			}
		}
		// StartMs==0 means we couldn't read a session start; only trust create-time correlation when
		// the winner actually had one, else fall through to mtime.
		if best.StartMs > 0 {
			return Resolution{Path: best.Path, MatchCount: len(matches), Method: "createtime"}
		}
	}
	best := matches[0]
	for _, c := range matches[1:] {
		if c.ModTime.After(best.ModTime) {
			best = c
		}
	}
	return Resolution{Path: best.Path, MatchCount: len(matches), Method: "mtime"}
}

func absInt64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// transcriptHead returns the `cwd` and session-start (first record's `timestamp`, as ms epoch) by
// scanning the transcript head. cwd is the first non-empty cwd found; startMs is parsed from the
// first record that carries an RFC3339 timestamp. Reading only the head keeps this cheap. Any error
// or absence yields zero values.
func transcriptHead(path string) (cwd string, startMs int64) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 8*1024*1024) // transcript lines can be large
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var rec struct {
			Cwd       string `json:"cwd"`
			Timestamp string `json:"timestamp"`
		}
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		if cwd == "" && rec.Cwd != "" {
			cwd = rec.Cwd
		}
		if startMs == 0 && rec.Timestamp != "" {
			if ts, perr := time.Parse(time.RFC3339, rec.Timestamp); perr == nil {
				startMs = ts.UnixMilli()
			}
		}
		if cwd != "" && startMs != 0 {
			break
		}
	}
	return cwd, startMs
}

// listCandidates enumerates the *.jsonl transcripts directly under dir with their cwd and mtime.
// A missing dir yields no candidates (not an error).
func listCandidates(dir string) []candidate {
	matches, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if err != nil {
		return nil
	}
	cands := make([]candidate, 0, len(matches))
	for _, p := range matches {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		cwd, startMs := transcriptHead(p)
		cands = append(cands, candidate{Path: p, Cwd: cwd, ModTime: st.ModTime(), StartMs: startMs})
	}
	return cands
}

// Resolve maps a block (identified by its working directory and its agent process's create time) to
// its transcript — no hook required. It narrows to the Claude projects dir via the slug, then picks
// the session re-validated against the transcript's own cwd field, disambiguating concurrent
// same-cwd agents by create-time proximity. createMs<=0 disables the tiebreaker (mtime is used).
func Resolve(projectsRoot, blockCwd string, createMs int64) Resolution {
	// Clean first: a process Cwd may carry a trailing separator (observed on Windows), which would
	// slugify to a spurious trailing '-' and miss the directory.
	blockCwd = filepath.Clean(blockCwd)
	dir := filepath.Join(projectsRoot, SlugifyCwd(blockCwd))
	return pickActive(listCandidates(dir), blockCwd, createMs)
}

// ActiveTranscript is the cwd-only convenience form (no create-time tiebreaker): returns just the
// resolved path, or "" when nothing correlates.
func ActiveTranscript(projectsRoot, blockCwd string) string {
	return Resolve(projectsRoot, blockCwd, 0).Path
}
