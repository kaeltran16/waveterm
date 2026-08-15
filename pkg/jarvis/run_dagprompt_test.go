package jarvis

import (
	"strings"
	"testing"
)

func TestBuildOrchestratePromptPiHasDagVerbs(t *testing.T) {
	p := BuildOrchestratePrompt("ship auth", nil, true, "pi")
	for _, want := range []string{"wsh jarvis dag import-tasks", "wsh jarvis dag status", "respond to control events", "Goal: ship auth"} {
		if !strings.Contains(p, want) {
			t.Errorf("pi prompt missing %q", want)
		}
	}
	if strings.Contains(p, "typed into your terminal") {
		t.Errorf("pi prompt must not carry the claude babysitting language")
	}
}

func TestBuildOrchestratePromptClaudeUnchanged(t *testing.T) {
	p := BuildOrchestratePrompt("ship auth", nil, true, "claude")
	if strings.Contains(p, "wsh jarvis dag import-tasks") {
		t.Errorf("claude prompt must not mention dag verbs")
	}
	if !strings.Contains(p, "Goal: ship auth") {
		t.Errorf("claude prompt must carry the goal")
	}
}
