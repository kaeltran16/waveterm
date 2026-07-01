// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package consult

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestSpecFor_knownRuntimes(t *testing.T) {
	cases := map[string]struct {
		bin  string
		arg0 string
	}{
		"claude":      {"claude", "-p"},
		"codex":       {"codex", "exec"},
		"antigravity": {"agy", "-p"},
	}
	for rt, want := range cases {
		spec, ok := SpecFor(rt)
		if !ok {
			t.Fatalf("%s: expected ok", rt)
		}
		if spec.Bin != want.bin || len(spec.BaseArgs) == 0 || spec.BaseArgs[0] != want.arg0 {
			t.Errorf("%s: got bin=%q args=%v", rt, spec.Bin, spec.BaseArgs)
		}
	}
}

func TestSpecFor_unsupported(t *testing.T) {
	if _, ok := SpecFor("terminal"); ok {
		t.Error("terminal should be unsupported")
	}
	if _, ok := SpecFor("gemini"); ok {
		t.Error("gemini should be unsupported in v1")
	}
}

func TestBuildPrompt_emptyHistoryReturnsPromptVerbatim(t *testing.T) {
	got := BuildPrompt(nil, "what is 2+2?")
	if got != "what is 2+2?" {
		t.Errorf("expected verbatim prompt, got %q", got)
	}
}

func TestBuildPrompt_includesRecentHistoryAndRequest(t *testing.T) {
	hist := []waveobj.ChannelMessage{
		{Author: "you", Text: "we are refactoring auth"},
		{Author: "codex", Text: "done, +40 -10"},
	}
	got := BuildPrompt(hist, "does it have races?")
	if !strings.Contains(got, "you: we are refactoring auth") {
		t.Errorf("missing history line: %q", got)
	}
	if !strings.Contains(got, "does it have races?") {
		t.Errorf("missing request: %q", got)
	}
}

func TestBuildPrompt_capsMessageCount(t *testing.T) {
	var hist []waveobj.ChannelMessage
	for i := 0; i < 50; i++ {
		hist = append(hist, waveobj.ChannelMessage{Author: "you", Text: "OLDLINE"})
	}
	hist = append(hist, waveobj.ChannelMessage{Author: "you", Text: "NEWEST"})
	got := BuildPrompt(hist, "q")
	// only the last maxContextMessages are kept; with 51 total, the count of OLDLINE is bounded
	if strings.Count(got, "OLDLINE") > maxContextMessages {
		t.Errorf("kept too many history lines: %d", strings.Count(got, "OLDLINE"))
	}
	if !strings.Contains(got, "NEWEST") {
		t.Errorf("dropped the newest message: %q", got)
	}
}

func TestRun_streamsAndCapturesOutput(t *testing.T) {
	var chunks []string
	spec := RuntimeSpec{Bin: "git", BaseArgs: []string{"version"}, PromptViaStdin: false}
	full, err := Run(context.Background(), spec, "", "", func(c string) { chunks = append(chunks, c) })
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if !strings.Contains(full, "git version") {
		t.Errorf("expected git version in output, got %q", full)
	}
	if len(chunks) == 0 {
		t.Error("expected at least one streamed chunk")
	}
}

func TestRun_missingBinaryErrors(t *testing.T) {
	spec := RuntimeSpec{Bin: "definitely-not-a-real-binary-xyz", BaseArgs: nil}
	_, err := Run(context.Background(), spec, "", "", func(string) {})
	if err == nil {
		t.Error("expected an error for a missing binary")
	}
}

func TestCodexParseLine_extractsAgentMessage(t *testing.T) {
	// real codex `exec --json` events (captured 2026-07-01)
	skip := []string{
		`{"type":"thread.started","thread_id":"019f"}`,
		`{"type":"turn.started"}`,
		`{"type":"turn.completed","usage":{"output_tokens":63}}`,
		`{"type":"item.completed","item":{"type":"reasoning","text":"thinking..."}}`,
	}
	for _, line := range skip {
		if txt, ok := codexParseLine([]byte(line)); ok || txt != "" {
			t.Errorf("expected skip for %q, got %q", line, txt)
		}
	}
	reply := `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}`
	txt, ok := codexParseLine([]byte(reply))
	if !ok || txt != "pong" {
		t.Errorf("expected agent_message text 'pong', got %q ok=%v", txt, ok)
	}
	if _, ok := codexParseLine([]byte("not json")); ok {
		t.Error("garbage line should not parse as a reply")
	}
}

func TestClaudeParseLine_extractsAssistantText(t *testing.T) {
	// real claude `-p --output-format stream-json --verbose` events (captured 2026-07-01)
	skip := []string{
		`{"type":"system","subtype":"init","session_id":"b16"}`,
		`{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup"}`,
		`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}`,
		`{"type":"result","subtype":"success","result":"pong"}`, // final result is redundant with the assistant delta
	}
	for _, line := range skip {
		if txt, ok := claudeParseLine([]byte(line)); ok || txt != "" {
			t.Errorf("expected skip for %q, got %q", line, txt)
		}
	}
	reply := `{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"pong"}]},"session_id":"b16"}`
	txt, ok := claudeParseLine([]byte(reply))
	if !ok || txt != "pong" {
		t.Errorf("expected assistant text 'pong', got %q ok=%v", txt, ok)
	}
}

func TestCleanTUI_stripsAnsiAndBoxDrawing(t *testing.T) {
	// agy renders a repainting TUI over a pty: ANSI CSI, OSC, box-drawing, CR repaints.
	raw := "\x1b[2J\x1b[H┌────────┐\r\n│ working…│\r\x1b[32mpong\x1b[0m\r\n└────────┘"
	got := cleanTUI(raw)
	if !strings.Contains(got, "pong") {
		t.Errorf("expected 'pong' to survive cleaning, got %q", got)
	}
	if strings.ContainsRune(got, '\x1b') {
		t.Errorf("ANSI escape leaked through: %q", got)
	}
	if strings.ContainsAny(got, "┌┐└┘│─") {
		t.Errorf("box-drawing leaked through: %q", got)
	}
}

func TestSpecFor_streamingModes(t *testing.T) {
	codex, _ := SpecFor("codex")
	if codex.ParseLine == nil {
		t.Error("codex should use JSONL line parsing (--json)")
	}
	claude, _ := SpecFor("claude")
	if claude.ParseLine == nil {
		t.Error("claude should use JSONL line parsing (stream-json)")
	}
	agy, _ := SpecFor("antigravity")
	if !agy.UsePty {
		t.Error("agy must run under a pty (upstream non-TTY stdout bug antigravity-cli#76)")
	}
}

func TestProbe_presentAndAbsent(t *testing.T) {
	ok, ver := probe(context.Background(), "git")
	if !ok {
		t.Fatal("expected git to be installed in the dev env")
	}
	if !strings.Contains(strings.ToLower(ver), "git") {
		t.Errorf("expected version string to mention git, got %q", ver)
	}
	if absent, _ := probe(context.Background(), "definitely-not-a-real-binary-xyz"); absent {
		t.Error("expected a missing binary to probe as absent")
	}
}
