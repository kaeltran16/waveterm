// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"strings"
	"testing"
)

func TestPhasePrompt_ModeAware(t *testing.T) {
	orch := NewRun("do X", "ws", "/p", "be clean", RunMode_Orchestrator, DefaultOrchestratorPlaybook(true), 1)
	if p := phasePrompt(&orch, 0); !strings.Contains(p, "wsh jarvis hold") {
		t.Fatalf("orchestrator prompt should hold-gate:\n%s", p)
	}

	pipe := NewRun("do X", "ws", "/p", "be clean", RunMode_Pipeline, DefaultPlaybook(), 1)
	if p := phasePrompt(&pipe, 0); strings.Contains(p, "wsh jarvis") {
		t.Fatalf("pipeline prompt should not use orchestrate verbs:\n%s", p)
	}
}
