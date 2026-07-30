# Jarvis Autonomy Chip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Jarvis Stage header's 283×41px autonomy ladder with a fixed-width chip that opens a popover holding the three nested rungs and the Delegator-only dispatch mode, so the header stops shifting when Delegator is selected and the control matches the app's scale.

**Architecture:** The chip is a `<button>` in the same classes as its `Graph` sibling (27px tall) with a 3-bar glyph, the tier name, and a chevron; its `min-w` is pinned to the widest state so its box never changes. The popover reuses the proven cockpit pattern from `TermThemeDropdown` — floating-ui `useClick` + `useDismiss` (Escape *and* outside-click) with `PopoverReveal` for motion. All decision logic (rung order, fill state, bar heights, chip text) stays in the already-unit-tested pure module `autonomyladder.ts`; the view is markup only.

**Tech Stack:** React 19 · Tailwind 4 (`@theme` tokens in `frontend/tailwindsetup.css`) · `@floating-ui/react` · `motion/react` via `PopoverReveal` · vitest · CDP verification harness (`scripts/cdp/`)

**Spec:** `docs/superpowers/specs/2026-07-30-jarvis-autonomy-chip-design.md`

## Global Constraints

- **Colors come from `@theme` tokens only.** Never a raw hex or `rgba()` in a class. Tokens this plan uses, all confirmed present in `frontend/tailwindsetup.css`: `accent` (55), `accent-700` (52), `accent-soft` (57), `edge-mid` (40), `border` (39), `surface-raised` (12), `surface-hover` (13), `muted` (35), `secondary` (24), `primary` (23), `success` (67). The one exception already in the codebase is the panel's drop shadow, copied verbatim from `settingssurface.tsx:554`.
- **Never hand-edit generated files.** Nothing in this plan is generated; no `task generate` run is needed (no Go/wshrpc type changes).
- **Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.** Bare `npx tsc` stack-overflows on this repo. The baseline is clean (exit 0), so any error reported is yours.
- **Do not run `prettier --write` on `stageheader.tsx` or `scripts/cdp/scenarios.mjs`.** Both are already dirty from another session's in-flight work, and `--write` reorders imports and rewraps whole files, turning a 3-line edit into a 600-line diff. `.editorconfig` also omits `.mjs`, so `--write` reindents those files from 4-space to 2-space. Hand-format edits in both. `autonomyladderview.tsx` is fully rewritten by this plan and clean, so `npx prettier --write` on that one file only is safe.
- **Commits: one commit at the end, and only after the user explicitly approves it.** The user's standing git rule overrides the per-task commit steps this skill normally emits: never commit or push without explicit approval, batch into one commit, do not add a co-author. The spec and plan docs fold into that same feature commit — never a docs-only commit.
- **Stage only this change's files.** Nine files are dirty from in-flight work; three of them are touched here (`stageheader.tsx`, `scripts/cdp/scenarios.mjs`, `docs/jarvis-tab.md`) in different regions. Leave `collapsiblerail.tsx`, `stagerail.tsx`, `profilepanel.tsx`, `jarvisstore.ts`, `stage.tsx` and `docs/jarvis-tour.md` alone — do not stage them, do not revert them.
- **The tier is nested, not a choice of three.** `delegator` implies `gatekeeper` implies `concierge` (`pkg/jarvis/resolve.go`). Any rendering that reads as three alternatives is wrong.
- **No render/snapshot tests for this surface.** The established position: pure glue is extracted and unit-tested, "does it render" is verified over CDP. Do not add jsdom render tests.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `frontend/app/view/jarvis/autonomyladder.ts` | Pure shape + decisions: rung order, `rungState`, dispatch-mode gate, **new:** bar heights and chip text. No React. | Modify (add 2 exports) |
| `frontend/app/view/jarvis/autonomyladder.test.ts` | Unit tests for the above. | Modify (add 2 describes) |
| `frontend/app/view/jarvis/autonomyladderview.tsx` | The chip + its popover. Markup and floating-ui wiring only — no decisions. | Rewrite in place (67 → ~140 lines) |
| `frontend/app/view/jarvis/stageheader.tsx` | The header row. Call site is **byte-identical**; only a now-false comment is deleted. | Modify (delete comment) |
| `scripts/cdp/scenarios.mjs` | The `jarvis-fleet` scenario's autonomy assertion, plus the no-shift regression check. | Modify (one `assert` body) |
| `docs/jarvis-tab.md` | §8, the autonomy control's reference description. | Modify (one section) |
| `docs/jarvis-consolidation-open-issues.md` | JC12's entry — its cause is now removed. | Modify (add a note) |

Filename and the `AutonomyLadder` export name are **kept**: the ladder still exists, it just lives in the panel now, and renaming a frontend module while the dev app runs blanks the page with no error overlay.

**Deviation from the spec, deliberate:** the spec's §5 names a `chipLabel(tier, mode)` returning one string. This plan implements `chipParts(tier, mode)` returning `{ label, mode }` instead, because §3 requires the mode to keep its muted-mono treatment, which a single concatenated string cannot express. Same inputs, same gate, same tests — one extra field.

**Second deviation, deliberate:** the spec's §4 mentions the `+` copy form from `docs/jarvis-tab.md`. The existing `LADDER` blurbs already state the nesting explicitly ("implies Concierge, and answers routine asks itself…") and `autonomyladder.test.ts:9` pins that wording. Keep the blurbs verbatim — no copy churn, and the existing nesting test stays meaningful.

---

### Task 1: Bar heights and chip text as pure, tested exports

Both the chip's glyph and the panel's rows draw the same bars, and both the chip and (later) the CDP scenario care what the chip's text says. Neither belongs in markup.

**Files:**
- Modify: `frontend/app/view/jarvis/autonomyladder.ts`
- Test: `frontend/app/view/jarvis/autonomyladder.test.ts`

**Interfaces:**
- Consumes: existing `LADDER`, `RANK`, `rungState`, `showsDispatchMode`, `DISPATCH_MODES` from the same file; `JarvisTier` from `@/app/view/agents/channelmessages`.
- Produces:
  - `RUNG_BAR_PX: readonly number[]` — bar height in px per rung, index-aligned to `LADDER`.
  - `chipParts(tier: JarvisTier, mode: string | undefined): { label: string; mode: string | null }`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/jarvis/autonomyladder.test.ts`. Note the import line at the top of that file must gain the two new names — change line 2 to:

```ts
import { chipParts, DISPATCH_MODES, LADDER, RUNG_BAR_PX, rungState, showsDispatchMode } from "./autonomyladder";
```

Then append:

```ts
describe("RUNG_BAR_PX", () => {
    it("gives every rung a height, index-aligned to the ladder", () => {
        expect(RUNG_BAR_PX).toHaveLength(LADDER.length);
    });

    it("grows with the rung, so the bars read as accumulation", () => {
        const rising = RUNG_BAR_PX.every((h, i) => i === 0 || h > RUNG_BAR_PX[i - 1]);
        expect(rising).toBe(true);
    });
});

describe("chipParts", () => {
    it("names the current tier", () => {
        expect(chipParts("gatekeeper", "report").label).toBe("Gatekeeper");
        expect(chipParts("concierge", "report").label).toBe("Concierge");
    });

    it("carries the dispatch mode at delegator only", () => {
        expect(chipParts("delegator", "fanout").mode).toBe("fanout");
        expect(chipParts("gatekeeper", "fanout").mode).toBeNull();
        expect(chipParts("concierge", "fanout").mode).toBeNull();
    });

    it("drops an unset mode rather than rendering a bare separator", () => {
        expect(chipParts("delegator", "").mode).toBeNull();
        expect(chipParts("delegator", undefined).mode).toBeNull();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/jarvis/autonomyladder.test.ts`

Expected: FAIL. The import of `chipParts` / `RUNG_BAR_PX` cannot be resolved, so the whole file errors — that is the expected failure, not just the new cases.

- [ ] **Step 3: Write the minimal implementation**

In `frontend/app/view/jarvis/autonomyladder.ts`, append after the existing `showsDispatchMode`:

```ts
// One source for the bar heights, because two draw them: the header chip's glyph and the popover's rows.
// A rung that is taller in one place than the other stops reading as the same ladder.
export const RUNG_BAR_PX: readonly number[] = [3, 5, 7];

// The chip's face. The mode is a free string off channel meta and only means anything at delegator, so
// below that tier — or when it is unset — the chip is the tier alone, with no dangling separator.
export function chipParts(tier: JarvisTier, mode: string | undefined): { label: string; mode: string | null } {
    const label = LADDER.find((r) => r.tier === tier)?.label ?? tier;
    return { label, mode: showsDispatchMode(tier) && mode ? mode : null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/jarvis/autonomyladder.test.ts`

Expected: PASS, all describes including the four pre-existing ones (`LADDER`, `rungState`, `showsDispatchMode`).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

Expected: exit 0, no output. The baseline is clean, so any error here is from this task.

- [ ] **Step 6: Do not commit yet**

Per the global constraints, everything lands in one approved commit at the end (Task 5). Leave the working tree dirty and move to Task 2.

---

### Task 2: The chip and its popover

**Files:**
- Rewrite: `frontend/app/view/jarvis/autonomyladderview.tsx`
- Modify: `frontend/app/view/jarvis/stageheader.tsx:34-38` (delete a comment; the `<AutonomyLadder …/>` call at :69-71 is unchanged)

**Interfaces:**
- Consumes: `RUNG_BAR_PX`, `chipParts` from Task 1; existing `LADDER`, `rungState`, `showsDispatchMode`, `DISPATCH_MODES`; `setChannelTier(channelId, tier, mode)` from `@/app/view/agents/channelsstore`; `PopoverReveal` from `@/app/element/popoverreveal`.
- Produces: `AutonomyLadder({ channelId: string, tier: JarvisTier, mode: string })` — **same name and same props as today**, so `stageheader.tsx`'s call site does not change. Two DOM hooks for the CDP scenario in Task 4: `data-jarvis-autonomy="chip"` on the button, `data-jarvis-autonomy="panel"` on the panel.

- [ ] **Step 1: Replace the file**

Write `frontend/app/view/jarvis/autonomyladderview.tsx` in full:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The channel's autonomy control. The header carries a fixed-width chip naming the current tier; the three
// nested rungs, their blurbs and the Delegator-only dispatch mode live in the popover it opens.
//
// Why a chip. The rungs used to sit in the header with the dispatch strip beside them, rendered only at
// Delegator — so selecting that tier grew the group ~140px and slid all three rungs left, out from under
// the cursor that had just clicked one (this is JC12's cause, measured at a 0px title). The chip's box is
// identical at every tier and every mode, so the shift is gone by construction rather than absorbed by a
// reserved gap. It also brings the control to the header's own scale: 27px tall, like the Graph button
// beside it, where the group was 41px in a 43px band.

import { PopoverReveal } from "@/app/element/popoverreveal";
import type { JarvisTier } from "@/app/view/agents/channelmessages";
import { setChannelTier } from "@/app/view/agents/channelsstore";
import { cn, fireAndForget } from "@/util/util";
import { autoUpdate, offset, useClick, useDismiss, useFloating, useInteractions } from "@floating-ui/react";
import { useState } from "react";
import { chipParts, DISPATCH_MODES, LADDER, RUNG_BAR_PX, rungState, showsDispatchMode } from "./autonomyladder";

// The ladder itself, at whatever width its host wants: 3px in the chip's glyph, 4px in a panel row. Bars
// fill up to `tier`, so a row passed its own tier says what that tier includes — which makes the current
// row's glyph identical to the chip's, and the chip's glyph legible once you have opened the panel.
function RungBars({ tier, width }: { tier: JarvisTier; width: number }) {
    return (
        <span className="flex flex-none items-end gap-[2px]">
            {LADDER.map((rung, i) => (
                <span
                    key={rung.tier}
                    className={cn("rounded-[1px]", rungState(tier, rung.tier) === "off" ? "bg-edge-mid" : "bg-accent")}
                    style={{ width, height: RUNG_BAR_PX[i] }}
                />
            ))}
        </span>
    );
}

export function AutonomyLadder({ channelId, tier, mode }: { channelId: string; tier: JarvisTier; mode: string }) {
    const [open, setOpen] = useState(false);
    const setTier = (next: JarvisTier) => fireAndForget(() => setChannelTier(channelId, next, mode));
    const setMode = (next: string) => fireAndForget(() => setChannelTier(channelId, tier, next));
    const face = chipParts(tier, mode);
    // bottom-end + useDismiss is the cockpit's popover pattern (settingssurface TermThemeDropdown): both
    // Escape and an outside click close it, where a hand-rolled backdrop only ever closed on click.
    const { refs, floatingStyles, context } = useFloating({
        open,
        onOpenChange: setOpen,
        placement: "bottom-end",
        middleware: [offset(6)],
        whileElementsMounted: autoUpdate,
    });
    const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context), useDismiss(context)]);
    return (
        <div className="relative flex-none">
            <button
                ref={refs.setReference}
                {...getReferenceProps()}
                type="button"
                data-jarvis-autonomy="chip"
                aria-expanded={open}
                title="Autonomy — how much Jarvis decides on this channel"
                // min-w holds the widest state ("Delegator · fanout"), pinned by measurement in Task 3 of
                // the plan: a chip that sizes to its tier would put back the shift this replaced.
                className={cn(
                    "flex min-w-[172px] cursor-pointer items-center gap-2 rounded-[7px] border bg-surface px-2.5 py-1 text-[11px] font-semibold",
                    open ? "border-accent-700 text-primary" : "border-border text-secondary hover:text-primary"
                )}
            >
                <RungBars tier={tier} width={3} />
                <span className="flex-1 whitespace-nowrap text-left">{face.label}</span>
                {face.mode != null ? (
                    <span className="flex-none font-mono text-[10.5px] font-normal text-muted">· {face.mode}</span>
                ) : null}
                <span className={cn("flex-none font-mono text-[10px] text-muted", open && "rotate-180")}>▾</span>
            </button>
            {/* rendered unconditionally and driven by `open` — a `{open ? … : null}` caller defeats
                PopoverReveal's AnimatePresence and the exit animation never plays. */}
            <div ref={refs.setFloating} style={floatingStyles} {...getFloatingProps()} className="z-20">
                <PopoverReveal
                    open={open}
                    origin="top right"
                    className="w-[300px] rounded-[11px] border border-border bg-surface p-[5px] shadow-[0_12px_34px_rgba(0,0,0,0.5)]"
                >
                    <div data-jarvis-autonomy="panel">
                        <div className="px-[9px] pb-1.5 pt-1 font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">
                            Autonomy
                        </div>
                        {LADDER.map((rung) => {
                            const active = rung.tier === tier;
                            return (
                                <button
                                    key={rung.tier}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => setTier(rung.tier)}
                                    className={cn(
                                        "flex w-full cursor-pointer items-start gap-2.5 rounded px-[9px] py-2 text-left hover:bg-surface-hover",
                                        active ? "bg-surface-raised" : "bg-transparent"
                                    )}
                                >
                                    <span className="pt-[5px]">
                                        <RungBars tier={rung.tier} width={4} />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span
                                            className={cn(
                                                "block text-[12.5px] font-semibold",
                                                active ? "text-accent" : "text-primary"
                                            )}
                                        >
                                            {rung.label}
                                        </span>
                                        {/* the blurbs were tooltip-only while the rungs were 70px wide; the
                                            panel is where they finally fit as text */}
                                        <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted">
                                            {rung.blurb}
                                        </span>
                                    </span>
                                    {active ? (
                                        <span className="flex-none pt-[3px] font-mono text-[11px] text-accent">✓</span>
                                    ) : null}
                                </button>
                            );
                        })}
                        {/* Delegator-only, and absent rather than greyed out: a control the tier cannot act
                            on is not drawn. The panel grows downward from a top-anchored header, so nothing
                            under the pointer moves when this appears. */}
                        {showsDispatchMode(tier) ? (
                            <div className="mt-1 border-t border-border px-[9px] pb-1 pt-2">
                                <div className="pb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">
                                    Dispatch mode
                                </div>
                                <div className="flex gap-1">
                                    {DISPATCH_MODES.map((m) => (
                                        <button
                                            key={m}
                                            type="button"
                                            aria-pressed={mode === m}
                                            onClick={() => setMode(m)}
                                            className={cn(
                                                "cursor-pointer rounded-[5px] px-2 py-1 font-mono text-[10.5px]",
                                                mode === m
                                                    ? "bg-success/15 text-success"
                                                    : "text-muted hover:text-secondary"
                                            )}
                                        >
                                            {m}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : null}
                    </div>
                </PopoverReveal>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Delete the now-false comment in the header**

In `frontend/app/view/jarvis/stageheader.tsx`, the comment at lines 34-38 describes the ladder dropping its rung labels under pressure. Those labels no longer exist in the header. **Hand-edit** (this file is dirty from another session — no `prettier --write`). Replace:

```tsx
            {/* @container: the ladder's rungs and its dispatch strip yield to the header's own width, not
                the window's. The title was the only shrinkable item in this row, so it truncated to 0px
                whenever the ladder grew — the subject you are looking at lost its name. It now has a floor
                and the ladder gives up its labels first (see autonomyladderview). The query container is
                the gutter row, which is the box its children actually get. */}
```

with:

```tsx
            {/* @container: the subtitle yields to the header's own width, not the window's. The title was
                the only shrinkable item in this row, so it truncated to 0px whenever the autonomy control
                grew — the subject you are looking at lost its name. The control is now a fixed-width chip
                that cannot grow, and the title keeps its floor. The query container is the gutter row,
                which is the box its children actually get. */}
```

Leave everything else in the file untouched, including the `<AutonomyLadder channelId={channelId} tier={tier} mode={mode} />` call.

- [ ] **Step 3: Format the one file this task owns**

Run: `npx prettier --write frontend/app/view/jarvis/autonomyladderview.tsx`

Expected: reformats only that file (it was written from scratch here, so import reordering is harmless). Do **not** pass any other path.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

Expected: exit 0.

- [ ] **Step 5: Lint the two touched frontend files**

Run: `npx eslint frontend/app/view/jarvis/autonomyladderview.tsx frontend/app/view/jarvis/stageheader.tsx`

Expected: no errors. (`eslint.config.js` still references removed `emain/` and a phantom `tsunami/frontend` workspace — both dead; ignore any noise about them.)

- [ ] **Step 6: See it render**

Start the dev app if it is not already running. Headless `task dev` dies on stdin EOF, so keep stdin open:

```bash
tail -f /dev/null | task dev
```

Then, with a channel selected on the Jarvis surface, capture the header:

```bash
node scripts/cdp-shot.mjs cdp-shots/autonomy-chip.png
```

Expected in the shot: one chip at the header's right, the same height as `Graph`, reading `▮▮▮ Concierge ▾` (or the channel's real tier). Read the PNG to confirm before moving on. If the page is blank, do a full `location.reload()` over CDP — HMR after a file rewrite can leave the app in a torn state with no error overlay.

- [ ] **Step 7: Do not commit yet**

---

### Task 3: Pin the chip's min-width to a measurement

`min-w-[172px]` in Task 2 is arithmetic on the type sizes, not a measurement. If it is too small, the chip grows at Delegator and the shift is back — the exact bug this replaces.

**Files:**
- Modify: `frontend/app/view/jarvis/autonomyladderview.tsx` (the `min-w-[…]` class and its comment)
- Create: nothing. This task's artifact is a number and a recorded measurement.

**Interfaces:**
- Consumes: the rendered chip from Task 2, via CDP.
- Produces: a `min-w-[Npx]` value backed by measurement, and a decision on whether a narrow-width collapse step is needed.

- [ ] **Step 1: Measure the chip's natural width in every state**

With the dev app running and a channel selected on Jarvis, save this to the scratchpad directory (not `scripts/`) as `measure-chip.mjs` and run it. It drives the tier and mode clicks over CDP, so no manual clicking is involved:

```js
import { attach } from "C:/Users/kael02/IdeaProjects/waveterm/scripts/cdp/attach.mjs";

const c = await attach(9222);
const settle = (ms) => c.ev(`new Promise((r) => setTimeout(r, ${ms}))`);

// natural width = what the chip would be without the floor we are trying to pick
const read = () =>
    c.ev(`(() => {
        const chip = document.querySelector('[data-jarvis-autonomy="chip"]');
        if (!chip) return null;
        const box = chip.getBoundingClientRect();
        const prev = chip.style.minWidth;
        chip.style.minWidth = '0px';
        const nat = chip.getBoundingClientRect().width;
        chip.style.minWidth = prev;
        return {
            text: chip.innerText.replace(/\\n/g, ' ').trim(),
            box: Math.round(box.width),
            left: Math.round(box.left),
            natural: Math.ceil(nat),
        };
    })()`);

const openChip = () => c.ev(`(() => { document.querySelector('[data-jarvis-autonomy="chip"]').click(); return true; })()`);
const clickInPanel = (prefix) =>
    c.ev(`(() => {
        const p = document.querySelector('[data-jarvis-autonomy="panel"]');
        if (!p) return false;
        const b = [...p.querySelectorAll('button')].find((x) => (x.innerText || '').trim().startsWith(${JSON.stringify(prefix)}));
        if (!b) return false;
        b.click();
        return true;
    })()`);

const rows = [];
for (const tier of ["Concierge", "Gatekeeper", "Delegator"]) {
    await openChip();
    await settle(350);
    await clickInPanel(tier);
    await settle(1200); // SetChannelTier RPC + loadChannels refetch
    rows.push([tier, await read()]);
    // at Delegator, walk the three modes too — the mode word is part of the chip's widest state
    if (tier === "Delegator") {
        for (const m of ["report", "manage", "fanout"]) {
            await clickInPanel(m);
            await settle(1200);
            rows.push([`Delegator/${m}`, await read()]);
        }
    }
    await c.ev(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
    await settle(400);
}
for (const [name, r] of rows) console.log(name.padEnd(18), JSON.stringify(r));
console.log("max natural:", Math.max(...rows.map(([, r]) => r.natural)));
await c.close();
```

Expected: the maximum `natural` is one of the `Delegator/*` rows. `report`, `manage` and `fanout` are all six characters, so those three should agree within a pixel or two. Record the printed `max natural`.

Note this leaves the channel at Delegator with whichever mode ran last — set it back through the panel afterwards if the channel is one you care about. On a throwaway verification channel it does not matter.

- [ ] **Step 2: Set min-w to the measured maximum, rounded up**

Edit the class in `autonomyladderview.tsx`, replacing `min-w-[172px]` with the measured value (round **up** to the next even pixel), and update the comment to record the measurement rather than the estimate:

```tsx
                // min-w holds the widest state, measured over CDP at <N>px for "Delegator · fanout" and
                // rounded up: a chip that sizes to its tier would put back the shift this replaced.
                className={cn(
                    "flex min-w-[<N>px] cursor-pointer items-center gap-2 rounded-[7px] border bg-surface px-2.5 py-1 text-[11px] font-semibold",
```

- [ ] **Step 3: Verify the box no longer changes**

Re-run the script from Step 1 at Concierge, then at Delegator with each mode. Expected: `box` is identical in every state (the `natural` values will differ; only `box` matters), and `left` is identical too.

- [ ] **Step 4: Check the title's floor at three widths**

The header used to give up the rung labels at 820px and the dispatch strip at 640px of container width; both rules are gone. Confirm nothing else needs them. Add to the script:

```js
// The title span is found by its own classes rather than by position: the header row's container-query
// class ("@container") needs double escaping through querySelector and is not worth the fragility.
const atWidth = async (width) => {
    await c.cdp("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await c.ev("new Promise((r) => setTimeout(r, 350))");
    return c.ev(`(() => {
        const stage = document.querySelector('[data-jarvis-region="stage"]');
        const title = stage
            ? [...stage.querySelectorAll('span')].find(
                  (s) => s.className.includes('truncate') && s.className.includes('font-bold')
              )
            : null;
        const chip = document.querySelector('[data-jarvis-autonomy="chip"]');
        return {
            title: title ? Math.round(title.getBoundingClientRect().width) : null,
            titleText: title ? (title.innerText || '').trim() : null,
            chip: chip ? Math.round(chip.getBoundingClientRect().width) : null,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
    })()`);
};
for (const w of [1440, 1000, 860]) console.log(w, JSON.stringify(await atWidth(w)));
await c.cdp("Emulation.clearDeviceMetricsOverride");
```

Expected: `title` > 0 at all three widths, `titleText` non-empty (proof the span found is the subject's name and not some other truncating bold span), `chip` identical at all three, and `overflow` === 0.

- [ ] **Step 5: Decide on a collapse step — only if the measurement demands it**

If Step 4 shows `title` at its `10ch` floor (roughly 70px) or `overflow` > 0 at 860px, add exactly one collapse rule to the chip — the label yields, the glyph and chevron stay:

```tsx
                <span className="flex-1 whitespace-nowrap text-left @max-[560px]:hidden">{face.label}</span>
```

and add the same `@max-[560px]:hidden` to the mode span. The chip's `title` attribute already names the tier, so nothing becomes unreadable. **If Step 4 is clean at all three widths, add nothing** — the old rules existed because the group was 283-420px wide, and a 172px chip may simply never need them. Record which way it went in the task notes.

- [ ] **Step 6: Typecheck and format**

Run: `npx prettier --write frontend/app/view/jarvis/autonomyladderview.tsx` then `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

Expected: exit 0.

- [ ] **Step 7: Do not commit yet**

---

### Task 4: The CDP scenario, with the no-shift regression check

`scenarios.mjs:277` currently requires the body text to contain `AUTONOMY` *and* `CONCIERGE` *and* `DELEGATOR`. After Task 2 the header carries only the current tier, so this assertion is now wrong and must be replaced — and while it is being replaced, it should assert the thing that started this work: that the chip does not move.

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` — the `jarvis-fleet` scenario's `assert` body (currently lines ~269-292)

**Interfaces:**
- Consumes: `data-jarvis-autonomy="chip"` and `data-jarvis-autonomy="panel"` from Task 2; the harness's `h.ev`, `h.shot`, `h.rpc` from `scripts/cdp/attach.mjs`.
- Produces: an extended `jarvis-fleet` scenario. No new scenario name, so `task verify:ui -- jarvis-fleet` is unchanged.

- [ ] **Step 1: Replace the autonomy half of the assertion**

Hand-edit (4-space indent, no `prettier --write` on this file). Replace the `rendered` probe and its `steps.push` — that is, from the comment `// innerText reflects CSS text-transform…` through the closing `});` of the existing `steps.push` — with:

```js
        // The autonomy control is a fixed-width chip now, so the header carries only the current tier; the
        // three rungs live in its popover. Assert the chip, then open it and assert the ladder.
        const rendered = await h.ev(`(() => {
            const t = document.body.innerText || '';
            const chip = document.querySelector('[data-jarvis-autonomy="chip"]');
            return {
                chip: chip ? chip.innerText.replace(/\\n/g, ' ').trim() : null,
                panelClosed: document.querySelector('[data-jarvis-autonomy="panel"]') == null,
                roster: t.includes('No workers dispatched') && t.includes('working'),
                summarize: t.includes('Summarize the fleet'),
            };
        })()`);
        steps.push({
            step: `select the channel subject -> autonomy chip + Fleet roster + summary button render`,
            ok:
                selected === true &&
                /Concierge/.test(rendered.chip ?? "") &&
                rendered.panelClosed === true &&
                rendered.roster === true &&
                rendered.summarize === true,
            detail: `clicked=${selected} ${JSON.stringify(rendered)}`,
        });
```

A freshly created channel has neither `delegator:enabled` nor `gatekeeper:enabled` in its meta, so `tierFromMeta` floors it at `concierge` — hence `Concierge` in the chip.

- [ ] **Step 2: Add the open / ladder / no-shift / dismiss steps**

Immediately after the `steps.push` from Step 1 and **before** `await h.shot("cdp-shots/jarvis-fleet.png");`, insert:

```js
        // open the chip: the ladder, its blurbs and (at Delegator) the dispatch mode are all in the panel
        const opened = await h.ev(`(() => {
            const chip = document.querySelector('[data-jarvis-autonomy="chip"]');
            if (!chip) return null;
            chip.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 350))"); // PopoverReveal enter
        const panel = await h.ev(`(() => {
            const p = document.querySelector('[data-jarvis-autonomy="panel"]');
            if (!p) return null;
            const t = p.innerText || '';
            const upper = t.toUpperCase();
            return {
                caption: upper.includes('AUTONOMY'),
                rungs: t.includes('Concierge') && t.includes('Gatekeeper') && t.includes('Delegator'),
                blurb: t.includes('watches and narrates'),
                modesHidden: !t.includes('fanout'),
            };
        })()`);
        steps.push({
            step: `chip opens -> three rungs with blurbs, dispatch mode absent below Delegator`,
            ok:
                opened === true &&
                panel != null &&
                panel.caption === true &&
                panel.rungs === true &&
                panel.blurb === true &&
                panel.modesHidden === true,
            detail: JSON.stringify(panel),
        });
        await h.shot("cdp-shots/jarvis-fleet-autonomy.png");

        // The regression this control was rebuilt for: selecting Delegator used to grow the header group
        // ~140px and slide it left, out from under the cursor. The chip's left edge must not move.
        const beforeLeft = await h.ev(
            `Math.round(document.querySelector('[data-jarvis-autonomy="chip"]').getBoundingClientRect().left)`
        );
        const picked = await h.ev(`(() => {
            const p = document.querySelector('[data-jarvis-autonomy="panel"]');
            if (!p) return false;
            const row = [...p.querySelectorAll('button')].find((b) => (b.innerText || '').trim().startsWith('Delegator'));
            if (!row) return false;
            row.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 1200))"); // SetChannelTier RPC + loadChannels refetch
        const after = await h.ev(`(() => {
            const chip = document.querySelector('[data-jarvis-autonomy="chip"]');
            const p = document.querySelector('[data-jarvis-autonomy="panel"]');
            return {
                left: chip ? Math.round(chip.getBoundingClientRect().left) : null,
                width: chip ? Math.round(chip.getBoundingClientRect().width) : null,
                text: chip ? chip.innerText.replace(/\\n/g, ' ').trim() : null,
                stillOpen: p != null,
                modes: p ? /report/.test(p.innerText || '') && /fanout/.test(p.innerText || '') : false,
            };
        })()`);
        steps.push({
            step: `pick Delegator -> chip does not move, panel stays open, dispatch mode appears`,
            ok:
                picked === true &&
                after.left === beforeLeft &&
                /Delegator/.test(after.text ?? "") &&
                after.stillOpen === true &&
                after.modes === true,
            detail: `left ${beforeLeft} -> ${after.left} ${JSON.stringify(after)}`,
        });

        // Escape dismisses, as it does the profile drawer and the graph peek (floating-ui useDismiss).
        await h.ev(`(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 500))"); // PopoverReveal exit
        const dismissed = await h.ev(`document.querySelector('[data-jarvis-autonomy="panel"]') == null`);
        steps.push({ step: `Escape closes the autonomy panel`, ok: dismissed === true, detail: `panelGone=${dismissed}` });
```

The scenario's existing `teardown` deletes the channel and its temp dir, so writing `delegator` to it leaves no residue.

- [ ] **Step 3: Run the scenario**

With the dev app running:

```bash
task verify:ui -- jarvis-fleet
```

Expected: a PASS row for every step, exit 0, and a contact sheet at `cdp-shots/index.html`. The `left N -> N` detail on the no-shift step is the evidence this whole change is for — read it, do not just trust the PASS.

- [ ] **Step 4: If CDP refuses the connection**

`ECONNREFUSED :9222` mid-run usually means the dev app went away (another session's edit crashed it, or HMR tore it down), not that the harness is broken. Check the dev log for "going away", restart `tail -f /dev/null | task dev`, and re-run. If a `tail -f`-wrapped `task dev` has crashed, its `tail` half will not exit on its own — stop that background task explicitly before restarting.

- [ ] **Step 5: Do not commit yet**

---

### Task 5: Docs, then one commit

**Files:**
- Modify: `docs/jarvis-tab.md` §8 (lines ~342-355)
- Modify: `docs/jarvis-consolidation-open-issues.md` — JC12's entry (~line 428)
- Commit: everything from Tasks 1-5 plus the spec and this plan

- [ ] **Step 1: Rewrite §8 of `docs/jarvis-tab.md`**

Hand-edit (the file is dirty from in-flight work elsewhere in it). Keep the heading level and the behaviour table verbatim; replace the prose around it. The section currently reads "## 8. Autonomy ladder" with a paragraph about accumulating fill in the header. Replace the heading and that first paragraph with:

```markdown
## 8. Autonomy control

`autonomyladder.ts` + `autonomyladderview.tsx`. Channel only. A fixed-width chip in the Stage header names
the current tier (`▮▮▮ Delegator · fanout`), and opens a popover holding the ladder itself. The tiers are
three **nested** rungs, not alternatives — delegator implies gatekeeper implies concierge
(`pkg/jarvis/resolve.go`) — drawn as accumulating fill so they read as accumulation; three separate buttons
would misrepresent the backend. The chip's glyph is the current tier's rung fill at 3px, so the header
states the tier without opening anything.

The chip's box is identical at every tier and every mode. That is deliberate: the dispatch strip used to
render inline at Delegator only, which grew the control ~140px and slid the rungs out from under the cursor
that had just clicked one (JC12's cause). It is also what brings the control to the header's scale — 27px
tall, like the `Graph` button beside it.
```

Then, after the existing behaviour table, replace the dispatch-mode sentence with:

```markdown
The dispatch mode (`report` / `manage` / `fanout`) appears in the popover at Delegator only — below that
tier it has nothing to act on. Picking a tier or a mode leaves the panel open, since setting the mode is the
obvious next click after landing on Delegator; Escape, an outside click, or the chip closes it.
```

- [ ] **Step 2: Note JC12's cause as removed**

In `docs/jarvis-consolidation-open-issues.md`, append to the JC12 entry, after its **Verify.** line:

```markdown
**Superseded 2026-07-30.** The cause is gone, not mitigated: the dispatch strip no longer renders in the
header at all (`docs/superpowers/specs/2026-07-30-jarvis-autonomy-chip-design.md`). The autonomy control is
a fixed-width chip whose box cannot change with the tier, so the title has nothing to lose space to. The
`min-w-[10ch]` floor stays as belt-and-braces, and `jarvis-fleet` now asserts the chip's left edge is
identical before and after selecting Delegator.
```

- [ ] **Step 3: Full verification sweep before asking to commit**

Run all four, and read the output of each:

```bash
npx vitest run frontend/app/view/jarvis/autonomyladder.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx eslint frontend/app/view/jarvis/autonomyladderview.tsx frontend/app/view/jarvis/stageheader.tsx
task verify:ui -- jarvis-fleet
```

Expected: tests pass, tsc exit 0 with no output, eslint clean, every scenario step PASS. If anything fails, fix it before Step 4 — do not report partial success.

- [ ] **Step 4: Show the diff and ask for commit approval**

```bash
git status --short
git diff --stat
```

Confirm the changed set is exactly: `frontend/app/view/jarvis/autonomyladder.ts`, `autonomyladder.test.ts`, `autonomyladderview.tsx`, `stageheader.tsx`, `scripts/cdp/scenarios.mjs`, `docs/jarvis-tab.md`, `docs/jarvis-consolidation-open-issues.md`, plus the untracked spec and plan. The other in-flight files (`collapsiblerail.tsx`, `stagerail.tsx`, `profilepanel.tsx`, `jarvisstore.ts`, `stage.tsx`, `docs/jarvis-tour.md`) must still be modified-but-unstaged and untouched by this work.

Then **ask the user for explicit approval to commit.** Do not commit before they answer.

- [ ] **Step 5: Commit, once approved**

Stage only this change's files — never `git add -A`, since the tree holds another session's work:

```bash
git add frontend/app/view/jarvis/autonomyladder.ts \
        frontend/app/view/jarvis/autonomyladder.test.ts \
        frontend/app/view/jarvis/autonomyladderview.tsx \
        frontend/app/view/jarvis/stageheader.tsx \
        scripts/cdp/scenarios.mjs \
        docs/jarvis-tab.md \
        docs/jarvis-consolidation-open-issues.md \
        docs/superpowers/specs/2026-07-30-jarvis-autonomy-chip-design.md \
        docs/superpowers/plans/2026-07-30-jarvis-autonomy-chip.md
git commit -m "fix(jarvis): the autonomy control stops moving when you pick Delegator" \
           -m "The dispatch strip rendered inline at Delegator only, so selecting that tier grew the header group ~140px and slid all three rungs left, out from under the cursor that had just clicked one. The group was also 283x41 in a 43px band, against 53x27 for the Graph button beside it." \
           -m "It is now a fixed-width chip naming the current tier, opening a popover that holds the ladder, its blurbs as visible text, and the Delegator-only dispatch mode. The chip's box is identical at every tier and mode, so the shift is gone by construction. JC12's cause is removed with it."
```

Multiple `-m` flags rather than a here-string: this is Windows, and `@'…'@` inside the Bash tool breaks. No co-author line.

---

## Notes for the implementer

- **The dev app must be running for Tasks 2-4.** `tail -f /dev/null | task dev` — a bare headless `task dev` dies on stdin EOF. The CDP debug port is dev-only (`src-tauri/src/main.rs`, `#[cfg(debug_assertions)]`) and never ships.
- **`wavesrv.x64.exe` is both the dev and the packaged binary.** Never kill one without checking its `.Path` and asking first.
- **A blank page after editing a frontend module is HMR, not your code.** Full `location.reload()` over CDP, then re-verify.
- **`setChannelTier` is RPC-then-refetch with no optimistic update** (`channelsstore.ts:116`), which is why the CDP steps wait ~1.2s after clicking a tier. If a row's state seems not to change, wait longer before suspecting the code.

---

## Execution notes (2026-07-30)

What the measurements said, and where the implementation departed from the plan.

- **`min-w` is 164px, not the estimated 172.** Natural widths measured over CDP: Concierge 107, Gatekeeper 115, `Delegator · report|manage|fanout` 164 each. With the floor at 164 the chip's `box` is 164 and its `left` identical in all six states.
- **No collapse rule was added.** Task 3 Step 5's condition never triggered: at 1440 / 1000 / 860 the title held 99px (well above its ~70px floor), the chip stayed 164px and document overflow was 0. The old `@max-[820px]` / `@max-[640px]` rules existed because the group was 283-420px wide; a 164px chip does not need them.
- **The mode span is capped at a measured 52px** (`· report` / `· manage` / `· fanout` all render 51px). The floor equals the widest natural state exactly, so with no cap a non-canonical mode off channel meta — a free string — would grow the box and put the shift back. The cap makes the fixed-width invariant unconditional rather than dependent on every writer staying within six characters.
- **Escape needed a keybinding guard, which the plan did not anticipate.** `bindings.ts` `surface:back-home` binds Escape to "back to Cockpit" on every deep surface, and the dispatcher runs on **window capture** (`dispatcher.ts:99-107`, `stopImmediatePropagation` on a claim) — so floating-ui's document-level dismissal can never pre-empt it, and a press that dismissed the panel also ejected the user from Jarvis. Fixed the way the graph peek already does it: `autonomyPanelOpenAtom` (in `autonomyladder.ts`, since `jarvisstore.ts` is off-limits this cycle) is the panel's single source of open-state, and `surface:back-home` stands down while it is set. Reset on unmount, or leaving the surface with the panel open would hold Escape hostage everywhere. Covered by two cases in `bindings.test.ts`. This added `bindings.ts` + `bindings.test.ts` to the plan's file list, on the user's explicit decision.
- **The scenario's Escape step uses a real key event.** A dispatched `new KeyboardEvent('keydown', …)` never closes the panel — verified — so the plan's synthetic step would have asserted nothing. It now goes through `Input.dispatchKeyEvent`, asserts the surface is *still Jarvis* (the regression the guard prevents), and a second press asserts `surface:back-home` still works with the panel closed. The step focuses the chip first: picking a tier hands focus back to the composer, where Escape legitimately belongs to `jarvis:blur-composer`.
- **`jarvis-fleet.png` is still shot at the just-selected state**, with the panel getting its own `jarvis-fleet-autonomy.png`, rather than inserting the new steps ahead of the existing shot as Task 4 Step 2 said — that kept the existing artifact's meaning.
