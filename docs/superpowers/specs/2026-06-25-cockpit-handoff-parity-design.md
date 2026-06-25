# Cockpit handoff-parity — design

**Date:** 2026-06-25
**Status:** design (awaiting review)
**Source of truth:** `wave-handoff/wave/project/Wave-cockpit-live.dc.html` (the Cockpit surface, lines 34–353)
**Companion spec:** `2026-06-25-cockpit-testdata-injection-design.md` (the mock roster used to eyeball this work)

## Problem

Phase 1a is functionally complete but visually diverges from the handoff. The cause is three
partial-migration gaps, not card-logic bugs:

1. **Fonts never register in the Tauri boot path.** `loadFonts()` runs only in `preview.tsx`;
   `frontend/tauri/main.tsx` never calls it. Hanken Grotesk + JetBrains Mono are bundled
   (`public/fonts/hanken-grotesk-variable.woff2`, `…jetbrains-mono…`) and themed
   (`tailwindsetup.css` `--font-sans`/`--font-mono`), but the cockpit renders in the system-ui
   fallback. This is the single biggest cause of the mismatch. (Same class of miss as the
   Tailwind-not-wired gotcha fixed in `a058f8af`.)
2. **The polished app-bar chrome was never ported.** The bare `CockpitTitlebar` (`Wave` +
   min/max/close) plus a plain `+ New Agent` strip stand in for the handoff's 46px bar.
3. **1a deliberately deferred the visually-prominent items** — NavRail glyphs, the `LIVE AGENTS`
   section header, the right-rail recent-activity peek, full usage bars, and card-level
   reply chips / widen / resize. The user wants these pulled forward to handoff parity.

The palette tokens already match the handoff hex exactly, so this is a fidelity port, not a
re-theme.

## Goals

Bring the **Cockpit surface** (and the shell chrome around it) to handoff parity:

- Wire fonts into boot.
- Replace the titlebar with the handoff top app bar.
- Add NavRail icons, the cockpit-header project/live filters, section headers, and the
  right-rail recent-activity peek + full usage bars.
- Bring cards to full parity: always-on composer, reply-suggestion chips, per-card widen +
  resize, working/asking banner.

## Non-goals

- Command palette behavior (the ⌘K box is a render-only stub — see `docs/deferred.md`).
- The Agent 3-pane focus surface (Phase 1b).
- A formal multi-project entity or persisted project switching — projects are derived from
  transcript paths (`projectname.ts`); filtering is in-memory only.
- Test-data injection (companion spec).

## Architecture

Files touched, by area:

| Area | File | Change |
|---|---|---|
| Fonts | `frontend/tauri/main.tsx` | call `loadFonts()` during boot |
| App bar | `frontend/app/cockpit/cockpit-root.tsx`, new `app-bar.tsx`, `titlebar.tsx`, `cockpit.scss` | new `<CockpitAppBar>` replaces titlebar + `+New Agent` strip; titlebar styles → Tailwind |
| Nav | `frontend/app/view/agents/navrail.tsx` | add 8 SVG glyphs |
| Header | `frontend/app/view/agents/cockpitsurface.tsx` | projects count, `All projects ▾`, `Live only` |
| Sections | `cockpitsurface.tsx` | `LIVE AGENTS` header; match `IDLE` header |
| Right rail | `cockpitsurface.tsx`, new rail subcomponents | recent-activity peek + full usage bars |
| Cards | `frontend/app/view/agents/agentrow.tsx` | always-on composer, reply chips, widen, resize, banner |
| Model | `frontend/app/view/agents/agents.tsx` | new atoms: `projectFilterAtom`, `liveOnlyAtom`, `cardPrefsAtom` |
| Derived | new `recentactivity.ts` (or fold into `liveagents.ts`) | recent-activity list atom |

### State (new model atoms on `AgentsViewModel`)

- `projectFilterAtom: "all" | <projectName>` — single source of truth for project scope. Bound
  to **both** the app-bar project switcher and the header `All projects ▾` button (both
  read/write it). Filters the grid by `projectNameFromTranscriptPath`.
- `liveOnlyAtom: boolean` — when true, hide idle agents (header `Live only` toggle).
- `cardPrefsAtom: Record<id, { wide?: boolean; height?: number }>` — per-card widen (1-col ↔
  2-col span) and dragged height. Ephemeral (not persisted) for this pass.

### Data flow (unchanged spine)

`agentsAtom` → `groupAgents` → grid. The new filters compose on top of the existing
`shownAgents` derivation in `cockpitsurface.tsx`: `shownAgents = order → project filter →
live-only filter → chip filter`. Recent activity derives from the newest narration entry per
agent (`liveEntriesByIdAtom` / `lastActivityByIdAtom`, falling back to `previousInfo`).

## Detailed design

### 1. Fonts
Import and call `loadFonts()` in `main.tsx` boot (before or after render — fonts swap in on
load). One line + import. Verifies via: the cockpit renders in Hanken Grotesk.

### 2. Top app bar — `<CockpitAppBar>`
New component, 46px, `bg-surface` (`#0e1116`), bottom border `border-border`. Replaces both
`CockpitTitlebar` and the `+ New Agent` strip currently in `CockpitRoot`.

Layout (left → right):
- **Logo mark** — gradient rounded square with a centered dot (handoff lines 41–43) + `Wave`.
- **Project switcher** — `/ {currentProject} ▾`; dropdown lists distinct projects (derived
  from agents) with a dot, name, asking-count, and agent-count; selecting sets
  `projectFilterAtom`; an `All projects` entry resets to `"all"`.
- **⌘K search stub** — centered, `width:min(520px,42%)`, magnifier glyph + placeholder
  `Search agents, sessions, commands…` + `⌘K` badge. **No-op onClick** (deferred; see
  `docs/deferred.md`).
- **Usage donut** — small conic-gradient ring + `NN% / 5h limit`, fed from the existing
  per-provider usage (use the highest 5h pct, or Claude's). Click → `surfaceAtom="usage"`.
- **`+ New agent`** — accent button; calls `newAgentSession(model)` (moved off the old strip).
- **Window controls** — min / max / close at far right via the Tauri window plugin (moved from
  `titlebar.tsx`).

**Decision — Windows adaptation:** the handoff shows decorative mac traffic-lights on the left
and no explicit window controls. This is Windows borderless, so we keep functional min/max/close
on the **right** (Windows convention) and drop the mac dots. Same bar look, platform-correct.
`data-tauri-drag-region` stays on the non-interactive bar background.

`titlebar.tsx` is removed (its window-control logic moves into the app bar); the `.cockpit-titlebar*`
SCSS in `cockpit.scss` is deleted (no new SCSS — Tailwind only, per project rule).

### 3. NavRail glyphs
Add the 8 handoff SVGs (Cockpit 4-squares, Agent target, Activity list, Channels chat-bubble,
Sessions layers, Files folder, Memory graph-nodes, Usage gauge-arc — handoff lines 86–125) above
each existing label. Keep the current active-state treatment (accent left-bar + `bg-accent/10`).
Icons inherit `currentColor`.

### 4. Cockpit header
Extend the existing header in `cockpitsurface.tsx`:
- Subtitle gains `· {N} projects` (distinct project count).
- Add `All projects ▾` button (bound to `projectFilterAtom`) and `Live only` toggle (green dot,
  bound to `liveOnlyAtom`) beside the existing `Hide panel` button.

### 5. Section headers
Add the `LIVE AGENTS` header above the grid (handoff lines 156–163): pulsing accent dot
(`@keyframes pulseDot`, already in `tailwindsetup.css`), `LIVE AGENTS` label, count pill,
gradient divider line, and `{asking} need you · {working} working` on the right. Match the
existing `IDLE` header styling to the handoff (lines 247–252). These render only when their
section is non-empty.

### 6. Right rail
Two blocks in the existing `aside`:
- **Usage** — full-width bars per provider: a `5-hour window` bar and a `Weekly` bar with
  percentage, token counts (`1.34M / 2.2M tok`), and reset countdown (handoff lines 322–333).
  Keeps the per-provider truth from `providerPlanUsage` but renders as the handoff's full bars
  instead of compact mini-gauges.
- **Recent activity** — peek list of the newest activity across agents (handoff lines 335–351):
  per entry a colored dot, `{agent} {text}`, and `{typeLabel} · {time} ago`. `View all →` sets
  `surfaceAtom="activity"`. Derived from a new `recentActivityAtom`.

### 7. Cards — full parity (`agentrow.tsx`)
- **Always-on composer** — the composer renders at the card bottom for every active card, not
  only the cursor row (replaces the `isCursor` reveal). Keeps `onComposerEscape`.
- **Reply-suggestion chips** — amber chips above the composer for asking agents (handoff lines
  224–230), rendered from a `replySuggestions: string[]` field on the ask. Clicking a chip
  fills the composer. (Structured option asks still use `AnswerBar`; suggestions are the
  free-form quick-replies.) The field is optional; the test-data scenarios populate it.
- **Working/asking banner** — the `Waiting on you` amber banner (asking) and the green activity
  line (working) inside the card head (handoff lines 179–190).
- **Widen toggle** — a head button toggling `cardPrefsAtom[id].wide`; wide cards span both grid
  columns (`grid-column: 1 / -1`).
- **Resize handle** — a bottom `ns-resize` strip dragging `cardPrefsAtom[id].height`; applied as
  the card's height (handoff lines 237–239).

## Decisions

- **D1 — App bar Windows adaptation.** Functional min/max/close on the right; drop mac dots.
- **D2 — ⌘K render-only stub.** Looks right, does nothing; tracked in `docs/deferred.md`.
- **D3 — Project filter single source.** One `projectFilterAtom`, surfaced in both the app-bar
  switcher and the header button; derived from transcript paths, in-memory only.
- **D4 — Usage: per-provider truth, handoff bar styling.** Keep multiple providers, render full
  bars.
- **D5 — Card prefs ephemeral.** Widen/height live in a model atom, not persisted this pass.
- **D6 — No SCSS.** All new/replaced styling is Tailwind; delete dead `.cockpit-titlebar*` SCSS.

## Testing

Per the 1a convention (no jsdom): node-env pure-logic tests for the new derivations only —
project-list/count from agents, project + live-only filter composition, recent-activity
ordering, and `cardPrefs` span/height mapping. Component rendering is **not** unit-tested.

Static gates: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (3 baseline
errors), `npx vitest`, and `npx vite build --config frontend/tauri/vite.config.ts` (proves the
import graph stays acyclic). **Note:** the Vite-config change for fonts (if any) and the
Tailwind plugin require restarting `task dev`.

Visual verification is by running `task dev` with a mock scenario loaded (companion spec). CDP
is not automatable on the Tauri webview.

## Open questions for planning

- Exact source for the app-bar usage donut (single highest 5h pct vs. Claude-only).
- Whether `recentActivityAtom` lives in `liveagents.ts` or a new `recentactivity.ts`.
