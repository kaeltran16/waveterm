# Orchestrator Redesign Slice 5a: Lead Prompt and Compaction

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An engine lead starts from a goal-first launch prompt that ends in `wsh jarvis dag submit --plan --spec`. Once it hands the plan over, the engine compacts it at that boundary. After every compaction, on Claude and pi alike, the lead gets a fixed set of orchestration rules back. Every dag worker starts from a plan-aware worker contract, and a lead that exits before submitting fails its run with a visible reason.

**Architecture:**
- **Prompts** live in `pkg/jarvis/leadprompt.go`: `AskTool(runtime)`, the engine launch prompt, and `OrchestrationRules(runId, specPath, planPath)`. `BuildOrchestratePrompt` keeps its adaptive branch until slice 5c and drops its `parallelism` parameter, which only the old engine prompt read.
- **Worker contract:** `workerContract` replaces `HeadlessContract` in `pkg/orchestrate/engine.go`. `taskPrompt` becomes contract, then the task's text, then the predecessor handoff (spec §4).
- **`wsh jarvis dag rules`** resolves the caller's block through the existing `JarvisCtxCommand` and `DagStatusCommand`, and prints the rules only when the caller's run is the one the dag names. No new RPC, so no `task generate`.
- **Re-orientation after a compaction:**
  - Claude: a managed SessionStart hook, matcher `compact`, runs `jarvis dag rules --inject`, which emits the same `hookSpecificOutput` shape as the memory inject.
  - pi: the tools extension runs `wsh jarvis dag rules` on `session_compact` and appends the output as the last message from its `context` handler.
- **Handoff compaction:** `DagSubmitCommand` calls `orchestrate.PostHandoff` for a run with a lead worker. The wake adapter types `HandoffCompact` alone the next time the lead is at its prompt, as an outstanding wake that `working` must confirm.
- **Compaction states.** The adapter's confirmation is a `working` report, and today neither harness reports anything during a compaction, so a typed `/compact` would be retried once and the lead declared dead. This slice adds the reports:
  - Claude: managed `PreCompact` runs `agent-hook`, which reports `working`. Managed SessionStart `compact` runs `agent-hook`, which reports `idle`.
  - pi: the status extension reports `working` on `session_before_compact`, and restores the state the compaction interrupted on `session_compact` and `session_compact_failed`.
- **Dead lead before submit (G8):**
  - `jarvis.OnWorkerExit` calls a new `LeadExitHook` for every agent tab exit, before it parses the transcript.
  - `orchestrate.HandleLeadExit` fails the running phase of an orchestrator run that holds no dag, and appends a `lead-exited` row with the reason.
  - The `NoTranscript` lead branch in `HandleChildOutcome` is removed: it also failed runs after submit, which G8 says must keep running.

Probed facts this plan relies on (2026-09-15):
- pi 0.85.1: interactive mode passes the text after `/compact ` as `customInstructions` (`dist/modes/interactive/interactive-mode.js:2465-2468`). `session_before_compact`, `session_compact` and `session_compact_failed` carry `reason: "manual" | "threshold" | "overflow"`. `ContextEventResult` is `{ messages?: AgentMessage[] }`, and a user message is `{ role: "user", content: string, timestamp: number }`.
- Claude Code 2.1.272 (strings in `claude.exe`): the PreCompact payload is `hook_event_name:"PreCompact",trigger,custom_instructions`, and the SessionStart payload carries `source`.
- `OnWorkerExit` reaches `ChildOutcomeHook` only after the transcript parses. In the S4 live check, three live Claude workers had no `<session>.jsonl` on disk. A lead exit on that path can be missed.
- The Tauri shell runs `wsh install-agent-hooks` from the app's `bin` on every launch (`src-tauri/src/main.rs:156`), so a rebuilt dev app installs the new hooks and pi extensions itself.
- `mergeAgentHooks` removes every managed group of an event and re-adds one group per `managedHooks` entry, so two entries with the same event and matcher both survive.

**Tech Stack:** Go (`pkg/jarvis`, `pkg/orchestrate`, `pkg/wshrpc/wshserver`, `pkg/waveobj`), cobra (`cmd/wsh`), TypeScript pi extensions, React 19 + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md`. This plan implements:
- §2 The lead: Launch prompt (goal runs), Orchestration rules, Dead lead (G8) before submit.
- §4 Engine, Workers: the worker contract.
- §6 Waking the lead: the handoff `/compact` typed by the same adapter.
- §7 Context management: rules 2, 3 and 4.
- §13 Delivery slices: slice 5a.

## Decisions that differ from the spec's wording

1. **Compaction states** (above) are not in the spec. Without them the handoff makes the adapter give up on a healthy lead.
2. **Rules commands:** the rules name full commands (`wsh jarvis dag answer <task> <answers-json>`, not `dag answer`), because a compacted lead cannot be assumed to remember the prefix. Their run-finished line ends in `wsh jarvis complete`, matching spec §2 Lifecycle step 7.
3. **The Claude hook runs `jarvis dag rules --inject`**, mirroring `agent-memory-project --inject`. Plain `jarvis dag rules` prints text, which is what pi reads.
4. **The launch prompt appends `PlanFormat`** after its bullets instead of inline, and says the submit paths must be absolute (`loadDagPlan` rejects relative ones).
5. **Dags submitted as JSON** (until 5c): the worker contract names the task id and drops its plan lines, and the rules drop their Spec and Plan clauses.

## Global Constraints

- **Handoff text** (spec §7): `/compact Keep: what the human said that the spec does not record, and the reason behind each decision. Drop: code you read, drafts, tool output.`
- **Dead-lead reason** (spec §2): `lead exited before submitting a plan`.
- **Ask tool:** `AskUserQuestion` for claude, `ask_user_question` for pi.
- **Scope limits:**
  - No new timeouts, RPCs, task states or failure kinds. The one new run event kind is `lead-exited`.
  - The plan gate stays until 5c: a lead's submit still stops at it.
- No emojis. Comments are lower case and say why, never what.
- **Generated and copied files:**
  - Never hand-edit generated files. `cmd/wsh/cmd/pi-status-extension.ts`, `pi-tools-extension.ts` and `pi-tools-core-extension.ts` are copies: edit `pi/extensions/*.ts`, then run `task sync:piartifacts`.
  - `cmd/wsh/cmd/pi-status-extension.test.ts` is authored where it is.
- Go tests for `jarvis`, `orchestrate`, `wshserver` and `cmd/wsh` need CGO flags. From PowerShell at the repo root:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  ```
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (`npx tsc` overflows).
- **Formatters:** HEAD is not formatter-clean. Never run `gofmt -w` or `prettier --write` over a file you did not already own; check only the hunks you wrote, with `gofmt -d <file>` and `npx prettier --check <file>`.
- **Staging:** other sessions edit this tree. Run `git status --short` again before staging, and stage only the files Task 7 lists.
- **Commit:** one commit for the whole slice, with the spec edits and this plan folded in. Commits for this effort need no approval; pushing does. No co-author trailer.
- **New files:** the Write tool replaces an existing file. The only new files are `pkg/jarvis/leadprompt.go` and `pkg/jarvis/leadprompt_test.go`, so check with `ls pkg/jarvis | grep leadprompt` first. Every other test is added with Edit, except `pkg/jarvis/run_dagprompt_test.go`, which Task 1 replaces on purpose.

## Task order

1. The launch prompt and the orchestration rules.
2. The worker contract.
3. `wsh jarvis dag rules` and the Claude compaction hooks.
4. The handoff compaction.
5. pi: compaction states and the rules after a compaction.
6. A lead that exits before submitting fails its run.
7. Docs, full verification, live check, commit.

---

### Task 1: The launch prompt and the orchestration rules

**Files:**
- Create: `pkg/jarvis/leadprompt.go`
- Create: `pkg/jarvis/leadprompt_test.go`
- Modify: `pkg/jarvis/run.go` (`MaxDagTasks` comment, `BuildOrchestratePrompt`, delete `buildEngineOrchestratePrompt`)
- Modify: `pkg/jarvis/runexec.go:190` (`phasePrompt`)
- Modify: `pkg/jarvis/run_test.go`
- Replace: `pkg/jarvis/run_dagprompt_test.go`

**Interfaces:**
- Consumes: `PlanFormat` (`pkg/jarvis/plan.go`), `RenderPrinciples`, `ResolveOrchestration`, `buildAdaptiveOrchestratePrompt`.
- Produces:
  - `func AskTool(runtime string) string`
  - `func OrchestrationRules(runId, specPath, planPath string) string`
  - `func BuildOrchestratePrompt(goal string, principles waveobj.PrincipleList, runtime, orchestration string) string` (was five parameters)

- [ ] **Step 1: Write the failing tests**

Check `ls pkg/jarvis | grep leadprompt` prints nothing, then create `pkg/jarvis/leadprompt_test.go`:

```go
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
			PlanFormat,
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvis/ -run 'AskTool|EngineLaunchPrompt|OrchestrationRules' -v`
Expected: build failure, `undefined: AskTool`, `undefined: OrchestrationRules`, and `too many arguments` or `not enough arguments in call to BuildOrchestratePrompt`.

- [ ] **Step 3: Create `pkg/jarvis/leadprompt.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"fmt"
	"strings"
)

// AskTool names the structured question tool a runtime's agent calls. A question asked in plain text
// never reaches the cockpit, so every prompt that tells an agent to ask names this tool.
func AskTool(runtime string) string {
	if runtime == "pi" {
		return "ask_user_question"
	}
	return "AskUserQuestion"
}

// writeLaunchPrompt is an engine lead's prompt for a goal run (spec §2). The lead brainstorms with the
// human and the skill's classification picks the path; only an architectural goal reaches the engine,
// as a plan file the engine parses.
func writeLaunchPrompt(b *strings.Builder, goal, runtime string) {
	fmt.Fprintf(b, "Goal: %s\n", goal)
	fmt.Fprintf(b, "Work this goal with the superpowers:brainstorming skill; the human is at this terminal. Put every question and every approval through %s, never plain text, which does not reach the cockpit.\n", AskTool(runtime))
	b.WriteString("- spike: report the answer, then `wsh jarvis complete`.\n")
	b.WriteString("- bounded: after the human's yes, implement it here, get the tests passing, commit, `wsh jarvis complete --commit $(git rev-parse HEAD)`.\n")
	b.WriteString("- architectural: after the spec is approved, write the plan with superpowers:writing-plans in the plan format below. Don't commit the spec or plan and don't execute the plan: run `wsh jarvis dag submit --plan <plan path> --spec <spec path>` with absolute paths and stop. The engine wakes you when something needs judgment.\n\n")
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
	b.WriteString("- run finished: write the report from `wsh jarvis dag status` (landed, unverified, answered, forwarded), then `wsh jarvis complete`. If the goal isn't fully met, say what's missing and ask the human; don't add tasks.\n")
	b.WriteString("Never re-plan and never do a task's own work.")
	return b.String()
}
```

- [ ] **Step 4: Rewire `BuildOrchestratePrompt` in `pkg/jarvis/run.go`**

Replace the `BuildOrchestratePrompt` function and its comment (starting `// BuildOrchestratePrompt is the lead's initial prompt`) with:

```go
// BuildOrchestratePrompt is the lead's initial prompt for an orchestrator run. The fork is the
// orchestration choice, not the runtime: an "engine" lead brainstorms and hands pkg/orchestrate a plan
// file, an "adaptive" lead fans out with its own subagents. Runtime names the ask tool.
func BuildOrchestratePrompt(goal string, principles waveobj.PrincipleList, runtime, orchestration string) string {
	var b strings.Builder
	if rendered := RenderPrinciples(principles); rendered != "" {
		fmt.Fprintf(&b, "Work by these principles, and propagate them into every subagent you dispatch:\n%s\n\n", rendered)
	}
	if ResolveOrchestration(orchestration, runtime) == Orchestration_Engine {
		writeLaunchPrompt(&b, goal, runtime)
	} else {
		buildAdaptiveOrchestratePrompt(&b, goal)
	}
	return strings.TrimRight(b.String(), "\n")
}
```

Delete `buildEngineOrchestratePrompt` and its four-line leading comment (`// buildEngineOrchestratePrompt: the lead publishes a DAG...`), to the end of the file.

In the `MaxDagTasks` comment, replace the first two lines:

```go
// MaxDagTasks is the ceiling orchestrate.MaxTasks enforces. It lives here because the lead's engine
// prompt has to state it while planning, and pkg/orchestrate imports pkg/jarvis, never the reverse.
```

with:

```go
// MaxDagTasks is the ceiling orchestrate.MaxTasks enforces. It lives here because pkg/orchestrate imports
// pkg/jarvis, never the reverse; slice 5c deletes the cap with JSON submit.
```

- [ ] **Step 5: Update the caller**

In `pkg/jarvis/runexec.go`, `phasePrompt`:

```go
		return BuildOrchestratePrompt(run.Goal, run.Principles, run.Runtime, run.Orchestration, run.Parallelism)
```

becomes:

```go
		return BuildOrchestratePrompt(run.Goal, run.Principles, run.Runtime, run.Orchestration)
```

Run `git grep -n "BuildOrchestratePrompt(" -- '*.go'`. Expected: `run.go`, `runexec.go`, `run_test.go`, `run_dagprompt_test.go` and `leadprompt_test.go` only.

- [ ] **Step 6: Update `pkg/jarvis/run_test.go`**

- In `TestBuildOrchestratePromptAdaptive`, change `BuildOrchestratePrompt("do X", principles, "claude", orch, 0)` to `BuildOrchestratePrompt("do X", principles, "claude", orch)`.
- Delete these tests, each with the comment block directly above it:
  - `TestBuildOrchestratePromptEngine`
  - `TestBuildOrchestratePromptUsesDigestMergeVocabulary` (comment starts `// The prompt is load-bearing protocol`)
  - `TestBuildOrchestratePromptLeavesRoutineMergesToTheEngine` (comment starts `// the engine lands a clean merge itself`)
  - `TestBuildOrchestratePromptStatesTheHumansParallelism` (comment starts `// The Run rail's width reaches the lead`)

  Their replacements are in `leadprompt_test.go`.

- [ ] **Step 7: Replace `pkg/jarvis/run_dagprompt_test.go`**

```go
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
```

- [ ] **Step 8: Run the package tests**

Run: `go test ./pkg/jarvis/ -v -run 'AskTool|EngineLaunchPrompt|OrchestrationRules|BuildOrchestratePrompt'`, then `go test ./pkg/jarvis/`
Expected: PASS.

---

### Task 2: The worker contract

**Files:**
- Modify: `pkg/orchestrate/engine.go` (delete `HeadlessContract`, add `workerContract`, rewrite `taskPrompt`, the call in `scheduleLocked`)
- Modify: `pkg/orchestrate/engine_test.go`

**Interfaces:**
- Consumes: `jarvis.AskTool` (Task 1), `TaskGroup.PlanPath`, `TaskGroup.SpecPath`, `TaskGroup.Verify`, `effectiveTaskRoute`.
- Produces:
  - `func workerContract(g *waveobj.TaskGroup, task *waveobj.TaskNode, runtime string) string`
  - `func taskPrompt(g *waveobj.TaskGroup, task *waveobj.TaskNode, owner *waveobj.Run, runtime, handoff string) string` (was `taskPrompt(task, owner, handoff)`)

- [ ] **Step 1: Write the failing tests**

In `pkg/orchestrate/engine_test.go`, replace `TestTaskPromptCarriesDescriptionAndContract`, `TestTaskPromptLabelOnlyStillHasContract` and `TestTaskPromptPlacesHandoffBeforeTheContract` with:

```go
func TestTaskPromptCarriesDescriptionAndContract(t *testing.T) {
	owner := jarvis.NewRun("owner", "ws-1", "/p", nil, jarvis.RunMode_Orchestrator, nil, 1)
	g := &waveobj.TaskGroup{}
	desc := "pin: date-only format (Aug 16)"
	task := &waveobj.TaskNode{ID: "t-1", Label: "add fmtDate", Description: desc}
	p := taskPrompt(g, task, &owner, "claude", "")
	for _, want := range []string{"add fmtDate", desc, workerContract(g, task, "claude")} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt missing %q: %q", want, p)
		}
	}
}

func TestTaskPromptLabelOnlyStillHasContract(t *testing.T) {
	owner := jarvis.NewRun("owner", "ws-1", "/p", nil, jarvis.RunMode_Orchestrator, nil, 1)
	g := &waveobj.TaskGroup{}
	task := &waveobj.TaskNode{ID: "t-1", Label: "plain"}
	p := taskPrompt(g, task, &owner, "claude", "")
	if !strings.HasPrefix(p, workerContract(g, task, "claude")) {
		t.Fatalf("contract must open the prompt: %q", p)
	}
	if strings.Contains(p, "description") {
		t.Fatalf("no description should appear for a label-only task: %q", p)
	}
}

// spec §4: the contract, then the task's text, then the handoff, so a worker reads its obligations first
// and the handoff sits beside the work it shaped.
func TestTaskPromptOrdersContractTaskHandoff(t *testing.T) {
	owner := jarvis.NewRun("owner", "ws-1", "/p", nil, jarvis.RunMode_Orchestrator, nil, 1)
	g := &waveobj.TaskGroup{}
	task := &waveobj.TaskNode{ID: "t-2", Label: "use fmtDate"}
	p := taskPrompt(g, task, &owner, "claude", "landed as commit abc1234")
	ci := strings.Index(p, workerContract(g, task, "claude"))
	ti := strings.Index(p, "use fmtDate")
	hi := strings.Index(p, "landed as commit abc1234")
	if ci != 0 || ti < 0 || hi < 0 || ti > hi {
		t.Fatalf("want contract, task, handoff in that order (contract@%d task@%d handoff@%d): %q", ci, ti, hi, p)
	}
}

func TestWorkerContractNamesPlanSpecVerifyAndTool(t *testing.T) {
	g := &waveobj.TaskGroup{PlanPath: "C:/p/plan.md", SpecPath: "C:/p/spec.md", Verify: "go test ./..."}
	c := workerContract(g, &waveobj.TaskNode{ID: "t-3"}, "pi")
	for _, want := range []string{
		"You are the worker for task 3 of the plan at C:/p/plan.md (spec: C:/p/spec.md).",
		"don't re-plan or pause for design approval",
		"ask once with ask_user_question and concrete options, then wait",
		"Run `go test ./...` and get it passing before you complete; if you can't, ask.",
		"Commit, then `wsh jarvis complete --commit $(git rev-parse HEAD)`.",
		"If your context was compacted, re-read your task from the plan.",
	} {
		if !strings.Contains(c, want) {
			t.Fatalf("contract missing %q:\n%s", want, c)
		}
	}
}

// until slice 5c a dag can still arrive as JSON, with no plan file to point at
func TestWorkerContractWithoutPlanOrVerify(t *testing.T) {
	c := workerContract(&waveobj.TaskGroup{}, &waveobj.TaskNode{ID: "t-3"}, "claude")
	for _, want := range []string{
		"You are the worker for task t-3 of this run's dag.",
		"ask once with AskUserQuestion",
		"Run the tests the task names and get them passing",
	} {
		if !strings.Contains(c, want) {
			t.Fatalf("contract missing %q:\n%s", want, c)
		}
	}
	for _, gone := range []string{"plan at", "spec:", "re-read your task"} {
		if strings.Contains(c, gone) {
			t.Fatalf("a dag without a plan names none, found %q:\n%s", gone, c)
		}
	}
}
```

In `TestTaskPromptRunSpecGoalWins`, change the call to:

```go
	p := taskPrompt(&waveobj.TaskGroup{}, &waveobj.TaskNode{ID: "t-1", Label: "label", RunSpec: waveobj.RunSpec{Goal: "explicit goal"}}, &owner, "claude", "")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/orchestrate/ -run 'TaskPrompt|WorkerContract' -v`
Expected: build failure, `undefined: workerContract` and wrong argument count to `taskPrompt`.

- [ ] **Step 3: Replace the contract in `pkg/orchestrate/engine.go`**

Delete `HeadlessContract` and its five-line comment (`// HeadlessContract is appended to every DAG child's goal...`). Put this in its place:

```go
// workerContract opens every dag worker's prompt (spec §4). The plan is approved, so the worker neither
// re-plans nor guesses a consequential decision: it asks, and the lead or the human answers. It owns its
// task's tests, and it names the plan so a compacted worker can re-read its task.
func workerContract(g *waveobj.TaskGroup, task *waveobj.TaskNode, runtime string) string {
	var b strings.Builder
	if g.PlanPath != "" {
		fmt.Fprintf(&b, "You are the worker for task %s of the plan at %s", strings.TrimPrefix(task.ID, "t-"), g.PlanPath)
		if g.SpecPath != "" {
			fmt.Fprintf(&b, " (spec: %s)", g.SpecPath)
		}
		b.WriteString(".\n")
	} else {
		fmt.Fprintf(&b, "You are the worker for task %s of this run's dag.\n", task.ID)
	}
	fmt.Fprintf(&b, "The plan is approved: don't re-plan or pause for design approval. If a consequential decision isn't pinned, or the plan and the code disagree, ask once with %s and concrete options, then wait; the lead or the human answers.\n", jarvis.AskTool(runtime))
	if g.Verify != "" {
		fmt.Fprintf(&b, "Run `%s` and get it passing before you complete; if you can't, ask.", g.Verify)
	} else {
		b.WriteString("Run the tests the task names and get them passing before you complete; if you can't, ask.")
	}
	b.WriteString(" Commit, then `wsh jarvis complete --commit $(git rev-parse HEAD)`.")
	if g.PlanPath != "" {
		b.WriteString("\nIf your context was compacted, re-read your task from the plan.")
	}
	return b.String()
}
```

Replace `taskPrompt` and its comment (`// taskPrompt is the child's goal...`) with:

```go
// taskPrompt is the child's goal: the worker contract, then the task's text (its RunSpec goal, else its
// label, with the plan description and its decision pins), then the handoff from landed dependencies.
func taskPrompt(g *waveobj.TaskGroup, task *waveobj.TaskNode, owner *waveobj.Run, runtime, handoff string) string {
	var b strings.Builder
	b.WriteString(workerContract(g, task, runtime))
	b.WriteString("\n\n")
	if task.RunSpec.Goal != "" {
		b.WriteString(task.RunSpec.Goal)
	} else if task.Label != "" {
		b.WriteString(task.Label)
	} else {
		fmt.Fprintf(&b, "task %s of %q", task.ID, owner.Goal)
	}
	if task.Description != "" {
		b.WriteString("\n\n")
		b.WriteString(task.Description)
	}
	if handoff != "" {
		b.WriteString("\n\n")
		b.WriteString(handoff)
	}
	return b.String()
}
```

In `scheduleLocked`, change:

```go
		prompt := taskPrompt(task, owner, predecessorHandoff(task, g, runs))
```

to:

```go
		prompt := taskPrompt(g, task, owner, pin.Runtime, predecessorHandoff(task, g, runs))
```

`pin` is the `effectiveTaskRoute` result from the top of the same loop.

- [ ] **Step 4: Run the tests**

Run: `git grep -n "HeadlessContract" -- '*.go'`
Expected: no output.

Run: `go test ./pkg/orchestrate/ -run 'TaskPrompt|WorkerContract|PredecessorHandoff' -v`, then `go test ./pkg/orchestrate/`
Expected: PASS.

---

### Task 3: `wsh jarvis dag rules` and the Claude compaction hooks

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-agent-memory-project.go` (extract `sessionStartPayload`)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`dagRulesCmd`, `dagRulesRun`, `dagRulesText`, `init`)
- Modify: `cmd/wsh/cmd/wshcmd-agenthook.go` (`ccHookEvent.Source`, `planEmission`)
- Modify: `cmd/wsh/cmd/wshcmd-installhooks.go` (`managedHooks`, `isManagedCommand`)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`, `cmd/wsh/cmd/wshcmd-agenthook_test.go`, `cmd/wsh/cmd/wshcmd-installhooks_test.go`

**Interfaces:**
- Consumes: `jarvis.OrchestrationRules` (Task 1), `wshclient.JarvisCtxCommand`, `wshclient.DagStatusCommand`, `setupRpcClient`, `resolveBlockArg`.
- Produces:
  - `func sessionStartPayload(text string) ([]byte, error)`
  - `func dagRulesText(ctx *wshrpc.CommandJarvisCtxRtnData, st *wshrpc.CommandDagStatusRtnData) string`
  - CLI: `wsh jarvis dag rules [--inject]` (hidden)
  - Managed hooks: `PreCompact` → `agent-hook`, SessionStart `compact` → `agent-hook`, SessionStart `compact` → `jarvis dag rules --inject`

- [ ] **Step 1: Write the failing tests**

In `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`, add `"encoding/json"` and `"github.com/wavetermdev/waveterm/pkg/jarvis"` to the imports, and append:

```go
func TestDagRulesTextOnlyForTheLead(t *testing.T) {
	st := &wshrpc.CommandDagStatusRtnData{Group: &waveobj.TaskGroup{RunID: "lead-run", PlanPath: "C:/p/plan.md", SpecPath: "C:/p/spec.md"}}
	lead := &wshrpc.CommandJarvisCtxRtnData{ChannelId: "ch", RunId: "lead-run", DagOID: "dag-1"}
	if got, want := dagRulesText(lead, st), jarvis.OrchestrationRules("lead-run", "C:/p/spec.md", "C:/p/plan.md"); got != want {
		t.Fatalf("lead rules = %q, want %q", got, want)
	}
	// a dag child resolves to its own run, which the dag does not name
	child := &wshrpc.CommandJarvisCtxRtnData{ChannelId: "ch", RunId: "child-run", DagOID: "dag-1"}
	if got := dagRulesText(child, st); got != "" {
		t.Fatalf("a dag child gets no lead rules, got %q", got)
	}
	if got := dagRulesText(lead, &wshrpc.CommandDagStatusRtnData{}); got != "" {
		t.Fatalf("no dag, no rules, got %q", got)
	}
}

func TestDagRulesIsHiddenWithInjectFlag(t *testing.T) {
	if !dagRulesCmd.Hidden {
		t.Fatal("dag rules is plumbing for hooks and must stay out of help")
	}
	if dagRulesCmd.Flags().Lookup("inject") == nil {
		t.Fatal("dag rules needs --inject for the SessionStart hook")
	}
}

func TestSessionStartPayloadShape(t *testing.T) {
	out, err := sessionStartPayload("rules text")
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		HookSpecificOutput struct {
			HookEventName     string `json:"hookEventName"`
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got.HookSpecificOutput.HookEventName != "SessionStart" || got.HookSpecificOutput.AdditionalContext != "rules text" {
		t.Fatalf("payload = %s", out)
	}
	if strings.Contains(string(out), "additional_context") {
		t.Fatalf("exactly one context key may be emitted: %s", out)
	}
}
```

In `cmd/wsh/cmd/wshcmd-agenthook_test.go`, `TestPlanEmission`, add these lines directly after the `{"pre ask -> asking", ...}` case:

```go
		{"pre compact working", ccHookEvent{HookEventName: "PreCompact"}, baseds.AgentState_Working, false},
		{"session start after a compaction is idle", ccHookEvent{HookEventName: "SessionStart", Source: "compact"}, baseds.AgentState_Idle, false},
		{"session start on startup reports nothing", ccHookEvent{HookEventName: "SessionStart", Source: "startup"}, "", false},
```

Append to `cmd/wsh/cmd/wshcmd-installhooks_test.go`:

```go
func TestCompactionHooksAreManaged(t *testing.T) {
	for _, want := range []managedHook{
		{"PreCompact", "", "agent-hook", 10},
		{"SessionStart", "compact", "agent-hook", 10},
		{"SessionStart", "compact", "jarvis dag rules --inject", 15},
	} {
		found := false
		for _, mh := range managedHooks {
			if mh == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("managed hooks missing %+v", want)
		}
	}
	// a command wsh does not recognize is never replaced, so every re-run would add another copy
	if !isManagedCommand(`"C:\bin\wsh-0.14.10-windows.x64.exe" jarvis dag rules --inject`) {
		t.Fatal("the rules hook command is not recognized as Arc-managed")
	}
	merged := mergeAgentHooks(mergeAgentHooks(map[string]any{}, testWsh), testWsh)
	groups, _ := merged["hooks"].(map[string]any)["SessionStart"].([]any)
	if len(groups) != 3 {
		t.Fatalf("SessionStart groups after two merges = %d, want the memory, idle and rules hooks", len(groups))
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./cmd/wsh/cmd/ -run 'DagRules|SessionStartPayload|PlanEmission|CompactionHooks' -v`
Expected: build failure, `undefined: dagRulesText`, `undefined: dagRulesCmd`, `undefined: sessionStartPayload`, and `unknown field Source`.

- [ ] **Step 3: Extract the SessionStart payload**

In `cmd/wsh/cmd/wshcmd-agent-memory-project.go`, add after `resolveProjectCwd`:

```go
// sessionStartPayload wraps text as a SessionStart hook's added context. Claude Code reads both
// additional_context and hookSpecificOutput without deduplication, so exactly one of them may be emitted.
func sessionStartPayload(text string) ([]byte, error) {
	return json.Marshal(map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":     "SessionStart",
			"additionalContext": text,
		},
	})
}
```

In `agentMemoryProjectRun`, replace:

```go
	// claude code reads both additional_context and hookSpecificOutput without deduplication, so
	// exactly one of them may be emitted
	payload := map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":     "SessionStart",
			"additionalContext": manifest,
		},
	}
	out, err := json.Marshal(payload)
```

with:

```go
	out, err := sessionStartPayload(manifest)
```

- [ ] **Step 4: Add `dag rules`**

In `cmd/wsh/cmd/wshcmd-jarvisdag.go`, add `"github.com/wavetermdev/waveterm/pkg/wshutil"` to the imports. Add before `func init()`:

```go
var dagRulesInject bool

// dagRulesCmd prints the orchestration rules for the caller's lead session (spec §7). It runs from a
// SessionStart hook in every Claude session and from pi after every compaction, so it is silent and
// succeeds everywhere else: outside Wave, outside a lead, and before the lead holds a dag.
var dagRulesCmd = &cobra.Command{
	Use:           "rules",
	Short:         "print the orchestration rules for this lead's run (nothing outside a lead holding a dag)",
	Args:          cobra.NoArgs,
	Hidden:        true,
	SilenceErrors: true,
	SilenceUsage:  true,
	RunE:          dagRulesRun,
}

func dagRulesRun(cmd *cobra.Command, args []string) error {
	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" || setupRpcClient(nil, jwt) != nil {
		return nil
	}
	oref, err := resolveBlockArg()
	if err != nil {
		return nil
	}
	ctxRtn, err := wshclient.JarvisCtxCommand(RpcClient, wshrpc.CommandJarvisCtxData{BlockORef: oref.String()}, &wshrpc.RpcOpts{Timeout: 5000})
	if err != nil || ctxRtn.DagOID == "" {
		return nil
	}
	st, err := wshclient.DagStatusCommand(RpcClient, wshrpc.CommandDagStatusData{ChannelId: ctxRtn.ChannelId, RunId: ctxRtn.RunId}, &wshrpc.RpcOpts{Timeout: 5000})
	if err != nil {
		return nil
	}
	text := dagRulesText(ctxRtn, st)
	if text == "" {
		return nil
	}
	if !dagRulesInject {
		fmt.Println(text)
		return nil
	}
	out, err := sessionStartPayload(text)
	if err != nil {
		return nil
	}
	fmt.Println(string(out))
	return nil
}

// dagRulesText is the rules for a caller whose run the dag names, and "" for anyone else: a dag child
// resolves to its own run.
func dagRulesText(ctx *wshrpc.CommandJarvisCtxRtnData, st *wshrpc.CommandDagStatusRtnData) string {
	if ctx == nil || st == nil || st.Group == nil || ctx.RunId == "" || st.Group.RunID != ctx.RunId {
		return ""
	}
	return jarvis.OrchestrationRules(ctx.RunId, st.Group.SpecPath, st.Group.PlanPath)
}
```

In `init()`, change the first line to:

```go
	jarvisDagCmd.AddCommand(dagSubmitCmd, dagImportCmd, dagStatusCmd, dagMergeCmd, dagAsksCmd, dagAnswerCmd, dagForwardCmd, dagRulesCmd)
```

and add after the `dagMergeCmd.Flags()` line:

```go
	dagRulesCmd.Flags().BoolVar(&dagRulesInject, "inject", false, "emit the rules as a Claude Code SessionStart hook's added context")
```

- [ ] **Step 5: Report compaction states from the Claude hook**

In `cmd/wsh/cmd/wshcmd-agenthook.go`, replace `ccHookEvent` with:

```go
// ccHookEvent is the subset of the Claude Code lifecycle-hook stdin payload we use.
type ccHookEvent struct {
	HookEventName  string          `json:"hook_event_name"`
	ToolName       string          `json:"tool_name"`
	ToolUseID      string          `json:"tool_use_id"`
	TranscriptPath string          `json:"transcript_path"`
	ToolInput      json.RawMessage `json:"tool_input"`
	Source         string          `json:"source"`
}
```

In `planEmission`, add these cases after the `case "PreToolUse":` block, inside the switch:

```go
	case "PreCompact":
		// a compaction is work the session cannot take typed input during, and it confirms a typed /compact
		return agentEmission{State: baseds.AgentState_Working}
	case "SessionStart":
		// the session is back at its prompt once the summary lands. an auto-compaction inside a turn reads
		// idle only until that turn's next tool reports working, and a wake typed then queues behind it.
		if ev.Source == "compact" {
			return agentEmission{State: baseds.AgentState_Idle}
		}
```

- [ ] **Step 6: Manage the three hooks**

In `cmd/wsh/cmd/wshcmd-installhooks.go`, insert before `{"SessionEnd", "", "agent-memory-hook", 10},`:

```go
	// a compaction reports working and its end reports idle: the wake adapter types a lead's handoff
	// /compact as a wake that working confirms, and holds later wakes until the session is back
	{"PreCompact", "", "agent-hook", 10},
```

and after `{"SessionStart", "startup|clear|compact", "agent-memory-project --inject", 15},`:

```go
	{"SessionStart", "compact", "agent-hook", 10},
	// a compaction drops a lead's launch prompt, so its orchestration rules come back in its place
	{"SessionStart", "compact", "jarvis dag rules --inject", 15},
```

In `isManagedCommand`, change the case to:

```go
	case "agent-hook", "ask", "ask --clear", "agent-memory-hook", "agent-memory-project --inject", "jarvis dag rules --inject":
```

- [ ] **Step 7: Run the tests**

Run: `go test ./cmd/wsh/cmd/ -run 'DagRules|SessionStartPayload|PlanEmission|CompactionHooks|MergeAgentHooks|SessionStartMemoryHook|IsManagedCommand' -v`, then `go test ./cmd/wsh/...`
Expected: PASS.

---

### Task 4: The handoff compaction

**Files:**
- Modify: `pkg/orchestrate/wake.go` (`HandoffCompact`, `runWake.handoff`, `PostHandoff`, `flushLocked`, `leadDiedLocked`)
- Modify: `pkg/orchestrate/wake_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`postHandoff` seam, the call in `DagSubmitCommand`)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag_test.go`

**Interfaces:**
- Consumes: the wake adapter (`runLocked`, `flushLocked`, `leadStateFn`, `sendWakeFn`, `wakeNow`), `leadORef` in `wshserver_dag.go`, the compaction states from Task 3 and Task 5.
- Produces:
  - `const HandoffCompact string`
  - `func PostHandoff(ctx context.Context, channelId, runId string)`
  - `var postHandoff = orchestrate.PostHandoff` in `wshserver`

- [ ] **Step 1: Write the failing tests**

Append to `pkg/orchestrate/wake_test.go`:

```go
func TestHandoffTypedAloneOnceTheLeadIsAtItsPrompt(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	// the lead is still in the turn that ran `dag submit`
	f.state.State = baseds.AgentState_Working
	PostHandoff(ctx, wakeChannel, wakeRun)
	PostWake(ctx, wakeChannel, wakeRun, finishedLine)
	if len(f.sends) != 0 {
		t.Fatalf("a working lead gets nothing yet, got %q", f.sends)
	}

	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))
	if len(f.sends) != 1 || f.sends[0] != HandoffCompact {
		t.Fatalf("the handoff compaction goes out first and alone, got %q", f.sends)
	}
	if f.countKind(waveobj.RunEventKindLeadWoken) != 1 {
		t.Fatalf("the handoff records one lead-woken row, got %+v", f.rows)
	}

	// PreCompact reports working, and the SessionStart after the compaction reports idle
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))
	if len(f.sends) != 2 || f.sends[1] != finishedLine {
		t.Fatalf("the held wake follows once the compaction is over, got %q", f.sends)
	}
}

func TestHandoffUnconfirmedIsRetriedLikeAWake(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	PostHandoff(ctx, wakeChannel, wakeRun)
	if len(f.sends) != 1 || f.sends[0] != HandoffCompact {
		t.Fatalf("an idle lead gets the handoff at once, got %q", f.sends)
	}
	f.now += WakeConfirmTimeout.Milliseconds()
	tickWakes(ctx)
	if len(f.sends) != 2 || f.sends[1] != "" {
		t.Fatalf("an unconfirmed handoff is retried with Enter alone, got %q", f.sends)
	}
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	f.now += 3 * WakeConfirmTimeout.Milliseconds()
	tickWakes(ctx)
	if len(f.sends) != 2 || LeadDead(wakeRun) {
		t.Fatalf("a confirmed handoff is done, sends=%q dead=%v", f.sends, LeadDead(wakeRun))
	}
}
```

Append to `pkg/wshrpc/wshserver/wshserver_dag_test.go`:

```go
func TestDagSubmitHandsOffOnlyToALead(t *testing.T) {
	ctx := context.Background()
	var handed []string
	old := postHandoff
	postHandoff = func(_ context.Context, channelId, runId string) { handed = append(handed, channelId+"/"+runId) }
	t.Cleanup(func() { postHandoff = old })
	stubRunServer(t, "pi", nil)
	ws := &WshServer{}

	ch, err := wstore.CreateChannel(ctx, "dag-handoff", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	lead := jarvis.NewRun("do the thing", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	lead.Phases[0].WorkerOrefs = []string{"tab:lead-tab"}
	if err := wstore.AppendRun(ctx, ch.OID, lead); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	submit := wshrpc.CommandDagSubmitData{
		ChannelId: ch.OID, RunId: lead.ID, Title: "t", Parallelism: 1,
		Tasks: []waveobj.TaskNode{{ID: "t-1", Label: "one"}},
	}
	if _, err := ws.DagSubmitCommand(ctx, submit); err != nil {
		t.Fatalf("submit: %v", err)
	}
	if _, err := ws.DagSubmitCommand(ctx, submit); err != nil {
		t.Fatalf("identical retry: %v", err)
	}
	if want := []string{ch.OID + "/" + lead.ID}; !reflect.DeepEqual(handed, want) {
		t.Fatalf("handoffs = %v, want exactly one for the lead's first submit %v", handed, want)
	}

	deferred, err := ws.CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "human planned", Runtime: "pi",
		Mode: jarvis.RunMode_Orchestrator, DeferStart: true,
	})
	if err != nil {
		t.Fatalf("create deferred: %v", err)
	}
	if _, err := ws.DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
		ChannelId: ch.OID, RunId: deferred.Run.ID, Title: "g", Parallelism: 1,
		Tasks: []waveobj.TaskNode{{ID: "t-1", Label: "one"}},
	}); err != nil {
		t.Fatalf("submit deferred: %v", err)
	}
	if len(handed) != 1 {
		t.Fatalf("a run with no lead worker gets no handoff, got %v", handed)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/orchestrate/ -run Handoff -v` and `go test ./pkg/wshrpc/wshserver/ -run TestDagSubmitHandsOffOnlyToALead -v`
Expected: build failures, `undefined: PostHandoff`, `undefined: HandoffCompact`, `undefined: postHandoff`.

- [ ] **Step 3: Implement the handoff in `pkg/orchestrate/wake.go`**

Add after the `leadNotRunningNote` const block:

```go
// HandoffCompact is typed into a lead once its plan is handed over (spec §7): the compaction lands at the
// natural boundary instead of mid-wake, and keeps what the spec does not already hold.
const HandoffCompact = "/compact Keep: what the human said that the spec does not record, and the reason behind each decision. Drop: code you read, drafts, tool output."
```

In `runWake`, add after `told map[string]bool`:

```go
	// handoff is a handoff compaction not yet typed.
	handoff bool
```

Add after `PokeWake`:

```go
// PostHandoff queues runId's handoff compaction, typed the next time the lead is at its prompt. It is
// delivered like a wake: the compaction's working report confirms it on both harnesses.
func PostHandoff(ctx context.Context, channelId, runId string) {
	wakes.lock.Lock()
	defer wakes.lock.Unlock()
	rw := wakes.runLocked(channelId, runId)
	if rw.dead {
		return
	}
	rw.handoff = true
	wakes.flushLocked(ctx, runId, rw)
}
```

In `flushLocked`, change:

```go
	if len(rw.lines) == 0 && !untold {
		return
	}
```

to:

```go
	if len(rw.lines) == 0 && !untold && !rw.handoff {
		return
	}
```

and insert directly after `if !atPrompt(st.State) { return }`:

```go
	if rw.handoff {
		// alone and first: a wake joined to it would be summarized away before the lead read it, so held
		// lines wait for the idle report that ends the compaction
		sendWakeFn(st.BlockId, HandoffCompact)
		rw.handoff, rw.sentAt, rw.retried = false, wakeNow(), false
		appendRunEvent(ctx, rw.channelId, runId, waveobj.RunEventKindLeadWoken, nil, map[string]any{"text": HandoffCompact})
		return
	}
```

In `leadDiedLocked`, change:

```go
	rw.lines, rw.sentAt, rw.retried, rw.dead = nil, 0, false, true
```

to:

```go
	rw.lines, rw.sentAt, rw.retried, rw.dead, rw.handoff = nil, 0, false, true, false
```

- [ ] **Step 4: Post the handoff from `DagSubmitCommand`**

In `pkg/wshrpc/wshserver/wshserver_dag.go`, add before `func (ws *WshServer) DagSubmitCommand`:

```go
// postHandoff is a var so tests can see which submits hand a lead its compaction.
var postHandoff = orchestrate.PostHandoff
```

In `DagSubmitCommand`, the `} else {` branch of `if !created` ends with the `RunEventKindDagPlanGated` append. Add at the end of that branch:

```go
		// a lead that just handed its plan over compacts at that boundary (spec §7); a run with no lead
		// worker, a human-planned one, has nobody to compact
		if leadORef(run) != "" {
			postHandoff(ctx, data.ChannelId, data.RunId)
		}
```

- [ ] **Step 5: Run the tests**

Run: `go test ./pkg/orchestrate/ -run 'Wake|Handoff' -v` and `go test ./pkg/wshrpc/wshserver/ -run 'TestDagSubmit' -v`
Expected: PASS.

---

### Task 5: pi compaction states and the rules after a compaction

**Files:**
- Modify: `pi/extensions/waveterm-status.ts`
- Modify: `pi/extensions/waveterm-tools-core.ts`, `pi/extensions/waveterm-tools-core.test.ts`
- Modify: `pi/extensions/waveterm-tools.ts`
- Modify: `cmd/wsh/cmd/pi-status-extension.test.ts`
- Regenerated by `task sync:piartifacts`: `cmd/wsh/cmd/pi-status-extension.ts`, `cmd/wsh/cmd/pi-tools-extension.ts`, `cmd/wsh/cmd/pi-tools-core-extension.ts`

**Interfaces:**
- Consumes: `wsh jarvis dag rules` (Task 3), pi's `session_before_compact`, `session_compact`, `session_compact_failed` and `context` events.
- Produces:
  - `export function dagRulesArgs(): string[]`
  - `export function withOrchestrationRules(messages: unknown[], rules: string, now: number): unknown[] | undefined`

- [ ] **Step 1: Write the failing tests**

In `pi/extensions/waveterm-tools-core.test.ts`, replace the import block with:

```ts
import { describe, expect, it } from "vitest";
import {
    captureTailArgs,
    dagRulesArgs,
    notifyArgs,
    openFileArgs,
    querySessionsArgs,
    runCommandArgs,
    vaultAskArgs,
    withOrchestrationRules,
} from "./waveterm-tools-core";
```

and insert directly after `describe("waveterm-tools-core", () => {`:

```ts
    it("builds the dag rules argv", () => {
        expect(dagRulesArgs()).toEqual(["jarvis", "dag", "rules"]);
    });

    it("appends a lead's rules as the last user message", () => {
        const messages = [{ role: "user", content: "hi", timestamp: 1 }];
        expect(withOrchestrationRules(messages, "  You are the lead for run r-1.\n", 5)).toEqual([
            ...messages,
            { role: "user", content: "You are the lead for run r-1.", timestamp: 5 },
        ]);
    });

    it("leaves a request alone when there are no rules", () => {
        expect(withOrchestrationRules([{ role: "user", content: "hi", timestamp: 1 }], " \n", 5)).toBeUndefined();
    });
```

In `cmd/wsh/cmd/pi-status-extension.test.ts`, change the end of `LIFECYCLE_EVENTS` from:

```ts
    "agent_settled",
    "session_shutdown",
];
```

to:

```ts
    "agent_settled",
    "session_shutdown",
    "session_before_compact",
    "session_compact",
    "session_compact_failed",
];
```

and insert directly after the `it("reports idle on session_start", ...)` test:

```ts
    it("reports working for a compaction and idle after it", async () => {
        const pi = fakePi();
        registerWavetermStatus(pi, "wsh");
        await pi.handlers.get("session_before_compact")![0]({ reason: "manual" }, sessionCtx());
        expect(pi.exec).toHaveBeenLastCalledWith("wsh", expect.arrayContaining(["--state", "working"]));
        await pi.handlers.get("session_compact")![0]({ reason: "manual" }, sessionCtx());
        expect(pi.exec).toHaveBeenLastCalledWith("wsh", expect.arrayContaining(["--state", "idle"]));
    });

    it("keeps a turn working across a compaction inside it", async () => {
        const pi = fakePi();
        registerWavetermStatus(pi, "wsh");
        await pi.handlers.get("agent_start")![0]({}, sessionCtx());
        await pi.handlers.get("session_before_compact")![0]({ reason: "threshold" }, sessionCtx());
        await pi.handlers.get("session_compact")![0]({ reason: "threshold" }, sessionCtx());
        expect(pi.exec).toHaveBeenLastCalledWith("wsh", expect.arrayContaining(["--state", "working"]));
    });

    it("restores the prior state when a compaction fails", async () => {
        const pi = fakePi();
        registerWavetermStatus(pi, "wsh");
        await pi.handlers.get("session_before_compact")![0]({ reason: "manual" }, sessionCtx());
        await pi.handlers.get("session_compact_failed")![0]({ reason: "manual", aborted: false }, sessionCtx());
        expect(pi.exec).toHaveBeenLastCalledWith("wsh", expect.arrayContaining(["--state", "idle"]));
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run pi/extensions/waveterm-tools-core.test.ts cmd/wsh/cmd/pi-status-extension.test.ts`
Expected: FAIL. `dagRulesArgs is not a function`, and the lifecycle tests find no `session_before_compact` handler.

- [ ] **Step 3: Add the core helpers**

In `pi/extensions/waveterm-tools-core.ts`, insert before `export default function noop(): void {}`:

```ts
// dagRulesArgs asks wsh for the orchestration rules of the lead this session is; wsh prints nothing for
// any other session.
export function dagRulesArgs(): string[] {
    return ["jarvis", "dag", "rules"];
}

// withOrchestrationRules appends a lead's rules to a provider request as its last message (orchestrator
// redesign §7). No rules leaves the request untouched, which is every session that is not a lead holding
// a dag.
export function withOrchestrationRules(messages: unknown[], rules: string, now: number): unknown[] | undefined {
    const text = rules.trim();
    if (!text) {
        return undefined;
    }
    return [...messages, { role: "user", content: text, timestamp: now }];
}

```

- [ ] **Step 4: Report compaction states**

In `pi/extensions/waveterm-status.ts`, replace:

```ts
    pi.on("agent_settled", (_event: any, ctx: any) => report(ctx, "idle"));
    pi.on("session_shutdown", (_event: any, ctx: any) => report(ctx, "idle"));
```

with:

```ts
    pi.on("agent_settled", (_event: any, ctx: any) => report(ctx, "idle"));
    pi.on("session_shutdown", (_event: any, ctx: any) => report(ctx, "idle"));
    // a compaction holds the session like a turn: it confirms a typed handoff /compact and keeps wakes out
    // while it runs. afterwards the session is back in whatever state the compaction interrupted.
    let beforeCompact: "working" | "idle" = "idle";
    pi.on("session_before_compact", async (_event: any, ctx: any) => {
        beforeCompact = state;
        await report(ctx, "working");
    });
    pi.on("session_compact", (_event: any, ctx: any) => report(ctx, beforeCompact));
    pi.on("session_compact_failed", (_event: any, ctx: any) => report(ctx, beforeCompact));
```

- [ ] **Step 5: Bring the rules back after a compaction**

In `pi/extensions/waveterm-tools.ts`, replace the import block with:

```ts
import { Type } from "typebox";
import {
    captureTailArgs,
    dagRulesArgs,
    notifyArgs,
    openFileArgs,
    querySessionsArgs,
    runCommandArgs,
    vaultAskArgs,
    withOrchestrationRules,
} from "./waveterm-tools-core";
```

and replace the end of `registerWavetermTools`:

```ts
    pi.on("agent_settled", async (event: any, ctx: any) => {
        // The settled-payload error signal is confirmed during Task 8's live round-trip; the
        // predicate below covers the documented error carriers (event.error / ctx.lastError).
        if (event?.error || ctx?.lastError) {
            await notify("Pi session ended with an error", { level: "error" });
        }
    });
}
```

with:

```ts
    pi.on("agent_settled", async (event: any, ctx: any) => {
        // The settled-payload error signal is confirmed during Task 8's live round-trip; the
        // predicate below covers the documented error carriers (event.error / ctx.lastError).
        if (event?.error || ctx?.lastError) {
            await notify("Pi session ended with an error", { level: "error" });
        }
    });

    // --- orchestrator lead: the rules after a compaction ------------------------------------------

    // a compaction drops the lead's launch prompt, so the rules are fetched once per compaction and ride
    // on every later request. a failed fetch keeps the last rules: they only name the run and its files.
    let rules = "";
    pi.on("session_compact", async () => {
        const r = await wsh(dagRulesArgs());
        if (r.ok) {
            rules = r.stdout;
        }
    });
    pi.on("context", (event: any) => {
        const messages = withOrchestrationRules(event?.messages ?? [], rules, Date.now());
        return messages ? { messages } : undefined;
    });
}
```

- [ ] **Step 6: Sync the embedded copies and run the tests**

Run: `task sync:piartifacts`, then `git status --short cmd/wsh/cmd`
Expected: `pi-status-extension.ts`, `pi-tools-extension.ts` and `pi-tools-core-extension.ts` modified.

Run: `npx vitest run pi/extensions cmd/wsh/cmd`
Expected: PASS.

Run: `go test ./cmd/wsh/cmd/ -run 'Pi|Install' -v`
Expected: PASS. The Go side embeds the copies.

---

### Task 6: A lead that exits before submitting fails its run

**Files:**
- Modify: `pkg/jarvis/onexit.go` (`LeadExitHook`, `notifyLeadExit`, `OnWorkerExit`)
- Modify: `pkg/jarvis/onexit_test.go`
- Modify: `pkg/orchestrate/outcome.go` (`init`, `workerRunIds`, `HandleChildOutcome`, `HandleLeadExit`; delete `isOrchestratorLead` and `failLeadRun`)
- Modify: `pkg/orchestrate/outcome_test.go`
- Modify: `pkg/waveobj/runevent.go` (`RunEventKindLeadExited`)
- Modify: `frontend/app/view/agents/runtimeline.ts`, `frontend/app/view/agents/runtimeline.test.ts`
- Modify: `frontend/app/view/orchestrate/timelinefilter.ts`, `frontend/app/view/orchestrate/timelinefilter.test.ts`

**Interfaces:**
- Consumes: `workerOwnerOf`, `appendRunEvent`, `jarvis.FailPhase`, `jarvis.RunningPhaseIndex`, `wstore.UpdateRun`, `wcore.SendWaveObjUpdate`.
- Produces:
  - `var LeadExitHook func(context.Context, string) error` (pkg/jarvis)
  - `func HandleLeadExit(ctx context.Context, workerORef string) error` (pkg/orchestrate)
  - `RunEventKindLeadExited = "lead-exited"`, detail `"reason"`
  - Timeline title `Lead exited`, tone `text-warning`, an attention kind

- [ ] **Step 1: Write the failing tests**

In `pkg/jarvis/onexit_test.go`, add `"path/filepath"` to the imports and append:

```go
// a lead can exit before its transcript exists on disk; its run still has to learn that it is gone
func TestOnWorkerExitReportsALeadExitBeforeTheTranscriptParses(t *testing.T) {
	ctx := context.Background()
	tabOID, blockOID := uuid.NewString(), uuid.NewString()
	tabORef := waveobj.MakeORef(waveobj.OType_Tab, tabOID).String()
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: tabOID, BlockIds: []string{blockOID}, Meta: waveobj.MetaMapType{"session:agent": "claude"}}); err != nil {
		t.Fatalf("seed tab: %v", err)
	}
	block := &waveobj.Block{OID: blockOID, ParentORef: tabORef, Meta: waveobj.MetaMapType{
		waveobj.MetaKey_AgentTranscriptPath: filepath.Join(t.TempDir(), "never-written.jsonl"),
	}}
	if err := wstore.DBInsert(ctx, block); err != nil {
		t.Fatalf("seed block: %v", err)
	}
	old := LeadExitHook
	t.Cleanup(func() { LeadExitHook = old })
	var got []string
	LeadExitHook = func(_ context.Context, worker string) error {
		got = append(got, worker)
		return nil
	}

	OnWorkerExit(blockOID, 0)

	if len(got) != 1 || got[0] != tabORef {
		t.Fatalf("lead exit hook calls = %v, want [%s]", got, tabORef)
	}
}
```

Append to `pkg/orchestrate/outcome_test.go`:

```go
// newLeadExitRun stores an orchestrator run whose lead tab is "tab:lead-tab", and captures run events.
func newLeadExitRun(t *testing.T, mutate func(*waveobj.Run)) (context.Context, string, *waveobj.Run, *[]map[string]any) {
	t.Helper()
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "lead-exit", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := jarvis.NewRun("goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	run.Phases[0].WorkerOrefs = []string{"tab:lead-tab"}
	if mutate != nil {
		mutate(&run)
	}
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatal(err)
	}
	rows := &[]map[string]any{}
	oldOwner, oldAppend := workerOwnerOf, appendRunEvent
	workerOwnerOf = func(context.Context, string) (string, string, error) {
		return waveobj.MakeORef(waveobj.OType_Run, run.ID).String(), waveobj.MakeORef(waveobj.OType_Channel, ch.OID).String(), nil
	}
	appendRunEvent = func(_ context.Context, _, _, kind string, _ *int, detail any) {
		row := map[string]any{"eventkind": kind}
		if d, ok := detail.(map[string]any); ok {
			for k, v := range d {
				row[k] = v
			}
		}
		*rows = append(*rows, row)
	}
	t.Cleanup(func() { workerOwnerOf, appendRunEvent = oldOwner, oldAppend })
	return ctx, ch.OID, &run, rows
}

func TestLeadExitBeforeSubmitFailsTheRunWithAReason(t *testing.T) {
	ctx, channelId, run, rows := newLeadExitRun(t, nil)
	if err := HandleLeadExit(ctx, "tab:lead-tab"); err != nil {
		t.Fatal(err)
	}
	got, err := wstore.GetRun(ctx, channelId, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != jarvis.RunStatus_Blocked || got.Phases[0].State != jarvis.PhaseState_Failed {
		t.Fatalf("run status=%q phase=%q, want blocked and failed", got.Status, got.Phases[0].State)
	}
	if len(*rows) != 1 || (*rows)[0]["eventkind"] != waveobj.RunEventKindLeadExited || (*rows)[0]["reason"] != leadExitedNote {
		t.Fatalf("want one lead-exited row with the reason, got %+v", *rows)
	}
}

func TestLeadExitLeavesOtherRunsAlone(t *testing.T) {
	for name, mutate := range map[string]func(*waveobj.Run){
		// G8: after submit the engine keeps running the dag, and the wake adapter hands judgment to the human
		"submitted": func(r *waveobj.Run) { r.DagORef = "dag-1" },
		// a spike or bounded lead completes before it exits. a failed CompletePhase leaves the run
		// executing, which the status check below then catches
		"finished": func(r *waveobj.Run) {
			next, _ := jarvis.CompletePhase(*r, 0, nil, 2)
			*r = next
		},
		"pipeline": func(r *waveobj.Run) { r.Mode = jarvis.RunMode_Pipeline },
	} {
		t.Run(name, func(t *testing.T) {
			ctx, channelId, run, rows := newLeadExitRun(t, mutate)
			before := run.Status
			if err := HandleLeadExit(ctx, "tab:lead-tab"); err != nil {
				t.Fatal(err)
			}
			got, err := wstore.GetRun(ctx, channelId, run.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != before || len(*rows) != 0 {
				t.Fatalf("status %q -> %q, rows %+v: a %s run is not the lead-exit case", before, got.Status, *rows, name)
			}
		})
	}
}
```

In `frontend/app/view/agents/runtimeline.test.ts`, insert after `expect(toneFor("lead-wake-failed")).toBe("text-warning");`:

```ts
        expect(toneFor("lead-exited")).toBe("text-warning");
```

and after `expect(eventKindTitle("lead-wake-failed")).toBe("Lead wake failed");`:

```ts
        expect(eventKindTitle("lead-exited")).toBe("Lead exited");
```

In `frontend/app/view/orchestrate/timelinefilter.test.ts`, change:

```ts
            "lead-wake-failed",
        ]) {
```

to:

```ts
            "lead-wake-failed",
            "lead-exited",
        ]) {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvis/ -run TestOnWorkerExitReportsALeadExit -v` and `go test ./pkg/orchestrate/ -run LeadExit -v`
Expected: build failures, `undefined: LeadExitHook`, `undefined: HandleLeadExit`, `undefined: waveobj.RunEventKindLeadExited`.

Run: `npx vitest run frontend/app/view/agents/runtimeline.test.ts frontend/app/view/orchestrate/timelinefilter.test.ts`
Expected: FAIL on `lead-exited`.

- [ ] **Step 3: Add the run event kind**

In `pkg/waveobj/runevent.go`, replace:

```go
	//   lead-wake-failed  the lead cannot take wakes; its judgment goes to the human ("reason", "lines")
	RunEventKindTaskForwarded  = "task-forwarded"
	RunEventKindLeadWoken      = "lead-woken"
	RunEventKindLeadWakeFailed = "lead-wake-failed"
```

with:

```go
	//   lead-wake-failed  the lead cannot take wakes; its judgment goes to the human ("reason", "lines")
	//   lead-exited       the lead exited before submitting a plan, which fails the run ("reason")
	RunEventKindTaskForwarded  = "task-forwarded"
	RunEventKindLeadWoken      = "lead-woken"
	RunEventKindLeadWakeFailed = "lead-wake-failed"
	RunEventKindLeadExited     = "lead-exited"
```

- [ ] **Step 4: Call the hook on every agent tab exit**

In `pkg/jarvis/onexit.go`, add after `notifyChildOutcome`:

```go
// LeadExitHook, when set (by pkg/orchestrate at init), hears every agent worker tab exit before its
// transcript is read: a lead that exits before it submits a plan must fail its run whether or not its
// transcript parses, and a Claude session may not have written one yet.
var LeadExitHook func(context.Context, string) error

func notifyLeadExit(ctx context.Context, workerORef string) {
	if LeadExitHook == nil {
		return
	}
	if err := LeadExitHook(ctx, workerORef); err != nil {
		log.Printf("jarvis lead exit for %s: %v", workerORef, err)
	}
}
```

In `OnWorkerExit`, replace:

```go
	data, ok := exitOutcome(tpath, runtime, exitCode)
	if !ok {
		return
	}
	workerORef := waveobj.MakeORef(waveobj.OType_Tab, tabId).String()
	notifyChildOutcome(ctx, workerORef, data)
```

with:

```go
	workerORef := waveobj.MakeORef(waveobj.OType_Tab, tabId).String()
	notifyLeadExit(ctx, workerORef)
	data, ok := exitOutcome(tpath, runtime, exitCode)
	if !ok {
		return
	}
	notifyChildOutcome(ctx, workerORef, data)
```

- [ ] **Step 5: Fail the run in `pkg/orchestrate/outcome.go`**

Add `"github.com/wavetermdev/waveterm/pkg/wcore"` to the imports. Replace `init` with:

```go
func init() {
	jarvis.ChildOutcomeHook = HandleChildOutcome
	jarvis.LeadExitHook = HandleLeadExit
}
```

In `HandleChildOutcome`, replace everything from `runORef, channelORef, err := workerOwnerOf(ctx, workerORef)` through `if run.DagORef == "" {` and its `return nil }` with:

```go
	channelId, runId, err := workerRunIds(ctx, workerORef)
	if err != nil || runId == "" {
		return err
	}
	run, err := wstore.GetRun(ctx, channelId, runId)
	if err != nil {
		return fmt.Errorf("loading child run %s: %w", runId, err)
	}
	if run.DagORef == "" {
		return nil
	}
```

This removes the `data.NoTranscript && isOrchestratorLead` branch.

Delete `isOrchestratorLead` and `failLeadRun` with their comments. Put this in their place:

```go
// workerRunIds resolves the channel and run a worker tab was spawned for; empty ids for a tab no run owns.
func workerRunIds(ctx context.Context, workerORef string) (string, string, error) {
	runORef, channelORef, err := workerOwnerOf(ctx, workerORef)
	if err != nil {
		return "", "", fmt.Errorf("resolving owner for worker %s: %w", workerORef, err)
	}
	if runORef == "" || channelORef == "" {
		return "", "", nil
	}
	runRef, err := waveobj.ParseORef(runORef)
	if err != nil || runRef.OType != waveobj.OType_Run {
		return "", "", fmt.Errorf("worker %s has invalid run oref %q", workerORef, runORef)
	}
	channelRef, err := waveobj.ParseORef(channelORef)
	if err != nil || channelRef.OType != waveobj.OType_Channel {
		return "", "", fmt.Errorf("worker %s has invalid channel oref %q", workerORef, channelORef)
	}
	return channelRef.OID, runRef.OID, nil
}

// leadExitedNote is why a run whose lead exited before submitting a plan stopped (spec §2, G8).
const leadExitedNote = "lead exited before submitting a plan"

// HandleLeadExit fails an orchestrator run whose lead exited before it submitted a plan: nothing else will
// move the run, and the human needs to see why it stopped. A lead that already submitted leaves its dag
// running, and the wake adapter hands its judgment to the human instead (G8).
func HandleLeadExit(ctx context.Context, workerORef string) error {
	channelId, runId, err := workerRunIds(ctx, workerORef)
	if err != nil || runId == "" {
		return err
	}
	// every agent tab exit lands here, dag children included; only a lead with no dag is worth a write
	run, err := wstore.GetRun(ctx, channelId, runId)
	if err != nil {
		return fmt.Errorf("loading run %s: %w", runId, err)
	}
	if run.Mode != jarvis.RunMode_Orchestrator || run.DagORef != "" {
		return nil
	}
	failed := false
	err = wstore.UpdateRun(ctx, channelId, runId, func(cur *waveobj.Run) error {
		failed = false
		// decided under the update: a submit or a completion that lands just before the exit wins
		if cur.Mode != jarvis.RunMode_Orchestrator || cur.DagORef != "" {
			return nil
		}
		if cur.Status != jarvis.RunStatus_Executing && cur.Status != jarvis.RunStatus_Planning {
			return nil
		}
		i := jarvis.RunningPhaseIndex(*cur)
		if i < 0 {
			return nil
		}
		updated, ferr := jarvis.FailPhase(*cur, i, time.Now().UnixMilli())
		if ferr != nil {
			return ferr
		}
		*cur = updated
		failed = true
		return nil
	})
	if err != nil || !failed {
		return err
	}
	appendRunEvent(ctx, channelId, runId, waveobj.RunEventKindLeadExited, nil, map[string]any{"reason": leadExitedNote})
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Run, runId))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, channelId))
	return nil
}
```

- [ ] **Step 6: Show the row in the timeline**

In `frontend/app/view/agents/runtimeline.ts`:
- In `RUN_GROUP_KINDS`, change `"lead-wake-failed",` followed by `"task-verify-started",` to `"lead-wake-failed",`, `"lead-exited",`, `"task-verify-started",`.
- After `"lead-wake-failed": "Lead wake failed",` add `"lead-exited": "Lead exited",`.
- After `"lead-wake-failed": "text-warning",` add `"lead-exited": "text-warning",`.

In `frontend/app/view/orchestrate/timelinefilter.ts`, change the end of `ATTENTION_KINDS` from:

```ts
    "lead-wake-failed",
]);
```

to:

```ts
    "lead-wake-failed",
    "lead-exited",
]);
```

- [ ] **Step 7: Run the tests**

Run: `git grep -n "isOrchestratorLead\|failLeadRun" -- '*.go'`
Expected: no output.

Run: `go test ./pkg/jarvis/ ./pkg/orchestrate/` and `npx vitest run frontend/app/view/agents/runtimeline.test.ts frontend/app/view/orchestrate/timelinefilter.test.ts`
Expected: PASS.

---

### Task 7: Docs, full verification, live check, commit

**Files:**
- Modify: `docs/orchestrator-howto.md`

- [ ] **Step 1: Update the howto**

In `docs/orchestrator-howto.md`, insert before the line `Everything else is machinery. The rest of this document is what that machinery looks like from the`:

```markdown
> **Update 2026-09-15 (orchestrator redesign, slice 5a):**
> - **Lead:** an engine lead no longer plans the dag in JSON. From a goal it brainstorms with you, writes the
>   spec and a plan in the plan format, and runs `wsh jarvis dag submit --plan <plan> --spec <spec>`. The plan
>   gate still holds it until slice 5c.
> - **Compaction:** once the lead submits, the engine types a `/compact` that keeps what you said and drops the
>   drafts. After any compaction the lead gets its orchestration rules back (`wsh jarvis dag rules`).
> - **Workers:** every worker's prompt opens with a contract that names its task in the plan.
> - **Dead lead:** a lead that exits before submitting fails the run with a `Lead exited` row.

```

- [ ] **Step 2: Full verification**

From PowerShell at the repo root, with the CGO flags set:

```powershell
go test ./pkg/jarvis/... ./pkg/orchestrate/... ./pkg/wshrpc/... ./pkg/waveobj/... ./cmd/wsh/...
go vet ./pkg/jarvis/... ./pkg/orchestrate/... ./pkg/wshrpc/... ./pkg/waveobj/... ./cmd/wsh/...
task generate
git status --short
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
```

Expected:
- **Go:** tests pass and vet is clean.
- **`task generate`:** changes no generated file. `lead-exited` is a Go constant the frontend spells itself, and no wshrpc type changed.
- **tsc:** exit 0.
- **vitest:** passes. `frontend/preview/mock/mockwaveenv.test.ts` has timed out under full-suite load before and passes alone. Re-run a failure alone before treating it as this slice's.

Formatting, only on this slice's hunks:

```powershell
gofmt -d pkg/jarvis/leadprompt.go pkg/jarvis/leadprompt_test.go pkg/jarvis/run.go pkg/jarvis/runexec.go pkg/jarvis/onexit.go pkg/orchestrate/engine.go pkg/orchestrate/wake.go pkg/orchestrate/outcome.go pkg/waveobj/runevent.go pkg/wshrpc/wshserver/wshserver_dag.go cmd/wsh/cmd/wshcmd-jarvisdag.go cmd/wsh/cmd/wshcmd-agenthook.go cmd/wsh/cmd/wshcmd-installhooks.go cmd/wsh/cmd/wshcmd-agent-memory-project.go
npx prettier --check pi/extensions/waveterm-status.ts pi/extensions/waveterm-tools.ts pi/extensions/waveterm-tools-core.ts pi/extensions/waveterm-tools-core.test.ts cmd/wsh/cmd/pi-status-extension.test.ts frontend/app/view/agents/runtimeline.ts frontend/app/view/orchestrate/timelinefilter.ts
```

If a file is flagged, check whether HEAD's version already is (`git show HEAD:<path> | npx prettier --stdin-filepath <path> --check`), and fix only this slice's hunks.

- [ ] **Step 3: Live check**

1. `task build:backend`, then start the dev app with `task dev`. If another session's dev app is running, ask the user before stopping it, and never kill a `wavesrv` without approval. Launching runs `install-agent-hooks` with the rebuilt `wsh`.
   - Expected: `~/.claude/settings.json` has a `PreCompact` group running `agent-hook`, plus SessionStart `compact` groups running `agent-hook` and `jarvis dag rules --inject`.
   - Expected: `~/.pi/agent/extensions/waveterm-tools.ts` contains `dagRulesArgs`.
2. Create a scratch git repo with one commit, outside the repo (`%TEMP%`). From + Run, start an Orchestrator run there with a Claude lead and this goal:

   ```text
   Add hello.txt containing "hi" and bye.txt containing "bye". Treat this as architectural: write a two-sentence spec and a plan with two tasks, one per file, both "**Depends on:** none", with the Verify line `git log --oneline -1`, under docs/, and submit them.
   ```

   Answer the lead's brainstorming questions from the cockpit, and approve the plan at the gate.

   Expected:
   - The lead's first message quotes the launch prompt: `Goal:`, `superpowers:brainstorming`, `wsh jarvis dag submit --plan`.
   - After the submitting turn ends, the timeline shows `Lead woken` with the `/compact Keep:` text, and the lead compacts.
   - After the compaction, the lead's SessionStart hook output carries `You are the lead for run`. If the transcript view does not show it, run `! wsh jarvis dag rules` in the lead's terminal; it prints the rules there.
   - No `Lead wake failed` row appears between the handoff and the next wake.
   - Each worker's prompt opens with `You are the worker for task 1 of the plan at` (or task 2).
   - Both tasks land. `wake: run finished` is typed into the lead, which reports and runs `wsh jarvis complete`.
3. Start a second Orchestrator run on the same repo and type `/exit` in the lead's terminal before it submits.
   - Expected: the run reads blocked, and the timeline shows `Lead exited` with `lead exited before submitting a plan`.
4. Stop the dev app and delete the scratch repo and its channel.

If the dev app cannot be driven from this session, say so in the report, and do not claim the handoff, the rules or the lead exit were verified live.

- [ ] **Step 4: Self-review the diff**

Run `git diff`. Check:
- No debug output and no commented-out code.
- Every new comment says why.
- The slice's decisions are the ones this plan lists.

- [ ] **Step 5: Commit**

Run `git status --short` again, then stage exactly:

```bash
git add pkg/jarvis/leadprompt.go pkg/jarvis/leadprompt_test.go pkg/jarvis/run.go pkg/jarvis/runexec.go pkg/jarvis/run_test.go pkg/jarvis/run_dagprompt_test.go pkg/jarvis/onexit.go pkg/jarvis/onexit_test.go \
  pkg/orchestrate/engine.go pkg/orchestrate/engine_test.go pkg/orchestrate/wake.go pkg/orchestrate/wake_test.go pkg/orchestrate/outcome.go pkg/orchestrate/outcome_test.go \
  pkg/waveobj/runevent.go pkg/wshrpc/wshserver/wshserver_dag.go pkg/wshrpc/wshserver/wshserver_dag_test.go \
  cmd/wsh/cmd/wshcmd-jarvisdag.go cmd/wsh/cmd/wshcmd-jarvisdag_test.go cmd/wsh/cmd/wshcmd-agent-memory-project.go cmd/wsh/cmd/wshcmd-installhooks.go cmd/wsh/cmd/wshcmd-installhooks_test.go cmd/wsh/cmd/wshcmd-agenthook.go cmd/wsh/cmd/wshcmd-agenthook_test.go \
  pi/extensions/waveterm-status.ts pi/extensions/waveterm-tools.ts pi/extensions/waveterm-tools-core.ts pi/extensions/waveterm-tools-core.test.ts \
  cmd/wsh/cmd/pi-status-extension.ts cmd/wsh/cmd/pi-tools-extension.ts cmd/wsh/cmd/pi-tools-core-extension.ts cmd/wsh/cmd/pi-status-extension.test.ts \
  frontend/app/view/agents/runtimeline.ts frontend/app/view/agents/runtimeline.test.ts frontend/app/view/orchestrate/timelinefilter.ts frontend/app/view/orchestrate/timelinefilter.test.ts \
  docs/orchestrator-howto.md docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md docs/superpowers/plans/2026-09-15-orchestrator-redesign-s5a-lead-prompt-compaction.md
git commit -m "feat(orchestrate): a goal-run lead brainstorms, hands the engine a plan file and is compacted at the handoff, gets its rules back after every compaction, and fails its run visibly if it exits before submitting"
```

- [ ] **Step 6: Tick the effort chunk**

```bash
wsh effort chunk status aeabb4ad-a19c-4f5d-bba2-44586b73af16 "S5a lead prompt + compaction - pi /compact probe, launch prompt + orchestration rules, worker contract, dag rules, handoff /compact, Claude + pi re-orientation, dead lead before submit (plan)" done --note "<commit sha> <date>: <what landed, what was verified, what was not live-checked>"
```
