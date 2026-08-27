package jarvis

import (
	"strings"
	"testing"
)

func TestBuildOrchestratePromptPiPublishesTypedTasksAutonomously(t *testing.T) {
	p := BuildOrchestratePrompt("ship auth", nil, "pi")
	for _, want := range []string{
		"wsh jarvis dag import-tasks",
		"wsh jarvis dag status",
		"respond to control events",
		"task-specific goal",
		"relevant evidence",
		"verification",
		"pinned decisions",
		"Goal: ship auth",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("pi prompt missing %q", want)
		}
	}
	for _, unwanted := range []string{"hold <plan-file-path>", "wait for human approval", "plan review"} {
		if strings.Contains(strings.ToLower(p), strings.ToLower(unwanted)) {
			t.Errorf("pi prompt retained plan approval %q", unwanted)
		}
	}
}

func TestBuildOrchestratePromptClaudeRetainsAdaptiveTriage(t *testing.T) {
	p := BuildOrchestratePrompt("ship auth", nil, "claude")
	for _, want := range []string{"wsh jarvis triage", "quick", "plan", "Goal: ship auth"} {
		if !strings.Contains(p, want) {
			t.Errorf("claude prompt missing %q", want)
		}
	}
	if strings.Contains(p, "wsh jarvis hold") {
		t.Errorf("claude prompt must not mention plan hold")
	}
}
