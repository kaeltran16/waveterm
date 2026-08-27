# Persistent Orchestrator Lead Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace disposable preflight DAG planning and task-list approval with a persistent orchestrator lead that starts immediately, publishes typed tasks when useful, and automatically starts a validated DAG.

**Architecture:** The composer creates a normal orchestrator run on the exact selected route. The existing lead decides between direct execution and Pi task/DAG execution, while the deterministic DAG engine retains scheduling, worktrees, dependencies, gates, and task controls. The local draft modal and planner RPC are removed; only persisted live DAGs remain in the graph UI.

**Tech Stack:** React 19, TypeScript, jotai, Vitest, Go, wshrpc code generation, Pi task tools, Wave DAG engine.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-26-persistent-orchestrator-lead-design.md` as the source of truth.
- Do not add a mandatory or optional task-list approval step.
- Preserve explicit consequential DAG task gates and child AskUserQuestion handling.
- Do not add a replacement headless consult, Markdown parser, or normalization model call.
- Preserve exact selected-model routing for the lead and inherited children.
- Do not hand-edit generated files; run `task generate` after removing wshrpc types.
- Avoid new SCSS; use existing Tailwind utilities for touched UI.
- Do not commit or push implementation changes in this effort. Replace each commit step with a diff checkpoint.
- The final real DAG run may not start until the user explicitly approves the engine's required internal child-worktree commits. Wave must never push them.
- The working tree contains abandoned preflight-planner fixes. Remove that path cleanly rather than layering the persistent-lead design on top of it.

---

## File map

### Direct launch

- Modify `frontend/app/view/agents/composercommand.ts` — make every run shape resolve to a normal run creation decision.
- Modify `frontend/app/view/agents/composercommand.test.ts` — prove orchestrator mode and exact route are preserved.
- Modify `frontend/app/view/agents/channelcomposers.tsx` — replace “review DAG” footer copy with persistent-lead behavior.
- Modify `frontend/app/view/jarvis/stagecomposer.tsx` — create the orchestrator run directly and preserve the goal on creation failure.

### Ungated persistent lead

- Modify `pkg/wshrpc/wshserver/wshserver_runs.go` — always construct new orchestrator phases without a plan gate.
- Modify `pkg/wshrpc/wshserver/wshserver_run_test.go` — prove profile/request gate values cannot re-enable orchestrator plan approval.
- Modify `pkg/jarvis/run.go` — remove plan-review branches from lead prompts and require self-contained Pi task descriptions.
- Modify `pkg/jarvis/run_test.go` and `pkg/jarvis/run_dagprompt_test.go` — prove adaptive, typed-task behavior without plan approval.
- Modify `pkg/jarvis/runexec.go` — call the simplified orchestrator prompt builder.
- Modify `frontend/app/view/jarvis/profilepanel.tsx` — remove orchestrator plan-gate controls.
- Modify `frontend/app/view/agents/composercommand.ts` and tests — derive pipeline footer gate copy from playbook phases, not legacy `defaultplangate`.
- Modify `frontend/app/view/agents/runmodel.ts` and tests — remove the unused plan-gate composer summary.

### Live-only DAG surface

- Modify `frontend/app/view/orchestrate/dagmodal.tsx` — render persisted live DAGs only.
- Modify `frontend/app/view/orchestrate/dagmodalstate.ts` and test — retain only live open/close state.
- Delete `frontend/app/view/orchestrate/dagdraftgraph.tsx`.
- Delete `frontend/app/view/orchestrate/dagdraftsummary.tsx`.
- Delete `frontend/app/view/orchestrate/dagdraftview.tsx`.
- Delete `frontend/app/view/orchestrate/daglaunch.ts` and `daglaunch.test.ts`.
- Delete `frontend/app/view/orchestrate/dagplanning.ts` and `dagplanning.test.ts`.
- Delete `frontend/app/view/orchestrate/dagtaskdrawer.tsx`.
- Delete `frontend/app/view/orchestrate/draftmodel.ts` and `draftmodel.test.ts`.
- Delete `frontend/app/view/orchestrate/draftsummary.ts` and `draftsummary.test.ts`.

### Planner RPC removal

- Delete `pkg/jarvis/plandag.go` and `pkg/jarvis/plandag_test.go`.
- Delete `pkg/wshrpc/wshserver/wshserver_plandag_test.go`.
- Modify `pkg/wshrpc/wshserver/wshserver_jarvis.go` — remove planner command and planner-only catalog adapters.
- Modify `pkg/wshrpc/wshserver/wshserver_harness_test.go` — remove the planner-only pin test while preserving harness catalog coverage.
- Delete `pkg/wshrpc/wshserver/wshserver_jarvis_catalog_test.go` — it contains only planner-route warning coverage.
- Modify `pkg/wshrpc/wshrpctypes_jarvis.go` — remove planner command and DTOs.
- Modify `pkg/consult/consult.go`, `pkg/consult/consult_test.go`, and `pkg/consult/openrouter.go` — remove exact-model/sentinel additions that become unused with the planner.
- Regenerate `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, and `pkg/wshrpc/wshclient/wshclient.go` with `task generate`.

### Verification evidence

- Modify `docs/handoff/2026-08-26-jarvis-orchestrator-open-ended-improvement-run.md`.
- Add real screenshots under `docs/handoff/assets/2026-08-26-jarvis-orchestrator/`.

---

### Task 1: Launch Orchestrator as a normal persistent-lead run

**Files:**
- Modify: `frontend/app/view/agents/composercommand.ts`
- Modify: `frontend/app/view/agents/composercommand.test.ts`
- Modify: `frontend/app/view/agents/channelcomposers.tsx`
- Modify: `frontend/app/view/jarvis/stagecomposer.tsx`

**Interfaces:**
- Consumes: `RoutePin`, `RunShape`, `createRun(channelId, goal, route, { mode })`.
- Produces: `RunCreationDecision` with `kind: "create-run"` and `mode: "pipeline" | "orchestrator" | "quick"`; no `DagDraftRequest` or `dag-draft` decision.

- [ ] **Step 1: Replace the orchestrator draft expectation with a failing direct-run test**

In `frontend/app/view/agents/composercommand.test.ts`, replace the current orchestrator test with:

```ts
it("creates an orchestrator lead directly on the exact route", () => {
    expect(
        resolveRunCreationDecision({
            channelId: "channel-1",
            goal: "plan migration",
            shape: "orchestrator",
            route,
        })
    ).toEqual({
        kind: "create-run",
        channelId: "channel-1",
        goal: "plan migration",
        mode: "orchestrator",
        route: route.pin,
    });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run frontend/app/view/agents/composercommand.test.ts
```

Expected: FAIL because the implementation still returns `kind: "dag-draft"`.

- [ ] **Step 3: Collapse run-shape resolution to one create-run path**

In `frontend/app/view/agents/composercommand.ts`:

```ts
export type RunCreationDecision =
    | {
          kind: "create-run";
          channelId: string;
          goal: string;
          mode: RunShape;
          route: RoutePin;
      }
    | { kind: "blocked"; focusRoute: boolean; reason: string };

export function resolveRunCreationDecision(input: {
    channelId: string;
    goal: string;
    shape: RunShape;
    route: EffectiveRoute | null;
}): RunCreationDecision {
    if (input.route == null || input.route.capability == null) {
        return { kind: "blocked", focusRoute: true, reason: "Choose an available route" };
    }
    return {
        kind: "create-run",
        channelId: input.channelId,
        goal: input.goal,
        mode: input.shape,
        route: input.route.pin,
    };
}
```

Delete `DagDraftRequest` and the `dag-draft` union member.

- [ ] **Step 4: Dispatch the decision directly from StageComposer**

In `frontend/app/view/jarvis/stagecomposer.tsx`:

- remove the `openDagDraft` import;
- remove the `decision.kind === "dag-draft"` branch;
- await `createRun` before clearing the goal and attachments;
- retain the goal if creation rejects.

Use this control flow inside the run dispatch branch:

```ts
try {
    const created = await createRun(decision.channelId, decision.goal, decision.route, {
        mode: decision.mode,
    });
    setActiveRunId(decision.channelId, created.id);
    setDraft("");
    attach.clear();
    setComposingRun(decision.channelId, false);
} catch (error) {
    setLaunchError(String(error));
}
```

Add `const [launchError, setLaunchError] = useState("");`, clear it before each attempt, and render a compact `text-error` line immediately above `LaunchComposer` when non-empty. Do not clear a Radar draft through this ordinary dispatch path.

- [ ] **Step 5: Correct the composer footer**

In `frontend/app/view/agents/channelcomposers.tsx`, replace:

```ts
"→ review DAG before launch"
```

with:

```ts
"→ persistent lead · DAG when useful"
```

- [ ] **Step 6: Run focused frontend checks and confirm GREEN**

Run:

```bash
npx vitest run frontend/app/view/agents/composercommand.test.ts frontend/app/view/agents/runactions.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 7: Diff checkpoint; do not commit**

Run:

```bash
git diff --check
git diff -- frontend/app/view/agents/composercommand.ts frontend/app/view/agents/composercommand.test.ts frontend/app/view/agents/channelcomposers.tsx frontend/app/view/jarvis/stagecomposer.tsx
```

Confirm the goal is cleared only after `createRun` succeeds and no draft-modal import remains.

---

### Task 2: Remove orchestrator plan approval and strengthen the persistent-lead prompt

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_run_test.go`
- Modify: `pkg/jarvis/run.go`
- Modify: `pkg/jarvis/run_test.go`
- Modify: `pkg/jarvis/run_dagprompt_test.go`
- Modify: `pkg/jarvis/runexec.go`
- Modify: `frontend/app/view/jarvis/profilepanel.tsx`
- Modify: `frontend/app/view/agents/composercommand.ts`
- Modify: `frontend/app/view/agents/composercommand.test.ts`
- Modify: `frontend/app/view/agents/runmodel.ts`
- Modify: `frontend/app/view/agents/runmodel.test.ts`

**Interfaces:**
- Consumes: persisted legacy `JarvisProfile.DefaultPlanGate`, `RunMode_Orchestrator`, Pi task tools, `wsh jarvis dag import-tasks`.
- Produces: `BuildOrchestratePrompt(goal string, principles waveobj.PrincipleList, runtime string) string`; every newly resolved orchestrator playbook has `Gate == false`.

- [ ] **Step 1: Add failing server tests proving legacy gate settings are ignored**

In `pkg/wshrpc/wshserver/wshserver_run_test.go`, replace the existing orchestrator gate assertions around `resolveRunPlan` with:

```go
func TestResolveRunPlanOrchestratorIsAlwaysUngated(t *testing.T) {
    enabled := true
    disabled := false
    cases := []struct {
        name     string
        profile  waveobj.JarvisProfile
        request  *bool
    }{
        {name: "request enabled", request: &enabled},
        {name: "profile enabled", profile: waveobj.JarvisProfile{DefaultPlanGate: &enabled}},
        {name: "request disabled", request: &disabled},
        {name: "unset"},
    }
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            mode, phases := resolveRunPlan(tc.profile, jarvis.RunMode_Orchestrator, tc.request)
            if mode != jarvis.RunMode_Orchestrator || len(phases) != 1 || phases[0].Gate {
                t.Fatalf("mode=%q phases=%+v", mode, phases)
            }
        })
    }
}
```

- [ ] **Step 2: Add failing prompt tests for autonomous typed-task publication**

Update `pkg/jarvis/run_dagprompt_test.go` to call the new three-argument signature and assert the Pi prompt includes all of:

```go
for _, want := range []string{
    "wsh jarvis dag import-tasks",
    "wsh jarvis dag status",
    "respond to control events",
    "task-specific goal",
    "relevant evidence",
    "verification",
    "pinned decisions",
    "Goal: ship auth",
} {
    if !strings.Contains(p, want) {
        t.Errorf("pi prompt missing %q", want)
    }
}
for _, unwanted := range []string{"hold <plan-file-path>", "wait for human approval", "plan review"} {
    if strings.Contains(strings.ToLower(p), strings.ToLower(unwanted)) {
        t.Errorf("pi prompt retained plan approval %q", unwanted)
    }
}
```

Update the Claude prompt test to assert adaptive triage remains and `wsh jarvis hold` is absent.

- [ ] **Step 3: Run the Go tests and confirm RED**

Run:

```bash
export CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc'
go test ./pkg/jarvis ./pkg/wshrpc/wshserver -run 'TestResolveRunPlanOrchestratorIsAlwaysUngated|TestBuildOrchestratePrompt' -count=1
```

Expected: compile/test failure because the old prompt signature and gate behavior remain.

- [ ] **Step 4: Make server-side orchestrator resolution unconditionally ungated**

In `resolveRunPlan` inside `pkg/wshrpc/wshserver/wshserver_runs.go`, replace the orchestrator branch with:

```go
if mode == jarvis.RunMode_Orchestrator {
    return mode, jarvis.DefaultOrchestratorPlaybook(false)
}
```

Keep the request/profile fields readable for backward-compatible RPC/profile decoding, but ignore them for orchestrator creation.

- [ ] **Step 5: Remove plan-review branches from lead prompt construction**

Change the public builder to:

```go
func BuildOrchestratePrompt(goal string, principles waveobj.PrincipleList, runtime string) string
```

Update `phasePrompt` in `pkg/jarvis/runexec.go`:

```go
if run.Mode == RunMode_Orchestrator {
    return BuildOrchestratePrompt(run.Goal, run.Principles, run.Runtime)
}
```

For Claude, retain only the existing adaptive triage branch. For Pi, use one autonomous branch with wording equivalent to:

```go
b.WriteString("Size up the goal: if it is a small well-understood change, run `wsh jarvis triage quick \"<reason>\"` and do it directly. Otherwise plan it with the writing-plans approach, create pi-tasks records, and run `wsh jarvis dag import-tasks`; the engine validates and schedules ready children automatically and wakes you with control events — do not babysit. Each task description must include the task-specific goal, relevant evidence and constraints, expected verification, and pinned decisions so the child does not have to rediscover the broad goal. Use `wsh jarvis dag status` for detail.\n")
```

Retain consequential `AskUserQuestion` guidance and final completion reporting. Remove every `wsh jarvis hold` plan-review branch from orchestrator prompts.

- [ ] **Step 6: Update prompt and playbook tests without deleting generic gate-domain coverage**

Update all `BuildOrchestratePrompt` calls to the three-argument signature. Replace tests that distinguish gated/ungated orchestrator prompts with one adaptive prompt contract.

Keep `DefaultOrchestratorPlaybook(gate bool)` and generic `HoldPhase`/`ApproveGate` tests intact; explicit phase gates remain a domain capability even though new orchestrator runs no longer enable a plan gate.

- [ ] **Step 7: Remove orchestrator plan-gate controls from profile UI**

In `frontend/app/view/jarvis/profilepanel.tsx`:

- remove `gate` locals from `GlobalProfileEditor` and `DefaultsSection`;
- remove both conditional “plan gate on by default” checkbox blocks;
- make project default override/reset depend only on `defaultmode`;
- leave legacy `defaultplangate` data round-trippable but ignored.

Use:

```ts
const overridden = draft.defaultmode != null;
```

and:

```ts
onClick={() => setDraft((d) => omit(d, "defaultmode"))}
```

Do not include `defaultplangate` when deciding whether an override has active behavior. Existing stored legacy values may round-trip unchanged; the server ignores them.

- [ ] **Step 8: Make pipeline footer copy derive from actual playbook gates**

In `runFooterFor`:

```ts
if (profile.defaultmode === "orchestrator") {
    return "→ adaptive lead · DAG when useful · set in ⚙";
}
const gate = profile.playbook?.length
    ? profile.playbook.some((phase) => phase.gate)
    : true;
return gate
    ? "→ pipeline run · stops at a review gate · set in ⚙"
    : "→ pipeline run · no gate · set in ⚙";
```

Update `composercommand.test.ts` to construct pipeline profiles with gated and ungated `playbook` phases instead of `defaultplangate`.

Delete the unused `composerSummary(mode, planGate)` export from `frontend/app/view/agents/runmodel.ts` and its three stale plan-gate assertions from `runmodel.test.ts`; `rg` shows it has no production caller.

- [ ] **Step 9: Run focused tests and confirm GREEN**

Run:

```bash
export CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc'
go test ./pkg/jarvis ./pkg/wshrpc/wshserver -count=1
npx vitest run frontend/app/view/agents/composercommand.test.ts frontend/app/view/agents/runmodel.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```

Expected: all commands exit 0.

- [ ] **Step 10: Diff checkpoint; do not commit**

Run:

```bash
git diff --check
git diff -- pkg/jarvis/run.go pkg/jarvis/runexec.go pkg/wshrpc/wshserver/wshserver_runs.go frontend/app/view/jarvis/profilepanel.tsx frontend/app/view/agents/composercommand.ts
```

Confirm there is no orchestrator plan-review branch or writable orchestrator plan-gate control.

---

### Task 3: Reduce the DAG modal to persisted live DAGs

**Files:**
- Modify: `frontend/app/view/orchestrate/dagmodal.tsx`
- Modify: `frontend/app/view/orchestrate/dagmodalstate.ts`
- Modify: `frontend/app/view/orchestrate/dagmodalstate.test.ts`
- Delete: the eight draft/planning implementation files and four tests listed in the file map.

**Interfaces:**
- Consumes: persisted `Run`, `TaskGroup`, `openDagLive(channelId, runId, dagOref)`.
- Produces: `DagModalState = { kind: "live"; channelId; runId; dagOref; error } | null`; `DagModal` renders only `DagGraphView`.

- [ ] **Step 1: Replace modal-state tests with a failing live-only contract**

Rewrite `frontend/app/view/orchestrate/dagmodalstate.test.ts` around these behaviors:

```ts
it("opens a persisted live DAG", () => {
    expect(
        reduceDagModalState(null, {
            type: "open-live",
            channelId: "channel-1",
            runId: "run-1",
            dagOref: "dag:1",
        })
    ).toEqual({
        kind: "live",
        channelId: "channel-1",
        runId: "run-1",
        dagOref: "dag:1",
        error: "",
    });
});

it("closes on escape", () => {
    const live = {
        kind: "live" as const,
        channelId: "channel-1",
        runId: "run-1",
        dagOref: "dag:1",
        error: "",
    };
    expect(reduceDagModalState(live, { type: "escape" })).toBeNull();
});

it("does not reopen the removed local draft flow", () => {
    const removedAction = {
        type: "open-draft",
        requestId: 1,
        request: { channelId: "channel-1", goal: "ship", route: { runtime: "pi", model: "m" } },
    } as never;
    expect(reduceDagModalState(null, removedAction)).toBeNull();
});
```

Remove tests for decomposition, fallback retry, dirty drafts, editing, and launch.

- [ ] **Step 2: Run the modal-state test and confirm RED**

Run:

```bash
npx vitest run frontend/app/view/orchestrate/dagmodalstate.test.ts
```

Expected: compile/test failure while the reducer still exposes draft states and actions.

- [ ] **Step 3: Simplify modal state to live open/close**

Use this state/action boundary in `dagmodalstate.ts`:

```ts
export type DagModalState = {
    kind: "live";
    channelId: string;
    runId: string;
    dagOref: string;
    error: string;
};

export type DagModalAction =
    | { type: "open-live"; channelId: string; runId: string; dagOref: string }
    | { type: "escape" }
    | { type: "close" };
```

`open-live` returns the live object; `escape` and `close` return `null`. Keep `openDagLive`, selection reset, and the development fixture. Remove request IDs, `openDagDraft`, retry rules, draft selectors, and launch actions.

- [ ] **Step 4: Simplify DagModal rendering**

In `dagmodal.tsx`:

- remove planner RPC, coordinator, harness catalog summary, draft launch, retry, and draft view imports;
- retain focus trapping, Escape close, motion, `useWaveObjectValue`, `DagGraphView`, and live run loading;
- remove Ctrl/Cmd+Enter launch handling;
- always render `<LiveDagModal state={state} />` when open.

The body should reduce to:

```tsx
<div className="min-h-0 flex flex-1">
    <LiveDagModal state={state} />
</div>
```

- [ ] **Step 5: Delete local draft/planner files**

Delete exactly:

```text
frontend/app/view/orchestrate/dagdraftgraph.tsx
frontend/app/view/orchestrate/dagdraftsummary.tsx
frontend/app/view/orchestrate/dagdraftview.tsx
frontend/app/view/orchestrate/daglaunch.ts
frontend/app/view/orchestrate/daglaunch.test.ts
frontend/app/view/orchestrate/dagplanning.ts
frontend/app/view/orchestrate/dagplanning.test.ts
frontend/app/view/orchestrate/dagtaskdrawer.tsx
frontend/app/view/orchestrate/draftmodel.ts
frontend/app/view/orchestrate/draftmodel.test.ts
frontend/app/view/orchestrate/draftsummary.ts
frontend/app/view/orchestrate/draftsummary.test.ts
```

- [ ] **Step 6: Prove no frontend draft path remains**

Run:

```bash
rg -n "openDagDraft|DagDraft|JarvisPlanDag|dagplanning|dagdraft|draftmodel|draftsummary|launchDagDraft" frontend/app --glob '*.ts' --glob '*.tsx'
```

Expected: no matches. If a match is a stale import, remove it rather than suppressing the check.

- [ ] **Step 7: Run frontend checks and confirm GREEN**

Run:

```bash
npx vitest run frontend/app/view/orchestrate frontend/app/view/agents/composercommand.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```

Expected: all remaining orchestrate tests pass and typecheck exits 0.

- [ ] **Step 8: Diff checkpoint; do not commit**

Run:

```bash
git diff --check
git diff --stat -- frontend/app/view/orchestrate frontend/app/view/jarvis/stagecomposer.tsx
```

Confirm only draft/planning files were deleted; live graph, layout, store, escalation, and graph-header files remain.

---

### Task 4: Remove the unused planner RPC and consult additions

**Files:**
- Delete: `pkg/jarvis/plandag.go`
- Delete: `pkg/jarvis/plandag_test.go`
- Delete: `pkg/wshrpc/wshserver/wshserver_plandag_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_harness_test.go`
- Delete if planner-only: `pkg/wshrpc/wshserver/wshserver_jarvis_catalog_test.go`
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go`
- Modify: `pkg/consult/consult.go`
- Modify: `pkg/consult/consult_test.go`
- Modify: `pkg/consult/openrouter.go`
- Regenerate: `frontend/app/store/wshclientapi.ts`
- Regenerate: `frontend/types/gotypes.d.ts`
- Regenerate: `pkg/wshrpc/wshclient/wshclient.go`

**Interfaces:**
- Consumes: Task 3's proof that no frontend caller needs the planner RPC.
- Produces: wshrpc surface without `JarvisPlanDagCommand`, `CommandJarvisPlanDagData`, `DagPlanDraft`, `DagPlanTask`, or `CommandJarvisPlanDagRtnData`.

- [ ] **Step 1: Establish the safe-deletion baseline**

Run:

```bash
rg -n "JarvisPlanDag|CommandJarvisPlanDag|DagPlanDraft|DagPlanTask|PlanDag\(" frontend/app pkg --glob '*.ts' --glob '*.tsx' --glob '*.go'
```

Expected before deletion: matches only in the planner implementation, RPC declarations/server adapter, generated files, and planner-specific tests. Stop if a live feature caller remains.

- [ ] **Step 2: Remove the planner server surface**

From `pkg/wshrpc/wshserver/wshserver_jarvis.go`, remove:

- the `planDag = jarvis.PlanDag` injectable;
- `JarvisPlanDagCommand`;
- `catalogPresenceWarnings`;
- `installedRunWorkerPins`;
- `toRPCDagPlanDraft`.

Delete planner-only tests. In `wshserver_harness_test.go`, remove only the `installedRunWorkerPins` assertion; retain catalog and capability tests.

- [ ] **Step 3: Remove planner RPC declarations and DTOs**

From `pkg/wshrpc/wshrpctypes_jarvis.go`, remove the `JarvisPlanDagCommand` interface method and these types:

```go
CommandJarvisPlanDagData
DagPlanDraft
DagPlanTask
CommandJarvisPlanDagRtnData
```

Delete `pkg/jarvis/plandag.go` and `pkg/jarvis/plandag_test.go`.

- [ ] **Step 4: Remove abandoned exact-consult changes**

Remove `SpecForExactModel` and `TestSpecForExactModel`; it has no caller after `PlanDag` is deleted.

Remove `ErrOpenRouterKeyMissing`, remove the now-unused `errors` import, and restore the original OpenRouter missing-key boundary exactly:

```go
if !exists || key == "" {
    return "", fmt.Errorf("OpenRouter API key not configured (set OPENROUTER_KEY)")
}
```

Do not alter other consult runtime specs or error handling.

- [ ] **Step 5: Regenerate bindings**

Run:

```bash
task generate
```

Expected: generated TypeScript and Go clients no longer contain the planner command or DTOs. Do not edit generated files manually.

- [ ] **Step 6: Prove planner symbols are gone**

Run:

```bash
rg -n "JarvisPlanDag|CommandJarvisPlanDag|DagPlanDraft|DagPlanTask|SpecForExactModel|ErrOpenRouterKeyMissing" frontend pkg --glob '*.ts' --glob '*.tsx' --glob '*.go'
```

Expected: no matches.

- [ ] **Step 7: Run backend and generated-client checks**

Run:

```bash
export CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc'
go test ./pkg/consult ./pkg/jarvis ./pkg/wshrpc/wshserver ./pkg/orchestrate -count=1
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```

Expected: all commands exit 0.

- [ ] **Step 8: Diff checkpoint; do not commit**

Run:

```bash
git diff --check
git diff --stat
git diff -- pkg/consult pkg/jarvis/plandag.go pkg/wshrpc/wshrpctypes_jarvis.go pkg/wshrpc/wshserver/wshserver_jarvis.go
```

Confirm the abandoned planner fixes were removed rather than left as unused helpers.

---

### Task 5: Verify the complete implementation and rebuild the dev backend

**Files:**
- Modify only if a test exposes a scoped defect in Tasks 1–4.
- Preserve: `docs/superpowers/specs/2026-08-26-persistent-orchestrator-lead-design.md`.
- Preserve: `docs/superpowers/plans/2026-08-26-persistent-orchestrator-lead.md`.

**Interfaces:**
- Consumes: direct composer dispatch, ungated lead prompt, live-only DAG modal, regenerated RPC surface.
- Produces: a fresh `dist/bin/wavesrv.x64.exe` ready for user-controlled dev-app restart.

- [ ] **Step 1: Run the relevant frontend suite**

Run:

```bash
npx vitest run frontend/app/view/agents/composercommand.test.ts frontend/app/view/agents/runactions.test.ts frontend/app/view/agents/runmodel.test.ts frontend/app/view/orchestrate
```

Expected: all tests pass.

- [ ] **Step 2: Run TypeScript with the required stack size**

Run:

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```

Expected: exit 0 with no errors.

- [ ] **Step 3: Run relevant Go packages**

Run:

```bash
export CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc'
go test ./pkg/consult ./pkg/jarvis ./pkg/orchestrate ./pkg/wshrpc/wshserver -count=1
```

Expected: all packages pass.

- [ ] **Step 4: Build the backend**

Run:

```bash
task build:backend
```

Expected: `dist/bin/wavesrv.x64.exe` is rebuilt successfully.

- [ ] **Step 5: Perform simplify-style self-review**

Run:

```bash
git diff --check
git status --short
git diff --stat
git diff -- frontend/app/view/agents frontend/app/view/jarvis/stagecomposer.tsx frontend/app/view/jarvis/profilepanel.tsx frontend/app/view/orchestrate pkg/jarvis pkg/wshrpc pkg/consult
```

Check explicitly:

- no planner/fallback/debug code remains;
- no unrelated formatting or refactor is mixed in;
- no generated file was hand-edited;
- no commented-out implementation or debug logging exists;
- direct run failure preserves the composer goal;
- orchestrator creation cannot re-enable a plan gate;
- live DAG controls remain intact.

- [ ] **Step 6: Ask the user to restart the dev app**

Do not kill the hosting process. Report the rebuilt executable timestamp and ask the user to restart `task dev`. After confirmation, verify the running `wavesrv.x64.exe` start time is newer than the build.

- [ ] **Step 7: Diff checkpoint; do not commit**

Do not stage, commit, or push. Report the exact modified/deleted/generated file set and all verification output.

---

### Task 6: Launch and document the real persistent-lead orchestrator run

**Files:**
- Modify: `docs/handoff/2026-08-26-jarvis-orchestrator-open-ended-improvement-run.md`
- Add: `docs/handoff/assets/2026-08-26-jarvis-orchestrator/05-persistent-lead-planning.png`
- Add: `docs/handoff/assets/2026-08-26-jarvis-orchestrator/06-live-dag-auto-started.png`
- Add: `docs/handoff/assets/2026-08-26-jarvis-orchestrator/07-workers-running.png`
- Add: `docs/handoff/assets/2026-08-26-jarvis-orchestrator/08-dag-progress-or-completion.png`

**Interfaces:**
- Consumes: restarted dev app at `http://localhost:5174/`, CDP port `9222`, working route `pi / opencode-go/deepseek-v4-flash`.
- Produces: a real persisted multi-task DAG and screenshot-backed handoff observations.

- [ ] **Step 1: Obtain explicit permission for engine-managed child commits**

Before launching, tell the user:

```text
Wave's DAG engine requires internal commits in isolated child worktrees so it can merge completed tasks. It will not push. May I launch the run with those internal commits enabled?
```

If the answer is not explicit approval, stop before launch. Do not reinterpret the earlier no-commit instruction.

- [ ] **Step 2: Connect to the real Tauri WebView**

Use `agent_browser` interactively:

```text
connect 9222
get url
snapshot -i
```

Verify the page has Tauri-backed Wave content, not a regular browser tab showing `BOOT ERROR`.

- [ ] **Step 3: Submit the goal through the UI**

In `#improvement-scan-2026-08-26`:

- select **Orchestrator**;
- select `Pi · opencode-go/deepseek-v4-flash`;
- submit this goal:

```text
Fix every finding in docs/superpowers/briefs/2026-08-26-open-ended-improvement-scan.md — all 32 findings (F1-F8, W1-W8, S1-S8, P1-P8). Read the brief for the full evidence and suggested directions. Size the work up, create coherent typed DAG tasks when useful, include task-specific evidence, constraints, verification, and pinned decisions in every child description, and let the engine schedule ready work automatically. Do not push. Internal isolated-worktree commits required by the DAG engine are allowed.
```

Verify no local DAG draft or approval modal appears.

- [ ] **Step 4: Capture persistent-lead planning**

Capture the real UI while the lead is planning to:

```text
docs/handoff/assets/2026-08-26-jarvis-orchestrator/05-persistent-lead-planning.png
```

Verify the route/model and lead activity are visible.

- [ ] **Step 5: Observe typed task publication and automatic start**

Wait for the lead to publish through `wsh jarvis dag import-tasks`. Verify:

- a persisted DAG appears;
- it has more than one task for this multi-area goal;
- no task-list approval is requested;
- ready tasks begin automatically;
- inherited task routes show `pi / opencode-go/deepseek-v4-flash` unless the lead supplied a justified exception.

Capture:

```text
docs/handoff/assets/2026-08-26-jarvis-orchestrator/06-live-dag-auto-started.png
docs/handoff/assets/2026-08-26-jarvis-orchestrator/07-workers-running.png
```

- [ ] **Step 6: Observe progress and bounded failure behavior**

Watch until at least one task completes or the DAG reaches a stable blocked/failure state. Exercise only a necessary real control; do not create a synthetic gate merely for a screenshot. Capture the resulting state to:

```text
docs/handoff/assets/2026-08-26-jarvis-orchestrator/08-dag-progress-or-completion.png
```

Record actual task count, dependency waves, parallelism, routes, timings, errors, and interventions. Do not claim completion if workers remain active.

- [ ] **Step 7: Update the handoff document**

Add sections covering:

- removed preflight architecture and why;
- direct persistent-lead launch behavior;
- absence of task-list approval;
- exact selected route and inherited worker routes;
- observed typed DAG and automatic scheduling;
- engine-managed commit constraint;
- screenshot index with captions;
- completed, active, blocked, and unverified work.

Use bounded language based only on observed UI/process evidence.

- [ ] **Step 8: Final verification and status checkpoint**

Run:

```bash
git diff --check
git status --short
```

Verify all screenshot paths exist and the handoff references exact filenames. Report tests run, build output, live-run state, residual risks, and that no push occurred. Do not commit the implementation or documentation.
