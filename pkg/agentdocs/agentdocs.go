// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentdocs lists the Markdown files an agent wrote or edited, read from its transcripts: a Claude
// transcript with its subagent transcripts, or a pi v3 session. Pure Go over transcript files; whether a
// listed file still exists is the caller's question.
package agentdocs

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentedits"
	"github.com/wavetermdev/waveterm/pkg/pisession"
)

const (
	VerbWritten = "written"
	VerbEdited  = "edited"

	piSessionType = "session"
	piMessageType = "message"
)

// verbs maps each tool that writes a file onto the verb its touch reads as: Claude's and pi's names.
var verbs = map[string]string{
	"Write":     VerbWritten,
	"Edit":      VerbEdited,
	"MultiEdit": VerbEdited,
	"write":     VerbWritten,
	"edit":      VerbEdited,
}

// Doc is one Markdown file and the latest call that touched it.
type Doc struct {
	Path string // absolute, as the call spelled it
	Ts   int64  // unix ms of the call
	Verb string // VerbWritten | VerbEdited
}

// Read lists the Markdown files one transcript's successful write and edit calls touched, newest first.
func Read(transcriptPath string) ([]Doc, error) {
	pi, err := isPiSession(transcriptPath)
	if err != nil {
		return nil, err
	}
	if pi {
		return readPi(transcriptPath)
	}
	return readClaude(transcriptPath)
}

// Merge joins lists by path (case-insensitively on Windows), keeping each path's latest touch; at an equal
// time the later list wins. The result is newest first.
func Merge(lists ...[]Doc) []Doc {
	byKey := map[string]Doc{}
	for _, l := range lists {
		for _, d := range l {
			k := pathKey(d.Path)
			if cur, ok := byKey[k]; !ok || d.Ts >= cur.Ts {
				byKey[k] = d
			}
		}
	}
	out := make([]Doc, 0, len(byKey))
	for _, d := range byKey {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Ts != out[j].Ts {
			return out[i].Ts > out[j].Ts
		}
		return out[i].Path < out[j].Path
	})
	return out
}

func isMarkdown(p string) bool {
	ext := strings.ToLower(filepath.Ext(p))
	return ext == ".md" || ext == ".markdown"
}

func pathKey(p string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(p)
	}
	return p
}

func resolve(p, cwd string) string {
	if !filepath.IsAbs(p) && cwd != "" {
		p = filepath.Join(cwd, p)
	}
	return filepath.Clean(p)
}

// docOf is the touch a successful call makes, ok=false when it touches no Markdown file.
func docOf(tool, path, cwd string, ts time.Time) (Doc, bool) {
	verb := verbs[tool]
	if verb == "" || path == "" || !isMarkdown(path) {
		return Doc{}, false
	}
	return Doc{Path: resolve(path, cwd), Ts: ts.UnixMilli(), Verb: verb}, true
}

// isPiSession reports whether the file's first record is a pi v3 session header.
func isPiSession(path string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	r := bufio.NewReader(f)
	for {
		ln, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(ln)) > 0 {
			var head struct {
				Type    string `json:"type"`
				Version int    `json:"version"`
			}
			if json.Unmarshal(ln, &head) != nil {
				return false, nil
			}
			return head.Type == piSessionType && head.Version == pisession.SupportedVersion, nil
		}
		if err == io.EOF {
			return false, nil
		}
		if err != nil {
			return false, fmt.Errorf("reading transcript %s: %w", path, err)
		}
	}
}

type claudeRecord struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Cwd       string `json:"cwd"`
	Message   *struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type claudeBlock struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Name  string `json:"name"`
	Input struct {
		FilePath string `json:"file_path"`
	} `json:"input"`
	ToolUseID string `json:"tool_use_id"`
	IsError   bool   `json:"is_error"`
}

type call struct {
	id   string
	tool string
	path string
	cwd  string
	ts   time.Time
	seq  int
}

// calls gathers write calls and tool results across files; a call counts once its result is in and is no error.
type calls struct {
	uses    []call
	seen    map[string]bool
	results map[string]bool // id -> is error
}

func newCalls() *calls {
	return &calls{seen: map[string]bool{}, results: map[string]bool{}}
}

func (c *calls) use(id, tool, path, cwd string, ts time.Time) {
	if verbs[tool] == "" || c.seen[id] {
		return
	}
	c.seen[id] = true
	c.uses = append(c.uses, call{id: id, tool: tool, path: path, cwd: cwd, ts: ts, seq: len(c.uses)})
}

func (c *calls) docs() []Doc {
	sort.SliceStable(c.uses, func(i, j int) bool {
		if !c.uses[i].ts.Equal(c.uses[j].ts) {
			return c.uses[i].ts.Before(c.uses[j].ts)
		}
		return c.uses[i].seq < c.uses[j].seq
	})
	var touches []Doc
	for _, u := range c.uses {
		if isErr, done := c.results[u.id]; !done || isErr {
			continue
		}
		if d, ok := docOf(u.tool, u.path, u.cwd, u.ts); ok {
			touches = append(touches, d)
		}
	}
	return Merge(touches)
}

func readClaude(transcriptPath string) ([]Doc, error) {
	subs, err := agentedits.SubagentTranscripts(transcriptPath)
	if err != nil {
		return nil, err
	}
	c := newCalls()
	for _, file := range append([]string{transcriptPath}, subs...) {
		if err := c.readClaudeFile(file); err != nil {
			return nil, err
		}
	}
	return c.docs(), nil
}

func (c *calls) readClaudeFile(file string) error {
	f, err := os.Open(file)
	if err != nil {
		return fmt.Errorf("reading transcript: %w", err)
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 64*1024)
	var cwd string
	var last time.Time
	for {
		ln, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(ln)) > 0 {
			var rec claudeRecord
			if json.Unmarshal(ln, &rec) == nil {
				if rec.Cwd != "" {
					cwd = rec.Cwd
				}
				if ts, perr := time.Parse(time.RFC3339Nano, rec.Timestamp); perr == nil {
					last = ts
				}
				c.takeClaude(&rec, cwd, last)
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("reading transcript %s: %w", file, err)
		}
	}
}

func (c *calls) takeClaude(rec *claudeRecord, cwd string, ts time.Time) {
	// other record types (api-request-blob) echo tool_use blocks that are not the agent's calls
	if rec.Type != "assistant" && rec.Type != "user" {
		return
	}
	if rec.Message == nil || len(rec.Message.Content) == 0 || rec.Message.Content[0] != '[' {
		return
	}
	var blocks []claudeBlock
	if json.Unmarshal(rec.Message.Content, &blocks) != nil {
		return
	}
	for _, b := range blocks {
		switch {
		case rec.Type == "assistant" && b.Type == "tool_use":
			c.use(b.ID, b.Name, b.Input.FilePath, cwd, ts)
		case rec.Type == "user" && b.Type == "tool_result":
			c.results[b.ToolUseID] = b.IsError
		}
	}
}

type piMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	ToolCallID string          `json:"toolCallId"`
	IsError    bool            `json:"isError"`
}

type piBlock struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments struct {
		Path string `json:"path"`
	} `json:"arguments"`
}

func readPi(transcriptPath string) ([]Doc, error) {
	f, err := pisession.Read(transcriptPath)
	if err != nil {
		return nil, err
	}
	c := newCalls()
	for _, e := range f.Entries {
		if e.Type != piMessageType || len(e.Message) == 0 {
			continue
		}
		var m piMessage
		if json.Unmarshal(e.Message, &m) != nil {
			continue
		}
		if m.Role == "toolResult" {
			c.results[m.ToolCallID] = m.IsError
			continue
		}
		var blocks []piBlock
		if m.Role != "assistant" || json.Unmarshal(m.Content, &blocks) != nil {
			continue
		}
		ts, _ := time.Parse(time.RFC3339Nano, e.Timestamp)
		for _, b := range blocks {
			if b.Type == "toolCall" {
				c.use(b.ID, b.Name, b.Arguments.Path, f.Header.Cwd, ts)
			}
		}
	}
	return c.docs(), nil
}
