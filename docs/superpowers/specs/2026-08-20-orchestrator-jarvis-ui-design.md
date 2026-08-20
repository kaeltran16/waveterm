# Orchestrator–Jarvis UI (Light Seam A) — Design

Date: 2026-08-20. Status: draft, awaiting review.
Author: lead + engine review. Companion to `docs/lead-authored-task-routing-roadmap.md` (routing foundation + §5 typed `blocked`/`escalate`).

## Goal

Surface the Jarvis context the DAG engine now carries (light seam A) without a new dossier-native DAG. Chat keeps steering (lead authors `goal+Description`); the cockpit shows **why a task knows what it knows, where it failed, and what a hop would cost** — the precision chat can't give.

Light seam A data, for reference:
- child prompt = `goal + Description pins + Principles` + 0–2 deterministic `jarvisrecall` grounding cards (pure, no model loop)
- parent `Evidence` = union of child evidences at `dag:done`
- continuity one-liner on `dag_blocked`/`dag_done` (for Briefing/pet strip + run header)
- per-task `Attempts` + `LastFailureKind` persisted on `TaskNode` (typed `blocked`)

This doc is UI only; no vault/dossier editor (that's seam B).

## Non-goals

- No task authoring in the graph (lead still steers tasks in chat; graph is for correction/audit, not authoring).
- No dossier/vault task editor, no vault graph, no semantic attribution UI (seam B).
- No new top-level orchestrator surface (reuses Settings + DAG graph + parent run card per roadmap hybrid C).

## Architecture

Three touches, no new surface. All read from existing stores plus one projection:

- **Matrix admin** lives in **Settings** (extends `headless:runtime` row). No code change in this doc — roadmap §2 owns it. This doc does not add a matrix UI.
- **DAG graph** (`@xyflow/react`, per-run) gets recall + failure affordances on node chrome.
- **Task drawer** (click node → detail pane, same pattern as `RunDetailsRail`) shows grounding + retry state + `escalate`.
- **Parent run card** shows continuity narrative + union evidence (reuses existing `run:event` hybrid timeline).

Data sources:
- `TaskGroup` (wstore `dag:<id>`) — `Tasks[].RunSpec`, `State`, `Attempts`, `LastFailureKind`, `LastActivity`.
- Projection `recallCards` per task — computed on read via `jarvisrecall` deterministic seed on `goal+Description` (not persisted; free, pure function, 0–2 cards). Backend returns it with `GetDag`.
- `Run.Evidence` per child + parent union (computed at `dag:done`).
- `RunEvent` log on parent run (`task_spawned/task_stalled/dag_blocked/dag_done`) — already published by `engine.go:appendRunEvent` + `wps.Event_RunEvent`.

No new waveobj persisted type for UI; `Attempts/LastFailureKind` are the only `wtype.go` additions (owned by routing doc).

## UI components

### 1. DAG node chrome (inline, in graph)

- Badge: `(harness, tier)` — the existing picker from roadmap Phase 1. Read-only when task is `running/done`; dropdown when `pending` and `Deps` satisfied (pre-spawn correction).
- Recall chip: `⧉ N` (N=0 hidden, 1–2 shown) when projection has cards. Hover tooltip = card titles; click opens drawer anchored to cards section.
- Attempts dot: for `tool_call_error` retry, show `• retry 1/1 (cache hit)` under state. `stalled` shows `stalled 14m ago` via `LastActivity`.
- State color stays `pending/ready/running/stalled/done/failed/blocked-merge`; `failed` is not shown long — it becomes `blocked` after typed handling.

### 2. Task drawer

Opened by clicking a node. Width ~380px, same rail chrome as other surfaces. Sections top→bottom:

1. **Task identity** — `label`, `Description` pins (read-only, with copy), `Deps` list.
2. **Route** — `(harness, tier)` picker + `Mode` (quick) read-only. Invalid stamp shows fallback note.
3. **Jarvis context** — `Principles` (chips) + `Recall cards` (`GroundingCard` list: title, snippet, cite count; empty state = "No prior decisions matched — task runs on Description only"). Cards are read-only, deterministic.
4. **Execution** — `State`, `RunID` link to child run card, `LastFailureKind` + `Attempts`, `LastActivity` relative time. Actions: `Retry` (same-tier, only for tool errors on first failure), `Escalate --tier mid|capable` (always), `Skip`/`Cancel` (existing `scheduler.go` verbs). `Escalate` is `RetryTask + patch RunSpec` (roadmap verb) — drawer disables it when `blocked` cap reached or global `Failures >=3`.

Drawer is the only place `escalate` lives; chat does not get a button (keeps chat as steering, not fleet control).

### 3. Parent run card

- **Header** continuity line: one-liner from `jarviscontinuity` on `dag_blocked`/`dag_done` (same source as pet `eventFromResume`). Shown under goal when `Status` is `awaiting-review/blocked/done`. No line = no narrative yet.
- **Lifecycle timeline**: existing hybrid `run:event` strip already renders `task_spawned/task_stalled/dag_blocked/dag_done`. No change except `dag_blocked` payload now includes `{taskid, kind}` for click-to-drawer.
- **Files tab**: union evidence — `Evidence.Files` merged from children at `dag:done` (deduplicated by path, last child wins on overlap). Tabs for per-child files remain via child run rows.

## Data flow

```
GetDag(dag:<id>) -> TaskGroup + per-task recallCards (computed)
  -> DAG graph renders nodes (badge, recall chip, attempts)
  -> click node -> drawer fetches same projection (no extra round-trip) + child Run via wstore.GetRun
  -> escalate -> wsh jarvis dag escalate <task> --tier -> UpdateDag(patch RunSpec, MarkPending) -> ScheduleOnce spawns next tier
  -> run:event append on parent -> run card timeline + continuity narrative
```

Recall retrieval is synchronous, pure-Go (`pkg/jarvisrecall`), bounded to top 2; no model call, no loading spinner. Failure is silent empty (no chip).

## Error handling

- No recall cards → chip hidden, drawer shows empty state (not error).
- Invalid `(harness,model)` stamp → badge shows fallback with tooltip "invalid stamp, using owner default"; spawn uses fallback (roadmap §2).
- `Attempts` overflow / global `MaxConsecutiveFailures` → `escalate` disabled with reason in tooltip.
- Child run missing (`GetRun` fails) → drawer shows "child not found" with `RunID`, actions disabled except `Retry`/`Escalate` which still clear the stale `RunID`.
- Stalled detection is best-effort (`lastActivityForRun` may be 0 for non-pi runs) — drawer shows "no activity yet" instead of a false stalled flag.

## Testing

- **Go**: `pkg/orchestrate` — typed `kind × attempts → action` table test (tool error retries same tier then blocks; stalled blocks immediately; `escalate` patches tier and re-queues; global circuit-break respected). Existing `dag_test.go` + `engine_test.go` cover state derivation.
- **FE**: vitest for `drawer` — recall chip hidden when 0, shown when 1–2; `escalate` disabled at cap; `RunSpec` picker writes `Model`; `wshclientapi` round-trip. No jsdom render snapshot — pure `.ts` viewmodel tests beside thin `.tsx`.
- **Visual**: `task verify:ui` on a seeded DAG (via `wsh jarvis dag submit` fixture) — node badges, chip hover, drawer open, union files tab.

## Dependencies

- Routing roadmap Phase 1 (`RunSpec.Model` + passthrough) must land before recall projection has a harness/tier to display.
- `pkg/jarvisrecall` deterministic retrieval exists (it does); no embedding/index change.
- `jarviscontinuity` writer on `dag_blocked/dag_done` is a one-line `appendRunEvent` addition in `engine.go` (follow-up to routing Phase 2).
- `task generate` + `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` per AGENTS.md after any `wtype` change.

## Open questions

1. Recall card cap: 2 enough for a headless child? Keep 2 for A; revisit if grounding is thin in practice.
2. Drawer vs inline: is a drawer too heavy for a task that is just `label+Description`? Alternative is inline popover on node — drawer wins because `GroundingCard` needs ~200px snippet width.

## Related

- Routing: `docs/lead-authored-task-routing-roadmap.md`
- Engine: `pkg/orchestrate/engine.go`, `pkg/orchestrate/dag.go`, `pkg/jarvis/attention.go`
- Prior UI surfaces: `frontend/app/view/agents/` DAG graph, `frontend/app/view/jarvis/` run card
