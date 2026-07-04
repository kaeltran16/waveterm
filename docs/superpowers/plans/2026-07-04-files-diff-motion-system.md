# Files / Diff motion system — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Files/Diff surface (Browse + Review modes) onto the shared cockpit motion layer, reusing the existing 8-moment vocabulary with no new keyframes, durations, or eases.

**Architecture:** Extract the Channels no-cascade guard into the shared `motiontokens.ts` so Files (and, later, Activity) reuse it. Add a tiny `filesmotion.ts` for the source→guard-key derivation and a shared `useSettle` hook in `motionhooks.ts`. Then wire Framer motion into `filessurface.tsx` (Browse: file-list entrance/exit/reflow + diff-pane crossfade) and `reviewsurface.tsx` (Review: hunk/file settle, progress-bar transition, hunk-pane crossfade, applied-screen reveal). One `<MotionConfig reducedMotion="user">` at the `FilesSurface` root covers both modes.

**Tech Stack:** React 19, `motion/react` (Framer v12), jotai, Tailwind 4, vitest. CSS ambient keyframes live in `tailwindsetup.css`.

## Global Constraints

- **Import motion values from `frontend/app/element/motiontokens.ts`** — never inline a duration/ease/keyframe. No new vocabulary for this surface.
- **Animate transform/opacity only; `layout` only on container elements** — never on diff/hunk text nodes (perf). No per-line diff animation.
- **Reduced motion is mandatory.** Framer via `<MotionConfig reducedMotion="user">`; CSS loops/one-shots carry `motion-reduce:animate-none`.
- **No entrance cascade.** `AnimatePresence` uses `initial={false}` at list level; per-row `initial` is gated by the no-cascade guard so only post-mount arrivals animate.
- **Typecheck runs as** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (plain `npx tsc` stack-overflows on this repo). Baseline is clean (exit 0).
- **Never hand-edit generated files.** No Go/wshrpc types are touched here.
- **Git (user rule, STRICT):** NEVER commit or push without explicit approval. Conventional commits (`type(scope): description`). Do not add a co-author. The final step of each task **stages** changes and **requests** approval with the proposed message; the executor does not commit unilaterally.
- **No render harness for the cockpit.** Wiring tasks are verified by (a) typecheck exit 0, (b) `npx vitest run` green, and (c) live-app visual checks over CDP (`node scripts/cdp-shot.mjs`), injecting a populated worktree if needed.

---

### Task 1: Extract the no-cascade guard + CSS ease token into `motiontokens.ts`

**Files:**
- Modify: `frontend/app/element/motiontokens.ts`
- Test: `frontend/app/element/motiontokens.test.ts`
- Modify: `frontend/app/view/agents/channelsmotion.ts`
- Modify: `frontend/app/view/agents/channelsmotion.test.ts:12,20`

**Interfaces:**
- Produces:
  - `interface EntranceState { key: string | undefined; seen: Set<string>; }`
  - `function initialEntranceState(): EntranceState`
  - `function computeEntrances(prev: EntranceState, key: string | undefined, ids: string[]): { animate: Set<string>; state: EntranceState }`
  - `const easeFluidCss: string` — `"cubic-bezier(0.22, 1, 0.36, 1)"`, derived from `MOTION.easeFluid`.
- Consumes: `MOTION.easeFluid` (existing).

- [ ] **Step 1: Write the failing tests** — the file already exists and uses vitest's `it` (not `test`). Extend the existing import from `./motiontokens` (line 5) to add the three new symbols:

```ts
import { MOTION, cardVariants, computeEntrances, easeFluidCss, initialEntranceState, modalBackdrop, modalPanel, shouldFadeEntry } from "./motiontokens";
```

Then append these two `describe` blocks (use `it`, matching the file's convention — do **not** re-import `MOTION`):

```ts
describe("easeFluidCss", () => {
    it("is the css cubic-bezier form of MOTION.easeFluid", () => {
        expect(easeFluidCss).toBe(`cubic-bezier(${MOTION.easeFluid.join(", ")})`);
        expect(easeFluidCss).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    });
});

describe("computeEntrances", () => {
    it("first mount animates nothing and seeds seen", () => {
        const r = computeEntrances(initialEntranceState(), "k1", ["a", "b"]);
        expect([...r.animate]).toEqual([]);
        expect([...r.state.seen].sort()).toEqual(["a", "b"]);
        expect(r.state.key).toBe("k1");
    });

    it("switching key animates nothing and reseeds", () => {
        const first = computeEntrances(initialEntranceState(), "k1", ["a", "b"]);
        const r = computeEntrances(first.state, "k2", ["x", "y"]);
        expect([...r.animate]).toEqual([]);
        expect([...r.state.seen].sort()).toEqual(["x", "y"]);
        expect(r.state.key).toBe("k2");
    });

    it("same-key append animates only the new ids", () => {
        const first = computeEntrances(initialEntranceState(), "k1", ["a", "b"]);
        const r = computeEntrances(first.state, "k1", ["a", "b", "c"]);
        expect([...r.animate]).toEqual(["c"]);
        expect([...r.state.seen].sort()).toEqual(["a", "b", "c"]);
    });

    it("undefined key (no source) seeds silently", () => {
        const r = computeEntrances(initialEntranceState(), undefined, []);
        expect([...r.animate]).toEqual([]);
        expect(r.state.key).toBeUndefined();
    });

    it("a removed id does not error and stays remembered", () => {
        const first = computeEntrances(initialEntranceState(), "k1", ["a", "b"]);
        const r = computeEntrances(first.state, "k1", ["a"]);
        expect([...r.animate]).toEqual([]);
        expect(r.state.seen.has("b")).toBe(true);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/element/motiontokens.test.ts`
Expected: FAIL — `computeEntrances`/`easeFluidCss`/`initialEntranceState` not exported from `./motiontokens`.

- [ ] **Step 3: Implement in `motiontokens.ts`** — append after the existing `shouldFadeEntry`:

```ts
// CSS-transition form of easeFluid (Framer wants the array; CSS `transition:` wants the string).
export const easeFluidCss = `cubic-bezier(${MOTION.easeFluid.join(", ")})`;

// No-cascade entrance guard (shared by Channels, Files, and future list surfaces). Switching the
// active `key` (channel / files source / …) reseeds silently so a whole-list swap never cascades;
// only ids that arrive while the key is unchanged animate in. Pure — callers hold the returned
// state in a ref. See docs/superpowers/specs/2026-07-04-files-diff-motion-design.md.
export interface EntranceState {
    key: string | undefined;
    seen: Set<string>;
}

export function initialEntranceState(): EntranceState {
    return { key: undefined, seen: new Set() };
}

export function computeEntrances(
    prev: EntranceState,
    key: string | undefined,
    ids: string[]
): { animate: Set<string>; state: EntranceState } {
    if (key !== prev.key) {
        return { animate: new Set(), state: { key, seen: new Set(ids) } };
    }
    const animate = new Set<string>();
    const seen = new Set(prev.seen);
    for (const id of ids) {
        if (!seen.has(id)) {
            animate.add(id);
            seen.add(id);
        }
    }
    return { animate, state: { key, seen } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/element/motiontokens.test.ts`
Expected: PASS (all describes green).

- [ ] **Step 5: Refactor `channelsmotion.ts` to re-export the shared guard** — replace its entire body (the `EntranceState`/`initialEntranceState`/`computeEntrances` definitions) with a re-export, keeping the header comment:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Channels message stream reuses the shared no-cascade entrance guard. Kept as a thin re-export
// so channelssurface.tsx's import path is unchanged. See motiontokens.ts for the implementation and
// docs/superpowers/specs/2026-07-04-channels-motion-design.md for the original rationale.
export { computeEntrances, initialEntranceState, type EntranceState } from "@/app/element/motiontokens";
```

- [ ] **Step 6: Update the two renamed-field assertions in `channelsmotion.test.ts`**

Line 12: `expect(r.state.channelId).toBe("c1");` → `expect(r.state.key).toBe("c1");`
Line 20: `expect(r.state.channelId).toBe("c2");` → `expect(r.state.key).toBe("c2");`

- [ ] **Step 7: Run the full guard + channels regression suite**

Run: `npx vitest run frontend/app/element/motiontokens.test.ts frontend/app/view/agents/channelsmotion.test.ts`
Expected: PASS (both files green — the channels re-export behaves identically).

- [ ] **Step 8: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline; `channelssurface.tsx` still compiles against the unchanged import path).

- [ ] **Step 9: Stage + request commit approval**

```bash
git add frontend/app/element/motiontokens.ts frontend/app/element/motiontokens.test.ts \
        frontend/app/view/agents/channelsmotion.ts frontend/app/view/agents/channelsmotion.test.ts
```
Proposed message: `refactor(motion): extract no-cascade guard + css ease token to motiontokens`
Await explicit approval before committing.

---

### Task 2: `filesmotion.ts` — source → guard-key derivation

**Files:**
- Create: `frontend/app/view/agents/filesmotion.ts`
- Test: `frontend/app/view/agents/filesmotion.test.ts`
- Modify: `frontend/app/view/agents/filessurface.tsx:36` (export the `FilesSource` type)

**Interfaces:**
- Consumes: `FilesSource` (type) from `./filessurface`.
- Produces: `function sourceKey(source: FilesSource | null): string | undefined` → `agent:<id>` / `project:<name>` / `undefined`.

- [ ] **Step 1: Export the `FilesSource` type** — in `frontend/app/view/agents/filessurface.tsx`, change the declaration at line 36 from:

```ts
type FilesSource = { kind: "agent"; id: string } | { kind: "project"; name: string };
```
to:
```ts
export type FilesSource = { kind: "agent"; id: string } | { kind: "project"; name: string };
```

- [ ] **Step 2: Write the failing test** — create `frontend/app/view/agents/filesmotion.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { sourceKey } from "./filesmotion";

describe("sourceKey", () => {
    test("agent source → agent:<id>", () => {
        expect(sourceKey({ kind: "agent", id: "abc" })).toBe("agent:abc");
    });
    test("project source → project:<name>", () => {
        expect(sourceKey({ kind: "project", name: "waveterm" })).toBe("project:waveterm");
    });
    test("null source → undefined", () => {
        expect(sourceKey(null)).toBeUndefined();
    });
    test("agent and project with the same string do not collide", () => {
        expect(sourceKey({ kind: "agent", id: "x" })).not.toBe(sourceKey({ kind: "project", name: "x" }));
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/filesmotion.test.ts`
Expected: FAIL — cannot find module `./filesmotion`.

- [ ] **Step 4: Implement `filesmotion.ts`** — create `frontend/app/view/agents/filesmotion.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Files-surface motion helper: derives the stable guard-key for the no-cascade entrance guard
// (motiontokens.computeEntrances). The key changes iff the viewed worktree source changes, so
// switching source reseeds the file list silently while live git updates within a source animate.
import type { FilesSource } from "./filessurface";

export function sourceKey(source: FilesSource | null): string | undefined {
    if (!source) {
        return undefined;
    }
    return source.kind === "agent" ? `agent:${source.id}` : `project:${source.name}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/filesmotion.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 7: Stage + request commit approval**

```bash
git add frontend/app/view/agents/filesmotion.ts frontend/app/view/agents/filesmotion.test.ts \
        frontend/app/view/agents/filessurface.tsx
```
Proposed message: `feat(files): add source→guard-key derivation for list motion`
Await explicit approval before committing.

---

### Task 3: Shared `useSettle` hook in `motionhooks.ts`

**Files:**
- Create: `frontend/app/element/motionhooks.ts`
- Test: `frontend/app/element/motionhooks.test.ts`

**Interfaces:**
- Produces: `function useSettle(done: boolean): boolean` — returns `true` for ~520ms after `done` flips `false→true` (one-shot), then `false`. Mirrors the local `useSettle` in `channelssurface.tsx:96`. (Channels' local copy is left as-is; this is the canonical version for new code — a future cleanup can dedupe channels/agentrow onto it.)

- [ ] **Step 1: Write the failing test** — create `frontend/app/element/motionhooks.test.ts` (uses `@testing-library/react`'s `renderHook`, already a dev dep used elsewhere; if unavailable, this step falls back to the manual note below):

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useSettle } from "./motionhooks";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useSettle", () => {
    test("stays false until done flips false→true", () => {
        const { result, rerender } = renderHook(({ d }) => useSettle(d), { initialProps: { d: false } });
        expect(result.current).toBe(false);
        rerender({ d: false });
        expect(result.current).toBe(false);
    });

    test("returns true for one shot on false→true, then clears", () => {
        const { result, rerender } = renderHook(({ d }) => useSettle(d), { initialProps: { d: false } });
        act(() => rerender({ d: true }));
        expect(result.current).toBe(true);
        act(() => vi.advanceTimersByTime(520));
        expect(result.current).toBe(false);
    });

    test("does not re-fire while done stays true", () => {
        const { result, rerender } = renderHook(({ d }) => useSettle(d), { initialProps: { d: true } });
        // mounting already-done must not settle (only a transition does)
        expect(result.current).toBe(false);
        act(() => rerender({ d: true }));
        expect(result.current).toBe(false);
    });
});
```

> Verify `@testing-library/react` is importable (`ls node_modules/@testing-library/react`). It is used by existing component tests. If it is genuinely absent, keep the test file but reduce it to a documented-skip with `test.skip` and record that `useSettle` is covered by the Task 4 CDP visual check instead — do **not** invent a different harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/element/motionhooks.test.ts`
Expected: FAIL — cannot find module `./motionhooks`.

- [ ] **Step 3: Implement `motionhooks.ts`** — create `frontend/app/element/motionhooks.ts` (lifted verbatim from `channelssurface.tsx:96-109`, the 520ms window matches `@keyframes settle`'s 0.5s):

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";

// Completion settle (moment 4): returns true for one ~520ms shot when `done` flips false→true, so a
// caller can play `@keyframes settle` once. Mounting already-done does not fire (only a transition does).
export function useSettle(done: boolean): boolean {
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/element/motionhooks.test.ts`
Expected: PASS (or documented `test.skip` per Step 1 note).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Stage + request commit approval**

```bash
git add frontend/app/element/motionhooks.ts frontend/app/element/motionhooks.test.ts
```
Proposed message: `feat(motion): add shared useSettle hook`
Await explicit approval before committing.

---

### Task 4: Browse-mode motion in `filessurface.tsx`

**Files:**
- Modify: `frontend/app/view/agents/filessurface.tsx`

**Interfaces:**
- Consumes: `MOTION`, `cardVariants`, `computeEntrances`, `initialEntranceState`, `EntranceState` from `@/app/element/motiontokens`; `sourceKey` from `./filesmotion`; `AnimatePresence`, `MotionConfig`, `motion` from `motion/react`; `useRef` from `react`.

- [ ] **Step 1: Add imports** — at the top of `filessurface.tsx`:

```ts
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { MOTION, cardVariants, computeEntrances, initialEntranceState, type EntranceState } from "@/app/element/motiontokens";
import { sourceKey } from "./filesmotion";
```
Add `useRef` to the existing `react` import (currently `import { useEffect, useState } from "react";`) → `import { useEffect, useRef, useState } from "react";`.

- [ ] **Step 2: Add the no-cascade guard in `FilesSurface`** — after `source` is computed (around line 231), add:

```ts
    const filePaths = state?.changes?.files.map((f) => f.path) ?? [];
    const guardKey = sourceKey(source);
    const entranceRef = useRef<EntranceState>(initialEntranceState());
    const { animate: entranceIds } = computeEntrances(entranceRef.current, guardKey, filePaths);
    useEffect(() => {
        entranceRef.current = computeEntrances(entranceRef.current, guardKey, filePaths).state;
    }, [guardKey, filePaths.join(" ")]);
```

- [ ] **Step 3: Animate the file list** — replace the `changes!.files.map(...)` block (lines 300-309) with an `AnimatePresence` wrapper:

```tsx
                        <AnimatePresence mode="popLayout" initial={false}>
                            {changes!.files.map((c) => (
                                <motion.div
                                    key={c.path}
                                    layout
                                    variants={cardVariants}
                                    initial={entranceIds.has(c.path) ? "initial" : false}
                                    animate="animate"
                                    exit="exit"
                                >
                                    <FileRow
                                        change={c}
                                        selected={c.path === selected}
                                        onSelect={() => state.cwd && fireAndForget(() => selectFile(state.cwd!, c.path))}
                                    />
                                </motion.div>
                            ))}
                        </AnimatePresence>
```

- [ ] **Step 4: FileRow selection micro** — in `FileRow` (line 136-139), add a token-length color transition to the button className. Change:

```tsx
            className={cn(
                "flex w-full items-center gap-[7px] rounded-[7px] px-[8px] py-[5px] text-left hover:bg-surface-hover",
                selected && "bg-surface-selected"
            )}
```
to:
```tsx
            className={cn(
                "flex w-full items-center gap-[7px] rounded-[7px] px-[8px] py-[5px] text-left transition-colors duration-[140ms] hover:bg-surface-hover",
                selected && "bg-surface-selected"
            )}
```

- [ ] **Step 5: Diff-pane crossfade** — wrap `CenterPane`'s returned tree in a keyed `motion.div` so switching `path` fades the new content in. Replace the `CenterPane` body (lines 168-207) so both the empty state and the loaded diff share one keyed wrapper:

```tsx
function CenterPane({ path, view, cwd }: { path: string | null; view: FileView | null; cwd: string | null }) {
    return (
        <motion.div
            key={path ?? "__empty__"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
            className="flex min-w-0 flex-1 flex-col"
        >
            {!path ? (
                <EmptyCenter msg="Select a file to view its changes" />
            ) : (
                <>
                    <div className="flex flex-none items-center gap-[11px] border-b border-border px-[20px] py-[13px]">
                        <span className="min-w-0 truncate font-mono text-[13px] font-semibold">{path}</span>
                        <div className="flex-1" />
                        <span className="flex-none font-mono text-[11px] text-ink-mid">Read-only</span>
                        {cwd && (
                            <button
                                onClick={() => getApi().openExternal(`${cwd}/${path}`)}
                                className="flex-none rounded-[8px] border border-border px-[11px] py-[6px] text-[12px] text-ink-mid hover:text-foreground"
                            >
                                Open in editor ↗
                            </button>
                        )}
                    </div>
                    {view == null ? (
                        <EmptyCenter msg="Loading…" />
                    ) : (
                        <>
                            {view.isDiff && (
                                <div className="flex flex-none items-center gap-[14px] border-b border-edge-faint px-[20px] py-[8px] font-mono text-[11px] font-bold">
                                    <span className="text-success">+{view.adds}</span>
                                    <span className="text-error">−{view.dels}</span>
                                    <span className="font-medium text-ink-mid">{view.hunkLabel}</span>
                                </div>
                            )}
                            <div className="flex-1 overflow-auto py-[8px] font-mono text-[12.5px] leading-[1.75]">
                                {view.lines.map((l, i) => (
                                    <DiffRow key={i} line={l} />
                                ))}
                            </div>
                        </>
                    )}
                </>
            )}
        </motion.div>
    );
}
```

- [ ] **Step 6: Wrap the surface in `MotionConfig`** — the `FilesSurface` return (line 261) currently opens with `<div className="absolute inset-0 flex min-h-0">`. Wrap that whole returned element:

```tsx
    return (
        <MotionConfig reducedMotion="user">
            <div className="absolute inset-0 flex min-h-0">
                {/* …existing children unchanged… */}
            </div>
        </MotionConfig>
    );
```
(The two other early returns — the "No agents or projects" `EmptyCenter` at line 255 — need no motion and stay as-is.)

- [ ] **Step 7: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 8: Existing tests still green**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS (no logic changed; wiring only).

- [ ] **Step 9: Visual verification over CDP** (dev app must be running via `task dev`)

Run: `node scripts/cdp-shot.mjs files-browse.png` after navigating to the Files surface (inject a populated worktree first if needed — see `scripts/inject-live-agents.mjs`).
Confirm by observation:
- Switching source (agent→project or agent→agent) presents the file list with **no cascade**.
- With one source held, a newly-changed file **fades+scales in**; a reverted file exits and the list reflows.
- Clicking through files fades the diff pane in without feeling laggy.
- With OS "reduce motion" on, entrances/crossfade are effectively instant.

- [ ] **Step 10: Stage + request commit approval**

```bash
git add frontend/app/view/agents/filessurface.tsx
```
Proposed message: `feat(files): browse-mode list entrance/reflow + diff crossfade motion`
Await explicit approval before committing.

---

### Task 5: Review-mode motion in `reviewsurface.tsx`

**Files:**
- Modify: `frontend/app/view/agents/reviewsurface.tsx`

**Interfaces:**
- Consumes: `MOTION`, `cardVariants`, `easeFluidCss` from `@/app/element/motiontokens`; `useSettle` from `@/app/element/motionhooks`; `motion` from `motion/react`.
- Relies on the `<MotionConfig reducedMotion="user">` added at the `FilesSurface` root in Task 4 (ReviewSurface renders only inside FilesSurface), so no `MotionConfig` is added here.

- [ ] **Step 1: Add imports** — at the top of `reviewsurface.tsx`:

```ts
import { motion } from "motion/react";
import { MOTION, cardVariants, easeFluidCss } from "@/app/element/motiontokens";
import { useSettle } from "@/app/element/motionhooks";
```

- [ ] **Step 2: Progress-bar width transition** — in `ReviewSurface`, the two fill segments (lines 91-92) become token-timed transitions. Replace:

```tsx
                        <div className="h-full bg-success" style={{ width: `${acceptPct}%` }} />
                        <div className="h-full bg-error" style={{ width: `${rejectPct}%` }} />
```
with:
```tsx
                        <div className="h-full bg-success" style={{ width: `${acceptPct}%`, transition: `width ${MOTION.durMacro}s ${easeFluidCss}` }} />
                        <div className="h-full bg-error" style={{ width: `${rejectPct}%`, transition: `width ${MOTION.durMacro}s ${easeFluidCss}` }} />
```

- [ ] **Step 3: Hunk-pane crossfade on file switch** — wrap the hunks map container (lines 116-118) in a keyed `motion.div`. Replace:

```tsx
                <div className="flex-1 overflow-auto p-[16px_20px_26px]">
                    {sel.hunks.map((h) => <HunkBlock key={h.id} f={sel} h={h} d={d} />)}
                </div>
```
with:
```tsx
                <motion.div
                    key={sel.path}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                    className="flex-1 overflow-auto p-[16px_20px_26px]"
                >
                    {sel.hunks.map((h) => <HunkBlock key={h.id} f={sel} h={h} d={d} />)}
                </motion.div>
```

- [ ] **Step 4: "Review applied" reveal** — wrap the applied-summary return (lines 65-76) with `cardVariants`. Replace the outer `<div className="flex h-full flex-col items-center justify-center gap-[16px] p-[30px]">` with:

```tsx
            <motion.div
                variants={cardVariants}
                initial="initial"
                animate="animate"
                className="flex h-full flex-col items-center justify-center gap-[16px] p-[30px]"
            >
```
and its matching closing `</div>` (line 75) with `</motion.div>`.

- [ ] **Step 5: File-verdict completion settle** — in `FileHeader`, settle when the file becomes fully decided. After `const verdict = fileDecision(f, d);` (line 146), add:

```tsx
    const settling = useSettle(verdict === "accept" || verdict === "reject");
```
Then add the settle class to the header's outer div (line 150). Change:
```tsx
        <div className="flex flex-none items-center gap-[10px] border-b border-border bg-surface px-[20px] py-[13px]">
```
to:
```tsx
        <div className={cn(
            "flex flex-none items-center gap-[10px] border-b border-border bg-surface px-[20px] py-[13px]",
            settling && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
        )}>
```

- [ ] **Step 6: Hunk decision settle + smooth rail/opacity** — in `HunkBlock`, after `const dec = d[key] ?? null;` (line 178), add:

```tsx
    const settling = useSettle(dec !== null);
```
Then update the block's outer div (line 182). Change:
```tsx
        <div className={cn("mb-[10px] overflow-hidden rounded-[8px] border border-border border-l-2", rail)} style={{ opacity: dec === "reject" ? 0.5 : 1 }}>
```
to:
```tsx
        <div
            className={cn(
                "mb-[10px] overflow-hidden rounded-[8px] border border-border border-l-2 transition-[border-color,opacity] duration-[200ms]",
                rail,
                settling && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
            )}
            style={{ opacity: dec === "reject" ? 0.5 : 1 }}
        >
```

- [ ] **Step 7: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 8: Existing tests still green**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS (reviewstore logic untouched; wiring only).

- [ ] **Step 9: Visual verification over CDP** (dev app running)

Navigate to Files → Review mode on a worktree with changes, then `node scripts/cdp-shot.mjs files-review.png`. Confirm:
- Accept/Reject a hunk → the block plays a single soft settle; the left rail color and reject-dim ease in (no hard flip).
- A file becoming fully kept/discarded settles its header row.
- The progress bar grows smoothly as decisions accumulate.
- Selecting a different file fades the hunk pane in.
- Applying the review reveals the summary with a soft scale-in.
- With OS "reduce motion" on, settles and reveals are effectively instant.

- [ ] **Step 10: Stage + request commit approval**

```bash
git add frontend/app/view/agents/reviewsurface.tsx
```
Proposed message: `feat(files): review-mode settle, progress, and crossfade motion`
Await explicit approval before committing.

---

### Task 6: Flip the tracker row + correct the stale Agent note

**Files:**
- Modify: `docs/superpowers/animation-revamp-tracker.md`

- [ ] **Step 1: Update the Files / Diff row** — change its status cell from `☐ Not started` to `✅ Shipped (2026-07-04)` with a note summarizing the moments (browse list entrance/reflow + no-cascade guard, diff crossfade, review settle/progress/crossfade/applied-reveal; guard extracted to `motiontokens.ts`). Fill the commit SHA(s) once the Task 4/5 commits land.

- [ ] **Step 2: Add the References entries** for the new spec and plan:

```markdown
- Files/Diff motion design spec: `docs/superpowers/specs/2026-07-04-files-diff-motion-design.md`
- Files/Diff motion implementation plan: `docs/superpowers/plans/2026-07-04-files-diff-motion-system.md`
```

- [ ] **Step 3: Correct the stale Agent-row note** — the Agent row still says "Remaining: narration/composer/status motion (m5/m6/m7)", which predates the transcript→live-TUI change. Update it to reflect reality: m5 narration is moot (center is the live TUI), there is no inline composer on this surface, and the real remaining work is AgentTree roster + AgentHeader status motion (m1/m2/m3/m4/m7).

- [ ] **Step 4: Stage + request commit approval**

```bash
git add docs/superpowers/animation-revamp-tracker.md \
        docs/superpowers/specs/2026-07-04-files-diff-motion-design.md \
        docs/superpowers/plans/2026-07-04-files-diff-motion-system.md
```
Proposed message: `docs(superpowers): Files/Diff motion shipped; correct Agent-row note`
Await explicit approval before committing.

---

## Self-review notes (author)

- **Spec coverage:** every spec moment (Browse 1-4, Review 5-9, cross-cutting) maps to Tasks 4-5; the guard extraction → Task 1; `filesmotion.ts` → Task 2; `useSettle` shared hook → Task 3; tracker flip → Task 6.
- **Type consistency:** `EntranceState.key` (Task 1) is read in Task 4; `sourceKey` return (Task 2) feeds `computeEntrances`'s `key` param (Task 1) in Task 4; `useSettle(done: boolean)` (Task 3) is called in Task 5; `easeFluidCss` (Task 1) used in Task 5. `FilesSource` exported in Task 2, imported by `filesmotion.ts`.
- **No new vocabulary:** all durations/eases come from `MOTION`; the only additions are the derived `easeFluidCss` string and the shared guard/hook — no new keyframe or raw timing value.
- **Honesty on tests:** the JSX wiring in Tasks 4-5 has no unit harness (documented); it is gated on typecheck + existing-suite-green + explicit CDP visual checks, per the project's stated verification method.
