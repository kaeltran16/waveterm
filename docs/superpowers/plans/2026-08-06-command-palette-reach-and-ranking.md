# Command palette reach and ranking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the command palette's Enter key from spawning an agent when the user meant to navigate, derive its command list from the keybinding registry so every cockpit action is reachable and shows its chord, and give the result list recency, a visible cap, match highlighting and scroll-into-view.

**Architecture:** Four pure modules beside `command-palette.tsx`, following the `foo.ts` + `foo.test.ts` + thin `foo.tsx` convention already used across `view/agents`. `palette-groups.ts` owns the ordering rule that decides whether the typed text is a name (navigate) or a goal (dispatch). `palette-commands.ts` projects `bindingsAtom` into palette rows. `palette-mru.ts` holds the persisted recency list as pure functions plus one storage atom. `palette-match.ts` (existing) gains a positions-returning matcher. The component consumes all four and gains no logic of its own.

**Tech Stack:** TypeScript, React 19, jotai (`atomWithStorage` from `jotai/utils`), vitest, Tailwind 4 with `@theme` tokens.

**Spec:** `docs/superpowers/specs/2026-08-06-command-palette-reach-and-ranking-design.md`

## Global Constraints

- **Do not commit until the user approves.** Per the user's standing git rule, work is batched into one commit at the end, and spec/plan documents fold into the feature commit rather than landing as a docs-only commit. Every task below therefore ends with a verification step, not a commit step; Task 9 is the single commit, gated on approval.
- **Typecheck with the stack-size workaround.** `npx tsc` stack-overflows on this repo. Use `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. The baseline is clean (exit 0), so any error it reports is yours.
- **No raw hex or rgba in components.** Colors come from `@theme` tokens in `frontend/tailwindsetup.css`, used as Tailwind utilities. New rows reuse the classes already on neighboring rows.
- **No jsdom render or snapshot tests.** Every test in this plan is a pure unit test. "Does it render" is covered by the CDP `surface-smoke` scenario.
- **Prettier will reorder imports and rewrap a whole file if run with `--write`.** Hand-format the lines you add; do not run `prettier --write` on files you did not author in full.
- **`MIN_MATCH_DENSITY = 0.5`** and **`MAX_PER_GROUP = 20`** and **`MAX_MRU = 20`** and **`MAX_RECENT = 5`** — exact values, defined once each, in the module named by the task that introduces them.

---

## File Structure

**Created:**

- `frontend/app/cockpit/palette-groups.ts` — the confident-match rule and default-scope group assembly. Owns `GroupKind`, `MIN_MATCH_DENSITY`, `MAX_PER_GROUP`.
- `frontend/app/cockpit/palette-groups.test.ts`
- `frontend/app/cockpit/palette-commands.ts` — projects `Binding[]` into command rows; holds the chordless extras factory.
- `frontend/app/cockpit/palette-commands.test.ts`
- `frontend/app/cockpit/palette-mru.ts` — the persisted recency atom plus pure list operations.
- `frontend/app/cockpit/palette-mru.test.ts`

**Modified:**

- `frontend/app/cockpit/palette-match.ts` — add `fuzzyMatch` (positions), `highlightRuns`, `SCORE_PER_CHAR`; reduce `fuzzyScore` to a wrapper.
- `frontend/app/cockpit/palette-match.test.ts` — extend.
- `frontend/app/cockpit/command-palette.tsx` — consume all four modules; add chord chips, highlight spans, the overflow line, `data-idx` and the scroll effect.
- `frontend/app/store/keybindings/types.ts` — add the optional `paletteHidden` field to `Binding`.
- `frontend/app/store/keybindings/bindings.ts` — set `paletteHidden` on postures, duplicates and the two palette-opening bindings; rename one go-target label.

---

### Task 1: Positions-returning fuzzy matcher

The scoring loop already computes where each character matched; it just throws the indices away. Split the loop out so it returns them, and keep `fuzzyScore` as a wrapper so the existing four call sites are untouched.

**Files:**
- Modify: `frontend/app/cockpit/palette-match.ts:20-57`
- Test: `frontend/app/cockpit/palette-match.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `fuzzyMatch(query: string, text: string): FuzzyMatch | null` where `FuzzyMatch = {score: number; positions: number[]}`; `highlightRuns(text: string, positions: number[]): {text: string; hit: boolean}[]`; `SCORE_PER_CHAR: number`. `fuzzyScore(query, text): number | null` keeps its exact current signature.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/cockpit/palette-match.test.ts`, and change the import on line 5 to `import { fuzzyMatch, fuzzyScore, highlightRuns, rankPaletteItems } from "./palette-match";`:

```ts
describe("fuzzyMatch", () => {
    it("returns the matched indices in ascending order", () => {
        // "new agent": n@0, a@4, g@5
        expect(fuzzyMatch("nag", "New agent")!.positions).toEqual([0, 4, 5]);
    });
    it("returns score 0 and no positions for an empty query", () => {
        expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
    });
    it("returns null when the query is not a subsequence", () => {
        expect(fuzzyMatch("xyz", "New agent")).toBeNull();
    });
    it("agrees with fuzzyScore", () => {
        expect(fuzzyMatch("nag", "New agent")!.score).toBe(fuzzyScore("nag", "New agent"));
    });
});

describe("highlightRuns", () => {
    it("splits text into alternating hit and miss runs", () => {
        expect(highlightRuns("New agent", [0, 4, 5])).toEqual([
            { text: "N", hit: true },
            { text: "ew ", hit: false },
            { text: "ag", hit: true },
            { text: "ent", hit: false },
        ]);
    });
    it("returns a single miss run when there are no positions", () => {
        expect(highlightRuns("New agent", [])).toEqual([{ text: "New agent", hit: false }]);
    });
    it("returns [] for empty text", () => {
        expect(highlightRuns("", [0])).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/cockpit/palette-match.test.ts`
Expected: FAIL — `fuzzyMatch is not a function` / `highlightRuns is not a function`.

- [ ] **Step 3: Implement**

In `frontend/app/cockpit/palette-match.ts`, add below the existing constants (after line 10):

```ts
// The score a single matched character can normally earn: the match itself plus the contiguity bonus.
// palette-groups.ts uses this as the reference when deciding whether a query matched densely enough
// to be a name the user is typing rather than prose that happens to be a subsequence.
export const SCORE_PER_CHAR = MATCH_POINT + CONTIGUOUS_BONUS;

export interface FuzzyMatch {
    score: number;
    positions: number[]; // indices into `text` that matched, ascending
}
```

Replace the whole body of `fuzzyScore` (lines 20-57) with `fuzzyMatch` plus a wrapper. Keep the existing doc comment on `fuzzyScore`:

```ts
/**
 * Case-insensitive subsequence match. Returns the score (higher = better) and the matched indices,
 * or null when the query chars do not all appear in order within `text`. Empty query -> score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
    const q = query.trim().toLowerCase();
    if (q === "") {
        return { score: 0, positions: [] };
    }
    const t = text.toLowerCase();
    const positions: number[] = [];
    let score = 0;
    let ti = 0;
    let prevMatch = -2; // sentinel: no previous match, and not adjacent to index 0
    for (const ch of q) {
        let found = -1;
        for (let j = ti; j < t.length; j++) {
            if (t[j] === ch) {
                found = j;
                break;
            }
        }
        if (found === -1) {
            return null;
        }
        score += MATCH_POINT;
        if (found === prevMatch + 1) {
            score += CONTIGUOUS_BONUS;
        }
        if (found === 0 || !isWordChar(t[found - 1])) {
            score += WORD_BOUNDARY_BONUS;
        }
        if (prevMatch >= 0) {
            const gap = found - (prevMatch + 1);
            if (gap > 0) {
                score -= Math.min(gap, MAX_GAP_PENALTY);
            }
        }
        positions.push(found);
        prevMatch = found;
        ti = found + 1;
    }
    return { score, positions };
}

/**
 * Case-insensitive subsequence match. Returns a score (higher = better), or null
 * when the query chars do not all appear in order within `text`. Empty query -> 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
    return fuzzyMatch(query, text)?.score ?? null;
}

/**
 * Splits `text` into contiguous runs, each flagged as matched or not, so a row can bold what the
 * user typed without emitting one element per character.
 */
export function highlightRuns(text: string, positions: number[]): { text: string; hit: boolean }[] {
    const hits = new Set(positions);
    const runs: { text: string; hit: boolean }[] = [];
    for (let i = 0; i < text.length; i++) {
        const hit = hits.has(i);
        const last = runs[runs.length - 1];
        if (last != null && last.hit === hit) {
            last.text += text[i];
        } else {
            runs.push({ text: text[i], hit });
        }
    }
    return runs;
}
```

Note `fuzzyMatch(...)?.score ?? null` is correct for the empty-query case: `0 ?? null` is `0`, not `null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/cockpit/palette-match.test.ts`
Expected: PASS, including all five pre-existing `fuzzyScore` cases and all four pre-existing `rankPaletteItems` cases — this task must not change any existing score.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 2: The confident-match rule and group assembly

This is the footgun fix. Today `command-palette.tsx:348` prepends the launch block whenever a channel is active and the query is non-empty, and `:409-410` resets the selection to index 0 on every keystroke — so typing `usage` leaves `Quick · claude` selected and Enter spawns a worker. Move the assembly into a pure module and gate the launch block on the query *not* being a confident match.

**Files:**
- Create: `frontend/app/cockpit/palette-groups.ts`
- Test: `frontend/app/cockpit/palette-groups.test.ts`

**Interfaces:**
- Consumes: `fuzzyScore`, `SCORE_PER_CHAR` from Task 1.
- Produces: `GroupKind` (a string union), `GroupableItem` (`{key, kind, search}`), `PaletteGroup<T>` (`{kind, items}`), `isConfidentMatch(query, ranked)`, `assembleDefaultGroups(input)`, `isRichGroup(kind)`, `GROUP_ORDER`, `MIN_MATCH_DENSITY`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/cockpit/palette-groups.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { assembleDefaultGroups, isConfidentMatch, type GroupableItem } from "./palette-groups";
import { fuzzyScore } from "./palette-match";

const item = (key: string, kind: GroupableItem["kind"], search: string): GroupableItem => ({ key, kind, search });

// Builds a string that contains `q` as a maximally scattered subsequence: every query character is
// followed by filler, so it matches but never contiguously. Stands in for a long session task that a
// prose goal happens to be a subsequence of.
const scattered = (q: string) => [...q].map((c) => c + "zz").join("");

describe("isConfidentMatch", () => {
    it("accepts a surface name typed against its command row", () => {
        expect(isConfidentMatch("usage", [item("c1", "command", "Go to Usage")])).toBe(true);
    });
    it("rejects a prose goal that only scatter-matches", () => {
        const goal = "fix the flaky projectname test";
        const pool = [item("s1", "session", scattered(goal))];
        expect(fuzzyScore(goal, pool[0].search)).not.toBeNull(); // it really does match...
        expect(isConfidentMatch(goal, pool)).toBe(false); // ...but not densely enough to be a name
    });
    it("rejects an empty pool", () => {
        expect(isConfidentMatch("usage", [])).toBe(false);
    });
    it("rejects an empty query", () => {
        expect(isConfidentMatch("   ", [item("c1", "command", "Go to Usage")])).toBe(false);
    });
});

describe("assembleDefaultGroups", () => {
    const ranked = [item("c1", "command", "Go to Usage"), item("a1", "agent", "worker one")];
    const launchItems = [item("launch:quick", "launch", ""), item("launch:run", "launch", "")];
    const askItems = [item("ask-jarvis", "ask-jarvis", "")];

    it("leads with the ranked groups and trails with one act-on block on a confident match", () => {
        const groups = assembleDefaultGroups({ query: "usage", ranked, launchItems, askItems, recent: [] });
        expect(groups.map((g) => g.kind)).toEqual(["command", "agent", "act-on"]);
        expect(groups[0].items[0].key).toBe("c1"); // Enter navigates
        expect(groups[2].items.map((i) => i.key)).toEqual(["launch:quick", "launch:run", "ask-jarvis"]);
    });

    it("leads with the launch block when nothing matched confidently", () => {
        const goal = "fix the flaky projectname test";
        const groups = assembleDefaultGroups({ query: goal, ranked: [], launchItems, askItems, recent: [] });
        expect(groups.map((g) => g.kind)).toEqual(["launch", "ask-jarvis"]);
        expect(groups[0].items[0].key).toBe("launch:quick"); // Enter dispatches
    });

    it("leads with ask-jarvis when there is no active channel", () => {
        const groups = assembleDefaultGroups({ query: "some goal", ranked: [], launchItems: [], askItems, recent: [] });
        expect(groups.map((g) => g.kind)).toEqual(["ask-jarvis"]);
    });

    it("omits the act-on block when there is nothing to act with", () => {
        const groups = assembleDefaultGroups({ query: "usage", ranked, launchItems: [], askItems: [], recent: [] });
        expect(groups.map((g) => g.kind)).toEqual(["command", "agent"]);
    });

    it("leads with Recent on an empty query and does not repeat those rows below", () => {
        const groups = assembleDefaultGroups({
            query: "",
            ranked,
            launchItems: [],
            askItems: [],
            recent: [ranked[0]],
        });
        expect(groups.map((g) => g.kind)).toEqual(["recent", "agent"]);
        expect(groups[0].items.map((i) => i.key)).toEqual(["c1"]);
    });

    it("drops empty groups", () => {
        const groups = assembleDefaultGroups({
            query: "",
            ranked: [],
            launchItems: [],
            askItems: [],
            recent: [],
        });
        expect(groups).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/cockpit/palette-groups.test.ts`
Expected: FAIL — cannot resolve `./palette-groups`.

- [ ] **Step 3: Implement**

Create `frontend/app/cockpit/palette-groups.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure group assembly for the command palette's default scope, and the rule that decides what the
// typed text *is*. A query that names something the cockpit already has (a surface, an agent, a
// session, a focused task) leads with that and Enter navigates; a query that names nothing is a goal,
// so the launch block leads and Enter dispatches. Before this module the launch block always led,
// which meant typing "usage" and pressing Enter spawned a worker on the letters "usage".

import { SCORE_PER_CHAR, fuzzyScore } from "./palette-match";

export type GroupKind =
    | "recent"
    | "launch"
    | "ask-jarvis"
    | "act-on"
    | "focus-task"
    | "command"
    | "agent"
    | "session"
    | "channel";

export interface GroupableItem {
    key: string;
    kind: GroupKind;
    search: string; // matched text; "" for launch/ask rows, which are never ranked
}

export interface PaletteGroup<T> {
    kind: GroupKind;
    items: T[];
}

// Ranked kinds, in the order they are shown below any lead group.
export const GROUP_ORDER: GroupKind[] = ["focus-task", "command", "agent", "session"];

// Groups whose rows render as rich fast-dispatch cards rather than plain list rows.
const RICH_KINDS = new Set<GroupKind>(["launch", "ask-jarvis", "act-on"]);

export function isRichGroup(kind: GroupKind): boolean {
    return RICH_KINDS.has(kind);
}

// How dense a match has to be before it counts as a name rather than prose. fuzzyScore is a permissive
// subsequence match with no floor, so a long goal will often match *something* inside a long session
// task; gating on "matched at all" would make fast-dispatch fire or not fire unpredictably. The
// reference is SCORE_PER_CHAR per character of the trimmed query — "usage" against "Go to Usage"
// scores 28 against a reference of 30, while a scattered prose match scores near zero or below. The
// reference is not a hard maximum (a query containing spaces can pick up extra word-boundary bonuses),
// which is harmless because this is a floor test.
export const MIN_MATCH_DENSITY = 0.5;

export function isConfidentMatch(query: string, ranked: GroupableItem[]): boolean {
    const q = query.trim();
    if (q === "" || ranked.length === 0) {
        return false;
    }
    // ranked is best-first, so the head carries the best score in the pool.
    const best = fuzzyScore(q, ranked[0].search);
    if (best == null) {
        return false;
    }
    return best >= q.length * SCORE_PER_CHAR * MIN_MATCH_DENSITY;
}

export interface DefaultGroupsInput<T extends GroupableItem> {
    query: string;
    ranked: T[]; // focus tasks + commands + agents + sessions, already ranked best-first
    launchItems: T[]; // [] when there is no goal or no active channel
    askItems: T[]; // [] when there is no goal
    recent: T[]; // most-recently-used rows, resolved against the current pool
}

export function assembleDefaultGroups<T extends GroupableItem>(input: DefaultGroupsInput<T>): PaletteGroup<T>[] {
    const { query, ranked, launchItems, askItems, recent } = input;
    const showRecent = query.trim() === "" && recent.length > 0;
    // A row shown under Recent is not repeated in its own group below.
    const recentKeys = new Set(showRecent ? recent.map((it) => it.key) : []);
    const rest = showRecent ? ranked.filter((it) => !recentKeys.has(it.key)) : ranked;

    const rankedGroups = GROUP_ORDER.map((kind) => ({
        kind,
        items: rest.filter((it) => it.kind === kind),
    })).filter((g) => g.items.length > 0);

    const groups: PaletteGroup<T>[] = [];
    if (showRecent) {
        groups.push({ kind: "recent", items: recent });
    }
    if (isConfidentMatch(query, ranked)) {
        groups.push(...rankedGroups);
        const actOn = [...launchItems, ...askItems];
        if (actOn.length > 0) {
            groups.push({ kind: "act-on", items: actOn });
        }
        return groups;
    }
    if (launchItems.length > 0) {
        groups.push({ kind: "launch", items: launchItems });
    }
    if (askItems.length > 0) {
        groups.push({ kind: "ask-jarvis", items: askItems });
    }
    groups.push(...rankedGroups);
    return groups;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/cockpit/palette-groups.test.ts`
Expected: PASS, 11 tests.

---

### Task 3: Wire the ordering rule into the palette

**Files:**
- Modify: `frontend/app/cockpit/command-palette.tsx:33` (kind union), `:51-59` (group order and labels), `:320-358` (assembly), `:372` (footer), `:424` (rich-group branch), `:432-439` (group heading)

**Interfaces:**
- Consumes: `GroupKind`, `assembleDefaultGroups`, `isRichGroup`, `GROUP_ORDER` from Task 2.
- Produces: no new exports. `PaletteItem.kind` is now `GroupKind`.

- [ ] **Step 1: Replace the kind union and group labels**

Delete the local `PaletteKind` type (line 33) and the `GROUP_ORDER` constant (line 51-52). Add to the imports:

```ts
import { assembleDefaultGroups, isRichGroup, type GroupKind, type PaletteGroup } from "./palette-groups";
```

Change `PaletteItem.kind` (line 37) to `kind: GroupKind;` and update `GROUP_LABELS` (lines 53-59) to:

```ts
const GROUP_LABELS: Record<Exclude<GroupKind, "launch" | "ask-jarvis" | "act-on">, string> = {
    recent: "Recent",
    "focus-task": "Focus on task",
    command: "Commands",
    agent: "Agents",
    session: "Sessions",
    channel: "Channels",
};
```

- [ ] **Step 2: Replace the default-scope assembly**

Replace lines 329-350 (the `else if (parsed.scope === "default")` branch) with:

```ts
    } else if (parsed.scope === "default") {
        const ranked = rankPaletteItems([...focusItems, ...items], query);
        const askPalItems: PaletteItem[] = askItems.map((ai) => ({
            key: ai.key,
            kind: "ask-jarvis" as const,
            search: "",
            title: ai.mode,
            glyph: ai.glyph,
            mode: ai.mode,
            desc: ai.desc,
            footer: ai.footer,
            run: ai.run,
        }));
        groups = assembleDefaultGroups({
            query,
            ranked,
            launchItems,
            askItems: askPalItems,
            recent: [],
        });
    } else {
```

The `recent: []` is a real value, not a placeholder — Task 8 replaces it with the resolved recency rows. The type declaration on line 321 becomes `let groups: PaletteGroup<PaletteItem>[];`.

- [ ] **Step 3: Teach the renderer about the act-on group**

At line 424, change the rich-group condition from `g.kind === "launch" || g.kind === "ask-jarvis"` to `isRichGroup(g.kind)`.

Inside that branch, the accent rail (line 430) renders only for the two lead kinds — the trailing act-on block is deliberately quieter so it does not compete with the row Enter will actually run:

```tsx
{g.kind === "act-on" ? null : (
    <div className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-accent/80" />
)}
```

And the heading (lines 432-439) gains the third case:

```tsx
{g.kind === "launch" ? (
    <>
        Launch in <span className="text-accent-100">#{targetChannel?.name}</span>
    </>
) : g.kind === "act-on" ? (
    <>
        Act on <span className="text-accent-100">“{query.trim()}”</span>
    </>
) : (
    "Ask Jarvis"
)}
```

The `selFooter` expression on line 371-372 needs no change: items inside the act-on group keep their own `kind` of `"launch"` or `"ask-jarvis"`, only their *group* is `"act-on"`.

- [ ] **Step 4: Verify the whole suite and the types**

Run: `npx vitest run frontend/app/cockpit/`
Expected: PASS — all palette tests including the six pre-existing files.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Verify the behavior change in the running app**

The dev app must already be running (`task dev`). With an active channel selected on the Jarvis surface, open the palette with `Ctrl+P`, type `usage`, and confirm the selected row is `Go to Usage` under **Commands**, with the launch rows demoted to an `Act on "usage"` block at the bottom. Then clear it, type `fix the flaky projectname test`, and confirm `Quick · claude` is selected under `Launch in #<channel>`.

Screenshot for the record: `node scripts/cdp-shot.mjs cdp-shots/palette-confident.png`

If the dev app is not running, note that this step was skipped rather than marking it done.

---

### Task 4: Cap, overflow line, scroll-into-view and match highlighting

**Files:**
- Modify: `frontend/app/cockpit/palette-groups.ts` (add `MAX_PER_GROUP`, `capGroups`)
- Modify: `frontend/app/cockpit/palette-groups.test.ts`
- Modify: `frontend/app/cockpit/command-palette.tsx`

**Interfaces:**
- Consumes: `highlightRuns`, `fuzzyMatch` from Task 1; `PaletteGroup` from Task 2.
- Produces: `MAX_PER_GROUP: number`, `capGroups<T>(groups: PaletteGroup<T>[]): CappedGroup<T>[]` where `CappedGroup<T> = {kind: GroupKind; items: T[]; overflow: number}`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/cockpit/palette-groups.test.ts` (and add `capGroups`, `MAX_PER_GROUP` to its import):

```ts
describe("capGroups", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => item(`s${i}`, "session", `session ${i}`));

    it("caps a long group and reports what it dropped", () => {
        const [g] = capGroups([{ kind: "session", items: many(MAX_PER_GROUP + 7) }]);
        expect(g.items).toHaveLength(MAX_PER_GROUP);
        expect(g.overflow).toBe(7);
    });
    it("leaves a short group untouched and reports no overflow", () => {
        const [g] = capGroups([{ kind: "session", items: many(3) }]);
        expect(g.items).toHaveLength(3);
        expect(g.overflow).toBe(0);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/cockpit/palette-groups.test.ts`
Expected: FAIL — `capGroups is not a function`.

- [ ] **Step 3: Implement the cap**

Append to `frontend/app/cockpit/palette-groups.ts`:

```ts
// A silently truncated list reads as a complete one, so a capped group renders its own overflow count.
export const MAX_PER_GROUP = 20;

export interface CappedGroup<T> {
    kind: GroupKind;
    items: T[];
    overflow: number;
}

export function capGroups<T>(groups: PaletteGroup<T>[]): CappedGroup<T>[] {
    return groups.map((g) => ({
        kind: g.kind,
        items: g.items.slice(0, MAX_PER_GROUP),
        overflow: Math.max(0, g.items.length - MAX_PER_GROUP),
    }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/cockpit/palette-groups.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply the cap in the component**

In `command-palette.tsx`, change the declaration on line 321 to `let groups: PaletteGroup<PaletteItem>[];`, then immediately after the whole if/else chain (after line 358) insert:

```ts
    const capped = capGroups(groups);
    const flat = capped.flatMap((g) => g.items);
```

and delete the old `const flat = groups.flatMap((g) => g.items);` on line 359. Replace every render-time reference to `groups` (lines 423, 546 and the `.map` at 423) with `capped`. Import `capGroups` and `type CappedGroup` from `./palette-groups`.

After each plain group's rows (inside the `<div key={g.kind}>` at line 495, after the `g.items.map(...)` block), add the overflow line:

```tsx
{g.overflow > 0 ? (
    <div className="px-4 pb-1 pt-0.5 font-mono text-[10.5px] text-muted">
        +{g.overflow} more — keep typing
    </div>
) : null}
```

- [ ] **Step 6: Add scroll-into-view**

Add a ref for the scroll container and an effect. Near the other refs (line 72-73):

```ts
const listRef = useRef<HTMLDivElement>(null);
```

After the existing open effect (after line 109):

```ts
// Arrow-keying past the visible rows used to move the selection out of view — the scroll container
// was never told to follow it.
useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${selClamped}"]`)?.scrollIntoView({ block: "nearest" });
}, [selClamped]);
```

`selClamped` is computed at line 368, below the effects; move that computation and the `flat`/`flatIndex`/`selected` block above the effect so the effect can read it, or leave the effect where the values are already in scope — either is fine as long as the effect is not conditional.

Attach the ref to the scroll container on line 419: `<div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-2">`.

Add `data-idx={myIdx}` to both `<button>` elements (line 445 for rich rows, line 503 for plain rows).

- [ ] **Step 7: Add match highlighting to plain rows**

Add to the imports: `import { fuzzyMatch, highlightRuns, rankPaletteItems } from "./palette-match";` (replacing the existing `rankPaletteItems` import line 29).

Add a small component above `CommandPalette`:

```tsx
// Positions index the string that was matched, and item.search is not what a row displays — for an
// agent it is name + task + project while the title is "name — task". So the row re-matches against
// its own title; a query that hit only keywords renders unhighlighted, which beats bolding the wrong
// characters.
function Highlighted({ text, query }: { text: string; query: string }) {
    const runs = useMemo(() => {
        if (query.trim() === "") {
            return null;
        }
        const m = fuzzyMatch(query, text);
        return m == null || m.positions.length === 0 ? null : highlightRuns(text, m.positions);
    }, [text, query]);
    if (runs == null) {
        return <>{text}</>;
    }
    return (
        <>
            {runs.map((r, i) =>
                r.hit ? (
                    <span key={i} className="font-semibold text-primary">
                        {r.text}
                    </span>
                ) : (
                    <span key={i}>{r.text}</span>
                )
            )}
        </>
    );
}
```

The highlight query is the scope's own filter text, not the raw input — under `@` or `#` the sigil is not part of what was matched. Add beside `parsed` (line 80):

```ts
const highlightQuery = parsed.scope === "default" ? query : parsed.sub;
```

In the plain-row branch, replace `{it.title}` on line 520 with `<Highlighted text={it.title} query={highlightQuery} />`. Leave rich rows alone — their titles are mode names, not matches.

- [ ] **Step 8: Verify**

Run: `npx vitest run frontend/app/cockpit/`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 5: Annotate the keybinding registry

Adds the opt-out field and sets it on the entries that must not become palette rows. This task changes no behavior on its own — the field has no reader until Task 6 — so it is verified by the existing keybinding tests staying green.

**Files:**
- Modify: `frontend/app/store/keybindings/types.ts` (the `Binding` interface)
- Modify: `frontend/app/store/keybindings/bindings.ts:41`, `:86-92`, `:115-134`, `:158-185`, `:252-256`, `:294-305`, `:426-434`

**Interfaces:**
- Consumes: nothing.
- Produces: `Binding.paletteHidden?: boolean`.

- [ ] **Step 1: Add the field**

In `frontend/app/store/keybindings/types.ts`, inside `interface Binding`, above the `run` field and its comment:

```ts
    // Excluded from the command palette's derived command list (the cheat sheet still shows it). Set on
    // postures — keys pressed while looking at the screen rather than actions searched by name — on
    // multi-press gestures a single row cannot express, and on chords that duplicate a better-labelled
    // binding. See palette-commands.ts.
    paletteHidden?: boolean;
```

- [ ] **Step 2: Tag the duplicate surface jumps**

`bindings.ts:86-92`. These are exact duplicates of the `g`-leader go-targets, and dedupe-by-label cannot collapse them because their generated label is the raw lowercase surface key (`Jump to usage`) rather than the go-target's phrasing. Their label is also the worse of the two.

```ts
    const surfaceChords: Binding[] = SURFACE_ORDER.slice(0, 9).map((surface, i) => ({
        id: `surface:${surface}`,
        keys: `Ctrl:${i + 1}`,
        group: "Global",
        label: `Jump to ${surface}`,
        paletteHidden: true, // duplicates the go-target for the same surface, with a worse label
        run: () => globalStore.set(model.surfaceAtom, surface),
    }));
```

- [ ] **Step 3: Tag the two palette-opening bindings**

A row inside the command palette that opens the command palette is absurd, and their labels differ so dedupe would keep both. Add `paletteHidden: true,` to the `palette` binding (after line 118, `label: "Command palette (file finder on Code)",`) and to the `go:palette` binding (after line 131, `label: "Command palette",`).

- [ ] **Step 4: Tag the stateful close gesture**

`close-agent` is labelled "Close agent (press twice)" and its `run` returns false on the first press so the PTY receives `^C`. One palette row would fire one press and appear to do nothing. Add `paletteHidden: true,` after line 162 (`label: "Close agent (press twice)",`).

- [ ] **Step 5: Tag the postures**

Replace `bindings.ts:252-256` with:

```ts
    return [
        { id: "list:next-j", keys: "j", group: "Navigation", label: "Next item", when: active, paletteHidden: true, run: () => move(1) },
        { id: "list:prev-k", keys: "k", group: "Navigation", label: "Previous item", when: active, paletteHidden: true, run: () => move(-1) },
        { id: "list:next", keys: "ArrowDown", group: "Navigation", label: "Next item", when: active, paletteHidden: true, run: () => move(1) },
        { id: "list:prev", keys: "ArrowUp", group: "Navigation", label: "Previous item", when: active, paletteHidden: true, run: () => move(-1) },
        { id: "list:activate", keys: "Enter", group: "Navigation", label: "Open / activate item", when: active, paletteHidden: true, run: activate },
    ];
```

Add `paletteHidden: true,` to the answer-digit factory (`bindings.ts:294-301`, after `label: \`Answer option ${n}\`,`) and to `channels:submit` (line 304, after its `label`).

Add `paletteHidden: true,` to `jarvis:blur-composer` after line 430 (`label: "Leave the composer",`).

- [ ] **Step 6: Give the diff surface one name**

`bindings.ts:41` labels the diff surface `Files` while the nav rail (`navrail.tsx:45`) labels the same surface `Diff`. Today the two lists never meet; deriving palette rows from bindings puts them in the same list. Change line 41 to:

```ts
    { letter: "f", surface: "files", label: "Diff" },
```

- [ ] **Step 7: Verify nothing regressed**

Run: `npx vitest run frontend/app/store/keybindings/`
Expected: PASS. `bindings.test.ts` and `store.test.ts` do not assert on the `Files` label (verified: the only occurrences are the `buildFilesBindings` import and a `find` helper), and an added optional field cannot break the conflict-invariant test.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 6: Project bindings into command rows

**Files:**
- Create: `frontend/app/cockpit/palette-commands.ts`
- Test: `frontend/app/cockpit/palette-commands.test.ts`

**Interfaces:**
- Consumes: `Binding`, `KeyContext`, `SurfaceKey` from `@/app/store/keybindings/types`; `PICKER_THEMES` from `@/app/view/agents/themes`.
- Produces: `CommandItem` (`{key, title, keys?, group, run}`), `postCloseContext(surface)`, `buildCommandItems(bindings, ctx)`, `ExtraDeps`, `buildExtraItems(deps)`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/cockpit/palette-commands.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Binding, KeyContext } from "@/app/store/keybindings/types";
import { describe, expect, it, vi } from "vitest";
import { buildCommandItems, buildExtraItems, postCloseContext } from "./palette-commands";

const bind = (over: Partial<Binding> & Pick<Binding, "id" | "keys" | "label">): Binding => ({
    group: "Global",
    run: () => {},
    ...over,
});

// The guard shape most cockpit bindings use: only while the user is looking at a surface, not typing
// into a field and not behind a modal.
const navigate = (ctx: KeyContext) => !ctx.editable && !ctx.modalOpen;

describe("postCloseContext", () => {
    it("describes the posture one frame after the palette closes", () => {
        expect(postCloseContext("usage")).toEqual({
            surface: "usage",
            editable: false,
            modalOpen: false,
            leader: null,
        });
    });
    it("passes a navigate guard that the palette's own live context would fail", () => {
        const live: KeyContext = { surface: "usage", editable: true, modalOpen: true, leader: null };
        expect(navigate(postCloseContext("usage"))).toBe(true);
        expect(navigate(live)).toBe(false);
    });
});

describe("buildCommandItems", () => {
    const ctx = postCloseContext("usage");

    it("omits bindings tagged paletteHidden", () => {
        const items = buildCommandItems([bind({ id: "list:next", keys: "j", label: "Next item", paletteHidden: true })], ctx);
        expect(items).toEqual([]);
    });

    it("omits bindings whose guard rejects the post-close context", () => {
        const items = buildCommandItems(
            [bind({ id: "only-code", keys: "Ctrl:s", label: "Save", when: (c) => c.surface === "code" })],
            ctx
        );
        expect(items).toEqual([]);
    });

    it("keeps bindings with no guard at all", () => {
        const items = buildCommandItems([bind({ id: "new-agent", keys: "Ctrl:n", label: "New agent" })], ctx);
        expect(items.map((i) => i.key)).toEqual(["new-agent"]);
    });

    it("collapses same-labelled bindings, keeping the leader sequence", () => {
        const items = buildCommandItems(
            [
                bind({ id: "cycle-agent-next", keys: "Ctrl:Tab", label: "Next agent" }),
                bind({ id: "agent:next", keys: "ArrowRight", label: "Next agent" }),
                bind({ id: "go:next", keys: "g n", label: "Next agent" }),
            ],
            ctx
        );
        expect(items).toHaveLength(1);
        expect(items[0].keys).toBe("g n");
    });

    it("prefers a modifier chord over a bare posture key", () => {
        const items = buildCommandItems(
            [
                bind({ id: "agent:next", keys: "ArrowRight", label: "Next agent" }),
                bind({ id: "cycle-agent-next", keys: "Ctrl:Tab", label: "Next agent" }),
            ],
            ctx
        );
        expect(items[0].keys).toBe("Ctrl:Tab");
    });

    it("runs the binding with the post-close context, not the live one", () => {
        const run = vi.fn();
        const items = buildCommandItems([bind({ id: "x", keys: "Ctrl:x", label: "X", run })], ctx);
        items[0].run();
        expect(run).toHaveBeenCalledWith(ctx);
    });
});

describe("buildExtraItems", () => {
    const deps = () => ({ openNewProject: vi.fn(), openNewMemory: vi.fn(), setTheme: vi.fn() });

    it("offers the two chordless modals and one row per picker theme", () => {
        const items = buildExtraItems(deps());
        expect(items.slice(0, 2).map((i) => i.key)).toEqual(["cmd:new-project", "cmd:new-memory"]);
        expect(items.filter((i) => i.key.startsWith("cmd:theme:"))).toHaveLength(6);
    });
    it("carries no chord", () => {
        expect(buildExtraItems(deps()).every((i) => i.keys == null)).toBe(true);
    });
    it("switches to the chosen preset id", () => {
        const d = deps();
        buildExtraItems(d).find((i) => i.key === "cmd:theme:carbon")!.run();
        expect(d.setTheme).toHaveBeenCalledWith("carbon");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/cockpit/palette-commands.test.ts`
Expected: FAIL — cannot resolve `./palette-commands`.

- [ ] **Step 3: Implement**

Create `frontend/app/cockpit/palette-commands.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Projects the live keybinding registry into command-palette rows, so the registry is the single
// source of truth for what the cockpit can do and what it is called — and every row can show the chord
// that runs it. Before this module the palette hand-wrote eleven commands, duplicating a slice of the
// registry's labels and showing no chords at all.

import type { Binding, KeyContext, SurfaceKey } from "@/app/store/keybindings/types";
import { PICKER_THEMES } from "@/app/view/agents/themes";

export interface CommandItem {
    key: string; // binding id, or "cmd:<slug>" for a chordless extra
    title: string;
    keys?: string; // chord descriptor for formatChord; absent for chordless extras
    group: string;
    run: () => void;
}

// Binding guards are written against the posture of someone looking at a surface. While the palette is
// open the live context has modalOpen: true and editable: true (its search input holds focus), so
// evaluating guards against it would reject nearly everything worth listing. Applicability is judged
// against the context that exists one frame after the palette closes.
export function postCloseContext(surface: SurfaceKey): KeyContext {
    return { surface, editable: false, modalOpen: false, leader: null };
}

// Prefer the chord a user types deliberately: a leader sequence ("g u") over a modifier chord
// ("Ctrl:Tab") over a bare posture key ("j"), so a row never advertises the key you press without
// thinking when a memorable one exists for the same action.
function chordRank(keys: string): number {
    if (keys.includes(" ")) {
        return 0;
    }
    if (keys.includes(":")) {
        return 1;
    }
    return 2;
}

export function buildCommandItems(bindings: Binding[], ctx: KeyContext): CommandItem[] {
    const byLabel = new Map<string, Binding>();
    for (const b of bindings) {
        if (b.paletteHidden) {
            continue;
        }
        if (b.when != null && !b.when(ctx)) {
            continue;
        }
        const prev = byLabel.get(b.label);
        if (prev == null || chordRank(b.keys) < chordRank(prev.keys)) {
            byLabel.set(b.label, b);
        }
    }
    return [...byLabel.values()].map((b) => ({
        key: b.id,
        title: b.label,
        keys: b.keys,
        group: b.group,
        run: () => {
            b.run(ctx);
        },
    }));
}

export interface ExtraDeps {
    openNewProject: () => void;
    openNewMemory: () => void;
    setTheme: (presetId: string) => void;
}

// The cockpit actions that have no chord to derive from. PICKER_THEMES is already the dark-only subset
// the Settings picker offers, so Paper stays omitted here for the same reason it is omitted there.
export function buildExtraItems(deps: ExtraDeps): CommandItem[] {
    return [
        { key: "cmd:new-project", title: "New project", group: "Global", run: deps.openNewProject },
        { key: "cmd:new-memory", title: "New memory", group: "Memory", run: deps.openNewMemory },
        ...PICKER_THEMES.map((t) => ({
            key: `cmd:theme:${t.id}`,
            title: `Switch theme → ${t.name}`,
            group: "Appearance",
            run: () => deps.setTheme(t.id),
        })),
    ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/cockpit/palette-commands.test.ts`
Expected: PASS, 12 tests.

---

### Task 7: Replace the hand-written commands in the palette

**Files:**
- Modify: `frontend/app/cockpit/command-palette.tsx:17` (drop the nav-rail import), `:131-209` (the items memo), the plain-row renderer

**Interfaces:**
- Consumes: `buildCommandItems`, `buildExtraItems`, `postCloseContext` from Task 6; `bindingsAtom` from `@/app/store/keybindings/store`; `formatChord` from `@/util/keysym`; `themePresetAtom`, `themeOverridesAtom` from `@/app/view/agents/themestore`.
- Produces: `PaletteItem` gains an optional `chord?: string`.

- [ ] **Step 1: Swap the imports**

Remove line 17 (`import { ITEMS as SURFACE_ITEMS } from "@/app/view/agents/navrail";`) and add:

```ts
import { bindingsAtom } from "@/app/store/keybindings/store";
import { themeOverridesAtom, themePresetAtom } from "@/app/view/agents/themestore";
import { formatChord } from "@/util/keysym";
import { buildCommandItems, buildExtraItems, postCloseContext } from "./palette-commands";
```

Add `chord?: string; // keybinding chord for derived command rows` to the `PaletteItem` interface.

- [ ] **Step 2: Read the two atoms the derivation needs**

Beside the other `useAtomValue` calls (lines 62-68):

```ts
const surface = useAtomValue(model.surfaceAtom);
const bindings = useAtomValue(bindingsAtom);
```

- [ ] **Step 3: Replace the hand-written command array**

Replace lines 133-174 (the whole `const commands: PaletteItem[] = [...]` literal) with:

```ts
        const ctx = postCloseContext(surface);
        const extras = buildExtraItems({
            openNewProject: () => globalStore.set(model.newProjectOpenAtom, true),
            // memNewOpenAtom is read only inside memorysurface.tsx, and every surface but Agent unmounts
            // when off-screen — so the surface has to be switched first or nothing is listening.
            openNewMemory: () => {
                globalStore.set(model.surfaceAtom, "memory");
                globalStore.set(model.memNewOpenAtom, true);
            },
            // matches selectPreset in settingssurface.tsx: picking a preset drops per-role overrides.
            setTheme: (presetId) => {
                globalStore.set(themePresetAtom, presetId);
                globalStore.set(themeOverridesAtom, {});
            },
        });
        const commands: PaletteItem[] = [...buildCommandItems(bindings, ctx), ...extras].map((c) => ({
            key: c.key,
            kind: "command" as const,
            search: `${c.title} ${c.group}`,
            title: c.title,
            chord: c.keys,
            run: () => {
                c.run();
                close();
            },
        }));
```

Add `bindings` and `surface` to the memo's dependency array on line 209: `}, [agents, sessions, model, bindings, surface]);`

Every derived row keeps the palette's single `Commands` bucket rather than splitting by the binding's own group — the group name still feeds `search`, so typing `go` finds the go-targets and typing `jarvis` finds the Jarvis actions.

- [ ] **Step 4: Render the chord**

In the plain-row branch, between the title/subtitle span (which closes at line 527) and the `it.hint` span:

```tsx
{it.chord ? (
    <span className="flex shrink-0 items-center gap-1">
        {formatChord(it.chord).map((k, i) => (
            <span
                key={i}
                className="rounded-[5px] border border-edge-mid px-[6px] py-0.5 font-mono text-[10.5px] text-muted"
            >
                {k}
            </span>
        ))}
    </span>
) : null}
```

- [ ] **Step 5: Verify**

Run: `npx vitest run frontend/app/cockpit/`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Verify reach in the running app**

Open the palette and confirm: `Settings` now appears (it never had a palette row before); `Go to`-style rows show their `g` chord as key chips; typing `theme` lists six `Switch theme → …` rows and picking one repaints the cockpit; no `Answer option N`, `Next item`, `Jump to usage`, `Command palette` or `Close agent (press twice)` rows appear anywhere in the list.

Screenshot: `node scripts/cdp-shot.mjs cdp-shots/palette-reach.png`

If the dev app is not running, note that this step was skipped rather than marking it done.

---

### Task 8: Recency

**Files:**
- Create: `frontend/app/cockpit/palette-mru.ts`
- Test: `frontend/app/cockpit/palette-mru.test.ts`
- Modify: `frontend/app/cockpit/command-palette.tsx`

**Interfaces:**
- Consumes: `atomWithStorage` from `jotai/utils`.
- Produces: `paletteMruAtom` (a `string[]` storage atom), `MAX_MRU`, `MAX_RECENT`, `nextMru(prev, key)`, `sortByMru(items, mru)`, `recentItems(items, mru, limit)`.

Note: the write path is a pure `nextMru` applied through a functional atom update, so every test here is pure and needs no `localStorage` — which matters because vitest runs in the Node environment (no `environment` is set in `vite.config.ts`). Importing the module is nonetheless safe under Node: jotai's `atomWithStorage` degrades gracefully when `localStorage` is absent (verified by probe).

- [ ] **Step 1: Write the failing test**

Create `frontend/app/cockpit/palette-mru.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MAX_MRU, nextMru, recentItems, sortByMru } from "./palette-mru";

const it_ = (key: string) => ({ key });

describe("nextMru", () => {
    it("puts a new key at the front", () => {
        expect(nextMru(["a", "b"], "c")).toEqual(["c", "a", "b"]);
    });
    it("moves an existing key to the front without duplicating it", () => {
        expect(nextMru(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    });
    it("caps the list", () => {
        const full = Array.from({ length: MAX_MRU }, (_, i) => `k${i}`);
        const next = nextMru(full, "new");
        expect(next).toHaveLength(MAX_MRU);
        expect(next[0]).toBe("new");
        expect(next).not.toContain(`k${MAX_MRU - 1}`);
    });
});

describe("sortByMru", () => {
    it("floats recent items and leaves the rest in input order", () => {
        const items = [it_("a"), it_("b"), it_("c"), it_("d")];
        expect(sortByMru(items, ["c", "a"]).map((i) => i.key)).toEqual(["c", "a", "b", "d"]);
    });
    it("is a no-op with an empty history", () => {
        const items = [it_("a"), it_("b")];
        expect(sortByMru(items, []).map((i) => i.key)).toEqual(["a", "b"]);
    });
    it("does not mutate its input", () => {
        const items = [it_("a"), it_("b")];
        sortByMru(items, ["b"]);
        expect(items.map((i) => i.key)).toEqual(["a", "b"]);
    });
});

describe("recentItems", () => {
    it("resolves keys against the pool, in history order", () => {
        const items = [it_("a"), it_("b"), it_("c")];
        expect(recentItems(items, ["c", "a"], 5).map((i) => i.key)).toEqual(["c", "a"]);
    });
    it("drops history entries whose item no longer exists", () => {
        expect(recentItems([it_("a")], ["gone", "a"], 5).map((i) => i.key)).toEqual(["a"]);
    });
    it("honors the limit", () => {
        const items = [it_("a"), it_("b"), it_("c")];
        expect(recentItems(items, ["a", "b", "c"], 2).map((i) => i.key)).toEqual(["a", "b"]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/cockpit/palette-mru.test.ts`
Expected: FAIL — cannot resolve `./palette-mru`.

- [ ] **Step 3: Implement**

Create `frontend/app/cockpit/palette-mru.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// What the command palette remembers you using. A plain most-recently-used list rather than a frecency
// score: two effects, one stored array, and no decay constants to guess at. The write path is a pure
// function applied through a functional atom update, so everything here is unit-testable without
// localStorage.

import { atomWithStorage } from "jotai/utils";

export const MAX_MRU = 20;
export const MAX_RECENT = 5; // rows shown under the Recent group on an empty query

// atomWithStorage convention from themestore.ts / railstore.ts.
export const paletteMruAtom = atomWithStorage<string[]>("cockpit.palette.mru", []);

export function nextMru(prev: string[], key: string): string[] {
    return [key, ...prev.filter((k) => k !== key)].slice(0, MAX_MRU);
}

// Floats recently-used items to the front *before* ranking. Array.prototype.sort is stable, so items
// with no history keep their input order — which is what makes "the more recent row wins among equal
// fuzzy scores" true without adding a weighting term to the score itself.
export function sortByMru<T extends { key: string }>(items: T[], mru: string[]): T[] {
    const pos = new Map(mru.map((k, i) => [k, i]));
    const rank = (it: T) => pos.get(it.key) ?? Number.MAX_SAFE_INTEGER;
    return [...items].sort((a, b) => rank(a) - rank(b));
}

// Resolves history keys against the current pool, in history order, dropping keys whose item is gone.
export function recentItems<T extends { key: string }>(items: T[], mru: string[], limit: number): T[] {
    const byKey = new Map(items.map((it) => [it.key, it]));
    const out: T[] = [];
    for (const k of mru) {
        const found = byKey.get(k);
        if (found != null) {
            out.push(found);
        }
        if (out.length === limit) {
            break;
        }
    }
    return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/cockpit/palette-mru.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Wire it into the palette**

Add the import:

```ts
import { MAX_RECENT, nextMru, paletteMruAtom, recentItems, sortByMru } from "./palette-mru";
```

Read the atom beside the others: `const mru = useAtomValue(paletteMruAtom);`

Record on selection. In `onKeyDown`'s Enter branch (line 381-384) and in each plain/rich row's `onClick`, the row's own `run` already closes the palette — so record in one place instead by wrapping at the point of dispatch. Add above `onKeyDown`:

```ts
// Launch and ask rows are not recorded: their keys are generic ("launch:quick"), they never enter the
// ranked pool, and floating them would mean nothing.
const fire = (it: PaletteItem | undefined) => {
    if (it == null) {
        return;
    }
    if (!isRichGroup(it.kind)) {
        globalStore.set(paletteMruAtom, (prev) => nextMru(prev, it.key));
    }
    it.run();
};
```

Change the Enter branch to `fire(flat[selClamped]);` and both `onClick={() => it.run()}` handlers to `onClick={() => fire(it)}`.

Pre-sort the pool and resolve the Recent rows. In the default-scope branch, replace the `const ranked = ...` line with:

```ts
        const pool = sortByMru([...focusItems, ...items], mru);
        const ranked = rankPaletteItems(pool, query);
```

and change `recent: []` to `recent: recentItems(pool, mru, MAX_RECENT)`.

- [ ] **Step 6: Verify**

Run: `npx vitest run frontend/app/cockpit/`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 7: Verify recency in the running app**

Open the palette, run `Go to Memory`, reopen with `Ctrl+P` and confirm a **Recent** group leads the empty-query list with that row in it, and that the same row does not also appear under **Commands**. Reload the app (the palette's storage is `localStorage`, key `cockpit.palette.mru`) and confirm the Recent group survives.

If the dev app is not running, note that this step was skipped rather than marking it done.

---

### Task 9: Full verification and the single commit

**Files:** none — this task runs checks and commits everything.

- [ ] **Step 1: Run the whole frontend suite**

Run: `npx vitest run`
Expected: PASS. Report the actual pass/fail counts; do not claim success without the output.

- [ ] **Step 2: Typecheck the repo**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. The baseline is clean, so any error here belongs to this work.

- [ ] **Step 3: Lint the touched files**

Run: `npx eslint frontend/app/cockpit frontend/app/store/keybindings`
Expected: no new errors. Do not run `prettier --write` on `command-palette.tsx` or `bindings.ts` — it reorders imports and rewraps the whole file, turning a small diff into a several-hundred-line one.

- [ ] **Step 4: Self-review the diff**

Run: `git diff` and read it. Check for leftover debug statements, commented-out code, and any hand-written command row that should now come from the registry.

- [ ] **Step 5: Ask for approval, then commit**

Do not commit until the user approves. When they do, stage the code and both documents together — the spec and plan fold into the feature commit rather than landing as a docs-only commit:

```bash
git add frontend/app/cockpit frontend/app/store/keybindings \
        docs/superpowers/specs/2026-08-06-command-palette-reach-and-ranking-design.md \
        docs/superpowers/plans/2026-08-06-command-palette-reach-and-ranking.md
git commit -F <path-to-message-file>
```

Write the message to a temp file rather than using a here-string (this is a Windows environment; PowerShell here-string syntax inside the Bash tool corrupts multi-line messages). Subject line, following the repository's style of naming the defect and the fix:

```
feat(palette): Enter dispatched an agent whenever a channel was active, because the launch block led the list on any typed text; the palette now leads with what you named and dispatches only when you named nothing
```

---

## Self-Review

**Spec coverage.** Each of the spec's eleven resolved decisions maps to a task: the trailing act-on block and the launch-leads-on-prose rule (1) to Tasks 2-3; the density threshold (2) to Task 2; deriving commands from the registry (3) and the synthesized post-close context (4) to Task 6, wired in Task 7; the `paletteHidden` opt-out and label dedupe (5) to Tasks 5-6; the `Files`→`Diff` rename (6) to Task 5 step 6; the chordless extras (7) and the surface-before-atom ordering for New memory (8) to Tasks 6-7; the most-recently-used list (9) to Task 8; title-based highlighting (10) and the visible cap (11) to Task 4. The spec's rollout order is preserved: the safety fix (Tasks 1-3) lands before reach (5-7) and recency (8).

**Placeholder scan.** No "TBD", "handle edge cases", or "similar to Task N". The one value that looks like a stub — `recent: []` in Task 3 step 2 — is a real argument with a real meaning (no recency wired yet) and is replaced with data in Task 8 step 5 without changing the signature, which is why `recent` is in `DefaultGroupsInput` from the start.

**Type consistency.** `GroupKind` is defined once in Task 2 and imported by Tasks 3, 4 and 8. `PaletteGroup<T>` (Task 2) is the input to `capGroups` (Task 4), which returns `CappedGroup<T>`; Task 4 step 5 renames the component's render-time variable to `capped` so the two are never confused. `CommandItem.keys` (Task 6) is the field Task 7 step 4 passes to `formatChord`, and `PaletteItem.chord` is the field it lands in. `nextMru`/`sortByMru`/`recentItems` (Task 8) all key on `{key: string}`, which every `PaletteItem` and `GroupableItem` has.

**Known gap, deliberate.** The density threshold `MIN_MATCH_DENSITY = 0.5` is the one constant no test can validate as *correct* — the tests pin its two intended behaviors (a surface name is confident, a scattered prose match is not) but the boundary between them is a judgment call that only real use will settle. Task 3 step 5 exists to put a human in front of it.
