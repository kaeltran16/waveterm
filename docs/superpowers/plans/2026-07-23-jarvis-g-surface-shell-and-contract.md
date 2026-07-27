# Jarvis G — Plan 1: Surface shell + conversation view-model contract

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a navigable first-class `jarvis` cockpit surface that renders the second-brain conversation for its fixture-driven surface states (spec states 1–7, 11, 12), pinning the G ⇄ F conversation view-model contract before any backend exists.

**Architecture:** A new `frontend/app/view/jarvis/` namespace. A TS contract module (`jarviscontract.ts`) defines the view-model that F will later implement; hand-authored fixtures (`jarvisfixtures.ts`) exercise every branch. Pure view-model helpers (`recallderive.ts`) are unit-tested; presentational components (surface shell, conversation view, grounding rail, history rail, composer) are driven entirely by the store + fixtures and verified via the CDP `verify:ui` harness. A dev-only fixture switcher lets CDP cycle every state.

**Tech Stack:** React 19, jotai, Tailwind 4 (`@theme` tokens in `tailwindsetup.css`), `motion/react`, Vitest, the repo's CDP scenario harness (`scripts/cdp/`).

**This is Plan 1 of ~4 for sub-project G** (see the [G spec](../specs/2026-07-23-jarvis-ui-surface-design.md) §9):
- **Plan 1 (this):** surface shell + contract + surface states on fixtures. ← pins the seam.
- Plan 2: backend shim `JarvisConverseCommand` (Go) + wire Recall mode to real recall over SQLite.
- Plan 3: fleet-manager migration into the surface + Channels removal + `@jarvis` reroute.
- Plan 4: `Ctrl+P` "ask-jarvis" lead group + quick-ask states (8–10) + contextual entries + ambient fixtures.

## Global Constraints

Every task's requirements implicitly include these. Values copied verbatim from the spec and CLAUDE.md.

- **Dark mode only.** No light/Paper variant.
- **Preserve the 46px app bar and 78px nav rail.** Do not adopt the mockup's reduced rail — extend the real `ITEMS`/`ICON`.
- **Colors are `@theme` tokens** in `frontend/tailwindsetup.css` (e.g. `bg-background`, `text-secondary`, `border-border`, `text-accent`, `bg-accentbg`, `text-warning`, `text-error`, `text-success`). **Never raw hex/rgba** in components. The accent is `--color-accent: #7c95ff` (matches the mockup accent already).
- **Fonts:** use the cockpit's existing `--font-sans` / `--font-mono` (do not import the mockup's Hanken Grotesk / JetBrains Mono).
- **No new SCSS.** Tailwind utilities only.
- **Surface unmounts on nav-switch** (only the agent surface stays mounted). All survive-worthy state lives in module atoms in `jarvisstore.ts`, never component `useState`.
- **No jsdom render tests.** Pure logic → Vitest; rendering → CDP `verify:ui`. (Standing repo decision.)
- **Typecheck** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` overflows). Baseline is clean; any error it reports is yours.
- **Vitest** single file: `npx vitest run frontend/app/view/jarvis/<file>.test.ts`.
- **Git (per CLAUDE.md):** commits need explicit user approval and are batched — do NOT auto-commit or push. Treat each task's final step as **"stage + checkpoint for review"**; the actual commit happens once, with approval, at the end of the cycle (the plan/spec docs fold into that feature commit).
- **Do not hand-edit generated files** (`wshclientapi.ts`, `gotypes.d.ts`). Plan 1 has no backend; the contract is a plain TS module here and is replaced by generated Go→TS types in Plan 2.
- **Visual fidelity source:** `Wave-jarvis-second-brain.dc.html` (the `wave` Claude Design project) is the source of truth for exact spacing/treatment per state. This plan gives correct structure + tokens; reconcile pixel spacing against the matching mockup frame during each rendering task.

## File Structure

New (all under `frontend/app/view/jarvis/`):

| File | Responsibility |
|---|---|
| `jarviscontract.ts` | The conversation view-model TS types (the G ⇄ F seam). No logic. |
| `recallderive.ts` | Pure view-model helpers: segment interleaving, grounding grouping, age/freshness labels. Unit-tested. |
| `jarvisfixtures.ts` | Hand-authored fixtures: one `JarvisConversation` per surface state (1–7, 11, 12) + a `FIXTURE_STATES` index. |
| `jarvisstore.ts` | Module atoms: fixtures list, active conversation id, mode, grounding-rail open, active dev fixture. |
| `jarvissurface.tsx` | The three-region shell + mode switch; reads the store, composes the regions. |
| `conversationview.tsx` | Renders a `JarvisConversation`: turns, working steps, answer segments + `[n]` citations, terminals. |
| `groundingrail.tsx` | Grounding-rail content: source cards (type, title, project, age, freshness), expanded card, nav target. |
| `historyrail.tsx` | Conversation-history rail: list of conversations, active selection. |
| `composer.tsx` | Composer + scope chips (inert in Plan 1; sending wired in Plan 2). |
| `jarvisfixturebar.tsx` | Dev-only (`import.meta.env.DEV`) clickable fixture-state switcher for manual + CDP inspection. |
| `jarviscontract.test.ts` | Vitest: every fixture is well-formed against the contract invariants. |
| `recallderive.test.ts` | Vitest: the pure helpers. |

Modified:

| File | Change |
|---|---|
| `frontend/app/view/agents/agents.tsx` | Add `"jarvis"` to `SurfaceKey` union + insert into `SURFACE_ORDER`. |
| `frontend/app/view/agents/navrail.tsx` | Add `jarvis` to `ICON` + `ITEMS` (second position). |
| `frontend/app/view/agents/cockpitshell.tsx` | Import `JarvisSurface`; add the `surface === "jarvis"` branch. |
| `scripts/cdp/attach.mjs` | Add `jarvis: "Jarvis"` to `SURFACE_LABEL`. |
| `scripts/cdp/scenarios.mjs` | Add `jarvis` to `SMOKE_SURFACES`; add the `jarvis-states` scenario. |

---

### Task 1: Conversation view-model contract + fixtures

**Files:**
- Create: `frontend/app/view/jarvis/jarviscontract.ts`
- Create: `frontend/app/view/jarvis/jarvisfixtures.ts`
- Test: `frontend/app/view/jarvis/jarviscontract.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: the `JarvisConversation`, `JarvisTurn`, `JarvisAnswerTurn`, `WorkingStep`, `AnswerSegment`, `GroundingCard`, `JarvisScope`, `SourceRef`, `SourceType` types; `FIXTURES: Record<FixtureState, JarvisConversation>` and `FIXTURE_STATES: FixtureState[]`.

- [ ] **Step 1: Write the contract module**

Create `frontend/app/view/jarvis/jarviscontract.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Jarvis conversation view-model — the G ⇄ F seam (spec §"The seam"). G renders this for every
// state; F (Plan 2+) implements it. Plan 1 defines it as plain TS; Plan 2 replaces these with the
// Go-generated wire types once JarvisConverseCommand exists. Keep shapes minimal and additive.

export type SourceType =
    | "memory"
    | "decision"
    | "run"
    | "channel"
    | "radar"
    | "commit"
    | "agent"
    | "session"
    | "task";

export type Freshness = "fresh" | "stale" | "unavailable";
export type Terminal = "answered" | "weak" | "notfound";
export type StepStatus = "done" | "active" | "pending";
export type ScopeMode = "object" | "project" | "all" | "attached";

export interface SourceRef {
    oref: string; // ORef of the native object; the click target
    sourceType: SourceType;
    title: string;
}

export interface WorkingStep {
    id: string;
    label: string;
    status: StepStatus;
}

// A jarvis answer is a list of segments: prose text interleaved with citation references. A citationRef
// points at a GroundingCard.n in the same turn. Discriminated by the presence of `citationRef`.
export type AnswerSegment = { text: string } | { citationRef: number };

export interface GroundingCard {
    n: number; // citation index, referenced by AnswerSegment.citationRef
    sourceType: SourceType;
    title: string;
    project: string;
    ageMs: number; // age at synthesis time; rendered via recallderive.ageLabel
    freshness: Freshness;
    navTarget: string; // ORef opened in the native surface
    expanded?: boolean; // one card may be expanded (state 3)
}

export interface ScopeChip {
    label: string;
    active: boolean;
}

export interface JarvisScope {
    mode: ScopeMode;
    chips: ScopeChip[];
    attached: SourceRef[];
}

export interface JarvisUserTurn {
    role: "user";
    text: string;
    attachments: SourceRef[];
}

export interface JarvisAnswerTurn {
    role: "jarvis";
    workingSteps: WorkingStep[];
    segments: AnswerSegment[];
    grounding: GroundingCard[];
    terminal: Terminal;
}

export type JarvisTurn = JarvisUserTurn | JarvisAnswerTurn;

export interface JarvisConversation {
    id: string;
    title: string;
    turns: JarvisTurn[];
    scope: JarvisScope;
}

export function isAnswerTurn(t: JarvisTurn): t is JarvisAnswerTurn {
    return t.role === "jarvis";
}

export function isCitation(s: AnswerSegment): s is { citationRef: number } {
    return "citationRef" in s;
}
```

- [ ] **Step 2: Write the fixtures module**

Create `frontend/app/view/jarvis/jarvisfixtures.ts`. Nine fixtures, one per surface state this plan renders. Content is believable-but-fabricated (spec/UI-brief rule: read as placeholders).

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Hand-authored Jarvis conversation fixtures — one per surface state (spec states 1-7, 11, 12). They
// exercise every branch of the view-model so the contract is validated before F exists (Plan 2 swaps
// the source, not the shape). Content is fabricated placeholder data, not real project claims.

import type { GroundingCard, JarvisConversation, JarvisScope } from "./jarviscontract";

export type FixtureState =
    | "empty" // 1: first use, no conversations
    | "active" // 2: active multi-turn
    | "grounded" // 3: grounded answer, mixed sources, one expanded
    | "working" // 4: retrieval activity while streaming
    | "weak" // 5: weak grounding
    | "notfound" // 6: not found
    | "stale" // 7: source unavailable / stale
    | "contextual" // 11: contextual invocation from a Run
    | "narrow"; // 12: narrow window (same data as grounded; layout differs)

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const defaultScope: JarvisScope = {
    mode: "all",
    chips: [
        { label: "This project", active: false },
        { label: "All Wave", active: true },
    ],
    attached: [],
};

const card = (n: number, over: Partial<GroundingCard>): GroundingCard => ({
    n,
    sourceType: "decision",
    title: "Untitled source",
    project: "waveterm",
    ageMs: 2 * DAY,
    freshness: "fresh",
    navTarget: `run:00000000-0000-0000-0000-00000000000${n}`,
    ...over,
});

const empty: JarvisConversation = { id: "empty", title: "New conversation", turns: [], scope: defaultScope };

const active: JarvisConversation = {
    id: "active",
    title: "Channel scaling — where we left off",
    scope: defaultScope,
    turns: [
        { role: "user", text: "Where did we leave the channel-scaling work?", attachments: [] },
        {
            role: "jarvis",
            workingSteps: [{ id: "s1", label: "Searched decisions + runs", status: "done" }],
            terminal: "answered",
            grounding: [card(1, { sourceType: "run", title: "Run: shard channel fan-out", ageMs: 3 * DAY })],
            segments: [
                { text: "You paused after landing the fan-out sharding " },
                { citationRef: 1 },
                { text: ". The open thread was back-pressure on slow subscribers." },
            ],
        },
        { role: "user", text: "What was the back-pressure decision?", attachments: [] },
        {
            role: "jarvis",
            workingSteps: [{ id: "s2", label: "Traversed decision → run", status: "done" }],
            terminal: "answered",
            grounding: [card(1, { sourceType: "decision", title: "Decision: drop-oldest on overflow", ageMs: 2 * DAY })],
            segments: [{ text: "Drop-oldest on overflow, chosen over blocking " }, { citationRef: 1 }, { text: "." }],
        },
    ],
};

const grounded: JarvisConversation = {
    id: "grounded",
    title: "Why avoid per-run worktrees?",
    scope: defaultScope,
    turns: [
        { role: "user", text: "Why did we avoid per-run worktrees?", attachments: [] },
        {
            role: "jarvis",
            workingSteps: [
                { id: "s1", label: "Structured query: decisions", status: "done" },
                { id: "s2", label: "Full-text: 'worktree'", status: "done" },
                { id: "s3", label: "Traversed decision → run → commit", status: "done" },
            ],
            terminal: "answered",
            grounding: [
                card(1, { sourceType: "decision", title: "Decision: shared working tree", ageMs: 5 * DAY, expanded: true }),
                card(2, { sourceType: "run", title: "Run: worktree spike", ageMs: 6 * DAY }),
                card(3, { sourceType: "commit", title: "commit a779ac2a", ageMs: 6 * DAY, project: "waveterm" }),
                card(4, { sourceType: "memory", title: "EnterWorktree baseRef gotcha", ageMs: 12 * DAY }),
            ],
            segments: [
                { text: "Per-run worktrees were rejected because they branch from a stale origin " },
                { citationRef: 1 },
                { text: ", which the spike confirmed " },
                { citationRef: 2 },
                { text: " and the gotcha note captured " },
                { citationRef: 4 },
                { text: "." },
            ],
        },
    ],
};

const working: JarvisConversation = {
    id: "working",
    title: "What do recent Radar findings have in common?",
    scope: defaultScope,
    turns: [
        { role: "user", text: "What do the recent Radar findings have in common?", attachments: [] },
        {
            role: "jarvis",
            workingSteps: [
                { id: "s1", label: "Structured query: radar findings (7d)", status: "done" },
                { id: "s2", label: "Full-text across evidence", status: "active" },
                { id: "s3", label: "Synthesize common thread", status: "pending" },
            ],
            terminal: "answered",
            grounding: [card(1, { sourceType: "radar", title: "Finding: retry storm", ageMs: 1 * DAY })],
            segments: [{ text: "Reading the findings…" }],
        },
    ],
};

const weak: JarvisConversation = {
    id: "weak",
    title: "Did we decide on a rate-limit backoff curve?",
    scope: defaultScope,
    turns: [
        { role: "user", text: "Did we decide on a rate-limit backoff curve?", attachments: [] },
        {
            role: "jarvis",
            workingSteps: [{ id: "s1", label: "Searched decisions + memory", status: "done" }],
            terminal: "weak",
            grounding: [
                card(1, { sourceType: "memory", title: "wshrpc 5s budget note", ageMs: 9 * DAY, freshness: "fresh" }),
            ],
            segments: [
                { text: "No confirmed decision found. The closest candidate is a timeout-budget note " },
                { citationRef: 1 },
                { text: ", but it does not specify a backoff curve — treat as weak." },
            ],
        },
    ],
};

const notfound: JarvisConversation = {
    id: "notfound",
    title: "What is the Kafka partition count?",
    scope: defaultScope,
    turns: [
        { role: "user", text: "What partition count did we pick for Kafka?", attachments: [] },
        {
            role: "jarvis",
            workingSteps: [{ id: "s1", label: "Structured + full-text search", status: "done" }],
            terminal: "notfound",
            grounding: [],
            segments: [{ text: "Not found. No Wave source references Kafka or a partition count." }],
        },
    ],
};

const stale: JarvisConversation = {
    id: "stale",
    title: "Status of the migration run",
    scope: defaultScope,
    turns: [
        { role: "user", text: "Is the migration run still green?", attachments: [] },
        {
            role: "jarvis",
            workingSteps: [{ id: "s1", label: "Resolved run status at synthesis", status: "done" }],
            terminal: "answered",
            grounding: [
                card(1, { sourceType: "run", title: "Run: schema migration", ageMs: 20 * DAY, freshness: "stale" }),
                card(2, { sourceType: "session", title: "Session: nightly deploy", ageMs: 40 * DAY, freshness: "unavailable" }),
            ],
            segments: [
                { text: "The last recorded status was green " },
                { citationRef: 1 },
                { text: ", but that source is stale; the originating session is no longer available " },
                { citationRef: 2 },
                { text: "." },
            ],
        },
    ],
};

const contextual: JarvisConversation = {
    id: "contextual",
    title: "About this Run",
    scope: {
        mode: "attached",
        chips: [{ label: "This Run", active: true }],
        attached: [{ oref: "run:11111111-1111-1111-1111-111111111111", sourceType: "run", title: "Run: recolor runtime pills" }],
    },
    turns: [
        {
            role: "user",
            text: "What changed in this Run and why?",
            attachments: [{ oref: "run:11111111-1111-1111-1111-111111111111", sourceType: "run", title: "Run: recolor runtime pills" }],
        },
        {
            role: "jarvis",
            workingSteps: [{ id: "s1", label: "Read run evidence + linked decision", status: "done" }],
            terminal: "answered",
            grounding: [
                card(1, { sourceType: "run", title: "Run: recolor runtime pills", ageMs: 4 * HOUR }),
                card(2, { sourceType: "decision", title: "Decision: trademark pill colors", ageMs: 5 * HOUR }),
            ],
            segments: [
                { text: "This Run recolored the Claude/Codex pills to trademark colors " },
                { citationRef: 1 },
                { text: ", per the decision to match brand palettes " },
                { citationRef: 2 },
                { text: "." },
            ],
        },
    ],
};

// state 12 (narrow) renders the grounded conversation; only the layout differs, driven by the rail atom.
export const FIXTURES: Record<FixtureState, JarvisConversation> = {
    empty,
    active,
    grounded,
    working,
    weak,
    notfound,
    stale,
    contextual,
    narrow: { ...grounded, id: "narrow", title: "Narrow — why avoid per-run worktrees?" },
};

export const FIXTURE_STATES: FixtureState[] = [
    "empty",
    "active",
    "grounded",
    "working",
    "weak",
    "notfound",
    "stale",
    "contextual",
    "narrow",
];
```

- [ ] **Step 3: Write the failing contract test**

Create `frontend/app/view/jarvis/jarviscontract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isAnswerTurn, isCitation } from "./jarviscontract";
import { FIXTURES, FIXTURE_STATES } from "./jarvisfixtures";

describe("jarvis fixtures satisfy the contract", () => {
    it("exposes one fixture per declared state", () => {
        for (const state of FIXTURE_STATES) {
            expect(FIXTURES[state]).toBeDefined();
        }
        expect(Object.keys(FIXTURES).sort()).toEqual([...FIXTURE_STATES].sort());
    });

    it("every citationRef resolves to a grounding card in the same turn", () => {
        for (const conv of Object.values(FIXTURES)) {
            for (const turn of conv.turns) {
                if (!isAnswerTurn(turn)) continue;
                const ns = new Set(turn.grounding.map((g) => g.n));
                for (const seg of turn.segments) {
                    if (isCitation(seg)) expect(ns.has(seg.citationRef)).toBe(true);
                }
            }
        }
    });

    it("notfound turns carry no grounding; weak turns carry at least one candidate", () => {
        const nf = FIXTURES.notfound.turns.find(isAnswerTurn)!;
        expect(nf.terminal).toBe("notfound");
        expect(nf.grounding).toHaveLength(0);
        const wk = FIXTURES.weak.turns.find(isAnswerTurn)!;
        expect(wk.terminal).toBe("weak");
        expect(wk.grounding.length).toBeGreaterThan(0);
    });

    it("the stale fixture surfaces stale/unavailable freshness (not hidden)", () => {
        const turn = FIXTURES.stale.turns.find(isAnswerTurn)!;
        const freshnesses = turn.grounding.map((g) => g.freshness);
        expect(freshnesses).toContain("stale");
        expect(freshnesses).toContain("unavailable");
    });

    it("the empty fixture has no turns", () => {
        expect(FIXTURES.empty.turns).toHaveLength(0);
    });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/jarviscontract.test.ts`
Expected: PASS (5 tests). If a citationRef assertion fails, fix the offending fixture's `grounding`/`segments` — the fixtures are the code under test here.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Stage + checkpoint** (`git add` the three new files; do not commit — see Global Constraints).

---

### Task 2: Pure view-model helpers

**Files:**
- Create: `frontend/app/view/jarvis/recallderive.ts`
- Test: `frontend/app/view/jarvis/recallderive.test.ts`

**Interfaces:**
- Consumes: `AnswerSegment`, `GroundingCard`, `Freshness` from `jarviscontract.ts`.
- Produces: `ageLabel(ageMs: number): string`, `freshnessLabel(f: Freshness): string`, `groundingByN(cards: GroundingCard[]): Map<number, GroundingCard>`, `citedNs(segments: AnswerSegment[]): number[]`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/recallderive.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AnswerSegment, GroundingCard } from "./jarviscontract";
import { ageLabel, citedNs, freshnessLabel, groundingByN } from "./recallderive";

describe("ageLabel", () => {
    it("renders coarse relative ages", () => {
        expect(ageLabel(30_000)).toBe("just now");
        expect(ageLabel(5 * 60_000)).toBe("5m ago");
        expect(ageLabel(3 * 3_600_000)).toBe("3h ago");
        expect(ageLabel(2 * 86_400_000)).toBe("2d ago");
    });
});

describe("freshnessLabel", () => {
    it("maps freshness to human copy", () => {
        expect(freshnessLabel("fresh")).toBe("Fresh");
        expect(freshnessLabel("stale")).toBe("Stale");
        expect(freshnessLabel("unavailable")).toBe("Unavailable");
    });
});

describe("groundingByN", () => {
    it("indexes cards by citation number", () => {
        const cards: GroundingCard[] = [
            { n: 1, sourceType: "run", title: "a", project: "p", ageMs: 0, freshness: "fresh", navTarget: "run:1" },
            { n: 2, sourceType: "decision", title: "b", project: "p", ageMs: 0, freshness: "fresh", navTarget: "dec:2" },
        ];
        const m = groundingByN(cards);
        expect(m.get(2)?.title).toBe("b");
        expect(m.size).toBe(2);
    });
});

describe("citedNs", () => {
    it("returns the distinct citation refs in order of first appearance", () => {
        const segs: AnswerSegment[] = [{ text: "x" }, { citationRef: 2 }, { text: "y" }, { citationRef: 1 }, { citationRef: 2 }];
        expect(citedNs(segs)).toEqual([2, 1]);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/recallderive.test.ts`
Expected: FAIL (`recallderive` has no such exports / module not found).

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/jarvis/recallderive.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure, deterministic view-model helpers for the Jarvis recall surface. No React, no atoms — testable
// in isolation. Rendering components import these; they never re-derive copy inline.

import type { AnswerSegment, Freshness, GroundingCard } from "./jarviscontract";
import { isCitation } from "./jarviscontract";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function ageLabel(ageMs: number): string {
    if (ageMs < MIN) return "just now";
    if (ageMs < HOUR) return `${Math.floor(ageMs / MIN)}m ago`;
    if (ageMs < DAY) return `${Math.floor(ageMs / HOUR)}h ago`;
    return `${Math.floor(ageMs / DAY)}d ago`;
}

export function freshnessLabel(f: Freshness): string {
    switch (f) {
        case "fresh":
            return "Fresh";
        case "stale":
            return "Stale";
        case "unavailable":
            return "Unavailable";
    }
}

export function groundingByN(cards: GroundingCard[]): Map<number, GroundingCard> {
    return new Map(cards.map((c) => [c.n, c]));
}

export function citedNs(segments: AnswerSegment[]): number[] {
    const seen: number[] = [];
    for (const s of segments) {
        if (isCitation(s) && !seen.includes(s.citationRef)) seen.push(s.citationRef);
    }
    return seen;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/recallderive.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck** (`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`, expect exit 0), then **stage + checkpoint**.

---

### Task 3: Store — module atoms

**Files:**
- Create: `frontend/app/view/jarvis/jarvisstore.ts`

**Interfaces:**
- Consumes: `FixtureState`, `FIXTURES` from `jarvisfixtures.ts`; `JarvisConversation` from `jarviscontract.ts`.
- Produces atoms: `jarvisModeAtom` (`"recall" | "fleet"`), `activeFixtureAtom` (`FixtureState`), `groundingRailOpenAtom` (persisted bool), `activeConversationAtom` (derived read-only `JarvisConversation`), `conversationsAtom` (derived list for the history rail).

- [ ] **Step 1: Write the store**

Create `frontend/app/view/jarvis/jarvisstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Jarvis surface state. The surface UNMOUNTS on nav-switch (only the agent surface stays mounted), so
// every survive-worthy value lives here as a module atom, never component useState. In Plan 1 the
// conversation source is the fixtures; Plan 2 replaces activeConversationAtom's source with the real
// backend behind the same reads.

import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { JarvisConversation } from "./jarviscontract";
import { FIXTURES, FIXTURE_STATES, type FixtureState } from "./jarvisfixtures";

export type JarvisMode = "recall" | "fleet";

// session-scoped: which mode the surface shows. Fleet mode is a placeholder in Plan 1 (migrated in Plan 3).
export const jarvisModeAtom = atom<JarvisMode>("recall");

// which fixture the surface renders. In Plan 2+ this is superseded by a real active-conversation id;
// kept in Plan 1 as the single source that the dev fixture bar and CDP drive.
export const activeFixtureAtom = atom<FixtureState>("empty");

// grounding rail expanded state — persisted, default collapsed so narrow panes keep conversation width
// (mirrors channelRailOpenAtom in railstore.ts). "narrow" state == this collapsed on a small viewport.
export const groundingRailOpenAtom = atomWithStorage("jarvis.grounding.open", false);

// read-only: the conversation currently shown. Source is fixtures in Plan 1.
export const activeConversationAtom = atom<JarvisConversation>((get) => FIXTURES[get(activeFixtureAtom)]);

// read-only: the history-rail list. In Plan 1 this is the fixture set (excluding the "narrow" alias so a
// state does not appear twice); Plan 2 replaces it with persisted conversations.
export const conversationsAtom = atom<JarvisConversation[]>(() =>
    FIXTURE_STATES.filter((s) => s !== "narrow").map((s) => FIXTURES[s])
);
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (No unit test — this is atom wiring with no logic; it is exercised by the CDP scenario in Task 8.)

- [ ] **Step 3: Stage + checkpoint.**

---

### Task 4: Nav integration — the surface is reachable and renders

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx` (SurfaceKey union ~line 29; `SURFACE_ORDER` ~line 41)
- Modify: `frontend/app/view/agents/navrail.tsx` (`ICON` ~line 25; `ITEMS` ~line 37)
- Modify: `frontend/app/view/agents/cockpitshell.tsx` (imports ~line 15; switch ~line 100)
- Modify: `scripts/cdp/attach.mjs` (`SURFACE_LABEL` ~line 12)
- Create (stub, replaced in Task 5): `frontend/app/view/jarvis/jarvissurface.tsx`

**Interfaces:**
- Consumes: `AgentsViewModel` (for the `{ model }` prop shape).
- Produces: `JarvisSurface({ model }: { model: AgentsViewModel })` (stub now; full in Task 5); `"jarvis"` as a `SurfaceKey`.

- [ ] **Step 1: Add `"jarvis"` to the `SurfaceKey` union and `SURFACE_ORDER`**

In `frontend/app/view/agents/agents.tsx`, change the union (insert after `"cockpit"`):

```ts
export type SurfaceKey =
    | "cockpit"
    | "jarvis"
    | "agent"
    | "channels"
    | "radar"
    | "sessions"
    | "files"
    | "memory"
    | "usage"
    | "settings";
```

And `SURFACE_ORDER` (insert `"jarvis"` second, so Ctrl+2 selects it — accepted renumber of the rest):

```ts
export const SURFACE_ORDER: SurfaceKey[] = [
    "cockpit",
    "jarvis",
    "agent",
    "channels",
    "radar",
    "sessions",
    "files",
    "memory",
    "usage",
];
```

- [ ] **Step 2: Add the icon + nav item**

In `frontend/app/view/agents/navrail.tsx`, add `Brain` to the lucide import line and the `ICON` record + `ITEMS` array. The import (add `Brain`, keep alphabetical-ish with the rest):

```ts
import {
    Bot,
    Brain,
    Gauge,
    GitCompare,
    LayoutDashboard,
    MessagesSquare,
    Network,
    Radar,
    Settings,
    SquareStack,
} from "lucide-react";
```

`ICON` (add the `jarvis` key):

```ts
export const ICON: Record<SurfaceKey, ReactNode> = {
    cockpit: <LayoutDashboard {...iconProps} />,
    jarvis: <Brain {...iconProps} />,
    agent: <Bot {...iconProps} />,
    channels: <MessagesSquare {...iconProps} />,
    radar: <Radar {...iconProps} />,
    sessions: <SquareStack {...iconProps} />,
    files: <GitCompare {...iconProps} />,
    memory: <Network {...iconProps} />,
    usage: <Gauge {...iconProps} />,
    settings: <Settings {...iconProps} />,
};
```

`ITEMS` (insert second):

```ts
export const ITEMS: { key: SurfaceKey; label: string }[] = [
    { key: "cockpit", label: "Cockpit" },
    { key: "jarvis", label: "Jarvis" },
    { key: "agent", label: "Agent" },
    { key: "channels", label: "Channels" },
    { key: "radar", label: "Radar" },
    { key: "sessions", label: "Sessions" },
    { key: "files", label: "Diff" },
    { key: "memory", label: "Memory" },
    { key: "usage", label: "Usage" },
];
```

- [ ] **Step 3: Create the surface stub**

Create `frontend/app/view/jarvis/jarvissurface.tsx` (minimal now; Task 5 fills it in). It must render non-empty text so the CDP smoke passes.

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentsViewModel } from "@/app/view/agents/agents";

export function JarvisSurface({ model: _model }: { model: AgentsViewModel }) {
    return (
        <div className="flex h-full w-full items-center justify-center bg-background text-secondary">
            Jarvis
        </div>
    );
}
```

- [ ] **Step 4: Wire the switch**

In `frontend/app/view/agents/cockpitshell.tsx`, add the import (with the other surface imports):

```ts
import { JarvisSurface } from "@/app/view/jarvis/jarvissurface";
```

And add the branch in the switch (place it right after the `cockpit` branch):

```tsx
{surface === "cockpit" ? (
    <CockpitSurface model={model} />
) : surface === "jarvis" ? (
    <JarvisSurface model={model} />
) : surface === "channels" ? (
```

- [ ] **Step 5: Register the CDP label**

In `scripts/cdp/attach.mjs`, add to `SURFACE_LABEL` (insert after `cockpit`):

```js
export const SURFACE_LABEL = {
    cockpit: "Cockpit",
    jarvis: "Jarvis",
    agent: "Agent",
    channels: "Channels",
    radar: "Radar",
    sessions: "Sessions",
    files: "Diff",
    memory: "Memory",
    usage: "Usage",
    settings: "Settings",
};
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. The `Record<SurfaceKey, ReactNode>` on `ICON` guarantees a compile error if the icon key was missed — a clean typecheck confirms all switch/record sites are covered.

- [ ] **Step 7: Manual/CDP smoke (dev app must be running: `task dev`)**

Run: `node scripts/cdp-shot.mjs cdp-shots/jarvis-nav.png` after clicking Jarvis, or simply confirm via the running app that a "Jarvis" nav item appears second and selecting it shows the centered "Jarvis" text. (A full CDP scenario lands in Task 8.)

- [ ] **Step 8: Stage + checkpoint.**

---

### Task 5: Surface shell — three regions + mode switch

**Files:**
- Modify: `frontend/app/view/jarvis/jarvissurface.tsx` (replace the stub)
- Create: `frontend/app/view/jarvis/historyrail.tsx`
- Create: `frontend/app/view/jarvis/composer.tsx`

**Interfaces:**
- Consumes: store atoms from Task 3; `SurfaceHeader` from `@/app/view/agents/surfacescaffold`; `ConversationView` from `./conversationview` (Task 6) and `GroundingRail` from `./groundingrail` (Task 7) — **create thin placeholders now if implementing Task 5 before 6/7** (see note); `AgentsViewModel`.
- Produces: `JarvisSurface`, `HistoryRail`, `Composer`.

> Implementation note: Tasks 5–7 are mutually referential presentational components. Implement them in order 6 → 7 → 5, OR create one-line placeholder exports for `ConversationView`/`GroundingRail` first and fill them in Tasks 6/7. The steps below assume 6 and 7 exist.

- [ ] **Step 1: History rail**

Create `frontend/app/view/jarvis/historyrail.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { conversationsAtom, activeFixtureAtom } from "./jarvisstore";
import { FIXTURE_STATES, type FixtureState } from "./jarvisfixtures";

// Left conversation-history rail. In Plan 1 rows map 1:1 to fixture conversations; selecting one sets
// the active fixture. Plan 2 replaces the id mapping with real conversation ids.
export function HistoryRail() {
    const convs = useAtomValue(conversationsAtom);
    const [active, setActive] = useAtom(activeFixtureAtom);
    const stateById = new Map<string, FixtureState>(
        FIXTURE_STATES.filter((s) => s !== "narrow").map((s) => [s, s])
    );
    return (
        <nav className="flex w-[240px] shrink-0 flex-col border-r border-border bg-surface" aria-label="Conversations">
            <div className="px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">Conversations</div>
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
                {convs.map((c) => {
                    const state = stateById.get(c.id);
                    const isActive = state === active;
                    return (
                        <button
                            key={c.id}
                            type="button"
                            onClick={() => state && setActive(state)}
                            className={cn(
                                "cursor-pointer truncate rounded-[8px] px-3 py-2 text-left text-[13px] text-ink-mid hover:bg-surface-hover hover:text-secondary",
                                isActive && "bg-accentbg text-accent-soft"
                            )}
                        >
                            {c.title}
                        </button>
                    );
                })}
            </div>
        </nav>
    );
}
```

- [ ] **Step 2: Composer (inert)**

Create `frontend/app/view/jarvis/composer.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { activeConversationAtom } from "./jarvisstore";

// Composer + scope chips. Inert in Plan 1 (no send); Plan 2 wires submit → JarvisConverseCommand. Scope
// chips render the active conversation's scope so "what will Jarvis look at?" is always visible.
export function Composer() {
    const conv = useAtomValue(activeConversationAtom);
    return (
        <div className="flex-none border-t border-border bg-background px-6 py-4">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {conv.scope.chips.map((chip) => (
                    <span
                        key={chip.label}
                        className={cn(
                            "rounded-full border px-2.5 py-0.5 text-[11.5px]",
                            chip.active
                                ? "border-accent/40 bg-accentbg text-accent-soft"
                                : "border-border text-ink-mid"
                        )}
                    >
                        {chip.label}
                    </span>
                ))}
            </div>
            <div className="flex items-center gap-2 rounded-[10px] border border-edge-mid bg-surface px-3.5 py-2.5">
                <input
                    disabled
                    placeholder="Ask Jarvis…  (sending arrives in Plan 2)"
                    className="min-w-0 flex-1 bg-transparent text-[14px] text-secondary placeholder:text-muted focus:outline-none"
                />
            </div>
        </div>
    );
}
```

- [ ] **Step 3: The surface shell**

Replace `frontend/app/view/jarvis/jarvissurface.tsx` entirely:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Jarvis cockpit surface: three regions (history rail · conversation · grounding rail) with a mode
// switch (Recall / Fleet). Fleet mode is a placeholder in Plan 1 (migrated in Plan 3). All state lives
// in jarvisstore atoms because this surface unmounts on nav-switch.

import { SurfaceHeader } from "@/app/view/agents/surfacescaffold";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { Composer } from "./composer";
import { ConversationView } from "./conversationview";
import { GroundingRail } from "./groundingrail";
import { HistoryRail } from "./historyrail";
import { JarvisFixtureBar } from "./jarvisfixturebar";
import { activeConversationAtom, jarvisModeAtom } from "./jarvisstore";

export function JarvisSurface({ model: _model }: { model: AgentsViewModel }) {
    const [mode, setMode] = useAtom(jarvisModeAtom);
    const conv = useAtomValue(activeConversationAtom);
    return (
        <div className="flex h-full w-full flex-col bg-background">
            <SurfaceHeader
                title="Jarvis"
                actions={
                    <div className="flex items-center gap-1 rounded-[9px] border border-border bg-surface p-0.5">
                        {(["recall", "fleet"] as const).map((m) => (
                            <button
                                key={m}
                                type="button"
                                onClick={() => setMode(m)}
                                className={cn(
                                    "cursor-pointer rounded-[7px] px-3 py-1 text-[12.5px] font-semibold capitalize",
                                    mode === m ? "bg-accentbg text-accent-soft" : "text-ink-mid hover:text-secondary"
                                )}
                            >
                                {m}
                            </button>
                        ))}
                    </div>
                }
            />
            <JarvisFixtureBar />
            {mode === "fleet" ? (
                <div className="flex flex-1 items-center justify-center text-[13px] text-muted">
                    Fleet manager — migrated in Plan 3.
                </div>
            ) : (
                <div className="flex min-h-0 flex-1">
                    <HistoryRail />
                    <div className="flex min-w-0 flex-1 flex-col">
                        <div className="min-h-0 flex-1 overflow-y-auto">
                            <ConversationView conversation={conv} />
                        </div>
                        <Composer />
                    </div>
                    <GroundingRail conversation={conv} />
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (requires Tasks 6, 7, and the fixture bar in Task 8 to exist or have placeholders — see the implementation note; if building 5 first, add one-line placeholder exports and typecheck after 6/7/8).

- [ ] **Step 5: Stage + checkpoint.**

---

### Task 6: ConversationView — turns, working steps, segments + citations, terminals

**Files:**
- Create: `frontend/app/view/jarvis/conversationview.tsx`

**Interfaces:**
- Consumes: `JarvisAnswerTurn`, `JarvisConversation`, `JarvisTurn`, `isAnswerTurn`, `isCitation` from `jarviscontract`; `groundingByN` from `recallderive`; `SurfaceEmptyState` from `@/app/view/agents/surfacescaffold`.
- Produces: `ConversationView({ conversation }: { conversation: JarvisConversation })`.

- [ ] **Step 1: Build the component**

Create `frontend/app/view/jarvis/conversationview.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Renders one JarvisConversation. The visual center of gravity (spec). Handles user + jarvis turns,
// streamed working-steps (done/active/pending), answer segments interleaved with [n] citations, and the
// three terminals (answered / weak / not-found). One renderer, many states — the 12 fixtures exercise it.

import { SurfaceEmptyState } from "@/app/view/agents/surfacescaffold";
import { cn } from "@/util/util";
import { Brain } from "lucide-react";
import type { JarvisAnswerTurn, JarvisConversation, JarvisTurn } from "./jarviscontract";
import { isAnswerTurn, isCitation } from "./jarviscontract";
import { groundingByN } from "./recallderive";

function WorkingSteps({ turn }: { turn: JarvisAnswerTurn }) {
    if (turn.workingSteps.length === 0) return null;
    return (
        <ul className="mb-3 flex flex-col gap-1 rounded-[9px] border border-border bg-surface px-3 py-2">
            {turn.workingSteps.map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-[12px]">
                    <span
                        className={cn(
                            "inline-block h-1.5 w-1.5 rounded-full",
                            s.status === "done" && "bg-success",
                            s.status === "active" && "bg-accent",
                            s.status === "pending" && "bg-ink-faint"
                        )}
                    />
                    <span className={cn(s.status === "pending" ? "text-muted" : "text-ink-mid")}>{s.label}</span>
                </li>
            ))}
        </ul>
    );
}

function Answer({ turn }: { turn: JarvisAnswerTurn }) {
    const byN = groundingByN(turn.grounding);
    return (
        <div className="max-w-[720px]">
            <WorkingSteps turn={turn} />
            {turn.terminal === "notfound" ? (
                <div className="mb-2 inline-flex items-center gap-2 rounded-[7px] border border-border px-2.5 py-1 text-[11.5px] font-semibold text-muted">
                    Not found
                </div>
            ) : turn.terminal === "weak" ? (
                <div className="mb-2 inline-flex items-center gap-2 rounded-[7px] border border-warning/40 bg-warning/10 px-2.5 py-1 text-[11.5px] font-semibold text-warning">
                    Weak grounding
                </div>
            ) : null}
            <p className="text-[14.5px] leading-[1.65] text-secondary">
                {turn.segments.map((seg, i) => {
                    if (!isCitation(seg)) return <span key={i}>{seg.text}</span>;
                    const card = byN.get(seg.citationRef);
                    return (
                        <button
                            key={i}
                            type="button"
                            title={card ? `${card.title} — open source` : undefined}
                            onClick={() => card && console.log("[jarvis] open source", card.navTarget)}
                            className="mx-0.5 inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-[5px] bg-accentbg px-1 align-baseline text-[10.5px] font-bold text-accent-soft hover:bg-accent/25"
                        >
                            {seg.citationRef}
                        </button>
                    );
                })}
            </p>
        </div>
    );
}

function UserTurn({ text }: { text: string }) {
    return (
        <div className="flex justify-end">
            <div className="max-w-[560px] rounded-[12px] bg-surface-raised px-3.5 py-2 text-[14px] text-primary">{text}</div>
        </div>
    );
}

export function ConversationView({ conversation }: { conversation: JarvisConversation }) {
    if (conversation.turns.length === 0) {
        return (
            <SurfaceEmptyState
                glyph={<Brain size={40} strokeWidth={1.6} className="mb-4 text-accent" />}
                title="Ask Jarvis"
                body="Recall what happened, recover context, or understand why a decision was made — grounded in your Wave knowledge."
            />
        );
    }
    return (
        <div className="mx-auto flex max-w-[900px] flex-col gap-6 px-8 py-8">
            {conversation.turns.map((turn: JarvisTurn, i) =>
                isAnswerTurn(turn) ? (
                    <div key={i} className="flex gap-3">
                        <Brain size={18} strokeWidth={1.8} className="mt-1 shrink-0 text-accent" />
                        <Answer turn={turn} />
                    </div>
                ) : (
                    <UserTurn key={i} text={turn.text} />
                )
            )}
        </div>
    );
}
```

> Note: the `[n]` citation click logs to the console in Plan 1. Plan 4 replaces it with real native-surface navigation (open the cited `navTarget`'s ORef via the model), and this is the single wiring point for that change.

- [ ] **Step 2: Typecheck + lint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (exit 0) and `npx eslint frontend/app/view/jarvis/conversationview.tsx` (no errors; delete any unused imports).

- [ ] **Step 3: Stage + checkpoint.**

---

### Task 7: GroundingRail — source cards, freshness, expanded, nav target

**Files:**
- Create: `frontend/app/view/jarvis/groundingrail.tsx`

**Interfaces:**
- Consumes: `JarvisConversation`, `GroundingCard`, `isAnswerTurn` from `jarviscontract`; `ageLabel`, `freshnessLabel` from `recallderive`; `groundingRailOpenAtom` from `jarvisstore`; `CollapsibleRail` + `RailSection` from `@/app/element/collapsiblerail`.
- Produces: `GroundingRail({ conversation }: { conversation: JarvisConversation })`.

- [ ] **Step 1: Build the component**

Create `frontend/app/view/jarvis/groundingrail.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Right grounding rail. Shows the grounding cards of the conversation's latest jarvis turn: source type,
// title, project, age, freshness. One card may be expanded. Freshness (stale/unavailable) is surfaced,
// not hidden (spec invariant 7). Uses the shared CollapsibleRail (300/44px), persisted-collapsed by
// default so narrow panes keep conversation width (== spec state 12, narrow window).

import { CollapsibleRail, type RailSection } from "@/app/element/collapsiblerail";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { BookMarked } from "lucide-react";
import type { GroundingCard, JarvisConversation } from "./jarviscontract";
import { isAnswerTurn } from "./jarviscontract";
import { ageLabel, freshnessLabel } from "./recallderive";
import { groundingRailOpenAtom } from "./jarvisstore";

function freshnessClass(f: GroundingCard["freshness"]): string {
    switch (f) {
        case "fresh":
            return "text-success";
        case "stale":
            return "text-warning";
        case "unavailable":
            return "text-error";
    }
}

function Card({ card }: { card: GroundingCard }) {
    return (
        <button
            type="button"
            onClick={() => console.log("[jarvis] open source", card.navTarget)}
            className={cn(
                "flex w-full cursor-pointer flex-col gap-1 rounded-[10px] border px-3 py-2.5 text-left hover:bg-surface-hover",
                card.expanded ? "border-accent/40 bg-accentbg" : "border-border bg-surface"
            )}
        >
            <div className="flex items-center gap-2">
                <span className="rounded-[5px] bg-surface-selected px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-mid">
                    {card.sourceType}
                </span>
                <span className="ml-auto text-[11px] text-muted">[{card.n}]</span>
            </div>
            <div className="text-[13px] font-semibold text-secondary">{card.title}</div>
            <div className="flex items-center gap-2 text-[11px] text-muted">
                <span>{card.project}</span>
                <span>·</span>
                <span>{ageLabel(card.ageMs)}</span>
                <span className={cn("ml-auto font-semibold", freshnessClass(card.freshness))}>
                    {freshnessLabel(card.freshness)}
                </span>
            </div>
        </button>
    );
}

export function GroundingRail({ conversation }: { conversation: JarvisConversation }) {
    const answerTurns = conversation.turns.filter(isAnswerTurn);
    const latest = answerTurns[answerTurns.length - 1];
    const cards = latest?.grounding ?? [];
    const sections: RailSection[] = [
        {
            id: "grounding",
            icon: <BookMarked size={18} strokeWidth={1.8} />,
            label: "Sources",
            content: (
                <div className="flex flex-col gap-2.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Sources</div>
                    {cards.length === 0 ? (
                        <div className="text-[12px] text-muted">No grounding sources.</div>
                    ) : (
                        cards.map((c) => <Card key={c.n} card={c} />)
                    )}
                </div>
            ),
        },
    ];
    return <CollapsibleRail openAtom={groundingRailOpenAtom} ariaLabel="Grounding sources" sections={sections} />;
}
```

- [ ] **Step 2: Typecheck + lint** (as Task 6 Step 2, for this file). Expected exit 0 / no errors.

- [ ] **Step 3: Stage + checkpoint.**

---

### Task 8: Dev fixture switcher + CDP state coverage

**Files:**
- Create: `frontend/app/view/jarvis/jarvisfixturebar.tsx`
- Modify: `scripts/cdp/scenarios.mjs` (add `jarvis` to `SMOKE_SURFACES`; add the `jarvis-states` scenario + export it)

**Interfaces:**
- Consumes: `activeFixtureAtom`, `groundingRailOpenAtom` from `jarvisstore`; `FIXTURE_STATES` from `jarvisfixtures`.
- Produces: `JarvisFixtureBar` (dev-only); a `jarvis-states` CDP scenario.

- [ ] **Step 1: Build the dev fixture bar**

Create `frontend/app/view/jarvis/jarvisfixturebar.tsx`. Compiled out of production via `import.meta.env.DEV`. Clickable (CDP drives it by button text, matching the nav-click philosophy — `globalStore` is not exposed on `window`).

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY. A row of buttons that switch the active Jarvis fixture (and toggle the grounding rail), so a
// human and the CDP verify:ui harness can render every surface state without a backend. Compiled out of
// production builds (import.meta.env.DEV is statically false there). Remove when Plan 2 lands real data.

import { cn } from "@/util/util";
import { useAtom, useSetAtom } from "jotai";
import { activeFixtureAtom, groundingRailOpenAtom } from "./jarvisstore";
import { FIXTURE_STATES } from "./jarvisfixtures";

export function JarvisFixtureBar() {
    if (!import.meta.env.DEV) return null;
    const [active, setActive] = useAtom(activeFixtureAtom);
    const setRailOpen = useSetAtom(groundingRailOpenAtom);
    return (
        <div
            data-testid="jarvis-fixture-bar"
            className="flex flex-wrap items-center gap-1 border-b border-dashed border-edge-mid bg-surface px-4 py-1.5"
        >
            <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-muted">fixture</span>
            {FIXTURE_STATES.map((s) => (
                <button
                    key={s}
                    type="button"
                    data-fixture={s}
                    onClick={() => {
                        setActive(s);
                        setRailOpen(s !== "narrow"); // narrow == rail collapsed
                    }}
                    className={cn(
                        "cursor-pointer rounded-[6px] px-2 py-0.5 text-[11px]",
                        active === s ? "bg-accentbg text-accent-soft" : "text-ink-mid hover:bg-surface-hover"
                    )}
                >
                    {s}
                </button>
            ))}
        </div>
    );
}
```

- [ ] **Step 2: Add `jarvis` to the surface smoke**

In `scripts/cdp/scenarios.mjs`, add `"jarvis"` to `SMOKE_SURFACES`:

```js
const SMOKE_SURFACES = ["cockpit", "jarvis", "channels", "radar", "usage", "memory", "files", "settings"];
```

- [ ] **Step 3: Add the `jarvis-states` scenario**

In `scripts/cdp/scenarios.mjs`, add this scenario (DOM-driven: navigate to Jarvis, click each fixture button, screenshot, assert the conversation region is non-empty) and include it in the `SCENARIOS` export:

```js
// --- jarvis: render every surface state via the dev fixture bar --------------------------------
// The bar is DEV-only and clickable (globalStore is not on window, so we drive by button text like nav).
// Each fixture is screenshotted; we assert the conversation region rendered non-empty text.
const jarvisStates = {
    name: "jarvis-states",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("jarvis");
        const states = ["empty", "active", "grounded", "working", "weak", "notfound", "stale", "contextual", "narrow"];
        for (const s of states) {
            const clicked = await h.ev(`(() => {
                const b = [...document.querySelectorAll('[data-testid="jarvis-fixture-bar"] button')]
                    .find((x) => x.getAttribute('data-fixture') === ${JSON.stringify(s)});
                if (!b) return false;
                b.click();
                return true;
            })()`);
            // small settle for the width-reveal animation before shooting
            await h.ev("new Promise((r) => setTimeout(r, 300))");
            const contentLen = await h.ev(
                `(() => { const n=document.querySelector('nav'); const c=n&&n.nextElementSibling; return c?(c.textContent||'').trim().length:0; })()`
            );
            steps.push({
                step: `jarvis fixture "${s}" -> bar present + content non-empty`,
                ok: clicked === true && contentLen > 0,
                detail: `clicked=${clicked} contentLen=${contentLen}`,
            });
            await h.shot(`cdp-shots/jarvis-${s}.png`);
        }
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

export const SCENARIOS = [runsLifecycle, surfaceSmoke, jarvisStates];
```

- [ ] **Step 4: Typecheck** (`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`, exit 0). Do **not** run `prettier --write` on `scripts/cdp/scenarios.mjs` (the `.mjs` reindent gotcha) — hand-match the surrounding 4-space style.

- [ ] **Step 5: Run the CDP verification (dev app running via `task dev`)**

Run: `task verify:ui -- surface-smoke jarvis-states`
Expected: a PASS table for both scenarios; `cdp-shots/index.html` contact sheet shows `jarvis-empty`…`jarvis-narrow` (9 frames) plus `surface-jarvis`. Visually confirm each frame against the matching `Wave-jarvis-second-brain.dc.html` mockup state; open follow-up polish items but do not block the task on pixel spacing.

- [ ] **Step 6: Stage + checkpoint. Plan 1 complete.**

---

## Self-Review

**1. Spec coverage** (spec §"In / out of scope", §"The seam", §"Surface architecture", §"The 12 states", §"Testing", §9):

| Spec item | Task |
|---|---|
| New `jarvis` surface, `frontend/app/view/jarvis/` namespace | 3–8 (files); 4 (nav) |
| Conversation view-model contract (the seam) | 1 (`jarviscontract.ts`) |
| Three-region composition + narrow-collapse | 5 (shell) + 7 (`CollapsibleRail`, persisted-collapsed) |
| Recall / Fleet modes (fleet = placeholder this cycle) | 5 (mode switch + placeholder) |
| Unmount-safe module atoms | 3 (`jarvisstore.ts`) |
| Nav placed second, `Ctrl+2..8` renumber | 4 |
| Surface states 1–7, 11, 12 rendered from fixtures | 1 (fixtures) + 6/7 (renderers) + 8 (coverage) |
| `weak` / `notfound` / `stale` surfaced, not hidden | 1 (fixtures) + 6 (terminals) + 7 (freshness) |
| Inline `[n]` citations → source (nav wired Plan 4) | 6 |
| Scope chips near composer | 5 (`composer.tsx`) |
| `@theme` tokens, dark-only, existing fonts | Global Constraints; all component tasks |
| Vitest for pure logic; CDP for rendering; no jsdom | 1, 2 (vitest); 8 (CDP); Global Constraints |

**Deferred to later plans (not gaps):** states 8–10 (quick-ask, Plan 4 — palette is where they mount; their contract types are defined in Task 1's `JarvisScope`/`SourceRef`); real recall backend (Plan 2); fleet migration + `@jarvis` reroute (Plan 3); contextual entries + ambient fixtures + real citation nav (Plan 4).

**2. Placeholder scan:** No "TBD"/"implement later" left in code. The two `console.log` citation/nav handlers are explicit, working Plan-1 behavior with a named Plan-4 replacement point — not placeholders. The fleet-mode text is intended surface copy for this cycle, not a stub gap.

**3. Type consistency:** `activeFixtureAtom` (`FixtureState`), `activeConversationAtom` (`JarvisConversation`), `groundingRailOpenAtom` (bool) — names identical across `jarvisstore.ts`, `historyrail.tsx`, `composer.tsx`, `jarvissurface.tsx`, `jarvisfixturebar.tsx`, `groundingrail.tsx`. `groundingByN`/`ageLabel`/`freshnessLabel`/`citedNs` signatures match between `recallderive.ts`, its test, and the consumers. `isAnswerTurn`/`isCitation` exported from `jarviscontract.ts` and used consistently. `SurfaceKey` gains `"jarvis"` in the union (agents.tsx), the `Record` (navrail.tsx `ICON`), the switch (cockpitshell.tsx), and `SURFACE_LABEL` (attach.mjs) — the `Record<SurfaceKey, …>` makes any miss a compile error.
