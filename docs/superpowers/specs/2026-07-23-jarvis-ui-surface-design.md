# Jarvis second brain — G: UI surface design

**Date:** 2026-07-23
**Status:** Design complete; pending spec review, then implementation planning.
**Type:** Sub-project spec (sub-project **G** of the v1 meta spec). One `spec → plan → implementation` cycle.

**Builds on (read first):**
- [Jarvis second brain — v1 meta spec](2026-07-23-jarvis-second-brain-meta-spec.md) — decomposition, invariants, seams, build order.
- [Jarvis second brain — design](2026-07-22-jarvis-second-brain-design.md) — recall/attribution/write-ownership/presence + cost model.
- [Jarvis second brain — UI design brief](../briefs/2026-07-23-jarvis-second-brain-ui-design-brief.md) — product/interaction design, realized as `Wave-jarvis-second-brain.dc.html` in the `wave` Claude Design project (the **visual source of truth** for the 12 states; this spec is its engineering realization, not a redraw).

This spec does not restate the meta spec's invariants or the design's decisions. It records the decisions that were left to G, the engineering architecture, and the scope of this cycle.

## Scope decision (why this cycle is larger than the meta spec's "G on fixtures")

The meta spec's recommended sequence made G a fixtures-only, contract-pinning UI cycle with F (and its SQLite shim) following. During brainstorming the scope was deliberately expanded on five decisions:

1. **Unification: full behavioral rewire now.** Today's `Jarvis` is the Channels-bound fleet manager. v1 reuses the name for a superset. Decision: the fleet manager is **fully migrated** into the new Jarvis surface this cycle, not left in Channels.
2. **Recall backing: real shim over existing SQLite.** The recall/conversation facet is backed by a **real shim** over existing Wave objects (runs, decisions, memory, radar) — F's planned first backing (meta spec line 119), pulled forward — not fixtures.
3. **Ambient attribution: included in G, from fixtures.** Presence-D's ambient tags and inline "relevant past decision" cards ship on other surfaces this cycle, driven by a fixture provider (the real attribution engine D does not exist).
4. **Fleet homing: exclusively in Jarvis.** The in-Channels fleet controls (overview strip, autonomy toggle, profile drawer) are removed; a channel's fleet is managed only from the Jarvis surface.
5. **Composer model-picker: dropped** (meta spec design delta; contradicts invariant 2).

**The one immovable constraint.** "Full behavioral rewire / real" is deliverable for the **fleet facet** (it already has a live backend: `JarvisCommand`, `GetJarvisProfileCommand`, `SetChannelTierCommand`). The **second-brain recall facet** cannot be fully real: the vault is sub-project A, recall is C, attribution edges are D, continuity narrative is E — none exist. So recall is backed by a shim over existing SQLite (no vault, no wikilink traversal, no learning store), and ambient attribution is fixtures. `weak` / `notfound` / `stale` are real terminals the shim can produce and are also fixture-covered.

**Consequence.** This cycle collapses **G + F's shim + the fleet migration** into one large sub-project. It is deliverable and genuinely demoable end-to-end (fleet + basic recall), but it is not a small slice; §9 gives the internal decomposition the implementation plan will order.

## In / out of scope

**In:**
- A first-class `jarvis` cockpit surface under a new namespace `frontend/app/view/jarvis/`, three-region composition, all 12 required states.
- The **conversation view-model contract** (the G ⇄ F seam), defined here and implemented by the shim + fleet backend.
- **Recall/conversation backend shim** — a wshrpc command that answers over existing SQLite objects with grounding and streamed working-steps.
- **Fleet manager migration** into the surface (real, via existing RPCs), removed from Channels, `@jarvis` rerouted.
- **Ctrl+P "Ask Jarvis" lead group** + continuous handoff into the surface.
- **Contextual-entry actions** on Run / Radar / Memory.
- **Ambient attribution** on Run / Radar / Memory rows, from fixtures.

**Out (deferred per the v1/v2 boundary or to other sub-projects):**
- The vault and write path (A/B), real recall/traversal engine (C), real attribution edges (D), pre-computed continuity narrative (E).
- Embedding/semantic recall (layer 3) and everything else v2.
- The Tasks dossier-editor surface and the Graph surface (separate design efforts).
- Composer model-picker; light/Paper mode; any second command palette or new global shortcut.

## The seam — conversation view-model contract

The single most important artifact of this cycle (meta spec line 104). G renders it for every state; F implements it; the shim and fleet backend are its first two implementations. Go structs are the source of truth (regenerated via `task generate`); the TS shape below is illustrative.

```
JarvisConversation { id; title; turns: JarvisTurn[]; scope: JarvisScope }

JarvisTurn =
  | { role: "user";   text; attachments: SourceRef[] }
  | { role: "jarvis";
      workingSteps: WorkingStep[];      // streamed: "done" | "active" | "pending"
      segments:     AnswerSegment[];    // prose interleaved with [n] citation refs
      grounding:    GroundingCard[];
      terminal:     "answered" | "weak" | "notfound" }

WorkingStep   { id; label; status }
AnswerSegment = { text } | { citationRef: number }
GroundingCard { n; sourceType; title; project; age;
                freshness: "fresh" | "stale" | "unavailable";
                navTarget /* oref → native surface */; expanded? }
JarvisScope   { mode: "object" | "project" | "all" | "attached"; chips: ScopeChip[]; attached: SourceRef[] }
SourceRef     { oref; sourceType; title }

sourceType ∈ { memory, decision, run, channel, radar, commit, agent, session, task }
```

- **Quick-ask (palette)** consumes a reduced view (question, streaming segments, compact grounding, terminal) plus a **handoff payload** `{ question, jarvis turn, grounding, scope }` that seeds a full `JarvisConversation` with no context break.
- **Freshness is per-grounding-card.** Stale and unavailable are card states, resolved at synthesis time from the authoritative object (invariant 7), not hidden.
- **`weak` and `notfound` are rewarded terminals** (invariant 7). No confabulation to fill a gap.
- Every one of the 12 states (§7) is a value of this contract — that is how G validates the seam before F is real.

## Surface architecture

- **Three regions**, modeled on `ChannelsSurface` (`frontend/app/view/agents/channelssurface.tsx`), the closest existing multi-region surface: left **conversation-history rail** · center **conversation** (visual center of gravity) · right **grounding rail**.
- **Grounding rail** uses the `CollapsibleRail` primitive (`frontend/app/element/collapsiblerail.tsx`, 300/44px). Narrow-window collapse follows the `railstore.ts` pattern — a persisted `openAtom` defaulting collapsed — not a container query.
- **Two modes inside the one surface:**
  - **Recall/Ask** (default) — the second-brain conversation, all 12 states.
  - **Fleet** — the migrated manager (worker roster, autonomy tiers, profile, fleet summary).
  - Distinct because fleet management is not a linear conversation. **Bridge:** a `@jarvis(:report)` summary and gatekeeper escalations also surface as conversation turns in Recall mode, so "ask about the fleet" stays unified.
- **State store** `frontend/app/view/jarvis/jarvisstore.ts` — module atoms for conversations, active conversation id, scope, mode, rail-open, and the quick-ask handoff payload. Required because **the Jarvis surface unmounts on nav-switch** (only the agent surface stays mounted, hidden via CSS); survive-worthy state must live in module atoms, never `useState`.
- **Scaffolding** reuses `frontend/app/view/agents/surfacescaffold.tsx` (`SurfaceHeader` / `SurfaceEmptyState` / `SurfaceError`).

### Nav integration

Adding the destination touches four places (per the code map):
- `SurfaceKey` union — `frontend/app/view/agents/agents.tsx` (~line 29).
- `SURFACE_ORDER` (same file) — for the `Ctrl+N` shortcut.
- `ICON` record + `ITEMS` array — `frontend/app/view/agents/navrail.tsx` (~lines 25, 37).
- The render switch — `frontend/app/view/agents/cockpitshell.tsx` (~lines 87–121).

**Placement decision:** insert `jarvis` **second, immediately after `cockpit`** — Jarvis is the primary experience (UI brief). This **renumbers `Ctrl+2..8`** (a one-time muscle-memory cost), accepted for prominence. (Rejected alternative: append at the end — no renumber, but buries the primary surface.)

## Backend — shim recall + conversation command

- A new **responsestream** wshrpc command (working name `JarvisConverseCommand`) in `pkg/wshrpc` (Go source of truth → `task generate`). Consumed on the FE with the established `for await (const chunk of gen)` accumulate-into-atom pattern (see `usefleetsummary.ts`). Uses a generous timeout like `JarvisCommand` (~130s), not the 5s default.
- **Pipeline:** resolve scope (`object` / `project` / `all` / `attached` → an SQLite filter) → deterministic retrieve a bounded slice from existing objects (runs, decisions, memory, radar) → one model synthesis producing grounded segments, citations, and a terminal. The streamed working-steps are the retrieval/synthesis steps.
- **Model path:** reuse the headless-`claude -p` pattern the fleet manager already uses (`JarvisCommand`), **not** `aiusechat` (slated for removal ~Phase 6). Tiering per invariant 2 (cheap model drives retrieval/nav, capable model synthesizes) — internal, no user picker.
- **Scope enforcement in code, not prompt** (invariant 4, C's contract): the retriever is scoped by the query it is handed, not by asking the model to ignore objects.
- **Freshness** resolved at synthesis from the live object (e.g. Run status); `stale`/`unavailable` derived from object version/existence.
- **Shim limits (explicit):** no vault, no `[[wikilink]]` traversal, no learning-store materialization, no attribution edges. These are C/D/A/B and are replaced behind the same contract in later cycles.

## Fleet migration + `@jarvis` rerouting

The riskiest slice — it changes shipping Channels behavior. It gets its own plan step, guarded by the migrated unit tests.

- **Relocate** into `frontend/app/view/jarvis/`: `jarvisderive.ts`, `jarviscards.ts`, `usefleetsummary.ts`, `profilepanel.tsx`, `profilemodel.ts`, and their tests (`jarvisderive.test.ts`, `jarviscards.test.ts`). Update all importers.
- **Remove** the fleet controls from Channels: the Jarvis block in `OverviewStrip` (`channelchrome.tsx`), the autonomy toggle and profile drawer (`channelssurface.tsx`), the context-panel wiring that assumes them. These now live in Jarvis **Fleet mode**.
- **Reroute `@jarvis`**: the mention parsed in `channelmessages.ts` navigates to the Jarvis surface / Fleet mode instead of acting purely in the channel overview strip. The `channelderive.ts` address-book handle stays but points at the surface.
- Existing backend RPCs (`JarvisCommand`, `GetJarvisProfileCommand`, `SetChannelTierCommand`) are reused unchanged from the new location.

## Palette lead group · contextual entries · ambient (fixtures)

- **Ctrl+P:** add an `"ask-jarvis"` value to `PaletteKind` and a builder mirroring `palette-launch.ts`, injected as a lead group in the default-scope branch of `command-palette.tsx` (reusing the accent-railed lead-block renderer). Its `run()` seeds the handoff payload and opens the surface. Compact cited-answer and weak/not-found states render inline in the palette.
- **Contextual entries:** small local actions on Run / Radar / Memory (`Ask Jarvis about this Run`, `Explain this Radar finding`, `Recall related decisions`) that open Jarvis with the object attached as a `SourceRef`. Entry points into the one assistant — not inline chat panels (UI brief non-goal).
- **Ambient (fixtures):** task tags on Run/Radar/Memory rows + inline "relevant past decision" cards, behind a provider interface the real attribution engine D will later implement. Explicitly a mock this cycle; the provider seam is the durable part.

## The 12 states — real vs fixtures

All 12 are values of the §2 contract, so all are CDP-verifiable.

| # | State | Backing |
|---|---|---|
| 1 | Surface — first use / no conversations | real |
| 2 | Active multi-turn conversation | real (shim) |
| 3 | Grounded answer, mixed sources, one expanded | real (shim) |
| 4 | Working — retrieval/tool activity while streaming | real (shim) |
| 5 | Weak grounding | real terminal + fixture |
| 6 | Not found | real terminal + fixture |
| 7 | Source unavailable / stale | real freshness + fixture |
| 8 | Quick ask — composing | real |
| 9 | Quick ask — compact cited answer | real (shim) |
| 10 | Quick ask — continued into full surface | real (handoff) |
| 11 | Contextual invocation from Run / Radar | real (attach) |
| 12 | Narrow-window, supporting regions collapsed | real |

Ambient attribution (not one of the 12 UI-brief states; added by decision 3) is fixtures throughout.

## Testing

- **Vitest units** for pure logic: view-model builders, scope→filter resolution, `[n]` citation interleaving, freshness derivation, and the migrated `jarvisderive` / `jarviscards` tests (move with the code). The 12 fixture view-models are asserted against the contract.
- **Go tests** (`go test ./pkg/...`) for the shim: scope filtering, grounding assembly, terminal selection.
- **CDP surface-smoke** (`task verify:ui` scenarios): render each of the 12 states from fixtures, screenshot, assert; contact sheet to `cdp-shots/index.html`.
- No jsdom render tests (standing decision); risky wiring is extracted into the model and unit-tested, "does it render" is CDP.

## Internal decomposition (the implementation plan will order these)

1. Namespace + nav + empty surface shell (renders; nav works; unmount-safe store). **(done — Plan 1)**
2. View-model contract + fixtures + all 12 states rendered (CDP-verified). ← pins the seam. **(done — Plan 1)**
3. Backend shim `JarvisConverseCommand` (Go) + wire Recall mode to it (real recall over SQLite). **(done — Plan 2)**
4. Fleet migration + Channels removal + `@jarvis` reroute (guarded by migrated tests). **(done — Plan 3)** — split relocation (only the fleet-UI cluster `profilepanel`/`principleseditor`/`profilemodel`/`usefleetsummary` moved to `view/jarvis/`; shared domain `jarvisderive`/`jarviscards` stayed in `view/agents/`); the ⚙ profile drawer moved into Fleet mode; the `@jarvis` *summary* hands off to Fleet mode while delegator-tier *dispatch* stays in-channel. Note: the reroute's live *trigger* (a `@jarvis` composer entry) has no wiring yet — it arrives with step 5 (Plan 4), so the handoff's end-to-end path is exercised then; step 4 verifies the decision (dispatch vs summary, via `channelmessages.test.ts`) and the Fleet-side landing (CDP `jarvis-fleet`).
5. Ctrl+P `"ask-jarvis"` lead group + handoff.
6. Contextual entries + ambient fixtures on Run / Radar / Memory.

Steps 1–2 are the contract-pinning core; 3 makes recall real; 4 is the risky migration; 5–6 are the entry points. Steps 3 and 4 are independent and can proceed in parallel once 2 lands.

## Design constraints inherited (quick reference — full text in meta spec invariant 9)

Dark mode only; preserve the 46px app bar and 78px nav rail; colors are `@theme` tokens in `tailwindsetup.css` (the mockup accent `#7c95ff` already matches `--color-accent`) — never raw hex; use existing cockpit fonts (not the mockup's Hanken Grotesk / JetBrains Mono imports); restrained motion; Jarvis must feel native to the cockpit, not an embedded third-party chat app.

## Open items carried to the plan

- Exact region proportions and per-state visual treatments are taken from `Wave-jarvis-second-brain.dc.html` at implementation time.
- The precise Go struct names / wshrpc command signature are finalized in step 3 (must round-trip through `task generate`).
- Whether the `@jarvis(:report)` conversation-turn bridge reuses the recall view-model verbatim or a fleet-specific variant is settled when steps 3 and 4 meet.
