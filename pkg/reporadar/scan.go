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
func collectAll(ctx context.Context, projectName, projectPath string, sinceTs int64, onProgress func(kind, status string)) (*collectResult, error) {
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
	run(CollectorMemory, func() ([]waveobj.RadarSignal, error) { return collectMemory(ctx, in, projectName) })
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
	sinceTs := int64(0)
	if rpt.PrevReportId != "" {
		if prev, perr := wstore.GetRadarReport(ctx, rpt.PrevReportId); perr == nil {
			sinceTs = prev.CompletedTs
		}
	}

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
	cr, cerr := collectAll(ctx, rpt.ProjectName, rpt.ProjectPath, sinceTs, onProgress)
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

	setStatus(ctx, reportId, StatusClustering, "clustering")
	if ctx.Err() != nil {
		finishCancelled(ctx, reportId)
		return
	}

	findings, modeRuns := clusterModes(ctx, rpt.ProjectName, rpt.ProjectPath, cr.signals, V1Modes, synthStreamFn)
	if ctx.Err() != nil {
		finishCancelled(ctx, reportId)
		return
	}
	finalizeFindings(ctx, reportId, findings, modeRuns, cr.signals, cr.partialSources)
}

// synthStreamFn is the model runner used by runScan. Production defaults to runSonnet; tests
// override it with an injected fake so the suite never spends the real CLI/tokens.
var synthStreamFn streamFn = runSonnet

// runClusterOnly re-runs synthesis + finalize using a report's retained candidates, with no
// recollection. Used by Retry after a clustering failure.
func runClusterOnly(ctx context.Context, reportId string) {
	rpt, err := wstore.GetRadarReport(ctx, reportId)
	if err != nil || len(rpt.Candidates) == 0 {
		finishClusterFailed(reportId, "no retained candidates")
		return
	}
	setStatus(ctx, reportId, StatusClustering, "clustering")
	findings, modeRuns := clusterModes(ctx, rpt.ProjectName, rpt.ProjectPath, rpt.Candidates, V1Modes, synthStreamFn)
	if ctx.Err() != nil {
		finishCancelled(ctx, reportId)
		return
	}
	finalizeFindings(ctx, reportId, findings, modeRuns, rpt.Candidates, rpt.PartialSources)
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
// loop continues so other lenses still deliver.
func clusterModes(ctx context.Context, projectName, projectPath string, signals []waveobj.RadarSignal, modes []string, fn streamFn) ([]waveobj.RadarFinding, []waveobj.RadarModeRun) {
	var merged []waveobj.RadarFinding
	var runs []waveobj.RadarModeRun
	for _, mode := range modes {
		if ctx.Err() != nil {
			return merged, runs
		}
		cand := candidatesForMode(mode, signals)
		groups, payloadTokens := prepareCandidates(cand, DefaultRadarPayloadBudget)
		run := waveobj.RadarModeRun{Mode: mode, PayloadTokens: payloadTokens}
		resp, stream, serr := synthesize(ctx, projectName, mode, groups, fn)
		if serr != nil {
			if ctx.Err() != nil {
				return merged, runs
			}
			run.Status = ModeRunClusterFailed
			run.ClusterError = serr.Error()
			runs = append(runs, run)
			continue
		}
		byID := map[string]waveobj.RadarSignal{}
		for _, s := range cand {
			byID[s.ID] = s
		}
		validated := validateFindings(projectPath, mode, resp, byID)
		run.Status = ModeRunCompleted
		run.ResolvedModel = stream.modelID
		run.TotalTokens = stream.totalTokens
		run.TokensEstimated = !stream.haveUsage
		run.FindingCount = len(validated)
		runs = append(runs, run)
		merged = append(merged, validated...)
	}
	return merged, runs
}

type modeRunAgg struct {
	anyFailed     bool
	allFailed     bool
	estimated     bool
	clusterErr    string
	resolvedModel string
	payloadTokens int
	totalTokens   int
}

// aggregateModeRuns folds per-mode runs into the report's scan-wide fields.
func aggregateModeRuns(runs []waveobj.RadarModeRun) modeRunAgg {
	agg := modeRunAgg{allFailed: len(runs) > 0}
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
			if r.ClusterError != "" {
				errs = append(errs, r.Mode+": "+r.ClusterError)
			}
		}
	}
	agg.clusterErr = strings.Join(errs, "; ")
	return agg
}

// finalizeFindings reconciles the merged validated findings against the previous successful report,
// prunes candidates to referenced signals, folds per-mode runs into the scan-wide status, and
// persists. It retains the candidate pool whenever any lens failed to cluster so Retry can reuse it.
func finalizeFindings(ctx context.Context, reportId string, validated []waveobj.RadarFinding, modeRuns []waveobj.RadarModeRun, candidates []waveobj.RadarSignal, partialSources []string) {
	rpt, err := wstore.GetRadarReport(ctx, reportId)
	if err != nil {
		log.Printf("reporadar: finalize load %s: %v", reportId, err)
		return
	}
	byID := map[string]waveobj.RadarSignal{}
	for _, s := range candidates {
		byID[s.ID] = s
	}

	evidenceTs := map[string]int64{}
	for _, f := range validated {
		var max int64
		for _, id := range f.SignalIDs {
			if s, ok := byID[id]; ok && s.ObservedTs > max {
				max = s.ObservedTs
			}
		}
		evidenceTs[f.Fingerprint] = max
	}

	prev := latestSuccessfulExcluding(ctx, rpt.ProjectPath, reportId)
	reconciled := reconcile(rpt.ProjectPath, validated, prev, evidenceTs)

	refIDs := map[string]bool{}
	for _, f := range reconciled {
		for _, id := range f.SignalIDs {
			refIDs[id] = true
		}
	}
	var kept []waveobj.RadarSignal
	for _, s := range candidates {
		if refIDs[s.ID] {
			kept = append(kept, s)
		}
	}

	agg := aggregateModeRuns(modeRuns)
	status := StatusCompleted
	if len(partialSources) > 0 || agg.anyFailed {
		status = StatusPartial
	}
	if agg.allFailed {
		status = StatusFailed
	}

	endHead, _ := gitHead(ctx, rpt.ProjectPath)
	endDirty := gitDirtyFingerprint(ctx, rpt.ProjectPath)
	if status != StatusFailed && ((rpt.StartHead != "" && endHead != "" && rpt.StartHead != endHead) || rpt.StartDirty != endDirty) {
		status = StatusPartial
		partialSources = appendUnique(partialSources, "repository-changed")
	}
	wstore.UpdateRadarReport(ctx, reportId, func(r *waveobj.RadarReport) {
		r.Findings = reconciled
		r.Signals = kept
		r.ModeRuns = modeRuns
		r.PartialSources = partialSources
		r.ConfiguredModel = ConfiguredRadarModel
		r.ResolvedModel = agg.resolvedModel
		r.PayloadTokens = agg.payloadTokens
		r.TotalTokens = agg.totalTokens
		r.TotalTokensEstimated = agg.estimated
		r.ClusterError = agg.clusterErr
		r.EndHead = endHead
		r.EndDirty = endDirty
		r.WindowEndTs = nowMilli()
		r.Status = status
		r.Phase = ""
		r.CompletedTs = nowMilli()
		if !agg.anyFailed {
			r.Candidates = nil // prune only when every lens succeeded
		}
	})
	publish(reportId)
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
