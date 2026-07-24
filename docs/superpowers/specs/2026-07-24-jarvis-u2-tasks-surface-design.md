# Jarvis second brain — U2: Tasks surface (dossier editor) design

**Date:** 2026-07-24
**Status:** Design approved (brainstorming). Plan to follow.
**Type:** Sub-project spec (sub-project **U2** of the [v2 meta spec](2026-07-24-jarvis-second-brain-v2-meta-spec.md)). One `spec → plan → implementation` cycle.

**Builds on (read first):**
- [Jarvis second brain — v2 meta spec](2026-07-24-jarvis-second-brain-v2-meta-spec.md) — v2 decomposition, the added invariants, the UX lane, and U2's responsibility boundary.
- [Jarvis sub-project A — Wave Vault foundation](2026-07-23-jarvis-a-wave-vault-design.md) — the region-aware, diff-validated, ownership-staged write path U2's "inside-Wave tier" sits on.
- [Jarvis sub-project B — Dossier & structured records](2026-07-24-jarvis-b-dossier-design.md) — the typed `Dossier`/`Decision` models, `DossierSpec`/`DecisionSpec`, and the record operations U2 drives.
- [Jarvis sub-project U1 — Presence C ("Spaces")](2026-07-24-jarvis-u1-spaces-design.md) — the app-bar Space chip U2 deep-links from, and the nav/import conventions U2 reuses.

This spec does not restate those invariants or decisions. It records the decisions left to U2, the engineering architecture, and the scope of this cycle.

## What U2 is

A first-class **Tasks** cockpit surface that renders a task dossier and its decision log, realizing the write-ownership model's **inside-Wave tier**: machine-owned regions render **read-only and visually distinct**, and the human's only writes are **appending a decision** and **changing task status**. It is on the **UX lane** — pure UX over the already-built v1 A (vault write path) and B (`jarvisdossier`); per v2 invariant 10 it has **no embedding dependency**, and per v1 invariant 1 it makes **no model call**.

U2 edits *existing* dossiers. Real dossiers already exist — `jarviscapture.CaptureRunDispatch` writes one on every run dispatch — so the surface is populated on day one. Manually authoring a brand-new dossier from inside Wave is **out of scope** (see §9).

The v2 meta spec (U2) frames the deliverable precisely: *"machine regions render read-only / visually distinct; the decisions log offers 'append entry,' not 'edit entry.'"* The **outside-Wave** guard (a machine write clobbering human prose) is already A's diff-validated write path and is not re-litigated here.

## Decisions this cycle settled (during brainstorming)

1. **Write scope: append + status only.** Machine regions are read-only; human writes are limited to (a) appending a new decision (human-authored rationale) and (b) status transitions (active/paused/completed/archived). Editing the human `## Notes` prose in-Wave is **deferred** — that stays an "edit in your editor / Obsidian" flow this cycle (§9).
2. **Placement: a new nav-rail surface, with a Space deep-link.** `Tasks` is a first-class cockpit surface (new `SurfaceKey`), master-detail (dossier list → detail). The U1 app-bar Space chip gains an "Open dossier" affordance that deep-links into it. (Rejected: a mode inside the Jarvis surface — diverges from the meta spec's "extend the nav rail" and competes with Jarvis's conversation center of gravity.)
3. **Human-write attribution: honest git blame via a small A/B addition.** A human-submitted decision is written through a new `CreateHuman` primitive so the decision *file* lands in the **user** commit (not Jarvis); the refs-index update stays a machine (Jarvis) write; the decision frontmatter records `actor=human`/`provenance=human-submit`. (Rejected: reuse `AppendDecision` and record human-ness only in frontmatter — it would credit Jarvis in git blame, which A names as the provenance mechanism, on the very surface built to enforce ownership.)

## Constraints inherited from the real codebase

U2 is designed against what A, B, and U1 actually ship. The load-bearing facts:

1. **A has no human-authored write path.** `Write` splices only *machine* regions and diff-validates that the human projection is byte-identical; `Create` records the file in `v.machineFiles`, so `Commit` attributes it to **Jarvis**. Human edits are assumed to arrive from *outside* Wave (Obsidian/editor) and land in the `add -A` **user** commit. So any U2 human write is the first FE-driven, human-attributed vault write and needs a new primitive (§1).
2. **`Commit` is caller-triggered; there is no idle/quit wiring in production.** Every consumer (`jarviscapture`, `jarviscontinuity`) writes then calls `v.Commit(ctx, label)` at its boundary. U2's write RPCs do the same — a human action *is* a lifecycle boundary — so U2 does not depend on the (still-unbuilt) idle-debounce/quit flush.
3. **`LoadDossier` does not project the human `## Notes` prose.** It returns the machine fields + the `state`/`refs`/`blockers` blocks, but not the leftover human body. U2's read RPC must surface the Notes separately (the body with machine blocks stripped) for read-only display.
4. **Decisions are reachable two ways** (B design §): a `Query(Filter{HasLink: dossierId})` over a `decisions`-scoped retriever, or `Expand` following the dossier's `refs`. The dossier's `refs` block mixes decision ids (`dec-<hex>`) and run ids (`run-<oid>`), so U2 resolves decisions by the `HasLink` query (robust; no prefix parsing).
5. **`status` is a machine-owned frontmatter key.** A human *triggering* a status change still routes through B's `SetStatus` (a machine write → Jarvis commit). This is correct: the human owns the *decision* (invariant 6), Jarvis maintains the *field*. Only the decision **file** append needs human attribution (constraint 1).
6. **The nav is registered in four places** (per U1/G's code map): the `SurfaceKey` union (`agents.tsx:29`) + `SURFACE_ORDER` (`agents.tsx:42`); `ICON` + `ITEMS` (`navrail.tsx`); the render switch (`cockpitshell.tsx:~101`). The shell already imports `JarvisSurface` from `view/jarvis` (`cockpitshell.tsx:15`) and renders it in the switch — the shell is the sanctioned composition root, the exception to "agents must not import the jarvis view." U2's `TasksSurface` wires in identically.

## The seam — the dossier view-model contract

The one new contract. Go structs are the source of truth (regenerated via `task generate`); the TS shape below is illustrative. The list reuses U1's **`SpaceSummary`** `{ id; objective; ticket; status; updated }` — it is the canonical dossier-summary projection (the name is inherited; a second identical struct would only duplicate it).

```
DossierDetail {
  id; ticket; objective; acceptance[]; confidence; status; created; updated;
  state;        // machine narrative block            (read-only)
  blockers[];   // machine                             (read-only)
  refs[];       // machine (traversable link targets)  (read-only)
  notes;        // human ## Notes prose                (read-only THIS cycle)
  decisions: DecisionCard[]
}

DecisionCard { id; created; actor; provenance; status; links[]; rationale }
```

- Every field the FE renders read-only carries **no** edit affordance. Only `decisions` (append) and `status` (transition) are writable this cycle; the contract does not need per-field ownership flags because ownership is fixed and known at render time.
- `notes` is present but read-only this cycle; carrying it now keeps the contract stable when in-Wave Notes editing lands later.

## Backend — A/B additions + RPCs

### A — one new primitive (`pkg/wavevault/write.go`)

```go
// CreateHuman is Create's twin but does NOT record the file in machineFiles, so Commit's `add -A`
// stage attributes it to the user, not Jarvis. The one human-authored create path from inside Wave.
func (v *Vault) CreateHuman(collection, filename, content string) (*WriteResult, error)
```

Identical to `Create` (same existence check, `MkdirAll`, write, hash) minus the `v.machineFiles[path] = h` line. Additive, non-breaking, mirrors an existing function; exercised by B's tests.

### B — human decision append (`pkg/jarvisdossier/decision.go`)

```go
// AppendHumanDecision mirrors AppendDecision but writes the decision file via CreateHuman (→ user
// commit) and forces Actor="human"/Provenance="human-submit". The refs-index link stays a machine
// (SetRefs → Jarvis) write. Rationale is the human's prose.
func AppendHumanDecision(v *wavevault.Vault, f DecisionFacts) (string, error)
```

Same body as `AppendDecision` (mint id, slugged filename, render, then `SetRefs` to link into the dossier) but the file is created with `CreateHuman` and `Actor`/`Provenance` are overridden. Consequence: the decision **file** commits as the user, the **refs index** update as Jarvis — the honest two-tier split. (Extracting the shared body of `AppendDecision`/`AppendHumanDecision` into a private helper parameterized by the create func + actor is a plan-time detail.)

### RPCs (`pkg/wshrpc/wshserver/wshserver_jarvis.go` + types in `wshrpctypes.go`; `task generate`)

All open the default vault (`wavevault.OpenVault`) and, for writes, commit at the boundary like `CaptureRunDispatch`.

- **`GetDossierCommand(dossierId) → DossierDetail`** — read. `LoadDossier` for the machine fields/blocks; `r.Read(id)` for the human `## Notes` (body with the `state`/`refs`/`blockers` blocks stripped); the decisions via `Query(Filter{HasLink: dossierId})` over a `decisions`-scoped retriever → `LoadDecision` each, newest-first.
- **`ListTaskDossiersCommand() → { dossiers: SpaceSummary[] }`** — read. **All** statuses (the FE groups Active/Paused/Done). Reuses U1's `listDossiers` core, **extended to take a status filter** (U1's `ListDossiersCommand` keeps active|paused; U2 passes the full set) — DRY at the core, U1 behavior byte-identical. The `sort` (newest-`updated` first) is unchanged.
- **`AppendDossierDecisionCommand(dossierId, summary, rationale, links?) → { decisionId }`** — write. `AppendHumanDecision` + `v.Commit("human: decision added — " + dossierId)`.
- **`SetDossierStatusCommand(dossierId, status)`** — write. Validate `status ∈ {active,paused,completed,archived}`; re-read the dossier for its current `Hash`; `SetStatus(v, id, status, hash)` + `v.Commit(dossierId + " → " + status)`. On `WriteResult.Conflict` (external edit underneath) re-read the hash and retry **once**, then surface.

## Frontend

### Nav registration

Add `tasks` to the `SurfaceKey` union + `SURFACE_ORDER` (`agents.tsx`), an `ICON` (a Lucide `ListTodo`/`ClipboardList`) + `ITEMS` entry (`navrail.tsx`), and a `surface === "tasks"` branch in the render switch (`cockpitshell.tsx`). **Placement: insert `tasks` between `memory` and `usage`** — knowledge-adjacent, and it appends near the end so it does **not** renumber the muscle-memory-heavy early `Ctrl+N` slots (a lighter touch than G's jarvis-second insertion).

### Files (under `view/jarvis/`, per the meta spec)

- `taskssurface.tsx` — the surface shell (uses `surfacescaffold`'s `SurfaceHeader`/`SurfaceEmptyState`/`SurfaceError`).
- `tasksstore.ts` — **module-scope** jotai atoms (never `useState`) so state survives the surface's nav-switch unmount (the standing surface-unmount gotcha): `taskListAtom`, `selectedDossierIdAtom`, `detailAtom` (loaded `DossierDetail`), `appendDraftAtom` (in-progress decision form), plus loading/error atoms. Mutators mirror `jarvisstore` conventions (`globalStore.set` at module scope): `loadTaskList()`, `selectDossier(id)` (fires `GetDossier` into `detailAtom`), `appendDecision(draft)`, `setStatus(id, status)`.
- `tasksderive.ts` (+ `tasksderive.test.ts`) — the pure, unit-testable logic (list grouping, region/decision-card derivation, status-transition + append-form validation).
- Component split (`taskdetail.tsx` / `decisionlog.tsx` / `appenddecisionform.tsx`) settled in the plan.

### Layout — master-detail (modeled on `ChannelsSurface`)

- **Left rail:** the dossier list grouped Active / Paused / Done; each row = objective + ticket tag + status. Uses the `CollapsibleRail` primitive with the narrow-window `railstore` persist pattern (as the Jarvis grounding rail does).
- **Center:** the dossier detail — a header (objective, ticket tag, the **status control**); then the machine regions (acceptance, `state` narrative, blockers, refs) inside a **muted "machine-maintained" panel with a small lock glyph, non-editable**; then the human `## Notes` prose rendered **read-only** (styled as "yours," no lock).
- **Decisions log:** a timeline of `DecisionCard`s (actor/provenance/date + a status badge + rationale), newest first, with an **"Add decision"** button opening the append form (summary + rationale textarea; optional `[[link]]` refs field). Submit → `appendDecision` → optimistic reload of `detailAtom`.
- **Status control:** a dropdown (active↔paused) plus complete/archive, with a **confirm** on the terminal transitions (completed/archived) via the existing `ConfirmDialog`. Submit → `setStatus`.

The heart of the surface is the **ownership treatment**: machine regions are unmistakably read-only and system-owned; the two human affordances (add-decision, status) are the only interactive controls. This is the inside-Wave tier made visible.

## Spaces (U1) integration — deep-link

The app-bar **Space chip** (`SpaceSwitcher`) gains an **"Open dossier"** row → sets `surfaceAtom = "tasks"`. The Tasks surface preselects the dossier by **reading `activeSpaceAtom`** (from `spacestore.ts` in `view/agents` — jarvis *may* import agents, so no import-rule violation) on mount when nothing is selected. Selecting a dossier *within* Tasks sets the internal `selectedDossierIdAtom` and does **not** change the active Space (the two are decoupled — focusing a Space and inspecting a dossier are different acts). No Space active → Tasks opens on the list.

## Degradation & edge cases

- **Vault absent / read fails** → the surface shows the empty state ("No tasks yet"), never errors the cockpit (the U1 posture; graceful degradation in spirit even though U2 is not a semantic consumer).
- **Write RPC error** → a surface-level error, dossier unchanged; the list/detail are re-fetched.
- **Status-write conflict** (external edit underneath) → re-read + retry once; if it still conflicts, reload the detail and tell the user it changed underneath — never a silent clobber.
- **A dossier completed/archived while selected** → it moves to the Done group and stays viewable; it does not vanish from under the user.
- **Empty decisions log** → an inline "No decisions yet · Add decision" affordance, never a blank void.

## Testing

Backend Go + FE vitest + CDP surface-smoke, matching U1/G. No jsdom render tests (standing decision).

- **Go** (`go test ./pkg/...`):
  - `CreateHuman` — the created file is **not** in `machineFiles`, so a subsequent `Commit` lands it in the **user** commit (assert git author), while a machine `Write`/`Create` in the same window lands in the Jarvis commit.
  - `AppendHumanDecision` — decision file → **user** commit; the `refs` update → **Jarvis** commit; frontmatter `actor=human`/`provenance=human-submit`; the decision is reachable from the dossier via `HasLink`/`Expand` (guards the body-block-link edge).
  - `GetDossierCommand` — assembles machine fields + the human `## Notes` (blocks stripped) + the decisions (newest-first) for a fixture dossier with two decisions.
  - `SetDossierStatusCommand` — happy path writes `status` + bumps `updated`; the conflict path re-reads and retries once; an invalid status errors.
  - `ListTaskDossiersCommand` — returns all statuses newest-`updated` first; U1's `ListDossiersCommand` still returns only active|paused (the shared-core refactor did not change it).
- **Vitest** (pure logic in `tasksderive`): summaries → grouped list; detail → rendered regions with fixed ownership; decision-card derivation + ordering; status-transition validation (allowed set); append-form validation (non-empty rationale).
- **CDP surface-smoke** (`task verify:ui` scenarios): (1) list + empty state; (2) detail with machine regions read-only/distinct; (3) decisions log; (4) append-decision form; (5) status control + confirm; (6) Space-chip deep-link preselects the dossier; (7) narrow-window rail collapse.

## Internal decomposition (the implementation plan will order these)

1. **A/B write primitives:** `CreateHuman` (A) + `AppendHumanDecision` (B), with Go tests. ← the honest-attribution core; nothing else can write.
2. **Read + write RPCs:** `GetDossierCommand`, `ListTaskDossiersCommand` (shared-core refactor), `AppendDossierDecisionCommand`, `SetDossierStatusCommand` (+ `task generate`), with Go tests. ← pins the view-model contract.
3. **Surface shell + nav + store:** `tasks` nav registration, `taskssurface.tsx`, `tasksstore.ts`; list + empty state render, selection loads detail. Unmount-safe.
4. **Detail rendering + ownership treatment:** machine read-only panel, human Notes read-only, decisions log; CDP.
5. **The two write affordances:** append-decision form + status control (with confirm); wired to the RPCs; CDP.
6. **Spaces deep-link:** the "Open dossier" row on the Space chip + `activeSpaceAtom` preselect.

Steps 1–2 are the contract-pinning backend; 3–5 are the surface; 6 is the integration. Step 1 is independent; 2 depends on 1; 3–6 layer on the store.

## File-touch map

**Go — modified:**
- `pkg/wavevault/write.go` (`CreateHuman`) + `write_test.go`.
- `pkg/jarvisdossier/decision.go` (`AppendHumanDecision`, shared-helper extraction) + `decision_test.go`.
- `pkg/wshrpc/wshserver/wshserver_jarvis.go` (four RPCs + the `listDossiers` status-filter refactor) + `wshserver_jarvis_test.go`.
- `pkg/wshrpc/wshrpctypes.go` (command declarations + `DossierDetail`/`DecisionCard` wire types; the list reuses U1's `SpaceSummary`). Regenerate: `wshclient`, `wshclientapi.ts`, generated TS/Go types via **`task generate`**.

**Frontend — new** (under `frontend/app/view/jarvis/`): `taskssurface.tsx`, `tasksstore.ts`, `tasksderive.ts` (+ `tasksderive.test.ts`), and the detail/decision-log/append-form components (split at plan time).

**Frontend — modified:**
- `frontend/app/view/agents/agents.tsx` (`SurfaceKey` + `SURFACE_ORDER`).
- `frontend/app/view/agents/navrail.tsx` (`ICON` + `ITEMS`).
- `frontend/app/view/agents/cockpitshell.tsx` (render switch — add the `tasks` branch, import `TasksSurface`).
- The `SpaceSwitcher` app-bar component (U1) — add the "Open dossier" row (sets `surfaceAtom="tasks"`).

**Docs:** the v2 meta-spec tracking-table U2 row (spec + plan links) lands at **U2 feature-commit time**, not now (the A–G/S1/U1 precedent: avoid mid-plan edits to the shared meta-spec file). `docs/deferred.md` — the deferrals below.

## Out of scope (this cycle)

- **In-Wave `## Notes` prose editing** — read-only here; editing stays an external-editor/Obsidian flow (recorded in `docs/deferred.md`). The `notes` contract field is present so editing can land later without a contract change.
- **Editing non-reserved (human-owned) frontmatter keys** — deferred with Notes editing.
- **Editing an existing decision** — decisions are append-only; only `SupersedeDecision` (a machine `status` mutate) exists, and it is not exposed as a human affordance this cycle.
- **Manually authoring a new dossier** — dossiers are created by run dispatch (`jarviscapture`); an in-Wave "New task" form is a separate effort.
- **Attribution confidence / provenance / probation edge rendering** — that is D's model and U3's graph; U2 renders `refs` as plain read-only links.
- **The Graph surface (U3)** and any semantic/embedding behavior (S-lane).
- **Live scope/detail push** — the list and detail are re-fetched on action, not pushed.

## Open risks

- **Two list commands / shared-core refactor.** Extending `listDossiers` to take a status filter touches U1's code path; the risk is regressing the switcher's active|paused semantics. Mitigation: U1's `ListDossiersCommand` keeps its exact filter and its Go test is unchanged; the refactor is proven by both tests.
- **`GetDossier` decision assembly cost.** Resolving decisions via a `decisions`-scoped `HasLink` query is an O(vault) scan (A has no persistent index in v1) per open. Fine at v1 scale (dozens–hundreds of small files), same posture as A's `Search`; persistence is the documented later lever.
- **Human/Jarvis mixed-file commit ordering.** A human decision append is two writes (user file + Jarvis refs) in one `Commit`; ownership staging is file-granular, so the decision file (user) and the dossier (Jarvis, refs changed) land in separate commits correctly. If a human had *also* edited the dossier's Notes externally in the same window, that dossier commits wholesale under the user identity (A's documented file-granular rule) — acceptable, and the refs edit is still applied.
- **Status write vs. external edit.** The conflict path retries once; a user rapidly toggling status while Obsidian rewrites the file could still surface a conflict — by design it reloads rather than clobbers.
- **Windows path limits.** Any U2-triggered decision filename uses B's existing bounded-slug discipline (B already owns this); U2 adds no new filename generation.
