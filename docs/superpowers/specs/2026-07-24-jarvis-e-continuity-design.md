# Jarvis sub-project E — Continuity — design

**Date:** 2026-07-24
**Status:** Design approved (brainstorming). Plan to follow.
**Type:** Sub-project spec (one `spec → plan → implementation` cycle under the [meta spec](2026-07-23-jarvis-second-brain-meta-spec.md)).

## Where E sits

Sub-project **E** of the [Jarvis second-brain meta spec](2026-07-23-jarvis-second-brain-meta-spec.md) — **continuity**: pre-computed context recovery across pauses ("where was I / where did this stand"). It depends on A (Wave Vault, merged), B (dossier & records, merged), and **C** (recall engine — the piece that reads dossiers and, via the vault, is what surfaces E's output). Per the meta spec's build order `G → F → A/B → C → D → E`, E is the last v1 sub-project.

E is the mirror of C's capture writer: where `pkg/jarviscapture` writes a dossier at Run **dispatch** (status `active`), E writes the dossier's **narrative state summary** at Run **rest boundaries** (status `paused` / `completed`). C's recall then serves that narrative — so continuity is delivered without a new surface or wire type. This is fork 1 below.

This spec assumes the [Jarvis second-brain design](2026-07-22-jarvis-second-brain-design.md)'s cost model (Continuity row: "pre-computed at pause, served free on resume; one refresh only if facts changed"), A's [design](2026-07-23-jarvis-a-wave-vault-design.md) + implemented `pkg/wavevault`, B's [design](2026-07-24-jarvis-b-dossier-design.md) + implemented `pkg/jarvisdossier`, C's [design](2026-07-24-jarvis-c-recall-design.md), and the meta spec's [invariants](2026-07-23-jarvis-second-brain-meta-spec.md#cross-cutting-invariants). It inherits as hard constraints: invariant 1 (**the determinism boundary is the cost boundary** — recording facts, git, and queries are free; the model runs only to summarize, at an explicit boundary, **never on a background poll**), invariant 3 (Markdown is canonical; any cache is a rebuildable derived layer), invariant 6 (**human owns material decisions and completion** — Jarvis never invents a decision or declares a task complete; code records facts, the model only drafts prose), and invariant 7 (grounding first-class; freshness resolves from the authoritative store at synthesis time).

## Constraints inherited from the real codebase

E is designed against what A/B/C/F actually ship. Five facts shape it:

1. **B already provides E's write target.** `pkg/jarvisdossier` exposes `SetState(v, id, summary, baseHash)` — the machine-owned narrative **`state` block** — and `SetStatus(v, id, status, baseHash)` with dossier statuses `active | paused | completed | archived`. E needs no new schema, no new block, no migration. The `state` block is exactly the "narrative summary" the meta spec's E owns.
2. **The Run lifecycle has explicit rest states, and `AdvanceRunCommand` is the one funnel.** `waveobj.Run.Status ∈ {planning, awaiting-review, executing, blocked, done, cancelled}` (`jarvis.RunStatus_*`). Every status change flows through `WshServer.AdvanceRunCommand` (`pkg/wshrpc/wshserver/wshserver_runs.go`); it already reloads the run post-transition and special-cases the `→ done` edge to dispatch evidence-sealing **off-band via `sealAsync`**. This is the exact place — and the exact pattern — E hooks, symmetric to C hooking `CreateRunCommand` in the same file.
3. **A model call cannot run inline in the RPC handler.** `AdvanceRunCommand` runs on the wshrpc 5s budget; the seal is dispatched off-band precisely because a git-diff + transcript read outlasts it (a known EC-TIME hazard). E's boundary summary is a `consult.Run` model call — strictly more expensive — so it **must** be dispatched off-band exactly like the seal, never blocking the handler.
4. **The dossier↔run link C writes is E's lookup key.** C's `jarviscapture` calls `SetRefs(v, id, []string{"run-" + run.OID}, ...)`, so the dossier for a run is found by `Retriever.Query(Filter{HasLink: "run-<oid>"})` (proven in `jarviscapture`/`jarvisattrib` tests). If C's non-fatal dispatch capture failed and no dossier exists, E finds nothing and **no-ops** — creating dossiers is C's responsibility, not E's.
5. **F deferred model tiering; only the capable model exists.** `jarvisrecall` synthesizes via `consult.SpecFor("claude") → consult.Run` — no model parameter; the model is the `claude` CLI default (capable). There is no Haiku-class path to call. E reuses this exact pattern (fork 2).

## Design decisions

Settled in brainstorming:

- **Fork 1 — continuity surfaces through recall; no new UI or RPC.** E writes the narrative into the dossier `state` block at the boundary. C's recall already traverses dossiers and F synthesizes them, so "where was I on X" is answerable the moment the block is populated — no new surface, no new wire type. E stays pure in-process Go like C. A dedicated resume card / `resume` RPC is a *push* affordance adjacent to v2 proactive resurfacing; it is an ambient-presence follow-on, **not** E (§Deferred).
- **Fork 2 — reuse the capable model as an interim; defer the Haiku tier.** The boundary summary runs on the same `consult.SpecFor("claude") → consult.Run` path C uses. Model tiering is a shared concern (C's synthesis + E's summary both want it) and deserves its own cross-cutting slice, not a one-off inside E. Boundary summaries are event-bounded (one per rest transition, never a poll), so the interim cost is bounded. Recorded in `docs/deferred.md`.
- **Fork 3 — capture at rest-state transitions (`awaiting-review | blocked | done`).** A "lifecycle boundary" is the run transitioning *into* a rest state it was not already in: `awaiting-review` (a gate needs the human), `blocked` (a phase hit a blocker) → dossier `paused`; `done` → dossier `completed`. `cancelled` is abandoned work — skipped. Dispatch (`active`) is C's boundary, not E's. This is a single uniform rule (`IsRestState(post) && post != pre`), and it is what gives continuity value: the tasks you actually resume are the paused ones.
- **Freshness is pull, not a push hook.** "One refresh only if facts changed" is satisfied deterministically without a standing store or event subscription: (a) E re-captures at the *next* rest transition, refreshing the prose for still-live tasks; (b) C's synthesis resolves referenced-Run **live status** at query time (invariant 7), so volatile leaf values are fresh even when the prose is not. No `state_ts` bookkeeping, no invalidation callback.

## What E delivers

1. **A rest-boundary capture writer** — `pkg/jarviscontinuity.CaptureRunBoundary(ctx, run)`: find the run's dossier, assemble deterministic facts, run one model summary, write the `state` block + flip status, commit (§1).
2. **The narrative summary** — a pure prompt builder over deterministic facts (objective, rest reason, blockers, the triggering run's outcome, directly-referenced decisions), behind a mockable model call; invariant 6 enforced (no invented decisions/completion); an empty task writes a terse "no recorded activity," never confabulation (§2).
3. **A pure-read resume seam** — `Resume(r, taskID) → Narrative` (state prose + status + run refs, no model), realizing the meta spec's `resume(task)` seam. Exposed and unit-tested; **no wired v1 consumer** (recall reads the block during normal traversal), like C's `WorkerScope` (§3).
4. **The wshserver hook** — one non-fatal, off-band call in `AdvanceRunCommand`, mirroring the adjacent `sealAsync` dispatch (§4).

## What E deliberately does NOT do

- **No new surface, resume card, or `resume` RPC** — fork 1; continuity surfaces through recall. A discoverable "pick up where you left off" affordance is a later ambient-presence slice (§Deferred).
- **No Haiku / model-tier plumbing** — fork 2; interim capable model, deferred (`docs/deferred.md`).
- **No app idle/quit continuity flush** — A already performs a quit-safety commit; a separate E flush is speculative (§Deferred).
- **No proactive resurfacing** — event-triggered recall is v2 (meta spec).
- **No dossier creation** — E only updates the dossier C created; a missing dossier is a no-op, not a create.
- **No standing invalidation store / `state_ts`** — freshness is pull (re-capture at next boundary + C's live leaf resolution).
- **No new WaveObj type, no migration, no wire/RPC change, no `task generate`** — E is in-process Go consumed at a lifecycle hook, like C's `jarviscapture`. The vault is files; capture writes files.

## Architecture

One new package, one modified file:

- **`pkg/jarviscontinuity` (new)** — the rest-boundary narrative writer, deliberately separate from `jarvisrecall` (which stays a pure reader) and from `jarviscapture` (dispatch-only). Proposed files:

| File | Responsibility |
|---|---|
| `continuity.go` | `CaptureRunBoundary` orchestration (find dossier → assemble facts → `summarize` → `SetState`/`SetStatus` → `Commit`); `Resume`; the `isRestState`/status-mapping helpers; the mockable `summarize` var + `SetSummarizeForTest`. |
| `summary.go` | Pure, process-free helpers: `buildSummaryPrompt(SummaryFacts) string`, deterministic fact assembly from a dossier + its referenced decisions + the triggering run. Unit-testable with no vault, no model. |
| `continuity_test.go`, `summary_test.go` | Go tests over a fixture vault (`OpenVaultAtForTest`) + fixture Runs in a temp `wstore`, model mocked (§5). |

- **`wshserver` — modified:** `pkg/wshrpc/wshserver/wshserver_runs.go` — `AdvanceRunCommand` captures the pre-transition status and, after the existing post-transition reload, dispatches `CaptureRunBoundary` off-band when the run entered a new rest state.

## 1. Rest-boundary capture

`jarviscontinuity.CaptureRunBoundary(ctx, run *waveobj.Run) error` — the whole write side, called off-band and non-fatal:

1. **Open the vault** (`wavevault.OpenVault(ctx)`).
2. **Find the dossier.** `v.Retriever(wavevault.AllScope()).Query(Filter{HasLink: "run-" + run.OID})`. Zero hits → **no-op** (C's dispatch capture didn't run or failed; E does not create).
3. **Assemble deterministic facts** (`summary.go`, no model) — from the dossier (objective, current `state`, blockers, refs) + the triggering run (status, goal, `EndCommit`) + the dossier's directly-referenced decisions (`[[decision-*]]` refs resolved via `Retriever.Read`, titles + rationale; a bounded read of the dossier's own refs, **not** a full `Expand`).
4. **Summarize (the one model call).** `summarize(ctx, cwd, prompt)` over `buildSummaryPrompt(facts)`; `cwd = run.ProjectPath` (vault root fallback). Uses `consult.SpecFor("claude") → consult.Run` with a no-op emit (capture is one-shot, unstreamed). Mocked in tests via `SetSummarizeForTest`.
5. **Write, then flip status.** `jarvisdossier.SetState(v, id, narrative, hash)`; then `SetStatus(v, id, mapStatus(run.Status), res.Hash)` where `awaiting-review|blocked → paused`, `done → completed`. Each setter bumps `updated` (B's `updatedEdit`), so freshness never lags the write. Both writes go through B's region-aware, diff-validated writer — human `## Notes` prose is untouched.
6. **Commit** (`v.Commit(ctx, "jarvis: continuity summary for run "+run.OID)`) — machine-authored, commits as `Jarvis`.

The rest-state rule (in `wshserver`, §4): capture iff `IsRestState(post) && post != pre`, where `IsRestState ∈ {awaiting-review, blocked, done}`. Fires once per entry into a rest state; a re-block after resume earns a fresh summary; `cancelled`/`executing`/`planning` do not capture.

## 2. The narrative summary

- **Deterministic inputs only** (invariant 1 free-side): objective, the rest reason (status → "awaiting review" / "blocked" / "completed"), blockers block, the triggering run's outcome (status, goal, `EndCommit` presence), and referenced decisions' rationale. No transcript, no Run diff copied in (meta-spec non-goal).
- **Invariant 6 in the prompt.** The prompt instructs: summarize *where the work stands and what remains* from the given facts; **do not invent decisions, do not declare the task complete or correct** beyond the recorded run status. The model drafts prose over facts; it does not adjudicate.
- **Empty / no-activity.** If the dossier has no blockers, no decisions, and the run carries no outcome signal, E writes a terse deterministic line (e.g. "Paused at <status>; no recorded progress yet.") **without** a model call — a rewarded "nothing to say" state, not confabulation.
- **Length.** The `state` block is a short paragraph (a bounded "where it stands"), not a transcript — the prompt caps it; a PLACEHOLDER cap is recorded in `docs/deferred.md`.

## 3. Resume + freshness

- **`Resume(r *wavevault.Retriever, taskID string) → (Narrative, error)`** — a pure read: `LoadDossier(r, taskID)` projected to `Narrative{Summary, Status, Updated, RunRefs}`. No model, deterministic, free. This realizes the meta spec's `resume(task) → precomputed narrative` seam.
- **No wired v1 consumer.** Per fork 1, recall reads the `state` block during ordinary traversal, so nothing calls `Resume` in v1. It is exposed and tested (the seam exists and is provable), with a consumer arriving with the ambient/UI follow-on — the same "exposed, no consumer, testable now" posture C took with `WorkerScope`.
- **Freshness is pull.** No invalidation hook. Still-live tasks refresh at their next rest transition (§1); C's synthesis resolves referenced-Run live status at query time (invariant 7) so volatile values are fresh regardless of prose age.
- **Caveat (accepted, deferred):** a **completed** task's prose can drift if facts change after `done` (no further transition to re-trigger a summary). Low-stakes — it is a historical record and C still shows live run status. Re-freshness of terminal dossiers is deferred (`docs/deferred.md`).

## 4. The wshserver hook

In `AdvanceRunCommand` (`wshserver_runs.go`):

- Read `preStatus` before `wstore.UpdateRun` (generalize the `pre` read the Approve branch already does).
- After the existing post-transition reload (the block that today checks `run.Status == RunStatus_Done` for the seal), add: `if jarviscontinuity.IsRestState(run.Status) && run.Status != preStatus { captureAsync(func(){ jarviscontinuity.CaptureRunBoundary(bgctx, run) }) }`.
- **Off-band and non-fatal**, dispatched exactly like `sealAsync` — a background goroutine with its own context (not the handler's), errors logged not returned. E must never make `AdvanceRunCommand` slower or failable (invariant: capture failure must not fail the run transition).

## 5. Testing

Go tests only (backend package, no jsdom), over a fixture vault (`wavevault.OpenVaultAtForTest` — temp dir + real git) + fixture Runs in a temp `wstore`, matching A/B/C's pattern. The model call is mocked (`SetSummarizeForTest`).

- **buildSummaryPrompt (pure)** — given `SummaryFacts`, the prompt contains the objective, the rest reason, blockers, and referenced-decision rationale; asserts the invariant-6 guardrail text is present. No vault, no model.
- **capture writes state + flips status** — a dossier referencing `[[run-<oid>]]`; `CaptureRunBoundary` with the run at `done` writes the mocked narrative into the `state` block (`LoadDossier().State`) and sets status `completed`; at `blocked`/`awaiting-review` → `paused`. The change lands in a commit; human `## Notes` prose is untouched (B's diff-validator).
- **missing dossier → no-op** — a run with no dossier (`HasLink` miss) returns nil, writes nothing, makes no model call.
- **empty task → deterministic line, no model** — a dossier with no blockers/decisions/outcome writes the terse fallback without invoking `summarize`.
- **referenced-decision assembly** — a dossier linking `[[decision-x]]` includes that decision's rationale in the assembled facts; a dangling decision ref is skipped, not fatal.
- **rest-state rule (pure `IsRestState` + transition)** — `awaiting-review|blocked|done` are rest; `executing|planning` are not; `cancelled` is skipped; capture fires only on `post != pre`.
- **Resume (pure read)** — `Resume` returns the persisted `state`, status, and run refs with no model call; a task with an empty state returns an empty summary (not an error).
- **CDP** (`scripts/cdp/scenarios.mjs`, extends C's `jarvis-vault-recall`): dispatch a Run (C creates the dossier), advance it to `done`, then ask Jarvis "where did <goal> land" → the grounded answer reflects E's completion narrative. No jsdom (standing decision — wiring verified live).

## Seams E exposes / consumes

- **E ⇄ F/C (exposes):** `jarviscontinuity.Resume(r, taskID) → Narrative` — the meta spec's `resume(task)` seam, pure-read; unwired in v1 (recall reads the `state` block directly).
- **E ⇄ wshserver (exposes):** `jarviscontinuity.CaptureRunBoundary(ctx, run)` + `IsRestState(status)` — the off-band rest-boundary hook.
- **E ⇄ A/B (consumes):** `wavevault.OpenVault`/`Commit`/`Retriever`/`Query{HasLink}`/`Read`; `jarvisdossier.LoadDossier`/`SetState`/`SetStatus`.
- **E ⇄ wstore (consumes):** the `*waveobj.Run` handed to the hook (status, goal, `EndCommit`, `ProjectPath`, `OID`).
- **E ⇄ consult (consumes):** `SpecFor("claude")` + `Run` — the interim capable model, no tiering.
- **E ⇄ D (independent):** D also updates dossier refs (harden-to-`refs`); E only reads refs + writes the `state`/`status` regions — disjoint machine regions, no write contention.

## File-touch map

**Go — new:** `pkg/jarviscontinuity/{continuity.go, summary.go, continuity_test.go, summary_test.go}`.

**Go — modified:** `pkg/wshrpc/wshserver/wshserver_runs.go` — capture `preStatus`; one non-fatal, off-band `CaptureRunBoundary` dispatch in `AdvanceRunCommand`.

**CDP:** `scripts/cdp/scenarios.mjs` — extend C's `jarvis-vault-recall` with the advance-to-done → completion-narrative leg.

**Docs:** `docs/deferred.md` — E deferrals (Haiku tier, resume UI/RPC + ambient affordance, idle/quit flush, completed-task re-freshness) + PLACEHOLDER tuning (`state` summary length cap). Meta-spec tracking-table E-row link added at E's feature-commit time (avoid mid-plan edits to that shared file, per the A/B/C/D/F precedent).

## Open risks

- **Depends on C's capture landing first.** E updates dossiers C creates at dispatch; until C's `jarviscapture` is merged and running, `CaptureRunBoundary` no-ops (no dossier to find). E's *implementation* therefore lands after C merges; its *spec/tests* stand alone (tests seed a linked dossier directly). Accepted — E is the last v1 slice by design.
- **Model call per rest transition.** A run that re-enters `awaiting-review`/`blocked` several times earns a summary each time (off-band, capable model). At v1 scale (dozens of transitions/day) acceptable; the Haiku tier is the documented cost lever, and re-capture is *correct* (a fresh "where it's stuck"), not waste.
- **Off-band failure is silent.** Capture runs in a detached goroutine, logged not surfaced (like the seal). A persistently failing vault write leaves stale `state` prose but never blocks a run. Acceptable; the log is the signal.
- **Completed-task prose drift** (§3 caveat): terminal dossiers do not re-summarize on later fact changes. Low-stakes historical record; deferred.
- **`awaiting-review` volume** — plan-gate-heavy runs hit `awaiting-review` on every phase boundary. If this proves noisy against a populated vault, narrowing the rest-state set (e.g. drop `awaiting-review`, keep `blocked`/`done`) is a one-line tuning change; the placeholder set is recorded in `docs/deferred.md`.
