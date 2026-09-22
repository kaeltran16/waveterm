// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPlanCommandPassesQuotedArgumentsThrough(t *testing.T) {
	dir := newGitRepo(t)
	if _, err := execPlanCommand(context.Background(), dir, `git config wave.probe "two words"`, time.Minute, nil); err != nil {
		t.Fatal(err)
	}
	if got := gitCmd(t, dir, "config", "wave.probe"); got != "two words" {
		t.Fatalf("the shell must hand the command over unchanged, got %q", got)
	}
}

func TestPlanCommandRunsInAPosixShell(t *testing.T) {
	dir := newGitRepo(t)
	// an inline VAR=value prefix and $(...), which cmd.exe rejected in acceptance 2, and a /-leading
	// argument Git Bash would otherwise rewrite into a Windows path
	command := `WAVE_PROBE="$(echo two) words" sh -c 'git config wave.one "$WAVE_PROBE"' && git config wave.two /usr`
	if _, err := execPlanCommand(context.Background(), dir, command, time.Minute, nil); err != nil {
		t.Fatal(err)
	}
	if got := gitCmd(t, dir, "config", "wave.one"); got != "two words" {
		t.Fatalf("want the prefixed variable with its substitution, got %q", got)
	}
	if got := gitCmd(t, dir, "config", "wave.two"); got != "/usr" {
		t.Fatalf("want the argument unchanged, got %q", got)
	}
}

func TestPlanCommandReportsExitCodeAndOutput(t *testing.T) {
	_, err := execPlanCommand(context.Background(), newGitRepo(t), "git no-such-subcommand", time.Minute, nil)
	var pe *planCommandError
	if !errors.As(err, &pe) {
		t.Fatalf("want a planCommandError, got %v", err)
	}
	if pe.reason() != "exit 1" || !strings.Contains(pe.output, "no-such-subcommand") {
		t.Fatalf("want exit 1 with git's message, got %q / %q", pe.reason(), pe.output)
	}
}

func TestExecPlanCommandReturnsOutputOnSuccess(t *testing.T) {
	out, err := execPlanCommand(context.Background(), t.TempDir(), "echo all green", time.Minute, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out != "all green" {
		t.Fatalf("a passing command hands back its output tail, got %q", out)
	}
}

func TestPlanCommandTimesOut(t *testing.T) {
	_, err := execPlanCommand(context.Background(), t.TempDir(), "sleep 5", 200*time.Millisecond, nil)
	var pe *planCommandError
	if !errors.As(err, &pe) || pe.reason() != "timed out after 200ms" {
		t.Fatalf("want a timeout, got %v", err)
	}
}

func TestTailBufferKeepsTheEnd(t *testing.T) {
	b := &tailBuffer{max: 5}
	b.Write([]byte("abc"))
	b.Write([]byte("defgh"))
	if got := b.String(); got != "defgh" {
		t.Fatalf("want the last 5 bytes, got %q", got)
	}
}

// laterStages is what a chained Verify prints after an early stage failed: far more than the detail cap.
func laterStages() string {
	return strings.Repeat("ok  \tgithub.com/wavetermdev/waveterm/pkg/x\t0.123s\n", 100)
}

func TestFirstFailureExcerptFindsAnEarlyStageFailure(t *testing.T) {
	output := "vitest starting\n  --- FAIL: TestEarly (0.00s)\n    early_test.go:9: want 1, got 2\n" + laterStages()
	got := firstFailureExcerpt(output)
	if !strings.HasPrefix(got, "--- FAIL: TestEarly") {
		t.Fatalf("want the excerpt to start at the first failing line, got %q", got)
	}
}

func TestFailureDetailFallsBackToTheTail(t *testing.T) {
	output := strings.Repeat("noise line that is not a failure\n", 30) + "the cause is at the end"
	got := failureDetail(&planCommandError{exitCode: 1, output: output})
	if !strings.HasPrefix(got, "exit 1: ") || !strings.HasSuffix(got, "the cause is at the end") || len(got) > MaxFailureDetailLen {
		t.Fatalf("want the reason and the end of the output within %d bytes, got %q", MaxFailureDetailLen, got)
	}
}

func TestFirstFailureExcerptRespectsTheDetailCap(t *testing.T) {
	got := firstFailureExcerpt("FAIL\tpkg\n" + laterStages())
	if got == "" || len(got) > MaxFailureDetailLen {
		t.Fatalf("want a non-empty excerpt within %d bytes, got %d bytes", MaxFailureDetailLen, len(got))
	}
}

func TestFailureDetailKeepsTheReasonPrefix(t *testing.T) {
	output := "error: stage one broke\n" + laterStages()
	exit := failureDetail(&planCommandError{exitCode: 2, output: output})
	if !strings.HasPrefix(exit, "exit 2: error: stage one broke") || len(exit) > MaxFailureDetailLen {
		t.Fatalf("want the exit prefix then the first failure within the cap, got %q", exit)
	}
	timeout := failureDetail(&planCommandError{timeout: 20 * time.Minute, output: output})
	if !strings.HasPrefix(timeout, "timed out after 20m: error: stage one broke") || len(timeout) > MaxFailureDetailLen {
		t.Fatalf("want the timeout prefix then the first failure within the cap, got %q", timeout)
	}
}

func TestTailBufferPublishesOnlyAChangedTailOncePerInterval(t *testing.T) {
	var published []string
	b := &tailBuffer{
		max:          MaxPlanOutputLen,
		publish:      func(tail string) bool { published = append(published, tail); return true },
		publishEvery: time.Minute,
	}
	base := time.Now()

	// the first write publishes at once, so a command that prints and then thinks is not read as silent
	b.Write([]byte("running pkg/one\n"))
	if len(published) != 1 || published[0] != "running pkg/one" {
		t.Fatalf("want the first tail published immediately, got %q", published)
	}
	// inside the interval, however much is written
	b.Write([]byte("running pkg/two\n"))
	if len(published) != 1 {
		t.Fatalf("want no second publish inside the interval, got %q", published)
	}
	// past it, the grown tail goes out once
	b.lastPublish = base.Add(-2 * time.Minute)
	b.maybePublish(base)
	if len(published) != 2 || published[1] != "running pkg/one\nrunning pkg/two" {
		t.Fatalf("want the grown tail published, got %q", published)
	}
	// a silent command costs no write, however many intervals pass
	b.lastPublish = base.Add(-2 * time.Minute)
	b.maybePublish(base)
	if len(published) != 2 {
		t.Fatalf("an unchanged tail must not be published again, got %q", published)
	}
}

func TestTailBufferWithNoSinkKeepsItsTail(t *testing.T) {
	b := &tailBuffer{max: MaxPlanOutputLen}
	b.Write([]byte("setup output\n"))
	if got := b.String(); got != "setup output" {
		t.Fatalf("a command with no progress sink still keeps its tail, got %q", got)
	}
}

func TestLastOutputLineIsTheLastNonBlankLine(t *testing.T) {
	if got := lastOutputLine("ok pkg/one\nok pkg/two\n\n  \n"); got != "ok pkg/two" {
		t.Fatalf("want the last line with content, got %q", got)
	}
	if got := lastOutputLine("  \n\n"); got != "" {
		t.Fatalf("output with no content has no line to show, got %q", got)
	}
}

// A sink that declines must leave the tail unsent, or it goes unpublished until the output changes
// again — which for a Verify that has gone quiet means never.
func TestTailBufferRepublishesATailTheSinkDeclined(t *testing.T) {
	var published []string
	accept := false
	b := &tailBuffer{
		max: MaxPlanOutputLen,
		publish: func(tail string) bool {
			published = append(published, tail)
			return accept
		},
		publishEvery: time.Minute,
	}
	base := time.Now()

	b.Write([]byte("running pkg/one\n"))
	if len(published) != 1 {
		t.Fatalf("want one offer, got %q", published)
	}
	accept = true
	b.lastPublish = base.Add(-2 * time.Minute)
	b.maybePublish(base)
	if len(published) != 2 || published[1] != "running pkg/one" {
		t.Fatalf("a declined tail must be offered again unchanged, got %q", published)
	}
	// once taken, it is not offered a third time
	b.lastPublish = base.Add(-2 * time.Minute)
	b.maybePublish(base)
	if len(published) != 2 {
		t.Fatalf("an accepted tail must not be republished, got %q", published)
	}
}
