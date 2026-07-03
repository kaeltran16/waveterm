# Collapsible rail + Cockpit motion-gap closure — Design

Date: 2026-07-03
Surfaces: **Cockpit**, **Agent**, **Channels** (shared right rail) + Cockpit chrome motion
New primitive: `frontend/app/element/collapsiblerail.tsx`

## Problem

Two related issues surfaced while auditing whether the Cockpit surface's motion was actually complete.

1. **The right-rail UX is inconsistent and the toggle is poor.** Three surfaces each have a right `<aside>`, but they diverge on every axis:

   | Rail | Width | Left border | Sections | Toggle |
   |---|---|---|---|---|
   | Cockpit (`cockpitsurface.tsx:804`) | `300px` | `border-border` | Usage, Recent activity | header text button that swaps its own label ("Hide panel ›" / "‹ Usage"), `railOpenAtom` (session, default open) |
   | Agent DETAILS (`agentdetailsrail.tsx:87`) | `296px` | `border-[#1a1f26]` | Details, Context, Subagents, Tools, Files + Resume/Stop | `d` key only (`railVisibleAtom`, persisted, default off) |
   | Channels context (`channelssurface.tsx:790`) | `300px` | `border-border` | Jarvis header, Autonomy, Fleet, Needs-you, Project | none — auto-shows only above `@[1320px]` |

   The label-swapping button is undiscoverable, the Agent rail is only reachable by a hidden hotkey, and the Channels rail has no manual control at all.

2. **The Agent rail is misaligned with the titlebar ("the interception is a little off").** The app bar's right-edge "usage column" is `w-[300px] border-l border-border` and is *designed* (comment at `app-bar.tsx:63-65`) to read as one continuous vertical line with the rail beneath it. It does on Cockpit (also 300/`border-border`), but the Agent DETAILS rail is `296px` with a hardcoded `#1a1f26` border, so the divider **jogs 4px inward and changes color** exactly at the titlebar/rail seam. The hardcoded hex also violates the project's no-raw-hex rule.

Separately, the Cockpit motion pass (`b3ccce07`) was card-centric — the chrome around the cards still hard-cuts on state changes that the motion north star says should be legible.

## North star

Unchanged from the app-wide revamp (`docs/superpowers/animation-revamp-tracker.md`): **motion is functional-first — it must make a state change more legible.** This pass adds no new motion vocabulary; it *reuses* `motiontokens.ts` and folds the "rail reveal" moment into a shared component. The rail work is a **consistency + reuse** play (one component, one width, one border, one collapse affordance) whose animation happens to be the rail-reveal moment.

## Locked decisions (from the brainstorm)

- **Direction B — collapsible icon rail.** Collapsed, every rail is the same thin icon strip pinned to the right edge (always visible = discoverable). Expanded, it is the full 300px panel. (Chosen over "keep + animate", "slide-over drawer", and "kill the panel" in the visual companion.)
- **Expand model A — scroll-all.** Expanding shows *all* sections stacked and scrollable (today's content layout), not one-section-at-a-time tabs. The collapsed icons double as **jump-to-section anchors** (click → expand + scroll that section into view). Chosen because: (a) it preserves the 300px flush-right panel that fixes the alignment — tabs would need a gutter beside the panel, re-breaking the divider; (b) the sections are lopsided (several are 1-3 lines) so tabs would over-fragment; (c) the real win (discoverable strip) is model-independent, so KISS wins — one open/closed boolean, no active-section state.
- **Reusable component.** A single `CollapsibleRail` used by all three surfaces. Callers supply content + a persistence atom; the component owns layout, border, motion, scroll, and the collapse control.
- **No new vocabulary.** Reveal animation, header/footer entrances, and count transitions all come from `motiontokens.ts` (`MOTION`, `cardVariants`) + the existing `<MotionConfig reducedMotion="user">` pattern.

## Component: `CollapsibleRail`

`frontend/app/element/collapsiblerail.tsx` — a new design-system primitive, sibling to `motiontokens.ts`. It is content-agnostic; the three surfaces feed it sections.

```ts
export interface RailSection {
    id: string;
    icon: React.ReactNode;   // glyph/svg shown in the collapsed strip
    label: string;           // tooltip when collapsed; section heading when expanded
    content: React.ReactNode;
}

export function CollapsibleRail(props: {
    openAtom: PrimitiveAtom<boolean>;  // caller-owned → caller controls persistence + default
    sections: RailSection[];
    footer?: React.ReactNode;          // pinned below the scroll area (e.g. Resume/Stop)
    ariaLabel?: string;
}): JSX.Element;
```

Layout constants (component-local, not motion tokens — these are layout, not motion):
- `RAIL_EXPANDED_PX = 300`, `RAIL_COLLAPSED_PX = 44`.
- Both states: `border-l border-border bg-surface` (Channels currently uses `bg-background`; standardize on `bg-surface` — flag in Open questions).

Behavior:
- **Collapsed** (`w-[44px]`): a vertical strip of `IconButton`s (reuse `frontend/app/element/iconbutton.tsx`) with `Tooltip` (`tooltip.tsx`) = `section.label`. Clicking any icon sets `openAtom = true` and scrolls that section into view.
- **Expanded** (`w-[300px]`): a scroll container; each section renders a small header (`section.label`) + `section.content`; a collapse chevron pinned at the top sets `openAtom = false`; `footer` pinned at the bottom, outside the scroll area.
- **Reveal:** `motion.aside` animating `width` between the two constants on `MOTION.durMacro` + `MOTION.easeFluid`. Width animation reflows the neighboring content (grid / message column reclaims space) — this is the intended, infrequent, user-initiated transition, not a per-frame loop, so animating `width` (a layout property) is acceptable here. The component **self-wraps its `motion.aside` in `<MotionConfig reducedMotion="user">`** so the width snaps under reduced motion regardless of which surface hosts it (Cockpit already has an outer `MotionConfig`; nesting is harmless). The component adds no CSS loop.
- **Jump-to-section:** each section wraps in a `ref`; the icon's click handler opens then `scrollIntoView({ block: "start" })` on the next frame.

### Migration

Each surface swaps its raw `<aside>` for `<CollapsibleRail>`, passing its existing atom and its sections:

- **Cockpit** (`cockpitsurface.tsx`): sections `[Usage, Recent activity]`, `openAtom={model.railOpenAtom}`. Removes the header "Hide panel ›/‹ Usage" text button (the strip is now the affordance).
- **Agent** (`agentdetailsrail.tsx`): sections `[Details, Context window, Subagents, Tools used, Files touched]`, `footer={<Resume/Stop>}`, `openAtom={railVisibleAtom}`. The `296px`/`#1a1f26` `<aside>` is deleted, so the alignment bug and the hex-token violation are fixed **by construction**. The `d` key keeps working (it already toggles `railVisibleAtom`). Also fix the idle text: `agentdetailsrail.tsx:82` currently renders `` `${formatAge(undefined)} idle` `` → the nonsensical "just now idle"; the idle branch should render just `"idle"`.
- **Channels** (`channelssurface.tsx`): `ContextPanel`'s `<aside>` becomes `<CollapsibleRail>` with sections `[Jarvis / Autonomy, Fleet, Needs-you, Project]` (grouping the header + autonomy explainer into one section). Drops the `hidden @[1320px]:flex` container-query auto-hide in favor of the manual strip; needs a new persisted atom (e.g. `channelRailOpenAtom` in `channelsstore.ts` or `railstore.ts`).

## Cockpit motion-gap closure

All reuse `motiontokens.ts` + the surface's existing `<MotionConfig reducedMotion="user">`. (The former "rail reveal" gap is now handled by `CollapsibleRail`.)

1. **Rolling counts.** `RollingCount` (`cockpitsurface.tsx:53`) is currently a static `<span>` despite its name. Upgrade it to animate on value change — the digit change fades/slides (old out, new in) via `AnimatePresence` keyed on the value, `MOTION.durMicro`. Applies to the filter chips (All / Asking / Working / Idle) and the "N need you" figure. A count ticking up is exactly a state change the north star says to make legible. Reduced motion → instant swap.
2. **Section-header + empty-state appearance.** Wrap the "Live agents" `SectionHeader` (shown when `liveCount > 0`) and the empty-state block in `AnimatePresence` + `cardVariants` so the empty↔populated flip and the header's appear/disappear are eased rather than hard-cut.
3. **Grid→footer handoff (completes moment 2).** `BackgroundedSection` and `IdleSection` (`backgroundedsection.tsx`, `idlesection.tsx`) render the cards that *exit* the grid, but with no arrival motion — so a card visually teleports into the footer. Wrap their item lists in `AnimatePresence` + `cardVariants` (opacity+scale, `initial={false}` so a populated mount doesn't cascade) so the destination entrance mirrors the grid exit.

## Edge cases

- **No entrance cascade.** `initial={false}` on every new `AnimatePresence` (headers, footer sections) so mounting a populated Cockpit does not fire N entrances — only post-mount changes animate. Same guard already used for the card grid.
- **Reduced motion.** `CollapsibleRail` self-wraps in `<MotionConfig reducedMotion="user">`, so the rail width degrades to instant on every surface without the caller doing anything. The Cockpit chrome motion (count swaps, header/footer entrances) is honored by the Cockpit surface's existing outer `<MotionConfig reducedMotion="user">`. No new CSS keyframe loops are added, so there is nothing extra to guard with `@media`.
- **Collapsed strip vs. titlebar divider.** When *collapsed* (44px) the rail no longer sits under the app-bar's 300px usage-column border — but that is already the case today whenever a rail is closed, and the divider-above-grid is pre-existing and out of scope. Alignment is guaranteed in the *expanded* state, which is what "the interception is off" referred to.
- **Channels narrow panes.** Losing the `@[1320px]` auto-hide means the 44px strip is always present. That is an intended, small, consistent cost; default the Channels rail to collapsed so narrow panes keep maximum message width.
- **Jotai atom ownership.** The component never creates storage; it only reads/writes the passed `openAtom`. Cockpit keeps its session `atom(true)`, Agent keeps its persisted `atomWithStorage`, Channels gets a new one — no behavior regressions to existing persistence.

## Files touched (all frontend; no `task generate`, no backend/RPC)

| File | Change |
|---|---|
| `frontend/app/element/collapsiblerail.tsx` | **New.** The reusable rail (strip ↔ 300px panel, reveal animation, scroll, jump-to-section, footer). |
| `frontend/app/view/agents/cockpitsurface.tsx` | Replace the Usage/Recent `<aside>` (804-888) with `<CollapsibleRail>`; remove the "Hide panel" text button; upgrade `RollingCount`; wrap the "Live agents" header + empty state in `AnimatePresence`. |
| `frontend/app/view/agents/agentdetailsrail.tsx` | Return `CollapsibleRail` sections instead of the raw `<aside>`; delete `w-[296px]`/`border-[#1a1f26]`; fix the "just now idle" text (line 82). |
| `frontend/app/view/agents/channelssurface.tsx` | `ContextPanel` → `<CollapsibleRail>`; drop the `@[1320px]` auto-hide. |
| `frontend/app/view/agents/backgroundedsection.tsx`, `idlesection.tsx` | Wrap item lists in `AnimatePresence` + `cardVariants` (`initial={false}`). |
| `channelsstore.ts` (or `railstore.ts`) | Add `channelRailOpenAtom` (persisted, default collapsed). |
| `frontend/app/element/motiontokens.test.ts` | If a count-transition preset or jump helper is extracted as a pure fn, add a guard; otherwise unchanged. |

## Testing / verification

- **Unit (`npx vitest run`):** existing suite stays green. The component is largely presentational (no jsdom render harness for the cockpit — CLAUDE.md), so unit coverage is limited to any extracted pure helper (e.g. a value-change key for the count transition). No fabricated render tests.
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline clean; any error is ours).
- **Visual (CDP, per CLAUDE.md — `scripts/cdp-shot.mjs` on :9222):** collapsed strip renders on all three rails; expand/collapse width animation; **border continuity** — the expanded rail's left border lines up with the app-bar usage-column divider (the "interception" fix); jump-to-section from a collapsed icon; rolling counts on a filter change; "Live agents" header + empty-state entrance; card arrival into the Backgrounded/Idle footers; `prefers-reduced-motion` → everything instant, no cascade on tab open.

## Non-goals

- Full Agent / Channels *motion* passes (narration fade, message entrance, etc.) — those remain their own tracker rows; this pass only unifies their rails + the rail-reveal moment.
- The app-bar's own layout (the fixed 300px usage column, the divider-above-grid when collapsed) — pre-existing, out of scope.
- Tabs / one-section-at-a-time rail (expand model B) — explicitly rejected above; can be layered later if a rail ever needs it.
- Resizable rail width — YAGNI; fixed 300px.

## Open questions (resolve in the plan, not blocking)

- **Channels rail background:** standardize on `bg-surface` (Cockpit/Agent) vs. keep Channels' `bg-background`? Leaning `bg-surface` for consistency.
- **Collapsed strip icon set for the Agent rail (5 sections):** 1:1 icons vs. curate to the few worth a jump anchor. Leaning 1:1 (small 16px icons stack fine); revisit in the CDP pass if the strip feels crowded.
- **Count transition style:** vertical slide-swap vs. crossfade vs. spring count-up. Decide in the CDP pass against a real changing roster; default to the simplest that reads as "it changed" (slide-swap).

## Commit note

Per repo convention this spec + its plan fold into the feature commit, not a separate docs-only commit. Nothing is committed without explicit approval. This pass advances the Cockpit row (chrome gaps) and partially the Agent + Channels rows (shared rail) in `docs/superpowers/animation-revamp-tracker.md`; flip/annotate those rows when it lands.
