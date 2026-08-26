package orchestrate

import "testing"

func TestClassifyFailure(t *testing.T) {
	cases := []struct {
		summary string
		exit    int
		want    string
	}{
		{"context window exceeded", 1, FailureKindContextWindow},
		{"request timed out after 300s", 1, FailureKindTimeout},
		{"lead sendback: out of scope", 1, FailureKindGateSendback},
		{"tests: TestFoo still failing", 1, FailureKindTestFailed},
		{"tool call errored: invalid input schema", 2, FailureKindToolError},
		{"mcp tool returned an error", 2, FailureKindToolError},
		{"mcp server initialized before process exit", 1, FailureKindUnknown},
		{"assert calls=2, got calls=3", 1, FailureKindUnknown},
		{"", 1, FailureKindUnknown},
	}
	for _, tc := range cases {
		if got := classifyFailure(tc.summary, tc.exit); got != tc.want {
			t.Errorf("classifyFailure(%q, %d) = %q, want %q", tc.summary, tc.exit, got, tc.want)
		}
	}
}

func TestRetryDecision(t *testing.T) {
	if !retryDecision(FailureKindToolError, 0) {
		t.Fatal("first tool failure must retry")
	}
	if retryDecision(FailureKindToolError, 1) {
		t.Fatal("second consecutive tool failure must block")
	}
	for _, kind := range []string{FailureKindContextWindow, FailureKindTimeout, FailureKindGateSendback, FailureKindTestFailed, FailureKindUnknown} {
		if retryDecision(kind, 0) {
			t.Fatalf("%s must block on its first failure", kind)
		}
	}
}

func TestTierPolicy(t *testing.T) {
	if got, err := nextTier("cheap"); err != nil || got != "mid" {
		t.Fatalf("cheap -> %q, %v", got, err)
	}
	if got, err := nextTier("mid"); err != nil || got != "capable" {
		t.Fatalf("mid -> %q, %v", got, err)
	}
	if _, err := nextTier("capable"); err == nil {
		t.Fatal("capable must have no next tier")
	}
	if !isHigherTier("cheap", "mid") || !isHigherTier("cheap", "capable") || !isHigherTier("mid", "capable") {
		t.Fatal("valid upward hops rejected")
	}
	if isHigherTier("mid", "mid") || isHigherTier("mid", "cheap") || isHigherTier("capable", "capable") {
		t.Fatal("same-tier or downward escalation accepted")
	}
}
