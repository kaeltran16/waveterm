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

// EvaluateDispatch is the off-band, non-fatal dispatch entry. It opens the real index + vault and
// delegates to evaluate. It ALWAYS returns something to persist — a hit, or a "none" naming the reason
// — even alongside a non-nil error, because a caller that persisted nothing on failure is what made six
// distinct failures indistinguishable from never having run. Contract: the caller dispatches this in a
// detached goroutine, persists the result to run.Meta regardless of the error, and logs the error.
func EvaluateDispatch(ctx context.Context, run *waveobj.Run) (*ProactiveSuggestion, error) {
	ix, err := jarvisembed.OpenIndex(ctx)
	if err != nil {
		return &ProactiveSuggestion{Status: StatusNone, Reason: ReasonIndexError}, err
	}
	defer ix.Close()
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return &ProactiveSuggestion{Status: StatusNone, Reason: ReasonVaultError}, err
	}
	return evaluate(ctx, ix, v, run)
}

// evaluate takes an explicit index + vault so tests exercise it against a fixture vault + mock embedder
// + mock judge. Never returns nil: every terminal path yields a hit or a reasoned "none" sentinel. The
// embeddings-off path deliberately breaks invariant 10 (see the package's spec) — writing one metadata
// field on a non-fatal path keeps the run protected while removing the blindness.
func evaluate(ctx context.Context, ix *jarvisembed.Index, v *wavevault.Vault, run *waveobj.Run) (*ProactiveSuggestion, error) {
	noneBecause := func(reason string) *ProactiveSuggestion {
		return &ProactiveSuggestion{Status: StatusNone, Reason: reason}
	}
	if !ix.Available() {
		return noneBecause(ReasonEmbeddingsOff), nil
	}
	chunks, err := ix.QueryPerCollection(ctx, v, run.Goal, queryKPerCollection, wavevault.AllScope())
	if err != nil {
		if errors.Is(err, jarvisembed.ErrEmbeddingsDisabled) {
			return noneBecause(ReasonEmbeddingsOff), nil
		}
		// a provider error degrades to no card, never fails the run (invariant 11)
		return noneBecause(ReasonQueryError), nil
	}

	cands := prefilter(chunks, ownDossierID(v, run))
	if len(cands) == 0 {
		return noneBecause(ReasonNoCandidates), nil // below the bar → sentinel, no model call
	}

	reply, err := judge(ctx, run.ProjectPath, buildJudgePrompt(run.Goal, cands))
	if err != nil {
		// model unavailable/failed → no card, sentinel prevents recompute
		return noneBecause(ReasonJudgeError), nil
	}
	pick := parseJudgeReply(reply, len(cands))
	if pick < 0 {
		return noneBecause(ReasonJudgeDeclined), nil
	}
	c := cands[pick]
	return &ProactiveSuggestion{
		Status:     StatusHit,
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
