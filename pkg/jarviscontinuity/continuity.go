// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarviscontinuity

import (
	"context"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

var errNoClaude = fmt.Errorf("continuity summary requires the claude CLI, which is not available")

// summarize is the one model call (the capable model — tiering is deferred). A seam so tests mock it.
// Capture is one-shot and unstreamed, so the emit callback is discarded.
var summarize = func(ctx context.Context, cwd, prompt string) (string, error) {
	spec, ok := consult.SpecFor("claude")
	if !ok {
		return "", errNoClaude
	}
	return consult.Run(ctx, spec, cwd, prompt, func(string) {})
}

// SetSummarizeForTest swaps the model call; returns the previous value for restore.
func SetSummarizeForTest(fn func(ctx context.Context, cwd, prompt string) (string, error)) func(context.Context, string, string) (string, error) {
	old := summarize
	summarize = fn
	return old
}

// IsRestState reports whether a run status is a boundary E captures at: the run has come to rest and
// the human will want to know where it stands. planning/executing are in-flight; cancelled is abandoned.
func IsRestState(status string) bool {
	switch status {
	case jarvis.RunStatus_AwaitingReview, jarvis.RunStatus_Blocked, jarvis.RunStatus_Done:
		return true
	}
	return false
}

// restReason maps a run status to the human-readable narrative rest reason.
func restReason(status string) string {
	switch status {
	case jarvis.RunStatus_Done:
		return restCompleted
	case jarvis.RunStatus_Blocked:
		return restBlocked
	default:
		return restAwaitingReview
	}
}

// dossierStatus maps a run rest status to the dossier status B understands.
func dossierStatus(status string) string {
	if status == jarvis.RunStatus_Done {
		return "completed"
	}
	return "paused"
}

// CaptureRunBoundary writes the dossier's narrative state summary + status at a run rest boundary,
// against the default vault. Contract: the caller dispatches this off-band and logs errors (it makes a
// model call and must never block/fail a run transition).
func CaptureRunBoundary(ctx context.Context, run *waveobj.Run) error {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return err
	}
	return captureRunBoundary(ctx, v, run)
}

// captureRunBoundary takes an explicit vault so tests exercise it against a fixture vault. No-op if no
// dossier references the run (C's dispatch capture is the only creator — E never creates).
func captureRunBoundary(ctx context.Context, v *wavevault.Vault, run *waveobj.Run) error {
	r := v.Retriever(wavevault.AllScope())
	linked, err := r.Query(wavevault.Filter{HasLink: "run-" + run.OID})
	if err != nil {
		return err
	}
	if len(linked) == 0 {
		return nil
	}
	id := linked[0].ID
	d, err := jarvisdossier.LoadDossier(r, id)
	if err != nil {
		return err
	}

	facts := assembleFacts(r, d, run)
	narrative := terseState(facts)
	if facts.hasActivity() {
		out, serr := summarize(ctx, run.ProjectPath, buildSummaryPrompt(facts))
		if serr != nil {
			return serr
		}
		if s := strings.TrimSpace(out); s != "" {
			narrative = s
		}
	}

	res, err := jarvisdossier.SetState(v, id, narrative, d.Hash)
	if err != nil {
		return err
	}
	if res.Conflict {
		return nil // a concurrent human edit won; do not clobber (invariant 5). Next boundary retries.
	}
	if _, err := jarvisdossier.SetStatus(v, id, dossierStatus(run.Status), res.Hash); err != nil {
		return err
	}
	return v.Commit(ctx, "jarvis: continuity summary for run "+run.OID)
}

// assembleFacts gathers the deterministic narrative inputs: the dossier's objective + non-empty
// blockers, the triggering run's outcome, and the rationale of each referenced decision (dangling
// refs are skipped, not fatal). Pure reads — no model.
func assembleFacts(r *wavevault.Retriever, d *jarvisdossier.Dossier, run *waveobj.Run) SummaryFacts {
	var blockers []string
	for _, b := range d.Blockers {
		if strings.TrimSpace(b) != "" {
			blockers = append(blockers, b)
		}
	}
	var decisions []string
	for _, ref := range d.Refs {
		if !strings.HasPrefix(ref, "dec-") {
			continue
		}
		if dec, err := jarvisdossier.LoadDecision(r, ref); err == nil {
			if s := strings.TrimSpace(dec.Rationale); s != "" {
				decisions = append(decisions, s)
			}
		}
	}
	return SummaryFacts{
		Objective:    d.Objective,
		RestReason:   restReason(run.Status),
		Blockers:     blockers,
		Decisions:    decisions,
		RunGoal:      run.Goal,
		RunStatus:    run.Status,
		HasEndCommit: run.EndCommit != "",
	}
}

// Narrative is the continuity view E serves — the precomputed state prose plus the machine status and
// referenced runs. This realizes the meta spec's resume(task) seam.
type Narrative struct {
	Summary string
	Status  string
	Updated int64
	RunRefs []string
}

// Resume reads the precomputed continuity narrative for a task. Pure, deterministic, free (no model):
// it returns whatever E last wrote at a boundary. No wired v1 consumer — recall reads the state block
// during ordinary traversal; this is the named seam for a later ambient/UI slice.
func Resume(r *wavevault.Retriever, taskID string) (Narrative, error) {
	d, err := jarvisdossier.LoadDossier(r, taskID)
	if err != nil {
		return Narrative{}, err
	}
	var runRefs []string
	for _, ref := range d.Refs {
		if strings.HasPrefix(ref, "run-") {
			runRefs = append(runRefs, ref)
		}
	}
	return Narrative{Summary: d.State, Status: d.Status, Updated: d.Updated, RunRefs: runRefs}, nil
}
