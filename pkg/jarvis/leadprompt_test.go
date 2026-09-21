// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
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
		p := BuildOrchestratePrompt("ship auth", nil, runtime)
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
		p := BuildOrchestratePrompt("ship auth", nil, runtime)
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

// complete closes the lead's tab mid-turn, so a lead that reports and completes in one turn leaves the
// human no way to answer: the open issues go to the initiative and to the human first, and complete waits.
func TestOrchestrationRulesHoldCompleteForTheHuman(t *testing.T) {
	r := OrchestrationRules("run-1", "", "")
	var finished string
	for _, line := range strings.Split(r, "\n") {
		if strings.HasPrefix(line, "- run finished:") {
			finished = line
		}
	}
	if finished == "" {
		t.Fatalf("rules have no run-finished line:\n%s", r)
	}
	for _, want := range []string{
		"wsh jarvis dag status",
		"wsh effort chunk add <effort>",
		"wsh effort create",
		AskTool("claude"),
		AskTool("pi"),
		"report",
		"to a file",
		"wsh jarvis complete --report <file>",
		"only when the human says so",
	} {
		if !strings.Contains(finished, want) {
			t.Fatalf("run-finished rule missing %q:\n%s", want, finished)
		}
	}
	if strings.Index(finished, AskTool("claude")) > strings.Index(finished, "wsh jarvis complete") {
		t.Fatalf("the lead must ask the human before it completes:\n%s", finished)
	}
}

func TestOrchestrationRulesForbidAttributionTrailers(t *testing.T) {
	if r := OrchestrationRules("run-1", "", ""); !strings.Contains(r, "Co-Authored-By") {
		t.Fatalf("the lead commits too; its rules must forbid attribution trailers:\n%s", r)
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

// a lead started after its plan was submitted has no goal to brainstorm: it works by the rules, and its
// first message is the event that needed it
func TestPlanLeadPromptStartsFromTheRulesAndTheWake(t *testing.T) {
	wake := "wake: 1 question waiting. wsh jarvis dag asks"
	p := PlanLeadPrompt(nil, "run-1", "", "/repo/plan.md", wake)
	if !strings.HasPrefix(p, OrchestrationRules("run-1", "", "/repo/plan.md")) {
		t.Fatalf("the rules come first:\n%s", p)
	}
	if !strings.HasSuffix(p, "\n\n"+wake) {
		t.Fatalf("the wake ends the prompt:\n%s", p)
	}
	if strings.Contains(p, "brainstorming") {
		t.Fatalf("a plan-input lead has nothing to brainstorm:\n%s", p)
	}
	principled := PlanLeadPrompt(waveobj.PrincipleList{{ID: waveobj.LegacyGlobalPrincipleID, Text: "be tidy"}}, "run-1", "", "/repo/plan.md", wake)
	if !strings.HasPrefix(principled, "Work by these principles:\nbe tidy\n\n") {
		t.Fatalf("the run's principles lead the prompt, as they do for a goal-run lead:\n%s", principled)
	}
}

// the engine runs Verify and Setup through sh or Git Bash; a lead left guessing wrote a command for the
// wrong shell in acceptance 2
func TestPlanAuthorIsToldTheShell(t *testing.T) {
	if !strings.Contains(PlanFormat, "POSIX shell") {
		t.Fatalf("the plan format must name the shell Verify and Setup run in:\n%s", PlanFormat)
	}
}

// A lead told only the Depends on SYNTAX writes whatever shape it happens to think of: the same goal
// produced six lanes from one harness and one serial chain from another. Both surfaces a plan author
// reads have to say that independent tasks run at the same time.
func TestPlanAuthorIsToldToSplitByIndependentWork(t *testing.T) {
	if !strings.Contains(PlanFormat, "at the same time") || !strings.Contains(PlanFormat, "independently") {
		t.Fatalf("the plan format must say independent tasks run at the same time:\n%s", PlanFormat)
	}
	for _, runtime := range []string{"claude", "pi"} {
		p := BuildOrchestratePrompt("ship auth", nil, runtime)
		if !strings.Contains(p, "what can proceed independently") {
			t.Fatalf("%s launch prompt does not tell the lead to split the plan by independent work:\n%s", runtime, p)
		}
	}
}
