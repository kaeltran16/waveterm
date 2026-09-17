// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"reflect"
	"testing"
)

// a claude transcript writes a user record for far more than what a person typed: tool output, harness
// notices, slash commands, the compaction summary. Only the typed prompts are human prompts, including those
// typed while the session was busy, which it records as queued-command attachments rather than user records.
func TestHumanPromptsClaudeKeepsOnlyTypedPrompts(t *testing.T) {
	path := writeTranscript(t, []string{
		`{"type":"user","timestamp":"2026-09-17T06:02:05.000Z","origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":"You are the worker for task 1"}}`,
		`{"type":"assistant","timestamp":"2026-09-17T06:02:06.000Z","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}`,
		`{"type":"user","timestamp":"2026-09-17T06:02:07.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"a.go"}]}}`,
		`{"type":"user","timestamp":"2026-09-17T06:02:08.000Z","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"# Skill body"}]}}`,
		`{"type":"user","timestamp":"2026-09-17T06:02:09.000Z","origin":{"kind":"task-notification"},"message":{"role":"user","content":"a background command finished"}}`,
		`{"type":"user","timestamp":"2026-09-17T06:02:10.000Z","message":{"role":"user","content":"<command-name>/compact</command-name>\n<command-args></command-args>"}}`,
		`{"type":"user","timestamp":"2026-09-17T06:02:11.000Z","message":{"role":"user","content":"<local-command-stdout>Compacted</local-command-stdout>"}}`,
		`{"type":"user","timestamp":"2026-09-17T06:02:12.000Z","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued"}}`,
		`{"type":"user","timestamp":"2026-09-17T06:02:13.000Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}`,
		`{"type":"user","timestamp":"2026-09-17T06:02:14.000Z","origin":{"kind":"human"},"promptSource":"queued","message":{"role":"user","content":"keep closed-session links clickable"}}`,
		`{"type":"user","timestamp":"2026-09-17T06:02:15.000Z","isSidechain":true,"message":{"role":"user","content":"a subagent's own prompt"}}`,
		`{"type":"user","timestamp":"2026-09-17T06:02:16.000Z","origin":{"kind":"human"},"message":{"role":"user","content":[{"type":"text","text":"and use the"},{"type":"image"},{"type":"text","text":"shared chip"}]}}`,
		// typed while the session was busy: the queue records it, and it reaches the model as an attachment mid-turn
		`{"type":"queue-operation","operation":"enqueue","timestamp":"2026-09-17T06:02:17.000Z","content":"use hi instead of hello"}`,
		`{"type":"queue-operation","operation":"remove","timestamp":"2026-09-17T06:02:17.500Z","content":"use hi instead of hello","reason":"absorbed_mid_turn"}`,
		`{"type":"attachment","timestamp":"2026-09-17T06:02:17.000Z","attachment":{"type":"queued_command","prompt":"use hi instead of hello","commandMode":"prompt","origin":{"kind":"human"}}}`,
		`{"type":"attachment","timestamp":"2026-09-17T06:02:18.000Z","attachment":{"type":"queued_command","prompt":"<task-notification>\n<task-id>b1</task-id>\n</task-notification>","commandMode":"task-notification"}}`,
		`{"type":"attachment","timestamp":"2026-09-17T06:02:19.000Z","attachment":{"type":"queued_command","prompt":[{"type":"text","text":"match this"},{"type":"image"}],"commandMode":"prompt","origin":{"kind":"human"}}}`,
		`{"type":"attachment","timestamp":"2026-09-17T06:02:20.000Z","attachment":{"type":"edited_text_file","filename":"a.go"}}`,
		`not json`,
	})
	got := HumanPrompts(path, "claude")
	want := []HumanPrompt{
		{Ts: 1789624925000, Text: "You are the worker for task 1"},
		{Ts: 1789624934000, Text: "keep closed-session links clickable"},
		{Ts: 1789624936000, Text: "and use the\nshared chip"},
		{Ts: 1789624937000, Text: "use hi instead of hello"},
		{Ts: 1789624939000, Text: "match this"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("HumanPrompts = %+v\nwant %+v", got, want)
	}
}

func TestHumanPromptsPiReadsTheActiveBranch(t *testing.T) {
	path := writeTranscript(t, []string{
		`{"type":"session","version":3,"id":"s1","timestamp":"2026-09-17T06:00:00Z","cwd":"C:\\repo"}`,
		`{"type":"message","id":"u1","parentId":null,"timestamp":"2026-09-17T06:00:01Z","message":{"role":"user","content":"You are the worker for task 2"}}`,
		`{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-09-17T06:00:02Z","message":{"role":"assistant","content":"ok"}}`,
		`{"type":"message","id":"u2","parentId":"a1","timestamp":"2026-09-17T06:00:03Z","message":{"role":"user","content":[{"type":"text","text":"skip the docs"}]}}`,
	})
	got := HumanPrompts(path, "pi")
	want := []HumanPrompt{
		{Ts: 1789624801000, Text: "You are the worker for task 2"},
		{Ts: 1789624803000, Text: "skip the docs"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("HumanPrompts = %+v\nwant %+v", got, want)
	}
}

func TestHumanPromptsHasNoneForAnotherRuntimeOrAMissingFile(t *testing.T) {
	if got := HumanPrompts(writeTranscript(t, []string{`{"type":"user","message":{"content":"x"}}`}), "codex"); got != nil {
		t.Fatalf("codex HumanPrompts = %+v, want none", got)
	}
	if got := HumanPrompts("does-not-exist.jsonl", "claude"); got != nil {
		t.Fatalf("missing file HumanPrompts = %+v, want none", got)
	}
}
