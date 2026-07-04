# Channels Runs — Escalation Guidance (Piece 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Jarvis principles live — fed into every run phase worker's prompt and into the gatekeeper classifier — and wire run-phase workers into the gatekeeper so their asks are actually classified/escalated.

**Architecture:** Principles are resolved once at `CreateRun` and snapshotted on the `Run` (fed to each phase worker's prompt); the classifier resolves the channel's live principles per ask. A new pure resolver matches an asking worker to a run's phase `WorkerOrefs` so run workers reach the same classify→auto-answer/escalate flow as ad-hoc dispatch workers, independent of the `gatekeeper:enabled` toggle.

**Tech Stack:** Go (backend), the wshrpc codegen pipeline (`task generate`), `pkg/jarvis` (run engine + gatekeeper), `pkg/waveobj` object model.

**Design spec:** `docs/superpowers/specs/2026-07-05-channels-runs-escalation-guidance-design.md`.

## Global Constraints

- **Pure builders stay pure.** `BuildPhasePrompt` and `BuildClassifyPrompt` take principles as a plain `string` arg; resolution happens only at the impure boundary (`CreateRunCommand`, `Classify`). Empty principles must reproduce today's output byte-for-byte.
- **Fail-safe contract is untouched.** Every existing classifier escalate-on-error path stays; principles never introduce a fail-open.
- **No change to the deterministic pre-filter** (`watcher.go:91`): only a single single-select question is auto-answerable. Run workers inherit this.
- **Run workers are gatekept regardless of `MetaKey_GatekeeperEnabled`** ("gatekeeper:enabled"). The ad-hoc message path keeps its toggle gate.
- **Never hand-edit generated files.** After the `Run` type changes, run `task generate` (regenerates `frontend/app/store/wshclientapi.ts` and `frontend/types/gotypes.d.ts`).
- **tsc gotcha:** typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (plain `npx tsc` stack-overflows). Baseline is clean (exit 0).
- **Commits require explicit human approval.** Each task ends with a Commit step; when executing, stage the listed files and **present** the commit for approval rather than committing unattended.
- License header on every new Go file:
  ```go
  // Copyright 2026, Command Line Inc.
  // SPDX-License-Identifier: Apache-2.0
  ```

---

## File Structure

- **Modify** `pkg/waveobj/wtype.go` — add `Principles string` to `Run`.
- **Modify** `pkg/jarvis/run.go` — `NewRun` gains a `principles` param; `BuildPhasePrompt` gains a `principles` param + preamble.
- **Modify** `pkg/jarvis/run_test.go` — new-signature callers; principles-snapshot + phase-prompt tests.
- **Modify** `pkg/jarvis/runexec.go` — `EnsureWorkers` passes `run.Principles`.
- **Modify** `pkg/jarvis/classify.go` — `BuildClassifyPrompt` gains a `principles` param + section; `Classify` resolves the channel's live principles.
- **Modify** `pkg/jarvis/classify_test.go` — new-signature caller; principles-present/absent tests.
- **Modify** `pkg/jarvis/resolve.go` — `RunWorkerMatch`, `ResolveRunWorker`, `runWorkerTask`.
- **Modify** `pkg/jarvis/resolve_test.go` — `ResolveRunWorker`/`runWorkerTask` tests.
- **Modify** `pkg/jarvis/watcher.go` — `handleAsk` resolution order (ad-hoc, then run worker).
- **Modify** `pkg/wshrpc/wshserver/wshserver.go` — `CreateRunCommand` resolves the full profile once (playbook + principles).
- **Regenerate** `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` via `task generate`.

---

## Task 1: Snapshot resolved principles on the Run

Adds `Run.Principles`, threads it through `NewRun`, and resolves it once in `CreateRunCommand`. The `NewRun` signature change touches all existing callers — they update in this task so the tree stays buildable.

**Files:**
- Modify: `pkg/waveobj/wtype.go`
- Modify: `pkg/jarvis/run.go`
- Modify: `pkg/jarvis/run_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Regenerate: `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`

**Interfaces:**
- Consumes: `jarvis.ResolveProfile`, `jarvis.LoadGlobalProfile`, `jarvis.OverrideFromMeta`, `jarvis.DefaultPlaybook` (Piece 3); `waveobj.JarvisProfile.Principles`.
- Produces: `waveobj.Run.Principles string`; `NewRun(goal, workspaceId, projectPath, principles string, playbook []waveobj.RunPhase, ts int64) waveobj.Run`.

- [ ] **Step 1: Add the field to `pkg/waveobj/wtype.go`**

In the `Run` struct (after the `ProjectPath` line, ~line 229):

```go
	Principles  string     `json:"principles,omitempty"` // resolved at CreateRun; fed to every phase worker prompt
```

- [ ] **Step 2: Write the failing test**

Add to `pkg/jarvis/run_test.go`:

```go
func TestNewRunStoresPrinciples(t *testing.T) {
	r := NewRun("g", "ws", "/r", "prefer the clean fix", DefaultPlaybook(), 1)
	if r.Principles != "prefer the clean fix" {
		t.Fatalf("want principles stored, got %q", r.Principles)
	}
}
```

- [ ] **Step 3: Run the test to verify it fails (compile error)**

Run: `go test ./pkg/jarvis/ -run TestNewRun -v`
Expected: FAIL — `NewRun` is called with the old 5-arg signature elsewhere in the file; the package does not compile ("too many arguments in call to NewRun" / signature mismatch).

- [ ] **Step 4: Update `NewRun` (signature + body) in `pkg/jarvis/run.go`**

```go
func NewRun(goal, workspaceId, projectPath, principles string, playbook []waveobj.RunPhase, ts int64) waveobj.Run {
	phases := make([]waveobj.RunPhase, len(playbook))
	copy(phases, playbook)
	if len(phases) > 0 {
		phases[0].State = PhaseState_Running
	}
	r := waveobj.Run{
		ID:          uuid.NewString(),
		Goal:        goal,
		WorkspaceId: workspaceId,
		ProjectPath: projectPath,
		Principles:  principles,
		Status:      RunStatus_Planning,
		Phases:      phases,
		CreatedTs:   ts,
	}
	recomputeStatus(&r)
	return r
}
```

- [ ] **Step 5: Update the existing `NewRun` callers in `pkg/jarvis/run_test.go`**

Insert `""` as the 4th argument (principles) at each existing call. The eight sites:

```go
// line 35
r := NewRun("ship coupons", "ws1", "/repo", "", DefaultPlaybook(), 1717000000000)
// line 55
r := NewRun("g", "ws", "/r", "", pb, 1)
// lines 63, 80, 98, 109, 133, 157 (all identical)
r := NewRun("g", "ws", "/r", "", DefaultPlaybook(), 1)
```

- [ ] **Step 6: Update `CreateRunCommand` in `pkg/wshrpc/wshserver/wshserver.go`**

Replace the `ResolvePlaybook` + `NewRun` lines (currently at `wshserver.go:1776-1777`):

```go
	global := jarvis.LoadGlobalProfile()
	resolved := jarvis.ResolveProfile(global, jarvis.OverrideFromMeta(ch))
	playbook := resolved.Playbook
	if len(playbook) == 0 {
		playbook = jarvis.DefaultPlaybook() // preserve ResolvePlaybook's empty-fallback
	}
	run := jarvis.NewRun(data.Goal, data.WorkspaceId, ch.ProjectPath, resolved.Principles, playbook, time.Now().UnixMilli())
```

- [ ] **Step 7: Run tests + build to verify they pass**

Run: `go test ./pkg/jarvis/ -run TestNewRun -v && go build ./...`
Expected: PASS (both new and existing NewRun tests); build exit 0.

- [ ] **Step 8: Regenerate the TS bindings**

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts`'s `Run` gains `principles?: string`. Do not hand-edit.

- [ ] **Step 9: Typecheck the frontend**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (no FE consumer yet; this just confirms the regenerated type compiles).

- [ ] **Step 10: Commit** (present for approval)

```bash
git add pkg/waveobj/wtype.go pkg/jarvis/run.go pkg/jarvis/run_test.go pkg/wshrpc/wshserver/wshserver.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts
git commit -m "feat(runs): snapshot resolved principles on the Run at creation"
```

---

## Task 2: Principle-aware phase prompts

`BuildPhasePrompt` gains a principles preamble; `EnsureWorkers` passes `run.Principles`.

**Files:**
- Modify: `pkg/jarvis/run.go`
- Modify: `pkg/jarvis/run_test.go`
- Modify: `pkg/jarvis/runexec.go`

**Interfaces:**
- Consumes: `waveobj.Run.Principles` (Task 1).
- Produces: `BuildPhasePrompt(phase waveobj.RunPhase, goal string, priorArtifacts []string, principles string) string`.

- [ ] **Step 1: Write the failing tests**

Replace the existing `TestBuildPhasePromptMentionsSkillGoalAndArtifacts` body (calls the old signature at `run_test.go:173`) and add a principles case:

```go
func TestBuildPhasePromptMentionsSkillGoalAndArtifacts(t *testing.T) {
	p := waveobj.RunPhase{Kind: PhaseKind_Plan, Skill: "superpowers:writing-plans"}
	got := BuildPhasePrompt(p, "ship coupons", []string{"docs/spec.md"}, "")
	for _, want := range []string{"superpowers:writing-plans", "ship coupons", "docs/spec.md"} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt missing %q: %s", want, got)
		}
	}
}

func TestBuildPhasePromptIncludesPrinciplesWhenPresent(t *testing.T) {
	p := waveobj.RunPhase{Kind: PhaseKind_Execute, Skill: "superpowers:executing-plans"}
	got := BuildPhasePrompt(p, "ship coupons", nil, "prefer the clean fix")
	if !strings.Contains(got, "prefer the clean fix") {
		t.Errorf("prompt missing principles: %s", got)
	}
}

func TestBuildPhasePromptOmitsPrinciplesWhenEmpty(t *testing.T) {
	p := waveobj.RunPhase{Kind: PhaseKind_Plan, Skill: "superpowers:writing-plans"}
	withEmpty := BuildPhasePrompt(p, "g", nil, "")
	if strings.Contains(withEmpty, "principles") {
		t.Errorf("empty principles should add no principles text: %s", withEmpty)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail (compile error)**

Run: `go test ./pkg/jarvis/ -run TestBuildPhasePrompt -v`
Expected: FAIL — `BuildPhasePrompt` still has the 3-arg signature; the package does not compile.

- [ ] **Step 3: Update `BuildPhasePrompt` in `pkg/jarvis/run.go`**

```go
// BuildPhasePrompt is the claude worker's initial prompt for a phase: work by the resolved principles,
// run the phase's skill against the goal, using any artifacts prior phases produced. Empty principles
// add nothing (identical to the pre-Piece-4 prompt).
func BuildPhasePrompt(phase waveobj.RunPhase, goal string, priorArtifacts []string, principles string) string {
	var b strings.Builder
	if strings.TrimSpace(principles) != "" {
		fmt.Fprintf(&b, "Work by these principles:\n%s\n\n", principles)
	}
	fmt.Fprintf(&b, "Use the %s skill to work this goal, then stop when the phase's deliverable is written.\n", phase.Skill)
	fmt.Fprintf(&b, "Goal: %s\n", goal)
	if len(priorArtifacts) > 0 {
		fmt.Fprintf(&b, "Prior artifacts to build on: %s\n", strings.Join(priorArtifacts, ", "))
	}
	return strings.TrimRight(b.String(), "\n")
}
```

- [ ] **Step 4: Update the caller in `pkg/jarvis/runexec.go`**

At `runexec.go:85`, pass the run's principles:

```go
		prompt := BuildPhasePrompt(p, run.Goal, priorArtifacts(run, i), run.Principles)
```

- [ ] **Step 5: Run tests + build to verify they pass**

Run: `go test ./pkg/jarvis/ -run TestBuildPhasePrompt -v && go build ./...`
Expected: PASS (all three); build exit 0.

- [ ] **Step 6: Commit** (present for approval)

```bash
git add pkg/jarvis/run.go pkg/jarvis/run_test.go pkg/jarvis/runexec.go
git commit -m "feat(runs): feed resolved principles into phase worker prompts"
```

---

## Task 3: Principle-aware classifier

`BuildClassifyPrompt` gains a principles section; `Classify` resolves the channel's live principles.

**Files:**
- Modify: `pkg/jarvis/classify.go`
- Modify: `pkg/jarvis/classify_test.go`

**Interfaces:**
- Consumes: `jarvis.ResolveProfile`, `jarvis.LoadGlobalProfile`, `jarvis.OverrideFromMeta` (Piece 3).
- Produces: `BuildClassifyPrompt(q baseds.AgentAskQuestion, task string, channel *waveobj.Channel, principles string) string`.

- [ ] **Step 1: Write the failing tests**

Update the existing `TestBuildClassifyPrompt_Contents` (calls the old signature at `classify_test.go:22`) and add two cases:

```go
func TestBuildClassifyPrompt_Contents(t *testing.T) {
	c := &waveobj.Channel{Name: "payments-api"}
	p := BuildClassifyPrompt(aQuestion(), "harden webhooks", c, "")
	for _, want := range []string{"Which migration?", "0", "Use existing", "1", "Create new", "harden webhooks", "JSON"} {
		if !contains(p, want) {
			t.Fatalf("prompt missing %q\n---\n%s", want, p)
		}
	}
}

func TestBuildClassifyPrompt_IncludesPrinciples(t *testing.T) {
	c := &waveobj.Channel{Name: "payments-api"}
	p := BuildClassifyPrompt(aQuestion(), "harden webhooks", c, "prefer the clean fix")
	if !contains(p, "prefer the clean fix") {
		t.Fatalf("prompt missing principles\n---\n%s", p)
	}
}

func TestBuildClassifyPrompt_OmitsEmptyPrinciples(t *testing.T) {
	c := &waveobj.Channel{Name: "payments-api"}
	p := BuildClassifyPrompt(aQuestion(), "harden webhooks", c, "")
	if contains(p, "principles") {
		t.Fatalf("empty principles should add no principles text\n---\n%s", p)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail (compile error)**

Run: `go test ./pkg/jarvis/ -run TestBuildClassifyPrompt -v`
Expected: FAIL — `BuildClassifyPrompt` still has the 3-arg signature; the package does not compile.

- [ ] **Step 3: Update `BuildClassifyPrompt` in `pkg/jarvis/classify.go`**

```go
// BuildClassifyPrompt composes a JSON-only prompt: the single question + its indexed options, the
// worker's task, the resolved principles (when any), and a capped recent timeline. The model must
// return {action, optionindex, reason}. Empty principles reproduce the pre-Piece-4 prompt.
func BuildClassifyPrompt(q baseds.AgentAskQuestion, task string, channel *waveobj.Channel, principles string) string {
	var opts strings.Builder
	for i, o := range q.Options {
		opts.WriteString(fmt.Sprintf("  %d: %s", i, o.Label))
		if o.Description != "" {
			opts.WriteString(" — " + o.Description)
		}
		opts.WriteString("\n")
	}
	timeline := recentTimeline(channel)
	if task == "" {
		task = "(unknown task)"
	}
	lines := []string{
		fmt.Sprintf(`You are Jarvis, gatekeeping a coding agent in the "%s" channel. A worker paused to ask a multiple-choice question. Decide whether it is ROUTINE (safe to auto-answer on the human's behalf) or a genuine FORK that needs the human.`, channel.Name),
		`Escalate (do NOT answer) if the choice is irreversible, changes product scope or user-facing behavior, is a real judgment call, or you are not confident. When in doubt, escalate.`,
	}
	if strings.TrimSpace(principles) != "" {
		lines = append(lines,
			"",
			"Team principles to weigh (escalate a fork that is principle-significant, e.g. a quick patch vs. the clean fix; when you DO auto-answer, prefer the option these principles favor):",
			principles,
		)
	}
	lines = append(lines,
		"",
		"Worker task: "+task,
		"Question: "+q.Question,
		"Options (index: label):",
		strings.TrimRight(opts.String(), "\n"),
		"",
		"Recent channel messages:",
		timeline,
		"",
		`Reply with ONLY a JSON object, no prose: {"action":"answer"|"escalate","optionindex":<int, required when action is answer>,"reason":"<one short sentence>"}`,
	)
	return strings.Join(lines, "\n")
}
```

- [ ] **Step 4: Update `Classify` to resolve live principles in `pkg/jarvis/classify.go`**

Insert the resolution and pass it into the builder:

```go
func Classify(ctx context.Context, channel *waveobj.Channel, q baseds.AgentAskQuestion, task string) Decision {
	spec, ok := consult.SpecFor("claude")
	if !ok {
		return Decision{Action: "escalate", Reason: "claude CLI unavailable"}
	}
	principles := ResolveProfile(LoadGlobalProfile(), OverrideFromMeta(channel)).Principles
	runCtx, cancel := context.WithTimeout(ctx, classifyTimeout)
	defer cancel()
	reply, err := consult.Run(runCtx, spec, channel.ProjectPath, BuildClassifyPrompt(q, task, channel, principles), func(string) {})
	if err != nil {
		return Decision{Action: "escalate", Reason: "classifier error: " + err.Error()}
	}
	return ParseDecision(reply)
}
```

- [ ] **Step 5: Run tests + build to verify they pass**

Run: `go test ./pkg/jarvis/ -run "TestBuildClassifyPrompt|TestParseDecision" -v && go build ./...`
Expected: PASS (new prompt tests + all existing `ParseDecision` fail-safe tests); build exit 0.

- [ ] **Step 6: Commit** (present for approval)

```bash
git add pkg/jarvis/classify.go pkg/jarvis/classify_test.go
git commit -m "feat(runs): make the gatekeeper classifier principle-aware"
```

---

## Task 4: Gatekeeper ↔ run-worker coupling

A pure resolver matches an asking worker to a run's phase `WorkerOrefs`; `handleAsk` falls back to it so run workers reach the classifier — regardless of the `gatekeeper:enabled` toggle.

**Files:**
- Modify: `pkg/jarvis/resolve.go`
- Modify: `pkg/jarvis/resolve_test.go`
- Modify: `pkg/jarvis/watcher.go`

**Interfaces:**
- Consumes: `waveobj.Channel.Runs`, `waveobj.Run.Phases[].WorkerOrefs`, `waveobj.Run.Goal`.
- Produces: `RunWorkerMatch{Channel *waveobj.Channel; Run *waveobj.Run; PhaseIdx int}`; `ResolveRunWorker(channels []*waveobj.Channel, askingORef string) *RunWorkerMatch`; `runWorkerTask(run *waveobj.Run, phaseIdx int) string`.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/jarvis/resolve_test.go` (the `ch(...)` helper there builds a `*waveobj.Channel`; extend with a run):

```go
func chWithRun(name string, enabled bool, run waveobj.Run) *waveobj.Channel {
	c := ch(name, enabled)
	c.Runs = []waveobj.Run{run}
	return c
}

func TestResolveRunWorker_MatchesPhaseWorker(t *testing.T) {
	run := waveobj.Run{ID: "r1", Goal: "ship coupons", Phases: []waveobj.RunPhase{
		{Kind: PhaseKind_Brainstorm, State: PhaseState_Done, WorkerOrefs: []string{"tab:t0"}},
		{Kind: PhaseKind_Plan, Skill: "superpowers:writing-plans", State: PhaseState_Running, WorkerOrefs: []string{"tab:t1"}},
	}}
	c := chWithRun("c1", true, run)
	m := ResolveRunWorker([]*waveobj.Channel{c}, "tab:t1")
	if m == nil || m.Channel.OID != "c1" || m.Run.ID != "r1" || m.PhaseIdx != 1 {
		t.Fatalf("want c1/r1/phase 1, got %+v", m)
	}
}

func TestResolveRunWorker_MatchesRegardlessOfToggle(t *testing.T) {
	run := waveobj.Run{ID: "r1", Goal: "g", Phases: []waveobj.RunPhase{
		{Kind: PhaseKind_Execute, State: PhaseState_Running, WorkerOrefs: []string{"tab:t1"}},
	}}
	c := chWithRun("c1", false, run) // gatekeeper toggle OFF
	if m := ResolveRunWorker([]*waveobj.Channel{c}, "tab:t1"); m == nil {
		t.Fatalf("run workers must resolve even with the gatekeeper toggle off")
	}
}

func TestResolveRunWorker_NilForUnknown(t *testing.T) {
	run := waveobj.Run{ID: "r1", Phases: []waveobj.RunPhase{{Kind: PhaseKind_Plan, WorkerOrefs: []string{"tab:t1"}}}}
	c := chWithRun("c1", true, run)
	if m := ResolveRunWorker([]*waveobj.Channel{c}, "tab:nope"); m != nil {
		t.Fatalf("want nil for unknown oref, got %+v", m)
	}
}

func TestRunWorkerTask_MentionsPhaseAndGoal(t *testing.T) {
	run := &waveobj.Run{Goal: "ship coupons", Phases: []waveobj.RunPhase{
		{Kind: PhaseKind_Plan, Skill: "superpowers:writing-plans"},
	}}
	task := runWorkerTask(run, 0)
	for _, want := range []string{"plan", "superpowers:writing-plans", "ship coupons"} {
		if !contains(task, want) {
			t.Fatalf("task missing %q: %s", want, task)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvis/ -run "TestResolveRunWorker|TestRunWorkerTask" -v`
Expected: FAIL — undefined `ResolveRunWorker`, `runWorkerTask`, `RunWorkerMatch`.

- [ ] **Step 3: Implement in `pkg/jarvis/resolve.go`**

Add `"fmt"` to the imports (currently the file imports only `waveobj`):

```go
import (
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)
```

Append:

```go
// RunWorkerMatch locates a run phase worker: the channel/run it belongs to and the phase index.
type RunWorkerMatch struct {
	Channel  *waveobj.Channel
	Run      *waveobj.Run
	PhaseIdx int
}

// ResolveRunWorker finds the run phase whose WorkerOrefs contains askingORef, across all channels.
// Unlike ResolveGatekeeperChannel it is NOT gated by MetaKey_GatekeeperEnabled: starting a run is
// itself opting into Jarvis management, so run workers are always gatekept. Returns nil when no phase
// owns the oref. (Piece 5 can add a descendant/subagent predicate here without changing callers.)
func ResolveRunWorker(channels []*waveobj.Channel, askingORef string) *RunWorkerMatch {
	for _, ch := range channels {
		for ri := range ch.Runs {
			run := &ch.Runs[ri]
			for pi := range run.Phases {
				for _, wo := range run.Phases[pi].WorkerOrefs {
					if wo == askingORef {
						return &RunWorkerMatch{Channel: ch, Run: run, PhaseIdx: pi}
					}
				}
			}
		}
	}
	return nil
}

// runWorkerTask is the classifier "task" context for a run worker: the phase it is executing, framed
// against the run goal. Falls back to the bare goal for an out-of-range index.
func runWorkerTask(run *waveobj.Run, phaseIdx int) string {
	if phaseIdx < 0 || phaseIdx >= len(run.Phases) {
		return run.Goal
	}
	p := run.Phases[phaseIdx]
	skill := p.Skill
	if skill == "" {
		skill = p.Kind
	}
	return fmt.Sprintf("%s phase (%s) of run goal: %s", p.Kind, skill, run.Goal)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvis/ -run "TestResolveRunWorker|TestRunWorkerTask" -v`
Expected: PASS (all four).

- [ ] **Step 5: Wire the fallback into `handleAsk` (`pkg/jarvis/watcher.go`)**

Replace the ownership block — currently (`watcher.go:85-96`):

```go
	ownerORef := channelOwnerORef(ctx, data.ORef)
	ch := ResolveGatekeeperChannel(channels, ownerORef)
	if ch == nil {
		return // not owned by any gatekeeper-enabled channel
	}
	// deterministic pre-filter: only a single single-select question is auto-answerable.
	if len(data.Questions) != 1 || data.Questions[0].MultiSelect {
		postEscalation(ch.OID, data, "needs a human (multiple or multi-select questions)", ownerORef)
		return
	}
	q := data.Questions[0]
	decision := Classify(ctx, ch, q, workerTaskFor(ch, ownerORef))
```

with:

```go
	ownerORef := channelOwnerORef(ctx, data.ORef)
	ch := ResolveGatekeeperChannel(channels, ownerORef)
	task := ""
	if ch != nil {
		task = workerTaskFor(ch, ownerORef)
	} else if m := ResolveRunWorker(channels, ownerORef); m != nil {
		ch = m.Channel
		task = runWorkerTask(m.Run, m.PhaseIdx)
	}
	if ch == nil {
		return // not owned by any gatekeeper-enabled channel or run
	}
	// deterministic pre-filter: only a single single-select question is auto-answerable.
	if len(data.Questions) != 1 || data.Questions[0].MultiSelect {
		postEscalation(ch.OID, data, "needs a human (multiple or multi-select questions)", ownerORef)
		return
	}
	q := data.Questions[0]
	decision := Classify(ctx, ch, q, task)
```

- [ ] **Step 6: Run the jarvis suite + build**

Run: `go test ./pkg/jarvis/ && go build ./...`
Expected: PASS; build exit 0.

- [ ] **Step 7: Commit** (present for approval)

```bash
git add pkg/jarvis/resolve.go pkg/jarvis/resolve_test.go pkg/jarvis/watcher.go
git commit -m "feat(runs): route run-worker asks through the gatekeeper"
```

---

## Task 5: End-to-end acceptance (live dev app)

Verify the full path against the live tauri dev app, mirroring the Piece 1 acceptance. Record the result.

**Files:**
- Create: `docs/agents/runs-piece4-acceptance.md`

Prereqs: `task dev` running (use `tail -f /dev/null | task dev` so wavesrv's stdin doesn't EOF); a channel created with a `ProjectPath`; note its `channelid` and the workspace oid (`globalStore.get(atoms.workspace).oid`). Set a non-empty global profile so principles are present: either a `jarvis-profile.json` in the config dir or rely on `BuiltinProfile()`'s `DefaultPrinciples` (a missing file falls back to it, so principles are non-empty by default).

- [ ] **Step 1: Confirm principles reach a phase worker**

In the dev app devtools console:
`RpcApi.CreateRunCommand(TabRpcClient, { channelid, workspaceid, goal: "add a coupon field to checkout" })`
Open the spawned phase-1 worker tab. Expected: the claude worker's initial prompt begins with "Work by these principles:" followed by the profile principles, then the brainstorm skill + goal. (Confirms Task 1 + Task 2: snapshot + prompt injection.)

- [ ] **Step 2: Confirm a run worker's ask is classified**

In the worker tab, have the worker ask a single single-select question (or drive one via a scripted `AskUserQuestion`). Expected: within the classify timeout, Jarvis either posts a `jarvis-answered` card to the channel (routine) or a `jarvis-escalation` card (fork) — proving `ResolveRunWorker` routed the ask through `Classify` (Task 4). Before Piece 4 this produced nothing. Verify it fires even with the channel's gatekeeper toggle **off**.

- [ ] **Step 3: Confirm principle-significant escalation**

Drive an ask that pits a quick patch against the clean fix (e.g. options "add a null check here" vs "refactor the validation path"). Expected: Jarvis escalates (does not auto-answer), citing the principle in `reason`. (Confirms Task 3: the classifier weighs principles.)

- [ ] **Step 4: Record the acceptance note**

Write `docs/agents/runs-piece4-acceptance.md` with a short table of the three steps (RPC/action, observed result), the profile principles used, and any known issues surfaced — mirroring `docs/agents/runs-piece1-acceptance.md`.

- [ ] **Step 5: Commit** (present for approval)

```bash
git add docs/agents/runs-piece4-acceptance.md
git commit -m "test(runs): Piece 4 escalation-guidance acceptance record"
```

---

## Self-Review

**Spec coverage:**
- Principle-aware phase prompts (`Run.Principles` snapshot + `BuildPhasePrompt`) → Tasks 1–2. ✓
- Principle-aware classifier (`BuildClassifyPrompt` section + `Classify` live resolve) → Task 3. ✓
- Gatekeeper ↔ run-worker coupling (`ResolveRunWorker` + `runWorkerTask` + `handleAsk`, toggle-independent) → Task 4. ✓
- Decision 1 (snapshot at creation) → Task 1; Decision 2 (classifier live principles) → Task 3; Decision 3 (no brainstorm special-casing) → nothing special-cases phase kind in Task 4's `handleAsk` or Task 3's classifier; Decision 4 (toggle-independent) → Task 4 `ResolveRunWorker` + test; Decision 5 (pure builders) → principles are string args in Tasks 2–3. ✓
- Non-goals honored: pre-filter unchanged (Task 4 keeps the `len != 1 || MultiSelect` guard verbatim); no rail auto-answer trace (no FE task); no model-tier change (Classify still `SpecFor("claude")`); no recursive matching (noted in `ResolveRunWorker` doc, not built). ✓
- Empty-principles fallback → asserted in Tasks 2 (`TestBuildPhasePromptOmitsPrinciplesWhenEmpty`) and 3 (`TestBuildClassifyPrompt_OmitsEmptyPrinciples`). ✓
- Acceptance verification → Task 5. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows complete code; every test step shows assertions, the exact run command, and expected result. Existing-caller updates are mechanical signature propagation (the eight `NewRun` sites + one each for `BuildPhasePrompt`/`BuildClassifyPrompt`), enumerated with the new call text and enforced by the compiler at the "verify it fails/passes" steps.

**Type consistency:** `NewRun(goal, workspaceId, projectPath, principles, playbook, ts)`, `BuildPhasePrompt(phase, goal, priorArtifacts, principles)`, `BuildClassifyPrompt(q, task, channel, principles)`, `ResolveRunWorker(channels, askingORef) *RunWorkerMatch`, `runWorkerTask(run, phaseIdx)`, and `Run.Principles` are used with identical names/types across the tasks, tests, and call sites (`runexec.go`, `wshserver.go`, `watcher.go`).
