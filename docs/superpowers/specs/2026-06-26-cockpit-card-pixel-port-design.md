# Cockpit card — full pixel-port to handoff

**Date:** 2026-06-26
**Status:** design (awaiting review)
**Source of truth:** `wave-handoff/wave/project/Wave-cockpit-live.dc.html` — the Live-agents card, lines **165–276** (container 167, header bar 169–179, asking band 181–190, task popover 191–209, feed 211–247, composer 249–270, resize 272–274). Keyframes at lines 22–27.
**Supersedes:** the always-on-composer and split-control decisions in `2026-06-25-cockpit-handoff-parity-design.md` §7 (D-list). That pass brought the *chrome* to parity; this pass brings the *card body* to parity and reverts the live-only adaptations the user has chosen to drop.

## Problem

The Cockpit live-agent card (`frontend/app/view/agents/agentrow.tsx`) is functionally complete but structurally diverges from the handoff. The handoff card is a stack of self-padded **horizontal bands** separated by dividers (header bar → asking band → scrolling feed → composer band → resize strip). The current card is one `px-4 py-3` padded column with everything left-indented (`ml-[26px]`) and stacked with `mt-2`. That layout difference — not any single color — is the dominant mismatch. Secondary gaps: sans (not mono) name, outlined (not filled) `needs you` badge, hover-gated mixed-shape controls (vs. always-on uniform boxes), no in-card question text, an always-on composer (handoff collapses by default), and missing diff/task-list affordances.

The palette tokens already match the handoff hex, so this is a fidelity port, not a re-theme.

## Goals

Bring the live card to handoff parity (lines 165–276):

- Banded flex-column layout with self-padded zones and dividers; header becomes a distinct bar with its own background.
- Mono name (fixed size), filled-amber `needs you` badge, always-on uniform `widen / >_ / ⤓` control boxes, `∷∷` always-visible drag glyph, pulsing status dot.
- In-card asking band with the question text in a warm-cream treatment; working activity line at the feed head.
- Feed restyled to the handoff lane look (avatar narration, right-aligned user bubbles, tool lines) **while keeping the burst-collapse** behavior.
- Composer collapses by default (click / `R` to expand, Esc to collapse); reply-suggestion chips in the expanded state.
- Diff button (`+adds −dels`) and task-list chip + popover, rendered from **deterministic placeholder data** (no live source yet), with the real wiring recorded in `docs/deferred.md`.

## Non-goals

- The purple **"Ready for review"** section (handoff lines 280–350) — a separate git-review block, not "the card."
- The **Idle row / `Wave-answer`** treatment (handoff lines 360–376) — separate; `IdleSection` owns it. Recently-idle agents that currently render as grid cards simply inherit the new card chrome in their idle state.
- The Agent 3-pane focus surface and its `focustranscript` renderer — untouched.
- Persisting card prefs / drag stats; wiring real git or TodoWrite data (deferred).

## Handoff card anatomy (the target)

Container (167): `flex flex-col`, `rounded-[13px]`, `overflow-hidden`, state-driven `laneBg`/`laneBorder`, `gridColumn`/`height` from prefs, drag opacity, `paneShadow`. Then, in order:

1. **Header bar** (169–179): own `leftBg` background, `border-b` divider, `padding:6px 12px`, `draggable`. `∷∷` glyph (`#454c55`, mono, `cursor-grab`) · 8px status dot (`pulseDot 1.6s`) · mono name (`600 13.5px`, `#e6ebf1`, ellipsis) · project pill (`#181d23`/`#252b33`) · diff button if `hasChanges` (`+adds` green / `−dels` red) · `needs you` filled badge if asking (`bg #e6b450`, text `#1a1306`) · three 25×23 bordered control boxes: widen glyph, terminal `>_`, mute `⤓`.
2. **Asking band** (181–190), asking only: `padding:10px 14px 8px`, `border-b`. "Waiting on you" label (`600 8.5px` mono, `#c79a3f`) + optional task chip; question text (`13px`, `#eddcb8`, weight 500).
3. **Task popover** (191–209), absolute overlay: header + progress bar + checklist; toggled by the task chip.
4. **Feed** (211–247): `flex:1`, scroll. Working line at top if working (213–217: 6px green `pulseDot 1.4s` + activity `#bfe6d6` + optional task chip). Then `laneFeed` items: user (220–227, right bubble), narration (228–233, avatar box + prose), tool (234–245, status chip + tool label + summary + `→ out` + running caret + time).
5. **Composer** (249–270): collapsed hint row (250–254: `+` box + placeholder + `R` badge) OR expanded (256–269: reply chips for asking + input + `Send`), `border-t`.
6. **Resize strip** (272–274): absolute bottom, 9px `ns-resize`, 34×3 handle.

## Architecture — files touched

| Area | File | Change |
|---|---|---|
| Card | `frontend/app/view/agents/agentrow.tsx` | full rewrite to the banded layout; collapse-state for composer; control-box rework |
| Card host | `frontend/app/view/agents/cockpitsurface.tsx` | pass `onBackground` for asking too (so the `⤓` mute works on every live card, per the handoff) — one-line prop change |
| Feed | `frontend/app/view/agents/narrationtimeline.tsx` | restyle the 4 leaf renderers to the lane look; keep `groupTimeline`/collapse; drop dead `large` prop |
| Status dot | `frontend/app/view/agents/statusdot.tsx` | add optional `pulse` prop (active → `pulseDot`, quiet → static) |
| Placeholder data | `frontend/app/view/agents/agentsviewmodel.ts` | pure `placeholderDiffStats` / `placeholderTasks` / `taskProgress` (marked PLACEHOLDER) + `DiffStats`/`CardTask` types |
| Tokens + keyframes | `frontend/tailwindsetup.css` | new semantic color tokens; `@keyframes pulseDot`, `caret`, `fadeUp` |
| Tests | `frontend/app/view/agents/agentsviewmodel.test.ts` (or a peer) | unit tests for the new pure derivations |
| Deferred log | `docs/deferred.md` | two entries: real git-diff stats, real TodoWrite tasks |

No new files. No backend, no RPC, no generated-type changes.

## Detailed design

### 1. Card container (`agentrow.tsx`)
Keep `Reorder.Item` + `useDragControls` + `cardSpanStyle({wide,height})` + the cursor ring idiom + the `pulse` attention ring. Change the body from one padded column to `flex flex-col overflow-hidden rounded-[13px] border` with **no outer padding** — each band pads itself. State drives `laneBg`/`laneBorder` (asking → `bg-lane-asking border-warning/40`; else `bg-lane border-edge-mid`). Idle-state cards: muted dot (no pulse), no asking band, no working line; composer + mute (= dismiss) still available.

### 2. Header bar
A `flex items-center gap-2 border-b px-3 py-1.5` band with its own background (subtle `leftBg`; use `bg-surface`/`bg-surface-raised` per state). Drag is initiated from the `∷∷` glyph via `controls.start` (glyph always visible now, not hover-gated). `StatusDot` reused with the new `pulse` prop and a size class. Name: `<b className="font-mono text-[13.5px] ...">` — **fixed size** (drop the asking 15px bump). Project pill unchanged in shape. Diff button renders only when `placeholderDiffStats(agent)` is defined. `needs you` badge becomes a **filled** chip (`bg-warning text-[color:var(--color-on-warning)]`). Three uniform control boxes (`w-[25px] h-[23px] border rounded-[6px]`): widen (toggles `cardPrefs.wide`), terminal `>_` (`onOpenTerminal`), mute `⤓`. The `⤓` calls `onBackground` (working **and** asking) or `onDismiss` (idle); `cockpitsurface` is extended to pass `onBackground` for asking so the mute renders on every live card as in the handoff. Backgrounding an asking agent hides a blocked card — acceptable and reversible (it resurfaces from the Backgrounded section, and a new ask re-surfaces it automatically per `partitionBackgrounded`).

### 3. Asking band + working line + task affordances
- **Asking band** (asking only): the "Waiting on you" label + question text (`agent.ask.questions[0]?.question`) in `text-[color:var(--color-ask-question)]`. If the agent has a structured ask (`hasAnswerableAsk`), the `AnswerBar` still renders (in the composer band); the cream band shows the question prose regardless.
- **Working line**: moves to the **top of the feed band** with a `border-b` (was below the header). Green `pulseDot` dot + activity in `text-[color:var(--color-success-soft)]`.
- **Task chip + popover**: chip shows `done/total` from `taskProgress(placeholderTasks(agent))`; clicking toggles an absolute popover (progress bar + checklist) with `fadeUp`. Rendered only when `placeholderTasks` is defined.

### 4. Feed restyle (`narrationtimeline.tsx`)
Keep `groupTimeline`, the collapse-summary button, `accentLatest`, `active`-trailing-expand. Restyle the leaf renderers to match the handoff lane (card-only — this component has a single caller):
- `message` → narration avatar box (`bg-accent/[0.13] border-accent/30`, inner accent dot) + prose.
- `user` → right-aligned bubble (`bg-accent/10 border-accent/26`, `You` label + text).
- `action` → tool line: status chip (outcome-colored) + tool label (uppercase mono, `--color-feed-label`) + target/summary (`--color-feed-summary`) + `→` + note as `out` (outcome color) + outcome glyph. **Per-tool timestamp omitted** (not in `AgentEntry`).
- `group` (collapsed burst) → keep the expandable summary, recolored to accent tokens.

Drop the now-dead `large` prop (no caller passes it; the focus view uses its own renderer).

### 5. Composer (collapse/expand)
Collapse state lives in a **model atom** `openComposerIdAtom` (not `AgentRow` local state) so the `R` keybinding can open it — `cockpitsurface.tsx:411`'s `R` handler focuses the card textarea via `querySelector`, which doesn't exist while collapsed, so `R` must set the atom then `requestAnimationFrame(() => focusRowComposer(id))`. `AgentRow` takes `composerOpen` (controlled) + `onOpenComposer` props. Default **collapsed**: a click-to-open hint row (`+` box, `replyPlaceholder`, `R` badge). `R` (when this card is the cursor) or a click opens it; `AgentComposer`'s `onEscape` clears the atom and refocuses the grid. Asking cards are always expanded (`composerOpen || asking`). Expanded: reply-suggestion chips (asking, from `agent.ask.replySuggestions`) above the reused `AgentComposer`. `AgentComposer` is unchanged.

### 6. Resize strip
Unchanged — the current handle already matches the handoff (34×3 bar, `ns-resize`, absolute bottom).

## Placeholder data + deferred.md

The live `AgentVM` carries no git diff stats and no TodoWrite task list. Per the user's decision, fabricate believable values so the handoff bands render, and record the real wiring as deferred. Pure, deterministic (seeded from `agent.id` so values are stable across renders), clearly marked:

```ts
// PLACEHOLDER (docs/deferred.md#card-diff-stats): no live git source on AgentVM yet.
export interface DiffStats { files: number; adds: number; dels: number; }
export function placeholderDiffStats(agent: AgentVM): DiffStats | undefined; // undefined for some ids/idle so hasChanges varies
export interface CardTask { text: string; done: boolean; }
export function placeholderTasks(agent: AgentVM): CardTask[] | undefined;
export function taskProgress(tasks: CardTask[]): { done: number; total: number; pct: number };
```

`docs/deferred.md` gains two entries:
- **Card diff stats** — wire `+adds/−dels/files` from the Files-surface `gitinfo` RPCs for the agent's worktree; replace `placeholderDiffStats`.
- **Card task list** — project the agent's latest TodoWrite tool state from the transcript into `AgentVM.tasks`; replace `placeholderTasks`.

The placeholder helpers are the single seam to delete when real data lands.

## Theme tokens & keyframes (`tailwindsetup.css`)

No raw hex in markup (project rule). Add semantic tokens for the handoff colors that have none:
- `--color-ask-question: #eddcb8` (asking-band question prose)
- `--color-ask-label: #c79a3f` ("Waiting on you" label)
- `--color-on-warning: #1a1306` (text on the filled `needs you` badge)
- `--color-success-soft: #bfe6d6` (working activity line)
- faint feed-meta greys for the tool line / drag glyph (`#777f89` label, `#9aa3ad` summary, `#4f565f` time, `#454c55` glyph) — exact values from the handoff, named `--color-feed-*`.

Translucent fills (avatar/bubble/chip backgrounds) use Tailwind opacity modifiers on the existing `accent`/`warning` tokens. Subtle chrome neighbors (project pill `#181d23`/`#252b33`, control-box border) reuse the nearest existing `surface`/`edge` tokens unless the diff is visible, in which case an exact token is added.

Add keyframes (none currently exist): `@keyframes pulseDot{0%,100%{opacity:1}50%{opacity:.32}}`, `@keyframes caret{0%,100%{opacity:1}50%{opacity:0}}`, `@keyframes fadeUp{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}`, applied via arbitrary `animate-[...]` utilities.

## Residue / cleanup

Split three ways so nothing is left half-migrated:

**Keep & reuse (shared — other surfaces depend on these):**
- `StatusDot` (used by `agenttree.tsx`, `agenttranscript.tsx`) — reused for the header dot; gains a `pulse` prop. Feeding `isQuiet` into pulse-vs-static keeps `isQuiet` + its test live.
- `formatAge` (6 other callers) — stays; the card stops calling it.
- `AgentComposer`, `groupTimeline`, `cardSpanStyle`, and the `onBackground`/`onDismiss`/`pulse` props — retained.

**Delete (orphaned by this rewrite — our footprint):**
- The `model·age` header branch (`agentrow.tsx:146–151`) — the card's only use of `formatAge`/`idleMs`; remove the import + local. `agent.model` no longer read in the card.
- The two inline SVG buttons (background hamburger + dismiss arrow, `agentrow.tsx:152–192`) — markup folded into the single `⤓` box; handlers rewired.
- The indent-based layout (`mt-2 ml-[26px]`) and the always-on composer wrapper.
- The already-dead `large` prop on `NarrationTimeline`.

**Capability changes (behavior residue — accepted by the user):**
- Reply is one step slower (composer collapsed by default; `R`/click to open).
- `model` leaves the card (visible only in the focus details rail).
- Background vs. dismiss share one `⤓` glyph (state-disambiguated).

## Testing

Per the no-jsdom convention, unit-test only the new pure logic (component rendering is verified visually):
- `placeholderDiffStats` / `placeholderTasks` determinism (same id → same output) and that `hasChanges` varies across ids.
- `taskProgress` math (done/total/pct, including empty + all-done).
- The mute-by-state mapping and composer collapse state if extracted as pure helpers.

Static gates: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (3 baseline `api.test.ts` errors), `npx vitest`, `npx vite build --config frontend/tauri/vite.config.ts`. Visual: CDP screenshot of the dev app against the handoff (`scripts/cdp-shot.mjs`); note the Tailwind/keyframe additions require restarting `task dev`.

## Decisions

- **D1 — Banded rewrite, not a patch.** The card becomes a `flex flex-col` of self-padded bands; the indent-based layout is removed entirely.
- **D2 — Feed: handoff look + keep collapse.** Restyle `NarrationTimeline` leaves; retain `groupTimeline`. Per-tool timestamps omitted (no data).
- **D3 — Placeholder data, faithful + conditional.** Diff/task affordances render from deterministic placeholder helpers; real wiring deferred to `docs/deferred.md`. Accepted risk: live agents show fabricated `+/−` and task counts until wired.
- **D4 — Full handoff-literal controls.** Composer collapses by default; `model·age` dropped; background/dismiss collapse into one `⤓` mute glyph. Supersedes the parity spec's always-on-composer decision.
- **D5 — Reuse `StatusDot`, don't inline.** Add a `pulse` prop rather than a parallel dot; keeps the shared component single-source and `isQuiet` live.
- **D6 — Tokens, no raw hex.** New handoff colors become `@theme` tokens; translucent fills use opacity modifiers on existing tokens.

## Open questions / accepted risks

- **Placeholder-on-live** (accepted, D3): real users see fabricated git/task numbers until the deferred wiring lands. Mitigation: deterministic + clearly marked + single deletion seam.
- Exact `leftBg` shade for the header bar (the handoff value is state-dynamic via `support.js`); the plan picks `surface`/`surface-raised` per state and the CDP check confirms.
  - **Resolved (2026-06-26, CDP):** `bg-surface` over `bg-lane` reads as a distinct title bar (divider + shade), so the header keeps `bg-surface` for all states — no `surface-raised` switch needed.
