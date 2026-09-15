package jarvis

import (
	"strings"
	"testing"
)

// Empty orchestration throughout this file is deliberate: these two guard the legacy runtime fork a
// pre-2026-09 run is still built under, so they must keep passing the shape those runs stored.
func TestBuildOrchestratePromptLegacyPiGetsTheEngineLaunchPrompt(t *testing.T) {
	p := BuildOrchestratePrompt("ship auth", nil, "pi", "")
	for _, want := range []string{"Goal: ship auth", "wsh jarvis dag submit --plan", "ask_user_question"} {
		if !strings.Contains(p, want) {
			t.Errorf("pi prompt missing %q", want)
		}
	}
	if strings.Contains(p, "import-tasks") {
		t.Errorf("pi prompt still publishes through pi-tasks")
	}
}

func TestBuildOrchestratePromptClaudeRetainsAdaptiveTriage(t *testing.T) {
	p := BuildOrchestratePrompt("ship auth", nil, "claude", "")
	for _, want := range []string{"wsh jarvis triage", "quick", "plan", "Goal: ship auth"} {
		if !strings.Contains(p, want) {
			t.Errorf("claude prompt missing %q", want)
		}
	}
	if strings.Contains(p, "wsh jarvis hold") {
		t.Errorf("claude prompt must not mention plan hold")
	}
}
