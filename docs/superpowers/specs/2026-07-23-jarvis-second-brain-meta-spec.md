# Jarvis second brain — v1 meta spec

**Date:** 2026-07-23
**Status:** Decomposition agreed. Sub-project specs to follow; built one at a time from this file.
**Type:** Meta spec — umbrella / decomposition index. Not an implementation plan, and not a restatement of the decisions below.

**Scope.** This file sequences the build of the full **v1** Jarvis second brain into independent sub-projects. It does *not* re-decide the product and architecture already settled in:

- [Wave Vault direction brief](../briefs/2026-07-22-jarvis-second-brain-wave-vault-brief.md) — the storage substrate (approved).
- [Jarvis second brain — design](2026-07-22-jarvis-second-brain-design.md) — the four load-bearing decisions (recall, attribution, write-ownership, presence), the cost model, and the v1/v2 sequencing.
- [Jarvis second brain — UI design brief](../briefs/2026-07-23-jarvis-second-brain-ui-design-brief.md) — realized as `Wave-jarvis-second-brain.dc.html` in the `wave` Claude Design project (4 frames, all 12 required states).

Read those first; everything here assumes them.

## What this document is

The parent index for building v1. **Each sub-project below gets its own `spec → plan → implementation` cycle** under `docs/superpowers/`. This file owns only what is cross-cutting and must not drift per sub-project:

- the **invariants** every sub-project inherits;
- the **decomposition** (A–G) and each piece's responsibility boundary;
- the **seams** (typed interfaces) that let the pieces be built and tested independently;
- the **v1/v2 boundary** (what is explicitly deferred);
- the **build order** (advisory; the dependency DAG is the hard constraint);
- a **living tracking table** — link each sub-project's spec/plan here as it is written.

When we "build 1 by 1," we run one sub-project's full cycle, update the tracking table, and return here to pick the next.

## v1 in one paragraph

Jarvis becomes Wave's app-wide second brain over a local, Obsidian-compatible, git-backed **Wave Vault** of canonical Markdown. v1 delivers **recall + continuity**, backed by **deterministic attribution (layers 1–3)**, presented through **presence D** — ambient signals, the existing `Ctrl+P` palette for a quick ask, and a first-class **Jarvis cockpit surface**. No embeddings, no semantic recall, no semantic attribution, no proactive resurfacing — those are v2.

## Cross-cutting invariants

Every sub-project inherits these. A sub-project spec may add constraints but may not contradict one.

1. **Determinism boundary = cost boundary.** Only a model call costs tokens. Recording facts, git, frontmatter/full-text queries, wikilink traversal, and content-hash invalidation are deterministic and free. The model runs only to summarize, judge, or converse — at explicit boundaries or on demand, **never on a background poll**.
2. **Model tiers.** A cheap model (Haiku-class) does grunt work — boundary summaries, traversal navigation, draft rationale. A capable model (Opus/Sonnet) is reserved for final synthesis and conversation. Tiering is internal; it is **not** a user-facing model picker.
3. **Markdown is canonical.** Any index or cache must be rebuildable from the files. No second authoritative store in SQLite synced back to Markdown.
4. **Collection boundary in code, not prompt.** `memory/**` is projectable into agent steering context; `tasks/**` is never auto-projected. Retrievers are scoped by the tool set handed to them, not by asking the model to ignore files.
5. **Write-ownership.** Three region classes per dossier (machine-exclusive frontmatter keys + one state-summary block; human-exclusive prose and non-reserved keys; append-only-shared decisions/blockers). Writes go through a **region-aware, diff-validated, conflict-aware** writer that rejects any change outside a machine-owned region. On a human edit inside a machine region, the human wins and it is flagged — never silently clobbered.
6. **Human owns material decisions and completion.** Jarvis never invents a decision, declares a task complete, or rewrites official ticket state. Code creates entry scaffolds from deterministic facts; the model only drafts rationale.
7. **Grounding is first-class.** Every factual claim cites the node/section it came from. "Not found" and "weak candidate" are rewarded terminal states — no confabulation to fill a gap. Freshness is resolved from the authoritative store at synthesis time; stale and unavailable sources are surfaced, not hidden.
8. **Presence D.** Ambient signals + `Ctrl+P` reuse + a first-class Jarvis surface. No second command palette, no new global shortcut, no permanent assistant panel on every surface, and Tasks do not dominate the hierarchy. (Presence C — task-focus "Spaces" — is deferred.)
9. **Wave cockpit design language.** Dark mode only (no light/Paper variant). Preserve the 46px app bar and 78px nav rail. Colors are `@theme` tokens in `tailwindsetup.css` — never raw hex. Use existing fonts and restrained motion. Jarvis must feel native to the cockpit, not like an embedded third-party chat app.

## Subsystem decomposition

| # | Sub-project | One line | Depends on |
|---|---|---|---|
| **A** | Wave Vault foundation | Git-backed vault + the region-aware write machinery | — |
| **B** | Dossier & structured records | The dossier schema, records, parser/renderer | A |
| **C** | Recall engine | Retrieval layers 1–2, traversal, grounding, learning store | A, B |
| **D** | Attribution engine | Typed edges w/ provenance+confidence, layers 1–3 | A, B |
| **E** | Continuity | Lifecycle-boundary capture; pause/resume narrative | A, B, C |
| **F** | Jarvis conversation backend | The service the surface calls; recall/continuity orchestration + streaming | C (E, D) |
| **G** | Jarvis UI surface | The `.dc.html` realized: surface, quick-ask, contextual entry, 12 states | F (or its contract) |

### A — Wave Vault foundation
**Purpose.** The storage substrate the rest of v1 rests on.
**Responsibilities.** Create/locate the vault (user-selectable path; default `~/.waveterm/vault/`) as its own git repo; enforce the collection boundary (`memory/` · `tasks/{active,archive}/` · `decisions/` · `attachments/`); parse/serialize Markdown + YAML frontmatter + `[[wikilinks]]`; the **coarse commit cadence** (task lifecycle boundaries + idle/quit safety flush) with ownership-staged commits (machine as `Jarvis`, human as the user); the **generic region-aware, diff-validated, conflict-aware write path** (mechanism — the specific regions are B's policy); a rebuildable derived layer (search index/cache) kept out of the vault.
**Interface (exposes).** Vault read API (structured frontmatter query, full-text, wikilink neighborhood expansion, per-node content hash) and vault write API (region-aware splice + ownership-staged commit).
**Out of scope (v2).** Embedding index and its rebuild/freshness story.

### B — Dossier & structured records
**Purpose.** The shape of a task dossier and its machine-maintained records.
**Responsibilities.** The dossier frontmatter schema (reserved machine keys: status, ticket ref, objective snapshot, acceptance criteria, reference wikilinks, confidence, timestamps) + one delimited state-summary block; decisions and blockers as **fenced-YAML records with prose rationale beneath**, immutable append-only, field-granular ownership, tolerant parsing (no migrations); the renderer Wave owns. Defines *which* regions are machine-owned so A's writer can enforce them.
**Interface (exposes).** Typed dossier model + record read/append/status-mutate operations layered on A's write API.
**Out of scope.** The dossier *editor UI* (a future Tasks surface); referencing (not copying) external records is a rule, not a feature here.

### C — Recall engine
**Purpose.** Find the slice (deterministic, free) so the model can answer from it (bounded).
**Responsibilities.** Retrieval layer 1 (structured frontmatter `WHERE`) and layer 2 (full-text); **wikilink graph traversal** — model picks seeds, code expands the neighborhood breadth-first to bounded depth/fanout along typed edges, model reads the assembled subgraph once and either answers or requests one more named expansion; grounding assembly (traversal path = citation); `answered` / `weak` / `not-found` terminals; freshness resolution from authoritative stores at synthesis time; the **cache-tier learning store** (materialize high-confidence cited answers to the derived layer; content-hash invalidation marks stale, re-materialize lazily); **per-caller scope enforcement** (interactive queries see everything; worker-prompt assembly gets a retriever that physically cannot see other tasks).
**Interface (exposes).** `recall(query, scope) → { segments, citedNodes, terminal, freshness }` plus a stream of working steps.
**Out of scope (v2).** Semantic/embedding retrieval (layer 3); knowledge-slow promotion is human-gated and lives at the memory boundary, not here.

### D — Attribution engine
**Purpose.** Produce and maintain the typed edges recall traverses.
**Responsibilities.** Edges as first-class records carrying provenance + confidence; **layer 1** (active-task context), **layer 2** (identifier match in branch/commit/PR/Channel name — reuses the Run `BaseCommit..EndCommit` range), **layer 3** (structural correlation: same repo + overlapping window, weak prior); optimistic attach + one-click detach; **probation** before a fuzzy edge may feed the learning store; self-correction when a deterministic fact contradicts a guess; time-boxing and batched retroactive backfill.
**Interface (exposes).** Edge store read/write; confidence-weighted edges for C's traversal.
**Out of scope (v2).** Layer 4 (semantic inference matching Run objective/diff to acceptance criteria).

### E — Continuity
**Purpose.** Pre-computed context recovery across pauses.
**Responsibilities.** Capture the narrative summary once per lifecycle boundary (code records facts during work; the cheap model writes the summary at the boundary); serve resume for free; one refresh only if facts changed since the pause.
**Interface (exposes).** `resume(task) → precomputed narrative`; invalidation hook on fact change.
**Out of scope (v2).** Proactive resurfacing (event-triggered recall).

### F — Jarvis conversation backend
**Purpose.** The app-facing service the surface talks to.
**Responsibilities.** Start/continue a conversation; drive C for recall and E for continuity; stream the answer plus visible working steps and citations; apply model tiering; resolve scope (current object / project / all Wave / attached sources); accept contextual-entry attachments; carry a quick-ask question + answer + sources into a full conversation without a context break. Cross-process behavior is a **wshrpc command** (`pkg/wshrpc`); new wire types are generated via `task generate` (Go is source of truth).
**Interface (exposes).** The **conversation view-model contract** consumed by G (see Seams).
**Out of scope.** Retrieval configuration and prompt engineering exposed to the user.

### G — Jarvis UI surface (the `.dc.html`)
**Purpose.** Realize the design as a native cockpit surface.
**Responsibilities.** A first-class `jarvis` nav destination; the three-region composition (conversation-history rail · central conversation · grounding rail) with narrow-window collapse; all 12 states (empty, active, grounded, working, weak, not-found, stale; quick-ask composing / cited answer / handoff; contextual invocation; narrow window); inline `[n]` citations opening native source surfaces; scope chips near the composer; the `Ctrl+P` **"Ask Jarvis" lead group** and its handoff into the surface; small contextual-entry actions on existing surfaces (Run, Radar, Memory) — not inline chat panels. Built against F's contract; token/font-translated to the cockpit.
**Interface (consumes).** F's conversation view-model.
**Out of scope.** The Tasks dossier-editor surface and the Graph surface (separate designs); the composer model-picker shown in the mockup (invariant 2).

## Seams

The typed interfaces that make each piece independently buildable and testable. Getting these right is the point of a meta spec.

- **G ⇄ F — conversation view-model.** The single most important contract. It is the data G renders for every one of the 12 states: user/Jarvis turns; streamed working-steps (done/active/pending); answer segments interleaved with citation refs; grounding cards (type, title, project, age, freshness: fresh/stale/unavailable); scope chips; and the weak / not-found / stale variants. **G's spec defines this contract; F implements it.** Building G first pins it.
- **F ⇄ C — recall API.** `recall(query, scope)` returning grounded segments, cited nodes, a terminal (`answered` | `weak` | `notfound`), and freshness; plus a working-step stream.
- **F ⇄ E — continuity API.** `resume(task)` returning a precomputed narrative, refreshed only on fact change.
- **C/D ⇄ A/B — vault read + edge store.** Structured query, full-text, wikilink expansion, node content-hash (from A/B); typed confidence-weighted edges (from D).
- **all ⇄ A — vault write API.** Region-aware, diff-validated, conflict-aware; ownership-staged commits.

## Build order

The dependency DAG is the hard constraint; the sequence within it is advisory and chosen per cycle.

**Hard dependencies:** `A → B → {C, D}`, `C → {E, F}`, `F → G`. (D feeds C's traversal weighting and F's scope, but C can start with layer-1/2 edges before D exists.)

**Recommended sequence — contract-first:** **G → F → A/B → C → D → E.**

- **Rationale.** G is the named deliverable and the least-reversible decision (UX). Making it render all 12 states pins the F contract exactly, which de-risks the entire backend. It is demoable after one cycle.
- **How the dependencies are honored out of order.** Contract-first satisfies each unmet dependency with a **fixture or shim at the seam**, replaced by the real subsystem in a later cycle: G runs on fixtures; F is first backed by a shim recall over *existing* Wave SQLite objects (runs, decisions, memory, radar) before the vault exists; A/B/C then replace the shim behind the same contract.
- **Alternative — substrate-first:** **A → B → C/D → F → G.** No shims, everything real as it lands, but nothing demoable until late and the UX (the expensive-to-change part) is validated last.

Either is legitimate; pick the next slice from the tracking table when its dependencies (real or shimmed) are met.

## Integration & naming notes

- **Name collision.** `Jarvis` today is the Channels-bound fleet manager (`frontend/app/view/agents/jarvisderive.ts`, `jarviscards.ts`) — it composes a prompt for a headless `claude -p` fleet summary and auto-answers worker asks. The v1 second brain reuses the name for a superset. **G's spec must decide** whether the fleet manager becomes a mode/entry of the new Jarvis or stays a distinct Channels feature, and must namespace new code (e.g. `frontend/app/view/jarvis/`) to avoid confusion with `view/agents/`.
- **Nav.** Add a `jarvis` value to `SurfaceKey` and an entry to `ITEMS`/`ICON` in `frontend/app/view/agents/navrail.tsx`. Do **not** adopt the mockup's reduced/reordered rail — extend the real one.
- **Backend spine.** New cross-process behavior is a wshrpc command in `pkg/wshrpc`; regenerate TS/Go bindings with `task generate` after any type change. The vault path is user-selectable (default `~/.waveterm/vault/`).
- **Tokens & fonts.** Translate the mockup's hex palette to `@theme` tokens (its accent `#7c95ff` already matches the cockpit `accent`); use existing cockpit fonts, not the mockup's Hanken Grotesk / JetBrains Mono imports.
- **Design deltas to reconcile** (from the design/spec conformance review):
  - Drop the composer **model-picker** — model selection is a UI-brief non-goal and contradicts invariant 2.
  - The mockup omits presence-D's **ambient attribution** (task tags on agent/Channel/Run rows, inline "relevant past decision" cards). Decide whether that lands in G or a later ambient-presence slice; it is not depicted in the current design.
  - The **write-ownership dossier editor** and the **Graph surface** are not in this design — they are separate future surfaces, tracked under the v1/v2 boundary.

## v1 / v2 boundary

Explicitly deferred out of v1:

- Embedding index and its rebuild/freshness story → unlocks semantic recall (layer 3), semantic attribution (layer 4), and proactive resurfacing together.
- Proactive resurfacing (recall triggered by an event rather than a question).
- Presence C (task-focus "Spaces").
- The Tasks product surface (dossier editor rendering machine regions read-only, append-entry decisions log) and the Graph surface — the vault is the substrate; these surfaces are separate design efforts.
- Cross-machine sync (a user-configured git remote provides it; Wave implements no sync).

## Tracking table

Living index — link each artifact as it is produced.

| # | Sub-project | Spec | Plan | Built |
|---|---|---|---|---|
| A | Wave Vault foundation | [spec](2026-07-23-jarvis-a-wave-vault-design.md) | [plan](../plans/2026-07-23-jarvis-a-wave-vault.md) | Built — git-backed vault + region-aware write path + deterministic read/expand APIs + ownership-staged commits (`pkg/wavevault`) |
| B | Dossier & structured records | [spec](2026-07-24-jarvis-b-dossier-design.md) | [plan](../plans/2026-07-24-jarvis-b-dossier.md) | Built — typed Dossier + separate-file decision records over A (`pkg/jarvisdossier`); region-safe machine setters + append-only decisions + `wavevault.Create` |
| C | Recall engine | [spec](2026-07-24-jarvis-c-recall-design.md) | [plan](../plans/2026-07-24-jarvis-c-recall.md) | Built — pure-vault recall replacing F's SQLite shim: deterministic query analysis → layer-1 ticket `Query` + layer-2 full-text `Search` → ranked seeds → bounded `Expand`, referenced Runs resolved live from `wstore` (missing → surfaced `unavailable`); thin dispatch→dossier capture writer (`pkg/jarviscapture`) behind the unchanged `Converse` protocol (`pkg/jarvisrecall`). One model call (synthesis); no new WaveObj/RPC |
| D | Attribution engine | [spec](2026-07-24-jarvis-d-attribution-design.md) | [plan](../plans/2026-07-24-jarvis-d-attribution.md) | Built — inferred dossier↔Run edges (layers 2–3: ticket-match + structural) w/ provenance+confidence, rebuildable edge store + committed override log (detach/accept), probation-gated harden-to-`refs` via B, self-correction/time-box, unified `EdgesFor` read for C (`pkg/jarvisattrib`); adds `gitinfo.RangeLog`. No model, no RPC; layer 4 is v2 |
| E | Continuity | [spec](2026-07-24-jarvis-e-continuity-design.md) | [plan](../plans/2026-07-24-jarvis-e-continuity.md) | Built — rest-boundary narrative writer (`pkg/jarviscontinuity`): on a Run entering a rest state (awaiting-review / blocked / done) it assembles deterministic facts + runs one capable-model summary, writing the dossier `state` block + status off-band from `AdvanceRunCommand` (mirror of C's dispatch capture); terse no-model path for empty tasks, conflict-aware back-off (invariant 5); pure-read `Resume` seam exposed, unwired in v1 (recall serves the narrative). No new WaveObj/RPC/migration/`task generate` |
| F | Jarvis conversation backend | [spec](2026-07-23-jarvis-f-conversation-backend-design.md) | [plan](../plans/2026-07-23-jarvis-f-conversation-backend.md) | Built (merged) — persisted `JarvisConvo` WaveObj (SQLite, WOS-mirrored) + multi-turn `JarvisConverseCommand` + attached-scope retrieval, behind the G⇄F contract (still on the Plan-2 recall shim until C lands) |
| G | Jarvis UI surface | [spec](2026-07-23-jarvis-ui-surface-design.md) | [P1](../plans/2026-07-23-jarvis-g-surface-shell-and-contract.md) · [P2](../plans/2026-07-23-jarvis-g-recall-backend-shim.md) · [P3](../plans/2026-07-23-jarvis-g-fleet-migration.md) · [P4](../plans/2026-07-23-jarvis-g-palette-contextual-ambient.md) | Built (merged) — Plans 1–4 of 4 (shell + recall shim + fleet migration + palette/contextual/ambient) |

## Non-goals

Per the briefs (not restated): no embedding or executing Obsidian/its plugins; no Dataview/Canvas/theme compatibility; no replacing an external tracker; no auto-projecting task history into every coding agent; no copying full transcripts or Run evidence into Markdown; no cloud sync or collaborative editing; not a general-purpose knowledge-management product; no light mode.
