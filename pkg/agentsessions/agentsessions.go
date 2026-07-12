// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentsessions scans agent transcript JSONL on disk and returns lightweight,
// resumable per-session metadata for the Agent surfaces. Sibling to pkg/usagestats
// (which scans Claude files for token buckets).
package agentsessions

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
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

	TranscriptPath string // on-disk JSONL path; FE matches this against the live roster
	Status         string // "done" | "failed" | "waiting" (FE overlays "running" for live)
	StartedTs      int64  // first event ts, UnixMilli
	DurationMs     int64  // last event ts - first event ts
	Events         []SessionEvent
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

type claudeEventLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Message   struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type claudeBlock struct {
	Type  string `json:"type"`
	Text  string `json:"text"`
	ID    string `json:"id"`
	Name  string `json:"name"`
	Input struct {
		Command   string `json:"command"`
		Questions []struct {
			Question string `json:"question"`
			Header   string `json:"header"`
		} `json:"questions"`
	} `json:"input"`
	ToolUseID string `json:"tool_use_id"`
	IsError   bool   `json:"is_error"`
}

func askText(b claudeBlock) string {
	if len(b.Input.Questions) > 0 {
		q := b.Input.Questions[0]
		if q.Question != "" {
			return clipText(q.Question)
		}
		if q.Header != "" {
			return clipText(q.Header)
		}
	}
	return "asked a question"
}

// extractClaudeEvents ports frontend/app/view/agents/activityevents.ts:extractClaudeEvents. It does
// NOT gate the synthetic "finished" on liveness (Go can't know the live roster); assembleEvents only
// appends "finished" for done sessions, and the frontend strips it for live ones.
func extractClaudeEvents(lines []string) sessionEvents {
	var raw []SessionEvent
	cmdByID := map[string]string{}
	var firstTs, lastTs int64
	var firstUser, lastAssistant string
	for _, line := range lines {
		var rec claudeEventLine
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		if ts := parseTs(rec.Timestamp); ts > 0 {
			if firstTs == 0 {
				firstTs = ts
			}
			lastTs = ts
		}
		ts := parseTs(rec.Timestamp)
		switch rec.Type {
		case "assistant":
			var blocks []claudeBlock
			if json.Unmarshal(rec.Message.Content, &blocks) != nil {
				continue
			}
			for _, b := range blocks {
				switch b.Type {
				case "text":
					if strings.TrimSpace(b.Text) != "" {
						lastAssistant = b.Text
					}
				case "tool_use":
					cmd := b.Input.Command
					if b.ID != "" {
						if cmd != "" {
							cmdByID[b.ID] = cmd
						} else {
							cmdByID[b.ID] = b.Name
						}
					}
					if b.Name == "AskUserQuestion" {
						raw = append(raw, SessionEvent{Type: "asked", Ts: ts, Text: askText(b)})
					} else if b.Name == "Bash" && commitRe.MatchString(cmd) {
						raw = append(raw, SessionEvent{Type: "committed", Ts: ts, Text: commitSubject(cmd)})
					}
				}
			}
		case "user":
			var str string
			if json.Unmarshal(rec.Message.Content, &str) == nil {
				if firstUser == "" && strings.TrimSpace(str) != "" {
					firstUser = str
				}
				continue
			}
			var blocks []claudeBlock
			if json.Unmarshal(rec.Message.Content, &blocks) != nil {
				continue
			}
			for _, b := range blocks {
				if b.Type == "text" && firstUser == "" && strings.TrimSpace(b.Text) != "" {
					firstUser = b.Text
				}
				if b.Type == "tool_result" && b.IsError && b.ToolUseID != "" {
					cmd := cmdByID[b.ToolUseID]
					if cmd == "" {
						cmd = "a command"
					}
					raw = append(raw, SessionEvent{Type: "errored", Ts: ts, Text: "failed: " + clipText(cmd)})
				}
			}
		}
	}
	startedText := "started session"
	if firstUser != "" {
		startedText = clipText(firstUser)
	}
	finishedText := "finished"
	if lastAssistant != "" {
		finishedText = clipText(lastAssistant)
	}
	return assembleEvents(raw, firstTs, lastTs, startedText, finishedText)
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

type codexEventLine struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp"`
	Payload   json.RawMessage `json:"payload"`
}

type codexPayload struct {
	Type         string          `json:"type"`
	ThreadSource string          `json:"thread_source"`
	Role         string          `json:"role"`
	Name         string          `json:"name"`
	Arguments    string          `json:"arguments"`
	CallID       string          `json:"call_id"`
	Output       json.RawMessage `json:"output"`
	Content      []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

func codexShellCommand(argsRaw string) string {
	if argsRaw == "" {
		return ""
	}
	var a struct {
		Command string `json:"command"`
	}
	if json.Unmarshal([]byte(argsRaw), &a) != nil {
		return ""
	}
	return a.Command
}

func codexOutputIsError(raw json.RawMessage) bool {
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return false // ported TS only inspects string output
	}
	if m := exitCodeRe.FindStringSubmatch(s); m != nil {
		return m[1] != "0"
	}
	var p struct {
		Metadata struct {
			ExitCode *int `json:"exit_code"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(s), &p) == nil && p.Metadata.ExitCode != nil {
		return *p.Metadata.ExitCode != 0
	}
	return false
}

// extractCodexEvents ports frontend/app/view/agents/activityevents.ts:extractCodexEvents.
func extractCodexEvents(lines []string) sessionEvents {
	var raw []SessionEvent
	cmdByID := map[string]string{}
	var firstTs, lastTs int64
	var firstUser, lastAssistant string
	isSubagent := false
	for _, line := range lines {
		var rec codexEventLine
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		if ts := parseTs(rec.Timestamp); ts > 0 {
			if firstTs == 0 {
				firstTs = ts
			}
			lastTs = ts
		}
		ts := parseTs(rec.Timestamp)
		var p codexPayload
		if len(rec.Payload) == 0 || json.Unmarshal(rec.Payload, &p) != nil {
			continue
		}
		if rec.Type == "session_meta" {
			if p.ThreadSource == "subagent" {
				isSubagent = true
			}
			continue
		}
		if rec.Type != "response_item" {
			continue
		}
		switch p.Type {
		case "message":
			for _, b := range p.Content {
				if p.Role == "assistant" && b.Type == "output_text" && strings.TrimSpace(b.Text) != "" {
					lastAssistant = b.Text
				}
				if p.Role == "user" && b.Type == "input_text" && firstUser == "" && strings.TrimSpace(b.Text) != "" &&
					!strings.HasPrefix(b.Text, "<environment_context") && !strings.HasPrefix(b.Text, "<skill>") {
					firstUser = b.Text
				}
			}
		case "function_call":
			cmd := codexShellCommand(p.Arguments)
			if p.CallID != "" {
				if cmd != "" {
					cmdByID[p.CallID] = cmd
				} else {
					cmdByID[p.CallID] = p.Name
				}
			}
			if p.Name == "shell_command" && commitRe.MatchString(cmd) {
				raw = append(raw, SessionEvent{Type: "committed", Ts: ts, Text: commitSubject(cmd)})
			}
		case "function_call_output", "custom_tool_call_output":
			if p.CallID != "" && codexOutputIsError(p.Output) {
				cmd := cmdByID[p.CallID]
				if cmd == "" {
					cmd = "a command"
				}
				raw = append(raw, SessionEvent{Type: "errored", Ts: ts, Text: "failed: " + clipText(cmd)})
			}
		}
	}
	if isSubagent {
		return sessionEvents{Status: "done"}
	}
	startedText := "started session"
	if firstUser != "" {
		startedText = clipText(firstUser)
	}
	finishedText := "finished"
	if lastAssistant != "" {
		finishedText = clipText(lastAssistant)
	}
	return assembleEvents(raw, firstTs, lastTs, startedText, finishedText)
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

// SessionEvent is one lifecycle event extracted from a transcript (ported from
// frontend/app/view/agents/activityevents.ts). Type ∈ started|asked|committed|errored|finished.
type SessionEvent struct {
	Type string `json:"type"`
	Ts   int64  `json:"ts"`
	Text string `json:"text"`
}

// sessionEvents is an extractor's full result: the ordered events plus derived summary fields.
type sessionEvents struct {
	Events     []SessionEvent
	Status     string
	StartedTs  int64
	DurationMs int64
}

const maxEventText = 100

var (
	wsRe        = regexp.MustCompile(`\s+`)
	commitRe    = regexp.MustCompile(`\bgit\s+commit\b`)
	commitMsgRe = regexp.MustCompile(`-m\s+["']([^"']+)["']`)
	exitCodeRe  = regexp.MustCompile(`Exit code:\s*(\d+)`)
)

// clipText collapses whitespace, trims, and caps at maxEventText runes with an ellipsis.
func clipText(s string) string {
	s = strings.TrimSpace(wsRe.ReplaceAllString(s, " "))
	r := []rune(s)
	if len(r) > maxEventText {
		return strings.TrimSpace(string(r[:maxEventText-1])) + "…"
	}
	return s
}

// parseTs parses an ISO-8601 timestamp to UnixMilli, or 0 when absent/unparseable.
func parseTs(s string) int64 {
	if s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

func commitSubject(cmd string) string {
	if m := commitMsgRe.FindStringSubmatch(cmd); m != nil {
		return clipText(m[1])
	}
	return "committed"
}

// assembleEvents sorts the raw events, derives status from the last real event, prepends a synthetic
// "started" and (only for done sessions) appends a synthetic "finished", and computes duration.
func assembleEvents(raw []SessionEvent, firstTs, lastTs int64, startedText, finishedText string) sessionEvents {
	var real []SessionEvent
	for _, e := range raw {
		if e.Ts > 0 {
			real = append(real, e)
		}
	}
	sort.SliceStable(real, func(i, j int) bool { return real[i].Ts < real[j].Ts })

	status := "done"
	if n := len(real); n > 0 {
		switch real[n-1].Type {
		case "asked":
			status = "waiting"
		case "errored":
			status = "failed"
		}
	}

	var events []SessionEvent
	if firstTs > 0 {
		events = append(events, SessionEvent{Type: "started", Ts: firstTs, Text: startedText})
	}
	events = append(events, real...)
	if status == "done" && lastTs > 0 {
		events = append(events, SessionEvent{Type: "finished", Ts: lastTs, Text: finishedText})
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].Ts < events[j].Ts })

	var dur int64
	if firstTs > 0 && lastTs > firstTs {
		dur = lastTs - firstTs
	}
	return sessionEvents{Events: events, Status: status, StartedTs: firstTs, DurationMs: dur}
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
	events    func(lines []string) sessionEvents
}

func claudeProvider(root string) provider {
	return provider{
		runtime:   "claude",
		root:      root,
		matches:   func(name string) bool { return strings.HasSuffix(name, ".jsonl") },
		extract:   extractClaudeSession,
		resumeCmd: func(s *SessionInfo) string { return "claude --resume " + s.ID },
		events:    extractClaudeEvents,
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
		events:    extractCodexEvents,
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
		lines := readLines(c.path)
		s := p.extract(c.stem, lines)
		if s == nil {
			continue
		}
		s.Runtime = p.runtime
		s.LastActiveTs = c.mtime.UnixMilli()
		s.ResumeCommand = p.resumeCmd(s)
		s.TranscriptPath = c.path
		se := p.events(lines)
		s.Events = se.Events
		s.Status = se.Status
		s.StartedTs = se.StartedTs
		s.DurationMs = se.DurationMs
		out = append(out, *s)
	}
	return out
}

// ExtractSession folds a single transcript file into a SessionInfo, selecting the parser by runtime.
// Returns (nil, nil) when the file carries no session (e.g. a tool-only subagent file). Reuses the
// same extract/events the scanner uses, so status/summary derivation cannot drift from the Agent surfaces.
func ExtractSession(path, runtime string) (*SessionInfo, error) {
	var p provider
	switch runtime {
	case "claude":
		p = claudeProvider("")
	case "codex":
		p = codexProvider("")
	default:
		return nil, fmt.Errorf("agentsessions: unknown runtime %q", runtime)
	}
	lines := readLines(path)
	stem := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	s := p.extract(stem, lines)
	if s == nil {
		return nil, nil
	}
	s.Runtime = runtime
	s.TranscriptPath = path
	se := p.events(lines)
	s.Events = se.Events
	s.Status = se.Status
	s.StartedTs = se.StartedTs
	s.DurationMs = se.DurationMs
	return s, nil
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
