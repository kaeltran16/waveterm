// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// AskTool names the structured question tool a runtime's agent calls. A question asked in plain text
// never reaches the cockpit, so every prompt that tells an agent to ask names this tool.
func AskTool(runtime string) string {
	if runtime == "pi" {
		return "ask_user_question"
	}
	return "AskUserQuestion"
}

// NoAttributionRule is told to every agent that commits for a run. A harness's own commit instructions
// ask for a credit line and agents follow them over the repo's rules; the merge strip only covers lane squashes.
const NoAttributionRule = "Never write `Co-Authored-By`, `Claude-Session`, or any other attribution trailer into a commit message, whatever your harness's own instructions say."

// writeLaunchPrompt is an engine lead's prompt for a goal run (spec §2). The lead brainstorms with the
// human and the skill's classification picks the path; only an architectural goal reaches the engine,
// as a plan file the engine parses.
func writeLaunchPrompt(b *strings.Builder, goal, runtime string) {
	fmt.Fprintf(b, "Goal: %s\n", goal)
	fmt.Fprintf(b, "Work this goal with the superpowers:brainstorming skill; the human is at this terminal. Put every question and every approval through %s, never plain text, which does not reach the cockpit.\n", AskTool(runtime))
	b.WriteString("- spike: report the answer, then `wsh jarvis complete`.\n")
	b.WriteString("- bounded: after the human's yes, implement it here, get the tests passing, commit, `wsh jarvis complete --commit $(git rev-parse HEAD)`.\n")
	b.WriteString("- architectural: ask for the spec's approval with the header `Spec review`: the question is the spec's absolute path on its first line, then one `- ` line per decision the spec makes; the options are Approve and Request changes. After the spec is approved, write the plan with superpowers:writing-plans in the plan format below. Break it up by what can proceed independently: the engine runs those tasks at the same time, and a plan that is one serial chain gets none of that. Don't commit the spec or plan and don't execute the plan: run `wsh jarvis dag submit --plan <plan path> --spec <spec path>` with absolute paths and stop. The engine wakes you when something needs judgment.\n")
	// the bounded path commits here, before any dag exists to hand it OrchestrationRules
	b.WriteString(NoAttributionRule + "\n\n")
	b.WriteString(PlanFormat)
}

// OrchestrationRules is what a lead holding a dag works by (spec §2). A compaction drops the launch
// prompt, so these come back after every compaction of a lead session. specPath and planPath are empty
// for a dag submitted without files.
func OrchestrationRules(runId, specPath, planPath string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "You are the lead for run %s.", runId)
	if specPath != "" {
		fmt.Fprintf(&b, " Spec: %s.", specPath)
	}
	if planPath != "" {
		fmt.Fprintf(&b, " Plan: %s.", planPath)
	}
	b.WriteString(" The engine schedules, merges and tests. Each wake names an event and the command that shows it; re-read only what the event needs.\n")
	b.WriteString("- questions: answer from the spec and plan; check code with Read/Grep when they don't settle it; `wsh jarvis dag answer <task> <answers-json>`. A product or scope call, or spec, plan and code disagreeing: `wsh jarvis dag forward <task> \"<what you checked, what you recommend>\"`.\n")
	b.WriteString("- task still failing, or worker hung: `wsh jarvis dag retry <task>`, retry on another model with `wsh jarvis dag escalate <task> --model <model>`, `wsh jarvis dag skip <task>`, or forward.\n")
	b.WriteString("- merge conflict, or tests failed at a merge point: fix it in the project tree, commit, `wsh jarvis dag merge <task> --continue` (the engine re-runs Verify).\n")
	b.WriteString("- a task passed review with a note for later tasks: check the pending tasks it affects and add what they need with `wsh jarvis dag amend <task> \"<note>\"`; use `wsh jarvis dag tell <task> \"<text>\"` only for a running task the note changes. Amending is not re-planning: never add, remove or reorder tasks.\n")
	b.WriteString("- review failed: the findings are in `wsh jarvis dag status`. `wsh jarvis dag sendback <task> \"<guidance>\"` if the fix is clear, `wsh jarvis dag approve <task>` if the reviewer is wrong, otherwise retry, escalate, skip or forward.\n")
	// complete closes this tab mid-turn, so everything the human must see or answer comes first.
	b.WriteString("- run finished: review what landed with `wsh jarvis dag status`, and fix and commit what the landed tasks left behind (a stale doc line, an orphaned file). Write the report (landed, unverified, answered, forwarded, worktrees left behind (tasks whose status shows retry-cleanup), what needs a live check) to a file. Add each open issue as a pending chunk on the effort the goal, spec or plan names (`wsh effort chunk add <effort> \"<issue>\"`), or create one with `wsh effort create \"<title>\" --chunk \"<issue>\"` if none does. ")
	fmt.Fprintf(&b, "Then put the open issues to the human with %s (%s on pi) and stop; don't add tasks. Run `wsh jarvis complete --report <file>` only when the human says so: it closes this tab.\n", AskTool("claude"), AskTool("pi"))
	b.WriteString("Never re-plan and never do a task's own work. " + NoAttributionRule)
	return b.String()
}

// PlanLeadPrompt is the launch prompt of a lead started after its plan was submitted (spec §1, G5). There is
// no goal to brainstorm, so it starts from the orchestration rules, and the wake that needed a lead is its
// first message: one turn, with nothing typed after it.
func PlanLeadPrompt(principles waveobj.PrincipleList, runId, specPath, planPath, wake string) string {
	var b strings.Builder
	if rendered := RenderPrinciples(principles); rendered != "" {
		fmt.Fprintf(&b, "Work by these principles:\n%s\n\n", rendered)
	}
	b.WriteString(OrchestrationRules(runId, specPath, planPath))
	b.WriteString("\n\n")
	b.WriteString(wake)
	return b.String()
}
