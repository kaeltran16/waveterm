// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	tsPrompt = "2026-11-26T08:00:00.000Z"
	tsCall   = "2026-11-26T08:00:05.000Z"
	tsResult = "2026-11-26T08:00:09.000Z"
	tsEnd    = "2026-11-26T08:01:00.000Z"
)

func tsMs(t *testing.T, ts string) int64 {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		t.Fatal(err)
	}
	return parsed.UnixMilli()
}

func recPrompt(ts, prompt string) string {
	return `{"parentUuid":null,"isSidechain":true,"type":"user","message":{"role":"user","content":"` + prompt + `"},"timestamp":"` + ts + `"}`
}

func recToolUse(ts, id, name, input string) string {
	return `{"isSidechain":true,"message":{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"` + id + `","name":"` + name + `","input":` + input + `}]},"type":"assistant","timestamp":"` + ts + `"}`
}

func recToolResult(ts, id string) string {
	return `{"isSidechain":true,"type":"user","message":{"role":"user","content":[{"tool_use_id":"` + id + `","type":"tool_result","content":"ok"}]},"timestamp":"` + ts + `"}`
}

func recText(ts, text string) string {
	return `{"isSidechain":true,"message":{"type":"message","role":"assistant","content":[{"type":"text","text":"` + text + `"}]},"type":"assistant","timestamp":"` + ts + `"}`
}

func recInterrupt(ts string) string {
	return `{"isSidechain":true,"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]},"timestamp":"` + ts + `"}`
}

// a replayed request, shaped as Claude Code writes it: its message holds tool_use blocks that are not the
// child's calls
const recBlob = `{"type":"api-request-blob","sessionId":"s","agentId":"a1","hash":"h","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_blob","name":"Read","input":{}}]}}`

func newSubagentsDir(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	parent := filepath.Join(dir, "sess.jsonl")
	if err := os.WriteFile(parent, []byte(`{"type":"user"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	subdir := filepath.Join(dir, "sess", "subagents")
	if err := os.MkdirAll(subdir, 0o755); err != nil {
		t.Fatal(err)
	}
	return parent, subdir
}

func writeSubagent(t *testing.T, subdir, id string, recs ...string) string {
	t.Helper()
	path := filepath.Join(subdir, "agent-"+id+".jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(recs, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func appendRecord(t *testing.T, path, rec string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(rec + "\n"); err != nil {
		t.Fatal(err)
	}
}

func listOne(t *testing.T, parent string) wshrpc.SubagentFileInfo {
	t.Helper()
	infos, err := listSubagents(parent)
	if err != nil {
		t.Fatal(err)
	}
	if len(infos) != 1 {
		t.Fatalf("want 1 subagent, got %d", len(infos))
	}
	return infos[0]
}

func TestSubagentMeta(t *testing.T) {
	cases := []struct {
		name string
		meta string // "" writes no meta file
		want wshrpc.SubagentFileInfo
	}{
		{
			name: "background spawn",
			meta: `{"agentType":"general-purpose","isBuiltIn":true,"description":"Explore the repo","toolUseId":"toolu_spawn","spawnDepth":1,"requestShape":"background","model":"sonnet"}`,
			want: wshrpc.SubagentFileInfo{ToolUseId: "toolu_spawn", AgentType: "general-purpose", Description: "Explore the repo", Background: true},
		},
		{
			name: "finished foreground spawn",
			meta: `{"agentType":"Explore","description":"Find it","toolUseId":"toolu_fg","requestShape":"foreground","finished":true}`,
			want: wshrpc.SubagentFileInfo{ToolUseId: "toolu_fg", AgentType: "Explore", Description: "Find it", Done: true},
		},
		{
			name: "stopped by user",
			meta: `{"agentType":"Plan","toolUseId":"toolu_stop","requestShape":"background","stoppedByUser":true}`,
			want: wshrpc.SubagentFileInfo{ToolUseId: "toolu_stop", AgentType: "Plan", Background: true, Stopped: true},
		},
		{name: "no meta"},
		{name: "malformed meta", meta: `{"agentType":`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parent, subdir := newSubagentsDir(t)
			writeSubagent(t, subdir, "a1", recPrompt(tsPrompt, "go"), recToolUse(tsCall, "toolu_1", "Read", `{"file_path":"x"}`))
			if tc.meta != "" {
				if err := os.WriteFile(filepath.Join(subdir, "agent-a1.meta.json"), []byte(tc.meta), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			got := listOne(t, parent)
			if got.AgentId != "a1" {
				t.Errorf("AgentId = %q", got.AgentId)
			}
			gotMeta := wshrpc.SubagentFileInfo{ToolUseId: got.ToolUseId, AgentType: got.AgentType, Description: got.Description,
				Background: got.Background, Done: got.Done, Stopped: got.Stopped}
			if gotMeta != tc.want {
				t.Errorf("meta facts = %+v, want %+v", gotMeta, tc.want)
			}
		})
	}
}

func TestSubagentFacts(t *testing.T) {
	cases := []struct {
		name      string
		recs      []string
		done      bool
		stopped   bool
		toolCount int
		endedAt   string // "" wants 0
		call      *wshrpc.SubagentCall
	}{
		{
			name:      "running a call",
			recs:      []string{recPrompt(tsPrompt, "go"), recToolUse(tsCall, "toolu_1", "Grep", `{"pattern":"parsePlan("}`)},
			toolCount: 1,
			call:      &wshrpc.SubagentCall{Name: "Grep", Input: map[string]any{"pattern": "parsePlan("}},
		},
		{
			name:      "between calls",
			recs:      []string{recPrompt(tsPrompt, "go"), recToolUse(tsCall, "toolu_1", "Read", `{}`), recToolResult(tsResult, "toolu_1")},
			toolCount: 1,
		},
		{
			name: "a result longer than the read buffer closes its call",
			recs: []string{recPrompt(tsPrompt, "go"), recToolUse(tsCall, "toolu_1", "Read", `{}`),
				strings.Replace(recToolResult(tsResult, "toolu_1"), `"content":"ok"`, `"content":"`+strings.Repeat("x", 3*subagentScanBufSize)+`"`, 1)},
			toolCount: 1,
		},
		{
			name: "a parallel call still runs after a later one returns",
			recs: []string{recPrompt(tsPrompt, "go"), recToolUse(tsCall, "toolu_1", "Bash", `{"command":"go test"}`),
				recToolUse(tsResult, "toolu_2", "Read", `{}`), recToolResult(tsResult, "toolu_2")},
			toolCount: 2,
			call:      &wshrpc.SubagentCall{Name: "Bash", Input: map[string]any{"command": "go test"}},
		},
		{
			name: "count is distinct ids, without the handback or a replayed request's calls",
			recs: []string{recPrompt(tsPrompt, "go"), recToolUse(tsCall, "toolu_1", "Read", `{}`), recBlob,
				recToolUse(tsCall, "toolu_1", "Read", `{}`), recToolResult(tsResult, "toolu_1"),
				recToolUse(tsResult, "toolu_2", "Edit", `{}`), recToolResult(tsResult, "toolu_2"),
				recToolUse(tsResult, "toolu_h", "SubagentHandback", `{"message":"done"}`)},
			toolCount: 2,
		},
		{
			name:      "done",
			recs:      []string{recPrompt(tsPrompt, "go"), recToolUse(tsCall, "toolu_1", "Read", `{}`), recToolResult(tsResult, "toolu_1"), recText(tsEnd, "report"), recBlob},
			done:      true,
			toolCount: 1,
			endedAt:   tsEnd,
		},
		{
			name:      "interrupted mid-call",
			recs:      []string{recPrompt(tsPrompt, "go"), recToolUse(tsCall, "toolu_1", "Bash", `{}`), recInterrupt(tsEnd)},
			stopped:   true,
			toolCount: 1,
			endedAt:   tsEnd,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parent, subdir := newSubagentsDir(t)
			writeSubagent(t, subdir, "a1", tc.recs...)
			got := listOne(t, parent)
			if got.FirstPrompt != "go" {
				t.Errorf("FirstPrompt = %q", got.FirstPrompt)
			}
			if got.StartedAtMs != tsMs(t, tsPrompt) {
				t.Errorf("StartedAtMs = %d, want the first record's %d", got.StartedAtMs, tsMs(t, tsPrompt))
			}
			if got.Done != tc.done || got.Stopped != tc.stopped {
				t.Errorf("Done, Stopped = %v, %v; want %v, %v", got.Done, got.Stopped, tc.done, tc.stopped)
			}
			if got.ToolCount != tc.toolCount {
				t.Errorf("ToolCount = %d, want %d", got.ToolCount, tc.toolCount)
			}
			var wantEnded int64
			if tc.endedAt != "" {
				wantEnded = tsMs(t, tc.endedAt)
			}
			if got.EndedAtMs != wantEnded {
				t.Errorf("EndedAtMs = %d, want %d", got.EndedAtMs, wantEnded)
			}
			want := tc.call
			if want != nil {
				want.StartedAtMs = tsMs(t, tsCall)
			}
			if !reflect.DeepEqual(got.CurrentCall, want) {
				t.Errorf("CurrentCall = %+v, want %+v", got.CurrentCall, want)
			}
		})
	}
}

func TestSubagentFactsMetaEndsAt(t *testing.T) {
	parent, subdir := newSubagentsDir(t)
	writeSubagent(t, subdir, "a1", recPrompt(tsPrompt, "go"), recToolUse(tsEnd, "toolu_1", "Read", `{}`))
	if err := os.WriteFile(filepath.Join(subdir, "agent-a1.meta.json"), []byte(`{"finished":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got := listOne(t, parent)
	if got.EndedAtMs != tsMs(t, tsEnd) || got.CurrentCall != nil {
		t.Errorf("a meta-finished child: EndedAtMs = %d, CurrentCall = %+v; want %d and none", got.EndedAtMs, got.CurrentCall, tsMs(t, tsEnd))
	}
}

func TestSubagentFactsIncremental(t *testing.T) {
	parent, subdir := newSubagentsDir(t)
	path := writeSubagent(t, subdir, "a1", recPrompt(tsPrompt, "go"), recBlob, recToolUse(tsCall, "toolu_1", "Read", `{}`))
	if got := listOne(t, parent); got.ToolCount != 1 || got.CurrentCall == nil || got.CurrentCall.Name != "Read" {
		t.Fatalf("first listing: %+v", got)
	}

	before := subagentScans.bytesRead.Load()
	listOne(t, parent)
	if read := subagentScans.bytesRead.Load() - before; read != 0 {
		t.Errorf("a repeat listing of an unchanged file read %d bytes, want 0", read)
	}

	appended := []string{recToolResult(tsResult, "toolu_1"), recToolUse(tsResult, "toolu_2", "Grep", `{"pattern":"x"}`)}
	var appendedBytes int64
	for _, rec := range appended {
		appendRecord(t, path, rec)
		appendedBytes += int64(len(rec) + 1)
	}
	before = subagentScans.bytesRead.Load()
	got := listOne(t, parent)
	if read := subagentScans.bytesRead.Load() - before; read != appendedBytes {
		t.Errorf("listing after an append read %d bytes, want only the %d appended", read, appendedBytes)
	}
	if got.ToolCount != 2 || got.CurrentCall == nil || got.CurrentCall.Name != "Grep" || got.FirstPrompt != "go" {
		t.Errorf("after the append: %+v", got)
	}
}

func TestSubagentFactsRescan(t *testing.T) {
	cases := []struct {
		name    string
		replace func(t *testing.T, parent, subdir string)
	}{
		{
			name: "rewritten shorter",
			replace: func(t *testing.T, parent, subdir string) {
				writeSubagent(t, subdir, "a1", recPrompt(tsPrompt, "new"))
			},
		},
		{
			name: "deleted, then written again longer",
			replace: func(t *testing.T, parent, subdir string) {
				if err := os.Remove(filepath.Join(subdir, "agent-a1.jsonl")); err != nil {
					t.Fatal(err)
				}
				if infos, err := listSubagents(parent); err != nil || len(infos) != 0 {
					t.Fatalf("after the delete: %v, %v", infos, err)
				}
				writeSubagent(t, subdir, "a1", recPrompt(tsPrompt, "new"), recToolUse(tsCall, "toolu_1", "Read", `{}`),
					recToolResult(tsResult, "toolu_1"), recText(tsEnd, "a much longer report than before"))
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parent, subdir := newSubagentsDir(t)
			writeSubagent(t, subdir, "a1", recPrompt(tsPrompt, "old"), recToolUse(tsCall, "toolu_1", "Read", `{}`), recToolUse(tsCall, "toolu_2", "Read", `{}`))
			listOne(t, parent)
			tc.replace(t, parent, subdir)
			got := listOne(t, parent)
			if got.FirstPrompt != "new" {
				t.Errorf("FirstPrompt = %q, want the new file's", got.FirstPrompt)
			}
			if got.ToolCount > 1 {
				t.Errorf("ToolCount = %d carries the old file's calls", got.ToolCount)
			}
		})
	}
}
