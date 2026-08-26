package orchestrate

import (
	"fmt"
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

func nextTier(tier string) (string, error) {
	switch tier {
	case string(consult.TierCheap):
		return string(consult.TierMid), nil
	case string(consult.TierMid):
		return string(consult.TierCapable), nil
	case string(consult.TierCapable):
		return "", fmt.Errorf("tier %q is already the top tier", tier)
	default:
		return "", fmt.Errorf("unknown tier %q", tier)
	}
}

func isHigherTier(current, target string) bool {
	cheap, mid, capable := string(consult.TierCheap), string(consult.TierMid), string(consult.TierCapable)
	return current == cheap && (target == mid || target == capable) || current == mid && target == capable
}
