# Channels Surface Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Channels surface functional motion — message entrance without a switch/mount cascade, seamless streaming, an attention glow on the escalation card, and rail selection micro + attention pulse — all reusing the existing motion system.

**Architecture:** One new pure, unit-tested helper (`channelsmotion.ts`) decides which message ids animate (silent on channel switch / first mount, only true arrivals fade). `channelssurface.tsx` wraps rows in a shared `motion.div` + `cardVariants` under `<MotionConfig reducedMotion="user">`, and adds a one-shot `settle` on reply completion + a `breatheGlow` on the unresolved escalation card. `channelrail.tsx` gets CSS-only selection micro + `pulseDot` on the attention dot. No store, token, or keyframe changes.

**Tech Stack:** React 19, `motion/react` (Framer v12), Tailwind 4, jotai, vitest.

## Global Constraints

- **Import all motion values from `frontend/app/element/motiontokens.ts`** — never inline a duration/ease/keyframe. `cardVariants` and `MOTION` only.
- **CSS keyframes already exist** in `frontend/tailwindsetup.css` (`pulseDot`, `breatheGlow`, `settle`) — reference via arbitrary utilities exactly as `agentrow.tsx` does; do not add keyframes.
- **Every CSS loop carries `motion-reduce:animate-none`**; Framer motion is wrapped in `<MotionConfig reducedMotion="user">`.
- **No entrance cascade** on mount or channel switch (the `channelsmotion.ts` guard is the mechanism; `AnimatePresence initial={false}` is the second belt).
- **`layout` only on the row wrapper (a container), never on streaming-text nodes.** Animate opacity/scale/transform only — never x/y (`cardVariants` guarantees this).
- **Typecheck command (repo gotcha — `npx tsc` stack-overflows):** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0).
- **Git:** per repo workflow, do NOT commit per-task. Tasks end at verification. A single commit at the end (Task 6) requires explicit user approval.
- **No jsdom render harness for the cockpit** (per `CLAUDE.md`): component tasks are verified by typecheck + visual CDP screenshot (`node scripts/inject-live-agents.mjs <scenario>` then `node scripts/cdp-shot.mjs out.png`), not vitest. Only `channelsmotion.ts` has a unit test.

Reference spec: `docs/superpowers/specs/2026-07-04-channels-motion-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/app/view/agents/channelsmotion.ts` | **new.** Pure no-cascade entrance guard: `EntranceState`, `initialEntranceState()`, `computeEntrances()`. |
| `frontend/app/view/agents/channelsmotion.test.ts` | **new.** Unit test for `computeEntrances`. |
| `frontend/app/view/agents/channelssurface.tsx` | **modify.** `MotionConfig` wrap; `AnimatePresence` + per-row `motion.div`; wire the guard; `useSettle` hook + m4 on `ConsultRow`/`JarvisRow`; m3 `breatheGlow` on `EscalationRow`. |
| `frontend/app/view/agents/channelrail.tsx` | **modify.** m7 `transition-colors` on the channel button; `pulseDot` on the attention dot. |
| `docs/superpowers/animation-revamp-tracker.md` | **modify.** Flip Channels row to ✅. |

---

## Task 1: No-cascade entrance guard (`channelsmotion.ts`)

**Files:**
- Create: `frontend/app/view/agents/channelsmotion.ts`
- Test: `frontend/app/view/agents/channelsmotion.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface EntranceState { channelId: string | undefined; seen: Set<string> }`
  - `function initialEntranceState(): EntranceState`
  - `function computeEntrances(prev: EntranceState, channelId: string | undefined, messageIds: string[]): { animate: Set<string>; state: EntranceState }`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/channelsmotion.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { computeEntrances, initialEntranceState } from "./channelsmotion";

describe("computeEntrances", () => {
    test("first mount animates nothing and seeds seen", () => {
        const r = computeEntrances(initialEntranceState(), "c1", ["a", "b"]);
        expect([...r.animate]).toEqual([]);
        expect([...r.state.seen].sort()).toEqual(["a", "b"]);
        expect(r.state.channelId).toBe("c1");
    });

    test("switching channels animates nothing and reseeds", () => {
        const first = computeEntrances(initialEntranceState(), "c1", ["a", "b"]);
        const r = computeEntrances(first.state, "c2", ["x", "y"]);
        expect([...r.animate]).toEqual([]);
        expect([...r.state.seen].sort()).toEqual(["x", "y"]);
        expect(r.state.channelId).toBe("c2");
    });

    test("same-channel append animates only the new ids", () => {
        const first = computeEntrances(initialEntranceState(), "c1", ["a", "b"]);
        const r = computeEntrances(first.state, "c1", ["a", "b", "c"]);
        expect([...r.animate]).toEqual(["c"]);
        expect([...r.state.seen].sort()).toEqual(["a", "b", "c"]);
    });

    test("re-render with no new ids animates nothing", () => {
        const first = computeEntrances(initialEntranceState(), "c1", ["a", "b"]);
        const r = computeEntrances(first.state, "c1", ["a", "b"]);
        expect([...r.animate]).toEqual([]);
    });

    test("a removed id does not error and stays remembered", () => {
        const first = computeEntrances(initialEntranceState(), "c1", ["a", "b"]);
        const r = computeEntrances(first.state, "c1", ["a"]);
        expect([...r.animate]).toEqual([]);
        expect(r.state.seen.has("a")).toBe(true);
        expect(r.state.seen.has("b")).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/channelsmotion.test.ts`
Expected: FAIL — cannot resolve `./channelsmotion` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `frontend/app/view/agents/channelsmotion.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// No-cascade entrance guard for the Channels message stream. Switching channels swaps the entire
// message set, so a naive AnimatePresence would fire a full-list cascade. This tracks which message
// ids have already been seen for the active channel; only ids that arrive while a channel is settled
// animate. Channel switch and first mount present everything silently. Pure — the component holds the
// returned state in a ref. See docs/superpowers/specs/2026-07-04-channels-motion-design.md.

export interface EntranceState {
    channelId: string | undefined;
    seen: Set<string>;
}

export function initialEntranceState(): EntranceState {
    return { channelId: undefined, seen: new Set() };
}

export function computeEntrances(
    prev: EntranceState,
    channelId: string | undefined,
    messageIds: string[]
): { animate: Set<string>; state: EntranceState } {
    if (channelId !== prev.channelId) {
        // channel switch or first mount: present the existing set with no entrance
        return { animate: new Set(), state: { channelId, seen: new Set(messageIds) } };
    }
    const animate = new Set<string>();
    const seen = new Set(prev.seen);
    for (const id of messageIds) {
        if (!seen.has(id)) {
            animate.add(id);
            seen.add(id);
        }
    }
    return { animate, state: { channelId, seen } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/channelsmotion.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no new errors.

---

## Task 2: Message entrance + no-cascade wiring (`channelssurface.tsx`)

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx`

**Interfaces:**
- Consumes: `computeEntrances`, `initialEntranceState` (Task 1); `cardVariants` from `@/app/element/motiontokens`.
- Produces: nothing consumed by later tasks (Tasks 3–5 edit sibling regions of the same file / `channelrail.tsx`).

- [ ] **Step 1: Add imports**

At the top of `frontend/app/view/agents/channelssurface.tsx`, add these imports (place near the existing `motiontokens`-less imports; group with the other `@/app` imports):

```tsx
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { cardVariants } from "@/app/element/motiontokens";
import { computeEntrances, initialEntranceState } from "./channelsmotion";
```

(`useRef` and `useLayoutEffect` are already imported from `react` at line 17.)

- [ ] **Step 2: Hoist the filtered message list and wire the guard**

Inside `ChannelsSurface`, the current code reads (around line 915):

```tsx
    const roster: RosterEntry[] = agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId }));
    const messages = active?.messages ?? [];
```

Replace with (adds the filtered list, ids, and the entrance guard):

```tsx
    const roster: RosterEntry[] = agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId }));
    const messages = active?.messages ?? [];
    // replies are folded into their parent rows, so they never appear as standalone stream items
    const shownMessages = messages.filter((m) => m.kind !== "consult-reply" && m.kind !== "jarvis-reply");
    const messageIds = shownMessages.map((m) => m.id);
    // no-cascade guard: switch/mount is silent, only true arrivals animate (see channelsmotion.ts)
    const entranceRef = useRef(initialEntranceState());
    const { animate: entranceIds } = computeEntrances(entranceRef.current, activeId, messageIds);
    const idsKey = messageIds.join(",");
    useLayoutEffect(() => {
        entranceRef.current = computeEntrances(entranceRef.current, activeId, messageIds).state;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeId, idsKey]);
```

- [ ] **Step 3: Wrap the message list in `AnimatePresence` + per-row `motion.div`**

The current stream branch (around lines 1030–1058) maps `messages.filter(...)`. Replace the entire final `) : (` … `)` branch of that ternary (the one after the `messages.length === 0` check) with:

```tsx
                        ) : (
                            <AnimatePresence mode="popLayout" initial={false}>
                                {shownMessages.map((m) => (
                                    <motion.div
                                        key={m.id}
                                        layout
                                        variants={cardVariants}
                                        initial={entranceIds.has(m.id) ? "initial" : false}
                                        animate="animate"
                                    >
                                        {m.kind === "consult" ? (
                                            <ConsultRow
                                                msg={m}
                                                allMessages={messages}
                                                streams={consultStreams}
                                                now={now}
                                            />
                                        ) : m.kind === "jarvis" ? (
                                            <JarvisRow
                                                msg={m}
                                                allMessages={messages}
                                                streams={consultStreams}
                                                now={now}
                                            />
                                        ) : m.kind === "jarvis-answered" ? (
                                            <GatekeeperRow model={model} agents={agents} msg={m} now={now} />
                                        ) : m.kind === "jarvis-escalation" ? (
                                            <EscalationRow agents={agents} msg={m} now={now} />
                                        ) : (
                                            <MessageRow model={model} agents={agents} msg={m} now={now} />
                                        )}
                                    </motion.div>
                                ))}
                            </AnimatePresence>
                        )}
```

The `key` moves to the `motion.div` wrapper; the inner row components no longer take `key`. The surrounding `<div className="flex flex-col gap-5">` container is unchanged and remains the flex parent (the `motion.div` wrappers are its children, so `gap-5` still spaces rows). No `exit` variant: messages are never removed, so `popLayout` only ever does entrance + `layout` reflow.

- [ ] **Step 4: Wrap the returned tree in `MotionConfig`**

The function currently returns `( <div className="absolute inset-0 flex"> … </div> );` (line 956 opening, line 1080 closing). Wrap that outer div:

```tsx
    return (
        <MotionConfig reducedMotion="user">
            <div className="absolute inset-0 flex">
                {/* …existing rail + stream + ContextPanel unchanged… */}
            </div>
        </MotionConfig>
    );
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no new errors.

- [ ] **Step 6: Visual verify (live dev app via CDP)**

With `task dev` running:
1. `node scripts/inject-live-agents.mjs <a scenario that populates a channel with messages>` (see the script header for scenario names).
2. `node scripts/cdp-shot.mjs channels-baseline.png` — confirm the populated stream renders.
3. Send a new message in the active channel → confirm the **single new row** fades/scales in and **existing rows do not**.
4. Switch to another channel and back → confirm the populated stream appears **with no cascade** (no staggered entrances).
5. Toggle OS "reduce motion" → confirm entrances degrade to opacity-only (no scale pop).

Expected: new-arrival fade only; silent switch/mount; reduced-motion honored.

---

## Task 3: Escalation attention glow — m3 (`channelssurface.tsx`)

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`EscalationRow`)

**Interfaces:**
- Consumes: existing `cn` import (line 14); the component's existing `picked` state.
- Produces: nothing.

- [ ] **Step 1: Add the glow while the card is unresolved**

In `EscalationRow`, the amber card container currently reads (line ~432):

```tsx
                <div className="rounded-[9px] border border-asking/40 bg-lane-asking px-3.5 py-3">
```

Replace with (breathe while `picked == null`, calm once answered; matches `agentrow.tsx`'s asking-card treatment):

```tsx
                <div
                    className={cn(
                        "rounded-[9px] border border-asking/40 bg-lane-asking px-3.5 py-3",
                        picked == null && "animate-[breatheGlow_2.4s_ease-in-out_infinite] motion-reduce:animate-none"
                    )}
                >
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Visual verify**

Inject a scenario with a `jarvis-escalation` message. Screenshot: the escalation card breathes (soft amber pulse) while unanswered; after picking an option the glow stops and the resolved footer shows. Under reduced motion the glow is off (static amber). `GatekeeperRow` ("answered for you") must NOT glow.

---

## Task 4: Reply completion settle — m4 (`channelssurface.tsx`)

> Spec flags m4 as the first thing to cut if it reads fussy in the live app. Implement it; if Step 3 looks busy, revert this task's edits — Tasks 1–3, 5 stand alone.

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`ConsultRow`, `JarvisRow`, + one new local hook)

**Interfaces:**
- Consumes: existing `useState`, `useEffect`, `useRef` imports (line 17); `cn` (line 14).
- Produces: a file-local `useSettle(done: boolean): boolean` hook (not exported).

- [ ] **Step 1: Add the `useSettle` hook**

Add this above the `ConsultRow` component (e.g. right after the `timeLabel` helper, ~line 90):

```tsx
// one-shot completion settle (moment 4): plays @keyframes settle once when a streaming reply resolves
// (streaming -> done). Mirrors agentrow.tsx's justFinished pattern (520ms matches settle's .5s).
function useSettle(done: boolean): boolean {
    const [settling, setSettling] = useState(false);
    const prevDone = useRef(done);
    useEffect(() => {
        if (done && !prevDone.current) {
            setSettling(true);
            const t = setTimeout(() => setSettling(false), 520);
            prevDone.current = done;
            return () => clearTimeout(t);
        }
        prevDone.current = done;
    }, [done]);
    return settling;
}
```

- [ ] **Step 2: Settle the ConsultRow replies container on completion**

In `ConsultRow`, after `liveKeys` is computed (line ~222) and before the `return`, add:

```tsx
    // the consult is "done" once every live stream has resolved into a persisted reply
    const settling = useSettle(liveKeys.length === 0 && replies.length > 0);
```

Then the replies/live container (line ~233) currently reads:

```tsx
                <div className="flex flex-col gap-2">
```

Replace with:

```tsx
                <div
                    className={cn(
                        "flex flex-col gap-2",
                        settling && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
                    )}
                >
```

- [ ] **Step 3: Settle the JarvisRow reply block on completion**

In `JarvisRow`, after `live` is computed (line ~277), add:

```tsx
    const settling = useSettle(!!reply);
```

Then the persisted-reply block (line ~289) currently reads:

```tsx
                    <div className="rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-2.5">
```

Replace with:

```tsx
                    <div
                        className={cn(
                            "rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-2.5",
                            settling && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
                        )}
                    >
```

(The streaming/`live` branch is unchanged — only the completed reply settles.)

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Visual verify**

Inject a scenario with an in-flight `consult` and a `jarvis` query. Watch a reply stream, then land: the block gives a single soft scale settle exactly once on completion (no re-settle as later consult replies arrive; no settle while streaming). Under reduced motion, no settle. If this reads busy against the m1 entrance, revert Task 4.

---

## Task 5: Rail selection micro + attention pulse — m7 (`channelrail.tsx`)

**Files:**
- Modify: `frontend/app/view/agents/channelrail.tsx`

**Interfaces:**
- Consumes: existing `cn` import (line 8).
- Produces: nothing.

- [ ] **Step 1: Ease the active-channel highlight**

The channel button `className` (lines ~66–69) currently reads:

```tsx
                                className={cn(
                                    "flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left",
                                    active ? "bg-accentbg" : "hover:bg-surface-hover"
                                )}
```

Replace with (adds a `durMicro` = 140ms color transition to the static classes):

```tsx
                                className={cn(
                                    "flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition-colors duration-[140ms]",
                                    active ? "bg-accentbg" : "hover:bg-surface-hover"
                                )}
```

- [ ] **Step 2: Pulse the attention dot**

The attention dot (lines ~92–97) currently reads:

```tsx
                                {channelHasAsk(c, agents) ? (
                                    <span
                                        title="an agent here needs you"
                                        className="h-2 w-2 flex-none rounded-full bg-asking"
                                    />
                                ) : null}
```

Replace the `className` with the unified 1.6s status pulse:

```tsx
                                {channelHasAsk(c, agents) ? (
                                    <span
                                        title="an agent here needs you"
                                        className="h-2 w-2 flex-none rounded-full bg-asking animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none"
                                    />
                                ) : null}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Visual verify**

In the live app: click between channels → the active highlight (bg + `#` + label color) eases in over ~140ms instead of snapping. A channel with a waiting agent shows a pulsing attention dot. Under reduced motion the dot is static and selection still swaps (color transition is a harmless micro).

---

## Task 6: Tracker update + commit (requires approval)

**Files:**
- Modify: `docs/superpowers/animation-revamp-tracker.md`

- [ ] **Step 1: Flip the Channels row to shipped**

In the Surface rollout table, change the **Channels** row from:

```
| Channels | ◐ Rail only | Context rail now `CollapsibleRail`. Remaining: message entrance (m1/m5), rail selection micro (m7). |
```

to (fill in `<SHA>` after the commit):

```
| Channels | ✅ Shipped (2026-07-04) | Message entrance + no-cascade guard (`channelsmotion.ts`), streaming settle, escalation glow, rail selection micro + attention-dot pulse. |
```

Also bump the `Last updated:` line to `2026-07-04` and add the spec/plan paths under References.

- [ ] **Step 2: Full verification before commit**

Run both, confirm clean:
- `npx vitest run frontend/app/view/agents/channelsmotion.test.ts` → PASS
- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0

- [ ] **Step 3: Show the diff and request approval**

Present the file list (status + summary) and the proposed commit message, then ask for approval per the repo git workflow. Do NOT commit before approval.

Proposed commit message:

```
feat(channels): message entrance, streaming settle, attention motion

Map the Channels surface onto the shared motion vocabulary: m1 message
entrance gated by a per-channel no-cascade guard so switching channels
stays silent, m4 settle on reply completion, m3 breatheGlow on the
unresolved escalation card, and m7 rail selection micro + attention-dot
pulse. Reuses motiontokens + existing keyframes; no store/token changes.
```

---

## Self-Review

**Spec coverage:**
- m1 message entrance → Task 2 ✓
- no-cascade guard (`computeEntrances`) → Task 1 (+ wired in Task 2) ✓
- m5 streaming (text in place, seamless swap) → preserved by Task 2 (no per-token anim; blocks ride row entrance) ✓
- m4 completion settle → Task 4 ✓ (optional, per spec)
- m3 escalation glow → Task 3 ✓
- m7 rail attention pulse → Task 5 ✓
- m7 rail selection micro → Task 5 ✓
- m2 reflow on card grow → Task 2 (`layout` on wrapper) ✓
- Reduced motion → `MotionConfig` (Task 2) + `motion-reduce:animate-none` on every CSS loop (Tasks 3,4,5) ✓
- Tests → Task 1 (unit) + visual verify steps ✓
- Tracker update → Task 6 ✓

**Type consistency:** `computeEntrances` / `initialEntranceState` / `EntranceState` used identically in Tasks 1 and 2. `useSettle(done: boolean): boolean` defined and consumed within Task 4. `cardVariants` (not `MOTION`) is the only motiontokens import needed in Task 2.

**Placeholder scan:** none — every code step shows complete code; the only `<...>` are the commit SHA (filled post-commit) and the injector scenario name (chosen at verify time from the script header).
