# Cockpit Handoff-Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the cockpit surface and its shell chrome to handoff parity — fonts, top app bar, NavRail glyphs, project/live filters, section headers, full usage bars + recent-activity peek, and full-parity cards (always-on composer, reply chips, banner, widen, resize).

**Architecture:** A fidelity port, not a re-theme — the `@theme` tokens in `tailwindsetup.css` already match the handoff hex. New behavior is isolated into pure functions (TDD-tested) and three new ephemeral model atoms; React markup consumes them and is verified by static gates + visual run. No new backend, no new Rust/Go, no new SCSS (Tailwind only).

**Tech Stack:** React 19, Tailwind 4 (`@theme` tokens), jotai, motion/react, Tauri window plugin (`@tauri-apps/api/window`), vitest (node-env, no jsdom).

**Source of truth:** `wave-handoff/wave/project/Wave-cockpit-live.dc.html` lines 34–353.
**Spec:** `docs/superpowers/specs/2026-06-25-cockpit-handoff-parity-design.md`.

---

## Conventions (read once)

**Static gates** (run after each task before commit):
- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — baseline has **3 pre-existing errors** in `frontend/tauri/api.test.ts`; your change must add **zero** new errors. (Bare `npx tsc` stack-overflows on this repo — do not use it.)
- Unit tests: `npx vitest run` — must stay green.
- Import-graph / build: `npx vite build --config frontend/tauri/vite.config.ts` — proves the import graph stays acyclic.

**Single test file:** `npx vitest run frontend/app/view/agents/<file>.test.ts`.

**Commit discipline (project rule — STRICT):** Do **not** commit until the user approves. Each task below ends with a `git add` + a proposed commit message; stage the files and **show the user** the file list (M/A/D) + message, then ask "Awaiting approval. Proceed? (yes/no)". Do not add yourself as co-author. The spec doc folds into the first feature commit (it is not a separate docs commit).

**No SCSS:** all new/changed styling is Tailwind utility classes using the existing `@theme` tokens. Reference table (token → handoff hex):

| Token class | hex | use |
|---|---|---|
| `bg-background` | `#0c0e11` | app canvas |
| `bg-surface` | `#0e1116` | bars / rails |
| `bg-surface-raised` | `#13171d` | inputs / dropdowns / pills |
| `bg-surface-hover` / `hover:bg-surface-hover` | `#171c22` | hover |
| `border-border` | `#1c2128` | default border |
| `border-edge-mid` | `#20262e` | input border |
| `border-edge-strong` / `bg-edge-strong` | `#2a313a` | strong border / resize grip |
| `bg-accent` / `text-accent` | `#7c95ff` | primary accent |
| `bg-accenthover` | `#8da3ff` | accent hover |
| `text-accent-soft` / `bg-accent-soft` | `#aebfff` | soft accent (LIVE label/dot) |
| `accent-300` / `accent-500` | `#8da3ff` / `#5f74e0` | logo gradient stops |
| `text-warning` / `bg-warning` | `#e6b450` | asking / amber |
| `text-success` / `bg-success` | `#54c79a` | working / green |
| `text-muted` | `#6b7178` | secondary text |
| `text-secondary` | `#cfd5db` | body text |
| `text-primary` | `#e6e9ed` | headings |
| `text-ink-faint` | `#3a424c` | the `/` separator |

`@keyframes pulseDot` and `fadeUp` already exist in `tailwindsetup.css` — reference them with inline `style={{ animation: "pulseDot 1.8s infinite" }}`.

---

## File Structure

**New files:**
- `frontend/app/cockpit/app-bar.tsx` — the 46px top app bar (`<CockpitAppBar>`): logo, project switcher, ⌘K stub, usage donut, `+ New agent`, window controls.
- `frontend/app/view/agents/projectswitcher.tsx` — `<ProjectSwitcher variant="bar"|"header">` dropdown bound to `projectFilterAtom`; shared by the app bar and the cockpit header.
- `frontend/app/view/agents/sectionheader.tsx` — `<SectionHeader>` presentational primitive shared by the LIVE AGENTS and IDLE headers.
- `frontend/app/view/agents/recentactivity.ts` — pure `buildRecentActivity()` + `recentActivityAtom`.
- `frontend/app/view/agents/agentfilters.test.ts` — tests for the new pure helpers in `agentsviewmodel.ts`.
- `frontend/app/view/agents/recentactivity.test.ts` — tests for `buildRecentActivity()`.

**Modified files:**
- `frontend/tauri/main.tsx` — call `loadFonts()` in boot.
- `frontend/app/view/agents/agentsviewmodel.ts` — add `replySuggestions` to `AgentAsk`, `CardPref` type, and pure helpers `projectsFromAgents`, `matchesProjectFilter`, `filterAgents`, `topFiveHourPct`, `cardSpanStyle`.
- `frontend/app/view/agents/agents.tsx` — new model atoms `projectFilterAtom`, `liveOnlyAtom`, `cardPrefsAtom`.
- `frontend/app/cockpit/cockpit-root.tsx` — render `<CockpitAppBar>` (drop `<CockpitTitlebar>` + the `+ New Agent` strip).
- `frontend/app/cockpit/cockpit.scss` — delete the `.cockpit-titlebar*` / `.cockpit-tb-*` rules.
- `frontend/app/view/agents/navrail.tsx` — 8 SVG glyphs.
- `frontend/app/view/agents/cockpitsurface.tsx` — header filters, filter wiring, LIVE header, full usage bars, recent-activity peek (replaces `MiniGauge`/`ProviderPlan`).
- `frontend/app/view/agents/idlesection.tsx` — IDLE header restyle via `<SectionHeader>`.
- `frontend/app/view/agents/agentrow.tsx` — banner, always-on composer, reply chips, widen, resize.
- `frontend/app/view/agents/agentcomposer.tsx` — `forwardRef` + `fill()` imperative handle.
- `docs/deferred.md` — note the omitted usage-bar token counts.

**Deleted file:**
- `frontend/app/cockpit/titlebar.tsx` — window controls move into the app bar.

---

## Locked decisions (resolve the spec's open questions)

- **App-bar usage donut source** → `topFiveHourPct(agents)` = the single highest `usage.fivehourpct` across all agents (one number; `undefined` → `—`). Colored by `usageLevel`.
- **`recentActivityAtom` location** → new file `recentactivity.ts`, deriving from `liveAgentsAtom` + `liveEntriesByIdAtom` + `lastActivityByIdAtom`. (In the dev FE-mock path the live roster is empty, so the peek is empty — mock wiring is the companion test-data spec's concern, not this pass.)
- **Header chip counts stay global.** The project/live-only filters scope the **grid** and the idle/backgrounded sections; the All/Asking/Working/Idle chip counts continue to reflect the full roster (matches the spec's stated `shownAgents` derivation; avoids confusing chip math).
- **Usage-bar token counts fabricated (and flagged).** `AgentUsage` carries no token totals, but a `used / limit tok` line makes the bar layout judgeable — so it is **derived from a hardcoded per-window ceiling** (`pct% × ceiling`), marked `PLACEHOLDER` in code, and recorded as a gap in `docs/deferred.md`. Not real telemetry.
- **Working banner replaces the head activity subtitle for working agents** (avoids showing activity twice). Idle keeps its reason in the subtitle; asking keeps its task (ai-title) in the subtitle.
- **Structured asks keep `AnswerBar`.** The amber banner for asking is the "WAITING ON YOU" micro-label only (the question already renders inside `AnswerBar`); reply chips + composer are additive quick-replies.

---

## Task 1: Wire fonts into the Tauri boot path

The single biggest cause of the mismatch: `loadFonts()` runs only in `preview.tsx`; the Tauri entry never calls it, so the cockpit renders in the system-ui fallback instead of Hanken Grotesk / JetBrains Mono.

**Files:**
- Modify: `frontend/tauri/main.tsx:1-13`

This is a wiring change with no unit-testable behavior; it is verified by the build gate + a visual check.

- [ ] **Step 1: Add the import**

In `frontend/tauri/main.tsx`, add the import alongside the existing ones (after line 8 `import { resolveBootIds } from "./bootids";`):

```tsx
import { loadFonts } from "@/util/fontutil";
```

- [ ] **Step 2: Call it in boot**

Inside `boot()`, immediately after `installChromeListeners();` (currently line 17), add:

```tsx
        loadFonts(); // register Hanken Grotesk + JetBrains Mono (fonts swap in on load)
```

- [ ] **Step 3: Static gates**

Run:
```
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
npx vite build --config frontend/tauri/vite.config.ts
```
Expected: no new tsc errors (3 baseline only); vitest green; build succeeds.

- [ ] **Step 4: Stage + propose commit**

```
git add frontend/tauri/main.tsx docs/superpowers/specs/2026-06-25-cockpit-handoff-parity-design.md docs/superpowers/plans/2026-06-25-cockpit-handoff-parity.md
```
Proposed message: `feat(cockpit): load fonts in the Tauri boot path`
Show the file list + message, ask for approval. (The spec + this plan fold into this first feature commit.)

---

## Task 2: Pure helpers + `AgentAsk.replySuggestions` + `CardPref`

Add the pure derivations the UI will consume. All live in `agentsviewmodel.ts` (the existing "no React, no Wave runtime imports" home), tested in a new `agentfilters.test.ts`.

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentfilters.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/agents/agentfilters.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    cardSpanStyle,
    filterAgents,
    matchesProjectFilter,
    projectsFromAgents,
    topFiveHourPct,
    type AgentVM,
} from "./agentsviewmodel";

const P = "/h/.claude/projects/C--Users-u-IdeaProjects-waveterm/x.jsonl";
const Q = "/h/.claude/projects/C--Users-u-IdeaProjects-loom/y.jsonl";

const mk = (id: string, state: AgentVM["state"], extra: Partial<AgentVM> = {}): AgentVM => ({
    id,
    name: id,
    task: "",
    state,
    ...extra,
});

describe("projectsFromAgents", () => {
    it("groups distinct projects with agent + asking counts, sorted by name", () => {
        const out = projectsFromAgents([
            mk("a", "working", { transcriptPath: P }),
            mk("b", "asking", { transcriptPath: P }),
            mk("c", "idle", { transcriptPath: Q }),
        ]);
        expect(out).toEqual([
            { name: "loom", agentCount: 1, askingCount: 0 },
            { name: "waveterm", agentCount: 2, askingCount: 1 },
        ]);
    });
    it("skips agents whose transcript path yields no project", () => {
        expect(projectsFromAgents([mk("a", "working"), mk("b", "idle", { transcriptPath: "" })])).toEqual([]);
    });
});

describe("matchesProjectFilter", () => {
    it("matches everything for 'all'", () => {
        expect(matchesProjectFilter(mk("a", "working"), "all")).toBe(true);
    });
    it("matches by derived project name", () => {
        expect(matchesProjectFilter(mk("a", "working", { transcriptPath: P }), "waveterm")).toBe(true);
        expect(matchesProjectFilter(mk("a", "working", { transcriptPath: Q }), "waveterm")).toBe(false);
    });
});

describe("filterAgents", () => {
    const agents = [
        mk("a", "working", { transcriptPath: P }),
        mk("b", "idle", { transcriptPath: P }),
        mk("c", "asking", { transcriptPath: Q }),
    ];
    it("returns all when filter=all and liveOnly=false", () => {
        expect(filterAgents(agents, "all", false).map((a) => a.id)).toEqual(["a", "b", "c"]);
    });
    it("drops idle when liveOnly", () => {
        expect(filterAgents(agents, "all", true).map((a) => a.id)).toEqual(["a", "c"]);
    });
    it("scopes by project, preserving order", () => {
        expect(filterAgents(agents, "waveterm", false).map((a) => a.id)).toEqual(["a", "b"]);
    });
    it("composes project + liveOnly", () => {
        expect(filterAgents(agents, "waveterm", true).map((a) => a.id)).toEqual(["a"]);
    });
});

describe("topFiveHourPct", () => {
    it("returns the highest non-null fivehourpct", () => {
        expect(
            topFiveHourPct([
                mk("a", "working", { usage: { fivehourpct: 30 } }),
                mk("b", "working", { usage: { fivehourpct: 71 } }),
                mk("c", "working", { usage: {} }),
            ])
        ).toBe(71);
    });
    it("returns undefined when no agent reports a 5h pct", () => {
        expect(topFiveHourPct([mk("a", "working"), mk("b", "working", { usage: {} })])).toBeUndefined();
    });
});

describe("cardSpanStyle", () => {
    it("spans both columns when wide", () => {
        expect(cardSpanStyle({ wide: true })).toEqual({ gridColumn: "1 / -1" });
    });
    it("applies a pixel height", () => {
        expect(cardSpanStyle({ height: 240 })).toEqual({ height: "240px" });
    });
    it("combines wide + height", () => {
        expect(cardSpanStyle({ wide: true, height: 200 })).toEqual({ gridColumn: "1 / -1", height: "200px" });
    });
    it("is empty for undefined / no prefs", () => {
        expect(cardSpanStyle()).toEqual({});
        expect(cardSpanStyle({})).toEqual({});
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentfilters.test.ts`
Expected: FAIL — `projectsFromAgents`, `matchesProjectFilter`, `filterAgents`, `topFiveHourPct`, `cardSpanStyle` are not exported.

- [ ] **Step 3: Add the `replySuggestions` field + `CardPref` type**

In `frontend/app/view/agents/agentsviewmodel.ts`, extend the `AgentAsk` interface (currently lines 25-29) to add `replySuggestions`:

```ts
export interface AgentAsk {
    questions: AgentAskQuestion[];
    askId?: string;
    oref?: string;
    replySuggestions?: string[]; // free-form quick-replies (populated by test-data scenarios; undefined on the live path)
}
```

Add a `CardPref` type just after the `AgentVM` interface (after line 47):

```ts
// Per-card ephemeral layout prefs (widen span + dragged height). Not persisted this pass.
export interface CardPref {
    wide?: boolean;
    height?: number;
}
```

- [ ] **Step 4: Add the import + pure helpers**

At the top of `agentsviewmodel.ts`, add the project-name import beneath the existing `modelLabel` import (line 3):

```ts
import { projectNameFromTranscriptPath } from "./projectname";
```

Append these functions at the end of the file:

```ts
export interface ProjectInfo {
    name: string;
    agentCount: number;
    askingCount: number;
}

/** Pure: distinct projects derived from transcript paths, each with its agent + asking counts.
 *  Agents with no derivable project name are skipped. Sorted by project name. */
export function projectsFromAgents(agents: AgentVM[]): ProjectInfo[] {
    const byName = new Map<string, ProjectInfo>();
    for (const a of agents) {
        const name = projectNameFromTranscriptPath(a.transcriptPath ?? "");
        if (!name) {
            continue;
        }
        const cur = byName.get(name) ?? { name, agentCount: 0, askingCount: 0 };
        cur.agentCount++;
        if (a.state === "asking") {
            cur.askingCount++;
        }
        byName.set(name, cur);
    }
    return [...byName.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** Pure: does an agent fall within the current project scope? "all" matches everything. */
export function matchesProjectFilter(agent: AgentVM, filter: string): boolean {
    if (filter === "all") {
        return true;
    }
    return projectNameFromTranscriptPath(agent.transcriptPath ?? "") === filter;
}

/** Pure: apply the project scope + live-only (hide idle) filters, preserving input order. The chip
 *  filter is applied separately by the caller so the live-section counts can ignore it. */
export function filterAgents(agents: AgentVM[], projectFilter: string, liveOnly: boolean): AgentVM[] {
    return agents.filter((a) => matchesProjectFilter(a, projectFilter) && (!liveOnly || a.state !== "idle"));
}

/** Pure: the highest reported 5-hour plan pct across agents, or undefined if none report one.
 *  Drives the app-bar usage donut (one figure across providers). */
export function topFiveHourPct(agents: AgentVM[]): number | undefined {
    let top: number | undefined;
    for (const a of agents) {
        const p = a.usage?.fivehourpct;
        if (p == null) {
            continue;
        }
        if (top == null || p > top) {
            top = p;
        }
    }
    return top;
}

/** Pure: map a card's prefs to its grid style — `wide` spans both columns; `height` sets a px height. */
export function cardSpanStyle(pref?: CardPref): { gridColumn?: string; height?: string } {
    const style: { gridColumn?: string; height?: string } = {};
    if (pref?.wide) {
        style.gridColumn = "1 / -1";
    }
    if (pref?.height != null) {
        style.height = `${pref.height}px`;
    }
    return style;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentfilters.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 6: Static gates**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` then `npx vitest run`
Expected: no new tsc errors; full suite green.

- [ ] **Step 7: Stage + propose commit**

```
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentfilters.test.ts
```
Proposed message: `feat(cockpit): add project/filter/usage/card-span pure helpers`

---

## Task 3: `recentactivity.ts` — `buildRecentActivity` + `recentActivityAtom`

The right-rail "Recent activity" peek derives from the newest narration entry per agent.

**Files:**
- Create: `frontend/app/view/agents/recentactivity.ts`
- Test: `frontend/app/view/agents/recentactivity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/recentactivity.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentEntry, AgentVM } from "./agentsviewmodel";
import { buildRecentActivity } from "./recentactivity";

const mk = (id: string, state: AgentVM["state"], extra: Partial<AgentVM> = {}): AgentVM => ({
    id,
    name: id,
    task: "",
    state,
    ...extra,
});

const msg = (text: string): AgentEntry => ({ kind: "message", text });
const act = (verb: string, target: string): AgentEntry => ({ kind: "action", verb, target });

describe("buildRecentActivity", () => {
    it("uses the last entry per agent and orders by lastActivity desc", () => {
        const agents = [mk("a", "working"), mk("b", "asking")];
        const entries = { a: [msg("hi"), act("Read", "foo.ts")], b: [msg("question?")] };
        const last = { a: 100, b: 200 };
        const out = buildRecentActivity(agents, entries, last, 5);
        expect(out.map((i) => i.id)).toEqual(["b", "a"]);
        expect(out[0]).toEqual({ id: "b", agent: "b", text: "question?", typeLabel: "said", ts: 200, state: "asking" });
        expect(out[1]).toEqual({ id: "a", agent: "a", text: "Read foo.ts", typeLabel: "Read", ts: 100, state: "working" });
    });
    it("labels a user entry 'you'", () => {
        const out = buildRecentActivity([mk("a", "working")], { a: [{ kind: "user", text: "go" }] }, { a: 5 }, 5);
        expect(out[0].typeLabel).toBe("you");
        expect(out[0].text).toBe("go");
    });
    it("falls back to previousInfo when no live entries exist", () => {
        const agents = [mk("a", "asking", { previousInfo: [msg("seeded")] })];
        const out = buildRecentActivity(agents, {}, {}, 5);
        expect(out[0].text).toBe("seeded");
        expect(out[0].ts).toBe(0);
    });
    it("skips agents with no entries and slices to max", () => {
        const agents = [mk("a", "working"), mk("b", "working"), mk("c", "working")];
        const entries = { a: [msg("a")], b: [msg("b")], c: [msg("c")] };
        const last = { a: 1, b: 2, c: 3 };
        const out = buildRecentActivity(agents, entries, last, 2);
        expect(out.map((i) => i.id)).toEqual(["c", "b"]);
        expect(buildRecentActivity([mk("d", "idle")], entries, last, 2).map((i) => i.id)).toEqual([]);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/view/agents/recentactivity.test.ts`
Expected: FAIL — cannot resolve `./recentactivity`.

- [ ] **Step 3: Create the module**

Create `frontend/app/view/agents/recentactivity.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The right-rail "Recent activity" peek: newest narration entry per agent, newest-first.
// Pure derivation (buildRecentActivity) + a live-roster atom (recentActivityAtom).

import { atom, type Atom } from "jotai";
import type { AgentEntry, AgentState, AgentVM } from "./agentsviewmodel";
import { liveAgentsAtom } from "./liveagents";
import { lastActivityByIdAtom, liveEntriesByIdAtom } from "./livetranscript";

export const RECENT_ACTIVITY_LIMIT = 6;

export interface RecentActivityItem {
    id: string;
    agent: string;
    text: string;
    typeLabel: string;
    ts: number;
    state: AgentState;
}

function describe(entry: AgentEntry): { text: string; typeLabel: string } {
    if (entry.kind === "message") {
        return { text: entry.text, typeLabel: "said" };
    }
    if (entry.kind === "user") {
        return { text: entry.text, typeLabel: "you" };
    }
    return { text: `${entry.verb} ${entry.target}`.trim(), typeLabel: entry.verb };
}

/** Pure: one item per agent (its newest entry), newest-first by lastActivity, sliced to `max`.
 *  Live entries win; falls back to the agent's previousInfo (ts 0). Agents with no entries are skipped. */
export function buildRecentActivity(
    agents: AgentVM[],
    entriesById: Record<string, AgentEntry[]>,
    lastActivityById: Record<string, number>,
    max: number
): RecentActivityItem[] {
    const items: RecentActivityItem[] = [];
    for (const a of agents) {
        const entries = entriesById[a.id] ?? a.previousInfo ?? [];
        if (entries.length === 0) {
            continue;
        }
        const { text, typeLabel } = describe(entries[entries.length - 1]);
        items.push({ id: a.id, agent: a.name, text, typeLabel, ts: lastActivityById[a.id] ?? a.idleSince ?? 0, state: a.state });
    }
    return items.sort((x, y) => y.ts - x.ts).slice(0, max);
}

export const recentActivityAtom: Atom<RecentActivityItem[]> = atom((get) =>
    buildRecentActivity(get(liveAgentsAtom), get(liveEntriesByIdAtom), get(lastActivityByIdAtom), RECENT_ACTIVITY_LIMIT)
);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run frontend/app/view/agents/recentactivity.test.ts`
Expected: PASS.

- [ ] **Step 5: Static gates**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` then `npx vitest run`
Expected: no new tsc errors; suite green.

- [ ] **Step 6: Stage + propose commit**

```
git add frontend/app/view/agents/recentactivity.ts frontend/app/view/agents/recentactivity.test.ts
```
Proposed message: `feat(cockpit): derive recent-activity peek list`

---

## Task 4: Model atoms (`projectFilterAtom`, `liveOnlyAtom`, `cardPrefsAtom`)

Three ephemeral atoms on `AgentsViewModel`. No consumers yet — verified by tsc.

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx:12,42-56`

- [ ] **Step 1: Add the `CardPref` import**

In `frontend/app/view/agents/agents.tsx`, extend the existing import from `./agentsviewmodel` (line 12) to include `CardPref`:

```ts
import { buildAskAnswers, canSubmitAsk, type AgentVM, type CardPref } from "./agentsviewmodel";
```

- [ ] **Step 2: Add the atoms**

In the `AgentsViewModel` class, after `chipFilterAtom = atom<ChipFilter>("all");` (line 56), add:

```ts
    // handoff-parity filters + per-card layout (spec §State). Project scope is a single source bound to
    // both the app-bar switcher and the header button; card prefs are ephemeral (not persisted).
    projectFilterAtom = atom<string>("all"); // "all" | <projectName>
    liveOnlyAtom = atom(false);
    cardPrefsAtom = atom<Record<string, CardPref>>({}) as PrimitiveAtom<Record<string, CardPref>>;
```

(`PrimitiveAtom` is already imported in this file.)

- [ ] **Step 3: Static gates**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` then `npx vitest run`
Expected: no new tsc errors; suite green.

- [ ] **Step 4: Stage + propose commit**

```
git add frontend/app/view/agents/agents.tsx
```
Proposed message: `feat(cockpit): add project/live-only/card-prefs model atoms`

---

## Task 5: Top app bar + project switcher (replaces titlebar)

Build `<CockpitAppBar>` and `<ProjectSwitcher>`, wire them into `CockpitRoot`, delete `titlebar.tsx`, and delete the dead titlebar SCSS. No unit test (markup); gate-verified + visual.

**Files:**
- Create: `frontend/app/cockpit/app-bar.tsx`
- Create: `frontend/app/view/agents/projectswitcher.tsx`
- Modify: `frontend/app/cockpit/cockpit-root.tsx` (full rewrite below)
- Modify: `frontend/app/cockpit/cockpit.scss` (delete titlebar rules)
- Delete: `frontend/app/cockpit/titlebar.tsx`

- [ ] **Step 1: Create the project switcher**

Create `frontend/app/view/agents/projectswitcher.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import type { AgentsViewModel } from "./agents";
import { projectsFromAgents } from "./agentsviewmodel";

// Project scope dropdown bound to projectFilterAtom. "bar" = the app-bar `/ name ▾` trigger;
// "header" = the cockpit-header bordered button. Both share one atom (spec D3).
export function ProjectSwitcher({ model, variant }: { model: AgentsViewModel; variant: "bar" | "header" }) {
    const agents = useAtomValue(model.agentsAtom);
    const filter = useAtomValue(model.projectFilterAtom);
    const [open, setOpen] = useState(false);
    const projects = projectsFromAgents(agents);
    const label = filter === "all" ? "All projects" : filter;
    const select = (v: string) => {
        globalStore.set(model.projectFilterAtom, v);
        setOpen(false);
    };
    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    "flex cursor-pointer items-center gap-1.5",
                    variant === "bar"
                        ? "rounded-[6px] px-[7px] py-1 text-[13px] font-medium text-secondary hover:bg-surface-hover hover:text-primary"
                        : "rounded-[8px] border border-edge-mid bg-surface-raised px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:border-edge-strong"
                )}
            >
                {label}
                <span className="text-[9px] text-muted">▾</span>
            </button>
            {open ? (
                <>
                    <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />
                    <div
                        className="absolute left-0 top-[calc(100%+7px)] z-[60] w-[268px] overflow-hidden rounded-[12px] border border-edge-strong bg-surface-raised shadow-popover"
                        style={{ animation: "fadeUp .14s both" }}
                    >
                        <div className="px-3 pb-1.5 pt-[9px]">
                            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                                Switch project
                            </span>
                        </div>
                        <div className="max-h-[46vh] overflow-y-auto px-1.5 pb-1.5">
                            <button
                                type="button"
                                onClick={() => select("all")}
                                className={cn(
                                    "flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2 py-2 text-left hover:bg-surface-hover",
                                    filter === "all" && "bg-accent/10"
                                )}
                            >
                                <span className="h-2 w-2 shrink-0 rounded-[3px] bg-muted" />
                                <span className="flex-1 truncate text-[13px] font-medium text-secondary">All projects</span>
                                <span className="font-mono text-[11px] text-muted">{agents.length}</span>
                            </button>
                            {projects.map((p) => (
                                <button
                                    key={p.name}
                                    type="button"
                                    onClick={() => select(p.name)}
                                    className={cn(
                                        "flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2 py-2 text-left hover:bg-surface-hover",
                                        filter === p.name && "bg-accent/10"
                                    )}
                                >
                                    <span
                                        className={cn(
                                            "h-2 w-2 shrink-0 rounded-[3px]",
                                            p.askingCount > 0 ? "bg-warning" : "bg-success"
                                        )}
                                    />
                                    <span className="flex-1 truncate text-[13px] font-medium text-secondary">{p.name}</span>
                                    {p.askingCount > 0 ? (
                                        <span className="font-mono text-[10px] font-semibold text-warning">{p.askingCount}</span>
                                    ) : null}
                                    <span className="font-mono text-[11px] text-muted">{p.agentCount}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 2: Create the app bar**

Create `frontend/app/cockpit/app-bar.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { newAgentSession } from "@/app/cockpit/cockpit-actions";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { topFiveHourPct, usageLevel } from "@/app/view/agents/agentsviewmodel";
import { ProjectSwitcher } from "@/app/view/agents/projectswitcher";
import { fireAndForget } from "@/util/util";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAtomValue } from "jotai";

// donut foreground color tracks the usage band (matches the rail bars)
const DONUT_COLOR: Record<"ok" | "warn" | "hot", string> = {
    ok: "var(--color-accent)",
    warn: "var(--color-warning)",
    hot: "var(--color-error)",
};

// Handoff top app bar (46px). Replaces CockpitTitlebar + the old "+ New Agent" strip.
// Windows adaptation (spec D1): functional min/max/close on the right; no mac traffic-lights.
export function CockpitAppBar({ model }: { model: AgentsViewModel }) {
    const win = getCurrentWindow();
    const agents = useAtomValue(model.agentsAtom);
    const fivePct = topFiveHourPct(agents);
    const donut =
        fivePct != null
            ? `conic-gradient(${DONUT_COLOR[usageLevel(fivePct)]} 0 ${fivePct}%, var(--color-edge-mid) ${fivePct}% 100%)`
            : "var(--color-edge-mid)";
    return (
        <div
            data-tauri-drag-region
            className="flex h-[46px] shrink-0 items-center gap-4 border-b border-border bg-surface pl-4 pr-3.5"
        >
            <div className="flex items-center gap-[9px]">
                <div className="flex h-[19px] w-[19px] items-center justify-center rounded-[6px] bg-gradient-to-br from-accent-300 to-accent-500">
                    <div className="h-[7px] w-[7px] rounded-full bg-surface" />
                </div>
                <span className="text-[14.5px] font-bold tracking-[-0.01em] text-primary">Wave</span>
                <span className="text-[13px] text-ink-faint">/</span>
                <ProjectSwitcher model={model} variant="bar" />
            </div>

            {/* DEFERRED: command palette — render-only stub (docs/deferred.md) */}
            <button
                type="button"
                onClick={() => {}}
                className="mx-auto flex w-[min(520px,42%)] cursor-text items-center gap-2.5 rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-[7px] text-muted hover:border-edge-strong hover:bg-surface-hover"
            >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="5.5" cy="5.5" r="4" />
                    <path d="M9 9l3 3" strokeLinecap="round" />
                </svg>
                <span className="flex-1 text-left text-[13px]">Search agents, sessions, commands…</span>
                <span className="rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[11px]">⌘K</span>
            </button>

            <div className="flex items-center gap-3">
                <button
                    type="button"
                    onClick={() => globalStore.set(model.surfaceAtom, "usage")}
                    className="flex cursor-pointer items-center gap-2 rounded-[7px] px-1.5 py-1 hover:bg-surface-hover"
                >
                    <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full" style={{ background: donut }}>
                        <span className="h-[14px] w-[14px] rounded-full bg-surface" />
                    </span>
                    <span className="text-left leading-tight">
                        <span className="block font-mono text-[11px] text-secondary">
                            {fivePct != null ? `${Math.round(fivePct)}%` : "—"}
                        </span>
                        <span className="block text-[9px] text-muted">5h limit</span>
                    </span>
                </button>
                <div className="h-5 w-px bg-edge-mid" />
                <button
                    type="button"
                    onClick={() => fireAndForget(() => newAgentSession(model))}
                    className="flex cursor-pointer items-center gap-1.5 rounded-[8px] bg-accent px-3 py-[7px] text-[12.5px] font-semibold text-background hover:bg-accenthover"
                >
                    <span className="-mt-px text-[15px] leading-none">+</span>New agent
                </button>
                <div className="ml-1 flex items-center">
                    <button
                        onClick={() => win.minimize()}
                        aria-label="Minimize"
                        className="flex h-8 w-11 cursor-pointer items-center justify-center text-secondary hover:bg-hover"
                    >
                        &#x2013;
                    </button>
                    <button
                        onClick={() => win.toggleMaximize()}
                        aria-label="Maximize"
                        className="flex h-8 w-11 cursor-pointer items-center justify-center text-secondary hover:bg-hover"
                    >
                        &#x25A1;
                    </button>
                    <button
                        onClick={() => win.close()}
                        aria-label="Close"
                        className="flex h-8 w-11 cursor-pointer items-center justify-center text-secondary hover:bg-error hover:text-white"
                    >
                        &#x2715;
                    </button>
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 3: Rewrite `cockpit-root.tsx`**

Replace the entire contents of `frontend/app/cockpit/cockpit-root.tsx` with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getTabModelByTabId } from "@/app/store/tab-model";
import { AgentsViewModel } from "@/app/view/agents/agents";
import { CockpitShell } from "@/app/view/agents/cockpitshell";
import { WaveEnv, WaveEnvContext } from "@/app/waveenv/waveenv";
import { makeWaveEnvImpl } from "@/app/waveenv/waveenvimpl";
import { Provider } from "jotai";
import { useRef } from "react";
import { CockpitAppBar } from "./app-bar";
import "./cockpit.scss";
import { makeSyntheticNodeModel } from "./synthetic-node-model";

const AgentsBlockId = "cockpit-agents";

export function CockpitRoot() {
    const waveEnvRef = useRef(makeWaveEnvImpl());
    return (
        <Provider store={globalStore}>
            <WaveEnvContext.Provider value={waveEnvRef.current}>
                <div className="cockpit-shell">
                    <CockpitBody waveEnv={waveEnvRef.current} />
                </div>
            </WaveEnvContext.Provider>
        </Provider>
    );
}

// Inside the Provider so useAtomValue resolves to globalStore (the boot store), not jotai's default.
function CockpitBody({ waveEnv }: { waveEnv: WaveEnv }) {
    const agentsModelRef = useRef<AgentsViewModel>(null);
    const tabIdRef = useRef<string>(null);
    if (agentsModelRef.current == null) {
        tabIdRef.current = globalStore.get(atoms.staticTabId);
        const model = new AgentsViewModel({
            blockId: AgentsBlockId,
            nodeModel: makeSyntheticNodeModel(AgentsBlockId),
            tabModel: getTabModelByTabId(tabIdRef.current, waveEnv),
            waveEnv,
        });
        agentsModelRef.current = model;
    }
    const model = agentsModelRef.current;
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <CockpitAppBar model={model} />
            <div className="min-h-0 flex-1">
                <CockpitShell model={model} tabId={tabIdRef.current} />
            </div>
        </div>
    );
}
```

- [ ] **Step 4: Delete the titlebar SCSS rules**

In `frontend/app/cockpit/cockpit.scss`, delete lines 10-42 (the `.cockpit-titlebar`, `.cockpit-titlebar-title`, `.cockpit-titlebar-controls`, `.cockpit-tb-btn`/`.cockpit-tb-close` rules). Keep `.cockpit-shell` (lines 1-9) and `.cockpit-focus-pane` (lines 43-48). The file should end as:

```scss
.cockpit-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    background: var(--main-bg-color, #1a1a1a);
    color: var(--main-text-color, #eee);
}
.cockpit-focus-pane {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    position: relative;
}
```

- [ ] **Step 5: Delete `titlebar.tsx`**

Run: `git rm frontend/app/cockpit/titlebar.tsx`
(It is imported only by `cockpit-root.tsx`, which no longer references it.)

- [ ] **Step 6: Static gates**

Run:
```
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
npx vite build --config frontend/tauri/vite.config.ts
```
Expected: no new tsc errors; suite green; build succeeds (proves no import cycle from `cockpit` → `view/agents/projectswitcher`).

- [ ] **Step 7: Visual check**

Restart `task dev` (the app bar + font wiring need a fresh dev server). Confirm: the 46px bar renders with the logo/`Wave`/project switcher on the left, the ⌘K box centered, and the usage donut + `+ New agent` + min/max/close on the right; window drags from the bar background; the project dropdown opens and switching updates the trigger label. (CDP is not automatable on the Tauri webview — eyeball it.)

- [ ] **Step 8: Stage + propose commit**

```
git add frontend/app/cockpit/app-bar.tsx frontend/app/view/agents/projectswitcher.tsx frontend/app/cockpit/cockpit-root.tsx frontend/app/cockpit/cockpit.scss frontend/app/cockpit/titlebar.tsx
```
Proposed message: `feat(cockpit): replace titlebar with the handoff top app bar`

---

## Task 6: NavRail glyphs

Add the 8 handoff SVGs above each existing label; keep the active-state treatment.

**Files:**
- Modify: `frontend/app/view/agents/navrail.tsx` (full rewrite below)

- [ ] **Step 1: Rewrite `navrail.tsx`**

Replace the entire contents of `frontend/app/view/agents/navrail.tsx` with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtom } from "jotai";
import type { ReactNode } from "react";
import type { AgentsViewModel, SurfaceKey } from "./agents";

// Handoff NavRail glyphs (lines 86-125). Icons inherit currentColor; the active label sets text-accent-soft.
const ICON: Record<SurfaceKey, ReactNode> = {
    cockpit: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <rect x="2" y="2" width="7" height="7" rx="1.6" />
            <rect x="11" y="2" width="7" height="7" rx="1.6" />
            <rect x="2" y="11" width="7" height="7" rx="1.6" />
            <rect x="11" y="11" width="7" height="7" rx="1.6" />
        </svg>
    ),
    agent: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="10" cy="10" r="7" />
            <circle cx="10" cy="10" r="2.3" fill="currentColor" stroke="none" />
        </svg>
    ),
    activity: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <circle cx="3.5" cy="5" r="1.6" />
            <rect x="7" y="4" width="11" height="2" rx="1" />
            <circle cx="3.5" cy="10" r="1.6" />
            <rect x="7" y="9" width="11" height="2" rx="1" />
            <circle cx="3.5" cy="15" r="1.6" />
            <rect x="7" y="14" width="8" height="2" rx="1" />
        </svg>
    ),
    channels: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="3" y="4" width="14" height="10" rx="2.5" />
            <path d="M7 14v3l4-3" fill="currentColor" stroke="none" />
        </svg>
    ),
    sessions: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
            <path d="M10 3l7 3.5-7 3.5-7-3.5z" />
            <path d="M3 10.5l7 3.5 7-3.5" />
        </svg>
    ),
    files: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
            <path d="M3 5.5C3 4.7 3.6 4 4.4 4h3.3c.4 0 .7.2 1 .5L13 6h2.6c.8 0 1.4.7 1.4 1.5V14c0 .8-.6 1.5-1.4 1.5H4.4C3.6 15.5 3 14.8 3 14z" />
        </svg>
    ),
    memory: (
        <svg width="20" height="20" viewBox="0 0 20 20">
            <line x1="5.5" y1="6" x2="14.5" y2="5" stroke="currentColor" strokeWidth="1.5" />
            <line x1="5.5" y1="6" x2="10" y2="15" stroke="currentColor" strokeWidth="1.5" />
            <line x1="14.5" y1="5" x2="10" y2="15" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="5.5" cy="6" r="2.4" fill="currentColor" />
            <circle cx="14.5" cy="5" r="2.1" fill="currentColor" />
            <circle cx="10" cy="15" r="2.7" fill="currentColor" />
        </svg>
    ),
    usage: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" strokeLinecap="round">
            <circle cx="10" cy="10" r="7" stroke="var(--color-edge-strong)" strokeWidth="1.8" />
            <path d="M10 3a7 7 0 0 1 6.1 10.4" stroke="currentColor" strokeWidth="1.8" />
        </svg>
    ),
};

const ITEMS: { key: SurfaceKey; label: string }[] = [
    { key: "cockpit", label: "Cockpit" },
    { key: "agent", label: "Agent" },
    { key: "activity", label: "Activity" },
    { key: "channels", label: "Channels" },
    { key: "sessions", label: "Sessions" },
    { key: "files", label: "Files" },
    { key: "memory", label: "Memory" },
    { key: "usage", label: "Usage" },
];

export function NavRail({ model }: { model: AgentsViewModel }) {
    const [active, setActive] = useAtom(model.surfaceAtom);
    return (
        <nav className="flex w-[78px] shrink-0 flex-col gap-[3px] border-r border-border bg-surface py-2.5">
            {ITEMS.map(({ key, label }) => {
                const isActive = active === key;
                return (
                    <button
                        key={key}
                        type="button"
                        onClick={() => setActive(key)}
                        className={cn(
                            "relative mx-2 flex cursor-pointer flex-col items-center gap-[5px] rounded-[10px] border-0 bg-transparent py-[11px] text-muted transition-colors hover:text-muted-foreground",
                            isActive && "text-accent-soft"
                        )}
                    >
                        {isActive ? (
                            <>
                                <span className="absolute inset-0 rounded-[10px] bg-accent/10" />
                                <span className="absolute left-[-8px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-[3px] bg-accent" />
                            </>
                        ) : null}
                        <span className="relative z-[1]">{ICON[key]}</span>
                        <span className="relative z-[1] text-[10px] font-semibold">{label}</span>
                    </button>
                );
            })}
        </nav>
    );
}
```

(Note: the label font changes from `font-mono` to sans to match the handoff's Hanken Grotesk nav labels.)

- [ ] **Step 2: Static gates**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` then `npx vitest run`
Expected: no new tsc errors; suite green.

- [ ] **Step 3: Visual check**

In the running dev app, confirm each NavRail item shows its glyph above the label, the active item shows the accent left-bar + tinted background, and icons recolor on hover/active.

- [ ] **Step 4: Stage + propose commit**

```
git add frontend/app/view/agents/navrail.tsx
```
Proposed message: `feat(cockpit): add NavRail glyphs`

---

## Task 7: Cockpit header filters + grid filter wiring

Add the projects count, the header `ProjectSwitcher`, and the `Live only` toggle; consume `projectFilterAtom` / `liveOnlyAtom` in the grid + idle/backgrounded sections.

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurface.tsx`

- [ ] **Step 1: Update imports**

In `frontend/app/view/agents/cockpitsurface.tsx`, extend the `agentsviewmodel` import (lines 11-25) to add `filterAgents`, `matchesProjectFilter`, and `projectsFromAgents`:

```ts
import {
    canSubmitAsk,
    filterAgents,
    formatReset,
    groupAgents,
    hasAnswerableAsk,
    isRecentlyIdle,
    matchesProjectFilter,
    mergeOrder,
    moveCursor,
    nextAskId,
    partitionBackgrounded,
    projectsFromAgents,
    providerPlanUsage,
    toggleSelection,
    usageLevel,
    type AgentVM,
} from "./agentsviewmodel";
```

Add the `ProjectSwitcher` import beneath the `IdleSection` import (after line 27):

```ts
import { ProjectSwitcher } from "./projectswitcher";
```

- [ ] **Step 2: Read the filter atoms + compute the visible/filtered sets**

Inside `CockpitSurface`, find the chip line (currently line 235):

```ts
    const shownAgents = chip === "all" ? orderedAgents : orderedAgents.filter((a) => a.state === chip);
```

Replace it with:

```ts
    const projectFilter = useAtomValue(model.projectFilterAtom);
    const liveOnly = useAtomValue(model.liveOnlyAtom);
    // project scope + live-only first; the chip narrows what the grid renders (counts ignore the chip)
    const visibleOrdered = filterAgents(orderedAgents, projectFilter, liveOnly);
    const shownAgents = chip === "all" ? visibleOrdered : visibleOrdered.filter((a) => a.state === chip);
    const liveCount = visibleOrdered.length;
    const liveAsking = visibleOrdered.filter((a) => a.state === "asking").length;
    const liveWorking = visibleOrdered.filter((a) => a.state === "working").length;
    const projectCount = projectsFromAgents(agents).length;
    // idle/backgrounded sections share the project scope; live-only hides the parked-idle section
    const shownParkedIdle = liveOnly ? [] : parkedIdle.filter((a) => matchesProjectFilter(a, projectFilter));
    const shownBackgrounded = backgrounded.filter((a) => matchesProjectFilter(a, projectFilter));
```

- [ ] **Step 3: Add the projects count + header controls**

In the header, update the subtitle `<p>` (currently lines 400-405) to include the projects count:

```tsx
                    <p className="text-[12.5px] text-muted">
                        {agents.length} agents · {projectCount} projects ·{" "}
                        <span className="font-semibold text-warning">
                            <RollingCount value={asking.length} /> need you
                        </span>
                    </p>
```

Then find the `Hide panel ›` / `‹ Usage` button block (currently lines 406-412). Wrap it together with the new `ProjectSwitcher` + `Live only` toggle inside a flex row, replacing the single button with:

```tsx
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                        <button
                            type="button"
                            onClick={() => globalStore.set(model.railOpenAtom, !railOpen)}
                            className="cursor-pointer rounded-[8px] border border-edge-mid px-2.5 py-1.5 text-[12px] text-muted hover:border-edge-strong"
                        >
                            {railOpen ? "Hide panel ›" : "‹ Usage"}
                        </button>
                        <ProjectSwitcher model={model} variant="header" />
                        <button
                            type="button"
                            onClick={() => globalStore.set(model.liveOnlyAtom, !liveOnly)}
                            className={cn(
                                "flex cursor-pointer items-center gap-[7px] rounded-[8px] border px-2.5 py-1.5 text-[12px] font-medium",
                                liveOnly
                                    ? "border-success/60 bg-success/10 text-success"
                                    : "border-edge-mid bg-surface-raised text-muted-foreground hover:border-edge-strong"
                            )}
                        >
                            <span className="h-1.5 w-1.5 rounded-full bg-success" />
                            Live only
                        </button>
                    </div>
```

- [ ] **Step 4: Render the filtered idle/backgrounded sets**

In the bottom sections block (currently lines 494-497), pass the filtered lists:

```tsx
                    <div className="shrink-0 px-[18px]">
                        <BackgroundedSection agents={shownBackgrounded} onRestore={(id) => toggleBackground(id)} />
                        <IdleSection agents={shownParkedIdle} onOpen={(id) => model.openTerminal(id)} />
                    </div>
```

- [ ] **Step 5: Static gates**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` then `npx vitest run`
Expected: no new tsc errors; suite green. (`liveCount`/`liveAsking`/`liveWorking` are consumed in Task 8; they are referenced now but unused-locals are not a tsc error — leave them, Task 8 uses them. If your tsc config flags unused locals, defer adding `liveCount`/`liveAsking`/`liveWorking` until Task 8.)

- [ ] **Step 6: Visual check**

Confirm the header shows `N agents · M projects · K need you`, the `All projects ▾` button + `Live only` toggle sit beside `Hide panel`, selecting a project narrows the grid + idle list, and `Live only` hides idle cards and the Idle section.

- [ ] **Step 7: Stage + propose commit**

```
git add frontend/app/view/agents/cockpitsurface.tsx
```
Proposed message: `feat(cockpit): wire project + live-only filters into the header and grid`

---

## Task 8: Section headers (`SectionHeader` + LIVE AGENTS + IDLE restyle)

**Files:**
- Create: `frontend/app/view/agents/sectionheader.tsx`
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (LIVE header above the grid)
- Modify: `frontend/app/view/agents/idlesection.tsx` (IDLE header)

- [ ] **Step 1: Create `SectionHeader`**

Create `frontend/app/view/agents/sectionheader.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import type { ReactNode } from "react";

// Handoff section header: optional caret + colored dot + mono uppercase label + count pill + gradient
// divider + an optional right slot. Shared by LIVE AGENTS (accent, pulsing) and IDLE (muted, collapsible).
export function SectionHeader({
    label,
    labelClassName,
    count,
    dotClassName,
    pulse,
    countPillClassName,
    dividerClassName,
    right,
    caret,
    onClick,
    className,
}: {
    label: string;
    labelClassName?: string;
    count: number;
    dotClassName: string;
    pulse?: boolean;
    countPillClassName: string;
    dividerClassName: string;
    right?: ReactNode;
    caret?: string;
    onClick?: () => void;
    className?: string;
}) {
    return (
        <div className={cn("flex items-center gap-2.5", onClick && "cursor-pointer", className)} onClick={onClick}>
            {caret ? <span className="w-3 text-center font-mono text-[9px] text-muted">{caret}</span> : null}
            <span
                className={cn("h-[9px] w-[9px] shrink-0 rounded-full", dotClassName)}
                style={pulse ? { animation: "pulseDot 1.8s infinite" } : undefined}
            />
            <h2 className={cn("font-mono text-[12px] font-semibold uppercase tracking-[0.1em]", labelClassName)}>{label}</h2>
            <span className={cn("rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold", countPillClassName)}>{count}</span>
            <div className={cn("h-px flex-1", dividerClassName)} />
            {right}
        </div>
    );
}
```

- [ ] **Step 2: Render the LIVE AGENTS header in `cockpitsurface.tsx`**

Add the import beneath the `ProjectSwitcher` import:

```ts
import { SectionHeader } from "./sectionheader";
```

In the left column, between the empty-state `AnimatePresence` block and the `Reorder.Group` (currently the `Reorder.Group` starts at line 462), insert the header. Place it just before `<Reorder.Group ...>`:

```tsx
                    {liveCount > 0 ? (
                        <div className="shrink-0 px-5 pt-4">
                            <SectionHeader
                                label="Live agents"
                                labelClassName="text-accent-soft"
                                count={liveCount}
                                dotClassName="bg-accent-soft"
                                pulse
                                countPillClassName="bg-accent/10 text-accent-soft"
                                dividerClassName="bg-gradient-to-r from-accent/20 to-transparent"
                                right={
                                    <span className="text-[11.5px] text-muted">
                                        <span className="font-semibold text-warning">{liveAsking} need you</span> · {liveWorking} working
                                    </span>
                                }
                            />
                        </div>
                    ) : null}
```

Then change the `Reorder.Group` className top padding from `p-5` to `px-5 pb-5 pt-2.5` (currently line 467) so the grid sits under the header without a double gap:

```tsx
                        className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-3.5 overflow-y-auto px-5 pb-5 pt-2.5"
```

- [ ] **Step 3: Restyle the IDLE header in `idlesection.tsx`**

In `frontend/app/view/agents/idlesection.tsx`, add the import (after line 6):

```ts
import { SectionHeader } from "./sectionheader";
```

Replace the header `<div>` (currently lines 16-23) with:

```tsx
            <SectionHeader
                className="mb-2 py-1.5"
                label="Idle"
                labelClassName="text-muted"
                count={agents.length}
                dotClassName="bg-muted"
                countPillClassName="bg-surface-raised text-muted"
                dividerClassName="bg-gradient-to-r from-edge-mid to-transparent"
                caret={open ? "▾" : "▸"}
                onClick={() => setOpen((v) => !v)}
            />
```

- [ ] **Step 4: Static gates**

Run:
```
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
npx vite build --config frontend/tauri/vite.config.ts
```
Expected: no new tsc errors; suite green; build succeeds.

- [ ] **Step 5: Visual check**

Confirm the LIVE AGENTS header shows a pulsing accent dot, accent-soft label, count pill, gradient divider, and `K need you · J working` on the right; the IDLE header now matches (muted dot, count pill, gradient divider) while still toggling collapse via the caret.

- [ ] **Step 6: Stage + propose commit**

```
git add frontend/app/view/agents/sectionheader.tsx frontend/app/view/agents/cockpitsurface.tsx frontend/app/view/agents/idlesection.tsx
```
Proposed message: `feat(cockpit): add LIVE AGENTS header and restyle IDLE header`

---

## Task 9: Right rail — full usage bars + recent activity

Replace the compact `MiniGauge`/`ProviderPlan` with full-width handoff bars and add the recent-activity peek.

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurface.tsx`
- Modify: `docs/deferred.md` (token-count omission note)

- [ ] **Step 1: Update imports for the rail**

In `cockpitsurface.tsx`, add `formatAge` to the `agentsviewmodel` import list (it is not currently imported), and add the recent-activity import beneath the `SectionHeader` import:

```ts
import { recentActivityAtom } from "./recentactivity";
```

Add `formatAge` and `formatTokens` into the existing `agentsviewmodel` import block (alphabetical — `formatTokens` lands after `providerPlanUsage`'s neighbors; place both where they sort):

```ts
    formatAge,
    formatReset,
    formatTokens,
```

- [ ] **Step 2: Replace `MiniGauge` + `ProviderPlan` with `UsageBar`**

Delete the `MiniGauge` function (currently lines 61-75) and the `ProviderPlan` function (currently lines 77-89). Keep `PLAN_BAR`, `PLAN_TXT`, and `PROVIDER_DOT` (lines 51-56) — `UsageBar` reuses them. In their place add:

```tsx
// PLACEHOLDER (docs/deferred.md): AgentUsage has no real token totals. These per-window ceilings (handoff
// values) let UsageBar render a believable "used / limit tok" figure derived from pct so the layout is
// judgeable. NOT real telemetry — replace when per-window token data exists.
const FAKE_TOKEN_LIMIT: Record<string, number> = { "5-hour window": 2_200_000, Weekly: 44_000_000 };

// One plan window as a full-width handoff bar: label + pct + bar + (fabricated token count) + reset
// countdown. A null pct (API-key auth, or a window not yet reported) renders nothing.
function UsageBar({ label, pct, reset, now }: { label: string; pct?: number; reset?: number; now: number }) {
    if (pct == null) {
        return null;
    }
    const lvl = usageLevel(pct);
    const limit = FAKE_TOKEN_LIMIT[label];
    const used = limit != null ? (pct / 100) * limit : undefined;
    return (
        <div>
            <div className="mb-[7px] flex items-baseline justify-between">
                <span className="text-[12.5px] font-medium text-secondary">{label}</span>
                <span className={cn("font-mono text-[12px] font-semibold", PLAN_TXT[lvl])}>{Math.round(pct)}%</span>
            </div>
            <div className="h-[7px] overflow-hidden rounded-[4px] bg-surface-raised">
                <div className={cn("h-full rounded-[4px]", PLAN_BAR[lvl])} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            {used != null || reset ? (
                <div className="mt-[6px] flex justify-between font-mono text-[10.5px] text-muted">
                    <span>{used != null ? `${formatTokens(used)} / ${formatTokens(limit!)} tok` : ""}</span>
                    {reset ? <span>resets {formatReset(reset, now)}</span> : null}
                </div>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 3: Read the recent-activity atom**

Inside `CockpitSurface`, near the other `useAtomValue` reads (e.g. after `const chip = useAtomValue(model.chipFilterAtom);`, line 227), add:

```ts
    const recent = useAtomValue(recentActivityAtom);
```

- [ ] **Step 4: Rewrite the rail `<aside>`**

Replace the rail `<aside>` block (currently lines 500-520, the `{railOpen ? (...) : null}`) with the full usage bars + recent-activity peek:

```tsx
                {railOpen ? (
                    <aside className="flex w-[300px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-border bg-surface px-5 py-5">
                        <div>
                            <div className="mb-3.5 flex items-center justify-between">
                                <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Usage</h3>
                                <button
                                    type="button"
                                    onClick={() => globalStore.set(model.surfaceAtom, "usage")}
                                    className="cursor-pointer border-0 bg-transparent text-[11.5px] text-accent"
                                >
                                    Details →
                                </button>
                            </div>
                            <div className="flex flex-col gap-4">
                                {planByProvider.map(({ provider, usage }) => (
                                    <div key={provider} className="flex flex-col gap-4">
                                        {planByProvider.length > 1 ? (
                                            <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-primary">
                                                <span className={cn("h-[7px] w-[7px] rounded-full", PROVIDER_DOT[provider] ?? "bg-muted")} />
                                                {provider.charAt(0).toUpperCase() + provider.slice(1)}
                                            </div>
                                        ) : null}
                                        <UsageBar label="5-hour window" pct={usage.fivehourpct} reset={usage.fivehourreset} now={now} />
                                        <UsageBar label="Weekly" pct={usage.weekpct} reset={usage.weekreset} now={now} />
                                    </div>
                                ))}
                            </div>
                        </div>
                        {recent.length > 0 ? (
                            <div>
                                <div className="mb-3 flex items-center justify-between">
                                    <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                                        Recent activity
                                    </h3>
                                    <button
                                        type="button"
                                        onClick={() => globalStore.set(model.surfaceAtom, "activity")}
                                        className="cursor-pointer border-0 bg-transparent text-[11.5px] text-accent"
                                    >
                                        View all →
                                    </button>
                                </div>
                                <div className="flex flex-col">
                                    {recent.map((e) => (
                                        <div key={e.id} className="flex gap-[11px] border-b border-border py-[9px]">
                                            <span
                                                className="mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full"
                                                style={{ backgroundColor: RECENT_DOT[e.state] }}
                                            />
                                            <div className="min-w-0 flex-1">
                                                <div className="text-[12px] leading-[1.4] text-secondary">
                                                    <span className="font-mono font-semibold text-primary">{e.agent}</span> {e.text}
                                                </div>
                                                <div className="mt-[3px] font-mono text-[10px] text-muted">
                                                    {e.typeLabel} · {now - e.ts < 60_000 ? "just now" : `${formatAge(now - e.ts)} ago`}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : null}
                    </aside>
                ) : null}
```

- [ ] **Step 5: Add the `RECENT_DOT` color map**

Beside the existing `PROVIDER_DOT` constant (line 56), add (these reference `AgentState` via inline literals so no new import is needed):

```ts
// recent-activity dot color by agent state (matches the in-view StatusDot palette)
const RECENT_DOT: Record<string, string> = {
    asking: "var(--color-warning)",
    working: "var(--color-accent)",
    idle: "var(--color-muted)",
};
```

- [ ] **Step 6: Record the deferred token-count gap**

In `docs/deferred.md`, add a new entry at the top (after line 1 `# Deferred work` and its intro paragraph, before the first `##`):

```markdown
## Usage-bar token counts (fabricated)

- **What:** the cockpit right-rail usage bars (5-hour window / Weekly) render a `used / limit tok` line
  (handoff lines 326/331), but the figure is **fabricated** — `used = pct% × FAKE_TOKEN_LIMIT`, where the
  ceilings (2.2M / 44M) are hardcoded handoff values, not telemetry.
- **Why fabricated, not real:** `AgentUsage` (`baseds.AgentUsage`) carries no token totals — only
  `fivehourpct`, `fivehourreset`, `weekpct`, `weekreset`. The fake number makes the bar layout judgeable
  during the visual pass; it must not be read as real usage.
- **Where it plugs in:** `FAKE_TOKEN_LIMIT` + `UsageBar` in `frontend/app/view/agents/cockpitsurface.tsx`
  (marked `PLACEHOLDER`).
- **To resume:** extend `AgentUsage` (and the statusLine reporter that fills it) with per-window token
  used/limit fields, then feed real values into `UsageBar` and delete `FAKE_TOKEN_LIMIT`.
- **Deferred:** 2026-06-25, during the cockpit handoff-parity pass.
```

- [ ] **Step 7: Static gates**

Run:
```
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
npx vite build --config frontend/tauri/vite.config.ts
```
Expected: no new tsc errors; suite green; build succeeds (proves no cycle from `cockpitsurface` → `recentactivity` → `liveagents`).

- [ ] **Step 8: Visual check**

Confirm the rail shows full-width 5-hour + Weekly bars (pct + colored fill + reset), per-provider labels only when >1 provider, and a Recent activity peek with colored dots, `agent text`, and `type · time ago`.

- [ ] **Step 9: Stage + propose commit**

```
git add frontend/app/view/agents/cockpitsurface.tsx docs/deferred.md
```
Proposed message: `feat(cockpit): full usage bars + recent-activity peek in the rail`

---

## Task 10: Cards — always-on composer + reply chips

Make the composer imperative-fillable, render it for every active card (not only the cursor row), and add amber reply-suggestion chips for asking agents.

**Files:**
- Modify: `frontend/app/view/agents/agentcomposer.tsx` (forwardRef + `fill`)
- Modify: `frontend/app/view/agents/agentrow.tsx`

- [ ] **Step 1: Make `AgentComposer` forwardRef with a `fill` handle**

In `frontend/app/view/agents/agentcomposer.tsx`, change the React import (line 7) to add `forwardRef` + `useImperativeHandle`:

```tsx
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
```

Add an exported handle type above the component (after line 11):

```tsx
export interface AgentComposerHandle {
    fill: (text: string) => void;
}
```

Convert the component declaration. Change the current `export function AgentComposer({ ... }: { ... }) {` signature (lines 14-24) to a `forwardRef`:

```tsx
export const AgentComposer = forwardRef<
    AgentComposerHandle,
    {
        blockId?: string;
        placeholder: string;
        className?: string;
        onEscape?: () => void;
    }
>(function AgentComposer({ blockId, placeholder, className, onEscape }, ref) {
```

Immediately after the `taRef` declaration (currently line 26 `const taRef = useRef<HTMLTextAreaElement>(null);`), add the imperative handle:

```tsx
    useImperativeHandle(
        ref,
        () => ({
            fill: (t: string) => {
                setText(t);
                taRef.current?.focus();
            },
        }),
        []
    );
```

At the very end of the component, change the closing `}` of the function to `});` (because it is now a `forwardRef(function(){...})` call). The last two lines become:

```tsx
        </div>
    );
});
```

(Existing callers in `idlesection.tsx` and `focusview.tsx` pass no `ref` — forwardRef is backward compatible.)

- [ ] **Step 2: Update `agentrow.tsx` imports + props**

In `frontend/app/view/agents/agentrow.tsx`, change the `AgentComposer` import (line 8) to also import the handle type:

```tsx
import { AgentComposer, type AgentComposerHandle } from "./agentcomposer";
```

Change the `cn`/React imports (lines 4, 7) to add `useRef` (already imported) — `useRef` is present. No change needed there.

In the `AgentRow` props (the destructured params, lines 16-32 and their type, lines 33-49), add the new card-pref props. Add to the destructure after `pulse,`:

```tsx
    wide,
    height,
    onToggleWide,
    onResize,
```

And to the prop type (after `pulse?: boolean;`):

```tsx
    wide?: boolean;
    height?: number;
    onToggleWide: () => void;
    onResize: (height: number) => void;
```

- [ ] **Step 3: Add the composer ref**

Near the top of the `AgentRow` body, after `const controls = useDragControls();` (line 51), add:

```tsx
    const composerRef = useRef<AgentComposerHandle>(null);
```

- [ ] **Step 4: Replace the cursor-gated composer with the always-on composer + reply chips**

Replace the entire `<AnimatePresence>` composer block (currently lines 199-222 — from `<AnimatePresence>` through its closing `</AnimatePresence>`) with:

```tsx
            <div
                className="mt-2 ml-[26px] flex shrink-0 flex-col gap-2 pb-2"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
            >
                {asking && agent.ask?.replySuggestions?.length ? (
                    <div className="flex flex-wrap gap-1.5">
                        {agent.ask.replySuggestions.map((s, i) => (
                            <button
                                key={i}
                                type="button"
                                onClick={() => composerRef.current?.fill(s)}
                                className="cursor-pointer whitespace-nowrap rounded-[7px] border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11px] text-warning hover:border-warning/55 hover:bg-warning/20"
                            >
                                {s}
                            </button>
                        ))}
                    </div>
                ) : null}
                <AgentComposer
                    ref={composerRef}
                    blockId={agent.blockId}
                    placeholder={`message ${agent.name}…`}
                    onEscape={onComposerEscape}
                    className="border-t-0 px-0 py-0"
                />
            </div>
```

- [ ] **Step 5: Wire the new props from `cockpitsurface.tsx`**

In `cockpitsurface.tsx`, read the card-prefs atom near the other model-atom reads (after the `cursorId`/`answerSel` reads, ~line 223):

```ts
    const [cardPrefs, setCardPrefs] = useModelAtom(model.cardPrefsAtom);
    const toggleWide = (id: string) =>
        setCardPrefs((p) => ({ ...p, [id]: { ...p[id], wide: !p[id]?.wide } }));
    const setCardHeight = (id: string, h: number) =>
        setCardPrefs((p) => ({ ...p, [id]: { ...p[id], height: h } }));
```

In the `<AgentRow ... />` render (the `shownAgents.map`, currently lines 470-489), add the new props (after `pulse={pulseId === a.id}`):

```tsx
                                    wide={cardPrefs[a.id]?.wide}
                                    height={cardPrefs[a.id]?.height}
                                    onToggleWide={() => toggleWide(a.id)}
                                    onResize={(h) => setCardHeight(a.id, h)}
```

- [ ] **Step 6: Static gates**

Run:
```
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
npx vite build --config frontend/tauri/vite.config.ts
```
Expected: no new tsc errors; suite green; build succeeds.

- [ ] **Step 7: Visual check**

Confirm every active card shows the composer at its bottom (not just the cursor row), and an asking card with `replySuggestions` shows amber chips above the composer that fill the textarea when clicked. (`replySuggestions` is populated only by the test-data scenarios — the companion spec — so on the live path chips will be absent; verify the composer-always-on behavior regardless.)

- [ ] **Step 8: Stage + propose commit**

```
git add frontend/app/view/agents/agentcomposer.tsx frontend/app/view/agents/agentrow.tsx frontend/app/view/agents/cockpitsurface.tsx
```
Proposed message: `feat(cockpit): always-on card composer + reply-suggestion chips`

---

## Task 11: Cards — banner, widen, resize

Add the working/asking banner, the widen toggle (span both columns), and the bottom resize handle.

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx`

- [ ] **Step 1: Import `cardSpanStyle`**

In `agentrow.tsx`, change the `agentsviewmodel` import (line 10) to add `cardSpanStyle`:

```tsx
import { cardSpanStyle, formatAge, hasAnswerableAsk, isQuiet, type AgentVM } from "./agentsviewmodel";
```

- [ ] **Step 2: Add a card ref + resize handler**

After the `composerRef` declaration (added in Task 10), add:

```tsx
    const cardRef = useRef<HTMLDivElement>(null);
    const onResizeStart = (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const startY = e.clientY;
        const startH = height ?? cardRef.current?.offsetHeight ?? 0;
        const move = (ev: PointerEvent) => onResize(Math.max(140, startH + (ev.clientY - startY)));
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };
```

- [ ] **Step 3: Apply the ref + span/height style to the `Reorder.Item`**

On the `<Reorder.Item ...>` element, add `ref={cardRef}` and `style={cardSpanStyle({ wide, height })}`. Insert them just after `data-agent-id={agent.id}` (currently line 92):

```tsx
            ref={cardRef}
            style={cardSpanStyle({ wide, height })}
            data-agent-id={agent.id}
```

- [ ] **Step 4: Add the widen button to the head row**

In the head row, immediately before the existing `↗ terminal` button (currently lines 160-170), add the widen toggle:

```tsx
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggleWide();
                    }}
                    title={wide ? "Narrow" : "Widen"}
                    className="shrink-0 cursor-pointer rounded-[6px] border border-border px-1.5 py-0.5 text-[11px] text-secondary opacity-0 transition-opacity hover:bg-white/[0.04] group-hover:opacity-100"
                >
                    {wide ? "⤡" : "⤢"}
                </button>
```

- [ ] **Step 5: Add the banner + drop the working-activity from the subtitle**

First, change the head subtitle (currently lines 116-119) so working agents no longer show activity inline (it moves to the banner); idle keeps its reason, asking/working show task:

```tsx
                <span className="truncate text-[12px] text-muted">
                    {project ? `${project} · ` : ""}
                    {idle ? agent.activity ?? "" : agent.task}
                </span>
```

Then, immediately after the head-row closing `</div>` (currently line 171) and before the narration block, insert the banner:

```tsx
            {asking ? (
                <div className="mt-2 ml-[26px] font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-warning/80">
                    Waiting on you
                </div>
            ) : agent.state === "working" && agent.activity ? (
                <div className="mt-2 ml-[26px] flex items-start gap-2">
                    <span
                        className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-success"
                        style={{ animation: "pulseDot 1.4s infinite" }}
                    />
                    <span className="font-mono text-[12.5px] leading-[1.5] text-success">{agent.activity}</span>
                </div>
            ) : null}
```

- [ ] **Step 6: Simplify the narration block (remove the now-duplicate activity fallback)**

Replace the narration block (currently lines 173-183, the `entries.length > 0 ? (...) : agent.activity ? (...) : null`) with just the timeline (activity now lives in the banner / subtitle):

```tsx
            {entries.length > 0 ? (
                <div ref={scrollRef} onScroll={onNarrationScroll} className="mt-2 ml-[26px] max-h-56 min-h-[64px] overflow-y-auto">
                    <NarrationTimeline entries={entries} accentLatest active={agent.state !== "idle"} />
                </div>
            ) : null}
```

- [ ] **Step 7: Add the resize handle**

As the last child of the `Reorder.Item` (after the composer block from Task 10, before the closing `</Reorder.Item>`), add the absolutely-positioned resize strip:

```tsx
            <div
                onPointerDown={onResizeStart}
                title="Drag to resize"
                className="absolute inset-x-0 bottom-0 flex h-[9px] cursor-ns-resize items-center justify-center"
            >
                <div className="h-[3px] w-[34px] rounded-[3px] bg-edge-strong" />
            </div>
```

- [ ] **Step 8: Static gates**

Run:
```
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
npx vite build --config frontend/tauri/vite.config.ts
```
Expected: no new tsc errors; suite green; build succeeds.

- [ ] **Step 9: Visual check**

Confirm: asking cards show the amber "WAITING ON YOU" micro-label; working cards show a green pulsing activity line; the head widen button toggles the card to span both grid columns and back; dragging the bottom grip resizes the card height (clamped ≥140px). Working cards no longer show activity twice (subtitle vs banner).

- [ ] **Step 10: Stage + propose commit**

```
git add frontend/app/view/agents/agentrow.tsx
```
Proposed message: `feat(cockpit): card banner, widen toggle, and resize handle`

---

## Self-Review (completed by the plan author)

**1. Spec coverage** — every spec section maps to a task:

| Spec item | Task |
|---|---|
| §1 Fonts — `loadFonts()` in `main.tsx` | 1 |
| §2 Top app bar (`<CockpitAppBar>`, logo, project switcher, ⌘K stub, donut, +New agent, window controls; delete titlebar + SCSS; D1 Windows controls) | 5 |
| §3 NavRail 8 glyphs | 6 |
| §4 Cockpit header (projects count, `All projects ▾`, `Live only`) | 7 |
| §5 Section headers (LIVE AGENTS + IDLE) | 8 |
| §6 Right rail (full usage bars + recent activity) | 9 |
| §7 Cards (always-on composer, reply chips, banner, widen, resize) | 10, 11 |
| §State atoms (`projectFilterAtom`, `liveOnlyAtom`, `cardPrefsAtom`) | 4 |
| §Data flow filter composition + `recentActivityAtom` | 2, 3, 7, 9 |
| D2 ⌘K stub + `docs/deferred.md` | 5 (entry pre-exists in deferred.md) |
| D6 No SCSS | 5 (delete titlebar SCSS; all new = Tailwind) |
| Open Q: donut source | resolved → `topFiveHourPct` (Task 2) |
| Open Q: `recentActivityAtom` home | resolved → new `recentactivity.ts` (Task 3) |

**2. Placeholder scan** — no "TBD"/"handle errors appropriately"/"similar to Task N"; every code step shows complete code.

**3. Type consistency** — verified across tasks: `CardPref` (Task 2) used by `cardPrefsAtom` (Task 4) + `cardSpanStyle` (Task 11); `AgentComposerHandle` (Task 10) referenced by `composerRef`; `ProjectInfo` fields (`name`/`agentCount`/`askingCount`) match `projectsFromAgents` usage in `ProjectSwitcher` (Task 5) + header count (Task 7); `RecentActivityItem` fields (`agent`/`text`/`typeLabel`/`ts`/`state`) match the rail render (Task 9); `filterAgents(agents, projectFilter, liveOnly)` signature matches both test (Task 2) and call site (Task 7).

**Noted deviations from a literal handoff replication (all documented above):** header chip counts stay global; working activity moves from subtitle to banner; usage-bar token counts are fabricated from a hardcoded window ceiling and flagged `PLACEHOLDER` (deferred.md); the IDLE section keeps its collapse affordance (handoff shows it expanded).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-25-cockpit-handoff-parity.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

**Dependency note:** the companion test-data spec (`2026-06-25-cockpit-testdata-injection-design.md`) recommends building its **Mechanism 1 (runtime FE mock) first** so this visual pass can be eyeballed with a populated roster (asking/working/idle, multi-question asks, `replySuggestions`). That is a separate plan; if you want the reply-chip + multi-state cards visually verifiable, plan/execute the runtime-mock task before (or alongside) Task 10 here.
