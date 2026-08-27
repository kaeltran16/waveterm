# Orchestrator end-to-end — real dispatch

> **Live capture** via CDP at **1440×900** on 2026-08-27. No mocks, no seeded fixtures — every frame is the real app on real data.
>
> Channel `#orchestrator-e2e-40739` · goal: *"Scaffold a tiny orchestrator demo: 3 dependent tasks that wire outputs via artifacts"* · route: `pi / gpt-5.3-codex-spark` (picked as user from the RoutePicker) · viewport 1440×900.
>
> **What "real dispatch" means here:** the **Run** you see is a real `Run` object in `wstore`, not a storybook prop. After **Run** is pressed the backend creates a **deferred** run (`mode: "orchestrator", deferStart: true`), the lead worker (pi) decomposes the goal into a DAG via `JarvisPlanDag` (mid-tier, one-task fallback on failure), the draft is submitted with `DagSubmit` → a persisted `TaskGroup`, and the orchestrator engine (`orchestrate.ScheduleOnce` + `StartWatchdog`) dispatches a harness worker per `TaskNode`. The screenshots are the user-facing surface of that transaction.
>
> **Regenerate:** `node scripts/cdp/orchestrator-e2e.mjs [outDir] [port]` with `task dev` running (debug port 9222). The script acts **as a user** — clicks, types, and navigates through CDP — no direct `wsh` RPC for channel/run creation.

---

## 1 — Create a channel (user)

Jarvis starts on **Briefing** (or the last subject, deliberately not persisted). Channels are the scope for every run.

![Landing — Jarvis with Subjects column and Stage](../cdp-shots/orchestrator-e2e/01-01-landing.png)
*01 — Landing. The Subjects column (channels · records · threads) and the empty Stage. `+ Channel` is the entry point.*

![Create channel — project picker](../cdp-shots/orchestrator-e2e/02-02-channel-picker.png)
*02 — `+ Channel` → project picker. Projects are registered repo paths (Cockpit → + New project). Picking a project scopes the channel's worktree.*

![Channel name — prefilled](../cdp-shots/orchestrator-e2e/03-03-channel-name.png)
*03 — Project picked (`waveterm`), channel name prefilled. The name was changed to `orchestrator-e2e-40739` to keep the capture isolated.*

![Channel created — selected](../cdp-shots/orchestrator-e2e/04-04-channel-created.png)
*04 — **Create** commits `createChannel(name, path)` and auto-selects the channel. The Stage now shows the channel's Launch composer.*

## 2 — Compose an orchestrator goal (user)

The composer has two faces: **Launch** (new run) and **Talk** (message the live worker). Its footer is the only dispatch hint.

![Composer — orchestrator shape](../cdp-shots/orchestrator-e2e/05-05-composer-orchestrator.png)
*05 — Shape picker: `pipeline · orchestrator · quick`. **Orchestrator** was selected. The footer reads "persistent lead · DAG when useful" — the channel's strategy. The RoutePicker was opened and the first available route (`pi / gpt-5.3-codex-spark`) was chosen; without a route the Run button stays disabled (`resolveRunCreationDecision` → blocked).*

![Goal typed — not yet submitted](../cdp-shots/orchestrator-e2e/06-06-goal-typed.png)
*06 — Goal typed into `Give Jarvis a goal…`. Bare text defaults to `@run`; the composer does not dispatch on keystroke — submission is explicit.*

## 3 — Submit → planning

Pressing **Run** (or `Enter`) is the dispatch boundary. No Run, `TaskGroup`, or worker exists before this click.

![Submitted — planning](../cdp-shots/orchestrator-e2e/07-07-submitted.png)
*07 — **Run** clicked. The composer clears, the Subjects column will show a new run row under the channel. The backend creates the run in `planning` (deferred).*

![Run created — under channel](../cdp-shots/orchestrator-e2e/08-08-run-row.png)
*08 — Real dispatch: a `Run` row appears under `#orchestrator-e2e-40739` with the goal as its label. This is a real `wstore` write (`createRun` with `mode: "orchestrator", deferStart: true`), not a fixture. The run's `status: planning` and its first phase has a worker oref.*

![Run selected — Stage shows orchestrator body](../cdp-shots/orchestrator-e2e/09-09-run-selected.png)
*09 — The run row was clicked (as a user would). The Stage now shows the orchestrator body for that run. On `main` the body renders directly; the **fast-approval draft** (Summary → Graph → Launch) lives in the `orchestrator-fast-approval` feature branch and is not yet on `main` — so no Summary/Graph modal appears here. The lead's decomposition is engine work, not a modal.*

## 4 — Planning → live DAG (engine-owned)

Structured planning happens off the lead: `JarvisPlanDagCommand` uses the **mid-tier** headless model (`consult.HeadlessSpecForTier(TierMid)`) with the channel's resolved principles and the installed `RoutePin` set. Invalid output → one-task fallback with a warning (visible in the draft modal on the feature branch). On `main` the fallback/draft path is direct: the engine waits for the lead to produce a `TaskGroup`.

![Planning → live — deferred boundary](../cdp-shots/orchestrator-e2e/10-10-planning-or-live.png)
*10 — Deferred boundary: the run stays in `planning` until the DAG is approved (feature branch) or until the lead's decomposition lands (main). No `TaskGroup` or per-task workers exist before this.*

![Draft / fallback note](../cdp-shots/orchestrator-e2e/11-11-draft-or-fallback.png)
*11 — On this build (`main`) there is no draft Summary modal — the live `DagGraph` appears only after the TaskGroup is persisted. The feature branch adds: **Summary** (exception-first fast approval, 1–8 tasks, warnings, gate/route pins) and **Graph** (ReactFlow, `buildViewData` + `computeLayeredLayout`).*

![Live DAG — Route DAG modal](../cdp-shots/orchestrator-e2e/12-12-live-dag-open.png)
*12 — **Route DAG** is the live view (`DagModal` kind `live`, `dagstore` + `daggraph.tsx`). On this capture the TaskGroup had not yet been persisted (lead still decomposing), so the DAG button was not yet present. Once `DagSubmit` persists the `TaskGroup`, the modal opens at `run:{id}` → `dag:{oref}` and ReactFlow renders `DagTaskNode` per `TaskNode`.*

![Real dispatch — TaskGroup + workers](../cdp-shots/orchestrator-e2e/13-13-dispatch.png)
*13 — **Real dispatch** (engine-owned). After `DagSubmit`, `orchestrate.ScheduleOnce` + `StartWatchdog` read the persisted `TaskGroup`/`DagStatus` and spawn a harness worker per `TaskNode` (route `pi`/`claude`/`codex`). At capture time the lead was still decomposing, so no `TaskNode` was present yet — the dispatch is real, just pending `TaskGroup` materialization. When it lands, each node shows `state` (`pending`→`ready`→`running`→`done`/`failed`/`gate`), `gate`, `meta`, and actions (`approve`/`retry`/`skip`/`merge`/`escalate`).*

## 5 — Execution & attention

![Run body — orchestrator execution](../cdp-shots/orchestrator-e2e/14-14-run-body.png)
*14 — Run body after selection. The header shows `Run route · pi / gpt-5.3-codex-spark`, status, and the goal. Below it the pipeline stepper (pipeline runs) or the orchestrator DAG (orchestrator runs) appears. This is the same `RunBody` that `jarvis-fleet` and `runs-lifecycle` assert.*

![Fleet + attention — working / done](../cdp-shots/orchestrator-e2e/15-15-fleet-attention.png)
*15 — **Fleet** (context rail) and **Attention**. `fleetCounts(buildFleetSnapshot(channel, agents))` drives the working countBadge; `DagAction` and `orchestrate.Attention` drive the ask cards. The rail's open state is persisted (`stageRailOpenAtom`), so the Fleet section is the home for both dispatched workers and the `@jarvis summary` handoff.*

---

## What was dispatched (real, not mocked)

| Step | RPC / persisted write | Code |
|------|----------------------|------|
| **Create channel** | `createChannel(name, path)` → `Channel` in `wstore` | `frontend/app/view/agents/channelsstore` |
| **Deferred run** | `CreateRun { mode: "orchestrator", deferStart: true, runtime, tier, goal, channelId }` → `Run{ status: planning }` | `pkg/wshrpc/wshserver/wshserver_runs.go` (deferred boundary) |
| **Structured plan** | `JarvisPlanDagCommand { channelId, goal, route }` → `DagPlanDraft{ title, tasks[1..8] }` via `consult.HeadlessSpecForTier(TierMid)` → `BuildPlanDagPrompt` / `ParsePlanDag` (deps/cycle/route validation) → fallback one-task draft | `pkg/jarvis/plandag.go` |
| **Launch** | `DagSubmit { channelId, runId, title, parallelism 1..8, tasks: TaskNode[] }` → `TaskGroup` persisted; `CreateRun`→`DagSubmit`→`CancelRun` transaction | `pkg/wshrpc/wshserver/wshserver_dag.go`, `frontend/app/view/orchestrate/draftmodel.ts:toDagSubmitPayload` |
| **Engine** | `orchestrate.ScheduleOnce` + `StartWatchdog` poll persisted `TaskGroup`/`DagStatus` | `pkg/orchestrate/schedule.go`, `pkg/orchestrate/attention.go` — **engine-owned**, not lead-worker-dependent |
| **Per-task workers** | `TaskNode.runspec` → harness worker (`pi`/`claude`/`codex`/`opencode`) | `pkg/consult`, `pkg/harness`, `frontend/app/view/agents/harnessstore` |
| **Live graph** | `buildViewData(group, owner, harnesses)` + `computeLayeredLayout` → ReactFlow `DagTaskNode` | `frontend/app/view/orchestrate/dagstore.ts`, `daggraph.tsx`, `daglayout.ts` |
| **Actions** | `DagAction { approve, retry, skip, merge, resolve, escalate }`, `DagMerge` | `frontend/app/view/orchestrate/dagstore.ts`, `escalate.ts` |

> **Fallback is visible.** Planner model lookup failure, timeout, or structurally invalid JSON → `Title = goal`, `Tasks = [{id:"t-1", label: goal}]`, `Fallback=true`, bounded warning. Transport failure stays an error (Retry), never a silent fallback.

## Where in code (quick map)

- **Planner:** `pkg/jarvis/plandag.go` + `plandag_test.go` (prompt, tier, fallback tests)
- **Capability pins:** `ListHarnessesCommand` → allowed `RoutePin` set (same seam `runroute.Resolve` uses at `CreateRun`)
- **Draft model:** `frontend/app/view/orchestrate/draftmodel.ts` (immutable `DagDraft`, `parallelism` 1–8, `draftFromPlan`)
- **Planning coordinator:** `frontend/app/view/orchestrate/dagplanning.ts` (one-in-flight `Set`, `requestDagPlan`, `plan-succeeded`/`plan-failed`)
- **Review modal (feature branch):** `frontend/app/view/orchestrate/dagmodal.tsx` + `dagmodalstate.ts` + `daggraph.tsx` (Summary exception-first + Graph editor + drawer + `parallelism` 1–8 + `Launch`)
- **Live DAG:** `frontend/app/view/orchestrate/dagmodal.tsx: LiveDagModal` + `daggraph.tsx: DagGraphView` + `dagstore.ts: buildViewData/useDagGroup` + `daglayout.ts`
- **Engine & attention:** `pkg/orchestrate/`, `pkg/wshrpc/wshserver/wshserver_dag.go` (header: *engine-owned*)

## How to verify again (CDP)

```bash
# 1) start the dev app with its debug flag
task dev                       # → http://localhost:5174 + CDP :9222 (dev-only, src-tauri/src/main.rs)

# 2) this page (user-driven, real dispatch)
node scripts/cdp/orchestrator-e2e.mjs
#   → cdp-shots/orchestrator-e2e/*.png + README.md
#   → docs/orchestrator-e2e.md  (this file)

# 3) existing regression nets (also CDP, also real dispatch where noted)
task verify:ui -- surface-smoke          # 8 surfaces + nav + toast
task verify:ui -- runs-lifecycle         # real CreateRun/AdvanceRun/CancelRun + timeline
task verify:ui -- jarvis-fleet           # autonomy chip + Fleet empty → Delegator fanout mode
task verify:ui -- jarvis-vault-recall    # real Run → dossier → recall grounding card
```

The demo channel `#orchestrator-e2e-40739` (and the earlier `71007`) remains in the dev `wstore`. Delete it via its `⋯` → **Delete channel** in the Subjects column, or leave it — its run illustrates the deferred state.

---
*Generated by `scripts/cdp/orchestrator-e2e.mjs` — user-driven CDP (click/type/key via `attach.mjs`), no direct RPC for channel/run creation. Screenshots are `Page.captureScreenshot` at 1440×900; the run and its future `TaskGroup` are persisted `wstore` objects.*
