// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentsessions scans Claude Code transcript JSONL on disk and returns lightweight,
// resumable per-session metadata for the Agent-tab "No terminal running" hero. Sibling to
// pkg/usagestats (which scans the same files for token buckets). The session id is the JSONL
// filename stem — the key for `claude --resume <id>`.
package agentsessions

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

const (
	defaultWindowDays = 14
	defaultLimit      = 20
	maxTaskLen        = 120
)

// SessionInfo is one resumable past Claude session.
type SessionInfo struct {
	ID           string // filename stem = the `claude --resume` key
	Runtime      string // "claude"
	ProjectPath  string // cwd
	ProjectName  string // last path segment of cwd
	Branch       string
	Task         string // first human prompt, trimmed
	Model        string // last assistant model seen
	TokensTotal  int
	LastActiveTs int64 // file mtime, UnixMilli
}

type claudeLine struct {
	Type      string `json:"type"`
	Cwd       string `json:"cwd"`
	GitBranch string `json:"gitBranch"`
	Message   struct {
		Model   string          `json:"model"`
		Content json.RawMessage `json:"content"`
		Usage   *struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

// extractClaudeSession folds one transcript file's lines into a SessionInfo. Returns nil when the
// file carries no human prompt (e.g. a subagent/tool-only file) — those aren't useful to resume.
func extractClaudeSession(id string, lines []string) *SessionInfo {
	s := &SessionInfo{ID: id, Runtime: "claude"}
	hasTask := false
	for _, line := range lines {
		var rec claudeLine
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			continue
		}
		if s.ProjectPath == "" && rec.Cwd != "" {
			s.ProjectPath = rec.Cwd
			s.ProjectName = filepath.Base(rec.Cwd)
		}
		if s.Branch == "" && rec.GitBranch != "" {
			s.Branch = rec.GitBranch
		}
		if rec.Message.Model != "" {
			s.Model = rec.Message.Model // last assistant model wins
		}
		if rec.Message.Usage != nil {
			u := rec.Message.Usage
			s.TokensTotal += u.InputTokens + u.OutputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
		}
		if !hasTask && rec.Type == "user" {
			if txt := stringContent(rec.Message.Content); txt != "" {
				s.Task = trimTo(txt, maxTaskLen)
				hasTask = true
			}
		}
	}
	if !hasTask {
		return nil
	}
	return s
}

// stringContent returns trimmed text when message.content is a plain string (a human prompt).
// Returns "" for array content (tool results) or anything else.
func stringContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		return strings.TrimSpace(str)
	}
	return ""
}

func trimTo(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return strings.TrimSpace(s[:max]) + "…"
}

// readLines reads non-blank lines from a transcript file. A package var so tests can assert
// scanRoot's read-count invariant (only the newest candidates' content is read).
var readLines = func(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var lines []string
	for _, ln := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(ln) != "" {
			lines = append(lines, ln)
		}
	}
	return lines
}

// scanRoot returns up to `limit` resumable sessions from a Claude projects root, newest-first. It
// stats every *.jsonl (cheap dirent metadata, no content read) to rank by mtime, then reads CONTENT
// only for the newest candidates — just enough to fill `limit` valid sessions. So surfacing 5 rows
// never costs reading all (hundreds of) transcripts. Unexported so tests can target a fixture dir.
func scanRoot(root string, windowDays, limit int) []SessionInfo {
	var cutoff time.Time
	if windowDays > 0 {
		cutoff = time.Now().AddDate(0, 0, -windowDays-1)
	}
	type candidate struct {
		path  string
		name  string
		mtime time.Time
	}
	var cands []candidate
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return nil
		}
		if !cutoff.IsZero() && info.ModTime().Before(cutoff) {
			return nil
		}
		cands = append(cands, candidate{path: path, name: d.Name(), mtime: info.ModTime()})
		return nil
	})
	sort.Slice(cands, func(i, j int) bool { return cands[i].mtime.After(cands[j].mtime) })

	// read newest-first, parsing only enough files to reach `limit` valid sessions (nil = a
	// subagent/tool-only file with no human prompt, which we skip and read one more).
	var out []SessionInfo
	for _, c := range cands {
		if limit > 0 && len(out) >= limit {
			break
		}
		s := extractClaudeSession(strings.TrimSuffix(c.name, ".jsonl"), readLines(c.path))
		if s == nil {
			continue
		}
		s.LastActiveTs = c.mtime.UnixMilli()
		out = append(out, *s)
	}
	return out
}

// ScanSessions lists recent resumable Claude sessions from ~/.claude/projects. windowDays<=0 and
// limit<=0 fall back to the package defaults.
func ScanSessions(windowDays, limit int) ([]SessionInfo, error) {
	if windowDays <= 0 {
		windowDays = defaultWindowDays
	}
	if limit <= 0 {
		limit = defaultLimit
	}
	root := filepath.Join(wavebase.GetHomeDir(), ".claude", "projects")
	return scanRoot(root, windowDays, limit), nil
}
