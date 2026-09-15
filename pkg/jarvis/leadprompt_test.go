// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"strings"
	"testing"
)

func TestAskToolByRuntime(t *testing.T) {
	cases := map[string]string{"claude": "AskUserQuestion", "pi": "ask_user_question", "": "AskUserQuestion"}
	for runtime, want := range cases {
		if got := AskTool(runtime); got != want {
			t.Fatalf("AskTool(%q) = %q, want %q", runtime, got, want)
		}
	}
}

// the launch prompt is the whole goal-run protocol: a lead not told the submit command, the ask tool or
// the plan format either never reaches the engine or reaches it with a plan the parser rejects.
func TestEngineLaunchPromptCarriesTheGoalRunProtocol(t *testing.T) {
	for runtime, tool := range map[string]string{"claude": "AskUserQuestion", "pi": "ask_user_question"} {
		p := BuildOrchestratePrompt("ship auth", nil, runtime, Orchestration_Engine)
		for _, want := range []string{
			"Goal: ship auth",
			"superpowers:brainstorming",
			tool,
			"- spike:",
			"- bounded:",
			"- architectural:",
			"superpowers:writing-plans",
			"wsh jarvis dag submit --plan <plan path> --spec <spec path>",
			"wsh jarvis complete --commit $(git rev-parse HEAD)",
			// the builder trims the prompt's trailing newline, which PlanFormat ends with
			strings.TrimRight(PlanFormat, "\n"),
		} {
			if !strings.Contains(p, want) {
				t.Fatalf("%s launch prompt missing %q:\n%s", runtime, want, p)
			}
		}
	}
}

// the old engine prompt's planning protocol goes with it: JSON submit, pi-tasks, triage, the task cap
// and the human's width all belong to a lead that planned the dag itself, which a plan file replaces.
func TestEngineLaunchPromptDropsTheOldPlanningProtocol(t *testing.T) {
	for _, runtime := range []string{"claude", "pi"} {
		p := BuildOrchestratePrompt("ship auth", nil, runtime, Orchestration_Engine)
		for _, gone := range []string{"--file", "import-tasks", "triage", "16 tasks", "parallelism", "resolve-merge"} {
			if strings.Contains(p, gone) {
				t.Fatalf("%s launch prompt still carries %q:\n%s", runtime, gone, p)
			}
		}
	}
}

func TestOrchestrationRulesNameRunSpecPlanAndCommands(t *testing.T) {
	r := OrchestrationRules("run-1", "C:/p/spec.md", "C:/p/plan.md")
	for _, want := range []string{
		"You are the lead for run run-1.",
		"Spec: C:/p/spec.md.",
		"Plan: C:/p/plan.md.",
		"wsh jarvis dag answer <task> <answers-json>",
		"wsh jarvis dag forward <task>",
		"wsh jarvis dag retry <task>",
		"wsh jarvis dag escalate <task> --model <model>",
		"wsh jarvis dag skip <task>",
		"wsh jarvis dag merge <task> --continue",
		"wsh jarvis dag status",
		"wsh jarvis complete",
		"Never re-plan and never do a task's own work.",
	} {
		if !strings.Contains(r, want) {
			t.Fatalf("rules missing %q:\n%s", want, r)
		}
	}
}

func TestOrchestrationRulesOmitMissingPaths(t *testing.T) {
	r := OrchestrationRules("run-1", "", "")
	if strings.Contains(r, "Spec:") || strings.Contains(r, "Plan:") {
		t.Fatalf("a dag without files names none:\n%s", r)
	}
	if !strings.HasPrefix(r, "You are the lead for run run-1. The engine schedules") {
		t.Fatalf("rules must open with the run:\n%s", r)
	}
}
