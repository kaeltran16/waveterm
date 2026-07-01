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
