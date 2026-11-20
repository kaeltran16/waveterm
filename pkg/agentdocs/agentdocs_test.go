// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentdocs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 20, 9, 0, 0, 0, time.UTC)

func at(n int) string { return t0.Add(time.Duration(n) * time.Second).Format(time.RFC3339Nano) }

func ms(n int) int64 { return t0.Add(time.Duration(n) * time.Second).UnixMilli() }

func jsonLine(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// claudeCall is a Claude tool_use at n seconds and its result.
func claudeCall(t *testing.T, n int, cwd, id, name string, input map[string]any, isError bool) []string {
	return []string{
		jsonLine(t, map[string]any{"type": "assistant", "timestamp": at(n), "cwd": cwd, "message": map[string]any{
			"content": []any{map[string]any{"type": "tool_use", "id": id, "name": name, "input": input}},
		}}),
		jsonLine(t, map[string]any{"type": "user", "timestamp": at(n), "cwd": cwd, "message": map[string]any{
			"content": []any{map[string]any{"type": "tool_result", "tool_use_id": id, "is_error": isError}},
		}}),
	}
}

func writeLines(t *testing.T, path string, lines []string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeTranscriptListsOnlySuccessfulMarkdownWrites(t *testing.T) {
	dir := t.TempDir()
	cwd := filepath.Join(dir, "repo")
	a, b := filepath.Join(cwd, "a.md"), filepath.Join(cwd, "b.MD")
	var lines []string
	lines = append(lines, claudeCall(t, 1, cwd, "t1", "Write", map[string]any{"file_path": a, "content": "x"}, false)...)
	lines = append(lines, claudeCall(t, 2, cwd, "t2", "Edit", map[string]any{"file_path": b, "old_string": "x", "new_string": "y"}, false)...)
	lines = append(lines, claudeCall(t, 3, cwd, "t3", "Write", map[string]any{"file_path": filepath.Join(cwd, "c.go"), "content": "x"}, false)...)
	lines = append(lines, claudeCall(t, 4, cwd, "t4", "Edit", map[string]any{"file_path": filepath.Join(cwd, "d.md"), "old_string": "x", "new_string": "y"}, true)...)
	transcript := filepath.Join(dir, "s.jsonl")
	writeLines(t, transcript, lines)

	got, err := Read(transcript)
	if err != nil {
		t.Fatal(err)
	}
	want := []Doc{{Path: b, Ts: ms(2), Verb: VerbEdited}, {Path: a, Ts: ms(1), Verb: VerbWritten}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestClaudeSubagentWriteIsListed(t *testing.T) {
	dir := t.TempDir()
	cwd := filepath.Join(dir, "repo")
	transcript := filepath.Join(dir, "s.jsonl")
	writeLines(t, transcript, claudeCall(t, 1, cwd, "p1", "Read", map[string]any{"file_path": filepath.Join(cwd, "x.md")}, false))
	sub := filepath.Join(dir, "s", "subagents", "agent-1.jsonl")
	writeLines(t, sub, claudeCall(t, 5, cwd, "s1", "Write", map[string]any{"file_path": "notes/plan.markdown", "content": "x"}, false))

	got, err := Read(transcript)
	if err != nil {
		t.Fatal(err)
	}
	want := []Doc{{Path: filepath.Join(cwd, "notes", "plan.markdown"), Ts: ms(5), Verb: VerbWritten}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestPiRelativeWriteResolvesAgainstSessionCwd(t *testing.T) {
	dir := t.TempDir()
	cwd := filepath.Join(dir, "repo")
	entry := func(id string, parent any, n int, message map[string]any) string {
		return jsonLine(t, map[string]any{"type": "message", "id": id, "parentId": parent, "timestamp": at(n), "message": message})
	}
	call := func(id, name, path string) map[string]any {
		return map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "toolCall", "id": id, "name": name, "arguments": map[string]any{"path": path}},
		}}
	}
	result := func(id string, isError bool) map[string]any {
		return map[string]any{"role": "toolResult", "toolCallId": id, "isError": isError, "content": []any{}}
	}
	transcript := filepath.Join(dir, "pi.jsonl")
	writeLines(t, transcript, []string{
		jsonLine(t, map[string]any{"type": "session", "version": 3, "id": "sess", "timestamp": at(0), "cwd": cwd}),
		entry("e1", nil, 1, call("c1", "write", "docs/spec.md")),
		entry("e2", "e1", 1, result("c1", false)),
		entry("e3", "e2", 2, call("c2", "edit", "docs/other.md")),
		entry("e4", "e3", 2, result("c2", true)),
		entry("e5", "e4", 3, call("c3", "edit", "docs/spec.md")),
		entry("e6", "e5", 3, result("c3", false)),
	})

	got, err := Read(transcript)
	if err != nil {
		t.Fatal(err)
	}
	want := []Doc{{Path: filepath.Join(cwd, "docs", "spec.md"), Ts: ms(3), Verb: VerbEdited}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestMergeKeepsLatestTouchNewestFirst(t *testing.T) {
	earlier := []Doc{{Path: "/r/x.md", Ts: 30, Verb: VerbEdited}, {Path: "/r/y.md", Ts: 10, Verb: VerbWritten}}
	later := []Doc{{Path: "/r/x.md", Ts: 50, Verb: VerbWritten}, {Path: "/r/z.md", Ts: 20, Verb: VerbWritten}}
	got := Merge(earlier, later)
	want := []Doc{{Path: "/r/x.md", Ts: 50, Verb: VerbWritten}, {Path: "/r/z.md", Ts: 20, Verb: VerbWritten}, {Path: "/r/y.md", Ts: 10, Verb: VerbWritten}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}
