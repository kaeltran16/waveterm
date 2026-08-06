// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

var errNoClaude = fmt.Errorf("volunteer judge requires the claude CLI, which is not available")

// judgeRun is the inner process-runner seam. judge itself is swappable, but SetJudgeForTest replaces
// spec construction along with the call, so a test using it cannot observe which tier the real body
// selects. Overriding this instead runs the real judge and exposes the spec.
var judgeRun = consult.Run

// judge runs on the cheap tier: deciding whether any of a short list is worth interrupting for is
// bounded classification, not synthesis. One-shot and unstreamed, so the emit callback is discarded.
var judge = func(ctx context.Context, cwd, prompt string) (string, error) {
	spec, ok := consult.SpecForTier("claude", consult.TierCheap)
	if !ok {
		return "", errNoClaude
	}
	return judgeRun(ctx, spec, cwd, prompt, func(string) {})
}

// SetJudgeForTest swaps the model call and returns a restore func the caller defers.
func SetJudgeForTest(fn func(ctx context.Context, cwd, prompt string) (string, error)) func() {
	old := judge
	judge = fn
	return func() { judge = old }
}

// buildJudgePrompt asks the one question a static precedence table cannot answer: not which class
// outranks which, but whether any of these is worth interrupting a working human for right now.
func buildJudgePrompt(cands []Candidate) string {
	var b strings.Builder
	b.WriteString("You are deciding whether an assistant should interrupt a developer at work.\n")
	b.WriteString("Below are things the assistant noticed. Interrupting has a real cost: a wrong or\n")
	b.WriteString("obvious interruption is worse than silence. Prefer silence when unsure.\n\n")
	for i, c := range cands {
		fmt.Fprintf(&b, "%d. [%s] %s - %s\n", i+1, c.Class, c.Title, c.Snippet)
	}
	b.WriteString("\nReply with the number of the single item worth saying now, or the word none.\n")
	b.WriteString("Reply with nothing else.\n")
	return b.String()
}

// parseJudgeReply returns the zero-based index of the pick, or -1 for a decline. Total: any reply it
// cannot read as an in-range one-based number is a decline, never an error.
func parseJudgeReply(reply string, n int) int {
	s := strings.TrimSpace(strings.ToLower(reply))
	if s == "" || strings.HasPrefix(s, "none") {
		return -1
	}
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return -1
	}
	i, err := strconv.Atoi(strings.Trim(fields[0], ".,:"))
	if err != nil || i < 1 || i > n {
		return -1
	}
	return i - 1
}
