# Orchestrator Redesign Slice 5b: + Run Shapes and Plan-Path Start

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** + Run offers two shapes, Quick and Orchestrator. An Orchestrator starts from a goal (the 5a lead) or from an absolute plan path, which + Run parses and previews before start. A plan-path run is submitted to the engine at start with no lead; its lead is launched only when something needs judgment.

**Architecture:**
- **Quick** gains the spec's ask line, naming the runtime's ask tool (`jarvis.AskTool`).
- **Plan shape** is computed once in Go: `orchestrate.PlanShapeOf` (tasks, lanes, longest chain over `jarvis.Lanes`/`jarvis.LongestChain`). It feeds a new `DagPlanPreviewCommand` (+ Run's preview) and a new `DagStatusDigest.Shape` (the run card).
- **Plan-path start:** `CommandCreateRunData.PlanPath`. `CreateRunCommand` parses the plan before anything persists, forces the engine, clears the plan gate, spawns no lead, and calls `DagSubmitCommand` with the plan path. A submit failure cancels the run.
- **Lead at the first judgment event:** the wake adapter's `readLeadState` reports `NoLead` for a dag-holding run that has never had a lead worker. `flushLocked` then launches the lead instead of declaring it dead: the pending wake lines become the tail of the lead's launch prompt (`jarvis.PlanLeadPrompt` = principles + `OrchestrationRules` + wake). The spawn runs off the waker lock through `orchestrate.LaunchLeadHook`, wired to `wshserver.LaunchPlanLead`, which reuses `spawnRunWorkers` with a prompt override.
- **+ Run launcher:** the shape cards become Orchestrator and Quick. The machine toggle and the "Who plans" control leave the launcher; "Start from: A goal | A plan file" replaces them, with a path field and a live preview.

**Tech Stack:** Go (`pkg/jarvis`, `pkg/orchestrate`, `pkg/wshrpc`, `pkg/wshrpc/wshserver`, `pkg/waveobj`, `cmd/server`), React 19 + TypeScript + jotai, vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md`. This plan implements:
- §1 Run shapes: the two shapes, Quick's ask line, Orchestrator from a plan path (G5), the plan shape on the run card.
- §2 Judgment events and §5 Raise: a plan-input run with no lead launches its lead at the first judgment event.
- §6 Waking the lead: the plan-input launch wake.
- §13 Delivery slices: slice 5b.

## Decisions that differ from the spec's wording

1. **A clean finish launches no lead** (owner decision, 2026-09-15). "Run finished" alone never starts a plan-input run's lead: nobody has a judgment to make, and the engine already closes a lead-free run whose dag is done (`MaybeCompleteLeadFreeRun`, which seals evidence). Questions, a failure with its retry spent, a hung worker, a merge conflict and a failed Verify still launch it. Once a lead exists, run finished wakes it as before.
2. **The launch wake rides the launch prompt.** The spec says the lead launches with the rules "followed by the wake message". The wake is appended to the launch prompt rather than typed after the lead's first turn: one turn instead of two, and nothing to confirm. It is recorded as a new `lead-launched` run event ("text").
3. **+ Run drops the machine toggle and "Who plans" in this slice.** An Orchestrator started from + Run is always the engine. The adaptive and pipeline code, the cockpit composer's toggle and `wsh jarvis dag submit --file` stay until 5c. A profile whose `defaultmode` is `pipeline` hydrates the launcher to its baseline shape.
4. **A plan-path start takes no spec path.** §1 names only the plan. The lead's rules omit their Spec clause.
5. **A plan-path start clears the plan gate.** The human picked the plan and saw its shape at + Run; that was the review. The gate still applies to goal runs until 5c.
6. **No guard for a dag that finishes while a lead is spawning.** Every launching event (question, failure, hung, conflict, failed Verify) holds the dag short of done, so the window is not reachable in practice. A launch that fails marks the lead dead, and the engine's existing close path handles the run when its dag finishes.
7. **The plan-format rule lands in `CLAUDE.md` here.** Spec §3 put it in slice 4a and it was not added; plan-path start is where user-written plans enter.
8. **No new CDP scenario.** §12 asks for the + Run scenarios to be updated, but none drives + Run today (`scripts/cdp/scenarios.mjs` never touches `data-jarvis-new-run`). Task 7's live check covers the modal instead.

## Global Constraints

- **Quick ask line** (spec §1): `If this turns out to be more than one change or needs a design decision, stop and ask with <tool> instead of pushing on.` `<tool>` is `jarvis.AskTool(runtime)`: `AskUserQuestion` for claude, `ask_user_question` for pi.
- **Preview flags** (spec §1): `serial` when the plan has more than one task and runs in one lane; `unverified` when it has no `**Verify:**` line.
- **Scope limits:**
  - One new run event kind: `lead-launched`. No new timeouts, task states or failure kinds.
  - Two new RPC surfaces: `DagPlanPreviewCommand`, and `planpath` on `CommandCreateRunData`. One new digest field: `shape`.
  - Do not delete pipeline, adaptive, triage, the plan gate, JSON submit, `import-tasks`, `init` or `MaxDagTasks`. That is 5c.
- **`MaxDagTasks` still applies** until 5c: a plan over 16 tasks parses and previews, then fails at submit, and the run is cancelled with that error.
- No emojis. Comments are lower case and say why, never what.
- **Generated files:** never hand-edit `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` or `pkg/wshrpc/wshclient/wshclient.go`. After changing a `wshrpc` type, run `task generate`.
- Go tests for `jarvis`, `orchestrate` and `wshserver` need CGO flags. From PowerShell at the repo root:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  ```
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (`npx tsc` overflows).
- **Formatters:** HEAD is not formatter-clean. Never run `gofmt -w` or `prettier --write` over a file you did not already own; check only your hunks, with `gofmt -d <file>` and `npx prettier --check <file>`.
- **Staging:** other sessions edit this tree. `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` and `docs/superpowers/specs/2026-09-15-cross-surface-resource-linking-design.md` were already dirty before this slice and are not yours. Run `git status --short` before staging, and stage only the files Task 7 lists.
- **Commit:** one commit for the whole slice, with the spec edits and this plan folded in. Commits for this effort need no approval; pushing does. No co-author trailer.
- **New files:** the Write tool replaces an existing file. The new files are `pkg/wshrpc/wshserver/wshserver_planlead_test.go` and `pkg/wshrpc/wshserver/wshserver_planstart_test.go`; check with `ls pkg/wshrpc/wshserver | grep -E "planlead|planstart"` first. Every other change is an Edit.
- **Backend restart:** the live check in Task 7 needs a rebuilt `wavesrv` and a restarted dev app. Ask the owner before killing or restarting either (`wavesrv.x64` is also the packaged app's binary; check its path).

## Task order

1. Quick's ask line.
2. Plan shape in Go: the preview RPC and the digest field.
3. A plan-input run launches its lead at the first judgment event.
4. `CreateRun` from a plan path.
5. Launcher model: two shapes, start from a plan file (pure TS + stores).
6. Launcher views, + Run modal, sheet goal row, run card shape.
7. Docs, full verification, live check, commit.

---

### Task 1: Quick's ask line

**Files:**
- Modify: `pkg/jarvis/run.go` (`BuildQuickPrompt`, lines 377-388)
- Modify: `pkg/jarvis/runexec.go:187` (`phasePrompt`)
- Modify: `pkg/jarvis/run_test.go` (`TestBuildQuickPrompt`, lines 415-427)

**Interfaces:**
- Consumes: `AskTool(runtime string) string` (`pkg/jarvis/leadprompt.go`).
- Produces: `func BuildQuickPrompt(goal string, principles waveobj.PrincipleList, runtime string) string` (was two parameters).

- [ ] **Step 1: Write the failing tests**

Replace `TestBuildQuickPrompt` in `pkg/jarvis/run_test.go` with:

```go
func TestBuildQuickPrompt(t *testing.T) {
	// a single legacy-ID principle renders as its bare text (see RenderPrinciples)
	principles := waveobj.PrincipleList{{ID: waveobj.LegacyGlobalPrincipleID, Text: "be tidy"}}
	p := BuildQuickPrompt("add a spinner", principles, "claude")
	for _, want := range []string{
		"add a spinner",
		"be tidy",
		"wsh jarvis complete",
		"If this turns out to be more than one change or needs a design decision, stop and ask with AskUserQuestion instead of pushing on.",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("prompt missing %q:\n%s", want, p)
		}
	}
	if strings.Contains(p, "skill to work this goal") {
		t.Errorf("quick prompt must not carry a skill directive:\n%s", p)
	}
}

// a pi worker told to call Claude's tool asks in plain text, which never reaches the cockpit
func TestBuildQuickPromptNamesTheRuntimeAskTool(t *testing.T) {
	p := BuildQuickPrompt("add a spinner", nil, "pi")
	if !strings.Contains(p, "stop and ask with ask_user_question instead of pushing on") {
		t.Fatalf("a pi quick worker asks with ask_user_question:\n%s", p)
	}
	if strings.Contains(p, "AskUserQuestion") {
		t.Fatalf("a pi quick worker must not be told to call AskUserQuestion:\n%s", p)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (PowerShell, CGO flags set): `go test ./pkg/jarvis/ -run TestBuildQuickPrompt`
Expected: build failure, `too many arguments in call to BuildQuickPrompt`.

- [ ] **Step 3: Implement**

Replace `BuildQuickPrompt` in `pkg/jarvis/run.go`:

```go
// BuildQuickPrompt is the worker prompt for a quick run: same headless guidance as a pipeline execute
// phase but no skill directive — just do the goal directly and report completion. A quick goal that turns
// out to need a plan stops and asks rather than improvising one, and runtime names the tool it asks with.
func BuildQuickPrompt(goal string, principles waveobj.PrincipleList, runtime string) string {
	tool := AskTool(runtime)
	var b strings.Builder
	if rendered := RenderPrinciples(principles); rendered != "" {
		fmt.Fprintf(&b, "Work by these principles:\n%s\n\n", rendered)
	}
	fmt.Fprintf(&b, "You are running headless with no human at your terminal. Make reasonable assumptions for low-stakes or easily-reversible choices and keep going — do not ask about them. Only when a decision is genuinely consequential and a wrong assumption would waste real work, pause and use the %s tool (it reaches the human in the cockpit); otherwise proceed to the deliverable.\n", tool)
	fmt.Fprintf(&b, "If this turns out to be more than one change or needs a design decision, stop and ask with %s instead of pushing on.\n", tool)
	fmt.Fprintf(&b, "Goal: %s\n", goal)
	b.WriteString("When the goal is fully accomplished, commit your work and run `wsh jarvis complete --commit $(git rev-parse HEAD)` from your working tree (the SHA of your own final commit), so the run's evidence reflects exactly your changes.\n")
	return strings.TrimRight(b.String(), "\n")
}
```

In `pkg/jarvis/runexec.go`, `phasePrompt`, change:

```go
		return BuildQuickPrompt(run.Goal, run.Principles)
```

to:

```go
		return BuildQuickPrompt(run.Goal, run.Principles, run.Runtime)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvis/`
Expected: PASS. `BuildQuickPrompt` has no other callers (`grep -rn "BuildQuickPrompt(" pkg cmd` lists only `run.go`, `runexec.go` and `run_test.go`).

---

### Task 2: Plan shape in Go — the preview RPC and the digest field

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (`DagCommands`, `DagStatusDigest`, new types)
- Modify: `pkg/orchestrate/digest.go` (`BuildDigest`, new `PlanShapeOf`)
- Modify: `pkg/orchestrate/digestlane_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`loadDagPlan`, new `readPlanFile`, `planTitle`, `DagPlanPreviewCommand`)
- Modify: `pkg/wshrpc/wshserver/wshserver_dagplan_test.go`
- Regenerate: `task generate`

**Interfaces:**
- Consumes: `jarvis.ParsePlan`, `jarvis.Lanes`, `jarvis.LongestChain` (`pkg/jarvis/plan.go`).
- Produces:
  - `type wshrpc.DagPlanShape struct { Tasks, Lanes, LongestChain int }` (json `tasks`, `lanes`, `longestchain`); TS `DagPlanShape`.
  - `wshrpc.DagStatusDigest.Shape DagPlanShape` (json `shape`).
  - `DagPlanPreviewCommand(ctx, CommandDagPlanPreviewData{PlanPath}) (*CommandDagPlanPreviewRtnData, error)`; `CommandDagPlanPreviewRtnData{Title, Verify, Setup string; Shape DagPlanShape}` (json `title`, `verify`, `setup`, `shape`). TS: `RpcApi.DagPlanPreviewCommand(TabRpcClient, { planpath })`.
  - `func orchestrate.PlanShapeOf(tasks []waveobj.TaskNode) wshrpc.DagPlanShape`
  - `func readPlanFile(path string) (jarvis.Plan, error)` and `func planTitle(plan jarvis.Plan, path string) string` in package `wshserver`.

- [ ] **Step 1: Add the wire types**

In `pkg/wshrpc/wshrpctypes_dag.go`, add to `DagCommands` after `DagSubmitCommand`:

```go
	DagPlanPreviewCommand(ctx context.Context, data CommandDagPlanPreviewData) (*CommandDagPlanPreviewRtnData, error) // parse a plan file for + Run before any run exists
```

After `CommandDagSubmitData`, add:

```go
type CommandDagPlanPreviewData struct {
	PlanPath string `json:"planpath"` // absolute path to a plan in jarvis.PlanFormat
}

// CommandDagPlanPreviewRtnData is what + Run shows before it starts a plan: its name, its two plan-level
// commands, and its shape.
type CommandDagPlanPreviewRtnData struct {
	Title  string       `json:"title,omitempty"`
	Verify string       `json:"verify,omitempty"`
	Setup  string       `json:"setup,omitempty"`
	Shape  DagPlanShape `json:"shape"`
}

// DagPlanShape is how a plan decomposes: how many tasks, how many lanes they run in, and the longest chain
// of tasks that wait on one another.
type DagPlanShape struct {
	Tasks        int `json:"tasks"`
	Lanes        int `json:"lanes"`
	LongestChain int `json:"longestchain"`
}
```

In `DagStatusDigest`, add after `Report`:

```go
	// omitempty makes the generated TS field optional, so the typed digest fixtures in the frontend tests
	// keep compiling; Go still sends it
	Shape      DagPlanShape      `json:"shape,omitempty"`
```

- [ ] **Step 2: Write the failing digest test**

Append to `pkg/orchestrate/digestlane_test.go`:

```go
func TestDigestShapeCountsTasksLanesAndLongestChain(t *testing.T) {
	cases := []struct {
		name  string
		tasks []waveobj.TaskNode
		want  wshrpc.DagPlanShape
	}{
		{"one chain is one lane", chainTasks(), wshrpc.DagPlanShape{Tasks: 3, Lanes: 1, LongestChain: 3}},
		{"independent tasks are a lane each", plainTasks(), wshrpc.DagPlanShape{Tasks: 3, Lanes: 3, LongestChain: 1}},
	}
	for _, c := range cases {
		g := digestGroup(t, true, c.tasks)
		if got := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow)).Shape; got != c.want {
			t.Fatalf("%s: shape = %+v, want %+v", c.name, got, c.want)
		}
	}
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `go test ./pkg/orchestrate/ -run TestDigestShape`
Expected: FAIL, `shape = {Tasks:0 Lanes:0 LongestChain:0}`.

- [ ] **Step 4: Implement `PlanShapeOf` and set it in the digest**

In `pkg/orchestrate/digest.go`, in `BuildDigest`, after `d.Report = buildReport(sn, d.Durations)` add:

```go
	d.Shape = PlanShapeOf(g.Tasks)
```

and add below `BuildDigest`:

```go
// PlanShapeOf is a plan's shape from its tasks. + Run's preview and the run card both read it, so the lanes
// a human approves are the lanes the engine runs.
func PlanShapeOf(tasks []waveobj.TaskNode) wshrpc.DagPlanShape {
	return wshrpc.DagPlanShape{
		Tasks:        len(tasks),
		Lanes:        len(jarvis.Lanes(tasks)),
		LongestChain: jarvis.LongestChain(tasks),
	}
}
```

Add `"github.com/wavetermdev/waveterm/pkg/jarvis"` to `digest.go`'s imports if it is not already there.

Run: `go test ./pkg/orchestrate/ -run TestDigest`
Expected: PASS.

- [ ] **Step 5: Write the failing preview tests**

Append to `pkg/wshrpc/wshserver/wshserver_dagplan_test.go`:

```go
func TestDagPlanPreview(t *testing.T) {
	ctx := context.Background()
	write := func(t *testing.T, name, src string) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), name)
		if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}

	t.Run("reports the plan's name, commands and shape", func(t *testing.T) {
		src := "# Coupons\n\n**Verify:** `task test`\n\n### Task 1: input\n**Depends on:** none\n\n### Task 2: totals\n**Depends on:** none\n\n### Task 3: tests\n**Depends on:** Task 1, Task 2\n"
		got, err := (&WshServer{}).DagPlanPreviewCommand(ctx, wshrpc.CommandDagPlanPreviewData{PlanPath: write(t, "plan.md", src)})
		if err != nil {
			t.Fatal(err)
		}
		want := wshrpc.CommandDagPlanPreviewRtnData{
			Title:  "Coupons",
			Verify: "task test",
			Shape:  wshrpc.DagPlanShape{Tasks: 3, Lanes: 3, LongestChain: 2},
		}
		if !reflect.DeepEqual(*got, want) {
			t.Fatalf("preview = %+v, want %+v", *got, want)
		}
	})

	t.Run("a plan with no title is named by its file", func(t *testing.T) {
		got, err := (&WshServer{}).DagPlanPreviewCommand(ctx, wshrpc.CommandDagPlanPreviewData{PlanPath: write(t, "2026-09-15-coupons.md", "### Task 1: input\n")})
		if err != nil {
			t.Fatal(err)
		}
		if got.Title != "2026-09-15-coupons" {
			t.Fatalf("title = %q", got.Title)
		}
	})

	t.Run("a plan that will not run is refused with the parser's message", func(t *testing.T) {
		cases := []struct {
			name    string
			path    string
			errPart string
		}{
			{"relative path", "plan.md", "absolute"},
			{"missing file", filepath.Join(t.TempDir(), "missing.md"), "missing.md"},
			{"no tasks", write(t, "prose.md", "just prose\n"), "no tasks"},
		}
		for _, c := range cases {
			_, err := (&WshServer{}).DagPlanPreviewCommand(ctx, wshrpc.CommandDagPlanPreviewData{PlanPath: c.path})
			if err == nil || !strings.Contains(err.Error(), c.errPart) {
				t.Fatalf("%s: error %v should name %q", c.name, err, c.errPart)
			}
		}
	})
}
```

- [ ] **Step 6: Run them to verify they fail**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestDagPlanPreview`
Expected: build failure, `(&WshServer{}).DagPlanPreviewCommand undefined`.

- [ ] **Step 7: Implement the preview and share the plan read with submit**

In `pkg/wshrpc/wshserver/wshserver_dag.go`, replace `loadDagPlan` with:

```go
// readPlanFile reads and parses the plan at path. wavesrv does not share the caller's cwd, so only an
// absolute path names the file the caller meant.
func readPlanFile(path string) (jarvis.Plan, error) {
	if !filepath.IsAbs(path) {
		return jarvis.Plan{}, fmt.Errorf("planpath %q must be absolute", path)
	}
	src, err := os.ReadFile(path)
	if err != nil {
		return jarvis.Plan{}, fmt.Errorf("reading plan: %w", err)
	}
	plan, err := jarvis.ParsePlan(string(src))
	if err != nil {
		return jarvis.Plan{}, fmt.Errorf("plan %s: %w", path, err)
	}
	return plan, nil
}

// planTitle names a plan by its heading, else by its file.
func planTitle(plan jarvis.Plan, path string) string {
	if plan.Title != "" {
		return plan.Title
	}
	return strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
}

// loadDagPlan fills a submit's tasks, and its title and width when unset, from its plan file, and
// returns the plan for its Verify and Setup commands.
func loadDagPlan(data *wshrpc.CommandDagSubmitData) (jarvis.Plan, error) {
	if len(data.Tasks) > 0 {
		return jarvis.Plan{}, fmt.Errorf("pass tasks or planpath, not both")
	}
	if data.SpecPath != "" {
		if !filepath.IsAbs(data.SpecPath) {
			return jarvis.Plan{}, fmt.Errorf("specpath %q must be absolute", data.SpecPath)
		}
		// checked now: a mistyped path would otherwise surface only as a log line at the first merge
		if _, err := os.Stat(data.SpecPath); err != nil {
			return jarvis.Plan{}, fmt.Errorf("reading spec: %w", err)
		}
	}
	plan, err := readPlanFile(data.PlanPath)
	if err != nil {
		return jarvis.Plan{}, err
	}
	data.Tasks = plan.Tasks
	if data.Title == "" {
		data.Title = planTitle(plan, data.PlanPath)
	}
	if data.Parallelism == 0 {
		data.Parallelism = orchestrate.DefaultParallelism(plan.Tasks)
	}
	return plan, nil
}

// DagPlanPreviewCommand parses a plan for + Run before a run exists, so a plan that will not run is refused
// before start and the human sees the shape the engine will run.
func (ws *WshServer) DagPlanPreviewCommand(ctx context.Context, data wshrpc.CommandDagPlanPreviewData) (*wshrpc.CommandDagPlanPreviewRtnData, error) {
	plan, err := readPlanFile(data.PlanPath)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandDagPlanPreviewRtnData{
		Title:  planTitle(plan, data.PlanPath),
		Verify: plan.Verify,
		Setup:  plan.Setup,
		Shape:  orchestrate.PlanShapeOf(plan.Tasks),
	}, nil
}
```

- [ ] **Step 8: Regenerate and run the tests**

Run: `task generate`
Expected: `frontend/app/store/wshclientapi.ts` gains `DagPlanPreviewCommand`; `frontend/types/gotypes.d.ts` gains `DagPlanShape`, `CommandDagPlanPreviewData`, `CommandDagPlanPreviewRtnData`, and `shape?: DagPlanShape` on `DagStatusDigest`.

Run: `go test ./pkg/orchestrate/ ./pkg/wshrpc/wshserver/ -run "TestDagPlanPreview|TestDagSubmitFromPlanPath|TestDigest"`
Expected: PASS, including every existing `TestDagSubmitFromPlanPath` subtest.

---

### Task 3: A plan-input run launches its lead at the first judgment event

**Files:**
- Modify: `pkg/waveobj/runevent.go` (new kind `lead-launched`)
- Modify: `pkg/jarvis/leadprompt.go`, `pkg/jarvis/leadprompt_test.go` (new `PlanLeadPrompt`)
- Modify: `pkg/jarvis/runexec.go` (`EnsureWorkers`), `pkg/jarvis/runexec_test.go`
- Modify: `pkg/orchestrate/wake.go`, `pkg/orchestrate/wake_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (`spawnRunWorkersWithPrompt`, `LaunchPlanLead`)
- Create: `pkg/wshrpc/wshserver/wshserver_planlead_test.go`
- Modify: `cmd/server/main-server.go:628`
- Modify: `frontend/app/view/agents/runtimeline.ts`, `frontend/app/view/agents/runtimeline.test.ts`

**Interfaces:**
- Consumes: `jarvis.OrchestrationRules(runId, specPath, planPath string) string`, `jarvis.RenderPrinciples`, `runTabID` (`pkg/orchestrate/leadclose.go`), `leadORef` (`wshserver_dag.go:322`).
- Produces:
  - `waveobj.RunEventKindLeadLaunched = "lead-launched"` (detail `"text"`)
  - `func jarvis.PlanLeadPrompt(principles waveobj.PrincipleList, runId, specPath, planPath, wake string) string`
  - `func jarvis.EnsureWorkers(ctx, run, cap, projectName, prompt string) (map[int]string, error)` (new last parameter; `""` keeps the phase's own prompt)
  - `var orchestrate.LaunchLeadHook func(ctx context.Context, channelId, runId, prompt string) error`
  - `func orchestrate.SetLaunchLeadForTest(fn func(ctx context.Context, channelId, runId, wake string)) func()`
  - `func wshserver.LaunchPlanLead(ctx context.Context, channelId, runId, prompt string) error`

- [ ] **Step 1: The launch prompt — failing test**

Append to `pkg/jarvis/leadprompt_test.go` (add `"github.com/wavetermdev/waveterm/pkg/waveobj"` to its imports):

```go
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
```

Run: `go test ./pkg/jarvis/ -run TestPlanLeadPrompt`
Expected: build failure, `undefined: PlanLeadPrompt`.

- [ ] **Step 2: The launch prompt — implement**

Append to `pkg/jarvis/leadprompt.go` (add `"github.com/wavetermdev/waveterm/pkg/waveobj"` to its imports):

```go
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
```

Run: `go test ./pkg/jarvis/ -run TestPlanLeadPrompt`
Expected: PASS.

- [ ] **Step 3: A given worker prompt — failing test**

In `pkg/jarvis/runexec_test.go`, change both calls in `TestEnsureWorkersPassesKeepOnExitOnlyForOrchestrator` from `EnsureWorkers(context.Background(), &orch, cap, "project")` / `(..., &pipe, cap, "project")` to pass a fifth argument `""`. Then append:

```go
func TestEnsureWorkersUsesAGivenPrompt(t *testing.T) {
	old := SpawnRunWorker
	defer func() { SpawnRunWorker = old }()

	var prompts []string
	SpawnRunWorker = func(_ context.Context, _ runroute.Capability, _, _, _, prompt string, _ RunWorkerOptions) (string, error) {
		prompts = append(prompts, prompt)
		return "tab:worker", nil
	}
	cap, err := runroute.Resolve(waveobj.RoutePin{Runtime: "pi"})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	given := NewRun("orchestrate", "ws", "/p", nil, RunMode_Orchestrator, DefaultOrchestratorPlaybook(false), 1)
	if _, err := EnsureWorkers(context.Background(), &given, cap, "project", "the rules, then the wake"); err != nil {
		t.Fatal(err)
	}
	derived := NewRun("orchestrate", "ws", "/p", nil, RunMode_Orchestrator, DefaultOrchestratorPlaybook(false), 1)
	if _, err := EnsureWorkers(context.Background(), &derived, cap, "project", ""); err != nil {
		t.Fatal(err)
	}

	if len(prompts) != 2 || prompts[0] != "the rules, then the wake" || prompts[1] != phasePrompt(&derived, 0) {
		t.Fatalf("a given prompt replaces the phase's, an empty one derives it; got %q", prompts)
	}
}
```

Run: `go test ./pkg/jarvis/ -run TestEnsureWorkers`
Expected: build failure, `too many arguments in call to EnsureWorkers`.

- [ ] **Step 4: A given worker prompt — implement**

In `pkg/jarvis/runexec.go`, replace `EnsureWorkers` with:

```go
// EnsureWorkers spawns a worker for each running phase that has none yet, returning the phase
// index -> tab oref it created. It does not mutate/persist the run; the caller attaches the orefs.
// The runtime comes from the persisted run; an empty runtime (legacy Run) resolves to Claude, the
// historical worker implementation. On a spawn error it returns what it has so far plus the error
// (the caller still persists partial work). A non-empty prompt replaces the phase's own: a lead started
// after its plan was submitted works from the orchestration rules, not the goal-run launch prompt.
func EnsureWorkers(ctx context.Context, run *waveobj.Run, cap runroute.Capability, projectName, prompt string) (map[int]string, error) {
	spawned := map[int]string{}
	for i := range run.Phases {
		p := run.Phases[i]
		if p.State != PhaseState_Running || len(p.WorkerOrefs) > 0 {
			continue
		}
		workerPrompt := prompt
		if workerPrompt == "" {
			workerPrompt = phasePrompt(run, i)
		}
		opts := RunWorkerOptions{KeepOnExit: run.Mode == RunMode_Orchestrator}
		oref, err := SpawnRunWorker(ctx, cap, run.WorkspaceId, projectName, run.ProjectPath, workerPrompt, opts)
		if err != nil {
			return spawned, fmt.Errorf("spawning worker for phase %d: %w", i, err)
		}
		spawned[i] = oref
	}
	return spawned, nil
}
```

Run: `go test ./pkg/jarvis/`
Expected: PASS.

- [ ] **Step 5: The run event kind**

In `pkg/waveobj/runevent.go`, in the "question queue and the lead wake" block, add a comment line after `lead-woken` and the constant after `RunEventKindLeadWoken`:

```go
	//   lead-launched     a plan-input run's first lead started, with the wake that needed it ("text")
```

```go
	RunEventKindLeadLaunched   = "lead-launched"
```

- [ ] **Step 6: The wake adapter — failing tests**

In `pkg/orchestrate/wake_test.go`, add `"errors"` and `"strings"` to the imports, then add below the `const` block:

```go
// the engine and merge fixtures build store-backed runs with a dag and no lead worker; each of their
// judgment events would otherwise start a real launch goroutine that outlives its test
func init() {
	launchLeadFn = func(context.Context, string, string, string) {}
}

// stubLaunch records the wakes each started lead was launched with. The launch stays open until the test
// settles it with leadLaunched.
func stubLaunch(t *testing.T) *[]string {
	t.Helper()
	var launched []string
	old := launchLeadFn
	launchLeadFn = func(_ context.Context, _, _, wake string) { launched = append(launched, wake) }
	t.Cleanup(func() { launchLeadFn = old })
	return &launched
}

const failedLine = "wake: task t-1 failed (tests), retry spent. wsh jarvis dag status"
```

Append the tests:

```go
func TestNoLeadRunLaunchesItsLeadAtTheFirstJudgmentEvent(t *testing.T) {
	f := newFakeLead(t)
	f.state = leadState{NoLead: true}
	launched := stubLaunch(t)

	PostWake(context.Background(), wakeChannel, wakeRun, failedLine)

	if len(*launched) != 1 || (*launched)[0] != failedLine {
		t.Fatalf("the first judgment event launches the lead with the wake as its first message, got %q", *launched)
	}
	if len(f.sends) != 0 || LeadDead(wakeRun) {
		t.Fatalf("a lead never launched is not dead and gets nothing typed, dead=%v sends=%q", LeadDead(wakeRun), f.sends)
	}
	if f.countKind(waveobj.RunEventKindLeadLaunched) != 1 || f.countKind(waveobj.RunEventKindLeadWakeFailed) != 0 {
		t.Fatalf("want one lead-launched row and no lead-wake-failed row, got %+v", f.rows)
	}
}

func TestNoLeadQuestionLaunchesTheLeadAndStaysItsQuestion(t *testing.T) {
	f := newFakeLead(t)
	f.state = leadState{NoLead: true}
	launched := stubLaunch(t)
	seedLeadAsk("block:child-1", "a1", 1)

	PokeWake(context.Background(), wakeChannel, wakeRun)

	if len(*launched) != 1 || (*launched)[0] != "wake: 1 question waiting. wsh jarvis dag asks" {
		t.Fatalf("a question launches the lead with the question line, got %q", *launched)
	}
	if p, _ := agentask.GlobalRegistry.Get("block:child-1"); p.Owner != agentask.AskOwner_Lead {
		t.Fatalf("a question raised before the lead exists is still the lead's, got %+v", p)
	}
}

// decision 1: nobody has a judgment to make about a clean finish, and the engine closes the run itself
func TestCleanFinishWithNoLeadLaunchesNothing(t *testing.T) {
	f := newFakeLead(t)
	f.state = leadState{NoLead: true}
	launched := stubLaunch(t)

	PostWake(context.Background(), wakeChannel, wakeRun, finishedLine)

	if len(*launched) != 0 || len(f.rows) != 0 || LeadDead(wakeRun) {
		t.Fatalf("a clean finish starts no lead and records nothing: launched=%q rows=%+v dead=%v", *launched, f.rows, LeadDead(wakeRun))
	}
}

func TestEventsDuringALaunchWaitForTheLead(t *testing.T) {
	f := newFakeLead(t)
	f.state = leadState{NoLead: true}
	launched := stubLaunch(t)
	ctx := context.Background()

	PostWake(ctx, wakeChannel, wakeRun, failedLine)
	PostWake(ctx, wakeChannel, wakeRun, finishedLine)
	tickWakes(ctx)
	if len(*launched) != 1 {
		t.Fatalf("one launch per lead while it starts, got %q", *launched)
	}

	f.state = leadState{BlockId: wakeLeadBlock, TabId: wakeLeadTab, Alive: true, State: baseds.AgentState_Idle}
	leadLaunched(ctx, wakeChannel, wakeRun, nil)
	tickWakes(ctx)

	if len(f.sends) != 1 || f.sends[0] != finishedLine {
		t.Fatalf("an event held while the lead started is typed once it is at its prompt, got %q", f.sends)
	}
}

func TestFailedLaunchHandsJudgmentToTheUser(t *testing.T) {
	f := newFakeLead(t)
	f.state = leadState{NoLead: true}
	stubLaunch(t)
	ctx := context.Background()
	seedLeadAsk("block:child-1", "a1", 1)
	PokeWake(ctx, wakeChannel, wakeRun)

	leadLaunched(ctx, wakeChannel, wakeRun, errors.New("no route for pi"))

	if !LeadDead(wakeRun) {
		t.Fatal("a lead that could not be started takes no wakes")
	}
	p, _ := agentask.GlobalRegistry.Get("block:child-1")
	if p.Owner != agentask.AskOwner_User || !strings.Contains(p.Note, leadLaunchFailedNote) || !strings.Contains(p.Note, "no route for pi") {
		t.Fatalf("its questions go to the user with why, got %+v", p)
	}
	if f.countKind(waveobj.RunEventKindLeadWakeFailed) != 1 {
		t.Fatalf("want one lead-wake-failed row, got %+v", f.rows)
	}
}
```

Run: `go test ./pkg/orchestrate/ -run "NoLead|CleanFinish|DuringALaunch|FailedLaunch"`
Expected: build failure, `unknown field NoLead in struct literal of type leadState`.

- [ ] **Step 7: The wake adapter — implement**

In `pkg/orchestrate/wake.go`:

1. Add `"github.com/wavetermdev/waveterm/pkg/jarvis"` to the imports.
2. In the `const` block of notes, add:

```go
	leadLaunchFailedNote = "lead could not be started"
```

3. Replace `leadState` with:

```go
type leadState struct {
	BlockId string
	TabId   string
	Alive   bool
	State   string
	// NoLead is a dag-holding run that has never had a lead worker, as opposed to one whose lead exited.
	NoLead bool
}
```

4. In `runWake`, add after `handoff bool`:

```go
	// launching is a first lead still starting; launchLines are the events it was started with.
	launching   bool
	launchLines []string
```

5. After `var wakeNow = ...`, add:

```go
// LaunchLeadHook spawns runId's lead with prompt. Wired to wshserver at startup; the default refuses,
// because wsh and the tests link this package without the server.
var LaunchLeadHook = func(ctx context.Context, channelId, runId, prompt string) error {
	return fmt.Errorf("no lead launcher in this process")
}

// launchLeadFn starts runId's first lead with wake as its first message. The spawn creates a tab and starts
// a process, so it runs off the waker lock and settles through leadLaunched. A var for tests.
var launchLeadFn = func(ctx context.Context, channelId, runId, wake string) {
	go func() {
		lctx := context.WithoutCancel(ctx)
		leadLaunched(lctx, channelId, runId, startLead(lctx, channelId, runId, wake))
	}()
}

// SetLaunchLeadForTest replaces the lead launch for tests in other packages and returns the restore.
func SetLaunchLeadForTest(fn func(ctx context.Context, channelId, runId, wake string)) func() {
	old := launchLeadFn
	launchLeadFn = fn
	return func() { launchLeadFn = old }
}
```

6. In `flushLocked`, change the first guard to `if rw.sentAt != 0 || rw.dead || rw.launching {`, and insert directly after `rw.blockId, rw.tabId = st.BlockId, st.TabId`:

```go
	if st.NoLead {
		w.launchLocked(ctx, runId, rw, asks, untold)
		return
	}
```

7. Add below `flushLocked`:

```go
// launchLocked starts the first lead of a run submitted with no lead, with the pending events as its first
// message (spec §1, G5). A clean finish is not a judgment: the engine closes a run nobody has to judge
// (MaybeCompleteLeadFreeRun), so run finished alone starts nothing.
func (w *waker) launchLocked(ctx context.Context, runId string, rw *runWake, asks map[string]agentask.PendingAsk, untold bool) {
	if !untold && onlyRunFinished(rw.lines) {
		rw.lines, rw.handoff = nil, false
		return
	}
	lines := append([]string{}, rw.lines...)
	if untold {
		lines = append(lines, questionsLine(asks))
	}
	text := strings.Join(lines, "\n")
	rw.launching, rw.launchLines, rw.lines = true, rw.lines, nil
	for _, p := range asks {
		rw.told[askTold(p)] = true
	}
	appendRunEvent(ctx, rw.channelId, runId, waveobj.RunEventKindLeadLaunched, nil, map[string]any{"text": text})
	launchLeadFn(ctx, rw.channelId, runId, text)
}

// onlyRunFinished reports held lines that say nothing but that the run finished.
func onlyRunFinished(lines []string) bool {
	for _, l := range lines {
		if l != runFinishedWake {
			return false
		}
	}
	return true
}

// leadLaunched settles a launch. A started lead took its first wake as its launch prompt, and events held
// meanwhile are typed once it reports it is at its prompt. A lead that could not be started hands its
// judgment to the human (G8).
func leadLaunched(ctx context.Context, channelId, runId string, err error) {
	wakes.lock.Lock()
	defer wakes.lock.Unlock()
	rw := wakes.runLocked(channelId, runId)
	rw.launching = false
	if err != nil {
		rw.lines = append(rw.launchLines, rw.lines...)
		wakes.leadDiedLocked(ctx, runId, rw, leadLaunchFailedNote+": "+err.Error())
	}
	rw.launchLines = nil
}

// startLead builds a plan-input lead's launch prompt from its run and dag and hands it to the spawner.
func startLead(ctx context.Context, channelId, runId, wake string) error {
	run, err := wstore.GetRun(ctx, channelId, runId)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	g, err := wstore.GetDag(ctx, run.DagORef)
	if err != nil {
		return fmt.Errorf("loading dag: %w", err)
	}
	return LaunchLeadHook(ctx, channelId, runId, jarvis.PlanLeadPrompt(run.Principles, runId, g.SpecPath, g.PlanPath, wake))
}
```

8. In `readLeadState`, replace

```go
	tabId := runTabID(run)
	if tabId == "" {
		return leadState{}
	}
```

with

```go
	tabId := runTabID(run)
	if tabId == "" {
		// a run submitted with a plan and no lead has never had one: its first judgment event starts it
		return leadState{NoLead: run.DagORef != ""}
	}
```

Run: `go test ./pkg/orchestrate/`
Expected: PASS, every existing wake, queue, engine and lead-free-close test included. `TestScheduleClosesLeadFreeRunWhenDagCompletes` now passes through the real `readLeadState`: its run-finished wake is dropped instead of recording `lead-wake-failed`.

- [ ] **Step 8: The server's lead spawner — failing tests**

Check `ls pkg/wshrpc/wshserver | grep planlead` prints nothing, then create `pkg/wshrpc/wshserver/wshserver_planlead_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// dagAskFixture and the dag tests build owner runs with a dag and no lead worker. Their judgment events now
// launch a lead, and the real launch runs on a goroutine that outlives the test.
func init() {
	orchestrate.SetLaunchLeadForTest(func(context.Context, string, string, string) {})
}

func planLeadRun(t *testing.T, state string) (*waveobj.Channel, waveobj.Run) {
	t.Helper()
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "plan-lead", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := jarvis.NewRun("ship coupons", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	run.Runtime = "pi"
	run.Phases[0].State = state
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatal(err)
	}
	return ch, run
}

func TestLaunchPlanLeadStartsTheLeadWithTheGivenPrompt(t *testing.T) {
	ctx := context.Background()
	ch, run := planLeadRun(t, jarvis.PhaseState_Running)
	stubRunServer(t, "pi", nil)
	var prompt string
	var keep bool
	stubbed := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(_ context.Context, _ runroute.Capability, _, _, _, p string, opts jarvis.RunWorkerOptions) (string, error) {
		prompt, keep = p, opts.KeepOnExit
		return waveobj.MakeORef(waveobj.OType_Tab, "lead-tab").String(), nil
	}
	t.Cleanup(func() { jarvis.SpawnRunWorker = stubbed })

	if err := LaunchPlanLead(ctx, ch.OID, run.ID, "the rules, then the wake"); err != nil {
		t.Fatal(err)
	}

	if prompt != "the rules, then the wake" || !keep {
		t.Fatalf("the lead starts on the given prompt and outlives its process, prompt=%q keeponexit=%v", prompt, keep)
	}
	got, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if leadORef(got) != "tab:lead-tab" {
		t.Fatalf("the lead's tab is attached to the run, got %q", leadORef(got))
	}
}

func TestLaunchPlanLeadRefusesARunWithNoPhaseToStart(t *testing.T) {
	ch, run := planLeadRun(t, jarvis.PhaseState_Done)
	stubRunServer(t, "pi", nil)

	err := LaunchPlanLead(context.Background(), ch.OID, run.ID, "the rules")
	if err == nil || !strings.Contains(err.Error(), "no running phase") {
		t.Fatalf("a run with nothing running cannot take a lead, got %v", err)
	}
}
```

Run: `go test ./pkg/wshrpc/wshserver/ -run TestLaunchPlanLead`
Expected: build failure, `undefined: LaunchPlanLead`.

- [ ] **Step 9: The server's lead spawner — implement and wire**

In `pkg/wshrpc/wshserver/wshserver_runs.go`:

1. Change the line `func spawnRunWorkers(ctx context.Context, channelId, runId, projectName string) error {` to `func spawnRunWorkersWithPrompt(ctx context.Context, channelId, runId, projectName, prompt string) error {`, and change the first word of its doc comment from `spawnRunWorkers` to `spawnRunWorkersWithPrompt`.
2. In its body, change `jarvis.EnsureWorkers(ctx, run, cap, projectName)` to `jarvis.EnsureWorkers(ctx, run, cap, projectName, prompt)`.
3. Insert above that doc comment:

```go
// spawnRunWorkers starts each newly running phase's worker on the prompt its phase derives.
func spawnRunWorkers(ctx context.Context, channelId, runId, projectName string) error {
	return spawnRunWorkersWithPrompt(ctx, channelId, runId, projectName, "")
}

// LaunchPlanLead is the engine's lead spawner for a run submitted with no lead: the run's own lead route,
// its project checkout, and prompt in place of the goal-run launch prompt. It fails when no lead was
// attached, so the wake adapter hands the judgment to the human rather than waiting on nobody.
func LaunchPlanLead(ctx context.Context, channelId, runId, prompt string) error {
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, channelId)
	if err != nil {
		return fmt.Errorf("loading channel: %w", err)
	}
	if err := spawnRunWorkersWithPrompt(ctx, channelId, runId, ch.Name, prompt); err != nil {
		return err
	}
	run, err := wstore.GetRun(ctx, channelId, runId)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	if leadORef(run) == "" {
		return fmt.Errorf("run %s has no running phase to start a lead in", runId)
	}
	return nil
}
```

In `cmd/server/main-server.go`, add after the `orchestrate.SealRunEvidenceHook = ...` line:

```go
	orchestrate.LaunchLeadHook = wshserver.LaunchPlanLead // a run submitted with no lead gets one at its first judgment event; before StartWatchdog, whose first tick can deliver one
```

Run: `go test ./pkg/wshrpc/wshserver/ ./pkg/jarvis/ ./pkg/orchestrate/` and `go build ./cmd/server/`
Expected: PASS, and the server builds. `spawnRunWorkers` keeps its other callers (`CreateRunCommand`, `CreateChildRunCommand`, `AdvanceRunCommand`, `wshserver_spawn_test.go`) unchanged.

- [ ] **Step 10: The timeline row**

In `frontend/app/view/agents/runtimeline.test.ts`, add `expect(toneFor("lead-launched")).toBe("text-muted");` to the "tones the queue and wake rows" test, and `expect(eventKindTitle("lead-launched")).toBe("Lead started");` to the "names the queue and wake rows" test.

Run: `npx vitest run frontend/app/view/agents/runtimeline.test.ts`
Expected: FAIL (`lead-launched` falls back to the raw kind and to muted; the title assertion fails).

In `frontend/app/view/agents/runtimeline.ts`, add `"lead-launched",` after `"lead-woken",` in the run-group kinds set, `"lead-launched": "Lead started",` after `"lead-woken": "Lead woken",` in `KIND_TITLE`, and `"lead-launched": "text-muted",` after `"lead-woken": "text-muted",` in `KIND_TONE`.

Run: `npx vitest run frontend/app/view/agents/runtimeline.test.ts`
Expected: PASS.

---

### Task 4: `CreateRun` from a plan path

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_runs.go` (`CommandCreateRunData`)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (`CreateRunCommand`, lines 296-449)
- Create: `pkg/wshrpc/wshserver/wshserver_planstart_test.go`
- Regenerate: `task generate`

**Interfaces:**
- Consumes: `readPlanFile`, `planTitle` (Task 2), `DagSubmitCommand`, `CancelRunCommand`, `orchestrate.PlanGatePending`, `wstore.GetChannelRuns`.
- Produces: `CommandCreateRunData.PlanPath string` (json `planpath`); TS `CommandCreateRunData.planpath?: string`.

- [ ] **Step 1: Add the field and regenerate**

In `pkg/wshrpc/wshrpctypes_runs.go`, add to `CommandCreateRunData` after `DeferStart`:

```go
	// PlanPath starts an orchestrator run from an absolute plan path in jarvis.PlanFormat: the engine
	// submits it at start and no lead runs until something needs judgment. Goal defaults to the plan's name.
	PlanPath string `json:"planpath,omitempty"`
```

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts` gains `planpath?: string` on `CommandCreateRunData`.

- [ ] **Step 2: Write the failing tests**

Check `ls pkg/wshrpc/wshserver | grep planstart` prints nothing, then create `pkg/wshrpc/wshserver/wshserver_planstart_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestCreateRunFromPlanPath(t *testing.T) {
	ctx := context.Background()
	const plan = "# Coupon codes\n\n### Task 1: input\nadd the field\n\n### Task 2: totals\n**Depends on:** none\n"
	writePlan := func(t *testing.T, src string) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), "plan.md")
		if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	newChannel := func(t *testing.T) *waveobj.Channel {
		t.Helper()
		ch, err := wstore.CreateChannel(ctx, "plan-start", t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		stubRunServer(t, "pi", nil)
		return ch
	}
	start := func(ch *waveobj.Channel, data wshrpc.CommandCreateRunData) (*wshrpc.CommandCreateRunRtnData, error) {
		data.ChannelId, data.WorkspaceId, data.Runtime = ch.OID, "ws", "pi"
		return (&WshServer{}).CreateRunCommand(ctx, data)
	}
	channelRuns := func(t *testing.T, ch *waveobj.Channel) []*waveobj.Run {
		t.Helper()
		runs, err := wstore.GetChannelRuns(ctx, ch.OID)
		if err != nil {
			t.Fatal(err)
		}
		return runs
	}

	t.Run("submits the plan at start, named by it, with no lead and no plan gate", func(t *testing.T) {
		ch := newChannel(t)
		planPath := writePlan(t, plan)
		rtn, err := start(ch, wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, PlanPath: planPath})
		if err != nil {
			t.Fatal(err)
		}
		run := rtn.Run
		if run.Goal != "Coupon codes" || run.Orchestration != jarvis.Orchestration_Engine {
			t.Fatalf("a plan start is an engine run named by its plan, goal %q orchestration %q", run.Goal, run.Orchestration)
		}
		if n := len(run.Phases[0].WorkerOrefs); n != 0 {
			t.Fatalf("a plan start spawns no lead, got %d workers", n)
		}
		if run.DagORef == "" {
			t.Fatal("the plan is submitted at start")
		}
		g, err := wstore.GetDag(ctx, run.DagORef)
		if err != nil {
			t.Fatal(err)
		}
		if g.PlanPath != planPath || len(g.Tasks) != 2 || orchestrate.PlanGatePending(g) {
			t.Fatalf("the dag is the plan, ungated: planpath %q, %d tasks, gated %v", g.PlanPath, len(g.Tasks), orchestrate.PlanGatePending(g))
		}
	})

	t.Run("a goal given with the plan names the run", func(t *testing.T) {
		ch := newChannel(t)
		rtn, err := start(ch, wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, Goal: "coupons, first cut", PlanPath: writePlan(t, plan)})
		if err != nil {
			t.Fatal(err)
		}
		if rtn.Run.Goal != "coupons, first cut" {
			t.Fatalf("goal = %q", rtn.Run.Goal)
		}
	})

	t.Run("a plan that cannot run is refused before a run exists", func(t *testing.T) {
		ch := newChannel(t)
		cases := []struct {
			name    string
			data    wshrpc.CommandCreateRunData
			errPart string
		}{
			{"unparseable plan", wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, PlanPath: writePlan(t, "just prose\n")}, "no tasks"},
			{"relative path", wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, PlanPath: "plan.md"}, "absolute"},
			{"quick shape", wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Quick, PlanPath: writePlan(t, plan)}, "orchestrator"},
			{"adaptive lead", wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, Orchestration: jarvis.Orchestration_Adaptive, PlanPath: writePlan(t, plan)}, "engine"},
		}
		for _, c := range cases {
			if _, err := start(ch, c.data); err == nil || !strings.Contains(err.Error(), c.errPart) {
				t.Fatalf("%s: error %v should name %q", c.name, err, c.errPart)
			}
		}
		if runs := channelRuns(t, ch); len(runs) != 0 {
			t.Fatalf("a refused plan leaves no run, got %d", len(runs))
		}
	})

	// the one submit-time refusal a parsed plan can still hit is the task cap; slice 5c deletes the cap, and
	// this case must then move to another refusal DagSubmitCommand still makes
	t.Run("a plan the engine refuses at submit cancels the run it started", func(t *testing.T) {
		ch := newChannel(t)
		var big strings.Builder
		for n := 1; n <= jarvis.MaxDagTasks+1; n++ {
			fmt.Fprintf(&big, "### Task %d: step %d\n**Depends on:** none\n\n", n, n)
		}
		_, err := start(ch, wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, PlanPath: writePlan(t, big.String())})
		if err == nil || !strings.Contains(err.Error(), "submitting plan") {
			t.Fatalf("want the submit refusal, got %v", err)
		}
		runs := channelRuns(t, ch)
		if len(runs) != 1 || runs[0].Status != jarvis.RunStatus_Cancelled {
			t.Fatalf("the started run is cancelled rather than left waiting for a dag, got %+v", runs)
		}
	})
}
```

Run: `go test ./pkg/wshrpc/wshserver/ -run TestCreateRunFromPlanPath`
Expected: FAIL. The first subtest spawns a lead and has no dag; the refusal subtests get no error for the quick and adaptive cases.

- [ ] **Step 3: Implement**

In `CreateRunCommand` (`pkg/wshrpc/wshserver/wshserver_runs.go`):

1. Insert at the top of the function, before the `channelid, workspaceid and goal are required` check:

```go
	// a plan start is refused before anything persists: a plan that will not parse, or a shape that cannot
	// run one, must not leave a run behind
	if data.PlanPath != "" {
		if data.Mode != jarvis.RunMode_Orchestrator {
			return nil, fmt.Errorf("planpath needs an orchestrator run: only the engine runs a plan")
		}
		if data.Orchestration == jarvis.Orchestration_Adaptive {
			return nil, fmt.Errorf("planpath needs the engine: an adaptive lead has no dag to run it")
		}
		plan, err := readPlanFile(data.PlanPath)
		if err != nil {
			return nil, err
		}
		if data.Goal == "" {
			data.Goal = planTitle(plan, data.PlanPath)
		}
		data.Orchestration = jarvis.Orchestration_Engine
	}
```

2. In the `if engineLaunch { switch { ... } }` block that sets `run.PlanGatePending`, add a first case:

```go
		case data.PlanPath != "":
			// the human picked this plan and saw its shape at + Run; that was the review
			gateOff := false
			run.PlanGatePending = &gateOff
```

3. Replace the block

```go
	if !data.DeferStart {
		phaseZero := 0
		appendRunEvent(ctx, data.ChannelId, run.ID, waveobj.RunEventKindPhaseStarted, &phaseZero, map[string]any{})
		if err := spawnRunWorkers(ctx, data.ChannelId, run.ID, ch.Name); err != nil {
			// the run is persisted; surface the spawn failure but return the run so the UI can show blocked/retry
			wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
			return nil, fmt.Errorf("spawning first worker: %w", err)
		}
	}
```

with

```go
	switch {
	case data.PlanPath != "":
		// the engine starts on the plan now; the lead comes at the first judgment event (spec §1, G5)
		if _, err := ws.DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: data.ChannelId, RunId: run.ID, PlanPath: data.PlanPath}); err != nil {
			// a run with no dag and no lead would wait in planning forever
			if cerr := ws.CancelRunCommand(ctx, wshrpc.CommandCancelRunData{ChannelId: data.ChannelId, RunId: run.ID}); cerr != nil {
				log.Printf("CreateRun: cancelling run %s after its plan was refused: %v", run.ID, cerr)
			}
			return nil, fmt.Errorf("submitting plan: %w", err)
		}
	case !data.DeferStart:
		phaseZero := 0
		appendRunEvent(ctx, data.ChannelId, run.ID, waveobj.RunEventKindPhaseStarted, &phaseZero, map[string]any{})
		if err := spawnRunWorkers(ctx, data.ChannelId, run.ID, ch.Name); err != nil {
			// the run is persisted; surface the spawn failure but return the run so the UI can show blocked/retry
			wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
			return nil, fmt.Errorf("spawning first worker: %w", err)
		}
	}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/wshrpc/wshserver/`
Expected: PASS, including `TestCreateRunDeferStart` and every existing `TestCreateRunCommand_*`.

---

### Task 5: Launcher model — two shapes, start from a plan file

Pure TypeScript and stores only. `tsc` is red from this task until Task 6: `runlauncher.tsx`, `newruncontrol.tsx` and `briefsheet.tsx` still import the planner exports this task removes. Vitest is the gate here.

**Files:**
- Modify: `frontend/app/view/agents/runconfig.ts`, `frontend/app/view/agents/runconfig.test.ts`
- Modify: `frontend/app/view/agents/runconfigstore.ts`, `frontend/app/view/agents/runconfigstore.test.ts`
- Modify: `frontend/app/view/jarvis/newrun.ts`, `frontend/app/view/jarvis/newrun.test.ts`
- Modify: `frontend/app/view/agents/runactions.ts` (`createRun`)
- Modify: `frontend/app/view/orchestrate/dagdigest.ts`, `frontend/app/view/orchestrate/dagdigest.test.ts`

**Interfaces:**
- Consumes: generated `CommandDagPlanPreviewRtnData`, `DagPlanShape` (Task 2); `planpath` on `CommandCreateRunData` (Task 4).
- Produces:
  - `runconfig.ts`: `type StartFrom = "goal" | "plan"`, `START_OPTIONS`, `DEFAULT_START`, `startNote(start)`, `SHAPE_CARDS` (orchestrator, quick), `runLauncherFace(shape): { showStart; showParallelism; showWorkerRoute }`, `interface PlanPreview { path; result?; error? }`, `interface LaunchBlockerInput`, `launchBlocker(input): string | null`. Removed: `Planner`, `PLANNER_OPTIONS`, `DEFAULT_PLANNER`, `plannerNote`, `machineNote`.
  - `runconfigstore.ts`: `startAtom`, `planPathAtom`, `planPreviewAtom`, `setStart(next)`, `setPlanPath(next)`. Removed: `plannerAtom`, `setPlanner`.
  - `newrun.ts`: `RunConfig { shape; parallelism; workerRoute; start; planPath }`, `LaunchOpts { mode; orchestration?; parallelism?; workerRoute?; planPath? }`, `launchOptsFromConfig(config)`, `launchGoal(config, goal)`.
  - `runactions.ts`: `createRun(..., opts?: { ...; planPath?: string })`.
  - `dagdigest.ts`: `planShapeText(shape: DagPlanShape | undefined): string | null`, `planWarnings(shape: DagPlanShape, verify: string | undefined): string[]`.

- [ ] **Step 1: Write the failing model tests**

In `frontend/app/view/agents/runconfig.test.ts`:
- Change the import list to: `DEFAULT_PARALLELISM, MAX_DAG_TASKS, MAX_PARALLELISM, SHAPE_CARDS, clampParallelism, launchBlocker, profileRunDefaults, runLauncherFace, startNote, type LaunchBlockerInput`.
- Delete the `describe("machineNote", ...)` and `describe("plannerNote", ...)` blocks.
- In `describe("shape cards")`, change the first test to:

```ts
    it("offers the two shapes a launch can start, once", () => {
        expect(SHAPE_CARDS.map((s) => s.id)).toEqual(["orchestrator", "quick"]);
    });
```

- Replace `describe("runLauncherFace", ...)` with:

```ts
describe("runLauncherFace", () => {
    it("gives the orchestrator its start, its width and its worker route", () => {
        expect(runLauncherFace("orchestrator")).toEqual({ showStart: true, showParallelism: true, showWorkerRoute: true });
    });

    // a quick run has no plan to start from and no dag children to route or widen
    it("gives quick none of them", () => {
        expect(runLauncherFace("quick")).toEqual({ showStart: false, showParallelism: false, showWorkerRoute: false });
    });
});

describe("startNote", () => {
    // a plan start runs with no lead, and a user not told when one appears reads that as a broken launch
    it("tells a plan start when a lead appears", () => {
        expect(startNote("plan")).toMatch(/judgment/);
        expect(startNote("goal")).toMatch(/lead/);
    });
});

describe("launchBlocker", () => {
    const ready = { title: "Coupons", shape: { tasks: 2, lanes: 1, longestchain: 2 } } as CommandDagPlanPreviewRtnData;
    const input = (over: Partial<LaunchBlockerInput>): LaunchBlockerInput => ({
        shape: "orchestrator",
        start: "goal",
        goal: "",
        planPath: "",
        preview: null,
        ...over,
    });

    it("needs a goal to start from a goal", () => {
        expect(launchBlocker(input({}))).toBe("Write the goal");
        expect(launchBlocker(input({ goal: "ship coupons" }))).toBeNull();
    });

    it("needs no goal to start from a plan it has read", () => {
        expect(launchBlocker(input({ start: "plan", planPath: "/p.md", preview: { path: "/p.md", result: ready } }))).toBeNull();
    });

    it("holds a plan start until the preview has read this exact path", () => {
        expect(launchBlocker(input({ start: "plan", planPath: "  " }))).toBe("Give the plan's absolute path");
        expect(launchBlocker(input({ start: "plan", planPath: "/p.md" }))).toBe("Reading the plan…");
        expect(
            launchBlocker(input({ start: "plan", planPath: "/new.md", preview: { path: "/p.md", result: ready } }))
        ).toBe("Reading the plan…");
    });

    it("blocks on the parser's message", () => {
        expect(
            launchBlocker(input({ start: "plan", planPath: "/p.md", preview: { path: "/p.md", error: "plan has no tasks" } }))
        ).toBe("plan has no tasks");
    });

    it("ignores a plan start left over on quick, which has no plan", () => {
        expect(launchBlocker(input({ shape: "quick", start: "plan", goal: "fix the flake" }))).toBeNull();
    });
});
```

- In `describe("profileRunDefaults")`, replace the test `"maps the pipeline default and the adaptive machine"` with:

```ts
    // + Run no longer offers pipeline, so a stored pipeline default has no card to land on
    it("leaves a pipeline default to the launcher's baseline, and still maps the machine", () => {
        const got = profileRunDefaults({ playbook: [], defaultmode: "pipeline", machine: "adaptive" } as JarvisProfile);
        expect(got.shape).toBeNull();
        expect(got.orchestration).toBe("adaptive");
    });
```

In `frontend/app/view/jarvis/newrun.test.ts`, change the imports to `launchGoal, launchOptsFromConfig, rankProjects, resolveChannelTarget, stepPick` and replace `describe("launchOptsFromConfig", ...)` with:

```ts
describe("launchOptsFromConfig", () => {
    const base: RunConfig = { shape: "quick", parallelism: 3, workerRoute: null, start: "goal", planPath: "" };
    const workerRoute: RoutePin = { runtime: "claude" };

    it("names the mode rather than leaving the server to default it to quick", () => {
        expect(launchOptsFromConfig(base)).toEqual({ mode: "quick" });
    });

    it("drops every orchestrator dial from quick", () => {
        expect(launchOptsFromConfig({ ...base, parallelism: 6, workerRoute, start: "plan", planPath: "/p.md" })).toEqual({
            mode: "quick",
        });
    });

    // spec §1: + Run has two shapes, and its orchestrator is the engine
    it("always launches an orchestrator on the engine, with its width and worker route", () => {
        expect(launchOptsFromConfig({ ...base, shape: "orchestrator", parallelism: 4, workerRoute })).toEqual({
            mode: "orchestrator",
            orchestration: "engine",
            parallelism: 4,
            workerRoute,
        });
    });

    it("omits a worker route the launcher left inheriting the lead", () => {
        expect(launchOptsFromConfig({ ...base, shape: "orchestrator", parallelism: 2 })).toEqual({
            mode: "orchestrator",
            orchestration: "engine",
            parallelism: 2,
        });
    });

    it("sends the trimmed plan path for a plan start", () => {
        expect(launchOptsFromConfig({ ...base, shape: "orchestrator", start: "plan", planPath: "  /repo/plan.md " })).toEqual({
            mode: "orchestrator",
            orchestration: "engine",
            parallelism: 3,
            planPath: "/repo/plan.md",
        });
    });

    it("sends no plan path for a goal start, even with one typed", () => {
        expect(launchOptsFromConfig({ ...base, shape: "orchestrator", planPath: "/repo/plan.md" })).not.toHaveProperty("planPath");
    });
});

describe("launchGoal", () => {
    it("sends the trimmed goal", () => {
        expect(launchGoal({ shape: "quick", start: "plan" }, "  fix the flake ")).toBe("fix the flake");
        expect(launchGoal({ shape: "orchestrator", start: "goal" }, " ship it ")).toBe("ship it");
    });

    // the goal field is hidden for a plan start, so a goal typed before switching must not name the run
    it("sends none for a plan start, which the run's plan names", () => {
        expect(launchGoal({ shape: "orchestrator", start: "plan" }, "an old goal")).toBe("");
    });
});
```

In `frontend/app/view/agents/runconfigstore.test.ts`, add `planPathAtom, planPreviewAtom, setPlanPath, setStart, startAtom` to the `./runconfigstore` import, and append:

```ts
describe("plan start", () => {
    it("is a choice the user made, so a profile arriving does not replace it", () => {
        setStart("plan");
        setPlanPath("/repo/plan.md");
        hydrateRunConfigFromProfile({ playbook: [], defaultmode: "orchestrator" } as JarvisProfile);
        expect(globalStore.get(configTouchedAtom)).toBe(true);
        expect(globalStore.get(startAtom)).toBe("plan");
        expect(globalStore.get(planPathAtom)).toBe("/repo/plan.md");
    });

    // a plan file belongs to one launch; the next draft starts from a goal again
    it("ends with the draft", () => {
        setStart("plan");
        setPlanPath("/repo/plan.md");
        endRunConfigDraft(null);
        expect(globalStore.get(startAtom)).toBe("goal");
        expect(globalStore.get(planPathAtom)).toBe("");
    });

    it("resets with the rest of the configuration", () => {
        setStart("plan");
        setPlanPath("/repo/plan.md");
        globalStore.set(planPreviewAtom, { path: "/repo/plan.md", error: "plan has no tasks" });
        resetRunConfig();
        expect(globalStore.get(startAtom)).toBe("goal");
        expect(globalStore.get(planPathAtom)).toBe("");
        expect(globalStore.get(planPreviewAtom)).toBeNull();
    });
});
```

In `frontend/app/view/orchestrate/dagdigest.test.ts`, add `planShapeText, planWarnings` to the `./dagdigest` import, and append:

```ts
describe("planShapeText", () => {
    it("reads tasks, lanes and the longest chain", () => {
        expect(planShapeText({ tasks: 5, lanes: 2, longestchain: 3 })).toBe("5 tasks · 2 lanes · longest chain 3");
        expect(planShapeText({ tasks: 1, lanes: 1, longestchain: 1 })).toBe("1 task · 1 lane · longest chain 1");
    });

    it("says nothing for a digest that carries no shape", () => {
        expect(planShapeText(undefined)).toBeNull();
        expect(planShapeText({ tasks: 0, lanes: 0, longestchain: 0 })).toBeNull();
    });
});

describe("planWarnings", () => {
    it("calls a multi-task plan that runs in one lane serial", () => {
        expect(planWarnings({ tasks: 3, lanes: 1, longestchain: 3 }, "task test")).toEqual(["serial"]);
    });

    it("does not call a one-task plan serial", () => {
        expect(planWarnings({ tasks: 1, lanes: 1, longestchain: 1 }, "task test")).toEqual([]);
    });

    it("calls a plan with no Verify line unverified", () => {
        expect(planWarnings({ tasks: 3, lanes: 3, longestchain: 1 }, "")).toEqual(["unverified"]);
        expect(planWarnings({ tasks: 3, lanes: 3, longestchain: 1 }, undefined)).toEqual(["unverified"]);
    });

    it("says both for a plan with neither", () => {
        expect(planWarnings({ tasks: 3, lanes: 1, longestchain: 3 }, "")).toEqual(["serial", "unverified"]);
    });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run frontend/app/view/agents/runconfig.test.ts frontend/app/view/agents/runconfigstore.test.ts frontend/app/view/jarvis/newrun.test.ts frontend/app/view/orchestrate/dagdigest.test.ts`
Expected: FAIL — the new exports are undefined (`launchBlocker is not a function`, `setStart is not a function`, `launchGoal is not a function`, `planShapeText is not a function`).

- [ ] **Step 3: Implement `runconfig.ts`**

In `frontend/app/view/agents/runconfig.ts`:

1. Replace everything from `// Who writes the DAG.` through the end of `plannerNote` with:

```ts
// Where an orchestrator starts. A goal gets a lead that works it with you and hands the engine a plan; a plan
// file skips that turn, because a plan you already wrote does not need a lead to transcribe it.
export type StartFrom = "goal" | "plan";
export const START_OPTIONS: StartFrom[] = ["goal", "plan"];
export const DEFAULT_START: StartFrom = "goal";

// Said in full because a plan start runs with no lead, and a user who is not told when one appears reads its
// absence as a broken launch.
export function startNote(start: StartFrom): string {
    return start === "goal"
        ? "A lead works the goal with you in its terminal, then hands the engine a plan."
        : "The engine runs the plan now. A lead starts only if something needs judgment: a question, a failure, a hung worker, a conflict or a failed Verify.";
}
```

2. Replace the `SHAPE_CARDS` comment and array with:

```ts
// The descriptions say what the machine does, not what the word means. Pipeline is not offered: slice 5c of
// the orchestrator redesign deletes it, and + Run stops starting it first.
export const SHAPE_CARDS: ShapeCard[] = [
    { id: "orchestrator", desc: "A lead and the engine: from a goal you shape together, or from your plan file." },
    { id: "quick", desc: "One worker, no lead, no plan. It stops and asks if the goal turns out bigger." },
];
```

3. Delete `machineNote` and its comment.
4. In `profileRunDefaults`, change the shape line to:

```ts
        // a pipeline default has no card to land on, so it leaves the launcher's baseline standing
        shape: mode === "quick" || mode === "orchestrator" ? mode : null,
```

5. Replace `RunLauncherFace` and `runLauncherFace` (with their comments) with:

```ts
export interface RunLauncherFace {
    showStart: boolean;
    showParallelism: boolean;
    showWorkerRoute: boolean;
}

// The start, the width and the worker route belong to the orchestrator: parallelism and WorkerRoute are read
// only when the engine spawns dag children, and a quick run has no plan to start from.
export function runLauncherFace(shape: RunShape): RunLauncherFace {
    const orchestrator = shape === "orchestrator";
    return { showStart: orchestrator, showParallelism: orchestrator, showWorkerRoute: orchestrator };
}

// PlanPreview is the launcher's last reading of a plan path: its parsed shape, or the parser's refusal.
export interface PlanPreview {
    path: string;
    result?: CommandDagPlanPreviewRtnData;
    error?: string;
}

export interface LaunchBlockerInput {
    shape: RunShape;
    start: StartFrom;
    goal: string;
    planPath: string;
    preview: PlanPreview | null;
}

// launchBlocker says why a launch cannot start yet, or null when it can. A plan start waits for a preview of
// the exact path it will send, so a plan that will not parse is refused before anything is created.
export function launchBlocker(input: LaunchBlockerInput): string | null {
    if (input.shape === "orchestrator" && input.start === "plan") {
        const path = input.planPath.trim();
        if (path === "") {
            return "Give the plan's absolute path";
        }
        if (input.preview == null || input.preview.path !== path) {
            return "Reading the plan…";
        }
        return input.preview.error ?? null;
    }
    return input.goal.trim() === "" ? "Write the goal" : null;
}
```

The `Orchestration` import stays: `ProfileRunDefaults` still carries the machine for the cockpit composer until 5c.

- [ ] **Step 4: Implement the stores**

In `frontend/app/view/agents/runconfigstore.ts`:

1. Change the `./runconfig` import to:

```ts
import {
    DEFAULT_PARALLELISM,
    DEFAULT_START,
    clampParallelism,
    profileRunDefaults,
    type PlanPreview,
    type StartFrom,
} from "./runconfig";
```

2. Replace the `plannerAtom` declaration and its comment with:

```ts
// Not profile-backed: a plan file belongs to one launch, never to a project's defaults, and a saved default
// that silently started lead-free runs is not a default anyone asked for.
export const startAtom = atom<StartFrom>(DEFAULT_START) as PrimitiveAtom<StartFrom>;
export const planPathAtom = atom<string>("") as PrimitiveAtom<string>;
// The launcher's last reading of planPathAtom; launchBlocker holds a plan start until it matches the path.
export const planPreviewAtom = atom<PlanPreview | null>(null) as PrimitiveAtom<PlanPreview | null>;
```

3. Replace `setPlanner` with:

```ts
export function setStart(next: StartFrom): void {
    globalStore.set(configTouchedAtom, true);
    globalStore.set(startAtom, next);
}

export function setPlanPath(next: string): void {
    globalStore.set(configTouchedAtom, true);
    globalStore.set(planPathAtom, next);
}
```

4. In `hydrateRunConfigFromProfile`, replace `globalStore.set(plannerAtom, DEFAULT_PLANNER);` with:

```ts
    globalStore.set(startAtom, DEFAULT_START);
    globalStore.set(planPathAtom, "");
```

5. In `resetRunConfig`, replace `globalStore.set(plannerAtom, DEFAULT_PLANNER);` with:

```ts
    globalStore.set(startAtom, DEFAULT_START);
    globalStore.set(planPathAtom, "");
    globalStore.set(planPreviewAtom, null);
```

- [ ] **Step 5: Implement the launch translation and `createRun`**

In `frontend/app/view/jarvis/newrun.ts`:

1. Replace the imports `import type { Orchestration } from "@/app/view/agents/orchestratorpicker";` and `import type { Planner } from "@/app/view/agents/runconfig";` with `import type { StartFrom } from "@/app/view/agents/runconfig";`.
2. Replace `RunConfig`, `LaunchOpts` and `launchOptsFromConfig` (with its comment) with:

```ts
export interface RunConfig {
    shape: RunShape;
    parallelism: number;
    workerRoute: RoutePin | null;
    start: StartFrom;
    planPath: string;
}

export interface LaunchOpts {
    mode: string;
    orchestration?: string;
    parallelism?: number;
    workerRoute?: RoutePin;
    planPath?: string;
}

// What the launcher's controls mean as CreateRun's arguments. The mode cannot simply be omitted: the server
// reads an unset mode as `quick` (resolveRunPlan). + Run's orchestrator is the engine (spec §1); the adaptive
// lead stays reachable only from the cockpit composer until slice 5c deletes it.
export function launchOptsFromConfig(config: RunConfig): LaunchOpts {
    const { shape, parallelism, workerRoute, start, planPath } = config;
    if (shape !== "orchestrator") {
        return { mode: shape };
    }
    return {
        mode: shape,
        orchestration: "engine",
        parallelism,
        ...(workerRoute != null ? { workerRoute } : {}),
        ...(start === "plan" ? { planPath: planPath.trim() } : {}),
    };
}

// The goal a launch sends. A plan start sends none: the server names the run by its plan, and a goal typed
// before switching to the plan is hidden, so it must not name a run the user can no longer see it on.
export function launchGoal(config: Pick<RunConfig, "shape" | "start">, goal: string): string {
    return config.shape === "orchestrator" && config.start === "plan" ? "" : goal.trim();
}
```

In `frontend/app/view/agents/runactions.ts`, `createRun`: add `planPath?: string;` to the `opts` type, and add after the `parallelism` spread:

```ts
        ...(opts?.mode === "orchestrator" && opts.planPath ? { planpath: opts.planPath } : {}),
```

- [ ] **Step 6: Implement the plan-shape text**

In `frontend/app/view/orchestrate/dagdigest.ts`, add after `reportChips`:

```ts
function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// planShapeText is how a plan reads before and after it starts: how much work, how many lanes it runs in,
// and the longest chain of tasks that wait on one another. Go computes the numbers (PlanShapeOf), so + Run
// and the run card cannot disagree about a plan's lanes.
export function planShapeText(shape: DagPlanShape | undefined): string | null {
    if (shape == null || shape.tasks === 0) {
        return null;
    }
    return `${plural(shape.tasks, "task")} · ${plural(shape.lanes, "lane")} · longest chain ${shape.longestchain}`;
}

// planWarnings names the two things a hand-written plan most often leaves out (spec §1): dependencies, so
// every task queues in one lane, and a Verify line, so nothing is tested where lanes merge.
export function planWarnings(shape: DagPlanShape, verify: string | undefined): string[] {
    const out: string[] = [];
    if (shape.lanes === 1 && shape.tasks > 1) {
        out.push("serial");
    }
    if (!verify) {
        out.push("unverified");
    }
    return out;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/runconfig.test.ts frontend/app/view/agents/runconfigstore.test.ts frontend/app/view/jarvis/newrun.test.ts frontend/app/view/orchestrate/dagdigest.test.ts frontend/app/view/orchestrate/plangate.test.ts`
Expected: PASS. `plangate.test.ts` is included because `plangate.ts` imports `MAX_DAG_TASKS` from `runconfig.ts`.

---

### Task 6: Launcher views, the + Run modal, the sheet's goal row, the run card

No render tests (the repo's no-jsdom rule): the logic these views need was extracted and tested in Task 5. The gate here is `tsc`, the full vitest suite, eslint on touched files, and Task 7's live check.

**Files:**
- Modify: `frontend/app/view/agents/runlauncher.tsx`
- Modify: `frontend/app/view/jarvis/newruncontrol.tsx`
- Modify: `frontend/app/view/jarvis/briefsheet.tsx` (`ChannelLaunch`, lines 83-206, and its imports)
- Modify: `frontend/app/view/orchestrate/dagoverview.tsx`

**Interfaces:**
- Consumes: everything Task 5 produces; `RpcApi.DagPlanPreviewCommand` (Task 2).
- Produces: DOM hooks for the live check — `data-jarvis-plan-path` (the path input), `data-jarvis-plan-preview="ready" | "error"` (the preview line).

- [ ] **Step 1: The launcher**

In `frontend/app/view/agents/runlauncher.tsx`:

1. In the header comment, change `shape, which machine fans out, how wide, and the two routes` to `shape, where an orchestrator starts, how wide, and the two routes`.
2. Replace the imports (from `import { cn } from "@/util/util";` through the closing `} from "./runconfigstore";`) with:

```tsx
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { planShapeText, planWarnings } from "../orchestrate/dagdigest";
import { RoutePicker } from "./routepicker";
import {
    MAX_DAG_TASKS,
    MAX_PARALLELISM,
    SHAPE_CARDS,
    START_OPTIONS,
    runLauncherFace,
    startNote,
    type StartFrom,
} from "./runconfig";
import {
    parallelismAtom,
    planPathAtom,
    planPreviewAtom,
    routeOpenRequestAtom,
    runRouteAtom,
    runShapeAtom,
    setPlanPath,
    setRunRoute,
    setRunShape,
    setStart,
    setWorkerRoute,
    startAtom,
    stepParallelism,
    workerRouteAtom,
} from "./runconfigstore";
```

3. In the `pickTone` comment, change `so the shape and the machine read as the same kind of choice` to `so the shape and the start read as the same kind of choice`.
4. In `ShapeCards`, change the comment's `the three shapes` to `the two shapes`, and `grid-cols-3` to `grid-cols-2`.
5. Delete `MachineCards`, the `// Who drafts the DAG.` comment, `PLANNER_LABEL` and `PlannerCards`. Put in their place:

```tsx
const START_LABEL: Record<StartFrom, string> = { goal: "A goal", plan: "A plan file" };

// Where an orchestrator starts. It sits under the shape because it decides whether a lead runs at all: a plan
// file hands the engine work you already decomposed, and a lead appears only when something needs judgment.
function StartSection() {
    const start = useAtomValue(startAtom);
    return (
        <Section label="Start from">
            <div className="flex gap-2">
                {START_OPTIONS.map((option) => (
                    <button
                        key={option}
                        type="button"
                        aria-pressed={start === option}
                        onClick={() => setStart(option)}
                        className={cn(
                            "cursor-pointer rounded-[7px] border px-3 py-1.5 font-mono text-[11.5px] font-semibold",
                            pickTone(start === option)
                        )}
                    >
                        {START_LABEL[option]}
                    </button>
                ))}
            </div>
            <span className="text-[11px] leading-[1.45] text-muted">{startNote(start)}</span>
            {start === "plan" ? <PlanPathField /> : null}
        </Section>
    );
}

// lets a typed or pasted path finish arriving before wavesrv reads the file
const PLAN_PREVIEW_DELAY_MS = 300;

// The plan is parsed here, before anything is created (spec §1): a plan that will not run shows the parser's
// message and holds the start, and one that will shows the shape the engine is about to run.
function PlanPathField() {
    const path = useAtomValue(planPathAtom);
    const preview = useAtomValue(planPreviewAtom);
    useEffect(() => {
        const trimmed = path.trim();
        if (trimmed === "") {
            globalStore.set(planPreviewAtom, null);
            return;
        }
        let live = true;
        const timer = setTimeout(() => {
            RpcApi.DagPlanPreviewCommand(TabRpcClient, { planpath: trimmed })
                .then((result) => {
                    if (live) {
                        globalStore.set(planPreviewAtom, { path: trimmed, result });
                    }
                })
                .catch((e) => {
                    if (live) {
                        globalStore.set(planPreviewAtom, {
                            path: trimmed,
                            error: e instanceof Error ? e.message : String(e),
                        });
                    }
                });
        }, PLAN_PREVIEW_DELAY_MS);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [path]);
    const current = preview != null && preview.path === path.trim() ? preview : null;
    return (
        <div className="flex flex-col gap-1">
            <input
                data-jarvis-plan-path
                value={path}
                aria-label="Plan file path"
                onChange={(e) => setPlanPath(e.target.value)}
                placeholder="Absolute path to the plan"
                className="w-full rounded-[7px] border border-edge-mid bg-background px-2.5 py-1.5 font-mono text-[11.5px] text-primary placeholder:text-muted outline-none focus:border-accent/60"
            />
            {current?.error != null ? (
                <span data-jarvis-plan-preview="error" className="text-[11px] leading-[1.45] text-error">
                    {current.error}
                </span>
            ) : current?.result != null ? (
                <span
                    data-jarvis-plan-preview="ready"
                    className="flex flex-wrap gap-x-2 font-mono text-[10.5px] text-secondary"
                >
                    {current.result.title ? <span>{current.result.title}</span> : null}
                    <span>{planShapeText(current.result.shape)}</span>
                    {planWarnings(current.result.shape, current.result.verify).map((warning) => (
                        <span key={warning} className="text-warning">
                            {warning}
                        </span>
                    ))}
                </span>
            ) : null}
        </div>
    );
}
```

6. Replace the body of `RunLauncherSections` with:

```tsx
    const shape = useAtomValue(runShapeAtom);
    const face = runLauncherFace(shape);
    return (
        <>
            <ShapeCards />
            {face.showStart ? <StartSection /> : null}
            {face.showParallelism ? <ParallelismStepper /> : null}
            <RoutingSection showWorkerRoute={face.showWorkerRoute} />
        </>
    );
```

- [ ] **Step 2: The + Run modal**

In `frontend/app/view/jarvis/newruncontrol.tsx`:

1. In the `../agents/runconfigstore` import, remove `orchestrationAtom` and `plannerAtom`, and add `planPathAtom`, `planPreviewAtom` and `startAtom` (keep the list alphabetical).
2. Add `import { launchBlocker } from "../agents/runconfig";` after the `../agents/projectsstore` import, and change the `./newrun` import to `import { launchGoal, launchOptsFromConfig, rankProjects, resolveChannelTarget, stepPick } from "./newrun";`.
3. In `NewRunModal`, delete `const orchestration = useAtomValue(orchestrationAtom);` and replace `const planner = useAtomValue(plannerAtom);` with:

```tsx
    const startFrom = useAtomValue(startAtom);
    const planPath = useAtomValue(planPathAtom);
    const preview = useAtomValue(planPreviewAtom);
```

4. Directly after the `const rows = rankProjects(...)` statement, add:

```tsx
    const config = { shape, parallelism, workerRoute, start: startFrom, planPath };
    // a plan start is named by its plan, so it has no goal field to fill
    const planStart = shape === "orchestrator" && startFrom === "plan";
    const blocker = launchBlocker({ shape, start: startFrom, goal, planPath, preview });
```

5. In `start`, replace

```tsx
        const text = goal.trim();
        if (picked == null || text === "" || starting) {
```

with

```tsx
        if (picked == null || blocker != null || starting) {
```

and replace the `createRun(...)` call with:

```tsx
                const run = await createRun(oid, launchGoal(config, goal), route, launchOptsFromConfig(config));
```

6. Wrap the Goal field's `<div className="flex flex-col gap-1">…</div>` (the one holding `<span className={FIELD_LABEL}>Goal</span>` and the textarea) as `{planStart ? null : ( …that div… )}`.
7. In the footer, change `{picked == null ? "pick a project" : `${shape} in ${picked}`}` to:

```tsx
                                {picked == null
                                    ? "pick a project"
                                    : planStart && blocker != null
                                      ? blocker
                                      : `${shape} in ${picked}`}
```

8. On the Start button, change `disabled={picked == null || goal.trim() === "" || starting}` to `disabled={picked == null || blocker != null || starting}`.

- [ ] **Step 3: The sheet's goal row**

In `frontend/app/view/jarvis/briefsheet.tsx`:

1. In the `@/app/view/agents/runconfigstore` import, remove `orchestrationAtom` and `plannerAtom`, and add `planPathAtom`, `planPreviewAtom` and `startAtom` (alphabetical).
2. Add `import { launchBlocker } from "@/app/view/agents/runconfig";` after the `@/app/view/agents/runbody` import, and change `import { launchOptsFromConfig } from "./newrun";` to `import { launchGoal, launchOptsFromConfig } from "./newrun";`.
3. In `ChannelLaunch`, delete `const orchestration = useAtomValue(orchestrationAtom);` and replace `const planner = useAtomValue(plannerAtom);` with:

```tsx
    const startFrom = useAtomValue(startAtom);
    const planPath = useAtomValue(planPathAtom);
    const preview = useAtomValue(planPreviewAtom);
```

4. Directly after `const value = radarDraft != null ? radarDraft.goal : goal;`, add:

```tsx
    const config = { shape, parallelism, workerRoute, start: startFrom, planPath };
    const planStart = shape === "orchestrator" && startFrom === "plan";
    const blocker = launchBlocker({ shape, start: startFrom, goal: value, planPath, preview });
```

5. In `launch`, replace

```tsx
        const text = value.trim();
        if (text === "" || runRoute == null || launching) {
```

with

```tsx
        if (blocker != null || runRoute == null || launching) {
```

and replace

```tsx
                const created = await createRun(channelId, text, runRoute, {
                    ...launchOptsFromConfig({ shape, orchestration, parallelism, workerRoute, planner }),
```

with

```tsx
                const created = await createRun(channelId, launchGoal(config, value), runRoute, {
                    ...launchOptsFromConfig(config),
```

6. On the `data-jarvis-launch-goal` input, change `value={value}` to `value={planStart ? "" : value}`, `disabled={launching}` to `disabled={launching || planStart}`, and `placeholder="What should it do?"` to `placeholder={planStart ? "Starts from the plan above" : "What should it do?"}`.
7. On the `Run ⏎` button, change `disabled={launching || value.trim() === "" || runRoute == null}` to `disabled={launching || blocker != null || runRoute == null}`.
8. In the help line under the row, change the last branch `: "The shape and machine above are what this dispatches with."` to:

```tsx
                      : planStart && blocker != null
                        ? blocker
                        : "The shape and start above are what this dispatches with."
```

- [ ] **Step 4: The run card's plan shape**

In `frontend/app/view/orchestrate/dagoverview.tsx`:

1. Add `planShapeText,` to the `./dagdigest` import, between `nextStepView,` and `reportChips,`.
2. After `const elapsed = counts ? digest?.durations?.elapsedms : undefined;`, add:

```tsx
    // spec §1: a goal run's plan shape appears once its dag is submitted, and a plan-path run's from the start
    const shapeText = counts ? planShapeText(digest?.shape) : null;
```

3. In the health strip, directly after `<span>{counts ? `${counts.done}/${counts.total} done` : "…"}</span>`, add:

```tsx
                    {shapeText ? <span>{shapeText}</span> : null}
```

- [ ] **Step 5: Verify**

Run: `grep -rn "plannerAtom\|plannerNote\|machineNote\|PLANNER_OPTIONS\|DEFAULT_PLANNER\|setPlanner\|showPlanner\|showMachine" frontend`
Expected: no output.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run`
Expected: PASS (the suite stood at 2857 passed / 2 skipped at B5; the count grows by this slice's new tests).

Run: `npx eslint frontend/app/view/agents/runlauncher.tsx frontend/app/view/agents/runconfig.ts frontend/app/view/agents/runconfigstore.ts frontend/app/view/agents/runactions.ts frontend/app/view/agents/runtimeline.ts frontend/app/view/jarvis/newruncontrol.tsx frontend/app/view/jarvis/newrun.ts frontend/app/view/jarvis/briefsheet.tsx frontend/app/view/orchestrate/dagoverview.tsx frontend/app/view/orchestrate/dagdigest.ts`
Expected: no errors on lines this slice changed. Some of these files are not eslint-clean at HEAD; a finding on a line you did not touch (check with `git diff -U0 <file>`) is pre-existing, is left alone, and is named in the effort note rather than called clean.

---

### Task 7: Docs, full verification, live check, commit

**Files:**
- Modify: `docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md`
- Modify: `CLAUDE.md`
- Modify: `docs/orchestrator-howto.md`

- [ ] **Step 1: Spec edits**

In `docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md`:

1. Status line: replace `and 4d from \`docs/superpowers/plans/2026-09-15-orchestrator-redesign-s4d-lanes.md\`.` with:

```markdown
and 4d from `docs/superpowers/plans/2026-09-15-orchestrator-redesign-s4d-lanes.md`. Slice 5a is built (117b4272) from `docs/superpowers/plans/2026-09-15-orchestrator-redesign-s5a-lead-prompt-compaction.md`, and 5b from `docs/superpowers/plans/2026-09-15-orchestrator-redesign-s5b-run-shapes-plan-start.md`.
```

2. §1, "Orchestrator from a plan path (G5)": after the bullet that ends `Then the engine launches the lead with the orchestration rules as its launch prompt, followed by the wake message.`, add:

```markdown
  - The wake message is the end of the launch prompt, not typed after the lead's first turn.
- A clean finish launches no lead (decided 2026-09-15, slice 5b). When every lane lands and verifies with nothing to decide, nobody has a judgment to make: the engine closes the run and seals its evidence itself, and the run card carries the report numbers.
```

3. §2, "Judgment events": directly before the paragraph starting `Two new wsh subcommands,`, add:

```markdown
Run finished wakes a lead that exists. For a plan-input run with no lead yet, it launches nothing (§1).
```

4. §13, item 5b: replace `the lead launched at the first judgment event with the 5a orchestration rules (G5). Plan.` with:

```markdown
the lead launched at the first judgment event with the 5a orchestration rules (G5). Plan: `docs/superpowers/plans/2026-09-15-orchestrator-redesign-s5b-run-shapes-plan-start.md`. + Run also drops its machine toggle and its "Who plans" control here; their code goes with 5c.
```

- [ ] **Step 2: `CLAUDE.md` plan-format rule (spec §3)**

In `CLAUDE.md`, "## Design docs", add after the `docs/agents/` bullet:

```markdown
- **Plans the engine runs** (`wsh jarvis dag submit --plan`, or + Run → Orchestrator → A plan file) follow `jarvis.PlanFormat` (`pkg/jarvis/plan.go`): optional `**Verify:**` and `**Setup:**` commands in backticks before the first task; `### Task N: <title>` (or `##`) headings numbered 1, 2, 3…; and, as a task's first line, an optional `**Depends on:**` — `none`, or `Task 1, Task 3`; left out, the task runs after the previous one, so a plan with no Depends lines is serial.
```

- [ ] **Step 3: How-to edits**

In `docs/orchestrator-howto.md`:

1. Replace the table row

```markdown
| Shape | Orchestrator | Pipeline is phases in order, one worker each. Quick is one worker, no plan. Only Orchestrator fans out. |
| Who fans out | Engine | See Phase 0.3. Parallelism and the worker route only exist for Engine (`runLauncherFace`, `runconfig.ts:78`). |
```

with

```markdown
| Shape | Orchestrator | Quick is one worker, no lead, no plan. Only Orchestrator fans out. |
| Start from | A goal | A goal gets a lead that brainstorms it with you. A plan file starts the engine at once, and a lead appears only when something needs judgment (`runLauncherFace`, `runconfig.ts`). |
```

2. In playbook item 17, replace from `Pick **You** under *Who plans* in the launcher` through `` `wsh jarvis dag submit --file <path> --channel <id> --runid <id>`. `` with:

```markdown
Write the plan in `jarvis.PlanFormat` instead and pick **Orchestrator → A plan file** in + Run: it parses the plan and shows its shape before start, the engine runs it at once, and a lead starts only if something needs judgment.
```

- [ ] **Step 4: Full verification**

From PowerShell at the repo root, with the CGO flags set:

```powershell
task generate
go build ./cmd/server/ ./cmd/wsh/
go vet ./pkg/jarvis/ ./pkg/orchestrate/ ./pkg/wshrpc/wshserver/
go test ./pkg/jarvis/ ./pkg/orchestrate/ ./pkg/waveobj/ ./pkg/wshrpc/... ./cmd/wsh/...
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
```

Expected: every command exits 0, and `task generate` leaves no diff beyond what Tasks 2 and 4 generated.

Formatting, on your files only: `gofmt -d` on each touched `.go` file prints nothing for your hunks, and `npx prettier --check` on each touched `.ts`/`.tsx` file passes (or fails only on lines you did not write — check with `git diff`).

Record every result, including anything red and why, for the effort note in Step 6.

- [ ] **Step 5: Live check — acceptance 3 in miniature**

Ask the owner before rebuilding the backend and restarting the dev app. Then `task build:backend` and restart `task dev`. For CDP probes, pin the viewport to 1600x950 first (the real dev window hides row labels).

Setup: a scratch git repo with one commit, registered as a project (+ Run's "Register a project", or the S4 live check's scratch project if still registered). Write three plans in it:

`plan-clean.md`:

```markdown
# S5b clean plan

**Verify:** `git status --short`

### Task 1: a
**Depends on:** none
Create a.txt containing "a". Commit it.

### Task 2: b
**Depends on:** none
Create b.txt containing "b". Commit it.
```

`plan-serial.md` (no Depends, no Verify):

```markdown
# S5b serial plan

### Task 1: a
Create a.txt containing "a". Commit it.

### Task 2: b
Create b.txt containing "b". Commit it.
```

`plan-verify-fails.md`:

```markdown
# S5b failing Verify

**Verify:** `git rev-parse --verify refs/heads/no-such-branch`

### Task 1: c
Create c.txt containing "c". Commit it.
```

Check, in + Run (Orchestrator → A plan file), recording a screenshot of each:

1. A relative path, then a prose file: the preview shows the parser's message in `data-jarvis-plan-preview="error"` and Start run is disabled.
2. `plan-serial.md`: the preview reads `S5b serial plan · 2 tasks · 1 lane · longest chain 2` with `serial` and `unverified`.
3. `plan-clean.md`, started: the run card's strip shows `2 tasks · 2 lanes · longest chain 1`; both lanes merge and Verify passes; the run ends done with sealed evidence; its timeline has no `Lead started` and no `Lead wake failed` row; no lead tab ever joins the roster.
4. `plan-verify-fails.md`, started: after the merge, the timeline shows `Verify failed`, then `Lead started` whose text is the `wake: Verify failed after merging task t-1 (…)` line; a lead tab appears whose terminal opens on the orchestration rules followed by that wake, and the lead runs `wsh jarvis dag status`. Cancel the run once that is seen.
5. + Run shape cards show Orchestrator and Quick only, and Quick shows no Start from, Parallelism or Workers model.

- [ ] **Step 6: Effort tracker**

```bash
wsh effort chunk status aeabb4ad-a19c-4f5d-bba2-44586b73af16 "S5b + Run shapes + plan-path start - Quick/Orchestrator, plan-path parse preview, submit at run start, lead at first judgment event (plan)" done --note "<commit sha> <date>: what landed, the Step 4 results, the Step 5 live results by number, and anything not verified>"
```

Leave "Live acceptance 1-3" pending; this live check is its item 3 in miniature, not the acceptance run.

- [ ] **Step 7: Commit**

Run `git status --short`. Stage only:

```text
CLAUDE.md
cmd/server/main-server.go
docs/orchestrator-howto.md
docs/superpowers/plans/2026-09-15-orchestrator-redesign-s5b-run-shapes-plan-start.md
docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md
frontend/app/store/wshclientapi.ts
frontend/types/gotypes.d.ts
frontend/app/view/agents/runactions.ts
frontend/app/view/agents/runconfig.ts
frontend/app/view/agents/runconfig.test.ts
frontend/app/view/agents/runconfigstore.ts
frontend/app/view/agents/runconfigstore.test.ts
frontend/app/view/agents/runlauncher.tsx
frontend/app/view/agents/runtimeline.ts
frontend/app/view/agents/runtimeline.test.ts
frontend/app/view/jarvis/briefsheet.tsx
frontend/app/view/jarvis/newrun.ts
frontend/app/view/jarvis/newrun.test.ts
frontend/app/view/jarvis/newruncontrol.tsx
frontend/app/view/orchestrate/dagdigest.ts
frontend/app/view/orchestrate/dagdigest.test.ts
frontend/app/view/orchestrate/dagoverview.tsx
pkg/jarvis/leadprompt.go
pkg/jarvis/leadprompt_test.go
pkg/jarvis/run.go
pkg/jarvis/run_test.go
pkg/jarvis/runexec.go
pkg/jarvis/runexec_test.go
pkg/orchestrate/digest.go
pkg/orchestrate/digestlane_test.go
pkg/orchestrate/wake.go
pkg/orchestrate/wake_test.go
pkg/waveobj/runevent.go
pkg/wshrpc/wshrpctypes_dag.go
pkg/wshrpc/wshrpctypes_runs.go
pkg/wshrpc/wshserver/wshserver_dag.go
pkg/wshrpc/wshserver/wshserver_dagplan_test.go
pkg/wshrpc/wshserver/wshserver_planlead_test.go
pkg/wshrpc/wshserver/wshserver_planstart_test.go
pkg/wshrpc/wshserver/wshserver_runs.go
```

plus the generated Go client if `task generate` changed it (`git status` shows `pkg/wshrpc/wshclient/wshclient.go`).

Write the message to a temp file and commit with `git commit -F <file>` (no here-strings in Bash, no co-author trailer):

```text
feat(orchestrate): + Run starts an orchestrator from a goal or a plan file, a plan-path run gets its lead only when something needs judgment, and Quick stops and asks when a goal outgrows it

- + Run offers Orchestrator and Quick; an Orchestrator starts from a goal or an absolute plan path, parsed and previewed (tasks, lanes, longest chain, serial, unverified) before anything is created
- CreateRun with planpath submits the plan at start with no lead and no plan gate, and cancels the run if the engine refuses it
- the wake adapter launches a plan-input run's lead at its first judgment event, with the orchestration rules and the wake as its launch prompt; a clean finish launches none and the engine closes the run
- the run card shows the plan's shape from the digest
- Quick's prompt tells the worker to stop and ask with its runtime's ask tool when the goal needs a plan
```
