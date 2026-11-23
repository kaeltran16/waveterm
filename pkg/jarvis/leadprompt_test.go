// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"fmt"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
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
		p := BuildOrchestratePrompt(&waveobj.Run{Goal: "ship auth", Runtime: runtime})
		for _, want := range []string{
			"Goal: ship auth",
			tool,
			"run `wsh jarvis dag submit --plan <plan path>` with an absolute path and stop.",
			"then `wsh jarvis complete --report <that file>`.",
			"wsh jarvis complete --commit $(git rev-parse HEAD) --report <that file>",
			"wsh jarvis design --kind brainstorm",
			"wsh jarvis design --kind canvas",
			// the builder trims the prompt's trailing newline, which PlanFormat ends with
			strings.TrimRight(PlanFormat, "\n"),
		} {
			if !strings.Contains(p, want) {
				t.Fatalf("%s launch prompt missing %q:\n%s", runtime, want, p)
			}
		}
	}
}

// the review dialog sends an approval with quoted notes as text, which a lead not told otherwise reads as a
// change request and never proceeds; docreview.ts reads the header and the approve label.
func TestLeadPromptApprovalWithNotes(t *testing.T) {
	rules := OrchestrationRules("r1", "", "", "", false)
	for _, want := range []string{"header `Plan review`", QuotedNotesRule("Accept all and proceed")} {
		if !strings.Contains(rules, want) {
			t.Fatalf("rules' Plan review missing %q:\n%s", want, rules)
		}
	}
}

// every command the rules tell the lead to run, with the run's own ids and paths
func TestOrchestrationRulesNameRunSpecPlanAndCommands(t *testing.T) {
	r := OrchestrationRules("run-1", "C:/p/spec.md", "C:/p/plan.md", "", false)
	for _, want := range []string{
		"You are the lead for run run-1.",
		"Spec: C:/p/spec.md.",
		"Plan: C:/p/plan.md.",
		AskTool("claude"),
		AskTool("pi"),
		"header `<task id>`",
		"wsh jarvis dag asks",
		"wsh jarvis dag answer <task> <answers-json>",
		"wsh jarvis dag retry <task>",
		"wsh jarvis dag escalate <task> --model <model>",
		"wsh jarvis dag skip <task>",
		"wsh jarvis dag merge <task> --continue",
		"wsh jarvis dag amend <task>",
		"wsh jarvis dag tell <task>",
		"wsh jarvis dag sendback <task>",
		"wsh jarvis dag approve <task>",
		"wsh jarvis dag status",
		"wsh jarvis dag report <task> [section]",
		"wsh effort chunk add <effort>",
		"wsh effort create",
		"wsh jarvis complete --report <file>",
		"wsh jarvis dag submit --round --plan <fix plan>",
		`wsh jarvis dag submit --round --granted "<the human's words>" --plan <fix plan>`,
		`wsh jarvis dag planreview accept "<the human's reason>"`,
		"wsh jarvis complete --report <file> --force-land",
		"wsh runs land <run> --force",
	} {
		if !strings.Contains(r, want) {
			t.Fatalf("rules missing %q:\n%s", want, r)
		}
	}
}

// a forwarded question surfaced the worker's raw text in the cockpit: the lead asks the human itself
func TestOrchestrationRulesLeadAsksWorkerQuestionItself(t *testing.T) {
	r := OrchestrationRules("run-1", "", "", "", false)
	if strings.Contains(r, "dag forward") {
		t.Fatalf("the rules still forward questions:\n%s", r)
	}
}

// the rules name the run's effort, so open issues land on it instead of on a new effort each run
func TestOrchestrationRulesNameTheRunsEffort(t *testing.T) {
	if r := OrchestrationRules("run-1", "", "", "eff-1", false); !strings.Contains(r, " Effort: effort:eff-1.") {
		t.Fatalf("rules should name the run's effort:\n%s", r)
	}
	if r := OrchestrationRules("run-1", "", "", "", false); strings.Contains(r, "Effort: effort:") {
		t.Fatalf("a run with no effort names none:\n%s", r)
	}
}

// each pin below guards a lead failure seen in a real run; one clause per failure
func TestOrchestrationRulesRunFinishedPins(t *testing.T) {
	r := OrchestrationRules("r1", "", "", "", false)
	for failure, want := range map[string]string{
		// finding 17 and run 33880f82: the lead waited for the human's word to complete
		"waited to complete": "without asking whether to",
		// run 33880f82: a code fix committed at wrap-up skipped review and cost the land a full Check
		"code at wrap-up": "A code defect is never a wrap-up commit",
		// d20dc06e, dec24c70, d276b206: in-feature leftovers filed as chunks became a follow-up run
		"leftovers as chunks": "even when it predates the run",
		// run dc7d6de0: the lead completed a failed final and never said it would hold
		"silent held land": "A failed final stage holds the land: completing does not merge the branch",
		// run 94a265f6: the lead offered only ways to complete, and the human came back to land it
		"no land option": "the question is what to do with the land",
		// run 72262859: the lead read the run-finished exemptions into a failed final and fixed nothing
		"exempted a failed final": "Fix every failing step, one already on the base or outside the goal included",
	} {
		if !strings.Contains(r, want) {
			t.Errorf("%s: rules missing %q:\n%s", failure, want, r)
		}
	}
	// run 6c7652be: accept spawns the first tasks, so an amend after it misses them
	carry, accept := strings.Index(r, "carry each accepted finding"), strings.Index(r, "dag planreview accept")
	if carry < 0 || carry > accept {
		t.Fatalf("the plan review rule must amend before accept:\n%s", r)
	}
}

// run b2d7fab1 (findings 4 to 7) asked the human to review a plan the engine reviews anyway
func TestEngineLaunchPromptCutsTheCeremony(t *testing.T) {
	for _, runtime := range []string{"claude", "pi"} {
		p := BuildOrchestratePrompt(&waveobj.Run{Goal: "ship auth", Runtime: runtime})
		if want := "don't ask the human to review the plan or pick an execution mode"; !strings.Contains(p, want) {
			t.Fatalf("%s launch prompt missing %q:\n%s", runtime, want, p)
		}
	}
}

// leads spent 7 to 14 min writing 17 to 88 KB plans that pasted each task's code (runs 09-29 and 09-30)
func TestEngineLaunchPromptPlansCarryDecisionsNotCode(t *testing.T) {
	for _, runtime := range []string{"claude", "pi"} {
		p := BuildOrchestratePrompt(&waveobj.Run{Goal: "ship auth", Runtime: runtime})
		if !strings.Contains(p, "except its complete-code rule") {
			t.Fatalf("%s launch prompt does not override writing-plans' complete-code rule:\n%s", runtime, p)
		}
	}
}

// every path that writes a plan carries the caller grep and the fast track's short plan
func TestEveryPlanningPromptListsCallersOfChangedSignatures(t *testing.T) {
	if !strings.Contains(planShortStep, strconv.Itoa(FastTrackMaxTasks)) {
		t.Fatalf("the short-plan step must name the fast track's limit:\n%s", planShortStep)
	}
	for _, runtime := range []string{"claude", "pi"} {
		for _, autonomous := range []bool{false, true} {
			runs := map[string]waveobj.Run{
				"from the goal":   {Goal: "ship auth", Runtime: runtime, Autonomous: autonomous},
				"from the design": {Goal: "ship auth", Runtime: runtime, Autonomous: autonomous, Spec: "C:/p/docs/spec.md"},
			}
			for name, run := range runs {
				p := BuildOrchestratePrompt(&run)
				for step, text := range map[string]string{"the caller grep": planCallersStep, "the short plan": planShortStep} {
					if !strings.Contains(p, text) {
						t.Errorf("%s %s autonomous=%v: plan step missing %s:\n%s", runtime, name, autonomous, step, p)
					}
				}
			}
		}
	}
}

// a run carrying an approved design plans from it (spec decision 2): no path classification, the design's
// paths named, and the spec submitted only when there is one
func TestPlanFromDesignPrompt(t *testing.T) {
	const spec, proto = "C:/p/docs/spec.md", "C:/p/.superpowers/design/x/canvas.dc.html"
	designs := map[string]waveobj.Run{
		"spec only":      {Spec: spec},
		"prototype only": {Prototype: proto},
		"both":           {Spec: spec, Prototype: proto},
	}
	for _, runtime := range []string{"claude", "pi"} {
		for name, d := range designs {
			for _, autonomous := range []bool{false, true} {
				p := BuildOrchestratePrompt(&waveobj.Run{Goal: "ship auth", Runtime: runtime, Autonomous: autonomous, Spec: d.Spec, Prototype: d.Prototype})
				label := fmt.Sprintf("%s %s autonomous=%v", runtime, name, autonomous)
				if strings.Contains(p, spikePath) {
					t.Errorf("%s: plan-from-design prompt carries the goal-run paths:\n%s", label, p)
				}
				for _, want := range []string{"Goal: ship auth", strings.TrimRight(PlanFormat, "\n")} {
					if !strings.Contains(p, want) {
						t.Errorf("%s: plan-from-design prompt missing %q:\n%s", label, want, p)
					}
				}
				for _, path := range []string{d.Spec, d.Prototype} {
					if path != "" && !strings.Contains(p, path) {
						t.Errorf("%s: plan-from-design prompt does not name %q:\n%s", label, path, p)
					}
				}
				if d.Spec != "" {
					if want := "`wsh jarvis dag submit --plan <plan path> --spec " + spec + "`"; !strings.Contains(p, want) {
						t.Errorf("%s: plan-from-design prompt missing %q:\n%s", label, want, p)
					}
				} else if strings.Contains(p, "--spec ") || !strings.Contains(p, "submit without `--spec`") {
					t.Errorf("%s: a prototype-only design submits without --spec:\n%s", label, p)
				}
				if d.Prototype != "" && !strings.Contains(p, "`**Prototype:**` line") {
					t.Errorf("%s: plan-from-design prompt does not put the prototype on the plan's Prototype line:\n%s", label, p)
				}
				if autonomous != strings.Contains(p, AutonomousRules) {
					t.Errorf("%s: AutonomousRules present = %v:\n%s", label, !autonomous, p)
				}
				if autonomous && strings.Contains(p, AskTool(runtime)) {
					t.Errorf("%s: an autonomous plan-from-design prompt names the ask tool:\n%s", label, p)
				}
			}
		}
	}
}

// a goal run with no design submits without a spec
func TestGoalPromptSubmitsWithoutASpec(t *testing.T) {
	for _, runtime := range []string{"claude", "pi"} {
		if p := BuildOrchestratePrompt(&waveobj.Run{Goal: "ship auth", Runtime: runtime}); strings.Contains(p, "--spec") {
			t.Errorf("%s goal prompt submits with --spec:\n%s", runtime, p)
		}
	}
}

// a principle like "merge back when done" had the lead doing what the engine owns (finding 1)
func TestEngineRunPromptsPutTheContractOverPrinciples(t *testing.T) {
	ps := waveobj.PrincipleList{{ID: "wt", Text: "Use worktree"}}
	for name, p := range map[string]string{
		"plan lead": PlanLeadPrompt(ps, "r1", "", "/repo/plan.md", "", false, "wake"),
		"goal lead": BuildOrchestratePrompt(&waveobj.Run{Goal: "ship auth", Principles: ps, Runtime: "claude"}),
	} {
		if !strings.Contains(p, "- Use worktree\n"+ContractWinsLine+"\n\n") {
			t.Fatalf("%s prompt must follow its principles with the contract line:\n%s", name, p)
		}
	}
	if strings.Contains(BuildOrchestratePrompt(&waveobj.Run{Goal: "ship auth", Runtime: "claude"}), ContractWinsLine) {
		t.Fatal("with no principles there is nothing for the contract to win over")
	}
}

func TestOrchestrationRulesOmitMissingPaths(t *testing.T) {
	r := OrchestrationRules("run-1", "", "", "", false)
	if strings.Contains(r, "Spec:") || strings.Contains(r, "Plan:") {
		t.Fatalf("a dag without files names none:\n%s", r)
	}
	if !strings.HasPrefix(r, "You are the lead for run run-1. ") {
		t.Fatalf("rules must open with the run:\n%s", r)
	}
}

// a lead started after its plan was submitted works by the rules, and its first message is the event that
// needed it
func TestPlanLeadPromptStartsFromTheRulesAndTheWake(t *testing.T) {
	wake := "wake: 1 question waiting. wsh jarvis dag asks"
	p := PlanLeadPrompt(nil, "run-1", "", "/repo/plan.md", "", false, wake)
	if !strings.HasPrefix(p, OrchestrationRules("run-1", "", "/repo/plan.md", "", false)) {
		t.Fatalf("the rules come first:\n%s", p)
	}
	if !strings.HasSuffix(p, "\n\n"+wake) {
		t.Fatalf("the wake ends the prompt:\n%s", p)
	}
	principled := PlanLeadPrompt(waveobj.PrincipleList{{ID: waveobj.LegacyGlobalPrincipleID, Text: "be tidy"}}, "run-1", "", "/repo/plan.md", "", false, wake)
	if !strings.HasPrefix(principled, "Work by these principles:\nbe tidy\n"+ContractWinsLine+"\n\n") {
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

// the same goal produced six lanes from one harness and one serial chain from another
func TestPlanAuthorIsToldToSplitByIndependentWork(t *testing.T) {
	if !strings.Contains(PlanFormat, "at the same time") {
		t.Fatalf("the plan format must say independent tasks run at the same time:\n%s", PlanFormat)
	}
}

// Every prompt that tells an agent to commit gives the commit rule: a short subject with the detail in a body,
// and no credit line, which a harness's own commit instructions ask for. The merge strip only covers lane
// squashes, and a quick run's commit lands straight on the branch.
func TestEveryCommittingPromptCarriesTheCommitRule(t *testing.T) {
	for name, p := range map[string]string{
		"quick":               BuildQuickPrompt("add a spinner", nil, "claude"),
		"orchestrate launch":  BuildOrchestratePrompt(&waveobj.Run{Goal: "ship auth", Runtime: "claude"}),
		"orchestration rules": OrchestrationRules("run-1", "", "", "", false),
	} {
		if !strings.Contains(p, CommitRule) {
			t.Errorf("%s prompt tells the agent to commit but never gives the commit rule:\n%s", name, p)
		}
	}
}

func TestRulesSayWhereAFixPlanGoes(t *testing.T) {
	r := OrchestrationRules("r1", "", "", "", false)
	if got := strings.Count(r, fixPlanHome); got != 2 {
		t.Fatalf("want the fix plan's place named in both the run-finished and the failed-final rule, got %d:\n%s", got, r)
	}
}

// the ON answer is typed into the lead's open picker at 60ms per rune, and a wake is typed as one line
func TestAutonomousTexts(t *testing.T) {
	if n := utf8.RuneCountInString(AutonomousOnAnswer); n >= 160 {
		t.Fatalf("AutonomousOnAnswer is %d runes; typing it must stay short", n)
	}
	q := []baseds.AgentAskQuestion{{Question: "Spec review", Header: "Spec review", Options: []baseds.AgentAskOption{{Label: "Approve"}, {Label: "Request changes"}}}}
	if err := agentask.ValidateAnswers(q, []baseds.AgentAnswerItem{{Text: AutonomousOnAnswer}}, false); err != nil {
		t.Fatalf("AutonomousOnAnswer is not a valid free-text answer: %v", err)
	}
	for name, s := range map[string]string{"rules": AutonomousRules, "on wake": AutonomousOnWake, "off wake": AutonomousOffWake} {
		if strings.ContainsAny(s, "\r\n") {
			t.Errorf("%s must be one line:\n%s", name, s)
		}
	}
	if !strings.HasPrefix(AutonomousOnWake, "wake: ") || !strings.HasSuffix(AutonomousOnWake, AutonomousRules) {
		t.Errorf("the ON wake is a wake line carrying the rules:\n%s", AutonomousOnWake)
	}
	if !strings.HasPrefix(AutonomousOffWake, "wake: ") {
		t.Errorf("the OFF wake is a wake line:\n%s", AutonomousOffWake)
	}
}

// nobody is at an autonomous lead's terminal, so its prompt names no ask tool
func TestLaunchPromptAutonomous(t *testing.T) {
	for _, runtime := range []string{"claude", "pi"} {
		p := BuildOrchestratePrompt(&waveobj.Run{Goal: "ship auth", Runtime: runtime, Autonomous: true})
		for _, gone := range []string{AskTool("claude"), AskTool("pi")} {
			if strings.Contains(p, gone) {
				t.Errorf("%s autonomous launch prompt names the ask tool %q:\n%s", runtime, gone, p)
			}
		}
		for _, want := range []string{
			"Goal: ship auth",
			"wsh jarvis dag submit --plan <plan path> --spec <spec path>",
			"wsh jarvis complete --commit $(git rev-parse HEAD) --report <that file>",
			CommitRule,
			AutonomousRules,
			strings.TrimRight(PlanFormat, "\n"),
		} {
			if !strings.Contains(p, want) {
				t.Errorf("%s autonomous launch prompt missing %q:\n%s", runtime, want, p)
			}
		}
		if off := BuildOrchestratePrompt(&waveobj.Run{Goal: "ship auth", Runtime: runtime}); strings.Contains(off, AutonomousRules) {
			t.Errorf("%s asking launch prompt carries the autonomous rules:\n%s", runtime, off)
		}
	}
}

func TestOrchestrationRulesAutonomous(t *testing.T) {
	off := OrchestrationRules("r1", "C:/p/spec.md", "C:/p/plan.md", "eff-1", false)
	on := OrchestrationRules("r1", "C:/p/spec.md", "C:/p/plan.md", "eff-1", true)
	if strings.Contains(off, AutonomousRules) {
		t.Fatalf("asking rules carry the autonomous rules:\n%s", off)
	}
	if on != off+"\n"+AutonomousRules {
		t.Fatalf("autonomous rules must be the asking rules plus AutonomousRules:\n%s", on)
	}
	if !strings.Contains(on, `wsh jarvis dag planreview accept "autonomous run"`) {
		t.Fatalf("autonomous rules must accept a failed plan review themselves:\n%s", on)
	}
}

// the run's recorded plan skill picks the skill the lead writes with and the format it writes in; a run from
// before the setting (empty) keeps writing-plans, and no prompt names the superpowers skills
func TestLeadPromptFollowsTheRunsPlanSkill(t *testing.T) {
	cases := []struct{ stored, skill, other, format string }{
		{PlanSkill_Plan, "arc:plan ", "arc:writing-plans", PlanFormatFor(PlanSkill_Plan)},
		{PlanSkill_WritingPlans, "arc:writing-plans ", "arc:plan ", PlanFormat},
		{"", "arc:writing-plans ", "arc:plan ", PlanFormat},
	}
	for _, c := range cases {
		for _, autonomous := range []bool{false, true} {
			runs := map[string]waveobj.Run{
				"goal":   {Goal: "ship auth", Runtime: "claude", Autonomous: autonomous, PlanSkill: c.stored},
				"design": {Goal: "ship auth", Runtime: "pi", Autonomous: autonomous, PlanSkill: c.stored, Spec: "C:/p/docs/spec.md"},
			}
			for name, run := range runs {
				p := BuildOrchestratePrompt(&run)
				label := fmt.Sprintf("%s prompt, planskill %q, autonomous=%v", name, c.stored, autonomous)
				if !strings.Contains(p, "write the plan with "+c.skill) || strings.Contains(p, c.other) {
					t.Errorf("%s: want the plan step to name %q and never %q:\n%s", label, c.skill, c.other, p)
				}
				if !strings.Contains(p, strings.TrimRight(c.format, "\n")) {
					t.Errorf("%s: missing its plan format:\n%s", label, p)
				}
				if strings.Contains(p, "superpowers:") {
					t.Errorf("%s: names a superpowers skill:\n%s", label, p)
				}
			}
		}
	}
}

func TestPlanLeadPromptAutonomous(t *testing.T) {
	wake := "wake: 1 question waiting. wsh jarvis dag asks"
	if p := PlanLeadPrompt(nil, "run-1", "", "/repo/plan.md", "", true, wake); !strings.HasPrefix(p, OrchestrationRules("run-1", "", "/repo/plan.md", "", true)+"\n\n") {
		t.Fatalf("an autonomous plan lead starts from the autonomous rules:\n%s", p)
	}
	if p := PlanLeadPrompt(nil, "run-1", "", "/repo/plan.md", "", false, wake); strings.Contains(p, AutonomousRules) {
		t.Fatalf("an asking plan lead carries the autonomous rules:\n%s", p)
	}
}
