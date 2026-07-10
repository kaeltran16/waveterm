// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package reporadar scans a single registered repository for evidence-backed correctness-risk
// hypotheses. It collects deterministic signals, spends one bounded model call to cluster them,
// validates the result, and tracks findings across scans. It never mutates the repository and
// never runs tests, commands, or agents. Persisted types live in pkg/waveobj.
package reporadar

import "time"

func nowMilli() int64 { return time.Now().UnixMilli() }

// scan status (mirrors waveobj.RadarReport.Status)
const (
	StatusCollecting = "collecting"
	StatusClustering = "clustering"
	StatusCompleted  = "completed"
	StatusPartial    = "partial"
	StatusFailed     = "failed"
	StatusCancelled  = "cancelled"
)

// finding lifecycle group
const (
	GroupNew        = "new"
	GroupRecurring  = "recurring"
	GroupNoLonger   = "nolonger"
	GroupDismissed  = "dismissed"
	GroupSuppressed = "suppressed"
)

// collector kinds (RadarSignal.Collector)
const (
	CollectorStructure  = "structure"
	CollectorGit        = "git"
	CollectorRuns       = "runs"
	CollectorTranscript = "transcript"
	CollectorMemory     = "memory"
	CollectorConfig     = "config"
)

// evidence strength / severity
const (
	StrengthStrong   = "strong"
	StrengthModerate = "moderate"
	StrengthLimited  = "limited"

	SeverityLow    = "low"
	SeverityMedium = "medium"
	SeverityHigh   = "high"
)

// v1 correctness-risk taxonomy
const (
	RiskTestCoverageGap     = "test-coverage-gap"
	RiskMigrationSafety     = "migration-safety"
	RiskConfigContractDrift = "configuration-contract-drift"
	RiskRepeatedFailure     = "repeated-failure-boundary"
	RiskRuntimeOnlyBehavior = "runtime-only-behavior"
	RiskCrossLayerMismatch  = "cross-layer-contract-mismatch"
)

var V1RiskKinds = []string{
	RiskTestCoverageGap, RiskMigrationSafety, RiskConfigContractDrift,
	RiskRepeatedFailure, RiskRuntimeOnlyBehavior, RiskCrossLayerMismatch,
}

// DefaultRadarPayloadBudget caps the prepared payload Radar sends to the model (estimated tokens).
// It is NOT a cap on total provider usage — Claude Code adds unmeasured runtime context.
const DefaultRadarPayloadBudget = 40_000

// MaxFindings caps New+Recurring findings surfaced per scan.
const MaxFindings = 10

func ValidRiskKind(kind string) bool {
	for _, k := range V1RiskKinds {
		if k == kind {
			return true
		}
	}
	return false
}
