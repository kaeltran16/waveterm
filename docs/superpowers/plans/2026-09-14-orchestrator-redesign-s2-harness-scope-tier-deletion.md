# Orchestrator Redesign Slice 2: Harness Scope, Tier Deletion, Pin Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run workers support only Claude Code and pi. A route is a runtime plus an exact model, with no tier anywhere in the run path. Every saved tier pin is rewritten to a model once, at server start.

**Architecture:**
- `pkg/runroute` keeps one runtime-default row per supported runtime and otherwise validates exact model ids.
- The tier column, legacy normalization and the automatic context-window escalation are deleted.
- Tier fields leave `Run`, `RunSpec` and the create-run, dag-action and route-capability wire types.
- `RoutePin` keeps `tier` only so a marker-gated startup pass in `pkg/jarvis` can rewrite settings, the global profile, channel overrides, runs and dags.
- The frontend drops every route-tier fallback and shows `default` where it showed `capable`.

**Tech Stack:** Go (wstore on SQLite, wshrpc codegen via `task generate`), React 19 + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md` §8 (Harness scope) and §9 (Tier deletion).

## Global Constraints

- Run workers (leads and task workers) support Claude Code and pi only. `ConsultCapable` is unchanged for codex and opencode.
- **Kept:**
  - consult tiers (`pkg/consult`, G9);
  - the channel autonomy `Tier` (`wshrpctypes_channels.go:70`, `jarvis.TierMeta`);
  - `view/jarvis/autonomyladder*` and `briefautonomy.ts`.
- **Pin migration table** (spec §9). The pass clears `tier` on write, and a pin that already has a model keeps it.

  | Pin | Rewritten to |
  |---|---|
  | claude + cheap | `consult.CheapModel` |
  | claude + mid | `consult.MidModel` |
  | any runtime + capable | empty model (the runtime default) |

- `dag escalate` requires `--model`.
- No emojis. Comments are lower case and say why, never what.
- Never hand-edit generated files. Run `task generate` after changing a wshrpc, waveobj or wconfig type.
- CGO packages (`wshrpc/wshserver`) need, from PowerShell at the repo root: `$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (`npx tsc` overflows).
- One commit for the slice, with this plan folded in. No co-author trailer, no push. Stage only this slice's files.

## Task order

1. Harness scope.
2. Escalation becomes model-only. It compiles while tiers still exist.
3. Tier deletion. The runroute rewrite, the type removal and their consumers are one compile unit, so they are one task.
4. Startup pin migration.
5. Frontend.
6. Verify and commit.

---

### Task 1: Run workers are claude and pi only

**Files:**
- Modify: `pkg/harness/catalog.go` (codex and opencode specs)
- Modify: `pkg/harness/catalog_test.go`
- Modify: `pkg/jarvis/runexec.go` (`RunWorkerSpecFor` switch, header comment)
- Modify: `pkg/jarvis/runexec_test.go`
- Modify: `pkg/orchestrate/liveness.go:64`
- Modify: `pkg/orchestrate/liveness_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_harness_test.go:39-49`
- Modify: `docs/deferred.md`, `docs/open-issues.md`, `docs/orchestrator-howto.md`

**Interfaces:** none new. `harness.Spec.RunWorkerCapable` is false for codex and opencode, and `jarvis.RunWorkerSpecFor` returns no spec for them.

- [ ] **Step 1: Write the failing tests**

`pkg/harness/catalog_test.go`:
- `TestLookupCapabilities` asserts `RunWorkerCapable` is true for exactly `claude` and `pi`, and false for `codex` and `opencode`.
- `ConsultCapable` stays true for all four.
- `TestValidateInstalled` expects `Validate("opencode", OpRunWorker)` (the operation constant the file already uses) to return an error containing `does not support run workers`, while claude still validates.

`pkg/jarvis/runexec_test.go` (`TestRunWorkerSpecFor`): add a case that a codex capability yields no spec. The capability is built by hand, because Task 3 removes codex from runroute.

```go
func TestRunWorkerSpecForRejectsUnsupportedRuntimes(t *testing.T) {
	for _, runtime := range []string{"codex", "opencode"} {
		cap := runroute.Capability{Runtime: runtime, ResolvedModel: "operator default"}
		if _, err := RunWorkerSpecFor(cap, "/tmp/wt", "do it"); err == nil {
			t.Errorf("%s must have no run worker adapter", runtime)
		}
	}
}
```

(Match the real `RunWorkerSpecFor` signature and the not-supported return shape in the file. If it returns `(spec, ok)` rather than an error, assert `!ok`.)

`pkg/orchestrate/liveness_test.go`:
- Delete `writeCodexSession` and `TestLastActivityTracksCodexChild`.
- The unsupported-runtime loop becomes `[]string{"codex", "opencode", "gemini"}`.

`pkg/wshrpc/wshserver/wshserver_harness_test.go` (`TestListHarnessesReportsCatalog`, line 46): the `!info.RunWorkerCapable` clause becomes a runtime check. `RunWorkerCapable` must equal `info.Runtime == "claude" || info.Runtime == "pi"`.

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./pkg/harness/ ./pkg/jarvis/ ./pkg/orchestrate/ -run 'TestLookupCapabilities|TestValidateInstalled|TestRunWorkerSpecFor|TestLastActivity' -count=1`

Expected: FAIL. codex/opencode are still run-worker capable and still have adapters.

- [ ] **Step 3: Implement**

- `pkg/harness/catalog.go`: set `RunWorkerCapable: false` on the codex and opencode specs.
- `pkg/jarvis/runexec.go`:
  - delete the `case "codex":` and `case "opencode":` arms;
  - the header comment says the prompt travels positionally for claude and pi.
- `pkg/orchestrate/liveness.go:64`: `var livenessRuntimes = map[string]bool{"claude": true, "pi": true}`.

- [ ] **Step 4: Run to verify they pass**

Run the Step 2 command, plus `go test ./pkg/wshrpc/wshserver/ -run TestListHarnesses -count=1` from PowerShell with `CGO_CFLAGS` set.

Expected: PASS.

- [ ] **Step 5: Docs**

**`docs/deferred.md`:** add a new entry at the top, `## Codex and opencode run workers (2026-09-14)`. It must say:
- Run workers support claude and pi only (spec §8), and consult still supports codex and opencode.
- What was deleted: the runexec arms, the liveness entry and its codex session test, the runroute rows and `codexSafe`, and the `RunWorkerCapable` flags.
- The recovery commands, against the pre-slice commit `adfcbebc`:
  - `git show adfcbebc:pkg/jarvis/runexec.go`
  - `git show adfcbebc:pkg/orchestrate/liveness.go`
  - `git show adfcbebc:pkg/orchestrate/liveness_test.go`
  - `git show adfcbebc:pkg/runroute/runroute.go`
  - `git show adfcbebc:pkg/harness/catalog.go`
- "Where to pick it up": re-add the arms, the rows and the flags together; a runtime needs all three to dispatch.

**`docs/open-issues.md`:** add a row in the existing deferred-row format, pointing at that entry.

**`docs/orchestrator-howto.md`:** under "Phase 0", add `### 4. The lead's harness must be claude or pi, with its packages installed`. It says:
- codex and opencode cannot run leads or workers (see `docs/deferred.md`).
- A pi lead needs the ask tool package `@juicesharp/rpiv-ask-user-question`.
- A pi lead also needs the superpowers package for `brainstorming` and `writing-plans`, because pi's `skills` setting (`~/.claude/skills`) doesn't hold plugin skills.

---

### Task 2: Escalation is a human choice of model

**Files:**
- Modify: `pkg/orchestrate/retry.go` (delete `escalateDecision`, `nextTier`, `isHigherTier`, and the `consult` import)
- Modify: `pkg/orchestrate/outcome.go:86-149` (delete `autoEscalationTarget` and the `mayEscalate` paths)
- Modify: `pkg/orchestrate/mutation.go:88-133`
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go:371-388` and `:547-549`
- Test: `pkg/orchestrate/retry_test.go`, `hardening_test.go`, `mutation_test.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`, `pkg/wshrpc/wshserver/wshserver_dag_test.go`

**Interfaces:**
- Produces:
  - `escalationTarget(task, owner, group, target waveobj.RoutePin) (waveobj.RoutePin, error)` returns an error unless `target.Model` is set;
  - `applyEscalation(task, target)` writes only `RunSpec.Runtime` and `RunSpec.Model`;
  - `dagEscalateData` returns an error when `--model` is empty.

- [ ] **Step 1: Write the failing tests**

`pkg/orchestrate/hardening_test.go`: replace `TestHandleChildOutcomeEscalatesContextWindowOnce` with:

```go
// a context-window failure is a real failure: the human picks a bigger model, the engine never guesses one.
func TestHandleChildOutcomeFailsContextWindowWithoutRepinning(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	data := jarvis.OutcomeData{Status: "failed", Summary: "context window exceeded", ExitCode: 1}
	if err := HandleChildOutcome(h.ctx, h.workers[0], data); err != nil {
		t.Fatal(err)
	}
	got := h.loadDag(t)
	task := got.Tasks[0]
	if task.State != TaskState_Failed || task.Escalations != 0 || task.RunSpec.Model != "" {
		t.Fatalf("context-window failure = %+v", task)
	}
	if got.Failures != 1 {
		t.Fatalf("a terminal failure must push the failure streak, got %d", got.Failures)
	}
	if len(h.workers) != 1 {
		t.Fatalf("a context-window failure spawned %d workers, want 1", len(h.workers))
	}
}
```

Also delete `TestEscalateDecisionAndTierLadder` (hardening_test.go) and `TestTierPolicy` (retry_test.go).

`pkg/orchestrate/mutation_test.go`: replace the tier escalation tests (`TestEscalateAcceptsExplicitHigherTier`, `TestEscalateRejectsSameOrLowerTierWithoutCancellingRun`) with:

```go
func TestEscalateRequiresModelWithoutCancellingRun(t *testing.T) {
	ctx, dag, child, worker := seedEscalationDag(t, "claude", "", TaskState_Failed, 0)
	assertEscalationRejectedWithoutCancelling(t, ctx, dag, child, worker, waveobj.RoutePin{Runtime: "claude"})
}

func TestEscalateRepinsToModel(t *testing.T) {
	ctx, dag, _, _ := seedEscalationDag(t, "claude", "", TaskState_Failed, 0)
	allowEscalationSchedule(t)
	if err := ApplyAction(ctx, dag.OID, "t-0", "escalate", waveobj.RoutePin{Model: "opus"}); err != nil {
		t.Fatal(err)
	}
	got := mustLoadDag(t, ctx, dag.OID)
	if got.Tasks[0].RunSpec.Runtime != "claude" || got.Tasks[0].RunSpec.Model != "opus" || got.Tasks[0].Escalations != 1 {
		t.Fatalf("model escalation = %+v", got.Tasks[0])
	}
}
```

Retarget the other escalation tests that pass a tier to models:
- `TestEscalateRejectsSecondHopWithoutCancellingRun` → `{Model: "opus"}`
- `TestEscalateRejectsUnsupportedRouteWithoutCancellingRun` → runtime `claude`, target `{Runtime: "claude", Model: "gpt-5.4"}` (wrong namespace)
- `TestEscalateRejectsPendingTask` → `{Model: "opus"}`

`TestEscalateRejectsEmptyTarget` keeps its body; its comment says a hop requires an explicit model.

`cmd/wsh/cmd/wshcmd-jarvisdag_test.go` (`TestDagEscalateData`):
- remove the tier flag, value and field expectation;
- add a case where `--model` is empty and `dagEscalateData` returns an error containing `--model is required`.

`pkg/wshrpc/wshserver/wshserver_dag_test.go`: delete `TestDagActionRejectsSameTierWithoutCancellingRun`. Its rejected-without-cancel shape is covered by `TestDagActionRejectsEmptyEscalateTarget`, whose comment becomes "the human names the model".

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./pkg/orchestrate/ -run 'TestHandleChildOutcome|TestEscalat' -count=1` and `go test ./cmd/wsh/cmd/ -run TestDagEscalateData -count=1`

Expected: FAIL. Context-window still auto-escalates, and the CLI accepts a missing model.

- [ ] **Step 3: Implement**

`pkg/orchestrate/retry.go`: delete `escalateDecision`, `nextTier`, `isHigherTier` and the `consult` import.

`pkg/orchestrate/outcome.go`, inside `HandleChildOutcome` after `task.State = TaskState_Failed`:

```go
		// a recoverable flake is retried, not a genuine failure: it must not push the streak
		// toward the circuit-break, or n concurrent one-shot flakes (plus any manual failure)
		// would block the DAG though every flake auto-recovers. only terminal failures count.
		if !mayRetry {
			g.Failures++
		}
		if mayRetry {
			if err := RetryTask(g, task.ID); err != nil {
				return err
			}
		}
		g.UpdatedTs = time.Now().UnixMilli()
		RecomputeDagStatus(g)
		if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
			*cur = *g
			return nil
		}); err != nil {
			return err
		}
		// emit only after the persist lands so the event never describes state the store rejected
		if mayRetry {
			detail := map[string]any{"taskid": task.ID, "kind": kind, "attempt": attempt}
			publishDagEvent(DagEventTaskRetried, g, task.ID)
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskRetried, nil, detail)
		}
		return scheduleLocked(ctx, g.OID)
```

Delete `autoEscalationTarget`. Drop any import that becomes unused.

`pkg/orchestrate/mutation.go`:

```go
func escalationTarget(task *waveobj.TaskNode, owner *waveobj.Run, group *waveobj.TaskGroup, target waveobj.RoutePin) (waveobj.RoutePin, error) {
	if task == nil {
		return waveobj.RoutePin{}, fmt.Errorf("task is required")
	}
	if task.State != TaskState_Failed && task.State != TaskState_Stalled && task.State != TaskState_BlockedMerge {
		return waveobj.RoutePin{}, fmt.Errorf("task %q cannot be escalated from state %q", task.ID, task.State)
	}
	if task.Escalations >= 1 {
		return waveobj.RoutePin{}, fmt.Errorf("task %q is already escalated; it is blocked for the human", task.ID)
	}
	if target.Model == "" {
		return waveobj.RoutePin{}, fmt.Errorf("escalating %q: a target model is required", task.ID)
	}
	if target.Runtime == "" {
		target.Runtime = effectiveTaskRoute(task, owner, group).Runtime
	}
	target = waveobj.RoutePin{Runtime: target.Runtime, Model: target.Model}
	if _, err := runroute.Resolve(target); err != nil {
		return waveobj.RoutePin{}, fmt.Errorf("escalating %q: %w", task.ID, err)
	}
	return target, nil
}

// applyEscalation repins a task to a chosen model and returns it to pending so the next tick
// dispatches it fresh.
func applyEscalation(task *waveobj.TaskNode, target waveobj.RoutePin) {
	task.RunSpec.Runtime = target.Runtime
	task.RunSpec.Model = target.Model
	task.Attempts = 0
	task.LastFailureKind = ""
	task.Escalations++
	task.State = TaskState_Pending
	task.RunID = ""
}
```

`task.RunSpec.Tier` is left untouched here. Task 3 deletes the field.

`cmd/wsh/cmd/wshcmd-jarvisdag.go`:
- `dagEscalateData` returns `fmt.Errorf("--model is required")` when the model flag is empty;
- it stops reading or sending the tier;
- the `--model` flag help becomes `exact model id to retry on (e.g. sonnet, or opencode/deepseek-v4-pro for pi)`;
- delete the `--tier` flag registration and its variable.

- [ ] **Step 4: Run to verify they pass**

Run: `go test ./pkg/orchestrate/ ./cmd/wsh/cmd/ -count=1`, and `go test ./pkg/wshrpc/wshserver/ -run TestDagAction -count=1` with `CGO_CFLAGS` set.

Expected: PASS.

---

### Task 3: Delete tiers from routes, run types and wire types

This task is one compile unit. The package-scoped runs in Step 2 fail to build until Step 3 is complete.

**Files:**
- Rewrite: `pkg/runroute/runroute.go`
- Rewrite: `pkg/runroute/runroute_test.go` (keep tests unrelated to tiers or codex/opencode)
- Modify: `pkg/waveobj/wtype.go:239-243` (`RoutePin`), `:266` (`Run.Tier`), `:350` (`RunSpec.Tier`), and the Model comments
- Modify: `pkg/waveobj/routemodel_test.go`
- Modify: `pkg/wshrpc/wshrpctypes_runs.go:28`, `wshrpctypes_dag.go:54-55`, `wshrpctypes_jarvis.go:216`
- Modify: `pkg/wconfig/settingsconfig.go:181`
- Generated: `pkg/wconfig/metaconsts.go`, `frontend/types/gotypes.d.ts`, `schema/settings.json` (via `task generate`)
- Modify: `pkg/orchestrate/engine.go:626-661`, `pkg/orchestrate/dag.go:288`, `pkg/orchestrate/liveness.go:87` comment
- Modify: `pkg/jarvis/runexec.go:118`
- Modify: `pkg/wshrpc/wshserver/wshserver.go:216-255`, `wshserver_dag.go:37-54`, `:314`, `wshserver_runs.go:208`, `:317`, `:356`, `:468`, `:482`, `wshserver_jarvis.go:363-379`
- Modify (tests; the tier references come from the grep below): orchestrate `b1b_workerroute_test.go`, `dag_test.go`, `engine_test.go`, `mutation_test.go`, `outcome_test.go`; jarvis `profile_test.go`, `runsettings_test.go`, `runexec_test.go`; wshserver `childrun_test`, `dag_test`, `harness_test`, `plangate_test`, `profile_test`, `profiledefaults_test`, `routeconfig_test`, `run_test`, `runsettings_test`, `spawn_test`; `cmd/wsh/cmd/wshcmd-jarvisdag.go` (drop `Tier:`)

**Interfaces:**
- Produces:
  - `runroute.Capability{Runtime, Model, ResolvedModel, Provider, ContextHint, Default, ModelArgs}` (no `Tier`);
  - `runroute.Resolve(pin waveobj.RoutePin) (Capability, error)`;
  - `runroute.Capabilities(runtime string) []Capability`;
  - `runroute.DefaultRuntime(runtime string) string`;
  - `runroute.MigrateTierPin(pin waveobj.RoutePin) (waveobj.RoutePin, bool)`;
  - `runroute.IsValid(Capability) bool`;
  - `waveobj.RoutePin{Runtime, Model, Tier}` with `Tier` tagged `json:"tier,omitempty"` and read only by the migration.

- [ ] **Step 1: Write the failing runroute tests**

In `pkg/runroute/runroute_test.go`, delete these tests:
- every tier-table test, including the supported-route and unsupported-route tables built on `consult.Tier` and the independent-slices test that resolves `claude/cheap`;
- `TestNormalizeLegacy`, `TestResolveModelPinOpenCode`, `TestResolveModelPinCodex`, `TestResolveModelWinsOverTier`, `TestResolveLegacyTableUnchanged`, `TestNormalizeLegacyPiTierAlwaysCapable`;
- any cross-namespace case naming codex or opencode as the runtime.

Keep the pi and claude model-pin tests. Add:

```go
func TestResolveRuntimeDefaults(t *testing.T) {
	for _, runtime := range []string{"claude", "pi"} {
		got, err := Resolve(waveobj.RoutePin{Runtime: runtime})
		if err != nil {
			t.Fatalf("%s default: %v", runtime, err)
		}
		if got.Runtime != runtime || got.Model != "" || got.ResolvedModel != operatorDefault || got.ModelArgs != nil {
			t.Fatalf("%s default = %+v", runtime, got)
		}
	}
}

func TestResolveRejectsUnsupportedRuntimes(t *testing.T) {
	for _, pin := range []waveobj.RoutePin{
		{Runtime: "codex"},
		{Runtime: "opencode"},
		{Runtime: "openrouter"},
		{Runtime: ""},
		{Runtime: "codex", Model: "gpt-5.4"},
		{Runtime: "opencode", Model: "openai/gpt-5.4"},
		{Runtime: "", Model: "sonnet"},
	} {
		if _, err := Resolve(pin); err == nil {
			t.Errorf("Resolve(%+v) accepted an unsupported route", pin)
		}
	}
}

func TestResolveIgnoresStaleTier(t *testing.T) {
	got, err := Resolve(waveobj.RoutePin{Runtime: "claude", Tier: "cheap"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Model != "" || got.ModelArgs != nil {
		t.Fatalf("a tier must not select a model any more: %+v", got)
	}
}

func TestCapabilitiesReturnsIndependentSlices(t *testing.T) {
	resolved, err := Resolve(waveobj.RoutePin{Runtime: "claude", Model: "haiku"})
	if err != nil {
		t.Fatal(err)
	}
	resolved.ModelArgs[1] = "mutated"
	again, err := Resolve(waveobj.RoutePin{Runtime: "claude", Model: "haiku"})
	if err != nil {
		t.Fatal(err)
	}
	if again.ModelArgs[1] != "haiku" {
		t.Fatalf("resolved args share storage: %+v", again.ModelArgs)
	}
	caps := Capabilities("pi")
	caps[0].ResolvedModel = "mutated"
	if Capabilities("pi")[0].ResolvedModel != operatorDefault {
		t.Fatal("capabilities share storage with the default table")
	}
}

func TestDefaultRuntime(t *testing.T) {
	if DefaultRuntime("") != "claude" || DefaultRuntime("pi") != "pi" {
		t.Fatal("empty runtime must default to claude and a set runtime must pass through")
	}
}

func TestMigrateTierPin(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   waveobj.RoutePin
		want waveobj.RoutePin
	}{
		{"claude cheap", waveobj.RoutePin{Runtime: "claude", Tier: "cheap"}, waveobj.RoutePin{Runtime: "claude", Model: consult.CheapModel}},
		{"claude mid", waveobj.RoutePin{Runtime: "claude", Tier: "mid"}, waveobj.RoutePin{Runtime: "claude", Model: consult.MidModel}},
		{"claude capable", waveobj.RoutePin{Runtime: "claude", Tier: "capable"}, waveobj.RoutePin{Runtime: "claude"}},
		{"pi cheap", waveobj.RoutePin{Runtime: "pi", Tier: "cheap"}, waveobj.RoutePin{Runtime: "pi"}},
		{"unknown tier", waveobj.RoutePin{Runtime: "claude", Tier: "strong"}, waveobj.RoutePin{Runtime: "claude"}},
		{"model kept", waveobj.RoutePin{Runtime: "claude", Tier: "cheap", Model: "opus"}, waveobj.RoutePin{Runtime: "claude", Model: "opus"}},
	} {
		got, changed := MigrateTierPin(tc.in)
		if !changed || got != tc.want {
			t.Errorf("%s: MigrateTierPin(%+v) = %+v, %v; want %+v, true", tc.name, tc.in, got, changed, tc.want)
		}
		if _, again := MigrateTierPin(got); again {
			t.Errorf("%s: a migrated pin must not migrate again", tc.name)
		}
	}
	untouched := waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"}
	if got, changed := MigrateTierPin(untouched); changed || got != untouched {
		t.Fatalf("a tier-free pin changed: %+v", got)
	}
}
```

`pkg/waveobj/routemodel_test.go`:
- `:12` drops `Tier: ""`;
- the marshal test asserts that `RoutePin{Runtime: "claude"}` marshals to `{"runtime":"claude"}` (tier omitted).

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./pkg/runroute/ ./pkg/waveobj/ -count=1`

Expected: FAIL (build). `DefaultRuntime` and `MigrateTierPin` are undefined, and `tier` is still marshalled.

- [ ] **Step 3: Rewrite `pkg/runroute/runroute.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package runroute owns the supported run runtimes and the model a route resolves to.
package runroute

import (
	"fmt"
	"regexp"
	"slices"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const operatorDefault = "operator default"

// a run persisted before routes existed has no runtime; it was always a claude run
const defaultRuntime = "claude"

var (
	claudeAliasRe   = regexp.MustCompile(`^(opus|sonnet|haiku|fable|best)(\[[0-9]+m\])?$`)
	claudeFullRe    = regexp.MustCompile(`^claude-[a-zA-Z0-9-]+$`)
	providerModelRe = regexp.MustCompile(`^[a-zA-Z0-9_-]+/[a-zA-Z0-9._:+-]+$`)
)

type Capability struct {
	Runtime       string   `json:"runtime"`
	Model         string   `json:"model,omitempty"` // "" means the runtime's own default model
	ResolvedModel string   `json:"resolvedmodel"`
	Provider      string   `json:"provider,omitempty"`
	ContextHint   string   `json:"contexthint,omitempty"`
	Default       bool     `json:"default,omitempty"`
	ModelArgs     []string `json:"-"`
}

var runtimeDefaults = []Capability{
	{Runtime: "pi", ResolvedModel: operatorDefault},
	{Runtime: "claude", ResolvedModel: operatorDefault},
}
```

Keep the existing bodies of `Capabilities` and `cloneCapability` (or the file's equivalent), looping over `runtimeDefaults`. Keep the existing `modelNamespaceValid` claude and pi branches and delete its codex and opencode branches, so an unknown runtime returns false. Then:

```go
func Resolve(pin waveobj.RoutePin) (Capability, error) {
	if pin.Model == "" {
		for _, capability := range runtimeDefaults {
			if capability.Runtime == pin.Runtime {
				return cloneCapability(capability), nil
			}
		}
		return Capability{}, fmt.Errorf("unsupported route runtime %q", pin.Runtime)
	}
	if pin.Runtime == "" {
		return Capability{}, fmt.Errorf("model route requires a runtime")
	}
	if !modelNamespaceValid(pin.Runtime, pin.Model) {
		return Capability{}, fmt.Errorf("model %q is not a valid %s model id", pin.Model, pin.Runtime)
	}
	return Capability{Runtime: pin.Runtime, Model: pin.Model, ResolvedModel: pin.Model, ModelArgs: []string{"--model", pin.Model}}, nil
}

// DefaultRuntime names the runtime of a route persisted without one.
func DefaultRuntime(runtime string) string {
	if runtime == "" {
		return defaultRuntime
	}
	return runtime
}

// MigrateTierPin rewrites a pin saved with a tier to the model that tier resolved to before tiers
// were deleted, and clears the tier. Only claude ever mapped cheap and mid to a model; every other
// tier resolved to the runtime default.
func MigrateTierPin(pin waveobj.RoutePin) (waveobj.RoutePin, bool) {
	if pin.Tier == "" {
		return pin, false
	}
	if pin.Model == "" && pin.Runtime == "claude" {
		switch consult.Tier(pin.Tier) {
		case consult.TierCheap:
			pin.Model = consult.CheapModel
		case consult.TierMid:
			pin.Model = consult.MidModel
		}
	}
	pin.Tier = ""
	return pin, true
}

func IsValid(capability Capability) bool {
	resolved, err := Resolve(waveobj.RoutePin{Runtime: capability.Runtime, Model: capability.Model})
	if err != nil {
		return false
	}
	return resolved.ResolvedModel == capability.ResolvedModel && slices.Equal(resolved.ModelArgs, capability.ModelArgs)
}
```

Delete `codexSafe`, `resolveLegacyTier` and `NormalizeLegacy`.

- [ ] **Step 4: Types**

`pkg/waveobj/wtype.go`:

```go
type RoutePin struct {
	Runtime string `json:"runtime"`
	Model   string `json:"model,omitempty"` // exact model id; empty means the runtime's own default
	// Tier is read only by the startup pin migration (runroute.MigrateTierPin), which clears it.
	Tier string `json:"tier,omitempty"`
}
```

Also in `wtype.go`:
- delete `Run.Tier` and `RunSpec.Tier`;
- in the comments on `Run.Model` and `RunSpec.Model`, drop "empty means tier" in favour of "empty means the runtime default".

Wire types:
- delete `CommandCreateRunData.Tier` (`wshrpctypes_runs.go`);
- delete `CommandDagActionData.Tier` (`wshrpctypes_dag.go`), and set the Model comment to `escalate target model (exact id); required`;
- delete `RouteCapabilityInfo.Tier` (`wshrpctypes_jarvis.go`);
- delete `HarnessPreferredTier` (`settingsconfig.go`).

Run: `task generate`

Expected:
- `metaconsts.go` loses `ConfigKey_HarnessPreferredTier`;
- `gotypes.d.ts` loses `tier` on `Run`, `RunSpec`, `CommandCreateRunData`, `CommandDagActionData` and `RouteCapabilityInfo`, and `RoutePin.tier` becomes optional;
- `schema/settings.json` loses `harness:preferredtier`.

- [ ] **Step 5: Backend consumers**

`pkg/orchestrate/engine.go`, `effectiveTaskRoute`:

```go
	if task.RunSpec.Runtime != "" || task.RunSpec.Model != "" {
		runtime := task.RunSpec.Runtime
		if runtime == "" {
			runtime = owner.Runtime
		}
		return waveobj.RoutePin{Runtime: runroute.DefaultRuntime(runtime), Model: task.RunSpec.Model}
	}
	if group != nil && group.WorkerRoute != nil && (group.WorkerRoute.Runtime != "" || group.WorkerRoute.Model != "") {
		return waveobj.RoutePin{Runtime: runroute.DefaultRuntime(group.WorkerRoute.Runtime), Model: group.WorkerRoute.Model}
	}
	return waveobj.RoutePin{Runtime: runroute.DefaultRuntime(owner.Runtime), Model: owner.Model}
```

Keep the function's existing nil-owner guard, if it has one. `childRunFromSpec` deletes `run.Tier = route.Tier`.

`pkg/orchestrate/dag.go:288`: drop `ta.RunSpec.Tier != tb.RunSpec.Tier ||`.

`pkg/orchestrate/liveness.go:87`: the comment references `runroute.DefaultRuntime` instead of `runroute.NormalizeLegacy`.

`pkg/jarvis/runexec.go:118`: `fmt.Errorf("no unattended run worker adapter for runtime %q model %q", cap.Runtime, cap.Model)`.

`pkg/wshrpc/wshserver/wshserver.go`, `validatePreferredRoutePatch`:
- read only the runtime and model keys;
- `if !runtimePresent && !modelPresent { return nil }`;
- a model change with an empty resolved runtime fails with `preferred route runtime must be set whenever the model changes`;
- otherwise `runroute.Resolve(waveobj.RoutePin{Runtime: runtime, Model: model})`.

Keep the existing type checks on each value, and the merge with the persisted settings for keys not in the patch.

`wshserver_dag.go:37-54`:

```go
	ownerPin := waveobj.RoutePin{Runtime: runroute.DefaultRuntime(run.Runtime), Model: run.Model}
```

When a task has `RunSpec.Runtime` or `RunSpec.Model`, its pin is `{Runtime: RunSpec.Runtime, or else ownerPin.Runtime; Model: RunSpec.Model}`. Delete the "runtime and tier must be provided together" case. At `:314`: `target := waveobj.RoutePin{Runtime: data.Runtime, Model: data.Model}`.

`wshserver_runs.go`:
- `:208` → `pin := waveobj.RoutePin{Runtime: runroute.DefaultRuntime(run.Runtime), Model: run.Model}`;
- `:317` → `runroute.Resolve(waveobj.RoutePin{Runtime: data.Runtime, Model: data.Model})`;
- `:356` → delete `run.Tier = cap.Tier`;
- `:468` → `pin := waveobj.RoutePin{Runtime: runroute.DefaultRuntime(parent.Runtime), Model: parent.Model}`;
- `:482` → `child.Model = cap.Model`, so a child inherits its parent's model the way it inherited the tier.

`wshserver_jarvis.go`:
- `:379` → remove `Tier: capability.Tier`;
- the `:363` comment stops mentioning legacy tiers.

- [ ] **Step 6: Compile-driven test updates**

Run: `go vet ./pkg/runroute/ ./pkg/waveobj/ ./pkg/orchestrate/ ./pkg/jarvis/ ./cmd/wsh/...`, plus `go vet ./pkg/wshrpc/wshserver/` with `CGO_CFLAGS` set. Fix each build error by these rules. The grep `\.Tier\b|\bTier:|NormalizeLegacy|HarnessPreferredTier` over `pkg/**/*_test.go` must return no route-tier hits when done. The channel autonomy `data.Tier` stays.

**Deleted fields:**
- `owner.Tier = ...`, `run.Tier = ...`, `Tier:` in a `CommandCreateRunData` or `RunSpec` literal: delete the assignment.
- An assertion on `child.Tier`, `cap.Tier` or `spawnedWith.Tier`: assert on `Model` instead, with the model that route now resolves to (`""` for a runtime default, the pinned model otherwise).

**RoutePin literals:** delete `Tier:` from every `waveobj.RoutePin{...}` literal in tests. A pin whose only purpose was a bad tier (`Tier: "strong"`, `Tier: "missing"`) becomes the equivalent bad model (`Model: "gpt-5.4"` on claude), or is deleted when the case only tested tier validation.

**Tests tied to removed behavior:**
- The `seedEscalationDag` and `seedDagActionEscalation` tier parameter: remove the parameter and every argument.
- `b1b_workerroute_test.go`:
  - delete `TestEffectiveTaskRoute_WorkerRouteTierFallback`;
  - in `TestEffectiveTaskRoute_TaskPinWinsOverWorkerRoute`, the task pin runtime becomes `"pi"`.
- `engine_test.go` `TestScheduleOnceLegacyRuntimeOnlyAndInheritedRoutes`: remove `owner.Tier`, and expect `claude` and `pi` capabilities with `Model == ""` and children with `Model == ""`. Rewrite the pi/mid comment to say a runtime-only pin resolves to the runtime default.
- `wshserver_dag_test.go` route validation table (`:346-349`):
  - `tier-only` becomes `model-only` (`RunSpec{Model: "sonnet"}`), which is valid because it inherits the owner runtime; move it to the accepted cases, or delete it if the table only lists rejections;
  - `unknown-runtime` keeps `Runtime: "missing"`;
  - `unknown-tier` becomes `bad-model` (`Runtime: "pi", Model: "sonnet"`);
  - `unsupported-pair` becomes `Runtime: "codex"`.
- `wshserver_run_test.go`:
  - create-run cases with `opencode` become `pi`;
  - the tier table at `:400` keeps only its runtime/model cases;
  - the legacy-run spawn test (`:549-557`) expects claude with `Model == ""`.
- `wshserver_childrun_test.go`: the opencode parent becomes pi, and the `child.Tier` checks become `child.Model` checks.
- `wshserver_spawn_test.go:60`: `opencode` → `pi`, with `Model` asserted instead of `Tier`.
- `wshserver_routeconfig_test.go`: remove every `ConfigKey_HarnessPreferredTier` entry. The type-error case that set tier to `1` sets the model to `1` instead.
- `wshserver_harness_test.go:83`: delete the `Tier:` line.
- `runexec_test.go`: resolve with `RoutePin{Runtime: X}` (runtime default) or `RoutePin{Runtime: "claude", Model: "haiku"}`. The forged capability becomes a claude haiku capability with `ModelArgs = nil`.

- [ ] **Step 7: Run the Go suites**

Run from PowerShell with `CGO_CFLAGS` set: `go test ./pkg/runroute/ ./pkg/waveobj/ ./pkg/harness/ ./pkg/orchestrate/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/ ./pkg/wconfig/ ./cmd/wsh/... -count=1`

Expected: PASS.

---

### Task 4: Rewrite saved tier pins once at server start

**Files:**
- Modify: `pkg/wstore/wstore_channelrows.go` (export `SingletonMetaBool` and `MarkSingletonMetaBool`, and update its 4 call sites)
- Create: `pkg/jarvis/routemigrate.go`
- Create: `pkg/jarvis/routemigrate_test.go`
- Modify: `cmd/server/main-server.go`, after `wconfig.MigratePresetsBackgrounds()`

**Interfaces:**
- Consumes:
  - `runroute.MigrateTierPin`;
  - `jarvis.LoadGlobalProfile`, `SaveGlobalProfile`, `OverrideFromMeta` and `MetaKey_JarvisProfile`;
  - `wconfig.ReadWaveHomeConfigFile` and `WriteWaveHomeConfigFile`;
  - `wstore.GetChannels`, `DBGetAllObjsByType`, `DBUpdateFn` and `UpdateDag`.
- Produces: `jarvis.MigrateTierPins(ctx context.Context) error` and `jarvis.MetaKey_TierPinsMigrated`.

- [ ] **Step 1: Write the failing test**

The test seeds each store in a tier-pinned state. It uses the package's `TestMain` store, and `withConfigHome` from `profile_test.go` for the settings and profile files. It calls `migrateTierPinsOnce` directly, because the MainServer marker is a boot concern that the test store may not have a row for.

```go
func TestMigrateTierPinsRewritesEveryStore(t *testing.T) {
	ctx := context.Background()
	withConfigHome(t, t.TempDir())
	if err := wconfig.WriteWaveHomeConfigFile(wconfig.SettingsFile, waveobj.MetaMapType{
		wconfig.ConfigKey_HarnessPreferredRuntime: "claude",
		"harness:preferredtier":                   "mid",
	}); err != nil {
		t.Fatal(err)
	}
	profile := LoadGlobalProfile()
	profile.WorkerRoute = &waveobj.RoutePin{Runtime: "claude", Tier: "cheap"}
	if err := SaveGlobalProfile(profile); err != nil {
		t.Fatal(err)
	}
	ch, err := wstore.CreateChannel(ctx, "tier-migrate", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	seedOverride(t, ctx, ch.OID, &waveobj.ProfileOverride{
		Route:       &waveobj.RoutePin{Runtime: "claude", Tier: "capable"},
		WorkerRoute: &waveobj.RoutePin{Runtime: "claude", Tier: "mid"},
	})
	run := NewRun("tier run", "ws-1", t.TempDir(), nil, RunMode_Orchestrator, DefaultOrchestratorPlaybook(false), 1)
	run.WorkerRoute = &waveobj.RoutePin{Runtime: "claude", Tier: "cheap"}
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatal(err)
	}
	dag := seedTierDag(t, ctx, ch.OID, run.ID, &waveobj.RoutePin{Runtime: "pi", Tier: "capable"})

	if err := migrateTierPinsOnce(ctx); err != nil {
		t.Fatal(err)
	}

	settings, _ := wconfig.ReadWaveHomeConfigFile(wconfig.SettingsFile)
	if _, present := settings["harness:preferredtier"]; present || settings[wconfig.ConfigKey_HarnessPreferredModel] != consult.MidModel {
		t.Fatalf("settings = %+v, want the tier moved into the preferred model", settings)
	}
	if got := LoadGlobalProfile().WorkerRoute; got == nil || *got != (waveobj.RoutePin{Runtime: "claude", Model: consult.CheapModel}) {
		t.Fatalf("global worker route = %+v", got)
	}
	storedCh, err := wstore.GetChannel(ctx, ch.OID)
	if err != nil {
		t.Fatal(err)
	}
	override := OverrideFromMeta(storedCh)
	if override == nil || *override.Route != (waveobj.RoutePin{Runtime: "claude"}) || *override.WorkerRoute != (waveobj.RoutePin{Runtime: "claude", Model: consult.MidModel}) {
		t.Fatalf("channel override = %+v", override)
	}
	storedRun, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if storedRun.WorkerRoute == nil || *storedRun.WorkerRoute != (waveobj.RoutePin{Runtime: "claude", Model: consult.CheapModel}) {
		t.Fatalf("run worker route = %+v", storedRun.WorkerRoute)
	}
	storedDag, err := wstore.GetDag(ctx, dag.OID)
	if err != nil {
		t.Fatal(err)
	}
	if storedDag.WorkerRoute == nil || *storedDag.WorkerRoute != (waveobj.RoutePin{Runtime: "pi"}) {
		t.Fatalf("dag worker route = %+v", storedDag.WorkerRoute)
	}

	// a second pass finds nothing to rewrite and leaves the results intact
	if err := migrateTierPinsOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if got := LoadGlobalProfile().WorkerRoute; got == nil || got.Model != consult.CheapModel {
		t.Fatalf("second pass changed the global worker route: %+v", got)
	}
}
```

`seedOverride` writes the override through the same meta write that `SetChannelProfileCommand` uses. `seedTierDag` builds a minimal `waveobj.TaskGroup` (OID `uuid.NewString()`, `ChannelId`, `RunID`, one task `{ID: "t-0", Label: "a"}`, `WorkerRoute`) and stores it with `wstore.AppendDag`. It can't use `orchestrate.NewTaskGroup`, because orchestrate imports jarvis. If the file already has an equivalent seeding helper, reuse it and don't add one.

Also add a test that a missing settings file is not an error: `withConfigHome(t, t.TempDir())`, and `migratePreferredTier()` returns nil without creating `settings.json`.

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestMigrateTierPins -count=1`

Expected: FAIL (build: `migrateTierPinsOnce` undefined).

- [ ] **Step 3: Implement `pkg/jarvis/routemigrate.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// MetaKey_TierPinsMigrated marks, on the MainServer singleton, that saved tier pins were rewritten to models.
const MetaKey_TierPinsMigrated = "jarvis:tierpinsmigrated"

// the setting was deleted with tiers; only this pass still names it
const settingsKeyPreferredTier = "harness:preferredtier"

// MigrateTierPins rewrites every saved route pin that still names a tier, once per data dir. Every
// step is idempotent, so a pass that fails part way is simply run again on the next boot.
func MigrateTierPins(ctx context.Context) error {
	done, err := wstore.SingletonMetaBool(ctx, MetaKey_TierPinsMigrated)
	if err != nil || done {
		return err
	}
	if err := migrateTierPinsOnce(ctx); err != nil {
		return err
	}
	return wstore.MarkSingletonMetaBool(ctx, MetaKey_TierPinsMigrated)
}

func migrateTierPinsOnce(ctx context.Context) error {
	if err := migratePreferredTier(); err != nil {
		return fmt.Errorf("migrating %s: %w", settingsKeyPreferredTier, err)
	}
	if err := migrateGlobalProfilePins(); err != nil {
		return fmt.Errorf("migrating the global profile worker route: %w", err)
	}
	if err := migrateChannelPins(ctx); err != nil {
		return err
	}
	if err := migrateRunPins(ctx); err != nil {
		return err
	}
	return migrateDagPins(ctx)
}

// migratePin rewrites a stored pin in place and reports whether it changed.
func migratePin(pin *waveobj.RoutePin) bool {
	if pin == nil {
		return false
	}
	next, changed := runroute.MigrateTierPin(*pin)
	*pin = next
	return changed
}

func migratePreferredTier() error {
	m, cerrs := wconfig.ReadWaveHomeConfigFile(wconfig.SettingsFile)
	if len(cerrs) > 0 {
		return fmt.Errorf("reading %s: %v", wconfig.SettingsFile, cerrs[0])
	}
	rawTier, present := m[settingsKeyPreferredTier]
	if !present {
		return nil
	}
	tier, _ := rawTier.(string)
	runtime, _ := m[wconfig.ConfigKey_HarnessPreferredRuntime].(string)
	model, _ := m[wconfig.ConfigKey_HarnessPreferredModel].(string)
	pin, _ := runroute.MigrateTierPin(waveobj.RoutePin{Runtime: runtime, Model: model, Tier: tier})
	if pin.Model != "" {
		m[wconfig.ConfigKey_HarnessPreferredModel] = pin.Model
	}
	delete(m, settingsKeyPreferredTier)
	return wconfig.WriteWaveHomeConfigFile(wconfig.SettingsFile, m)
}

func migrateGlobalProfilePins() error {
	profile := LoadGlobalProfile()
	if !migratePin(profile.WorkerRoute) {
		return nil
	}
	return SaveGlobalProfile(profile)
}

func migrateChannelPins(ctx context.Context) error {
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return fmt.Errorf("listing channels: %w", err)
	}
	for _, ch := range channels {
		override := OverrideFromMeta(ch)
		if override == nil {
			continue
		}
		routeChanged := migratePin(override.Route)
		workerChanged := migratePin(override.WorkerRoute)
		if !routeChanged && !workerChanged {
			continue
		}
		if err := wstore.DBUpdateFn(ctx, ch.OID, func(c *waveobj.Channel) {
			// same encoding SetChannelProfileCommand writes
			c.Meta[MetaKey_JarvisProfile] = override
		}); err != nil {
			return fmt.Errorf("migrating channel %s profile route: %w", ch.OID, err)
		}
	}
	return nil
}

func migrateRunPins(ctx context.Context) error {
	runs, err := wstore.DBGetAllObjsByType[*waveobj.Run](ctx, waveobj.OType_Run)
	if err != nil {
		return fmt.Errorf("listing runs: %w", err)
	}
	for _, run := range runs {
		if !migratePin(run.WorkerRoute) {
			continue
		}
		route := *run.WorkerRoute
		if err := wstore.DBUpdateFn(ctx, run.OID, func(r *waveobj.Run) { r.WorkerRoute = &route }); err != nil {
			return fmt.Errorf("migrating run %s worker route: %w", run.ID, err)
		}
	}
	return nil
}

func migrateDagPins(ctx context.Context) error {
	dags, err := wstore.DBGetAllObjsByType[*waveobj.TaskGroup](ctx, waveobj.OType_Dag)
	if err != nil {
		return fmt.Errorf("listing dags: %w", err)
	}
	for _, g := range dags {
		if !migratePin(g.WorkerRoute) {
			continue
		}
		route := *g.WorkerRoute
		if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
			cur.WorkerRoute = &route
			return nil
		}); err != nil {
			return fmt.Errorf("migrating dag %s worker route: %w", g.OID, err)
		}
	}
	return nil
}
```

Before relying on this code, verify it against the real signatures and adapt the calls. Don't adapt the behaviour:
- the `ConfigError` shape;
- whether `ReadWaveHomeConfigFile` reports a missing file as an error (the missing-file test pins this);
- whether `LoadGlobalProfile` returns a value or a pointer;
- how `SetChannelProfileCommand` encodes the override into meta (a struct, a map, or a JSON string);
- whether `GetChannels` returns pointers;
- the Run OType constant name.

`pkg/wstore/wstore_channelrows.go`: rename `singletonMetaBool` to `SingletonMetaBool` and `markSingletonMetaBool` to `MarkSingletonMetaBool`, updating the doc comments and the 4 call sites.

`cmd/server/main-server.go`, after `wconfig.MigratePresetsBackgrounds()`:

```go
	if err := jarvis.MigrateTierPins(context.Background()); err != nil {
		log.Printf("error migrating route tier pins: %v\n", err)
	}
```

First confirm the MainServer row exists by that point in startup. If it doesn't, the marker is skipped and the idempotent pass runs again next boot, which is harmless.

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./pkg/jarvis/ ./pkg/wstore/ -count=1` and `go build ./cmd/server/` (CGO env set).

Expected: PASS and the build succeeds.

---

### Task 5: Frontend routes are runtime plus model

**Files:**
- Modify: `frontend/app/view/agents/route.ts`, `route.test.ts`
- Modify: `frontend/app/view/agents/harnessstore.ts`, `harnessstore.test.ts`
- Modify: `frontend/app/view/agents/cockpitshell.tsx:28-32`, `runactions.ts:85`, `:193-201`, `runactions.test.ts`
- Modify: `frontend/app/view/agents/routepicker.tsx:228`, `:254`, `:262`, `channelcomposers.tsx:131-134`
- Modify: `frontend/app/view/orchestrate/dagstore.ts`, `dagstore.test.ts`, `daggraph.tsx:57`, `:76`, `:246`, `:306-307`, `plangate.ts:78-97`, `plangate.test.ts`, `escalate.test.ts:20`
- Modify: `frontend/app/view/jarvis/runsettings.ts:130-233`, `runsettings.test.ts`, `profilemodel.ts:192`, `profilemodel.test.ts`, `briefrunsheet.tsx:90-92`
- Modify: `frontend/app/view/settings/settingsmodel.ts:181`, `:187` (and its test, if the copy is asserted)
- Modify: any other test the typecheck or vitest names, e.g. `composercommand.test.ts:155`, `orchestratorpicker.test.ts:66-72`, `runconfig.test.ts:142`, `runconfigstore.test.ts:30`, `newrun.test.ts`, `launch.test.ts`, `harnesspicker.test.ts`

**Interfaces:**
- Consumes: the generated `RoutePin` (`runtime`, `model?`, `tier?`) and `RouteCapabilityInfo` without `tier`.
- Produces:
  - `normalizeRoute(runtime: string, model?: string): RoutePin | null`;
  - `capabilityFor(caps, pin)`, which matches the exact model and otherwise falls back to the runtime-default row;
  - `modelFace(pin): string` (`pin.model || "default"`);
  - `beginSave(state, route: RoutePin)`;
  - `initHarnessPreference(persistedRuntime: string, persistedModel = "")`.

- [ ] **Step 1: Write the failing tests**

`route.test.ts`: replace the `normalizeLegacyRoute` and `routeForRuntime` tests, and every tier fixture, with:

```ts
describe("normalizeRoute", () => {
    it("drops a route with no runtime", () => {
        expect(normalizeRoute("", "sonnet")).toBeNull();
    });
    it("keeps the model when there is one", () => {
        expect(normalizeRoute("claude", "sonnet")).toEqual({ runtime: "claude", model: "sonnet" });
        expect(normalizeRoute("pi")).toEqual({ runtime: "pi" });
    });
});

describe("capabilityFor", () => {
    const caps: RouteCapabilityInfo[] = [
        { runtime: "claude", resolvedmodel: "operator default" },
        { runtime: "claude", model: "haiku", resolvedmodel: "haiku" },
    ];
    it("matches an exact model", () => {
        expect(capabilityFor(caps, { runtime: "claude", model: "haiku" })?.model).toBe("haiku");
    });
    it("falls back to the runtime default for a model outside the catalog", () => {
        expect(capabilityFor(caps, { runtime: "claude", model: "claude-custom-1" })?.resolvedmodel).toBe("operator default");
    });
    it("finds nothing for another runtime", () => {
        expect(capabilityFor(caps, { runtime: "pi" })).toBeUndefined();
    });
});

it("modelFace names the default when a route has no model", () => {
    expect(modelFace({ runtime: "pi" })).toBe("default");
    expect(modelFace({ runtime: "claude", model: "opus" })).toBe("opus");
});
```

Before writing these, confirm the current `capabilityFor` argument order and the `RouteCapabilityInfo` field names in `route.ts`, and match them.

The remaining `resolveEffectiveRoute` and `normalizeProfileOverrideRoute` tests drop tier from fixtures and expectations. `normalizeProfileOverrideRoute` now keeps the override's model.

`harnessstore.test.ts`:
- remove codex rows and every `tier`;
- `setPreferredRoute` sends exactly `{"harness:preferredruntime", "harness:preferredmodel"}`;
- `setPreferredHarness` errors when the runtime has no runtime-default row;
- `initHarnessPreference("claude", "sonnet")` yields `{ runtime: "claude", model: "sonnet" }`.

`dagstore.test.ts`, `plangate.test.ts`, `runsettings.test.ts`, `profilemodel.test.ts`, `runactions.test.ts`, `escalate.test.ts`: drop `tier` from fixtures, and replace `capable` expectations with the model or `default`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run frontend/app/view/agents/route.test.ts frontend/app/view/agents/harnessstore.test.ts`

Expected: FAIL (`normalizeRoute` is not exported).

- [ ] **Step 3: Implement**

`route.ts`:

```ts
export function normalizeRoute(runtime: string, model?: string): RoutePin | null {
    if (!runtime) return null;
    return { runtime, ...(model ? { model } : {}) };
}

export function capabilityFor(caps: RouteCapabilityInfo[], pin: RoutePin): RouteCapabilityInfo | undefined {
    const model = pin.model ?? "";
    return (
        caps.find((c) => c.runtime === pin.runtime && (c.model ?? "") === model) ??
        caps.find((c) => c.runtime === pin.runtime && (c.model ?? "") === "")
    );
}

export function modelFace(pin: RoutePin): string {
    return pin.model || "default";
}
```

Also in `route.ts`:
- delete `normalizeLegacyRoute` and `routeForRuntime`;
- `resolveEffectiveRoute` calls `normalizeRoute(raw.runtime, raw.model)`;
- `normalizeProfileOverrideRoute` calls `normalizeRoute(override.route.runtime, override.route.model)`;
- the header comment describes a route as a runtime plus an optional exact model.

`harnessstore.ts`:
- delete `toPin`, and give `beginSave(state, route: RoutePin)` that signature;
- `setPreferredRoute` compares only runtime and model, and patches only `harness:preferredruntime` and `harness:preferredmodel`;
- `setPreferredHarness(runtime)` finds `routecapabilities` rows with `(c.model ?? "") === ""`, sets an error when there is none, and chooses `{ runtime, ...(current.route?.runtime === runtime && current.route.model ? { model: current.route.model } : {}) }`;
- `initHarnessPreference(persistedRuntime: string, persistedModel = "")` uses `normalizeRoute(persistedRuntime, persistedModel)`.

Consumers:
- `cockpitshell.tsx`: stop reading `harness:preferredtier` and pass `(runtime, model)`.
- `runactions.ts`:
  - `:85` → delete the `tier:` line;
  - `:193-201` → `normalizeRoute(settingsRuntime, settingsModel)`, with no settings tier.
- `routepicker.tsx`: remove `tier: ""` from the three `choose(...)` calls.
- `channelcomposers.tsx`: `leadFace: route ? modelFace(route) : "unset"` and `workerFace: workerRoute ? modelFace(workerRoute) : null`.
- `dagstore.ts`:
  - `DagNodeRoute` drops `tier`;
  - `normalizeRunPin` → `{ runtime: run.runtime ?? "", ...(run.model ? { model: run.model } : {}) }`;
  - `normalizeSpecPin` is the same over `spec`;
  - the fallback pin is `{ runtime: "" }`.
- `daggraph.tsx`:
  - `data-dag-node-route` becomes `${source}:${runtime}:${model ?? ""}`;
  - the route text shows `{runtime} / {model || "default"}`;
  - `:246` shows `owner.model || "default"`.
- `plangate.ts`: `pinText(runtime, model)` renders `[runtime, model || "default"]`, and both callers drop tier.
- `jarvis/runsettings.ts`:
  - `draftSeedKey` and `sameRoute` drop tier;
  - `leadRouteOf` → `{ runtime: run.runtime, ...(run.model ? { model: run.model } : {}) }`;
  - `routeLabel` → `[route.runtime, route.model || "default"]`.
- `profilemodel.ts:192` → `{ runtime: o.route.runtime, ...(o.route.model ? { model: o.route.model } : {}) }`.
- `briefrunsheet.tsx:92` → `[run.runtime || "claude", run.model || "default"]`, with the comment updated.
- `settingsmodel.ts:181`, `:187`: copy that says "harness and tier" says "harness and model".

- [ ] **Step 4: Run to verify they pass**

Run:
- `npx vitest run frontend/app/view/agents frontend/app/view/orchestrate frontend/app/view/jarvis frontend/app/view/settings`
- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

Expected: tests PASS and typecheck exits 0.

Finally, grep `frontend/app` for `\btier\b`. Only autonomy tiers (`JarvisTier`, `autonomyladder`, `briefautonomy`, `setChannelTier`, `petacts`, `jarviscards`) may remain, plus usage and consult code unrelated to routes.

---

### Task 6: Verify and commit

- [ ] **Step 1: Full verification**

**Go**, from PowerShell with `CGO_CFLAGS` set:
- `gofmt -l pkg cmd` prints nothing for touched files;
- `go vet` on the touched packages;
- `go test ./pkg/... ./cmd/... -count=1`.

Report any failing package with its output. A failure that also fails at `adfcbebc` is pre-existing; say so, with evidence.

**Frontend:**
- `npx vitest run` (full);
- the tsc typecheck;
- `npx eslint` on touched frontend files.

**Generated files:** `task generate` again produces no diff.

- [ ] **Step 2: Self-review the diff**

Run `git diff --stat` and `git diff`. Check that:
- nothing outside this slice is staged;
- there's no commented-out code or debug output;
- every `docs/deferred.md` recovery command names a real path at `adfcbebc`.

- [ ] **Step 3: Commit**

Re-check `git status`, then stage only this slice's files, including this plan. Commit with a message describing the user-visible outcome, for example `feat(orchestrate): routes name a model, not a tier, and run workers are claude and pi only`, with a body that names the migration and the deferral. Add no co-author or session trailer, and don't push.

- [ ] **Step 4: Mark effort chunk 3 done** on Wave initiative effort `aeabb4ad-a19c-4f5d-bba2-44586b73af16`.
