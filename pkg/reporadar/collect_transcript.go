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

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type transcriptFacts struct {
	toolErrors  int
	files       []string // project-relative
	editsByFile map[string]int
}

type tLine struct {
	Type    string `json:"type"`
	Cwd     string `json:"cwd"`
	Message struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type contentBlock struct {
	Type    string          `json:"type"`
	Name    string          `json:"name"`
	IsError bool            `json:"is_error"`
	Input   json.RawMessage `json:"input"`
}

// extractTranscript folds one transcript's lines into facts, scoped to projectPath. Returns nil
// when the transcript's cwd does not match the project (so it is skipped). It counts explicit tool
// errors and per-file edits, and records project-relative referenced files — it never infers that
// an agent was "confused" from prose.
func extractTranscript(sessionId, projectPath string, lines []string) *transcriptFacts {
	cp := canonPath(projectPath)
	f := &transcriptFacts{editsByFile: map[string]int{}}
	matched := false
	fileSet := map[string]bool{}
	for _, ln := range lines {
		var rec tLine
		if json.Unmarshal([]byte(ln), &rec) != nil {
			continue
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
			if b.Type == "tool_result" && b.IsError {
				f.toolErrors++
			}
			if b.Type == "tool_use" && (b.Name == "Edit" || b.Name == "Write" || b.Name == "Read") {
				if rel := relFileFromInput(b.Input, cp); rel != "" {
					if !fileSet[rel] {
						fileSet[rel] = true
						f.files = append(f.files, rel)
					}
					if b.Name == "Edit" || b.Name == "Write" {
						f.editsByFile[rel]++
					}
				}
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
	var sigs []waveobj.RadarSignal
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
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
	facts := map[string]any{"toolerrors": f.toolErrors, "editsbyfile": f.editsByFile}
	return newSignal(CollectorTranscript, "transcript:"+name, ts, f.files, summary, facts, "")
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
