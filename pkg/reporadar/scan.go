// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// StartScan runs a scan for an already-created report in a background goroutine, using the
// manager-owned cancellation context. Call only after mgr.register(reportId) succeeded.
func StartScan(scanCtx context.Context, reportId string) {
	go func() {
		defer func() { panichandler.PanicHandler("reporadar.StartScan", recover()) }()
		defer mgr.done(reportId)
		runScan(scanCtx, reportId)
	}()
}

// StartClusterOnly re-enters the scan at the clustering seam using the report's retained candidates
// (no recollection), in a background goroutine under the manager-owned context. Call only after
// mgr.register(reportId) succeeded.
func StartClusterOnly(scanCtx context.Context, reportId string) {
	go func() {
		defer func() { panichandler.PanicHandler("reporadar.StartClusterOnly", recover()) }()
		defer mgr.done(reportId)
		runClusterOnly(scanCtx, reportId)
	}()
}

// publish pushes a RadarReport update to the frontend.
func publish(reportId string) {
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_RadarReport, reportId))
}

// setStatus persists a status/phase transition and notifies the FE.
func setStatus(ctx context.Context, reportId, status, phase string) {
	if err := wstore.UpdateRadarReport(ctx, reportId, func(r *waveobj.RadarReport) {
		r.Status = status
		r.Phase = phase
	}); err != nil {
		log.Printf("reporadar: setStatus %s: %v", reportId, err)
	}
	publish(reportId)
}

// startClustering enters the clustering phase with every lens about to run queued, so the frontend can
// show which model call is in flight and for how long rather than a static screen for minutes.
func startClustering(ctx context.Context, reportId string, modes []string) {
	lenses := map[string]string{}
	for _, m := range modes {
		lenses[m] = CoverageQueued
	}
	if err := wstore.UpdateRadarReport(ctx, reportId, func(r *waveobj.RadarReport) {
		r.Status = StatusClustering
		r.Phase = "clustering"
		r.ClusterStartedTs = nowMilli()
		r.LensProgress = lenses
	}); err != nil {
		log.Printf("reporadar: startClustering %s: %v", reportId, err)
	}
	publish(reportId)
}

// lensReporter streams each lens's clustering status (running, then ok/failed) to the frontend.
func lensReporter(ctx context.Context, reportId string) func(mode, status string) {
	return func(mode, status string) {
		if err := wstore.UpdateRadarReport(ctx, reportId, func(r *waveobj.RadarReport) {
			if r.LensProgress == nil {
				r.LensProgress = map[string]string{}
			}
			r.LensProgress[mode] = status
		}); err != nil {
			return
		}
		publish(reportId)
	}
}

// collectResult aggregates one scan's collection pass.
type collectResult struct {
	signals        []waveobj.RadarSignal
	coverage       map[string]string
	partialSources []string
}

// collectAll runs every collector for the project, records per-source coverage, and returns the
// deduped signals. An inaccessible repository is fatal (returned error); optional-source failures
// are recorded as partial and do not fail the scan. onProgress is called with (kind, status) as each
// collector starts ("running") and finishes ("ok"/"failed") so the frontend checklist reflects real
// progress instead of jumping from all-queued to all-done in one step.
func collectAll(ctx context.Context, projectPath string, sinceTs int64, onProgress func(kind, status string)) (*collectResult, error) {
	if _, err := gitHead(ctx, projectPath); err != nil {
		return nil, fmt.Errorf("not a readable git repository: %w", err)
	}
	in := collectInput{projectPath: projectPath, sinceTs: sinceTs}
	res := &collectResult{coverage: map[string]string{}}
	run := func(kind string, fn func() ([]waveobj.RadarSignal, error)) {
		if ctx.Err() != nil {
			return
		}
		onProgress(kind, CoverageRunning)
		sigs, err := fn()
		if err != nil {
			res.coverage[kind] = CoverageFailed
			res.partialSources = append(res.partialSources, kind)
			onProgress(kind, CoverageFailed)
			log.Printf("reporadar: collector %s failed: %v", kind, err)
			return
		}
		res.coverage[kind] = CoverageOK
		res.signals = append(res.signals, sigs...)
		onProgress(kind, CoverageOK)
	}
	run(CollectorStructure, func() ([]waveobj.RadarSignal, error) { return collectStructure(ctx, in) })
	run(CollectorGit, func() ([]waveobj.RadarSignal, error) { return collectGit(ctx, in) })
	run(CollectorRuns, func() ([]waveobj.RadarSignal, error) { return collectRuns(ctx, in) })
	run(CollectorTranscript, func() ([]waveobj.RadarSignal, error) { return collectTranscript(ctx, in) })
	run(CollectorConfig, func() ([]waveobj.RadarSignal, error) { return collectConfig(ctx, in) })
	run(CollectorDependency, func() ([]waveobj.RadarSignal, error) { return collectDependency(ctx, in) })
	res.signals = dedupSignals(res.signals)
	return res, nil
}

// runScan is the deterministic scan sequence. Phases C–G fill the remaining seams; today it
// collects real signals, records coverage + HEAD boundaries, then completes with zero findings.
func runScan(ctx context.Context, reportId string) {
	rpt, err := wstore.GetRadarReport(ctx, reportId)
	if err != nil {
		log.Printf("reporadar: runScan load %s: %v", reportId, err)
		return
	}
	setStatus(ctx, reportId, StatusCollecting, "collecting")

	startHead, _ := gitHead(ctx, rpt.ProjectPath)
	startDirty := gitDirtyFingerprint(ctx, rpt.ProjectPath)
	sinceTs := nowMilli() - EvidenceWindow.Milliseconds()

	// stream each collector's status to the frontend as it runs, so the checklist ticks off
	// structure -> git -> ... -> config in real time rather than snapping from queued to done.
	onProgress := func(kind, status string) {
		if err := wstore.UpdateRadarReport(ctx, reportId, func(r *waveobj.RadarReport) {
			if r.Coverage == nil {
				r.Coverage = map[string]string{}
			}
			r.Coverage[kind] = status
		}); err != nil {
			return
		}
		publish(reportId)
	}
	cr, cerr := collectAll(ctx, rpt.ProjectPath, sinceTs, onProgress)
	if cerr != nil {
		finishFatal(reportId, cerr.Error())
		return
	}
	if ctx.Err() != nil {
		finishCancelled(ctx, reportId)
		return
	}
	wstore.UpdateRadarReport(ctx, reportId, func(r *waveobj.RadarReport) {
		r.StartHead = startHead
		r.StartDirty = startDirty
		r.WindowStartTs = sinceTs
		r.Coverage = cr.coverage
		r.PartialSources = cr.partialSources
		r.Candidates = cr.signals
	})
	publish(reportId)

	startClustering(ctx, reportId, V1Modes)
	if ctx.Err() != nil {
		finishCancelled(ctx, reportId)
		return
	}

	findings, modeRuns := clusterModes(ctx, rpt.ProjectName, rpt.ProjectPath, cr.signals, V1Modes, lensReporter(ctx, reportId))
	if ctx.Err() != nil {
		finishCancelled(ctx, reportId)
		return
	}
	pass := clusterPass{validated: findings, modeRuns: modeRuns, candidates: cr.signals, partialSources: cr.partialSources}
	// resolved after clustering so an investigation recorded while this scan ran is in the baseline
	if prev := latestSuccessfulExcluding(ctx, rpt.ProjectPath, reportId); prev != nil {
		pass.baseline = prev.Findings
		pass.priorSignals = prev.Signals
	}
	finalizeFindings(ctx, reportId, pass)
}

// runClusterOnly re-runs synthesis for the lenses that failed, using the report's retained candidates
// with no recollection, then finalizes. Used by Retry after a clustering failure.
func runClusterOnly(ctx context.Context, reportId string) {
	rpt, err := wstore.GetRadarReport(ctx, reportId)
	if err != nil || len(rpt.Candidates) == 0 {
		finishClusterFailed(reportId, "no retained candidates")
		return
	}
	modes := retryModes(rpt)
	startClustering(ctx, reportId, modes)
	findings, modeRuns := clusterModes(ctx, rpt.ProjectName, rpt.ProjectPath, rpt.Candidates, modes, lensReporter(ctx, reportId))
	if ctx.Err() != nil {
		// a cancelled retry leaves the report as it was, so a partial report stays the reconcile baseline
		setStatus(context.Background(), reportId, rpt.Status, "")
		return
	}
	finalizeFindings(ctx, reportId, retryPass(ctx, rpt, modes, findings, modeRuns))
}

// retryModes returns the lenses a retry reruns: those that failed to cluster, or every lens when the
// report never reached a clustering result.
func retryModes(rpt *waveobj.RadarReport) []string {
	if len(rpt.ModeRuns) == 0 {
		return V1Modes
	}
	var modes []string
	for _, r := range rpt.ModeRuns {
		if r.Status == ModeRunClusterFailed {
			modes = append(modes, r.Mode)
		}
	}
	return modes
}

// retryPass assembles finalize's input for a retry. The rerun lenses reconcile against the report's own
// findings for those lenses (carried unchanged when they failed, and holding any decision the user made
// since); every other lens keeps its findings and mode run as they are.
func retryPass(ctx context.Context, rpt *waveobj.RadarReport, rerun []string, validated []waveobj.RadarFinding, runs []waveobj.RadarModeRun) clusterPass {
	pass := clusterPass{validated: validated, candidates: rpt.Candidates, partialSources: rpt.PartialSources, priorSignals: rpt.Signals}
	prior := rpt.Findings
	if len(rpt.ModeRuns) == 0 {
		// never clustered, so the report holds no findings of its own; reconcile like a fresh scan
		if prev := latestSuccessfulExcluding(ctx, rpt.ProjectPath, rpt.OID); prev != nil {
			prior, pass.priorSignals = prev.Findings, prev.Signals
		}
	}
	rerunSet := map[string]bool{}
	for _, m := range rerun {
		rerunSet[m] = true
	}
	for _, f := range prior {
		if rerunSet[modeOf(f)] {
			pass.baseline = append(pass.baseline, f)
		} else {
			pass.untouched = append(pass.untouched, f)
		}
	}
	byMode := map[string]waveobj.RadarModeRun{}
	for _, r := range rpt.ModeRuns {
		byMode[r.Mode] = r
	}
	for _, r := range runs {
		byMode[r.Mode] = r
	}
	for _, m := range V1Modes {
		if r, ok := byMode[m]; ok {
			pass.modeRuns = append(pass.modeRuns, r)
		}
	}
	return pass
}

func finishClusterFailed(reportId, msg string) {
	wstore.UpdateRadarReport(context.Background(), reportId, func(r *waveobj.RadarReport) {
		r.Status = StatusFailed
		r.Phase = ""
		r.ClusterError = msg
		r.CompletedTs = nowMilli()
		// r.Candidates are retained (not pruned) so RetryClustering can reuse them.
	})
	publish(reportId)
}

func finishFatal(reportId, msg string) {
	wstore.UpdateRadarReport(context.Background(), reportId, func(r *waveobj.RadarReport) {
		r.Status = StatusFailed
		r.Phase = ""
		r.FatalError = msg
		r.CompletedTs = nowMilli()
	})
	publish(reportId)
}

func appendUnique(xs []string, x string) []string {
	for _, e := range xs {
		if e == x {
			return xs
		}
	}
	return append(xs, x)
}

func finishCancelled(ctx context.Context, reportId string) {
	// use context.Background(): the scan ctx is already cancelled, but we still must persist.
	wstore.UpdateRadarReport(context.Background(), reportId, func(r *waveobj.RadarReport) {
		r.Status = StatusCancelled
		r.Phase = ""
		r.CompletedTs = nowMilli()
	})
	publish(reportId)
}

// clusterModes runs each scan mode over the shared signal pool: it selects that mode's candidates,
// prepares + synthesizes + validates them, and returns the merged validated findings plus one
// RadarModeRun per mode. A mode whose synthesis fails is recorded clustering-failed and skipped; the
// loop continues so other lenses still deliver. onLens is told as each lens starts ("running") and
// finishes ("ok"/"failed").
func clusterModes(ctx context.Context, projectName, projectPath string, signals []waveobj.RadarSignal, modes []string, onLens func(mode, status string)) ([]waveobj.RadarFinding, []waveobj.RadarModeRun) {
	var merged []waveobj.RadarFinding
	var runs []waveobj.RadarModeRun
	for _, mode := range modes {
		if ctx.Err() != nil {
			return merged, runs
		}
		cand := candidatesForMode(mode, signals)
		groups, payloadTokens := prepareCandidates(cand, DefaultRadarPayloadBudget)
		run := waveobj.RadarModeRun{Mode: mode, PayloadTokens: payloadTokens}
		onLens(mode, CoverageRunning)
		resp, meta, serr := synthesize(ctx, projectName, mode, groups)
		if serr != nil && ctx.Err() != nil {
			return merged, runs
		}
		run.ResolvedModel, run.TotalTokens, run.RawResponse = meta.resolvedModel, meta.totalTokens, meta.raw
		if serr != nil {
			run.Status = ModeRunClusterFailed
			run.ClusterError = serr.Error()
			runs = append(runs, run)
			onLens(mode, CoverageFailed)
			continue
		}
		byID := map[string]waveobj.RadarSignal{}
		for _, s := range cand {
			byID[s.ID] = s
		}
		validated := validateFindings(projectPath, mode, resp, byID)
		run.Status = ModeRunCompleted
		run.FindingCount = len(validated)
		runs = append(runs, run)
		merged = append(merged, validated...)
		onLens(mode, CoverageOK)
	}
	return merged, runs
}

type modeRunAgg struct {
	anyFailed     bool
	allFailed     bool
	failedModes   map[string]bool
	estimated     bool
	clusterErr    string
	resolvedModel string
	payloadTokens int
	totalTokens   int
}

// aggregateModeRuns folds per-mode runs into the report's scan-wide fields.
func aggregateModeRuns(runs []waveobj.RadarModeRun) modeRunAgg {
	agg := modeRunAgg{allFailed: len(runs) > 0, failedModes: map[string]bool{}}
	var errs []string
	for _, r := range runs {
		agg.payloadTokens += r.PayloadTokens
		agg.totalTokens += r.TotalTokens
		if r.TokensEstimated {
			agg.estimated = true
		}
		if r.Status == ModeRunCompleted {
			agg.allFailed = false
			if agg.resolvedModel == "" {
				agg.resolvedModel = r.ResolvedModel
			}
		} else {
			agg.anyFailed = true
			agg.failedModes[r.Mode] = true
			if r.ClusterError != "" {
				errs = append(errs, r.Mode+": "+r.ClusterError)
			}
		}
	}
	agg.clusterErr = strings.Join(errs, "; ")
	return agg
}

// clusterPass is one clustering pass's input to finalize.
type clusterPass struct {
	validated      []waveobj.RadarFinding // what the clustered lenses found
	modeRuns       []waveobj.RadarModeRun // every lens's run, in V1Modes order
	candidates     []waveobj.RadarSignal
	partialSources []string
	baseline       []waveobj.RadarFinding // prior findings of the clustered lenses
	untouched      []waveobj.RadarFinding // findings of lenses a retry did not rerun, kept as they are
	priorSignals   []waveobj.RadarSignal  // evidence earlier findings cite, for the ones carried forward
}

// finalizeFindings reconciles a pass's findings against its baseline, prunes signals to the ones the
// findings cite, folds per-mode runs into the scan-wide status, and persists. It retains the candidate
// pool whenever any lens failed to cluster so Retry can reuse it.
func finalizeFindings(ctx context.Context, reportId string, pass clusterPass) {
	rpt, err := wstore.GetRadarReport(ctx, reportId)
	if err != nil {
		log.Printf("reporadar: finalize load %s: %v", reportId, err)
		return
	}
	byID := map[string]waveobj.RadarSignal{}
	for _, s := range pass.candidates {
		byID[s.ID] = s
	}
	agg := aggregateModeRuns(pass.modeRuns)
	reconciled := reconcile(pass.validated, pass.baseline, evidenceTimestamps(pass.validated, byID), agg.failedModes)
	findings := assignFindingIDs(append(append([]waveobj.RadarFinding{}, pass.untouched...), reconciled...))
	refreshInvestigations(ctx, findings)
	kept := referencedSignals(findings, pass.candidates, pass.priorSignals)

	status := StatusCompleted
	if len(pass.partialSources) > 0 || agg.anyFailed {
		status = StatusPartial
	}
	if agg.allFailed {
		status = StatusFailed
	}

	// the repository boundary belongs to the first pass; a retry reclusters that evidence, not a newer tree.
	// a boundary change is recorded, not treated as a coverage gap: every collector still ran
	firstPass := rpt.WindowEndTs == 0
	var endHead, endDirty string
	if firstPass {
		endHead, _ = gitHead(ctx, rpt.ProjectPath)
		endDirty = gitDirtyFingerprint(ctx, rpt.ProjectPath)
	}
	configured := headlessModelLabel()
	wstore.UpdateRadarReport(ctx, reportId, func(r *waveobj.RadarReport) {
		r.Findings = findings
		r.Signals = kept
		r.ModeRuns = pass.modeRuns
		r.PartialSources = pass.partialSources
		r.ConfiguredModel = configured
		r.ResolvedModel = agg.resolvedModel
		r.PayloadTokens = agg.payloadTokens
		r.TotalTokens = agg.totalTokens
		r.TotalTokensEstimated = agg.estimated
		r.ClusterError = agg.clusterErr
		if firstPass {
			r.EndHead = endHead
			r.EndDirty = endDirty
			r.WindowEndTs = nowMilli()
		}
		r.Status = status
		r.Phase = ""
		r.CompletedTs = nowMilli()
		if !agg.anyFailed {
			r.Candidates = nil // prune only when every lens succeeded
		}
	})
	publish(reportId)
	pruneReports(ctx, rpt.ProjectPath, reportId)
}

// RecoverInterruptedScans marks any report stranded in collecting/clustering (from a previous
// process) as failed with "scan-interrupted". Retained candidates remain retryable. Call once at
// wavesrv startup, after the store is initialized.
func RecoverInterruptedScans(ctx context.Context) {
	reports, err := wstore.GetRadarReports(ctx, "")
	if err != nil {
		log.Printf("reporadar: recover: %v", err)
		return
	}
	for _, r := range reports {
		if r.Status == StatusCollecting || r.Status == StatusClustering {
			wstore.UpdateRadarReport(ctx, r.OID, func(rr *waveobj.RadarReport) {
				rr.Status = StatusFailed
				rr.Phase = ""
				rr.FatalError = "scan-interrupted"
				rr.CompletedTs = nowMilli()
			})
		}
	}
}

// latestSuccessfulExcluding returns the newest completed/partial report for projectPath other than
// exceptId — the baseline the current scan reconciles against.
func latestSuccessfulExcluding(ctx context.Context, projectPath, exceptId string) *waveobj.RadarReport {
	reports, _ := wstore.GetRadarReports(ctx, projectPath)
	for _, r := range reports {
		if r.OID == exceptId {
			continue
		}
		if r.Status == StatusCompleted || r.Status == StatusPartial {
			return r
		}
	}
	return nil
}

// pruneReports deletes a project's reports beyond the newest ReportsKeptPerProject. It keeps, whatever
// their age, the latest successful report (the next scan's baseline), the report just finalized, and any
// report with a scan in flight.
func pruneReports(ctx context.Context, projectPath, finalizedId string) {
	reports, err := wstore.GetRadarReports(ctx, projectPath)
	if err != nil {
		log.Printf("reporadar: listing reports to prune for %s: %v", projectPath, err)
		return
	}
	baselineId := ""
	for _, r := range reports { // newest-first
		if r.Status == StatusCompleted || r.Status == StatusPartial {
			baselineId = r.OID
			break
		}
	}
	for i, r := range reports {
		if i < ReportsKeptPerProject || r.OID == baselineId || r.OID == finalizedId || mgr.active(r.OID) {
			continue
		}
		if err := wstore.DeleteRadarReport(ctx, r.OID); err != nil {
			log.Printf("reporadar: pruning report %s: %v", r.OID, err)
		}
	}
}
