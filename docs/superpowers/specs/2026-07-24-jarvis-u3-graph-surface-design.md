# Jarvis second brain — U3: Graph surface design

**Date:** 2026-07-24
**Status:** Design complete; pending spec review, then implementation planning.
**Type:** Sub-project spec (sub-project **U3** of the [v2 meta spec](2026-07-24-jarvis-second-brain-v2-meta-spec.md)). One `spec → plan → implementation` cycle.

**Builds on (read first):**
- [Jarvis second brain — v2 meta spec](2026-07-24-jarvis-second-brain-v2-meta-spec.md) — v2 decomposition, the added invariants, the UX lane, and U3's responsibility boundary.
- [Jarvis second brain — v1 meta spec](2026-07-23-jarvis-second-brain-meta-spec.md) — the nine inherited invariants (esp. **9: cockpit design language**) and the built A–G subsystems this consumes.
- [A — Wave Vault](2026-07-23-jarvis-a-wave-vault-design.md) — the vault, its collections, and the wikilink read primitives (`Retriever`, `Expand`).
- [D — attribution](2026-07-24-jarvis-d-attribution-design.md) — the confidence-weighted dossier→Run edges (`EdgesFor`), their layers/provenance/state, and the detach/probation machinery.
- [U1 — Presence C ("Spaces")](2026-07-24-jarvis-u1-spaces-design.md) — the UX-lane pattern this mirrors (cheap-list + lazy-resolve commands, module-scope store, snapshot semantics, graceful-degradation posture).

This spec does not restate those invariants or decisions. It records the decisions left to U3, the engineering architecture, and the scope of this cycle.

## What U3 is

A **new cockpit surface** rendering the Jarvis vault as a graph: the human-authored **wikilink web** (task↔decision↔memory) as the durable map, with a task's **typed attribution edges** to its Run objects blooming in on focus. It is on the v2 **UX lane** — it consumes only already-built v1 subsystems (A's wikilink read + D's `EdgesFor`), makes **no model call**, and has **no embedding dependency** (v2 invariant 10/11): L4 semantic edges simply appear in the graph once they exist in `EdgesFor`'s output; nothing in U3 waits on them.

### Distinct from the existing "Memory" surface

The cockpit already has a **Memory** graph (`frontend/app/view/agents/memgraph.tsx`, `Network` icon) — but it renders a *different* vault: `memvault` (`~/.waveterm/memory` + each agent's native `~/.claude` / `~/.codex` memory dirs), via `MemoryScanCommand`. U3 renders the separate **`wavevault`** (`~/.waveterm/vault`: `tasks/`, `decisions/`, `memory/`) *plus* the attribution edges to Run objects. Different data, different graph → a genuinely new surface. `memgraph.tsx` is strong, directly-reusable prior art for the *rendering*, not a surface to extend (see §Renderer strategy).

## Decisions this cycle settled (during brainstorming)

1. **Scope model: whole-vault map, Runs bloom on focus.** The default canvas is every vault node (tasks/decisions/memory) + all wikilinks — the durable, human-authored structure. Selecting a dossier resolves and blooms *its* attributed Run nodes + typed edges. Rejected "all Runs always" (Runs are the one unbounded node class — every dispatch mints one, and S2's L4 / S3 proactive keep *adding* dossier→Run edges over time, so a firehose default ages into a hairball; it also forces a whole-vault attribution assembler at load). Rejected "seeded neighborhood only" (throws away the at-a-glance map, the whole point of a graph view). "All Runs" remains a cheap future toggle if usage ever demands it — YAGNI until then.
2. **Interaction: a map, not a reader or editor.** Hover → tooltip; click a node → select (focus/dim neighborhood; for a dossier, bloom its Runs) + a compact **selection card** (essentials only). No full-body reading rail — reading a dossier is U2's job, reading a memory note is the Memory tab's job; a read rail here would duplicate both and blur what the surface is for.
3. **Read-only.** No editing, no hand-drawn edges, no detach from the graph this cycle (meta spec U3 "Out of scope"). Edges are produced by attribution and corrected by detach in D's own machinery, surfaced elsewhere. U3, like U1, is a pure-read lens.
4. **Cross-surface "open →" navigation deferred.** The selection card leaves a single slot for a future "open in…" (Run → its transcript in Agent, task → enter its Space), but this cycle builds no cross-surface nav — the most natural target (the U2 Tasks editor) isn't built, and it couples U3 to other surfaces.

## Node model — heterogeneous, two origins

- **Vault nodes** (from `wavevault.Node`): `kind` derived from `Collection` → `task` | `decision` | `memory`. Label = the dossier `objective` for a task; for a decision/memory node, its frontmatter `title` if present, else its `id`. Carries `status` (from frontmatter; absent for memory notes) and `updated`. These are the base canvas.
- **Run nodes** (from `waveobj.Run`; bloomed on focus only): `id = "run:"+OID`, label = `Goal`, `status` (`planning|awaiting-review|executing|blocked|done|cancelled`). Rendered as a **distinct shape** (not the Markdown circle) so evidence reads apart from notes at a glance.

## Edge model — two kinds

- **Wikilink** (vault↔vault, untyped) — the resolved `[[links]]` graph: an edge only when both endpoints exist in scope (danglers skipped, exactly as A already does). The base map's edges.
- **Attribution** (dossier→Run, typed; bloom only) — from `jarvisattrib.EdgesFor`, carrying the three dimensions `EdgesFor` actually exposes on each `AttributedEdge`:
  - `provenance` — `dispatch` | `ticket-match` | `structural` | `semantic`;
  - `confidence` + its `Bucket()` — `weak` | `medium` | `strong`;
  - `state` — `informing` | `confirmed` (`detached` is already dropped by `EdgesFor`).

  These three drive the "render distinctly" the meta spec calls for (§Visual encoding). **Probation is deliberately not a wire field:** `AttributedEdge` carries no timestamp, and probation is an internal, computed harden-gate in D's `extract.go` (not a stored/exposed value). The *provisional* look the meta spec wants is carried by `state=informing` (an inferred, not-yet-hardened edge) — no new data invented, no change to D's core type.

## The seam — two pure-read commands

Both live in `pkg/wshrpc` (Go source of truth → `task generate` regenerates TS/Go bindings), mirroring U1's cheap-list + lazy-resolve split. Both are **pure reads**: no model call, no embeddings, no new WaveObj, no migration. Go structs are the source of truth; the TS shapes below are illustrative.

```
GraphNode  { id; kind; label; status; updated }          // kind: task|decision|memory|run
GraphLink  { from; to; kind; provenance?; bucket?; state? }  // kind: wikilink|attribution
```

- **`VaultGraphCommand() → { nodes: GraphNode[], links: GraphLink[] }`** — the default canvas. One `Retriever(AllScope())` scan → all vault nodes + resolved wikilink edges. Cheap: one FS scan (like `MemoryScanCommand`), **no Runs, no attribution, no per-dossier edge resolution at load** — this is what keeps the whole-vault default bounded. Needs a small **`Retriever.Graph() → *Subgraph`** in `wavevault` (all nodes + all resolved edges; `load()` already computes both internally — this just exposes them, mirroring `Expand`).
- **`ResolveDossierEdgesCommand(dossierId) → { runs: GraphNode[], links: GraphLink[] }`** — the focus/bloom resolver, called lazily on dossier select. `EdgesFor(dossierId)` → a Run node per attributed run (from the `Run` object) + a typed attribution link carrying provenance/bucket/state. Missing-run tolerant (surface the edge, skip the node — mirrors `buildSpaceScope`).

**Why not reuse `ResolveSpaceScope`.** It returns `RunORefs` and *discards* both the edge metadata (confidence/provenance/state) and the Run display fields — exactly what the graph needs. Different return shape → a new command, not an extension.

**Graceful degradation** (U1's posture, applied even though U3 is not a semantic consumer): vault absent or scan fails → `VaultGraphCommand` returns empty → the surface shows a "No vault yet" empty state, never an error. A `ResolveDossierEdges` failure leaves the dossier selected with no bloom and is logged at the boundary; it never errors the surface.

## Frontend — nav surface

- New `SurfaceKey` `"graph"` in `frontend/app/view/agents/agents.ts`; add to `navrail.tsx` `ICON` (**`Waypoints`** — `Network` is Memory's) and `ITEMS` (label **"Graph"**), placed after `jarvis` (it is a Jarvis-vault surface).
- Files under `frontend/app/view/jarvis/`: `jarvisgraphsurface.tsx` (wrapper + empty/error/loading states), `jarvisgraph.tsx` (the canvas), `jarvisgraphstore.ts` (atoms + loaders).

## Frontend — renderer strategy (fork, reuse the pure math)

- **(a) Generalize `memgraph.tsx` into one shared component** — rejected. It is deeply bound to `memstore` atoms and memory node types; generalizing for two divergent data models now is speculative abstraction (don't abstract for a single-ish use).
- **(b) Fork the component, import the generic layout helpers — chosen.** New `jarvisgraph.tsx` reuses the rendering *patterns* (lazy `ForceGraph2D`, module-scope position/camera cache, `@theme`-token canvas colors resolved via `getComputedStyle`, the calm warmup→settle, degree-ranked de-collided labels, hover halos, the `refresh()` pump — see [[memory-graph-force-graph-lib]]) and **imports `memgraphlayout.ts`** (`degreeMap`, `degreeRank`, `graphSignature`, `labelBudget`, `seedPosition`, `truncateTitle`) directly. jarvis may import from agents (the established one-way import rule; agents must not import jarvis). DRY on the layout math; independent rendering for the divergent data model.
- **(c) Build fresh** — rejected: throws away the settle/label/camera work.

## Frontend — visual encoding

- **Node kinds → color** via new `@theme` tokens in `tailwindsetup.css` (`--color-graph-task` / `-decision` / `-memory` / `-run`; never raw hex — [[no-hardcoded-colors-use-theme-tokens]]). Runs get a **distinct shape** (square/diamond vs the Markdown circle).
- **Edge kinds → style.** Wikilinks render like memgraph's plain links. Attribution edges are typed: `state=informing` → dashed (the provisional/not-yet-hardened look), `confirmed` → solid; `bucket` → opacity + width (weak faint/thin … strong bright/thick); `provenance=semantic` (L4) renders in a distinct low-confidence hue, parallel to the ambient-tag look.
- **Legend** — the pinned overlay carries both a node-kind legend and a short edge legend (wikilink vs attribution; weak/probation treatment).
- **Selection card** — a compact pinned overlay (not a rail): title / kind / status, and for a focused dossier a short list of its bloomed Runs with confidence-bucket badges. Holds one deferred slot for a future "open →" (not built this cycle).

## Frontend — state (`jarvisgraphstore.ts`)

Module-scope jotai atoms (never component `useState`) so state survives the nav-switch unmount ([[surfaces-unmount-on-nav-switch]]), mirroring `memstore`/`spacestore` conventions (`globalStore.set` at module scope):

- `graphBaseAtom: { nodes; links } | null` — the base map from `VaultGraphCommand`.
- `graphLoadedAtom`, `graphErrorAtom` — loaded/error posture (so an empty base reads as "no vault" vs "load failed", like `memErrorAtom`).
- `graphSelectedIdAtom: string | null`.
- `bloomAtom: Map<dossierId, { runs; links }>` — accumulates focus-resolved attribution; a re-focus reuses the cached bloom.
- Loaders `loadGraph()` and `focusDossier(id)` (fires `ResolveDossierEdges` into `bloomAtom`). **Snapshot semantics** like U1 — re-resolved on load/focus, no live push this cycle.

The **rendered data** = `graphBaseAtom` merged with the bloomed runs/edges for selected (and previously-bloomed) dossiers — a pure, unit-testable merge (dedup by id), gated on a structural signature exactly as memgraph's memoized `data` is.

## Edge cases

- **Empty vault** (no nodes): the "No vault yet" empty state, never a blank canvas.
- **Isolated nodes** (a node with no resolved wikilinks): rendered, softly de-emphasized (memgraph's degree-0 treatment) — never dropped.
- **A dossier with zero attributed Runs:** selecting it focuses/dims the neighborhood and the card shows "no attributed runs yet" — the bloom is simply empty.
- **An attribution edge to a Run missing from the store:** the edge is surfaced (its metadata still reads), the Run node skipped — mirrors `buildSpaceScope`'s tolerance.
- **Re-focusing a previously-bloomed dossier:** served from `bloomAtom` cache; no re-resolve.

## Testing

- **Go** (`go test ./pkg/...`): `Retriever.Graph()` (all nodes + resolved edges; dangling-link skip; scope boundary). `VaultGraphCommand` (node+wikilink assembly). `ResolveDossierEdgesCommand` (edge→run-node + typed-link; `bucket`/`provenance`/`state` mapping; missing-run tolerance) — reuse D's/A's test vaults and runs.
- **Vitest** (pure logic, no render harness — standing decision [[surface-render-tests-declined]]): Go-rtn→`GNode`/`GLink` adapters; edge-style mapping (bucket/state/provenance → visual props); base+bloom merge/dedup; selection-card derivation.
- **CDP surface-smoke** (`task verify:ui` scenarios): (1) base map renders; (2) focus a task blooms Runs + typed edges; (3) weak/semantic edge styling; (4) empty-vault empty state; (5) legend + zoom controls.

## Internal decomposition (the implementation plan will order these)

1. Backend: `Retriever.Graph()` + `VaultGraphCommand` + `ResolveDossierEdgesCommand` (+ `task generate`) with Go tests. ← pins the seam.
2. `jarvisgraphstore.ts` (atoms + loaders) + nav surface (`SurfaceKey`, rail entry) + `jarvisgraph.tsx` base map rendering end-to-end (**wikilinks only**, no bloom yet).
3. Focus-bloom: `focusDossier` + Run nodes + typed attribution edges + the edge visual encoding + the selection card.
4. Legend + zoom polish + empty/error/loading states + CDP surface-smoke.

Step 1 pins the contract; 2 stands up the map; 3 is the payoff (attribution); 4 is polish and verification.

## Design constraints inherited (quick reference)

Dark mode only ([[cockpit-light-mode-wontfix]]); preserve the 78px nav rail (Graph is a non-destructive rail addition); colors are `@theme` tokens in `tailwindsetup.css` — never raw hex ([[no-hardcoded-colors-use-theme-tokens]]); existing cockpit fonts; restrained motion (reuse memgraph's reduced-motion guards); the `react-force-graph-2d` canvas must not repaint-stall — reuse memgraph's manual `refresh()` pump ([[memory-graph-force-graph-lib]]); must feel native to the cockpit. Do not build on `aiusechat` ([[wave-ai-on-chopping-block]]; U3 makes no model call anyway).

## Out of scope (this cycle)

- **Editing / detach from the graph** — read-only; corrections stay in D's attribution machinery (meta spec U3 "Out of scope").
- **Full body reading rail** — U2 (Tasks editor) and the Memory tab own reading a node's content.
- **Cross-surface "open in…" navigation** — deferred fast-follow; the card holds the slot.
- **Live scope push** — the base graph and blooms are re-resolved snapshots (like U1), not live-pushed.
- **"All Runs always" firehose mode** — a future toggle only if usage demands it.
- **Anything semantic / embedding** — no dependency; L4 edges appear once present in `EdgesFor`.
- The Tasks dossier editor (U2) — a separate sub-project.
