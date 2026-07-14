// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package tasksharpen

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

func TestBuildPrompt_includesContextAndContract(t *testing.T) {
	p := buildPrompt("fix the flaky login test", "waveterm", "claude")
	for _, want := range []string{
		"fix the flaky login test", // original task
		"waveterm",                 // project name
		"claude",                   // runtime
		"Preserve the original intent",
		"Return only the rewritten task",
	} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt missing %q\n---\n%s", want, p)
		}
	}
}

func TestBuildPrompt_excludesRepoContext(t *testing.T) {
	p := buildPrompt("do the thing", "waveterm", "codex")
	// must not reuse consult's channel-history / operator-principles framing
	for _, forbidden := range []string{"Recent channel conversation", "Operator principles"} {
		if strings.Contains(p, forbidden) {
			t.Fatalf("prompt unexpectedly contains %q", forbidden)
		}
	}
}

func TestResolveModel(t *testing.T) {
	cases := map[string]string{"fast": "fable", "sonnet": "sonnet"}
	for mode, want := range cases {
		got, err := resolveModel(mode)
		if err != nil {
			t.Fatalf("resolveModel(%q) error: %v", mode, err)
		}
		if got != want {
			t.Fatalf("resolveModel(%q) = %q, want %q", mode, got, want)
		}
	}
	if _, err := resolveModel("turbo"); err == nil {
		t.Fatal("resolveModel(\"turbo\") should error")
	}
}

func TestCloneClaudeSpec_addsFlagsWithoutMutatingShared(t *testing.T) {
	spec, err := cloneClaudeSpec("fable")
	if err != nil {
		t.Fatalf("cloneClaudeSpec error: %v", err)
	}
	joined := strings.Join(spec.BaseArgs, " ")
	for _, want := range []string{"--model fable", "--tools", "--no-session-persistence"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("cloned BaseArgs missing %q: %v", want, spec.BaseArgs)
		}
	}
	// --tools must be followed by an empty-string arg
	foundEmpty := false
	for i, a := range spec.BaseArgs {
		if a == "--tools" && i+1 < len(spec.BaseArgs) && spec.BaseArgs[i+1] == "" {
			foundEmpty = true
		}
	}
	if !foundEmpty {
		t.Fatalf(`expected --tools followed by "": %v`, spec.BaseArgs)
	}
	// the shared claude spec must be untouched (still the original 4 args)
	fresh, _ := cloneClaudeSpec("sonnet")
	_ = fresh
	// re-clone should not have accumulated fable's flags from the first clone
	if strings.Contains(strings.Join(mustClaudeBaseArgs(t), " "), "--model") {
		t.Fatal("shared claude spec was mutated")
	}
}

func TestNormalize(t *testing.T) {
	if got, _ := normalize("  hello  "); got != "hello" {
		t.Fatalf("trim: got %q", got)
	}
	if got, _ := normalize("```\nhello world\n```"); got != "hello world" {
		t.Fatalf("unwrap fence: got %q", got)
	}
	if got, _ := normalize("```markdown\n# Task\ndo it\n```"); got != "# Task\ndo it" {
		t.Fatalf("unwrap lang fence: got %q", got)
	}
	if _, err := normalize("   "); err == nil {
		t.Fatal("blank output should error")
	}
	big := strings.Repeat("x", MaxSharpenTaskChars+1)
	if _, err := normalize(big); err == nil {
		t.Fatal("oversized output should error")
	}
}

func mustClaudeBaseArgs(t *testing.T) []string {
	t.Helper()
	// read the shared claude spec's args directly through consult (a fresh copy each call)
	return claudeBaseArgsForTest()
}

// stubRunner replaces the real consult.Run in tests so nothing shells out to claude.
func stubRunner(reply string, err error, calls *int) func(context.Context, consult.RuntimeSpec, string, string, func(string)) (string, error) {
	return func(_ context.Context, _ consult.RuntimeSpec, _ string, _ string, _ func(string)) (string, error) {
		*calls++
		return reply, err
	}
}

func withRunner(t *testing.T, fn func(context.Context, consult.RuntimeSpec, string, string, func(string)) (string, error)) {
	t.Helper()
	prev := runFn
	runFn = fn
	t.Cleanup(func() { runFn = prev })
}

func TestSharpen_success(t *testing.T) {
	calls := 0
	withRunner(t, stubRunner("  a clearer task  ", nil, &calls))
	res, err := Sharpen(context.Background(), Input{Task: "do thing", ProjectName: "p", Runtime: "claude", Mode: "fast"})
	if err != nil {
		t.Fatalf("Sharpen error: %v", err)
	}
	if res.Task != "a clearer task" {
		t.Fatalf("Task = %q", res.Task)
	}
	if res.Model != "fable" {
		t.Fatalf("Model = %q, want fable", res.Model)
	}
	if calls != 1 {
		t.Fatalf("runner called %d times", calls)
	}
}

func TestSharpen_sonnetModel(t *testing.T) {
	calls := 0
	withRunner(t, stubRunner("ok", nil, &calls))
	res, err := Sharpen(context.Background(), Input{Task: "x", Runtime: "codex", Mode: "sonnet"})
	if err != nil || res.Model != "sonnet" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestSharpen_validationRejectsWithoutRunning(t *testing.T) {
	cases := []Input{
		{Task: "   ", Runtime: "claude", Mode: "fast"},                                     // blank
		{Task: "ok", Runtime: "notreal", Mode: "fast"},                                     // bad runtime
		{Task: "ok", Runtime: "claude", Mode: "warp"},                                      // bad mode
		{Task: strings_Repeat_x(MaxSharpenTaskChars + 1), Runtime: "claude", Mode: "fast"}, // oversized input
	}
	for i, in := range cases {
		calls := 0
		withRunner(t, stubRunner("should not be used", nil, &calls))
		if _, err := Sharpen(context.Background(), in); err == nil {
			t.Fatalf("case %d: expected error", i)
		}
		if calls != 0 {
			t.Fatalf("case %d: runner must not run on validation failure", i)
		}
	}
}

func TestSharpen_runnerErrorPreservesContext(t *testing.T) {
	calls := 0
	withRunner(t, stubRunner("", errors.New("boom: timeout"), &calls))
	_, err := Sharpen(context.Background(), Input{Task: "x", Runtime: "claude", Mode: "fast"})
	if err == nil || !contains(err.Error(), "boom: timeout") {
		t.Fatalf("expected wrapped runner error, got %v", err)
	}
}

func TestSharpen_rejectsEmptyModelOutput(t *testing.T) {
	calls := 0
	withRunner(t, stubRunner("   ", nil, &calls))
	if _, err := Sharpen(context.Background(), Input{Task: "x", Runtime: "claude", Mode: "fast"}); err == nil {
		t.Fatal("empty model output should fail")
	}
}

func strings_Repeat_x(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'x'
	}
	return string(b)
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }
