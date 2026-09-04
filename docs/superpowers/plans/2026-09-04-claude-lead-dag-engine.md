# Claude Lead on the DAG Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Claude Code orchestrator lead drive the real DAG engine — publishing a `TaskGroup`, spawning managed-worktree children, and resolving the merge gate — as an explicit composer choice, alongside pi.

**Architecture:** The engine is already runtime-neutral end to end; only the lead's prompt, its wake channel, and its DAG-submission ergonomics are pi-shaped. This adds an `Orchestration` field (`engine | adaptive`) that forks the prompt instead of the runtime forking it, a pull-based `wsh jarvis dag wait` that blocks on the already-registered `dag:*` events, and a `--file` source for the already-runtime-neutral `dag submit`.

**Tech Stack:** Go 1.25.6 (`pkg/jarvis`, `pkg/orchestrate`, `pkg/wshrpc`, `cmd/wsh`), React 19 + Tailwind 4 + jotai (`frontend/app/view/agents`, `frontend/app/view/jarvis`), Task + vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-claude-lead-dag-engine-design.md`

## Global Constraints

- **Do not commit per task.** The repo's git rule is one batched commit at the end, and only with the user's explicit approval. Each task below ends with verification, not a commit. The spec and this plan fold into that single feature commit — never a docs-only commit.
- **Never hand-edit generated files.** After changing anything in `pkg/waveobj` or `pkg/wshrpc`, run `task generate`. It rewrites `frontend/app/store/wshclientapi.ts` and the generated TS/Go type files.
- **Appending to an existing test file: use Edit, never Write.** Write replaces the whole file and silently destroys the existing tests.
- **Typecheck** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Bare `npx tsc` stack-overflows on this repo. Baseline is clean, so any error reported is yours.
- **`go test ./pkg/wshrpc/wshserver/` needs CGO_CFLAGS** with a Windows-style path, or it fails to build with `sqlite3.h: No such file or directory`. From the repo root in PowerShell, once per shell:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  ```
  `pkg/jarvis`, `pkg/orchestrate` and `cmd/wsh/cmd` build without it.
- **No emojis anywhere.** Code comments are lowercase and explain *why*, never *what*, and only where the reason is not obvious.
- **Colors come from `@theme` tokens** in `frontend/tailwindsetup.css`. Never a raw hex or rgba in a component — a hardcoded color silently opts out of every runtime theme.
- **Do not run `prettier --write`** on files you did not author wholesale. It reorders imports and rewraps the file, turning a 4-line edit into a 600-line diff. Hand-format your own lines to match the surrounding file.
- **`task build:backend`** must run before any live check, or new `wsh` subcommands route-error against a stale `wavesrv`.

---

### Task 1: Raise the DAG task ceiling to 16

`MaxTasks = 8` has no recorded rationale and forces a normal plan to be compressed. The engine prompt (Task 2) must state the ceiling, and `pkg/orchestrate` imports `pkg/jarvis` (`dag.go:9`, `engine.go:12`, `leadclose.go:10`, `mutation.go:12`, `outcome.go:8`), so `pkg/jarvis` cannot import it back. The value is declared in `pkg/jarvis` and aliased at the enforcement site.

**Files:**
- Modify: `pkg/jarvis/run.go` (constant block near `RunMode_*`, around line 36)
- Modify: `pkg/orchestrate/dag.go:39`
- Test: `pkg/orchestrate/dag_test.go` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `jarvis.MaxDagTasks` (untyped int constant, value 16) — Task 2's prompt reads it. `orchestrate.MaxTasks` keeps its name and meaning for every existing caller.

- [ ] **Step 1: Write the failing test**

Append to `pkg/orchestrate/dag_test.go`. Check the file's existing import block first and add `fmt` and `strings` only if they are not already there.

```go
func TestNewTaskGroupTaskCeiling(t *testing.T) {
	mk := func(n int) []waveobj.TaskNode {
		out := make([]waveobj.TaskNode, n)
		for i := range out {
			out[i] = waveobj.TaskNode{ID: fmt.Sprintf("t-%d", i), Label: fmt.Sprintf("task %d", i)}
		}
		return out
	}
	if MaxTasks != jarvis.MaxDagTasks {
		t.Fatalf("MaxTasks must alias jarvis.MaxDagTasks: %d vs %d", MaxTasks, jarvis.MaxDagTasks)
	}
	if MaxTasks < 16 {
		t.Fatalf("task ceiling regressed to %d", MaxTasks)
	}
	if _, err := NewTaskGroup("run-1", "ch-1", "title", 2, false, mk(MaxTasks), 1000, nil); err != nil {
		t.Fatalf("%d tasks must be accepted: %v", MaxTasks, err)
	}
	_, err := NewTaskGroup("run-1", "ch-1", "title", 2, false, mk(MaxTasks+1), 1000, nil)
	if err == nil || !strings.Contains(err.Error(), "no more than 16 tasks") {
		t.Fatalf("want ceiling error naming 16, got %v", err)
	}
}
```

- [ ] **Step 2: Run it to make sure it fails**

```
go test ./pkg/orchestrate/ -run TestNewTaskGroupTaskCeiling -count=1
```

Expected: FAIL to compile — `undefined: jarvis.MaxDagTasks`.

- [ ] **Step 3: Declare the constant in pkg/jarvis**

In `pkg/jarvis/run.go`, beside the `RunMode_*` block:

```go
// MaxDagTasks is the ceiling orchestrate.MaxTasks enforces. It lives here because the lead's engine
// prompt has to state it while planning, and pkg/orchestrate imports pkg/jarvis, never the reverse.
// The cap bounds blast radius — a lead fanning dozens of children into a user's repo — not resource
// use: concurrency is governed by Parallelism, and each worktree is removed on merge.
const MaxDagTasks = 16
```

- [ ] **Step 4: Alias it at the enforcement site**

In `pkg/orchestrate/dag.go`, replace `const MaxTasks = 8` with:

```go
// MaxTasks is the per-DAG node ceiling, declared in pkg/jarvis so the lead's prompt can state it.
// See jarvis.MaxDagTasks for what the cap is actually for. MaxParallelism is the limit that governs
// concurrent cost; this one only bounds how much one lead can fan out.
const MaxTasks = jarvis.MaxDagTasks
```

`pkg/orchestrate/dag.go:9` already imports `pkg/jarvis`, so no import change is needed.

- [ ] **Step 5: Run the tests and make sure they pass**

```
go test ./pkg/orchestrate/ -count=1
```

Expected: PASS, whole package. Any pre-existing test that hardcoded 8 as the rejection boundary must be updated to use `MaxTasks`, not re-pinned to 8.

---

### Task 2: `Orchestration` field and the prompt fork

The field travels composer → run → prompt, and the prompt forks on it rather than on runtime. Empty must reproduce today's behaviour byte for byte so runs created before this change are unaffected.

**Files:**
- Modify: `pkg/jarvis/run.go` (constants; `BuildOrchestratePrompt`; replace `buildPiOrchestratePrompt`)
- Modify: `pkg/jarvis/runexec.go:177`
- Modify: `pkg/waveobj/wtype.go` (`Run`, beside `WorkerRoute` around line 291)
- Modify: `pkg/wshrpc/wshrpctypes_runs.go` (`CommandCreateRunData`, around line 29)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (after `run.WorkerRoute = data.WorkerRoute`)
- Test: `pkg/jarvis/run_test.go` (append; `TestBuildOrchestratePrompt` at line 323 is rewritten)
- Test: `pkg/wshrpc/wshserver/wshserver_run_test.go` (append)

**Interfaces:**
- Consumes: `jarvis.MaxDagTasks` from Task 1.
- Produces:
  - `jarvis.Orchestration_Engine = "engine"`, `jarvis.Orchestration_Adaptive = "adaptive"`
  - `jarvis.ResolveOrchestration(orchestration, runtime string) string`
  - `jarvis.BuildOrchestratePrompt(goal string, principles waveobj.PrincipleList, runtime, orchestration string) string` — note the **new fourth parameter**; the old three-arg form is gone.
  - `waveobj.Run.Orchestration string` (json `orchestration,omitempty`)
  - `wshrpc.CommandCreateRunData.Orchestration string` (json `orchestration,omitempty`) — Task 5 sends it.

- [ ] **Step 1: Write the failing tests**

In `pkg/jarvis/run_test.go`, **replace** the existing `TestBuildOrchestratePrompt` (line 323) with the two tests below, and append the third. Use Edit; do not rewrite the file.

```go
func TestBuildOrchestratePromptAdaptive(t *testing.T) {
	principles := waveobj.PrincipleList{{ID: "clean", Text: "be clean"}}
	// explicit adaptive, and the legacy empty-on-claude that must resolve to it
	for _, orch := range []string{Orchestration_Adaptive, ""} {
		p := BuildOrchestratePrompt("do X", principles, "claude", orch)
		for _, want := range []string{"do X", "be clean", "wsh jarvis triage", "wsh jarvis complete", "subagent", "AskUserQuestion", "prose"} {
			if !strings.Contains(p, want) {
				t.Fatalf("orch=%q prompt missing %q:\n%s", orch, want, p)
			}
		}
		if strings.Contains(p, "wsh jarvis hold") {
			t.Fatalf("orch=%q: orchestrator prompt must not tell the lead to hold", orch)
		}
		if strings.Contains(p, "dag submit") || strings.Contains(p, "import-tasks") {
			t.Fatalf("orch=%q: adaptive prompt must not mention the engine:\n%s", orch, p)
		}
	}
}

func TestBuildOrchestratePromptEngine(t *testing.T) {
	principles := waveobj.PrincipleList{{ID: "clean", Text: "be clean"}}

	claude := BuildOrchestratePrompt("do X", principles, "claude", Orchestration_Engine)
	for _, want := range []string{
		"do X", "be clean", "dag submit --file", "wsh jarvis dag wait", "terminal:",
		"wsh jarvis dag merge", "AskUserQuestion", "16 tasks", "one DAG", "wsh jarvis complete",
	} {
		if !strings.Contains(claude, want) {
			t.Fatalf("claude engine prompt missing %q:\n%s", want, claude)
		}
	}
	if strings.Contains(claude, "import-tasks") {
		t.Fatalf("claude engine prompt must not mention pi-tasks:\n%s", claude)
	}

	// pi keeps push delivery: control events, never the wait loop.
	pi := BuildOrchestratePrompt("do X", principles, "pi", Orchestration_Engine)
	for _, want := range []string{"import-tasks", "control events", "16 tasks", "wsh jarvis dag merge"} {
		if !strings.Contains(pi, want) {
			t.Fatalf("pi engine prompt missing %q:\n%s", want, pi)
		}
	}
	if strings.Contains(pi, "dag wait") || strings.Contains(pi, "--file") {
		t.Fatalf("pi engine prompt must not use the pull loop:\n%s", pi)
	}
}

func TestResolveOrchestrationLegacyFork(t *testing.T) {
	cases := []struct{ orch, runtime, want string }{
		{"", "pi", Orchestration_Engine},
		{"", "claude", Orchestration_Adaptive},
		{"", "codex", Orchestration_Adaptive},
		{"", "", Orchestration_Adaptive},
		{Orchestration_Engine, "claude", Orchestration_Engine},
		{Orchestration_Adaptive, "pi", Orchestration_Adaptive},
	}
	for _, c := range cases {
		if got := ResolveOrchestration(c.orch, c.runtime); got != c.want {
			t.Fatalf("ResolveOrchestration(%q, %q) = %q, want %q", c.orch, c.runtime, got, c.want)
		}
	}
}
```

Append to `pkg/wshrpc/wshserver/wshserver_run_test.go` (modelled on `TestCreateRunCommand_PersistsExplicitRuntime` at line 365):

```go
func TestCreateRunCommand_PersistsOrchestration(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "create-orch", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	var spawnedCap runroute.Capability
	stubRunServer(t, "claude", nil, &spawnedCap)

	ws := &WshServer{}
	rtn, err := ws.CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws-1", Goal: "do it", Runtime: "claude", Tier: "capable",
		Mode: jarvis.RunMode_Orchestrator, Orchestration: jarvis.Orchestration_Engine,
	})
	if err != nil {
		t.Fatalf("CreateRunCommand: %v", err)
	}
	if rtn.Run.Orchestration != jarvis.Orchestration_Engine {
		t.Fatalf("persisted orchestration = %q, want engine", rtn.Run.Orchestration)
	}
}
```

- [ ] **Step 2: Run them to make sure they fail**

```
go test ./pkg/jarvis/ -run 'TestBuildOrchestratePrompt|TestResolveOrchestration' -count=1
```

Expected: FAIL to compile — `BuildOrchestratePrompt` takes 3 args, and `Orchestration_Engine` / `ResolveOrchestration` are undefined.

- [ ] **Step 3: Add the constants and the resolver**

In `pkg/jarvis/run.go`, beside the `RunMode_*` constants:

```go
const (
	Orchestration_Engine   = "engine"
	Orchestration_Adaptive = "adaptive"
)
```

Below the prompt builders:

```go
// ResolveOrchestration maps a run's stored choice onto the machine its prompt describes. Empty is the
// pre-2026-09 shape, where runtime alone decided: pi drove the engine and every other harness
// dispatched its own subagents. Preserving that mapping means a run created before the composer
// gained the control still builds the prompt it was created under.
func ResolveOrchestration(orchestration, runtime string) string {
	if orchestration != "" {
		return orchestration
	}
	if runtime == "pi" {
		return Orchestration_Engine
	}
	return Orchestration_Adaptive
}
```

- [ ] **Step 4: Fork the prompt builder**

In `pkg/jarvis/run.go`, replace `BuildOrchestratePrompt` and `buildPiOrchestratePrompt` with the following. The adaptive body is today's non-pi text moved verbatim; the engine body absorbs and generalizes the pi one.

```go
// BuildOrchestratePrompt is the lead's initial prompt for an orchestrator run. The fork is the
// orchestration choice, not the runtime: "engine" publishes a TaskGroup that pkg/orchestrate
// schedules into managed worktrees, "adaptive" leaves fan-out to the lead's own subagents. Runtime
// still selects how an engine lead publishes and how it is woken, because those differ per harness.
func BuildOrchestratePrompt(goal string, principles waveobj.PrincipleList, runtime, orchestration string) string {
	var b strings.Builder
	if rendered := RenderPrinciples(principles); rendered != "" {
		fmt.Fprintf(&b, "Work by these principles, and propagate them into every subagent you dispatch:\n%s\n\n", rendered)
	}
	if ResolveOrchestration(orchestration, runtime) == Orchestration_Engine {
		buildEngineOrchestratePrompt(&b, goal, runtime)
	} else {
		buildAdaptiveOrchestratePrompt(&b, goal)
	}
	return strings.TrimRight(b.String(), "\n")
}

// buildAdaptiveOrchestratePrompt: the lead sizes up the goal and fans out with its own subagents.
// No TaskGroup, so no engine, no managed worktrees, and no merge gate.
func buildAdaptiveOrchestratePrompt(b *strings.Builder, goal string) {
	b.WriteString("You are the lead orchestrator for this goal.\n")
	b.WriteString("First size up the goal and announce your call:\n")
	b.WriteString("- If it is a small, well-understood change, run `wsh jarvis triage quick \"<one-line reason>\"` and just make the fix directly — no plan document, and dispatch subagents only if the work genuinely needs them.\n")
	b.WriteString("- If it is larger or ambiguous, run `wsh jarvis triage plan \"<one-line reason>\"`, then plan it with the superpowers:writing-plans approach and execute it adaptively by dispatching your own subagents (superpowers:subagent-driven-development / superpowers:dispatching-parallel-agents).\n")
	b.WriteString("Do not wait after triaging — proceed straight into the work you chose.\n")
	// The intended ask channel is AskUserQuestion (it renders as an answerable card in the cockpit and
	// blocks); a question typed in prose does not render, so the run proceeds without an answer.
	b.WriteString("If a genuinely consequential or ambiguous decision comes up mid-run — one where a wrong assumption would waste real work — use the AskUserQuestion tool to ask the human; it renders as an answerable question in the cockpit and blocks until they reply. Never pose such a question in prose: a prose question does not render as a question, so the run just proceeds without an answer.\n")
	fmt.Fprintf(b, "Goal: %s\n", goal)
	b.WriteString("When the goal is fully accomplished, commit your work and run `wsh jarvis complete --commit $(git rev-parse HEAD)` from your working tree (the SHA of your own final commit), so the run's evidence reflects exactly your changes.\n")
}

// buildEngineOrchestratePrompt: the lead publishes a DAG and the engine schedules it. The two hard
// limits are stated up front because discovering them at submit time costs a blocking escalation —
// and the two-phase import a lead naturally proposes as the remedy is exactly what CreateDagForRun
// rejects.
func buildEngineOrchestratePrompt(b *strings.Builder, goal, runtime string) {
	b.WriteString("You are the lead orchestrator for this goal, driving the Arc orchestration engine.\n")
	b.WriteString("Size up the goal: if it is a small well-understood change, run `wsh jarvis triage quick \"<reason>\"` and do it directly. Otherwise run `wsh jarvis triage plan \"<reason>\"`, plan it with the superpowers:writing-plans approach, and publish that plan as a DAG.\n")
	fmt.Fprintf(b, "Two hard limits shape the plan, so respect them while planning instead of discovering them at submit time: a DAG holds at most %d tasks, and one orchestrator run holds exactly one DAG for its whole lifetime — a second, different submission is rejected as a dag conflict, so a multi-phase import is not available. Compress the plan to fit.\n", MaxDagTasks)
	b.WriteString("Each task description must include the task-specific goal, relevant evidence and constraints, expected verification, and pinned decisions, so the child never has to rediscover the broad goal.\n")
	if runtime == "pi" {
		b.WriteString("Create pi-tasks records and run `wsh jarvis dag import-tasks`; the engine validates and schedules ready children automatically and wakes you with control events; respond to control events as they arrive — do not babysit.\n")
	} else {
		b.WriteString("Write the DAG as JSON to a file and submit it with `wsh jarvis dag submit --file <path>`. The JSON is an object with `title`, `parallelism` (1-8), and `tasks`, each task `{\"id\": \"t-1\", \"label\": \"...\", \"description\": \"...\", \"deps\": [\"t-0\"]}`.\n")
		b.WriteString("Then loop: run `wsh jarvis dag wait`, do exactly what it reports, and wait again. Stop when it reports a line beginning `woke: terminal:`. Acting on a reported action is what lets the next wait block — an action you leave untaken makes wait return immediately.\n")
	}
	b.WriteString("Use `wsh jarvis dag status` for detail at any time.\n")
	b.WriteString("If a genuinely consequential or ambiguous decision comes up — one where a wrong assumption would waste real work — use the AskUserQuestion tool to ask the human; it renders an answerable question in the cockpit and blocks until they reply. Never pose such a question in prose.\n")
	b.WriteString("A Git-backed dependent task stays pending until each predecessor is merged; when the digest reports `merge`, run `wsh jarvis dag merge <task-id>` with the reported id after reviewing that finished child, so its successors start from the integrated project HEAD.\n")
	fmt.Fprintf(b, "Goal: %s\n", goal)
	b.WriteString("When the goal is fully accomplished, commit your work and run `wsh jarvis complete --commit $(git rev-parse HEAD)`.\n")
}
```

- [ ] **Step 5: Update the call site**

`pkg/jarvis/runexec.go:177` currently reads:

```go
		return BuildOrchestratePrompt(run.Goal, run.Principles, run.Runtime)
```

Change it to:

```go
		return BuildOrchestratePrompt(run.Goal, run.Principles, run.Runtime, run.Orchestration)
```

- [ ] **Step 6: Add the field to the run and the RPC**

In `pkg/waveobj/wtype.go`, in `Run`, directly after the `WorkerRoute` field:

```go
	// Orchestration selects which machine an orchestrator lead drives: "engine" publishes a TaskGroup
	// that pkg/orchestrate schedules; "adaptive" dispatches the lead's own subagents with no TaskGroup.
	// Empty preserves the pre-2026-09 fork, where runtime alone decided (pi engine, others adaptive).
	Orchestration string `json:"orchestration,omitempty"`
```

In `pkg/wshrpc/wshrpctypes_runs.go`, in `CommandCreateRunData`, after `WorkerRoute`:

```go
	Orchestration string `json:"orchestration,omitempty"` // engine | adaptive (empty = legacy runtime fork)
```

In `pkg/wshrpc/wshserver/wshserver_runs.go`, directly after `run.WorkerRoute = data.WorkerRoute`:

```go
	run.Orchestration = data.Orchestration // prompt-shaping only; DagSubmit stays open to either choice
```

- [ ] **Step 7: Regenerate bindings**

```
task generate
```

Expected: `frontend/app/store/wshclientapi.ts` and the generated TS types pick up `orchestration`. Do not hand-edit them.

- [ ] **Step 8: Run the tests and make sure they pass**

```
go test ./pkg/jarvis/ ./pkg/orchestrate/ -count=1
```

Then, with `CGO_CFLAGS` set as described in Global Constraints:

```
go test ./pkg/wshrpc/wshserver/ -count=1
```

Expected: PASS for all three packages.

---

### Task 3: `dag submit --file`

Reads the same `CommandDagSubmitData` JSON the positional form already takes, from a file or stdin, so a lead can write it with a file-write tool instead of quoting a large blob through argv.

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`dagSubmitCmd` at line 30; `init()` at the bottom)
- Test: `cmd/wsh/cmd/wshcmd-jarvisdag_test.go` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `dagSubmitSource(args []string, file string, stdin io.Reader) ([]byte, error)` — Task 4 does not use it; it exists so the source-selection rule is testable without an RPC client.

- [ ] **Step 1: Write the failing test**

Append to `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`:

```go
func TestDagSubmitSource(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "dag.json")
	if err := os.WriteFile(path, []byte(`{"title":"from file"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := dagSubmitSource(nil, path, strings.NewReader(""))
	if err != nil || string(got) != `{"title":"from file"}` {
		t.Fatalf("--file = %q, %v", got, err)
	}

	got, err = dagSubmitSource([]string{`{"title":"inline"}`}, "", strings.NewReader(""))
	if err != nil || string(got) != `{"title":"inline"}` {
		t.Fatalf("inline = %q, %v", got, err)
	}

	got, err = dagSubmitSource(nil, "-", strings.NewReader(`{"title":"stdin"}`))
	if err != nil || string(got) != `{"title":"stdin"}` {
		t.Fatalf("stdin = %q, %v", got, err)
	}

	// two sources is a mistake to surface, not a precedence rule to guess at
	if _, err := dagSubmitSource([]string{`{}`}, path, strings.NewReader("")); err == nil {
		t.Fatal("inline + --file must be rejected")
	}
	if _, err := dagSubmitSource(nil, "", strings.NewReader("")); err == nil {
		t.Fatal("no source must be rejected")
	}
	if _, err := dagSubmitSource(nil, filepath.Join(dir, "missing.json"), strings.NewReader("")); err == nil {
		t.Fatal("missing file must be rejected")
	}
}
```

- [ ] **Step 2: Run it to make sure it fails**

```
go test ./cmd/wsh/cmd/ -run TestDagSubmitSource -count=1
```

Expected: FAIL to compile — `undefined: dagSubmitSource`.

- [ ] **Step 3: Implement the source selector and wire the flag**

In `cmd/wsh/cmd/wshcmd-jarvisdag.go`, add `io` to the import block, then add above `dagSubmitCmd`:

```go
// dagSubmitSource reads the DAG payload from exactly one source: inline argv JSON, or --file (a path,
// or "-" for stdin). A lead writing a large DAG cannot reliably quote it through argv on Windows,
// which is what --file is for.
func dagSubmitSource(args []string, file string, stdin io.Reader) ([]byte, error) {
	if len(args) == 1 && file != "" {
		return nil, fmt.Errorf("pass the dag JSON inline or with --file, not both")
	}
	if len(args) == 1 {
		return []byte(args[0]), nil
	}
	if file == "-" {
		return io.ReadAll(stdin)
	}
	if file != "" {
		return os.ReadFile(file)
	}
	return nil, fmt.Errorf("dag JSON required: pass it inline or with --file <path>")
}
```

Change `dagSubmitCmd`'s `Use`, `Short`, `Args` and the head of its `RunE`:

```go
var dagSubmitCmd = &cobra.Command{
	Use:     "submit [dag-json]",
	Short:   "validate and submit a DAG for the current run (inline JSON, or --file <path>|-)",
	Args:    cobra.MaximumNArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		file, _ := cmd.Flags().GetString("file")
		raw, err := dagSubmitSource(args, file, cmd.InOrStdin())
		if err != nil {
			return err
		}
		channelId, runId, err := dagIds(cmd)
		if err != nil {
			return err
		}
		var data wshrpc.CommandDagSubmitData
		if err := json.Unmarshal(raw, &data); err != nil {
			return fmt.Errorf("dag json: %w", err)
		}
		data.ChannelId = channelId
		data.RunId = runId
		g, err := wshclient.DagSubmitCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 20_000})
		if err != nil {
			return err
		}
		fmt.Printf("dag %s submitted (%d tasks, parallelism %d)\n", g.ID, len(g.Tasks), g.Parallelism)
		return nil
	},
}
```

In `init()`, beside the existing `dagImportCmd.Flags().String("dir", ...)` line:

```go
	dagSubmitCmd.Flags().String("file", "", "read the dag JSON from a file (\"-\" for stdin)")
```

- [ ] **Step 4: Run the tests and make sure they pass**

```
go test ./cmd/wsh/cmd/ -count=1
```

Expected: PASS.

---

### Task 4: `wsh jarvis dag wait`

The wake path for a non-pi lead. Subscribes to the `dag:*` events already registered in `wps.AllEvents`, then blocks. Blocking is entirely client-side, so the 5s wshrpc handler budget is never involved.

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (new command, helper, `init()`)
- Test: `cmd/wsh/cmd/wshcmd-jarvisdag_test.go` (append)

**Interfaces:**
- Consumes: `dagStatusLines(rtn *wshrpc.CommandDagStatusRtnData, now int64) []string`, already in this file at line 110.
- Produces: `waitDecision(d wshrpc.DagStatusDigest) (bool, string)`.

- [ ] **Step 1: Write the failing test**

Append to `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`:

```go
func TestWaitDecision(t *testing.T) {
	cases := []struct {
		name       string
		digest     wshrpc.DagStatusDigest
		wantReturn bool
		wantReason string
	}{
		{
			name:       "quiet dag keeps blocking",
			digest:     wshrpc.DagStatusDigest{Health: "healthy", Next: wshrpc.DagNextStep{Kind: "parallelism-wait", BlockingTaskIds: []string{"t-2"}}},
			wantReturn: false,
		},
		{
			name:       "dependency wait keeps blocking",
			digest:     wshrpc.DagStatusDigest{Health: "healthy", Next: wshrpc.DagNextStep{Kind: "dependency-wait"}},
			wantReturn: false,
		},
		{
			name:       "merge gate needs the lead",
			digest:     wshrpc.DagStatusDigest{Health: "healthy", Next: wshrpc.DagNextStep{Kind: "merge-ready", Actions: []string{"resolve-merge"}}},
			wantReturn: true, wantReason: "action:merge-ready",
		},
		{
			name:       "child ask needs the lead",
			digest:     wshrpc.DagStatusDigest{Health: "needs-you", Next: wshrpc.DagNextStep{Kind: "human-action", Actions: []string{"answer"}}},
			wantReturn: true, wantReason: "action:human-action",
		},
		{
			name:       "terminal kind wins",
			digest:     wshrpc.DagStatusDigest{Health: "healthy", Next: wshrpc.DagNextStep{Kind: "terminal", TerminalStatus: "done"}},
			wantReturn: true, wantReason: "terminal:done",
		},
		{
			name:       "cancelled health is terminal even without a terminal next",
			digest:     wshrpc.DagStatusDigest{Health: "cancelled", Next: wshrpc.DagNextStep{Kind: "dispatch"}},
			wantReturn: true, wantReason: "terminal:cancelled",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, reason := waitDecision(c.digest)
			if got != c.wantReturn {
				t.Fatalf("returnNow = %v, want %v", got, c.wantReturn)
			}
			if c.wantReturn && reason != c.wantReason {
				t.Fatalf("reason = %q, want %q", reason, c.wantReason)
			}
		})
	}
}
```

- [ ] **Step 2: Run it to make sure it fails**

```
go test ./cmd/wsh/cmd/ -run TestWaitDecision -count=1
```

Expected: FAIL to compile — `undefined: waitDecision`.

- [ ] **Step 3: Implement the decision and the command**

In `cmd/wsh/cmd/wshcmd-jarvisdag.go`, add **two** imports — `github.com/wavetermdev/waveterm/pkg/waveobj` and `github.com/wavetermdev/waveterm/pkg/wps`. Neither is currently in the file (it has no `waveobj.` reference today), and both are used by the code below. Then add:

```go
// dagWaitEvents is every engine event that can change what the lead should do next. Each is already
// registered in wps.AllEvents and published scoped to the owning run.
var dagWaitEvents = []string{
	wps.DagEventChildDone, wps.DagEventGateOpen, wps.DagEventBlocked, wps.DagEventComplete,
	wps.DagEventTaskSpawned, wps.DagEventChildAsk, wps.DagEventTaskStalled, wps.DagEventTaskRetried,
}

// waitDecision reports whether the lead should be handed control now, and why. Pure, so the blocking
// glue evaluates it identically against the first digest and every post-event digest. Actions come
// from the digest's own single derivation — never re-derived here from task state.
func waitDecision(d wshrpc.DagStatusDigest) (bool, string) {
	if d.Next.Kind == "terminal" || d.Health == "done" || d.Health == "cancelled" {
		status := d.Next.TerminalStatus
		if status == "" {
			status = d.Health
		}
		return true, "terminal:" + status
	}
	if len(d.Next.Actions) > 0 {
		return true, "action:" + d.Next.Kind
	}
	return false, ""
}

func printDagWait(rtn *wshrpc.CommandDagStatusRtnData, reason string) {
	fmt.Printf("woke: %s\n", reason)
	for _, line := range dagStatusLines(rtn, time.Now().UnixMilli()) {
		fmt.Println(line)
	}
	fmt.Printf("dagversion=%d\n", rtn.Digest.DagVersion)
}

// DagWaitDefaultTimeout is bounded by Claude Code's Bash tool, which caps at 600s: a wait that
// outlives its caller is killed and reported as a tool failure, which reads as a real error to a lead.
const DagWaitDefaultTimeout = 540

var dagWaitCmd = &cobra.Command{
	Use:     "wait",
	Short:   "block until the dag needs the lead, goes terminal, or the timeout elapses",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		timeoutSec, _ := cmd.Flags().GetInt("timeout")
		channelId, runId, err := dagIds(cmd)
		if err != nil {
			return err
		}
		// subscribe before the first status read: an event landing between the two would otherwise be
		// lost, and the lead would block on state that had already moved.
		runScope := waveobj.MakeORef(waveobj.OType_Run, runId).String()
		woke := make(chan struct{}, 1)
		for _, ev := range dagWaitEvents {
			RpcClient.EventListener.On(ev, func(e *wps.WaveEvent) {
				if !e.HasScope(runScope) {
					return
				}
				select {
				case woke <- struct{}{}:
				default: // a pending wake already covers this one
				}
			})
			wshclient.EventSubCommand(RpcClient, wps.SubscriptionRequest{Event: ev, Scopes: []string{runScope}}, nil)
		}
		// one deadline for the whole call, not restarted per event
		deadline := time.After(time.Duration(timeoutSec) * time.Second)
		for {
			rtn, err := wshclient.DagStatusCommand(RpcClient, wshrpc.CommandDagStatusData{ChannelId: channelId, RunId: runId}, &wshrpc.RpcOpts{Timeout: 10_000})
			if err != nil {
				return err
			}
			if rtn.Group == nil {
				return fmt.Errorf("no dag for this run — submit one first")
			}
			if ret, reason := waitDecision(rtn.Digest); ret {
				printDagWait(rtn, reason)
				return nil
			}
			select {
			case <-woke:
				// re-read and re-evaluate; a purely informational event resumes blocking
			case <-deadline:
				printDagWait(rtn, "timeout")
				return nil
			}
		}
	},
}
```

In `init()`, add `dagWaitCmd` to an `AddCommand` call **before** the `for _, c := range jarvisDagCmd.Commands()` loop, so it receives the shared `--runid` / `--channel` flags:

```go
	jarvisDagCmd.AddCommand(dagInitCmd, dagAckCmd, dagWaitCmd)
```

Then, beside the other flag registrations after that loop:

```go
	dagWaitCmd.Flags().Int("timeout", DagWaitDefaultTimeout, "seconds to block before returning the current digest")
```

- [ ] **Step 4: Run the tests and make sure they pass**

```
go test ./cmd/wsh/cmd/ -count=1
```

Expected: PASS.

- [ ] **Step 5: Verify the command is wired**

```
go build ./cmd/wsh && ./wsh jarvis dag wait --help
```

Expected: help text listing `--timeout`, `--runid`, `--channel`. Delete the built binary afterward (`rm wsh` / `rm wsh.exe`) — it is not a build artifact this repo tracks.

---

### Task 5: Composer Engine/Adaptive control

The choice becomes explicit in the UI. Two behaviours are worth getting right: the footer copy must say which machine will run, and the Workers picker must not be offered in adaptive mode — `WorkerRoute` is only read by `engine.go:487` when the engine spawns children, so offering it for an adaptive lead would be a lie.

**Files:**
- Modify: `frontend/app/view/agents/orchestratorpicker.ts`
- Create: `frontend/app/view/agents/orchestratorpicker.test.ts`
- Modify: `frontend/app/view/agents/channelcomposers.tsx` (`runBehavior` at line 139; `tight` at line 162; the tight row JSX at line 246)
- Modify: `frontend/app/view/agents/runactions.ts` (`createRun` opts, line 64)
- Modify: `frontend/app/view/jarvis/stagecomposer.tsx` (state at line 251, reset effect at line 258, `createRun` call at line 421, composer props at line 561)

**Interfaces:**
- Consumes: `wshrpc.CommandCreateRunData.Orchestration` from Task 2 (available on the generated TS type after `task generate`).
- Produces:
  - `Orchestration` type = `"engine" | "adaptive"`
  - `ORCHESTRATION_OPTIONS: Orchestration[]`
  - `orchestratorPickerState(input: { shape: string; mode: string; pending: boolean; hasWorkerCallback: boolean; orchestration: Orchestration })` — **`orchestration` is a new required field**; returns the existing `{ showTightRow, showWorkerPicker }`.
  - `orchestratorBehaviorFace(input: { orchestration: Orchestration; leadFace: string; workerFace: string | null }): string`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/orchestratorpicker.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { orchestratorBehaviorFace, orchestratorPickerState, workerPickerFace } from "./orchestratorpicker";

const base = { shape: "orchestrator", mode: "run", pending: false, hasWorkerCallback: true } as const;

describe("orchestratorPickerState", () => {
    test("engine shows the lead to workers row", () => {
        expect(orchestratorPickerState({ ...base, orchestration: "engine" })).toEqual({
            showTightRow: true,
            showWorkerPicker: true,
        });
    });

    test("adaptive hides the worker picker: WorkerRoute only feeds engine-spawned children", () => {
        expect(orchestratorPickerState({ ...base, orchestration: "adaptive" })).toEqual({
            showTightRow: false,
            showWorkerPicker: false,
        });
    });

    test("non-orchestrator shapes are unaffected", () => {
        expect(orchestratorPickerState({ ...base, shape: "pipeline", orchestration: "engine" })).toEqual({
            showTightRow: false,
            showWorkerPicker: false,
        });
    });

    test("ask mode and pending drafts suppress it", () => {
        expect(orchestratorPickerState({ ...base, mode: "ask", orchestration: "engine" }).showTightRow).toBe(false);
        expect(orchestratorPickerState({ ...base, pending: true, orchestration: "engine" }).showTightRow).toBe(false);
        expect(
            orchestratorPickerState({ ...base, hasWorkerCallback: false, orchestration: "engine" }).showTightRow
        ).toBe(false);
    });
});

describe("orchestratorBehaviorFace", () => {
    test("engine names the machine and the workers", () => {
        expect(orchestratorBehaviorFace({ orchestration: "engine", leadFace: "opus", workerFace: "sonnet" })).toBe(
            "→ engine DAG · lead opus · workers sonnet"
        );
    });

    test("engine with inherited workers says so", () => {
        expect(orchestratorBehaviorFace({ orchestration: "engine", leadFace: "opus", workerFace: null })).toBe(
            "→ engine DAG · lead opus · workers same as lead"
        );
    });

    test("adaptive omits workers entirely", () => {
        expect(orchestratorBehaviorFace({ orchestration: "adaptive", leadFace: "opus", workerFace: "sonnet" })).toBe(
            "→ adaptive subagents · lead opus"
        );
    });
});

describe("workerPickerFace", () => {
    test("null inherits the lead", () => {
        expect(workerPickerFace(null)).toBe("Same as lead");
    });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```
npx vitest run frontend/app/view/agents/orchestratorpicker.test.ts
```

Expected: FAIL — `orchestratorBehaviorFace` is not exported, and `orchestratorPickerState` rejects the extra field / returns the wrong shape for adaptive.

- [ ] **Step 3: Implement the picker logic**

Replace the body of `frontend/app/view/agents/orchestratorpicker.ts` below its existing import with:

```ts
export type Orchestration = "engine" | "adaptive";

export const ORCHESTRATION_OPTIONS: Orchestration[] = ["engine", "adaptive"];

// The Lead → Workers row is engine-only: WorkerRoute is read solely when the engine spawns DAG
// children, so offering it for an adaptive lead would promise a routing that never happens.
export function orchestratorPickerState(input: {
    shape: string;
    mode: string;
    pending: boolean;
    hasWorkerCallback: boolean;
    orchestration: Orchestration;
}): { showTightRow: boolean; showWorkerPicker: boolean } {
    const show =
        input.shape === "orchestrator" &&
        input.mode !== "ask" &&
        !input.pending &&
        input.hasWorkerCallback &&
        input.orchestration === "engine";
    return { showTightRow: show, showWorkerPicker: show };
}

export function workerPickerFace(workerRoute: RoutePin | null): string {
    if (workerRoute == null) {
        return "Same as lead";
    }
    return modelFace(workerRoute);
}

// Footer copy for the orchestrator shape. Which machine runs is the thing worth echoing back: engine
// publishes a TaskGroup the backend schedules into managed worktrees, adaptive leaves fan-out to the
// lead's own subagents.
export function orchestratorBehaviorFace(input: {
    orchestration: Orchestration;
    leadFace: string;
    workerFace: string | null;
}): string {
    if (input.orchestration === "adaptive") {
        return `→ adaptive subagents · lead ${input.leadFace}`;
    }
    return `→ engine DAG · lead ${input.leadFace} · workers ${input.workerFace ?? "same as lead"}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```
npx vitest run frontend/app/view/agents/orchestratorpicker.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Render the control in the composer**

In `frontend/app/view/agents/channelcomposers.tsx`:

Add `orchestration` and `onOrchestrationChange` to the component's props type beside `shape` / `onShapeChange`, typed `Orchestration` and `(next: Orchestration) => void`. Extend the existing import from `./orchestratorpicker` to bring in `ORCHESTRATION_OPTIONS`, `orchestratorBehaviorFace`, and the `Orchestration` type.

Replace the `runBehavior` expression at line 139:

```tsx
    const runBehavior =
        selectedShape === "orchestrator"
            ? orchestratorBehaviorFace({
                  orchestration,
                  leadFace: route?.model || route?.tier || "unset",
                  workerFace: workerRoute ? workerRoute.model || workerRoute.tier || null : null,
              })
            : selectedShape === "quick"
              ? `→ direct quick launch in #${channelName}`
              : "→ direct pipeline launch";
```

Pass the new field to `orchestratorPickerState` at line 162:

```tsx
    const tight = orchestratorPickerState({
        shape: selectedShape,
        mode,
        pending,
        hasWorkerCallback: onWorkerRouteChange != null,
        orchestration,
    });
```

Add the toggle as a sibling of the shape group, directly after that group's closing `)}` and before `{tight.showTightRow ? (`. It sits in the same wrapping `flex flex-wrap items-center gap-2` row, so it wraps rather than crowding the tight row at narrow widths. The classes are copied from the shape buttons so both groups read as one control family — every color is a token:

```tsx
                        {selectedShape === "orchestrator" && mode !== "ask" && !pending ? (
                            <div className="flex items-center gap-1 rounded-[7px] border border-border bg-surface px-1 py-0.5">
                                {ORCHESTRATION_OPTIONS.map((option) => (
                                    <button
                                        key={option}
                                        type="button"
                                        aria-pressed={orchestration === option}
                                        onClick={() => onOrchestrationChange(option)}
                                        title={
                                            option === "engine"
                                                ? "Publish a DAG the engine schedules into managed worktrees"
                                                : "Let the lead dispatch its own subagents"
                                        }
                                        className={
                                            "rounded-[5px] px-1.5 py-0.5 font-mono text-[10px] font-semibold capitalize " +
                                            (orchestration === option
                                                ? "bg-accentbg text-accent-soft"
                                                : "text-muted hover:text-secondary")
                                        }
                                    >
                                        {option}
                                    </button>
                                ))}
                            </div>
                        ) : null}
```

- [ ] **Step 6: Thread it through createRun**

In `frontend/app/view/agents/runactions.ts`, add to the `opts` type in `createRun` (line 64):

```ts
        orchestration?: string;
```

and to the RPC payload, beside the `workerroute` spread:

```ts
        ...(opts?.orchestration ? { orchestration: opts.orchestration } : {}),
```

- [ ] **Step 7: Own the state in the stage composer**

In `frontend/app/view/jarvis/stagecomposer.tsx`:

Import the type: add `type Orchestration` to the existing import from `../agents/orchestratorpicker` (create the import if the file does not already import from it).

Add state beside `workerRoute` (line 253):

```tsx
    const [orchestration, setOrchestration] = useState<Orchestration>("engine");
```

Add the reset to the existing channel-change effect (line 258), beside `setWorkerRoute(null)`:

```tsx
        setOrchestration("engine");
```

Send it on launch — replace the `createRun` options object at line 421:

```tsx
                const created = await createRun(decision.channelId, decision.goal, decision.route, {
                    mode: decision.mode,
                    ...(shape === "orchestrator" ? { orchestration } : {}),
                    ...(shape === "orchestrator" && orchestration === "engine" && workerRoute ? { workerRoute } : {}),
                });
```

The worker route is now gated on engine too: an adaptive lead never spawns engine children, so sending a `WorkerRoute` would persist a routing nothing reads.

Pass the props to the composer at line 561, beside `workerRoute`:

```tsx
                                orchestration={orchestration}
                                onOrchestrationChange={setOrchestration}
```

- [ ] **Step 8: Run the frontend checks**

```
npx vitest run frontend/app/view/agents/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: vitest PASS; tsc exit 0 with no output. The tsc baseline is clean, so any error is yours.

- [ ] **Step 9: Verify it renders**

```
task build:backend
```

Start the dev app (`task dev`), then:

```
node scripts/cdp/verify.mjs surface-smoke
```

Expected: PASS. Then confirm by eye in the Jarvis composer that selecting the `orchestrator` shape reveals an `engine | adaptive` toggle, that `engine` shows the Lead → Workers row, and that `adaptive` collapses it back to the single route picker and changes the footer to `→ adaptive subagents · lead …`.

---

### Task 6: Live end-to-end verification

Everything above is unit-testable and none of it proves a Claude lead actually drives a DAG to a merge gate. This task is the proof, and it is the deliverable the whole effort is for.

**Files:**
- Create: `docs/jarvis-claude-lead-e2e.md`

**Interfaces:**
- Consumes: every prior task.
- Produces: a capture document. `cdp-shots/` is gitignored, so screenshots resolve only on the capturing machine — match the convention `docs/jarvis-orchestrator-plan-e2e.md` already uses and say so in the file.

- [ ] **Step 1: Rebuild the backend**

```
task build:backend
```

Required: `dag wait` and `dag submit --file` do not exist in a stale `wavesrv`/`wsh`, and the lead will get a route error instead of a command.

- [ ] **Step 2: Create the run**

Start `task dev`. In the Jarvis surface, create or pick a channel on a scratch project — not the main checkout. In the composer: shape `orchestrator`, orchestration `engine`, lead route a Claude Code model, workers `Same as lead`. Give it a small real goal, three to five tasks' worth, and submit.

- [ ] **Step 3: Confirm the lead took the engine path**

Watch the lead's terminal. Within its first few minutes it must:

- write a DAG JSON file and run `wsh jarvis dag submit --file <path>`, and
- enter the `wsh jarvis dag wait` loop.

If it instead starts dispatching its own subagents, the prompt fork is wrong — check `run.Orchestration` actually persisted (`wsh jarvis dag status` errors with "no dag for this run" while none is submitted).

- [ ] **Step 4: Confirm the wake loop closes**

The specific thing to observe, because it is what the whole design turns on: when a child finishes and the merge gate opens, `dag wait` must **return on its own** with a line beginning `woke: action:merge-ready`, and the lead must then run `wsh jarvis dag merge <task-id>` without a human touching anything.

Confirm too that `wait` does **not** return on a purely informational `dag:task-spawned` — the lead should stay blocked through child spawns.

- [ ] **Step 5: Drive it to completion**

Let the run reach `woke: terminal:done` and confirm the lead stops looping rather than calling `wait` again.

- [ ] **Step 6: Write the capture**

Write `docs/jarvis-claude-lead-e2e.md` recording, from the real run: the run id, runtime, model, orchestration and base commit; the DAG id, task count and parallelism; the submitted DAG JSON; the `woke:` lines in the order they appeared; and anything that behaved differently from this plan. Note the gitignored-screenshots caveat if you capture any.

State plainly whatever did not work. A capture that hides a rough edge is worse than no capture.

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: §1 `Orchestration` field → Task 2; §2 `dag wait` → Task 4; §3 `dag submit --file` → Task 3; §4 prompt fork → Task 2; §5 composer control → Task 5; `MaxTasks` → Task 1; the spec's testing table → the test steps in Tasks 1-5 plus Task 6 for the live row. The spec's "out of scope" list has no tasks, correctly.

**One deviation from the spec, resolved here.** The spec's §5 does not say the Workers picker hides in adaptive mode. Task 5 adds that, because `WorkerRoute` is read only by `engine.go:487` when the engine spawns children — offering it to an adaptive lead promises routing that never happens. This tightens the spec rather than contradicting it, and `stagecomposer.tsx` stops sending `workerRoute` for adaptive runs to match.

**Placeholders.** None. Every code step carries the actual code; every test step carries the actual assertions and the exact command with its expected result.

**Type consistency.** `Orchestration_Engine` / `Orchestration_Adaptive` (Go) and `"engine"` / `"adaptive"` (TS) are the same two literals throughout. `BuildOrchestratePrompt`'s new fourth parameter is defined in Task 2 and its only call site (`runexec.go:177`) is updated in the same task. `orchestratorPickerState` gains a required `orchestration` field in Task 5, and its sole caller (`channelcomposers.tsx:162`) is updated in the same task. `waitDecision` and `dagSubmitSource` are each defined and consumed within one task. `jarvis.MaxDagTasks` is produced in Task 1 and consumed in Task 2.

**Commit discipline.** No task commits. The repo's rule is one batched commit at the end with explicit approval, and this spec and plan fold into it.
