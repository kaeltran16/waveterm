# Collapsible Rail + Cockpit Motion-Gap Closure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three divergent right-rails (Cockpit / Agent / Channels) with one reusable `CollapsibleRail` (icon-strip ↔ 300px scroll panel), which also fixes the titlebar/rail alignment bug by construction, and close the remaining Cockpit chrome motion gaps (rolling counts, section-header entrance, grid→footer handoff).

**Architecture:** A new content-agnostic primitive `frontend/app/element/collapsiblerail.tsx` takes a caller-owned `openAtom` + a list of `{icon,label,content}` sections; it owns width (44↔300), border (`border-border`), the Framer width-reveal animation, scroll, and jump-to-section. Each surface swaps its raw `<aside>` for a `CollapsibleRail` call, keeping its own content and persistence atom. Cockpit chrome motion reuses the existing `motiontokens.ts` (`MOTION`, `cardVariants`) and the surface's `<MotionConfig reducedMotion="user">`.

**Tech Stack:** React 19, Framer Motion (`motion/react` v12), jotai, Tailwind v4 (`@theme` tokens), FontAwesome via `makeIconClass`.

---

## Testing & commit conventions for this plan (read first)

- **No jsdom/render harness exists for the cockpit** (see `CLAUDE.md` → Visual verification). This is a presentational/motion change with no meaningful pure logic to unit-test, so per the project convention (and the `b3ccce07` cockpit-motion precedent) we **do not fabricate render tests**. The correctness gates each task are:
  1. **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0 (baseline is clean; any error is ours — do **not** use bare `npx tsc`, it stack-overflows on this repo).
  2. **Existing unit suite stays green:** `npx vitest run` → all pass.
  3. **Visual (CDP):** `node scripts/cdp-shot.mjs <out.png>` against the running `task dev` (port 9222), described per task. Inject fixtures with `node scripts/inject-live-agents.mjs <scenario>` where a populated cockpit is needed.
- **Commits:** Per the repo owner's git workflow, **do not commit per task.** All work lands as **one feature commit at the very end (Task 14), gated on explicit approval**, folding in this plan + its spec. This intentionally overrides the skill's per-task-commit convention.
- Run `task dev` (or `tail -f /dev/null | task dev` when headless — stdin EOF otherwise kills wavesrv) before the CDP steps; leave it running across tasks.

---

## Phase 1 — The reusable component

### Task 1: Create `CollapsibleRail`

**Files:**
- Create: `frontend/app/element/collapsiblerail.tsx`

- [ ] **Step 1: Write the component**

```tsx
// frontend/app/element/collapsiblerail.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Reusable right-rail: a thin always-visible icon strip that expands to a 300px scroll panel.
// Content-agnostic — callers pass a list of {icon,label,content} sections and a caller-owned
// openAtom (so each surface keeps its own persistence/default). Owns width, border, the width-
// reveal animation, scroll, and jump-to-section. Collapsed icons double as jump-to-section anchors.
// See docs/superpowers/specs/2026-07-03-collapsible-rail-and-cockpit-motion-gaps-design.md.

import { MotionConfig, motion } from "motion/react";
import { useAtom, type PrimitiveAtom } from "jotai";
import { useCallback, useRef, type ReactNode } from "react";
import { MOTION } from "./motiontokens";
import { Tooltip } from "./tooltip";

export interface RailSection {
    id: string;
    icon: ReactNode; // rendered in the collapsed strip (e.g. <i className={makeIconClass("gauge", true)} />)
    label: string; // tooltip when collapsed; callers keep their own in-content headings
    content: ReactNode;
}

const RAIL_EXPANDED_PX = 300; // matches the app-bar usage column (app-bar.tsx:66) → continuous divider
const RAIL_COLLAPSED_PX = 44;

export function CollapsibleRail({
    openAtom,
    sections,
    footer,
    ariaLabel,
}: {
    openAtom: PrimitiveAtom<boolean>;
    sections: RailSection[];
    footer?: ReactNode;
    ariaLabel?: string;
}) {
    const [open, setOpen] = useAtom(openAtom);
    const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

    const openTo = useCallback(
        (id: string) => {
            setOpen(true);
            // let the expand lay out one frame before scrolling the target into view
            requestAnimationFrame(() => sectionRefs.current[id]?.scrollIntoView({ block: "start" }));
        },
        [setOpen]
    );

    return (
        <MotionConfig reducedMotion="user">
            <motion.aside
                aria-label={ariaLabel}
                initial={false}
                animate={{ width: open ? RAIL_EXPANDED_PX : RAIL_COLLAPSED_PX }}
                transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                className="flex h-full shrink-0 flex-col overflow-hidden border-l border-border bg-surface"
            >
                {open ? (
                    <>
                        <div className="flex shrink-0 items-center justify-end px-2 pt-2">
                            <button
                                type="button"
                                onClick={() => setOpen(false)}
                                aria-label="Collapse panel"
                                title="Collapse"
                                className="cursor-pointer rounded-[7px] px-2 py-1 text-[14px] leading-none text-muted hover:bg-surface-hover hover:text-secondary"
                            >
                                ›
                            </button>
                        </div>
                        <div className="flex min-h-0 flex-1 flex-col gap-[24px] overflow-y-auto px-[18px] pb-[40px] pt-[8px]">
                            {sections.map((s) => (
                                <div
                                    key={s.id}
                                    ref={(el) => {
                                        sectionRefs.current[s.id] = el;
                                    }}
                                >
                                    {s.content}
                                </div>
                            ))}
                        </div>
                        {footer ? <div className="shrink-0 border-t border-border px-[18px] py-3">{footer}</div> : null}
                    </>
                ) : (
                    <div className="flex flex-col items-center gap-1.5 pt-3">
                        {sections.map((s) => (
                            <Tooltip key={s.id} content={s.label} placement="left">
                                <button
                                    type="button"
                                    onClick={() => openTo(s.id)}
                                    aria-label={s.label}
                                    className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[8px] text-[14px] text-muted hover:bg-surface-hover hover:text-secondary"
                                >
                                    {s.icon}
                                </button>
                            </Tooltip>
                        ))}
                    </div>
                )}
            </motion.aside>
        </MotionConfig>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (the new file compiles; it has no consumers yet).

---

## Phase 2 — Cockpit rail migration

### Task 2: Swap the Cockpit `<aside>` for `CollapsibleRail`

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (imports; the `aside` at ~804-888; the header "Hide panel" button at ~611-618)

- [ ] **Step 1: Add imports**

At the top of `cockpitsurface.tsx`, add the component + icon helper imports (keep existing imports):

```tsx
import { CollapsibleRail, type RailSection } from "@/app/element/collapsiblerail";
import { makeIconClass } from "@/util/util";
```

`makeIconClass` may already be reachable via the existing `import { cn, fireAndForget } from "@/util/util"` line — extend that line instead of adding a second import:

```tsx
import { cn, fireAndForget, makeIconClass } from "@/util/util";
```

- [ ] **Step 2: Remove the header "Hide panel" toggle button**

Delete this block (currently ~611-618) — the strip is now the affordance:

```tsx
<button
    type="button"
    onClick={() => globalStore.set(model.railOpenAtom, !railOpen)}
    className="cursor-pointer rounded-[8px] border border-edge-mid px-2.5 py-1.5 text-[12px] text-muted hover:border-edge-strong"
>
    {railOpen ? "Hide panel ›" : "‹ Usage"}
</button>
```

- [ ] **Step 3: Replace the `<aside>` with `CollapsibleRail`**

Replace the entire `{railOpen ? (<aside …>…</aside>) : null}` block (~804-888) with a `sections` array + a `CollapsibleRail`. The two inner blocks (the Usage `<div>` and the Recent-activity `<div>`) move verbatim into the two sections' `content` — keep their existing headers ("Usage" + "Details →", "Recent activity" + "View all →"). Result:

```tsx
<CollapsibleRail
    openAtom={model.railOpenAtom}
    ariaLabel="Usage and recent activity"
    sections={[
        {
            id: "usage",
            label: "Usage",
            icon: <i className={makeIconClass("gauge", true)} />,
            content: (
                <div>
                    {/* ---- MOVE the existing Usage <div> (was 806-850) here verbatim ---- */}
                </div>
            ),
        },
        ...(recent.length > 0
            ? [
                  {
                      id: "activity",
                      label: "Recent activity",
                      icon: <i className={makeIconClass("clock-rotate-left", true)} />,
                      content: (
                          <div>
                              {/* ---- MOVE the existing Recent-activity <div> (was 851-886) here verbatim ---- */}
                          </div>
                      ),
                  } as RailSection,
              ]
            : []),
    ]}
/>
```

Notes for the mover:
- The old outer `<aside className="flex w-[300px] … px-5 py-5">` wrapper is deleted; its two child `<div>`s become the two section `content`s. Do not re-wrap them in another `aside`.
- The Recent-activity block was already conditional (`recent.length > 0`); preserve that by spreading it into the array only when non-empty (shown above). The Usage block always shows.
- `railOpen` is still read elsewhere? It is only used by the removed button and the old `aside` guard — after this task the `const railOpen = useAtomValue(model.railOpenAtom)` line becomes unused; remove it to keep tsc clean (the component reads the atom itself).

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Visual (CDP)**

With `task dev` running and a populated cockpit (`node scripts/inject-live-agents.mjs busy`):
Run: `node scripts/cdp-shot.mjs scratchpad/rail-cockpit-collapsed.png` — expect a thin icon strip (gauge, clock) on the right edge.
Then expand it (click the gauge icon via CDP `Input.dispatchMouseEvent`, or set the atom), re-shoot `rail-cockpit-expanded.png` — expect the 300px Usage + Recent panel with a `›` collapse control, and the left border continuous with the app-bar usage-column divider.

---

## Phase 3 — Agent rail migration + alignment/text fixes

### Task 3: Convert `AgentDetailsRail` to `CollapsibleRail` and fix the idle text

**Files:**
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx` (imports; the `running` line at :82; the `<aside>` at :86-231)

- [ ] **Step 1: Add imports**

```tsx
import { CollapsibleRail, type RailSection } from "@/app/element/collapsiblerail";
import { railStateAtom, loadRailForAgent, railVisibleAtom } from "./railstore";
import { makeIconClass } from "@/util/util";
```

`railVisibleAtom` is currently **not** imported here (the surface owns the `d`-key toggle); add it to the existing `./railstore` import. `makeIconClass` — add to the existing `@/util/util` import line (`import { cn, fireAndForget, stringToBase64, makeIconClass } from "@/util/util";`).

- [ ] **Step 2: Fix the "just now idle" text (line 82)**

Replace:

```tsx
const running = agent.state === "idle" ? `${formatAge(undefined)} idle` : formatAge(agent.activeMs);
```

with (mirrors `idlesection.tsx:46` — `${formatAge(a.activeMs)} idle`, so idle shows e.g. "3m idle" not the nonsensical "just now idle"):

```tsx
const running = agent.state === "idle" ? `${formatAge(agent.activeMs)} idle` : formatAge(agent.activeMs);
```

- [ ] **Step 3: Replace the `<aside>` return with `CollapsibleRail`**

The current `return (<aside className="…w-[296px]…border-[#1a1f26]…">…</aside>)` becomes a conditional `sections` array (each existing block is one section's `content`, minus its outer `<div>` wrapper where the wrapper only provided vertical spacing — the component supplies `gap-[24px]`), plus the Resume/Stop buttons as `footer`. Build it just before `return`:

```tsx
const sections: RailSection[] = [
    {
        id: "details",
        label: "Details",
        icon: <i className={makeIconClass("circle-info", true)} />,
        content: (
            <div>
                <div className="mb-[13px]">
                    <SectionLabel>Details</SectionLabel>
                </div>
                <div className="flex flex-col">
                    {/* ---- the seven <DetailRow> lines (was 93-107) verbatim ---- */}
                </div>
            </div>
        ),
    },
    ...(ctxPct != null
        ? [
              {
                  id: "context",
                  label: "Context window",
                  icon: <i className={makeIconClass("chart-simple", true)} />,
                  content: (
                      <div>
                          {/* ---- the Context-window block (was 112-123) verbatim ---- */}
                      </div>
                  ),
              } as RailSection,
          ]
        : []),
    ...(subs.length > 0
        ? [
              {
                  id: "subagents",
                  label: "Subagents",
                  icon: <i className={makeIconClass("diagram-project", true)} />,
                  content: <div>{/* ---- the Subagents block (was 127-163) verbatim ---- */}</div>,
              } as RailSection,
          ]
        : []),
    ...(tools.length > 0
        ? [
              {
                  id: "tools",
                  label: "Tools used",
                  icon: <i className={makeIconClass("wrench", true)} />,
                  content: <div>{/* ---- the Tools-used block (was 167-181) verbatim ---- */}</div>,
              } as RailSection,
          ]
        : []),
    {
        id: "files",
        label: "Files touched",
        icon: <i className={makeIconClass("file-lines", true)} />,
        content: <div>{/* ---- the Files-touched block (was 185-208) verbatim ---- */}</div>,
    },
];

return (
    <CollapsibleRail
        openAtom={railVisibleAtom}
        ariaLabel="Agent details"
        sections={sections}
        footer={
            <div className="flex gap-[8px]">
                {/* ---- the Resume + Stop buttons (was 211-228) verbatim ---- */}
            </div>
        }
    />
);
```

Notes for the mover:
- Delete the outer `<aside …w-[296px]…border-[#1a1f26]…>` — the width (296→300) and hardcoded-hex border are gone by construction (the component uses `w-300` + `border-border`), which is the "interception" fix.
- The footer wrapper was `<div className="mt-[4px] flex gap-[8px]">`; drop the `mt-[4px]` (the component's footer has its own `py-3` + top border), keep `flex gap-[8px]`.
- The `d`-key toggle in `agentsurface.tsx` already flips `railVisibleAtom`; no change needed there. The rail already only renders when `railVisible` is true today — but now the component renders the *strip* when the atom is false. **Update `agentsurface.tsx` (Task 4) so the rail is always mounted** (the strip must show even when "closed").

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

### Task 4: Always-mount the Agent rail so the strip is visible

**Files:**
- Modify: `frontend/app/view/agents/agentsurface.tsx:146-148`

- [ ] **Step 1: Change the rail render guard**

Today (line 146-148) the rail only mounts when `railVisible` is true:

```tsx
{railVisible && !fullscreen && agent.kind !== "terminal" ? (
    <AgentDetailsRail model={model} agent={agent} />
) : null}
```

`railVisible` now means "expanded" (the component shows the strip when false), so the rail should mount whenever it's not fullscreen and the focused item is a real agent, regardless of `railVisible`:

```tsx
{!fullscreen && agent.kind !== "terminal" ? <AgentDetailsRail model={model} agent={agent} /> : null}
```

Leave the `const railVisible = useAtomValue(railVisibleAtom);` line even if now unused only if tsc complains — otherwise remove it (the `d`-key binding writes the atom via `globalStore`, it does not need the value here). Verify tsc after.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Visual (CDP)**

With `task dev` running, switch to the Agent surface (set `model.surfaceAtom` to `"agent"` or press the nav key). Shoot `scratchpad/rail-agent.png`:
- Collapsed: strip with circle-info / chart-simple / diagram-project / wrench / file-lines icons (only the present ones).
- Press `d` (or set `railVisibleAtom`), re-shoot: 300px panel; **the left border is now continuous with the app-bar usage-column divider — no 4px jog, no color change** (the "interception" fix). Confirm the Running row reads e.g. "3m idle", not "just now idle".

---

## Phase 4 — Channels rail migration

### Task 5: Add a persisted open-atom for the Channels rail

**Files:**
- Modify: `frontend/app/view/agents/railstore.ts`

- [ ] **Step 1: Add the atom**

The top comment currently scopes the file to the agent details-rail; broaden it and add the channels atom (reuse the already-imported `atomWithStorage`):

```tsx
// Cockpit rail state: the agent details-rail toggle + the channels context-rail toggle (both global,
// persisted) plus a thin git load for the agent rail. …(keep the rest of the existing comment)…

// Agent details-rail expanded state (localStorage "agent.rail.visible", default collapsed).
export const railVisibleAtom = atomWithStorage("agent.rail.visible", false);

// Channels context-rail expanded state (localStorage "channel.rail.open", default collapsed so narrow
// panes keep maximum message width; replaces the old @[1320px] container-query auto-show).
export const channelRailOpenAtom = atomWithStorage("channel.rail.open", false);
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

### Task 6: Convert Channels `ContextPanel` to `CollapsibleRail`

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (imports; `ContextPanel` at ~774-849)

- [ ] **Step 1: Add imports**

```tsx
import { CollapsibleRail, type RailSection } from "@/app/element/collapsiblerail";
import { channelRailOpenAtom } from "./railstore";
import { makeIconClass } from "@/util/util";
```

`makeIconClass` — extend the existing `@/util/util` import line (`import { cn, fireAndForget, makeIconClass } from "@/util/util";`).

- [ ] **Step 2: Replace `ContextPanel`'s `<aside>` return with `CollapsibleRail`**

Inside `ContextPanel`, keep all the computed values (`snapshot`, `asking`, `counts`, `tier`, `explainer`, `label`) and replace the `return (<aside …>…</aside>)` (~790-847) with sections built from the existing blocks. The current `<aside className="hidden w-[300px] … border-l border-border bg-background … @[1320px]:flex">` is deleted — the `@[1320px]` auto-hide is intentionally dropped, and the component standardizes the background on `bg-surface`:

```tsx
const sections: RailSection[] = [
    {
        id: "jarvis",
        label: `Autonomy in #${channel?.name ?? "channel"}`,
        icon: <i className={makeIconClass("diamond", true)} />,
        content: (
            <div>
                {/* ---- the Jarvis header block (was 791-800) + the Autonomy block (was 802-817) verbatim ---- */}
            </div>
        ),
    },
    {
        id: "fleet",
        label: "Fleet here",
        icon: <i className={makeIconClass("users", true)} />,
        content: (
            <div>
                {/* ---- the "Fleet here" label + snapshot list (was 819-826) verbatim ---- */}
            </div>
        ),
    },
    ...(asking.length > 0
        ? [
              {
                  id: "needs-you",
                  label: `Needs you · ${asking.length}`,
                  icon: <i className={makeIconClass("bell", true)} />,
                  content: <div>{/* ---- the "Needs you" block (was 828-843) verbatim ---- */}</div>,
              } as RailSection,
          ]
        : []),
    {
        id: "project",
        label: "Project",
        icon: <i className={makeIconClass("folder", true)} />,
        content: (
            <div>
                {/* ---- the "Project" label + path (was 845-846) verbatim ---- */}
            </div>
        ),
    },
];

return <CollapsibleRail openAtom={channelRailOpenAtom} ariaLabel="Channel context" sections={sections} />;
```

Notes for the mover:
- The blocks currently use `mb-*` spacing between sections; the component supplies `gap-[24px]`, so the trailing `mb-4`/`mb-5` on the moved blocks are harmless but may be trimmed for cleanliness. Do not delete the small internal margins within a block.
- `ContextPanel` is rendered at `channelssurface.tsx:1038` — no change there; it still receives `model/channel/agents`.
- The `@container` class on the parent `<div>` (line 930) was only there for the rail's container query; leave it (harmless) to minimize churn.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Visual (CDP)**

Switch to the Channels surface. Shoot `scratchpad/rail-channels.png`: collapsed strip (diamond, users, bell?, folder). Expand: 300px panel with the Jarvis/Autonomy/Fleet/Project sections, `bg-surface`, border continuous with the titlebar divider.

---

## Phase 5 — Cockpit motion-gap closure

### Task 7: Animate `RollingCount`

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (imports; `RollingCount` at ~53-55; the "N need you" span at ~706)

- [ ] **Step 1: Extend the motion import + add `MOTION`**

The file already has `import { AnimatePresence, MotionConfig, Reorder } from "motion/react";` — add `motion`:

```tsx
import { AnimatePresence, MotionConfig, Reorder, motion } from "motion/react";
import { MOTION } from "@/app/element/motiontokens";
```

- [ ] **Step 2: Replace `RollingCount` with an animated version**

```tsx
// A count that slide-swaps its digits when the value changes (moment: a count ticking is a state
// change worth making legible). Under reduced motion, MotionConfig drops the y transform → crossfade.
function RollingCount({ value, className }: { value: number; className?: string }) {
    return (
        <span className={cn("relative inline-flex justify-center overflow-hidden tabular-nums", className)}>
            <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                    key={value}
                    initial={{ y: "-70%", opacity: 0 }}
                    animate={{ y: "0%", opacity: 1 }}
                    exit={{ y: "70%", opacity: 0 }}
                    transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                    className="inline-block"
                >
                    {value}
                </motion.span>
            </AnimatePresence>
        </span>
    );
}
```

- [ ] **Step 3: Route "N need you" through `RollingCount`**

At ~706 the live header currently hard-cuts the count:

```tsx
<span className="font-semibold text-warning">{liveAsking} need you</span>
```

Replace with:

```tsx
<span className="font-semibold text-warning">
    <RollingCount value={liveAsking} /> need you
</span>
```

(The filter-chip counts at ~665 already use `RollingCount` and now animate automatically.)

- [ ] **Step 4: Typecheck + Visual**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
CDP: with a populated cockpit, change a filter or flip an agent asking→working (via `inject-live-agents.mjs`) and confirm the All/Asking/Working/Idle counts and "N need you" slide-swap rather than hard-cut. Enable `prefers-reduced-motion` (CDP `Emulation.setEmulatedMedia`) → the swap becomes an instant crossfade (no vertical motion).

### Task 8: Animate the "Live agents" section header + empty state

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (the empty-state block ~678-693; the "Live agents" header block ~695-712)

- [ ] **Step 1: Wrap the empty state**

Wrap the existing `{empty ? (<div …>🤖 … + New agent</div>) : null}` so its appear/disappear eases. Replace `{empty ? (…) : null}` with:

```tsx
<AnimatePresence initial={false}>
    {empty ? (
        <motion.div
            key="empty"
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="flex flex-1 flex-col items-center justify-center gap-2 p-[18px] text-center"
        >
            {/* ---- the existing empty-state children (🤖, "No active agents", blurb, + New agent) ---- */}
        </motion.div>
    ) : null}
</AnimatePresence>
```

(Import `cardVariants` — extend the motiontokens import: `import { MOTION, cardVariants } from "@/app/element/motiontokens";`.)

- [ ] **Step 2: Wrap the "Live agents" header**

Replace `{liveCount > 0 ? (<div className="shrink-0 px-5 pt-4"><SectionHeader …/></div>) : null}` with:

```tsx
<AnimatePresence initial={false}>
    {liveCount > 0 ? (
        <motion.div
            key="live-header"
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="shrink-0 px-5 pt-4"
        >
            <SectionHeader
                label="Live agents"
                /* ---- keep all existing SectionHeader props verbatim ---- */
            />
        </motion.div>
    ) : null}
</AnimatePresence>
```

- [ ] **Step 3: Typecheck + Visual**

tsc → exit 0. CDP: start with an empty roster (`inject-live-agents.mjs empty`), then inject one live agent — the empty state should ease out and the "Live agents" header ease in (opacity+scale, no cascade on a pre-populated mount because `initial={false}`).

### Task 9: Animate card arrival into the Backgrounded footer

**Files:**
- Modify: `frontend/app/view/agents/backgroundedsection.tsx`

- [ ] **Step 1: Wrap the item list in `AnimatePresence`**

Add imports and wrap the `agents.map` so a card arriving into this footer eases in (completing moment 2's grid→footer handoff). Replace the `{open ? (<div className="flex flex-col gap-1">{agents.map(...)}</div>) : null}` body:

```tsx
import { AnimatePresence, motion } from "motion/react";
import { cardVariants } from "@/app/element/motiontokens";
```

```tsx
{open ? (
    <div className="flex flex-col gap-1">
        <AnimatePresence initial={false}>
            {agents.map((a) => (
                <motion.div
                    key={a.id}
                    layout
                    variants={cardVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    onClick={() => onRestore(a.id)}
                    title="Restore to working"
                    className="flex cursor-pointer items-center gap-2.5 rounded-[6px] px-2 py-1.5 hover:bg-white/[0.04]"
                >
                    {/* ---- the existing row children (dot, name, task, age) verbatim ---- */}
                </motion.div>
            ))}
        </AnimatePresence>
    </div>
) : null}
```

(The outer row `<div>` becomes the `motion.div`; move its `onClick`/`title`/`className` onto the `motion.div` as shown.)

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.

### Task 10: Animate card arrival into the Idle footer

**Files:**
- Modify: `frontend/app/view/agents/idlesection.tsx`

- [ ] **Step 1: Wrap the item list in `AnimatePresence`**

```tsx
import { AnimatePresence, motion } from "motion/react";
import { cardVariants } from "@/app/element/motiontokens";
```

Replace the `{open ? (<div className="flex flex-col gap-1">{agents.map((a) => { … return (<div key={a.id} className="flex flex-col rounded-[6px] hover:bg-white/[0.04]">…</div>); })}</div>) : null}` so each row is a `motion.div` inside `AnimatePresence`:

```tsx
{open ? (
    <div className="flex flex-col gap-1">
        <AnimatePresence initial={false}>
            {agents.map((a) => {
                const project = projectOf(a);
                return (
                    <motion.div
                        key={a.id}
                        layout
                        variants={cardVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="flex flex-col rounded-[6px] hover:bg-white/[0.04]"
                    >
                        {/* ---- the existing inner content (the clickable row + <AgentComposer/>) verbatim ---- */}
                    </motion.div>
                );
            })}
        </AnimatePresence>
    </div>
) : null}
```

- [ ] **Step 2: Typecheck + Visual (both footers)**

tsc → exit 0. CDP: with a couple of working agents, background one (`b`) and let one go idle; expand the Backgrounded and Idle footers — arriving rows ease in (opacity+scale) and surviving rows reflow (`layout`) rather than jumping. Confirm no cascade when opening a footer that already has several rows (`initial={false}`).

---

## Phase 6 — Verify, document, commit

### Task 11: Full typecheck + unit suite

- [ ] **Step 1: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 2: Unit tests**

Run: `npx vitest run`
Expected: all pass (no tests were changed; this confirms no import/token regressions). Note the current baseline count in the run output.

### Task 12: Consolidated CDP visual pass

- [ ] **Step 1: Walk every changed surface**

With `task dev` running (`tail -f /dev/null | task dev` if headless) and `inject-live-agents.mjs busy`, capture and eyeball:
- Cockpit rail: strip ↔ expand, jump-to-section (click the clock icon → expands scrolled to Recent activity), border continuity with the titlebar divider.
- Agent rail: strip ↔ expand, **no divider jog/color-change** (the interception fix), "N idle" text correct.
- Channels rail: strip ↔ expand, `bg-surface`, sections present.
- Rolling counts slide-swap on a roster change.
- "Live agents" header + empty-state entrance.
- Backgrounded/Idle footer arrival entrances.
- `prefers-reduced-motion` on (CDP `Emulation.setEmulatedMedia [{name:'prefers-reduced-motion',value:'reduce'}]`): all of the above degrade to instant; no entrance cascade when opening a populated cockpit/tab.

- [ ] **Step 2: Record any deferrals**

If the content-swap during the rail width animation reads abruptly (expanded content rendering in the 44px box before it grows), note it as a follow-up (candidate: crossfade the two content modes) rather than blocking — the reveal itself is the functional signal. Log to `docs/deferred.md` if one exists, else note in the tracker.

### Task 13: Update the animation revamp tracker

**Files:**
- Modify: `docs/superpowers/animation-revamp-tracker.md`

- [ ] **Step 1: Add `CollapsibleRail` to the shared-foundation table**

In the "Shared foundation" table, add a row:

```markdown
| `frontend/app/element/collapsiblerail.tsx` | Reusable right-rail (icon strip ↔ 300px scroll panel) shared by Cockpit/Agent/Channels; owns the rail-reveal moment + fixes titlebar/rail divider alignment by construction. |
```

- [ ] **Step 2: Annotate the surface rows**

Update the Cockpit note to record the chrome-gap closure, and add a note to the Agent and Channels rows that their **rails** now use the shared component (the full narration/message motion for those surfaces remains a later pass). Example edits:

```markdown
| **Cockpit** | ✅ Shipped `b3ccce07`; chrome gaps + shared rail `<pending SHA>` (2026-07-03) | 8 card moments + rolling counts, section-header entrance, grid→footer handoff, CollapsibleRail. |
| Agent | ◐ Rail only | DETAILS rail now `CollapsibleRail` (alignment fixed). Remaining: narration/composer/status motion (m5/m6/m7). |
| Channels | ◐ Rail only | Context rail now `CollapsibleRail`. Remaining: message entrance (m1/m5), rail selection micro (m7). |
```

(Replace `<pending SHA>` with the real commit SHA after Task 14.)

### Task 14: Single feature commit (gated on approval)

- [ ] **Step 1: Self-review the diff**

Run: `git status` and `git --no-pager diff` — confirm only the intended files changed (the new component, the four surface files, the two footer files, `railstore.ts`, and the two docs), no commented-out code, no debug logging, no stray hex colors reintroduced.

- [ ] **Step 2: Present for approval**

Show the file list (M/A) + change summary and the proposed message, then ask: "Awaiting approval. Proceed? (yes/no)". Proposed message:

```
feat(cockpit): reusable CollapsibleRail + close cockpit motion gaps

Unify the Cockpit/Agent/Channels right-rails behind one collapsible
icon-strip↔panel component (fixes the titlebar/rail divider misalignment
by construction) and close the remaining cockpit chrome motion gaps
(rolling counts, section-header entrance, grid→footer handoff).
```

- [ ] **Step 3: Commit only after explicit "yes"**

Stage exactly the changed files (the mover lists them from Step 1) and commit with the approved message. Do **not** add a co-author. Then backfill the real SHA into the tracker (Task 13, Step 2) — that doc edit rides in the same commit, so amend or include it in the staged set before committing.

---

## Self-review (author's pass against the spec)

- **Spec coverage:** CollapsibleRail component (Task 1) ✓; Cockpit rail (Task 2) ✓; Agent rail + 296→300/border + "just now idle" (Tasks 3-4) ✓; Channels rail + new atom + drop @1320 auto-hide + bg-surface (Tasks 5-6) ✓; rolling counts (Task 7) ✓; section-header/empty entrance (Task 8) ✓; grid→footer handoff (Tasks 9-10) ✓; reduced-motion self-wrap (Task 1 `MotionConfig`) ✓; no-cascade `initial={false}` (Tasks 8-10) ✓; tracker update (Task 13) ✓.
- **Open questions resolved:** Channels background → `bg-surface` (component-owned, Task 6); Agent strip icons → 1:1 (Task 3); count style → slide-swap (Task 7).
- **Type consistency:** `RailSection`/`CollapsibleRail` signature defined in Task 1 and used identically in Tasks 2/3/6; `openAtom` is `PrimitiveAtom<boolean>` and all three callers pass one (`model.railOpenAtom` is `atom(true)` ✓, `railVisibleAtom`/`channelRailOpenAtom` are `atomWithStorage` ✓); `MOTION`/`cardVariants` imported from `@/app/element/motiontokens` consistently.
- **Placeholder scan:** the `{/* MOVE … verbatim */}` markers are deliberate move-instructions for existing JSX (repeating ~60 lines of unchanged markup inline would obscure the change); every one names the exact source line range. No `TBD`/`add error handling`/undefined symbols.
```
