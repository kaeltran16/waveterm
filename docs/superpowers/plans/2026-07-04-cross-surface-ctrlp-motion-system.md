# Cross-surface / Ctrl+P Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the cross-surface tab transition as "none, by design" and ship one ship-gated selection-tint micro in the Ctrl+P command palette, closing the tracker row.

**Architecture:** The incoming surface's own entrance reveal is the cross-surface transition — the shell adds no container animation. The palette→surface hand-off already emerges from the existing set-surface-before-close ordering (new surface mounts under the fading `ModalShell`). The only code change is adding `transition-colors duration-[140ms]` to the palette's active row, and it ships only if it verifies clean in the live dev app.

**Tech Stack:** React 19, Tailwind 4, `motion/react` v12, jotai. Motion tokens in `frontend/app/element/motiontokens.ts`. Verification via the live Tauri dev app over CDP (no jsdom/render harness exists — see `CLAUDE.md`).

## Global Constraints

- **No new tokens, no new primitives, no shell restructuring.** (spec)
- **Only permitted motion class:** `transition-colors duration-[140ms]` — the shipped moment-7 idiom (AgentTree, ChannelRail, FilesSurface). Do not introduce `layoutId`, sliding highlights, or per-keystroke reflow. (spec, north-star "no new vocabulary")
- **Do not touch** per-surface entrance reveals, `ModalShell` open/close motion, or `cockpitshell.tsx` swap structure. (spec "Out of scope")
- **Reduced motion:** the selection tint is a color transition (no transform), acceptable under reduced motion; no extra gate needed. (spec)
- **Verification is visual, not unit-tested.** There is no render-test harness for cockpit motion; drive the live dev app over CDP. TDD failing-test steps do not apply to a CSS-class change — the "test" is the observed behavior in the running app. (CLAUDE.md)
- **Typecheck** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (`npx tsc` stack-overflows on this repo). Baseline is clean (exit 0). (CLAUDE.md)

---

### Task 1: Palette selection-tint micro (ship-gated)

Add the moment-7 color transition to the command-palette active row so the highlight fades between rows instead of hard-snapping. This is the only code change in the plan, and it is gated: if the fade smears across rows on held arrow-repeat or fast mouse traversal, it is reverted and the palette keeps its instant tint (spec §3).

**Files:**
- Modify: `frontend/app/cockpit/command-palette.tsx:224-227` (the results-row `<button>` `className`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks depend on (self-contained className change).

- [ ] **Step 1: Establish the baseline in the live app**

The dev app should already be running (`task dev`). If not, start it. Then inject a populated roster and confirm the palette opens, so you can see the "before" behavior (instant tint jump on arrow-nav):

Run:
```bash
node scripts/inject-live-agents.mjs active
node scripts/cdp-shot.mjs scratchpad/palette-before.png
```
Expected: a PNG of the app. (Open Ctrl+P manually in the app if you want to eyeball the pre-change instant tint; the screenshot is the record that CDP attach works before you edit.)

- [ ] **Step 2: Add the transition-colors micro to the active row**

In `frontend/app/cockpit/command-palette.tsx`, the results-row button currently reads:

```tsx
className={cn(
    "flex w-full cursor-pointer items-center gap-3 px-4 py-[7px] text-left",
    active ? "bg-accentbg" : "hover:bg-surface-hover"
)}
```

Change the static class string to add the shipped moment-7 idiom (matches `filessurface.tsx:140`):

```tsx
className={cn(
    "flex w-full cursor-pointer items-center gap-3 px-4 py-[7px] text-left transition-colors duration-[140ms]",
    active ? "bg-accentbg" : "hover:bg-surface-hover"
)}
```

Do not change anything else in the row (the inner title/subtitle spans keep their instant color — the row background is the selection cue).

- [ ] **Step 3: Typecheck**

Run:
```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```
Expected: exit 0 (clean baseline; a className change introduces no type error).

- [ ] **Step 4: Verify the tint in the live app — the ship gate**

The dev server HMR-reloads on save. In the running app, open Ctrl+P and:
1. Hold ↓ (arrow-repeat) through the list. Watch the highlight.
2. Sweep the mouse quickly down the list.

Capture evidence:
```bash
node scripts/cdp-shot.mjs scratchpad/palette-after.png
```

**Decision:**
- **Ships** if the highlight fades cleanly between rows and tracks selection without a visible smear/trail of multiple mid-transition rows on held repeat.
- **Reverted** if it smears: undo Step 2 (restore the original className with no `transition-colors duration-[140ms]`), re-run Step 3, and record in the commit message that the tint was dropped on the legibility gate. The instant tint is the correct fallback per spec §3.

- [ ] **Step 5: Commit**

If shipped:
```bash
git add frontend/app/cockpit/command-palette.tsx
git commit -m "feat(motion): palette selection tint micro (m7)"
```
If reverted (no net code change), skip this commit and note the gate outcome in Task 2's commit body.

---

### Task 2: Acceptance verification + close the tracker row

Confirm the no-code decisions hold in the running app (swap = none / no double animation; palette dissolves into the arriving surface; typing is an instant snap), then flip the tracker row to shipped. If any acceptance check fails, stop and revisit the spec rather than adding motion to compensate.

**Files:**
- Modify: `docs/superpowers/animation-revamp-tracker.md` (the "Cross-surface tab transitions" row + the References section)

**Interfaces:**
- Consumes: the Task 1 ship/revert outcome (to state accurately what shipped).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Verify the surface swap shows no double animation**

In the live app (roster injected via `node scripts/inject-live-agents.mjs active`), switch surfaces three ways and watch each arrival:
1. Click nav-rail items.
2. Press `[` and `]`.
3. Ctrl+P → "Go to <surface>".

Expected for every path: the arriving surface plays **its own** entrance reveal once; there is **no** additional shell-level crossfade and **no** second animation on the same surface. Switching **to** the Agent surface shows no arrival motion (it never unmounts) — this is expected, not a defect.

- [ ] **Step 2: Verify the palette → surface hand-off**

Ctrl+P → select "Go to Files" (or any surface). Watch the transition.

Expected: the palette panel fades + scales down (`ModalShell` exit) while the Files surface appears underneath and runs its reveal — reading as the palette dissolving into the arriving surface. Capture:
```bash
node scripts/cdp-shot.mjs scratchpad/handoff.png
```
If the surface is NOT visible under the fading palette (i.e. it appears only after the palette is gone), the set-surface-before-close ordering is broken — stop and revisit spec §2. Expected outcome per spec: no code change needed.

- [ ] **Step 3: Verify the results list is an instant snap**

In Ctrl+P, type a query and watch the list filter.

Expected: results re-rank/re-group instantly with no reflow tween and no per-item entrance cascade (matches Sessions' search path). If motion appears here, something added reflow against the spec — remove it.

- [ ] **Step 4: Flip the tracker row**

In `docs/superpowers/animation-revamp-tracker.md`, replace the "Cross-surface tab transitions" row:

```markdown
| **Cross-surface tab transitions** | ☐ Not started | Switching surfaces (`[`/`]`, rail). Design decision pending: crossfade vs. none. Must not fight per-surface entrances. |
```

with (fill in the actual SHA from Task 1's commit, or Task 2's if the tint was reverted; and state whether the tint shipped):

```markdown
| **Cross-surface tab transitions** | ✅ Shipped (2026-07-04) | Decision: **no container transition** — each surface's own entrance reveal IS the swap (only option that can't fight per-surface entrances). Palette→surface hand-off is emergent (surface mounts under the fading `ModalShell`; set-surface-before-close). Palette list stays an instant snap (no reflow/cascade). Selection tint micro (m7 `transition-colors duration-[140ms]`): <shipped | dropped on smear gate>. No new tokens/primitives/shell changes. SHA `<sha>`. |
```

Then add to the References section (after the Usage lines):

```markdown
- Cross-surface / Ctrl+P motion design spec: `docs/superpowers/specs/2026-07-04-cross-surface-ctrlp-motion-design.md`
- Cross-surface / Ctrl+P motion implementation plan: `docs/superpowers/plans/2026-07-04-cross-surface-ctrlp-motion-system.md`
```

Also update the `Last updated:` line to `2026-07-04` (already that date — confirm it is).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/animation-revamp-tracker.md
git commit -m "docs(motion): ship cross-surface + Ctrl+P palette motion; update tracker"
```
If the Task 1 tint was reverted, note that in this commit body (e.g. "selection tint dropped on legibility gate; swap decision = none").

---

## Self-Review

**Spec coverage:**
- Decision 1 (surface swap = none) → Task 2 Step 1 (acceptance verify; no code, by design). ✓
- Decision 2 (palette→surface hand-off, verify only) → Task 2 Step 2. ✓
- Decision 3 list (instant snap, no reflow/cascade) → Task 2 Step 3. ✓
- Decision 3 selection tint (optional, ship-gated) → Task 1. ✓
- Reduced motion → Global Constraints (no extra gate; color-only). ✓
- Verification method (CDP live app) → Global Constraints + every verify step. ✓
- Out of scope (per-surface reveals, ModalShell, shell structure, Memory) → Global Constraints. ✓
- Tracker row closure → Task 2 Step 4. ✓

**Placeholder scan:** `<sha>` and `<shipped | dropped ...>` are intentional fill-ins resolved at execution time from the actual commit/gate outcome, not vague TODOs — each has explicit instructions for what to substitute. No other placeholders.

**Type consistency:** Only one code edit (a className string); no cross-task types/signatures to reconcile.
