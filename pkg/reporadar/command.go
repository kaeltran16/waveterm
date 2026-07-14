// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// canonPath normalizes a path for comparison (clean + forward slashes; case-fold on Windows-style
// paths is intentionally NOT applied — registry and channel paths are produced the same way).
func canonPath(p string) string {
	return filepath.ToSlash(filepath.Clean(strings.TrimSpace(p)))
}

// resolveProjectName returns the registered project name whose path matches projectPath.
// projects maps name -> registered path. Errors when projectPath is empty or unregistered.
func resolveProjectName(projectPath string, projects map[string]string) (string, error) {
	cp := canonPath(projectPath)
	if cp == "" || cp == "." {
		return "", fmt.Errorf("project path is required")
	}
	for name, regPath := range projects {
		if canonPath(regPath) == cp {
			return name, nil
		}
	}
	return "", fmt.Errorf("path is not a registered project: %s", projectPath)
}

// registeredProjects reads name->path from config.
func registeredProjects() map[string]string {
	cfg := wconfig.ReadFullConfig()
	out := make(map[string]string, len(cfg.Projects))
	for name, pk := range cfg.Projects {
		if pk.Path != "" {
			out[name] = pk.Path
		}
	}
	return out
}

// Start validates scope, rejects a concurrent scan for the same project, persists a new report,
// registers it with the manager, and kicks the background scan. Returns the new report.
func Start(ctx context.Context, projectPath string) (*waveobj.RadarReport, error) {
	name, err := resolveProjectName(projectPath, registeredProjects())
	if err != nil {
		return nil, err
	}
	if err := rejectConcurrent(ctx, projectPath); err != nil {
		return nil, err
	}
	rpt, err := wstore.CreateRadarReport(ctx, name, canonPath(projectPath))
	if err != nil {
		return nil, err
	}
	// link the previous successful report (for later cross-scan compare)
	if prev := latestSuccessful(ctx, rpt.ProjectPath); prev != nil {
		wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) {
			r.PrevReportId = prev.OID
			r.PrevHead = prev.EndHead
		})
	}
	scanCtx, ok := mgr.register(rpt.OID)
	if !ok {
		return nil, fmt.Errorf("scan already running for this report")
	}
	StartScan(scanCtx, rpt.OID)
	return wstore.GetRadarReport(ctx, rpt.OID)
}

// ListReports returns the reports for projectPath (newest-first), canonicalizing the query path so a
// caller passing a non-canonical form (e.g. a Windows backslash path from the frontend) still matches
// the canonicalized path Start persisted. An empty projectPath returns reports for ALL projects (used to
// pre-select the most-recently-scanned project); canonPath is skipped for it since it would turn "" into ".".
func ListReports(ctx context.Context, projectPath string) ([]*waveobj.RadarReport, error) {
	if strings.TrimSpace(projectPath) == "" {
		return wstore.GetRadarReports(ctx, "")
	}
	return wstore.GetRadarReports(ctx, canonPath(projectPath))
}

// rejectConcurrent errors if a report for projectPath is still collecting/clustering.
func rejectConcurrent(ctx context.Context, projectPath string) error {
	reports, err := wstore.GetRadarReports(ctx, canonPath(projectPath))
	if err != nil {
		return err
	}
	for _, r := range reports {
		if (r.Status == StatusCollecting || r.Status == StatusClustering) && mgr.active(r.OID) {
			return fmt.Errorf("a scan is already running for %s", r.ProjectName)
		}
	}
	return nil
}

func latestSuccessful(ctx context.Context, projectPath string) *waveobj.RadarReport {
	reports, _ := wstore.GetRadarReports(ctx, projectPath)
	for _, r := range reports { // newest-first
		if r.Status == StatusCompleted || r.Status == StatusPartial {
			return r
		}
	}
	return nil
}

// Cancel cancels an in-flight scan. The scan goroutine persists the cancelled state.
func Cancel(reportId string) error {
	if !mgr.cancel(reportId) {
		return fmt.Errorf("no active scan for report %s", reportId)
	}
	return nil
}

// Retry re-runs clustering for a failed report using its retained candidate signals, without
// recollecting. Rejected when the report has no retained candidates or is not in a retryable state.
func Retry(ctx context.Context, reportId string) error {
	rpt, err := wstore.GetRadarReport(ctx, reportId)
	if err != nil {
		return err
	}
	if rpt.Status != StatusFailed {
		return fmt.Errorf("report %s is not in a retryable state (%s)", reportId, rpt.Status)
	}
	if len(rpt.Candidates) == 0 {
		return fmt.Errorf("no retained candidate signals to retry")
	}
	scanCtx, ok := mgr.register(reportId)
	if !ok {
		return fmt.Errorf("a scan is already running for this report")
	}
	StartClusterOnly(scanCtx, reportId)
	return nil
}
