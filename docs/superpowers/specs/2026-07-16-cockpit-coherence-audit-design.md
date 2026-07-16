# Cockpit Coherence Audit — Design

**Date:** 2026-07-16
**Status:** Approved (design) — ready for implementation plan
**Topic:** Cross-surface coherence — inventory every consistency divergence across the cockpit surfaces into one prioritized map

## Problem

The cockpit's top-level surfaces (`frontend/app/view/agents/*surface.tsx`) were built by different
specs over time. The 2026-07-14 chrome scaffold
(`docs/superpowers/specs/2026-07-14-cross-surface-consistency-scaffold-design.md`) unified how
surfaces *look* — header, empty/error/loading chrome, container, text scale — and migrated 7 fully +
3 partially. It explicitly deferred three coherence follow-ups: **interaction/keyboard parity**,
**full `ink-*` deprecation**, and a **navigation/IA rethink**.

Those follow-ups were named but never measured. We do not have a single source of truth for *where*
the surfaces still diverge or *which* divergence hurts daily use most. Concretely, we already know:

- The cockpit has a rich keyboard model (`usecockpitkeyboard.ts`: `j/k` nav, `[`/`]` surface switch,
  `n` next-ask, `Enter`, `r`, `t`, `b`, `1-9`, `?`) that its own comment marks *"cockpit-local —
  handled here, not by the global keybinding registry."* Channels, Sessions, Memory, Radar each roll
  their own keydown handling or none — so keyboard fluency evaporates on surface switch.
- The chrome scaffold migrated only 7 of ~10 surfaces fully; `ink-*` residue and bespoke chrome
  remain in the child-component subtrees the scaffold explicitly did not touch.
- Motion, and whether surfaces reuse shared row/badge primitives or reimplement them, were never
  inventoried at all.

Before spending effort fixing any one dimension, we need the map. This audit produces it.

## Goals

- One document that scores every navigable surface against a defined canon on five coherence
  dimensions, so "what's inconsistent" is answered with evidence, not impression.
- A findings backlog ranked by daily-use impact vs effort, so the *next* fix pass is chosen from data.
- Ground the canon in what already exists as the reference implementation (chrome scaffold for
  chrome/state; cockpit keyboard model for interaction) rather than inventing new standards.

## Non-goals (out of scope)

- **No fixes.** This audit only measures and prioritizes. Each chosen fix gets its own spec/plan.
- **No canon invention beyond what exists.** Where a shared primitive already exists, adoption of it
  is the canon. Where no canon exists (a genuine gap), the audit *records the gap* and defers the
  "what should canon be" decision to the fix pass — it does not decide it here.
- **No navigation / IA rethink.** Surface grouping and the cockpit/agent/sessions overlap stay out
  (higher-risk, separate project), consistent with the chrome scaffold's boundary.

## Approach (locked: A — matrix-driven conformance)

Define the canonical target per dimension, score every surface against it in a surface × dimension
grid, and turn each divergence into a prioritized finding. Top-down so the map has a spine and yields
a directly actionable "fix this first" ordering. (Rejected: divergence-first cataloguing — weaker
prioritization; dimension deep-dives — four artifacts instead of one map, heavier than the decision
needs.)

## Surface set

The navigable surfaces from the `cockpitshell.tsx` router:

`cockpit`, `agent` (focus/TUI), `channels`, `sessions`, `files`, `memory`, `usage`, `radar`,
`settings`, `placeholder`. `review` / `runcompletion` are scored where a dimension applies.

Structurally-different surfaces (agent full-bleed TUI, files 2-pane, channels 2-pane) are scored only
on the dimensions/pieces that *apply* — the same accommodation the chrome scaffold made. A cell that
does not apply is scored **N/A**, not **Diverges**.

## Dimensions & canon

Each dimension is scored against a named reference. "Canon" = the existing shared thing; conformance =
adoption of it.

1. **Interaction / keyboard.** Canon = the cockpit model in `usecockpitkeyboard.ts`: cursor nav
   (`j/k` + arrows), surface switch (`[`/`]`), open/submit (`Enter`), dismiss (`Esc`), which-key help
   (`?`), and a typing-guard (ignore keys while an INPUT/TEXTAREA/contentEditable is focused). Record
   per surface: which of these it honors, its selection model, its action letters, and its *mechanism*
   (local hook vs global `keymodel.ts` registry vs none). The audit maps mechanism; it does not decide
   whether the shared contract should ultimately live in the registry or a shared hook — that is the
   fix pass's call.
2. **Chrome / layout tokens.** Canon = the scaffold (`SurfaceHeader`, `SURFACE_ROOT`,
   `primary/secondary/muted` text scale, `text-[25px] font-bold` title, `px-[28px]` rhythm). Score
   header, root container, spacing, text scale, type sizes. Additionally count `ink-hi/ink-mid/ink-faint`
   occurrences in each surface's component subtree (the deferred `ink-*` residue).
3. **State coverage.** Canon = `Skeleton` + a `*LoadedAtom` gate (loading), `SurfaceEmptyState`
   (empty), `SurfaceError` (error). Score each state *only where it applies* — a surface with no async
   load is N/A for loading/error. Flag silent-failure patterns (`.catch(() => {})`, empty render on
   error).
4. **Motion.** Canon = shared `motiontokens.ts` (`cardVariants` et al.). Score whether entrance and
   list-reorder motion use the shared tokens vs bespoke `motion` config vs none-where-expected.
5. **Primitive reuse.** The single-source-of-truth lens. Score by *degree* of reuse
   (`Conforms` = shares the existing primitives; `Partial`/`Diverges` = reimplements some/most),
   and enumerate each concrete duplication instance in the backlog — a surface reimplementing a
   list row / badge / status dot / section header instead of sharing an existing primitive
   (`SectionHeader`, `statusdot.tsx`, `agentrow`, etc.).

## Scoring rubric

**Conformance (per applicable cell):** `Conforms` / `Partial` / `Diverges` / `N/A`.

**Severity (daily-use impact):**
- **High** — breaks the keyboard-first or calm-glance promise, or a visible inconsistency the user
  hits on every session.
- **Med** — noticeable but worked around.
- **Low** — cosmetic or rare.

**Effort:** `S` (FE-only, localized) / `M` (FE + shared-primitive change or cross-surface wiring) /
`L` (new behavior or structural change).

**Priority** = severity weighed against effort; quick high-value first (the same S/M/L convention the
channels-improvements backlog used).

## Output format

One document: `docs/agents/cockpit-coherence-audit.md` (findings/backlog docs live under `docs/agents/`,
alongside `channels-improvements.md` and `runs-pipeline-known-issues.md`).

Structure:
1. **Canon per dimension** — the reference each column is scored against (short; links to the code).
2. **Conformance grid** — surfaces (rows) × 5 dimensions (columns); each cell `Conforms/Partial/Diverges/N/A`
   with a one-line note.
3. **Findings backlog** — one entry per divergence: `surface · dimension · severity · effort ·
   evidence (file:line) · proposed canonical fix`. Sorted by priority.
4. **Recommended sequencing** — the "fix this first" ordering, grouped into a small number of coherent
   fix passes (a divergence and its fix rarely stand alone).

Every finding cites concrete evidence (`file:line`); no impressionistic claims.

## Execution plan

The audit reads ~200 files across 9–10 surfaces × 5 dimensions — a natural fan-out. Sweep per surface
(each pass returns that surface's five-dimension scorecard + findings with evidence), then synthesize
the per-surface scorecards into the grid, backlog, and sequencing. The canon definitions are fixed
before the sweep so scoring is consistent across surfaces. No code is modified; this is read-only
analysis producing one markdown artifact.

## Verification

- Every grid cell and finding cites a real `file:line`; spot-check a sample against the source.
- `Diverges`/`Partial` cells each produce at least one backlog finding (no orphan scores).
- The recommended sequencing covers every High-severity finding.
- Because the deliverable is a document, "verification" is provenance and internal consistency, not a
  build gate — `tsc`/`vitest` are untouched (no code changes).

## Follow-ups (deferred, tracked)

- The chosen fix pass(es) from the backlog — each its own spec → plan → implementation.
- The interaction-contract home decision (global `keymodel.ts` registry vs shared hook), resolved by
  the keyboard fix pass if the audit ranks it high.
