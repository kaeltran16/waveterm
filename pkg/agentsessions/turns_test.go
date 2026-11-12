// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"reflect"
	"testing"
)

// a board reads only what the session said and was told since its cursor: a subagent's turns, tool calls and
// tool output are not turns, and the text records of one answer read as one turn
func TestTurnsSinceClaudeKeepsMainChainTextAfterTheCursor(t *testing.T) {
	path := writeTranscript(t, []string{
		`{"type":"user","timestamp":"2026-09-17T06:02:05.000Z","origin":{"kind":"human"},"message":{"role":"user","content":"an old prompt"}}`,
		`{"type":"assistant","timestamp":"2026-09-17T06:02:06.000Z","message":{"content":[{"type":"text","text":"an old answer"}]}}`,
		`{"type":"user","timestamp":"2026-09-17T06:02:10.000Z","origin":{"kind":"human"},"message":{"role":"user","content":"draw the cache"}}`,
		`{"type":"assistant","timestamp":"2026-09-17T06:02:11.000Z","message":{"content":[{"type":"thinking","thinking":"hm"},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}`,
		`{"type":"user","timestamp":"2026-09-17T06:02:12.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"a.go"}]}}`,
		`{"type":"assistant","timestamp":"2026-09-17T06:02:13.000Z","isSidechain":true,"message":{"content":[{"type":"text","text":"a subagent's answer"}]}}`,
		`{"type":"assistant","timestamp":"2026-09-17T06:02:14.000Z","message":{"content":[{"type":"text","text":"the cache has two tiers"}]}}`,
		`{"type":"assistant","timestamp":"2026-09-17T06:02:15.000Z","message":{"content":[{"type":"text","text":"and one lock"}]}}`,
		`not json`,
	})
	got := TurnsSince(path, "claude", 1789624926000) // 06:02:06, the old answer
	want := []Turn{
		{Speaker: "user", Text: "draw the cache", Ts: 1789624930000},
		{Speaker: "agent", Text: "the cache has two tiers\nand one lock", Ts: 1789624935000},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("TurnsSince = %#v\nwant %#v", got, want)
	}
	if got := TurnsSince(path, "claude", 1789624935000); len(got) != 0 {
		t.Fatalf("TurnsSince at the last turn = %#v, want none", got)
	}
}

func TestTurnsSincePiReadsTheActiveBranch(t *testing.T) {
	path := writeTranscript(t, []string{
		`{"type":"session","version":3,"id":"s1","timestamp":"2026-09-17T06:00:00Z","cwd":"C:\\repo"}`,
		`{"type":"message","id":"u1","parentId":null,"timestamp":"2026-09-17T06:00:01Z","message":{"role":"user","content":"an old prompt"}}`,
		`{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-09-17T06:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"an old answer"}]}}`,
		`{"type":"message","id":"u2","parentId":"a1","timestamp":"2026-09-17T06:00:03Z","message":{"role":"user","content":"draw the cache"}}`,
		`{"type":"message","id":"a2","parentId":"u2","timestamp":"2026-09-17T06:00:04Z","message":{"role":"assistant","content":[{"type":"text","text":"an abandoned answer"}]}}`,
		`{"type":"message","id":"a3","parentId":"u2","timestamp":"2026-09-17T06:00:05Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"toolCall","id":"c1","name":"bash"}]}}`,
		`{"type":"message","id":"r1","parentId":"a3","timestamp":"2026-09-17T06:00:06Z","message":{"role":"toolResult","content":[{"type":"text","text":"a.go"}]}}`,
		`{"type":"message","id":"a4","parentId":"r1","timestamp":"2026-09-17T06:00:07Z","message":{"role":"assistant","content":[{"type":"text","text":"two tiers"}]}}`,
	})
	got := TurnsSince(path, "pi", 1789624802000) // 06:00:02, the old answer
	want := []Turn{
		{Speaker: "user", Text: "draw the cache", Ts: 1789624803000},
		{Speaker: "agent", Text: "two tiers", Ts: 1789624807000},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("TurnsSince = %#v\nwant %#v", got, want)
	}
}

func TestTurnsSinceHasNoneForAnotherRuntimeOrAMissingFile(t *testing.T) {
	answered := writeTranscript(t, []string{
		`{"type":"assistant","timestamp":"2026-09-17T06:02:06.000Z","message":{"content":[{"type":"text","text":"done"}]}}`,
	})
	if got := TurnsSince(answered, "codex", 0); len(got) != 0 {
		t.Fatalf("codex: TurnsSince = %#v, want none", got)
	}
	if got := TurnsSince("does-not-exist.jsonl", "pi", 0); len(got) != 0 {
		t.Fatalf("missing pi file: TurnsSince = %#v, want none", got)
	}
}
