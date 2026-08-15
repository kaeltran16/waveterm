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
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

var errNoRuntime = fmt.Errorf("continuity summary requires a headless runtime, which is not available")

// summarize is the one model call. It runs on the cheap tier: the narrative is mechanical prose over
// facts assembleFacts already gathered deterministically, not synthesis, and boundaries fire once per
// rest transition on every run. A seam so tests mock it; capture is one-shot and unstreamed, so the
// emit callback is discarded.
var summarize = func(ctx context.Context, cwd, prompt string) (string, error) {
	spec, ok := consult.HeadlessSpecForTier(consult.TierCheap)
	if !ok {
		return "", errNoRuntime
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
// against the default vault, and returns the resume card for that dossier (nil when there is nothing
// to resurface). Contract: the caller dispatches this off-band and logs errors (it makes a model call
// and must never block/fail a run transition).
func CaptureRunBoundary(ctx context.Context, run *waveobj.Run) (*ResumeCard, error) {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, err
	}
	return captureRunBoundary(ctx, v, run)
}

// captureRunBoundary takes an explicit vault so tests exercise it against a fixture vault. No-op if no
// dossier references the run (C's dispatch capture is the only creator — E never creates).
func captureRunBoundary(ctx context.Context, v *wavevault.Vault, run *waveobj.Run) (*ResumeCard, error) {
	r := v.Retriever(wavevault.AllScope())
	linked, err := r.Query(wavevault.Filter{HasLink: "run-" + run.OID})
	if err != nil {
		return nil, err
	}
	if len(linked) == 0 {
		return nil, nil
	}
	id := linked[0].ID
	d, err := jarvisdossier.LoadDossier(r, id)
	if err != nil {
		return nil, err
	}

	facts := assembleFacts(r, d, run)
	narrative := terseState(facts)
	if facts.hasActivity() {
		out, serr := summarize(ctx, run.ProjectPath, buildSummaryPrompt(facts))
		if serr != nil {
			return nil, serr
		}
		if s := strings.TrimSpace(out); s != "" {
			narrative = s
		}
	}

	res, err := jarvisdossier.SetState(v, id, narrative, d.Hash)
	if err != nil {
		return nil, err
	}
	if res.Conflict {
		// a concurrent human edit won; do not clobber (invariant 5). Next boundary retries — but the
		// human's text is now the truth about where this stands, so still surface it.
		return resumeCard(v, id)
	}
	if _, err := jarvisdossier.SetStatus(v, id, dossierStatus(run.Status), res.Hash); err != nil {
		return nil, err
	}
	if err := v.Commit(ctx, "jarvis: continuity summary for run "+run.OID); err != nil {
		return nil, err
	}
	return resumeCard(v, id)
}

// resumeCard reads the committed dossier back through Resume — the named E seam — so the card carries
// exactly what a Tasks-surface reader sees rather than what this boundary happened to compute. The
// retriever must be fresh: Retriever caches its graph on first load, so the one used above predates
// the writes.
func resumeCard(v *wavevault.Vault, id string) (*ResumeCard, error) {
	n, err := Resume(v.Retriever(wavevault.AllScope()), id)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(n.Summary) == "" {
		return nil, nil // nothing worth resurfacing
	}
	return &ResumeCard{TaskID: id, Summary: n.Summary, Status: n.Status, Updated: n.Updated}, nil
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

// MetaKeyResume is the run.Meta key holding the resume card written at the run's rest boundary.
// Hand-kept contract mirrored on the frontend (view/agents/resume.ts) — keep identical.
const MetaKeyResume = "jarvis:resume"

// MetaKeyResumeDismissed is the run.Meta bool the frontend sets when the human dismisses the card. A
// later boundary clears it: the narrative has changed, so it is worth showing again.
const MetaKeyResumeDismissed = "jarvis:resume:dismissed"

// ResumeCard is the run.Meta payload — "where this task stands", already written at the boundary so
// rendering it costs no model call. Written by Go, read by TS: json tags are the wire contract.
type ResumeCard struct {
	TaskID  string `json:"taskId"`
	Summary string `json:"summary"`
	Status  string `json:"status"`
	Updated int64  `json:"updated"`
}

// ReadResumeCard decodes the narrative persisted at a run's rest boundary, honoring the human's
// dismissal. run.Meta round-trips through the object store as JSON, so the struct written at the boundary
// comes back as a map. This mirrors the frontend reader (view/agents/resume.ts) exactly — including
// treating an empty summary as nothing to resurface — so the two cannot disagree about what is showable.
func ReadResumeCard(run *waveobj.Run) (ResumeCard, bool) {
	if run == nil || run.Meta == nil {
		return ResumeCard{}, false
	}
	if dismissed, ok := run.Meta[MetaKeyResumeDismissed].(bool); ok && dismissed {
		return ResumeCard{}, false
	}
	raw, ok := run.Meta[MetaKeyResume]
	if !ok || raw == nil {
		return ResumeCard{}, false
	}
	var card ResumeCard
	if err := utilfn.ReUnmarshal(&card, raw); err != nil {
		return ResumeCard{}, false
	}
	card.Summary = strings.TrimSpace(card.Summary)
	if card.Summary == "" {
		return ResumeCard{}, false
	}
	return card, true
}

// Resume reads the precomputed continuity narrative for a task. Pure, deterministic, free (no model):
// it returns whatever E last wrote at a boundary. Consumed by resumeCard at the rest boundary, and
// available to any later surface that wants "pick up where you left off" without a fresh call.
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
