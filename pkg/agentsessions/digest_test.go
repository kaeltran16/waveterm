// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"reflect"
	"testing"
)

// the digest is what a person reads in the conversation: tool calls, tool output, thinking and a subagent's
// turns are not part of it
func TestDigestClaudeKeepsPromptsAndReplies(t *testing.T) {
	lines := []string{
		`{"type":"user","timestamp":"2026-09-17T06:02:05.000Z","cwd":"/x","message":{"role":"user","content":"fix the hook timeout"}}`,
		`{"type":"assistant","timestamp":"2026-09-17T06:02:06.000Z","message":{"content":[{"type":"thinking","thinking":"secret thought"}]}}`,
		`{"type":"assistant","timestamp":"2026-09-17T06:02:07.000Z","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"grep timeout"}}]}}`,
		`{"type":"user","timestamp":"2026-09-17T06:02:08.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"tool output text"}]}}`,
		`{"type":"assistant","timestamp":"2026-09-17T06:02:09.000Z","isSidechain":true,"message":{"content":[{"type":"text","text":"a subagent reply"}]}}`,
		`{"type":"user","timestamp":"2026-09-17T06:02:10.000Z","isSidechain":true,"message":{"role":"user","content":"a subagent prompt"}}`,
		`{"type":"assistant","timestamp":"2026-09-17T06:02:11.000Z","message":{"content":[{"type":"text","text":"the timeout was the dial"}]}}`,
	}
	_, _, turns := claudeProvider("").fused("", "s1", lines)
	want := []Turn{{Speaker: "user", Text: "fix the hook timeout"}, {Speaker: "agent", Text: "the timeout was the dial"}}
	if !reflect.DeepEqual(turns, want) {
		t.Fatalf("turns = %+v\nwant %+v", turns, want)
	}
}

func TestDigestPiKeepsPromptsAndReplies(t *testing.T) {
	path := writeTranscript(t, []string{
		`{"type":"session","version":3,"id":"s1","timestamp":"2026-09-17T06:00:00Z","cwd":"C:\\repo"}`,
		`{"type":"message","id":"u1","parentId":null,"timestamp":"2026-09-17T06:00:01Z","message":{"role":"user","content":"review the diff"}}`,
		`{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-09-17T06:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"an abandoned answer"}]}}`,
		`{"type":"message","id":"a2","parentId":"u1","timestamp":"2026-09-17T06:00:03Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"the diff is fine"}]}}`,
		`{"type":"message","id":"a3","parentId":"a2","timestamp":"2026-09-17T06:00:04Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash"}]}}`,
		`{"type":"message","id":"r1","parentId":"a3","timestamp":"2026-09-17T06:00:05Z","message":{"role":"toolResult","content":[{"type":"text","text":"a.go"}]}}`,
		`{"type":"message","id":"u2","parentId":"r1","timestamp":"2026-09-17T06:00:06Z","message":{"role":"user","content":[{"type":"text","text":"ship it"}]}}`,
	})
	_, _, turns := piProvider("").fused(path, "", nil)
	want := []Turn{
		{Speaker: "user", Text: "review the diff"},
		{Speaker: "agent", Text: "the diff is fine"},
		{Speaker: "user", Text: "ship it"},
	}
	if !reflect.DeepEqual(turns, want) {
		t.Fatalf("turns = %+v\nwant %+v", turns, want)
	}
}

func TestDigestCodexHasNoTurns(t *testing.T) {
	lines := []string{
		`{"type":"session_meta","payload":{"session_id":"019f1633","cwd":"/home/me/waveterm"}}`,
		`{"type":"event_msg","payload":{"type":"user_message","message":"check the handoff"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}`,
	}
	s, _, turns := codexProvider("").fused("", "", lines)
	if s == nil {
		t.Fatal("want a codex session")
	}
	if len(turns) != 0 {
		t.Fatalf("codex keeps no turns, got %+v", turns)
	}
}
