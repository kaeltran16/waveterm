package orchestrate

import (
	"strings"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

const (
	FailureKindToolError     = "tool_call_error"
	FailureKindContextWindow = "context-window"
	FailureKindTimeout       = "timeout"
	FailureKindGateSendback  = "gate-sendback"
	FailureKindTestFailed    = "test-failed"
	FailureKindUnknown       = "unknown"
)

// Dispatch failure kinds. These never come from classifyFailure — the task died before it had a
// child run or a transcript to classify, so the engine names the step that failed instead.
const (
	FailureKindRoute      = "route-unresolved"
	FailureKindHarness    = "harness-missing"
	FailureKindWorktree   = "worktree-failed"
	FailureKindSpawn      = "spawn-failed"
	FailureKindWorkerExit = "worker-exit-unreported"
)

// MaxFailureDetailLen bounds the failure message carried on a lifecycle event.
const MaxFailureDetailLen = 200

func classifyFailure(summary string, exitCode int) string {
	s := strings.ToLower(summary)
	switch {
	case strings.Contains(s, "context window"), strings.Contains(s, "context limit"), strings.Contains(s, "length of your submission exceeds"):
		return FailureKindContextWindow
	case strings.Contains(s, "timeout"), strings.Contains(s, "timed out"):
		return FailureKindTimeout
	case strings.Contains(s, "sendback"), strings.Contains(s, "too hard"), strings.Contains(s, "out of scope"):
		return FailureKindGateSendback
	// bare "tests:" dropped: it matched passing summaries like "tests: 12 passed"
	case strings.Contains(s, "test failed"), strings.Contains(s, "not passing"), strings.Contains(s, "check failed"):
		return FailureKindTestFailed
	case strings.Contains(s, "tool call"), strings.Contains(s, "function call"), strings.Contains(s, "tool errored"):
		return FailureKindToolError
	case strings.Contains(s, "mcp") && (strings.Contains(s, "error") || strings.Contains(s, "failed")):
		return FailureKindToolError
	default:
		_ = exitCode
		return FailureKindUnknown
	}
}

func retryDecision(kind string, attempts int) bool {
	return kind == FailureKindToolError && attempts == 0
}

// escalateDecision reports whether a failure should auto-repin the task one tier up instead of
// failing it outright. Only context-window qualifies: retrying the identical route is guaranteed to
// hit the same wall, and a larger context is a property of the model, not of the attempt. Bounded by
// the same single-escalation cap the human path enforces, so a task can auto-escalate at most once
// and then stops for a human either way.
func escalateDecision(kind string, escalations int) bool {
	return kind == FailureKindContextWindow && escalations == 0
}

// nextTier returns the tier one step above current, or "" when there is none (already capable, or
// the route is pinned to an exact model and has no tier to step).
func nextTier(current string) string {
	switch current {
	case string(consult.TierCheap):
		return string(consult.TierMid)
	case string(consult.TierMid):
		return string(consult.TierCapable)
	}
	return ""
}

func isHigherTier(current, target string) bool {
	cheap, mid, capable := string(consult.TierCheap), string(consult.TierMid), string(consult.TierCapable)
	return current == cheap && (target == mid || target == capable) || current == mid && target == capable
}
