// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentsessions scans agent transcript JSONL on disk and returns lightweight,
// resumable per-session metadata for the Agent surfaces. Sibling to pkg/usagestats
// (which scans Claude files for token buckets).
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

// SessionInfo is one resumable past agent session.
type SessionInfo struct {
	ID            string // runtime resume key
	Runtime       string // "claude" | "codex"
	ProjectPath   string // cwd
	ProjectName   string // last path segment of cwd
	Branch        string
	Task          string // first human prompt, trimmed
	Model         string // last assistant model seen
	TokensTotal   int
	LastActiveTs  int64  // file mtime, UnixMilli
	ResumeCommand string // runtime resume invocation; empty means not resumable
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
// file carries no human prompt (e.g. a subagent/tool-only file) because those aren't useful to resume.
func extractClaudeSession(id string, lines []string) *SessionInfo {
	s := &SessionInfo{ID: id}
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

type codexLine struct {
	Type    string `json:"type"`
	Payload struct {
		Type      string `json:"type"`
		SessionID string `json:"session_id"`
		Cwd       string `json:"cwd"`
		Model     string `json:"model"`
		Message   string `json:"message"`
		Git       struct {
			Branch string `json:"branch"`
		} `json:"git"`
	} `json:"payload"`
}

// extractCodexSession folds one Codex rollout file into a SessionInfo. The resume key is
// session_meta.session_id, not the filename stem. The task is the first event_msg/user_message.
func extractCodexSession(_ string, lines []string) *SessionInfo {
	s := &SessionInfo{}
	model := "codex"
	hasTask := false
	for _, line := range lines {
		var rec codexLine
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			continue
		}
		switch rec.Type {
		case "session_meta":
			if rec.Payload.SessionID != "" {
				s.ID = rec.Payload.SessionID
			}
			if rec.Payload.Cwd != "" {
				s.ProjectPath = rec.Payload.Cwd
				s.ProjectName = filepath.Base(rec.Payload.Cwd)
			}
			if rec.Payload.Git.Branch != "" {
				s.Branch = rec.Payload.Git.Branch
			}
		case "turn_context":
			if rec.Payload.Model != "" {
				model = rec.Payload.Model // last turn_context model wins
			}
		case "event_msg":
			if rec.Payload.Type == "user_message" && !hasTask {
				if txt := strings.TrimSpace(rec.Payload.Message); txt != "" {
					s.Task = trimTo(txt, maxTaskLen)
					hasTask = true
				}
			}
		}
	}
	s.Model = model
	if s.ID == "" || !hasTask {
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
// scanProvider's read-count invariant (only the newest candidates' content is read).
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

type provider struct {
	runtime   string
	root      string
	matches   func(name string) bool
	extract   func(stem string, lines []string) *SessionInfo
	resumeCmd func(s *SessionInfo) string
}

func claudeProvider(root string) provider {
	return provider{
		runtime:   "claude",
		root:      root,
		matches:   func(name string) bool { return strings.HasSuffix(name, ".jsonl") },
		extract:   extractClaudeSession,
		resumeCmd: func(s *SessionInfo) string { return "claude --resume " + s.ID },
	}
}

func codexProvider(root string) provider {
	return provider{
		runtime: "codex",
		root:    root,
		matches: func(name string) bool {
			return strings.HasPrefix(name, "rollout-") && strings.HasSuffix(name, ".jsonl")
		},
		extract:   extractCodexSession,
		resumeCmd: func(s *SessionInfo) string { return "codex resume " + s.ID },
	}
}

// scanProvider returns up to limit sessions from one provider's root, newest-first. It reads
// content only for the newest candidates, just enough to fill limit valid sessions.
func scanProvider(p provider, windowDays, limit int) []SessionInfo {
	var cutoff time.Time
	if windowDays > 0 {
		cutoff = time.Now().AddDate(0, 0, -windowDays-1)
	}
	type candidate struct {
		path  string
		stem  string
		mtime time.Time
	}
	var cands []candidate
	_ = filepath.WalkDir(p.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !p.matches(d.Name()) {
			return nil
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return nil
		}
		if !cutoff.IsZero() && info.ModTime().Before(cutoff) {
			return nil
		}
		cands = append(cands, candidate{path: path, stem: strings.TrimSuffix(d.Name(), ".jsonl"), mtime: info.ModTime()})
		return nil
	})
	sort.Slice(cands, func(i, j int) bool { return cands[i].mtime.After(cands[j].mtime) })

	var out []SessionInfo
	for _, c := range cands {
		if limit > 0 && len(out) >= limit {
			break
		}
		s := p.extract(c.stem, readLines(c.path))
		if s == nil {
			continue
		}
		s.Runtime = p.runtime
		s.LastActiveTs = c.mtime.UnixMilli()
		s.ResumeCommand = p.resumeCmd(s)
		out = append(out, *s)
	}
	return out
}

// ScanSessions lists recent resumable sessions across runtime providers, newest-first.
// windowDays<=0 and limit<=0 fall back to the package defaults.
func ScanSessions(windowDays, limit int) ([]SessionInfo, error) {
	if windowDays <= 0 {
		windowDays = defaultWindowDays
	}
	if limit <= 0 {
		limit = defaultLimit
	}
	home := wavebase.GetHomeDir()
	providers := []provider{
		claudeProvider(filepath.Join(home, ".claude", "projects")),
		codexProvider(filepath.Join(home, ".codex", "sessions")),
	}
	var all []SessionInfo
	for _, p := range providers {
		all = append(all, scanProvider(p, windowDays, limit)...)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].LastActiveTs > all[j].LastActiveTs })
	if limit > 0 && len(all) > limit {
		all = all[:limit]
	}
	return all, nil
}
