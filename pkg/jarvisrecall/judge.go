// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

// errNoJudge mirrors jarvisproactive's failure mode: the cheap tier has no configured provider.
var errNoJudge = fmt.Errorf("relevance judge requires the cheap tier, which is not available")

// judgeRun is the inner process-runner seam (same shape as jarvisproactive.judgeRun).
var judgeRun = consult.Run

// judge is the batch relevance call: one cheap-tier pass over the numbered shortlist returning the
// kept indices. Picking on-topic candidates is bounded classification, not synthesis — the cheap
// tier exists for exactly this. A seam so tests mock it; one-shot and unstreamed.
var judge = func(ctx context.Context, cwd, prompt string) (string, error) {
	spec, ok := consult.SpecForTier("openrouter", consult.TierCheap)
	if !ok {
		return "", errNoJudge
	}
	return judgeRun(ctx, spec, cwd, prompt, func(string) {})
}

// SetJudgeForTest swaps the model call and returns a restore func the caller defers.
func SetJudgeForTest(fn func(ctx context.Context, cwd, prompt string) (string, error)) func() {
	old := judge
	judge = fn
	return func() { judge = old }
}

// buildJudgePrompt asks the cheap tier to keep the on-topic candidates. The numbered list aligns
// with the later synthesis prompt, so kept indices carry straight through.
func buildJudgePrompt(question string, cands []candidate) string {
	var b strings.Builder
	b.WriteString("A question was asked of a work ledger. Below are candidate sources a deterministic search retrieved.\n")
	b.WriteString("Decide which candidates are genuinely ON-TOPIC for the question — relevant to what is asked, not merely sharing a topic word.\n\n")
	b.WriteString("Question: " + question + "\n\nCandidates:\n")
	for i, c := range cands {
		fmt.Fprintf(&b, "%d. [%s] %s", i+1, c.sourceType, c.title)
		if c.project != "" {
			fmt.Fprintf(&b, " (%s)", c.project)
		}
		if c.snippet != "" {
			b.WriteString(" — " + strings.TrimSpace(c.snippet))
		}
		b.WriteString("\n")
	}
	b.WriteString("\nReply with ONLY the comma-separated numbers of the on-topic candidates, or the word \"none\" if none are on-topic. Do not explain.\n")
	return b.String()
}

var judgeNumRe = regexp.MustCompile(`\d+`)

// parseJudgeReply extracts 0-based kept indices from a comma-separated reply. "none"/"" keep
// nothing. Any ambiguity (out-of-range, digits alongside garbage, no digits at all) returns nil —
// the caller keeps everything, because a lost judge is a slower answer, never no answer.
func parseJudgeReply(reply string, n int) []int {
	low := strings.ToLower(strings.TrimSpace(reply))
	if low == "none" || low == "" {
		return []int{}
	}
	matches := judgeNumRe.FindAllString(reply, -1)
	if len(matches) == 0 {
		return nil
	}
	var out []int
	seen := map[int]bool{}
	for _, m := range matches {
		idx, err := strconv.Atoi(m)
		if err != nil || idx < 1 || idx > n {
			return nil
		}
		if !seen[idx] {
			seen[idx] = true
			out = append(out, idx-1)
		}
	}
	return out
}

// judgeCandidates applies the batch judge. Any judge failure keeps every candidate and logs —
// the judge removes wrong memories before synthesis, it must never remove the answer. A singleton
// shortlist skips the call: retrieval already narrowed it deterministically and one candidate is
// nothing for the model to choose between.
func judgeCandidates(ctx context.Context, cwd, question string, cands []candidate) []candidate {
	if len(cands) <= 1 {
		return cands
	}
	reply, err := judge(ctx, cwd, buildJudgePrompt(question, cands))
	if err != nil {
		log.Printf("[jarvisrecall] judge failed, keeping all %d candidates: %v\n", len(cands), err)
		return cands
	}
	kept := parseJudgeReply(reply, len(cands))
	if kept == nil {
		log.Printf("[jarvisrecall] judge reply unparseable (%q), keeping all %d candidates\n", reply, len(cands))
		return cands
	}
	out := make([]candidate, 0, len(kept))
	for _, i := range kept {
		out = append(out, cands[i])
	}
	return out
}
