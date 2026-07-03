# Sessions surface motion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add functional motion to the Sessions surface — chip-driven filter reflow (animated), search-as-you-type (instant), a one-shot load reveal, and an empty-state fade — reusing the cockpit motion vocabulary.

**Architecture:** All motion is Framer (`motion/react` v12) reusing `cardVariants`/`MOTION` from `frontend/app/element/motiontokens.ts`. A single `reflowAnimated` flag decides per-render whether row changes animate (chips) or snap (search); a pure `reflowProps(animated)` helper maps that flag to the row's `initial`/`exit`/`transition`. The row list is two nested layers: an outer opacity reveal wrapper and an inner `layout` list box.

**Tech Stack:** React 19, TypeScript, `motion/react`, jotai, vitest, Tailwind 4.

## Global Constraints

- **Reuse the token source.** Import durations/ease/variants from `frontend/app/element/motiontokens.ts`. Never inline a duration, ease, or keyframe. (`MOTION.durMacro`, `MOTION.easeFluid`, `cardVariants`.)
- **Reduced motion is mandatory.** The surface is wrapped in `<MotionConfig reducedMotion="user">`.
- **No entrance cascade.** `AnimatePresence initial={false}` — a populated list (first load or cached re-entry) fires zero staggered row entrances.
- **Animate transform/opacity only**; `layout` only on container elements, never on text nodes.
- **Typecheck command (repo gotcha):** `npx tsc` stack-overflows. Use `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0).
- **No commits without explicit user approval** (user's global git rule). Per the revamp tracker, the surface lands as **one** feature commit folding spec + plan + code + tracker flip. This plan therefore ends with a single approval-gated commit step, not per-task commits.
- **Scope:** only `sessionssurface.tsx` + a new colocated `sessionsmotion.ts`/`.test.ts`. No store or token changes. Resume→surface transition, chip micro-interactions, and any shared-primitive extraction are out of scope.

---

## Task 1: `reflowProps` gate helper

The one piece of real logic: map "was the last change a chip toggle?" to the Framer props that make a row animate (chips) or snap (search). Pure function, unit-tested — mirrors the `motiontokens.test.ts` precedent.

**Files:**
- Create: `frontend/app/view/agents/sessionsmotion.ts`
- Test: `frontend/app/view/agents/sessionsmotion.test.ts`

**Interfaces:**
- Consumes: `MOTION` from `@/app/element/motiontokens`.
- Produces: `reflowProps(animated: boolean): { initial: string | false; exit: string | undefined; transition: Transition }` — spread onto each row `motion.div` (and its `transition` reused on the inner list box).

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/sessionsmotion.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MOTION } from "@/app/element/motiontokens";
import { reflowProps } from "./sessionsmotion";

describe("reflowProps", () => {
    it("animates chip-driven reflow with the fluid macro transition", () => {
        const rp = reflowProps(true);
        expect(rp.initial).toBe("initial");
        expect(rp.exit).toBe("exit");
        expect(rp.transition).toEqual({ duration: MOTION.durMacro, ease: MOTION.easeFluid });
    });

    it("makes search-driven changes instant (no enter, no exit, zero-duration layout)", () => {
        const rp = reflowProps(false);
        expect(rp.initial).toBe(false);
        expect(rp.exit).toBeUndefined();
        expect(rp.transition).toEqual({ duration: 0 });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/sessionsmotion.test.ts`
Expected: FAIL — cannot resolve `./sessionsmotion` / `reflowProps is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/app/view/agents/sessionsmotion.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Chips animate the filter reflow; search-as-you-type updates instantly. This maps that
// decision to the Framer props each session row spreads. See
// docs/superpowers/specs/2026-07-03-sessions-motion-design.md.
import { MOTION } from "@/app/element/motiontokens";
import type { Transition } from "motion/react";

export interface ReflowProps {
    initial: string | false;
    exit: string | undefined;
    transition: Transition;
}

export function reflowProps(animated: boolean): ReflowProps {
    if (animated) {
        return {
            initial: "initial",
            exit: "exit",
            transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid },
        };
    }
    // search: no enter, no exit (popLayout drops the row), zero-duration layout snap.
    return { initial: false, exit: undefined, transition: { duration: 0 } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/sessionsmotion.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no new errors.

---

## Task 2: Wire motion into `SessionsSurface`

Replace the static list render with the motion structure: `MotionConfig` wrap, outer reveal wrapper, inner `layout` list box, `AnimatePresence` popLayout rows, the `reflowAnimated` flag on the chip/search handlers, and the empty-state fade. `FilterChip` is unchanged.

**Files:**
- Modify: `frontend/app/view/agents/sessionssurface.tsx` (whole `SessionsSurface` component + imports; `FilterChip` untouched)

**Interfaces:**
- Consumes: `reflowProps` (Task 1); `cardVariants`, `MOTION` (`@/app/element/motiontokens`); `AnimatePresence`, `MotionConfig`, `motion` (`motion/react`).
- Produces: nothing downstream (leaf surface).

- [ ] **Step 1: Replace the import block**

Replace lines 7–21 (the current import block) with:

```tsx
import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { MOTION, cardVariants } from "@/app/element/motiontokens";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { formatAge, formatTokens } from "./agentsviewmodel";
import type { Runtime } from "./launch";
import { reflowProps } from "./sessionsmotion";
import {
    filterSessions,
    loadSessionsArchive,
    projectsOf,
    runtimesOf,
    searchSessions,
    sessionsArchiveAtom,
} from "./sessionsarchivestore";
```

(`SessionInfo` stays an ambient global type — it is used unimported in the current file; do not add an import for it.)

- [ ] **Step 2: Replace the entire `SessionsSurface` function**

Replace the current `SessionsSurface` (from `export function SessionsSurface({ model }: { model: AgentsViewModel }) {` through its closing `}`) with:

```tsx
export function SessionsSurface({ model }: { model: AgentsViewModel }) {
    const sessions = useAtomValue(sessionsArchiveAtom);
    const [query, setQuery] = useState("");
    const [runtime, setRuntime] = useState("all");
    const [project, setProject] = useState("all");
    // chips animate the reflow; search updates instantly (see sessionsmotion).
    const [reflowAnimated, setReflowAnimated] = useState(false);
    // fade the list in only on first-ever load, never on cached re-entry.
    const [mountedEmpty] = useState(() => sessions == null);

    useEffect(() => {
        fireAndForget(loadSessionsArchive);
    }, []);

    const list = sessions ?? [];
    const runtimes = runtimesOf(list);
    const projects = projectsOf(list);
    const shown = filterSessions(searchSessions(list, query), { runtime, project });
    const now = Date.now();
    const rp = reflowProps(reflowAnimated);

    const chooseRuntime = (r: string) => {
        setRuntime(r);
        setReflowAnimated(true);
    };
    const chooseProject = (p: string) => {
        setProject(p);
        setReflowAnimated(true);
    };

    const resume = (s: SessionInfo) => {
        if (!s.resumecommand) {
            return;
        }
        fireAndForget(() =>
            launchAgent(model, {
                runtime: s.runtime as Runtime,
                startupCommand: s.resumecommand,
                task: "",
                projectPath: s.projectpath,
                projectName: s.projectname || "agent",
            })
        );
    };

    return (
        <MotionConfig reducedMotion="user">
            <div className="absolute inset-0 overflow-y-auto">
                <div className="mx-auto max-w-[820px] px-[30px] pb-[70px] pt-[30px]">
                    <div className="mb-5">
                        <h1 className="text-[25px] font-bold tracking-[-0.02em] text-primary">Sessions</h1>
                        <p className="text-[13.5px] text-secondary">Past agent sessions across runtimes.</p>
                    </div>

                    <input
                        type="text"
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setReflowAnimated(false);
                        }}
                        placeholder="Search task, project, or branch…"
                        className="mb-4 w-full rounded-[9px] border border-border bg-surface px-[13px] py-[9px] text-[13px] text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                    />

                    <div className="mb-3 flex flex-wrap gap-2">
                        <FilterChip label="All runtimes" active={runtime === "all"} onClick={() => chooseRuntime("all")} />
                        {runtimes.map((r) => (
                            <FilterChip key={r} label={r} active={runtime === r} onClick={() => chooseRuntime(r)} />
                        ))}
                    </div>
                    <div className="mb-7 flex flex-wrap gap-2">
                        <FilterChip label="All projects" active={project === "all"} onClick={() => chooseProject("all")} />
                        {projects.map((p) => (
                            <FilterChip key={p} label={p} active={project === p} onClick={() => chooseProject(p)} />
                        ))}
                    </div>

                    {sessions == null ? (
                        <div className="mt-10 text-center text-[13px] text-muted">Loading…</div>
                    ) : shown.length === 0 ? (
                        <motion.div
                            variants={cardVariants}
                            initial="initial"
                            animate="animate"
                            className="mt-10 text-center text-[13px] text-muted"
                        >
                            No sessions found.
                        </motion.div>
                    ) : (
                        <motion.div
                            initial={mountedEmpty ? { opacity: 0 } : false}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                        >
                            <motion.div
                                layout
                                transition={rp.transition}
                                style={{ position: "relative" }}
                                className="overflow-hidden rounded-[12px] border border-border bg-surface"
                            >
                                <AnimatePresence mode="popLayout" initial={false}>
                                    {shown.map((s) => (
                                        <motion.div
                                            key={`${s.runtime}:${s.id}`}
                                            layout
                                            variants={cardVariants}
                                            initial={rp.initial}
                                            animate="animate"
                                            exit={rp.exit}
                                            transition={rp.transition}
                                            className="flex items-center gap-[11px] border-b border-border px-[14px] py-[12px] last:border-b-0 hover:bg-surface-hover"
                                        >
                                            <span className="shrink-0 rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[.08em] text-muted">
                                                {s.runtime}
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate text-[12.5px] font-semibold text-primary">
                                                    {s.task || "(untitled session)"}
                                                </div>
                                                <div className="mt-[2px] truncate font-mono text-[10.5px] text-muted">
                                                    {s.projectname} · {s.branch || "—"} · {s.model || "—"}
                                                    {s.tokenstotal > 0 ? ` · ${formatTokens(s.tokenstotal)} tok` : ""}
                                                </div>
                                            </div>
                                            <span className="shrink-0 font-mono text-[10.5px] text-muted">
                                                {formatAge(now - s.lastactivets)}
                                            </span>
                                            {s.resumecommand ? (
                                                <button
                                                    type="button"
                                                    onClick={() => resume(s)}
                                                    className="shrink-0 cursor-pointer rounded-[7px] border border-border px-[11px] py-[5px] text-[11.5px] font-medium text-ink-mid hover:border-accent hover:text-accent-soft"
                                                >
                                                    Resume →
                                                </button>
                                            ) : (
                                                <span className="shrink-0 text-[10.5px] text-muted">read-only</span>
                                            )}
                                        </motion.div>
                                    ))}
                                </AnimatePresence>
                            </motion.div>
                        </motion.div>
                    )}
                </div>
            </div>
        </MotionConfig>
    );
}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no new errors. (If `initial={rp.initial}` / `exit={rp.exit}` complain, confirm `ReflowProps` types are `string | false` and `string | undefined` — those are valid `motion` prop unions.)

- [ ] **Step 4: Run the full agents test bucket to confirm no regressions**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS (including `sessionsmotion.test.ts`; existing session/store tests unaffected).

---

## Task 3: Visual verification + tracker flip

No unit harness renders the cockpit (per `CLAUDE.md`); verify the moments on the live dev app over CDP, then flip the tracker row.

**Files:**
- Modify: `docs/superpowers/animation-revamp-tracker.md` (Sessions row → ✅)

- [ ] **Step 1: Run the dev app**

Run: `task dev` (leave running). Wait for the Vite dev server + WebView2 to come up. If the cockpit needs populated sessions, inject data: `node scripts/inject-live-agents.mjs <scenario>` (see that script's header for scenarios).

- [ ] **Step 2: Navigate to Sessions and capture the moments**

Use the CDP harness (`node scripts/cdp-shot.mjs [out.png]`) and `Runtime.evaluate` to switch to the Sessions surface (rail click or the surface keybind). Capture and eyeball, one at a time:
  1. **Load reveal** — first navigation to Sessions fades the list in once (single fade, no per-row cascade).
  2. **Cached re-entry** — leave Sessions and return: list appears with **no** fade (mountedEmpty guard).
  3. **Chip reflow** — toggle a runtime/project chip: rows fade/scale out and the list settles (m2).
  4. **Search instant** — type in the search box: rows drop out with no fade/scale, no strobe.
  5. **Empty-state** — filter to zero (e.g. a runtime+project combo with no sessions): "No sessions found." fades in.

- [ ] **Step 3: Verify reduced motion**

In the running app, set `window:reducedmotion` (or the OS "reduce motion" setting) and repeat 1/3/5. Expected: transitions degrade to opacity-only / instant — no scale, no layout slide. (`MotionConfig reducedMotion="user"` handles this.)

- [ ] **Step 4: Note the known edge**

Confirm (do not "fix") the intended limitation: filtering to zero **via a chip** clears the rows without playing their exit animation, because the list subtree unmounts and the empty message fades in instead. This is an accepted trade-off (uncommon path; the empty fade covers it) — documented in the spec. If it reads as jarring in practice, raise it rather than silently reworking the structure.

- [ ] **Step 5: Flip the tracker row**

In `docs/superpowers/animation-revamp-tracker.md`, change the **Sessions** row from:

```
| Sessions | ☐ Not started | Resume hero + list. Candidates: list entrance/exit (m1/m2). |
```

to (fill in the real SHA at commit time):

```
| Sessions | ✅ Shipped `<SHA>` (2026-07-03) | Chip-filter reflow (m2 popLayout), instant search, one-shot load reveal, empty-state fade. No hero (surface is header+search+chips+list). |
```

---

## Final: single feature commit (approval-gated)

Per the user's git rule and the tracker's "fold into that surface's feature commit" convention, everything lands as one commit. Do **not** run this until the user approves.

- [ ] **Step 1: Show the diff for review**

Run: `git status` and `git --no-pager diff --stat` (plus `git --no-pager diff` for the surface file). Present files + a one-line summary each, and the proposed message. Ask for approval.

- [ ] **Step 2: Commit on approval**

```bash
git add docs/superpowers/specs/2026-07-03-sessions-motion-design.md \
        docs/superpowers/plans/2026-07-03-sessions-motion.md \
        docs/superpowers/animation-revamp-tracker.md \
        frontend/app/view/agents/sessionsmotion.ts \
        frontend/app/view/agents/sessionsmotion.test.ts \
        frontend/app/view/agents/sessionssurface.tsx
git commit -m "feat(sessions): filter reflow, instant search, load reveal motion"
```

---

## Self-Review

**1. Spec coverage:**
- Reduced-motion scaffold (`MotionConfig`) → Task 2 Step 2. ✓
- Load reveal (one-shot, cached-safe via `mountedEmpty`) → Task 2 Step 2 (outer wrapper). ✓
- Chips animate / search instant (m2 + gate) → Task 1 (helper) + Task 2 (handlers + `rp` wiring). ✓
- Empty-state fade (m1/`cardVariants`) → Task 2 Step 2. ✓
- No cascade (`AnimatePresence initial={false}`) → Task 2 Step 2. ✓
- Two-layer container (reveal wrapper + `layout`+`position:relative` list box) → Task 2 Step 2. ✓
- Out-of-scope items (resume switch, chip micro, extraction) → not touched. ✓
- Testing (unit gate + CDP visual) → Task 1 + Task 3. ✓
- Tracker flip → Task 3 Step 5. ✓

**2. Placeholder scan:** No TBD/TODO; all code shown in full; `<SHA>` is an intentional commit-time value, not a code placeholder.

**3. Type consistency:** `reflowProps` returns `{ initial: string | false; exit: string | undefined; transition: Transition }` in Task 1 and is consumed as `rp.initial`/`rp.exit`/`rp.transition` in Task 2. `reflowAnimated`, `mountedEmpty`, `chooseRuntime`, `chooseProject` names are consistent across Task 2. `MOTION`/`cardVariants` import names match motiontokens exports.
