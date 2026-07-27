// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisproactive

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

var errNoClaude = fmt.Errorf("proactive relevance judge requires the claude CLI, which is not available")

// judgeRun is the inner process-runner seam. judge itself is swappable, but SetJudgeForTest replaces
// spec construction along with the call, so a test using it cannot observe which tier the real body
// selects. Overriding this instead runs the real judge and exposes the spec.
var judgeRun = consult.Run

// judge runs on the cheap tier: picking one shortlist entry or "none" is bounded
// classification, not synthesis. It returns the model's raw reply ("<n>" or "none");
// parsing is parseJudgeReply's job. A seam so tests mock it. One-shot and unstreamed,
// so the emit callback is discarded.
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

// EvaluateDispatch is the off-band, non-fatal dispatch entry. It opens the real
// index + vault and delegates to evaluate. Returns nil when embeddings are off or
// the query fails (a total no-op — run.Meta is left untouched by the caller);
// otherwise a *ProactiveSuggestion (hit or none sentinel). Contract: the caller
// dispatches this in a detached goroutine, persists a non-nil result to run.Meta,
// and logs errors.
func EvaluateDispatch(ctx context.Context, run *waveobj.Run) (*ProactiveSuggestion, error) {
	ix, err := jarvisembed.OpenIndex(ctx)
	if err != nil {
		return nil, err
	}
	defer ix.Close()
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, err
	}
	return evaluate(ctx, ix, v, run)
}

// evaluate takes an explicit index + vault so tests exercise it against a fixture
// vault + mock embedder + mock judge. Returns nil for a total no-op (index
// unavailable / query error), else a hit or a "none" sentinel.
func evaluate(ctx context.Context, ix *jarvisembed.Index, v *wavevault.Vault, run *waveobj.Run) (*ProactiveSuggestion, error) {
	if !ix.Available() {
		return nil, nil // embeddings off → total no-op (invariant 10)
	}
	chunks, err := ix.Query(ctx, v, run.Goal, queryK, wavevault.AllScope())
	if err != nil {
		if errors.Is(err, jarvisembed.ErrEmbeddingsDisabled) {
			return nil, nil
		}
		return nil, nil // a provider error degrades to no card, never fails the run (invariant 11)
	}

	cands := prefilter(chunks, ownDossierID(v, run))
	none := &ProactiveSuggestion{Status: "none"}
	if len(cands) == 0 {
		return none, nil // below the bar → sentinel, no model call
	}

	reply, err := judge(ctx, run.ProjectPath, buildJudgePrompt(run.Goal, cands))
	if err != nil {
		return none, nil // model unavailable/failed → no card, sentinel prevents recompute
	}
	pick := parseJudgeReply(reply, len(cands))
	if pick < 0 {
		return none, nil
	}
	c := cands[pick]
	return &ProactiveSuggestion{
		Status:     "hit",
		NodeID:     c.NodeID,
		SourceType: c.SourceType,
		Title:      titleForNode(v, c),
		Snippet:    c.Snippet,
		Why:        fmt.Sprintf("Related to \"%s\"", run.Goal),
	}, nil
}

// ownDossierID resolves the dossier C's dispatch capture just wrote for this run
// (the node referencing run-<oid>), so the run never resurfaces against itself.
// Empty when none is found (capture not yet indexed / failed) — harmless.
func ownDossierID(v *wavevault.Vault, run *waveobj.Run) string {
	linked, err := v.Retriever(wavevault.AllScope()).Query(wavevault.Filter{HasLink: "run-" + run.OID})
	if err != nil || len(linked) == 0 {
		return ""
	}
	return linked[0].ID
}

// titleForNode prefers the node's frontmatter objective for a human title, falling
// back to the pre-filter's section heading. One bounded read for the single chosen node.
func titleForNode(v *wavevault.Vault, c candidate) string {
	nb, err := v.Retriever(wavevault.AllScope()).Read(c.NodeID)
	if err == nil && nb != nil {
		if obj, ok := nb.Node.Frontmatter["objective"]; ok {
			if s := strings.TrimSpace(fmt.Sprintf("%v", obj)); s != "" && s != "<nil>" {
				return s
			}
		}
	}
	return c.Title
}
