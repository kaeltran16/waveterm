// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agentobserve"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type transcriptFacts struct {
	toolErrors  int
	errors      []string // first line of the first few tool errors, redacted
	files       []string // project-relative: edited files plus files whose tool call errored
	editsByFile map[string]int
}

// maxTranscriptErrors bounds how many error lines a transcript signal carries into the prompt.
const maxTranscriptErrors = 3

// maxEvidenceTextLen bounds a single quoted line (commit subject, tool error) in a signal summary.
const maxEvidenceTextLen = 160

type tLine struct {
	Type       string `json:"type"`
	Cwd        string `json:"cwd"`
	Entrypoint string `json:"entrypoint"`
	Message    struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type contentBlock struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`          // tool_use id
	ToolUseID string          `json:"tool_use_id"` // the tool_use a tool_result answers
	Name      string          `json:"name"`
	IsError   bool            `json:"is_error"`
	Input     json.RawMessage `json:"input"`
	Content   json.RawMessage `json:"content"` // tool_result body (string or [{text}] blocks)
}

// editTools are the tool calls whose file counts as work done on that file.
var editTools = map[string]bool{"Edit": true, "MultiEdit": true, "Write": true}

// toolRejectedMarker is the substring Claude Code puts in a tool_result body when the user declines a
// tool call (a denied permission prompt or a rejected/clarified AskUserQuestion). Both variants contain
// it verbatim.
const toolRejectedMarker = "The tool use was rejected"

// isUserRejection reports whether an is_error tool_result is a user decision (declined tool) rather than
// a genuine execution failure. Claude Code marks both with is_error:true, but a rejection is the human
// intervening — counting it as a tool error fabricates false "explicit tool error" Radar findings from
// sessions where the user simply declined a prompt. The body is a string or a [{text}] array (mirrors
// evidence.go's resultText), flattened to text before matching.
func isUserRejection(raw json.RawMessage) bool {
	return strings.Contains(toolResultText(raw), toolRejectedMarker)
}

// toolResultText flattens a tool_result body (a string or a [{text}] block array) to text.
func toolResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		parts = append(parts, b.Text)
	}
	return strings.Join(parts, "\n")
}

// extractTranscript folds one transcript's lines into facts, scoped to projectPath. Returns nil
// when the transcript's cwd does not match the project (so it is skipped). It counts explicit tool
// errors and per-file edits, and records the project-relative files that were edited or whose tool
// call failed — files merely read are not evidence about them, and listing them spread one session's
// signal across the whole repo. It never infers that an agent was "confused" from prose.
func extractTranscript(sessionId, projectPath string, lines []string) *transcriptFacts {
	cp := canonPath(projectPath)
	f := &transcriptFacts{editsByFile: map[string]int{}}
	matched := false
	fileSet := map[string]bool{}
	fileByToolUse := map[string]string{}
	addFile := func(rel string) {
		if rel != "" && !fileSet[rel] {
			fileSet[rel] = true
			f.files = append(f.files, rel)
		}
	}
	for _, ln := range lines {
		var rec tLine
		if json.Unmarshal([]byte(ln), &rec) != nil {
			continue
		}
		if agentobserve.IsHeadlessEntrypoint(rec.Entrypoint) {
			// a print-mode run is one of Wave's own backend calls; its tool failures say nothing
			// about the user's repo, and several of these run with the project as their cwd
			return nil
		}
		if rec.Cwd != "" {
			if canonPath(rec.Cwd) != cp {
				return nil // whole transcript belongs to another project
			}
			matched = true
		}
		var blocks []contentBlock
		if json.Unmarshal(rec.Message.Content, &blocks) != nil {
			continue // string content (human prompt) — no tool data
		}
		for _, b := range blocks {
			if b.Type == "tool_result" && b.IsError && !isUserRejection(b.Content) {
				f.toolErrors++
				addFile(fileByToolUse[b.ToolUseID])
				if len(f.errors) < maxTranscriptErrors {
					f.errors = append(f.errors, clip(Redact(firstLine(toolResultText(b.Content))), maxEvidenceTextLen))
				}
			}
			if b.Type != "tool_use" {
				continue
			}
			rel := relFileFromInput(b.Input, cp)
			if rel == "" {
				continue
			}
			fileByToolUse[b.ID] = rel
			if editTools[b.Name] {
				addFile(rel)
				f.editsByFile[rel]++
			}
		}
	}
	if !matched {
		return nil
	}
	return f
}

func relFileFromInput(raw json.RawMessage, projectPath string) string {
	var in struct {
		FilePath string `json:"file_path"`
	}
	if json.Unmarshal(raw, &in) != nil || in.FilePath == "" {
		return ""
	}
	abs := canonPath(in.FilePath)
	if !strings.HasPrefix(abs, projectPath+"/") {
		return ""
	}
	return strings.TrimPrefix(abs, projectPath+"/")
}

// collectTranscript walks ~/.claude/projects, extracts facts for project-matching transcripts, and
// emits one signal per transcript that carried an explicit tool error or repeated edits.
func collectTranscript(ctx context.Context, in collectInput) ([]waveobj.RadarSignal, error) {
	root := filepath.Join(wavebase.GetHomeDir(), ".claude", "projects")
	headlessSlug := agentobserve.HeadlessAgentSlug()
	var sigs []waveobj.RadarSignal
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			// a failure inside our own maintenance pass is not evidence about the user's repo
			if headlessSlug != "" && d.Name() == headlessSlug {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		if in.sinceTs > 0 && info.ModTime().UnixMilli() < in.sinceTs {
			return nil
		}
		data, rerr := os.ReadFile(path)
		if rerr != nil {
			return nil
		}
		lines := nonBlankLines(string(data))
		facts := extractTranscript(strings.TrimSuffix(d.Name(), ".jsonl"), in.projectPath, lines)
		if facts == nil || (facts.toolErrors == 0 && !hasRepeatedEdit(facts)) {
			return nil
		}
		sig := transcriptSignal(d.Name(), info.ModTime().UnixMilli(), facts)
		sigs = append(sigs, sig)
		return nil
	})
	return sigs, nil
}

func hasRepeatedEdit(f *transcriptFacts) bool {
	for _, n := range f.editsByFile {
		if n >= 2 {
			return true
		}
	}
	return false
}

func transcriptSignal(name string, ts int64, f *transcriptFacts) waveobj.RadarSignal {
	summary := fmt.Sprintf("transcript recorded %d explicit tool error(s) across %d file(s)", f.toolErrors, len(f.files))
	if len(f.errors) > 0 {
		summary += fmt.Sprintf("; first error: %q", f.errors[0])
	}
	facts := map[string]any{"toolerrors": f.toolErrors, "errors": f.errors, "editsbyfile": f.editsByFile}
	return newSignal(CollectorTranscript, "transcript:"+name, ts, f.files, summary, facts, "")
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

func nonBlankLines(s string) []string {
	var out []string
	for _, ln := range strings.Split(s, "\n") {
		if strings.TrimSpace(ln) != "" {
			out = append(out, ln)
		}
	}
	return out
}
