// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"fmt"
	"log"

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
// are recorded as partial and do not fail the scan.
func collectAll(ctx context.Context, projectName, projectPath string, sinceTs int64) (*collectResult, error) {
	if _, err := gitHead(ctx, projectPath); err != nil {
		return nil, fmt.Errorf("not a readable git repository: %w", err)
	}
	in := collectInput{projectPath: projectPath, sinceTs: sinceTs}
	res := &collectResult{coverage: map[string]string{}}
	run := func(kind string, fn func() ([]waveobj.RadarSignal, error)) {
		if ctx.Err() != nil {
			return
		}
		sigs, err := fn()
		if err != nil {
			res.coverage[kind] = "failed"
			res.partialSources = append(res.partialSources, kind)
			log.Printf("reporadar: collector %s failed: %v", kind, err)
			return
		}
		res.coverage[kind] = "ok"
		res.signals = append(res.signals, sigs...)
	}
	run(CollectorStructure, func() ([]waveobj.RadarSignal, error) { return collectStructure(ctx, in) })
	run(CollectorGit, func() ([]waveobj.RadarSignal, error) { return collectGit(ctx, in) })
	run(CollectorRuns, func() ([]waveobj.RadarSignal, error) { return collectRuns(ctx, in) })
	run(CollectorTranscript, func() ([]waveobj.RadarSignal, error) { return collectTranscript(ctx, in) })
	run(CollectorMemory, func() ([]waveobj.RadarSignal, error) { return collectMemory(ctx, in, projectName) })
	run(CollectorConfig, func() ([]waveobj.RadarSignal, error) { return collectConfig(ctx, in) })
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

	cr, cerr := collectAll(ctx, rpt.ProjectName, rpt.ProjectPath, sinceTs)
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

	groups, payloadTokens := prepareCandidates(cr.signals, DefaultRadarPayloadBudget)
	wstore.UpdateRadarReport(ctx, reportId, func(r *waveobj.RadarReport) {
		r.PayloadTokens = payloadTokens
	})
	publish(reportId)

	setStatus(ctx, reportId, StatusClustering, "clustering")
	if ctx.Err() != nil {
		finishCancelled(ctx, reportId)
		return
	}

	resp, stream, serr := synthesize(ctx, rpt.ProjectName, groups, synthStreamFn)
	if serr != nil {
		if ctx.Err() != nil {
			finishCancelled(ctx, reportId)
			return
		}
		finishClusterFailed(reportId, serr.Error())
		return
	}
	wstore.UpdateRadarReport(ctx, reportId, func(r *waveobj.RadarReport) {
		r.ConfiguredModel = ConfiguredRadarModel
		r.ResolvedModel = stream.modelID
		r.TotalTokens = stream.totalTokens
		r.TotalTokensEstimated = !stream.haveUsage
	})

	finalizeFindings(ctx, reportId, resp, cr.signals, cr.partialSources)
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
	groups, _ := prepareCandidates(rpt.Candidates, DefaultRadarPayloadBudget)
	resp, stream, serr := synthesize(ctx, rpt.ProjectName, groups, synthStreamFn)
	if serr != nil {
		if ctx.Err() != nil {
			finishCancelled(ctx, reportId)
			return
		}
		finishClusterFailed(reportId, serr.Error())
		return
	}
	wstore.UpdateRadarReport(ctx, reportId, func(r *waveobj.RadarReport) {
		r.ConfiguredModel = ConfiguredRadarModel
		r.ResolvedModel = stream.modelID
		r.TotalTokens = stream.totalTokens
		r.TotalTokensEstimated = !stream.haveUsage
		r.ClusterError = ""
	})
	finalizeFindings(ctx, reportId, resp, rpt.Candidates, rpt.PartialSources)
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

// finalizeFindings validates the model response against the candidate signals, reconciles against
// the previous successful report, prunes candidates down to only the signals referenced by findings,
// and persists a completed (or partial) report.
func finalizeFindings(ctx context.Context, reportId string, resp *SynthResponse, candidates []waveobj.RadarSignal, partialSources []string) {
	rpt, err := wstore.GetRadarReport(ctx, reportId)
	if err != nil {
		log.Printf("reporadar: finalize load %s: %v", reportId, err)
		return
	}
	byID := map[string]waveobj.RadarSignal{}
	for _, s := range candidates {
		byID[s.ID] = s
	}
	validated := validateFindings(rpt.ProjectPath, resp, byID)

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

	// prune: keep only signals referenced by findings that live in this report's candidates
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

	status := StatusCompleted
	if len(partialSources) > 0 {
		status = StatusPartial
	}
	endHead, _ := gitHead(ctx, rpt.ProjectPath)
	endDirty := gitDirtyFingerprint(ctx, rpt.ProjectPath)
	if (rpt.StartHead != "" && endHead != "" && rpt.StartHead != endHead) || rpt.StartDirty != endDirty {
		status = StatusPartial
		partialSources = appendUnique(partialSources, "repository-changed")
	}
	wstore.UpdateRadarReport(ctx, reportId, func(r *waveobj.RadarReport) {
		r.Findings = reconciled
		r.Signals = kept
		r.Candidates = nil // pruned after successful synthesis
		r.PartialSources = partialSources
		r.EndHead = endHead
		r.EndDirty = endDirty
		r.WindowEndTs = nowMilli()
		r.Status = status
		r.Phase = ""
		r.CompletedTs = nowMilli()
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
