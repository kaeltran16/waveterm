# Jarvis Consolidation — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and unit-test every pure derivation and the one shared renderer that the merged Jarvis surface needs, without changing any user-visible behaviour.

**Architecture:** All new logic lands as pure, jotai-free, React-free modules under `frontend/app/view/jarvis/` and `frontend/app/view/agents/`, each with a vitest file beside it. One React component (`jarvisturn.tsx`) is extracted from `conversationview.tsx` so both the conversation thread and a run's thread can render a Jarvis answer. Nothing in this plan touches the nav rail, `SurfaceKey`, or any surface's composition — the app behaves identically when it lands.

**Tech Stack:** TypeScript, React 19, jotai, Tailwind 4, vitest.

**Spec:** `docs/superpowers/specs/2026-07-27-jarvis-consolidation-design.md`
**Design:** `wave-handoff/wave/project/Wave-jarvis-consolidated.dc.html` (revision 2, 13 states)
**Follow-on plan:** `2026-07-27-jarvis-consolidation-surface.md` consumes everything this plan produces.

## Global Constraints

- **Typecheck command is non-standard.** `npx tsc` stack-overflows on this repo. Always run `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0); any error it reports is yours.
- **Never hand-edit generated files.** `frontend/app/store/wshclientapi.ts` and generated Go/TS type files come from `task generate`.
- **No new SCSS.** Tailwind only. Colours come from `@theme` tokens in `frontend/app/tailwindsetup.css` — never a raw hex or `rgba()` in a component.
- **No jsdom render tests for surfaces or components.** Standing project decision. Pure logic gets vitest; rendering is verified over CDP in the follow-on plan. Do not add `@testing-library/react`.
- **Comments explain "why", never "what".** Lower case. Only where non-obvious.
- **No emojis in code or output.**
- Single vitest file: `npx vitest run <path>`. Filter by name: `npx vitest run -t "<name>"`.
- Do not commit unless the plan's Commit step says to. Never add a co-author trailer.
- Every module in this plan must be importable without pulling in jotai or React — except Task 1, which is a component.

---

### Task 1: Shared Jarvis turn renderer

Extract the answer/steps/user-turn rendering out of `conversationview.tsx` so a run's thread can render a Jarvis answer inline while the run keeps running. Behaviour must be byte-identical for the existing Jarvis surface.

**Files:**
- Create: `frontend/app/view/jarvis/jarvisturn.tsx`
- Create: `frontend/app/view/jarvis/jarvisturnderive.ts`
- Create: `frontend/app/view/jarvis/jarvisturnderive.test.ts`
- Modify: `frontend/app/view/jarvis/conversationview.tsx` (replace the three local components with imports)

**Interfaces:**
- Consumes: `JarvisAnswerTurn`, `JarvisTurn`, `Terminal` from `./jarviscontract`; `groundingByN` from `./recallderive`; `openORef` from `./openref`.
- Produces:
  - `terminalBadge(terminal: Terminal): { label: string; tone: "muted" | "warning" } | null`
  - `<JarvisAnswer turn={JarvisAnswerTurn} model={AgentsViewModel} />`
  - `<JarvisWorkingSteps turn={JarvisAnswerTurn} />`
  - `<JarvisUserTurn text={string} />`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/jarvisturnderive.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { terminalBadge } from "./jarvisturnderive";

describe("terminalBadge", () => {
    it("gives no badge for a normal answered turn", () => {
        expect(terminalBadge("answered")).toBeNull();
    });

    it("labels weak grounding with a warning tone", () => {
        expect(terminalBadge("weak")).toEqual({ label: "Weak grounding", tone: "warning" });
    });

    it("labels not-found with a muted tone — an absence is not a warning", () => {
        expect(terminalBadge("notfound")).toEqual({ label: "Not found", tone: "muted" });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/jarvisturnderive.test.ts`
Expected: FAIL — cannot resolve `./jarvisturnderive`.

- [ ] **Step 3: Write the derivation**

Create `frontend/app/view/jarvis/jarvisturnderive.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure copy/tone decisions for a Jarvis turn. Split out of the renderer so the badge wording is
// testable and identical wherever a turn is drawn (the recall thread and a run's thread).

import type { Terminal } from "./jarviscontract";

export interface TerminalBadge {
    label: string;
    tone: "muted" | "warning";
}

// A normal answer wears no badge. "weak" warns because acting on it is a risk; "notfound" is merely a
// stated absence, so it stays muted.
export function terminalBadge(terminal: Terminal): TerminalBadge | null {
    switch (terminal) {
        case "weak":
            return { label: "Weak grounding", tone: "warning" };
        case "notfound":
            return { label: "Not found", tone: "muted" };
        default:
            return null;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/jarvisturnderive.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Create the shared renderer**

Create `frontend/app/view/jarvis/jarvisturn.tsx`. This is a move of the three module-local components out of `conversationview.tsx`, with the badge copy now coming from `terminalBadge`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// One Jarvis turn, rendered the same way wherever it appears: the recall thread and, after the
// consolidation, inline in a run's thread while the run keeps running. Extracted from
// conversationview.tsx so there is exactly one answer renderer.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn } from "@/util/util";
import type { JarvisAnswerTurn } from "./jarviscontract";
import { isCitation } from "./jarviscontract";
import { terminalBadge } from "./jarvisturnderive";
import { openORef } from "./openref";
import { groundingByN } from "./recallderive";

export function JarvisWorkingSteps({ turn }: { turn: JarvisAnswerTurn }) {
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

export function JarvisUserTurn({ text }: { text: string }) {
    return (
        <div className="flex justify-end">
            <div className="max-w-[560px] rounded-[12px] bg-surface-raised px-3.5 py-2 text-[14px] text-primary">{text}</div>
        </div>
    );
}

export function JarvisAnswer({ turn, model }: { turn: JarvisAnswerTurn; model: AgentsViewModel }) {
    const byN = groundingByN(turn.grounding);
    const badge = terminalBadge(turn.terminal);
    return (
        <div className="max-w-[720px]">
            <JarvisWorkingSteps turn={turn} />
            {badge != null ? (
                <div
                    className={cn(
                        "mb-2 inline-flex items-center gap-2 rounded-[7px] border px-2.5 py-1 text-[11.5px] font-semibold",
                        badge.tone === "warning" ? "border-warning/40 bg-warning/10 text-warning" : "border-border text-muted"
                    )}
                >
                    {badge.label}
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
                            onClick={() => {
                                if (card) void openORef(model, card.navTarget);
                            }}
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
```

- [ ] **Step 6: Rewrite conversationview.tsx to use it**

Replace the whole file with the version below. The empty state and the `max-w-[900px]` column are unchanged — only the three local components become imports.

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Renders one JarvisConversation as a list of turns. The turn renderer itself lives in jarvisturn.tsx
// so a run's thread draws Jarvis answers identically.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { SurfaceEmptyState } from "@/app/view/agents/surfacescaffold";
import { Brain } from "lucide-react";
import type { JarvisConversation, JarvisTurn } from "./jarviscontract";
import { isAnswerTurn } from "./jarviscontract";
import { JarvisAnswer, JarvisUserTurn } from "./jarvisturn";

export function ConversationView({ conversation, model }: { conversation: JarvisConversation; model: AgentsViewModel }) {
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
                        <JarvisAnswer turn={turn} model={model} />
                    </div>
                ) : (
                    <JarvisUserTurn key={i} text={turn.text} />
                )
            )}
        </div>
    );
}
```

- [ ] **Step 7: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no output.

- [ ] **Step 8: Confirm no behaviour change on the live Jarvis surface**

Run: `npx vitest run frontend/app/view/jarvis`
Expected: PASS, no regressions.

- [ ] **Step 9: Commit**

```bash
git add frontend/app/view/jarvis/jarvisturn.tsx frontend/app/view/jarvis/jarvisturnderive.ts frontend/app/view/jarvis/jarvisturnderive.test.ts frontend/app/view/jarvis/conversationview.tsx
git commit -m "refactor(jarvis): extract the turn renderer so a run thread can draw a Jarvis answer"
```

---

### Task 2: Mentioned-dossier derivation

A conversation carries no attribution of its own. Its relationship to a record is derived from what it cited. This one derivation serves two consumers: the conversation record band ("Mentioned here") and Space scoping of threads in Task 3.

**Files:**
- Create: `frontend/app/view/jarvis/mentions.ts`
- Create: `frontend/app/view/jarvis/mentions.test.ts`

**Interfaces:**
- Consumes: `JarvisConversation`, `GroundingCard` from `./jarviscontract`.
- Produces: `mentionedDossierIds(conversation: JarvisConversation): string[]`

Grounding cards carry `sourceType` and `navTarget` (an ORef, `"<otype>:<oid>"`). A dossier card is `sourceType === "task"`; its dossier id is the ORef's oid half. Non-task cards are not attribution, mirroring the rule in `ambient.ts` that a link to a non-dossier note is not attribution.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/mentions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { GroundingCard, JarvisConversation } from "./jarviscontract";
import { mentionedDossierIds } from "./mentions";

function card(n: number, sourceType: GroundingCard["sourceType"], navTarget: string): GroundingCard {
    return { n, sourceType, title: "t" + n, project: "p", ageMs: 0, freshness: "fresh", navTarget };
}

function convo(cards: GroundingCard[][]): JarvisConversation {
    return {
        id: "c1",
        title: "why",
        scope: { mode: "all", chips: [], attached: [] },
        turns: cards.map((grounding) => ({
            role: "jarvis" as const,
            workingSteps: [],
            segments: [{ text: "answer" }],
            grounding,
            terminal: "answered" as const,
        })),
    };
}

describe("mentionedDossierIds", () => {
    it("returns the dossier ids cited across every turn, in first-cited order", () => {
        const c = convo([
            [card(1, "run", "run:r1"), card(2, "task", "task-418")],
            [card(1, "task", "task-402")],
        ]);
        expect(mentionedDossierIds(c)).toEqual(["task-418", "task-402"]);
    });

    it("ignores non-task sources — a run or memory citation is not attribution", () => {
        const c = convo([[card(1, "run", "run:r1"), card(2, "memory", "memory:m1"), card(3, "decision", "dec:d1")]]);
        expect(mentionedDossierIds(c)).toEqual([]);
    });

    it("dedups a dossier cited in several turns", () => {
        const c = convo([[card(1, "task", "task-418")], [card(1, "task", "task-418")]]);
        expect(mentionedDossierIds(c)).toEqual(["task-418"]);
    });

    it("accepts an oref-shaped task target and keeps only the oid half", () => {
        const c = convo([[card(1, "task", "task:task-418")]]);
        expect(mentionedDossierIds(c)).toEqual(["task-418"]);
    });

    it("skips a task card with an empty target rather than yielding an empty id", () => {
        const c = convo([[card(1, "task", "")]]);
        expect(mentionedDossierIds(c)).toEqual([]);
    });

    it("returns nothing for a conversation with no turns", () => {
        expect(mentionedDossierIds(convo([]))).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/mentions.test.ts`
Expected: FAIL — cannot resolve `./mentions`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/jarvis/mentions.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A conversation has no attribution edge of its own — its link to a record is whatever it cited. This
// derives that, and is the single source for both the "Mentioned here" band and Space-scoping of threads.

import type { JarvisConversation } from "./jarviscontract";
import { isAnswerTurn } from "./jarviscontract";

// A dossier citation's navTarget is either a bare dossier id or an oref ("task:<id>"). Only the oid half
// is the dossier id; a target with an empty oid is not a citation we can resolve.
function dossierIdFromTarget(navTarget: string): string | null {
    const target = navTarget ?? "";
    const id = target.includes(":") ? target.slice(target.indexOf(":") + 1) : target;
    return id === "" ? null : id;
}

export function mentionedDossierIds(conversation: JarvisConversation): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const turn of conversation.turns ?? []) {
        if (!isAnswerTurn(turn)) continue;
        for (const card of turn.grounding ?? []) {
            if (card.sourceType !== "task") continue;
            const id = dossierIdFromTarget(card.navTarget);
            if (id == null || seen.has(id)) continue;
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/mentions.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/jarvis/mentions.ts frontend/app/view/jarvis/mentions.test.ts
git commit -m "feat(jarvis): derive a conversation's mentioned dossiers from its citations"
```

---

### Task 3: The subject model

The Subjects column holds three kinds of thing in one grouped list. This builds that list.

**Files:**
- Create: `frontend/app/view/jarvis/subjects.ts`
- Create: `frontend/app/view/jarvis/subjects.test.ts`

**Interfaces:**
- Consumes: `mentionedDossierIds` from `./mentions`; `groupDossiers` from `./tasksderive`; `SpaceScope` (generated global); `Channel` / `SpaceSummary` (generated globals); `JarvisConversation` from `./jarviscontract`.
- Produces:
  - `type SubjectKind = "channel" | "dossier" | "conversation"`
  - `type Subject` (discriminated on `kind`, every variant has `id: string` and `label: string`)
  - `subjectMark(kind: SubjectKind): "#" | "▤" | "~"`
  - `buildSubjectGroups(input: SubjectInput): SubjectGroup[]`
  - `interface SubjectInput { channels: Channel[] | null; dossiers: SpaceSummary[]; conversations: JarvisConversation[]; projectNameFor: (channel: Channel) => string; spaceScope: SpaceScope | null; spaceDossierId: string | null; revealed: boolean }`
  - `interface SubjectGroup { key: string; label: string; items: Subject[] }`

Scoping rules, all three kinds, when a Space is active and not revealed:
- Channels: keep those whose `oid` is in `spaceScope.channeloids` (same rule as `filterChannelsBySpace`).
- Dossiers: keep only the Space's own dossier (`spaceDossierId`) — a Space *is* a dossier.
- Conversations: keep those whose `mentionedDossierIds` include `spaceDossierId`. This is the only defensible rule; there is no conversation→dossier edge in the data model.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/subjects.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { GroundingCard, JarvisConversation } from "./jarviscontract";
import { buildSubjectGroups, subjectMark, type SubjectInput } from "./subjects";

function ch(oid: string, name: string, project: string): Channel {
    return { oid, name, projectpath: "/p/" + project } as unknown as Channel;
}

function dos(id: string, objective: string, status: string): SpaceSummary {
    return { id, objective, status } as unknown as SpaceSummary;
}

function convo(id: string, title: string, taskIds: string[]): JarvisConversation {
    const grounding: GroundingCard[] = taskIds.map((t, i) => ({
        n: i + 1,
        sourceType: "task",
        title: t,
        project: "p",
        ageMs: 0,
        freshness: "fresh",
        navTarget: t,
    }));
    return {
        id,
        title,
        scope: { mode: "all", chips: [], attached: [] },
        turns: [{ role: "jarvis", workingSteps: [], segments: [{ text: "a" }], grounding, terminal: "answered" }],
    };
}

const BASE: SubjectInput = {
    channels: [ch("c1", "checkout-revamp", "payments"), ch("c2", "rate-limits", "platform")],
    dossiers: [dos("task-418", "Coupon abuse guardrails", "active"), dos("task-402", "Idempotent refunds", "paused")],
    conversations: [convo("v1", "Why the Redis counter?", ["task-418"]), convo("v2", "Week 30", [])],
    projectNameFor: (c) => (c.oid === "c1" ? "payments" : "platform"),
    spaceScope: null,
    spaceDossierId: null,
    revealed: false,
};

describe("subjectMark", () => {
    it("gives each kind its own glyph", () => {
        expect(subjectMark("channel")).toBe("#");
        expect(subjectMark("dossier")).toBe("▤");
        expect(subjectMark("conversation")).toBe("~");
    });
});

describe("buildSubjectGroups", () => {
    it("groups channels by project, then records, then threads", () => {
        const groups = buildSubjectGroups(BASE);
        expect(groups.map((g) => g.label)).toEqual(["payments", "platform", "Records · dossiers", "Threads"]);
    });

    it("tags every item with its kind and a stable id", () => {
        const groups = buildSubjectGroups(BASE);
        const records = groups.find((g) => g.key === "dossiers")!;
        expect(records.items.map((i) => i.kind)).toEqual(["dossier", "dossier"]);
        expect(records.items.map((i) => i.id)).toEqual(["task-418", "task-402"]);
    });

    it("labels a dossier by its objective and a conversation by its title", () => {
        const groups = buildSubjectGroups(BASE);
        expect(groups.find((g) => g.key === "dossiers")!.items[0].label).toBe("Coupon abuse guardrails");
        expect(groups.find((g) => g.key === "threads")!.items[0].label).toBe("Why the Redis counter?");
    });

    it("omits a group with no items rather than rendering an empty heading", () => {
        const groups = buildSubjectGroups({ ...BASE, dossiers: [], conversations: [] });
        expect(groups.map((g) => g.key)).toEqual(["project:payments", "project:platform"]);
    });

    it("treats a null channel list as no channels, not a crash", () => {
        const groups = buildSubjectGroups({ ...BASE, channels: null });
        expect(groups.map((g) => g.key)).toEqual(["dossiers", "threads"]);
    });

    it("scopes all three kinds to an active Space", () => {
        const groups = buildSubjectGroups({
            ...BASE,
            spaceScope: { channeloids: ["c1"], tabids: [], runorefs: [] } as unknown as SpaceScope,
            spaceDossierId: "task-418",
        });
        expect(groups.find((g) => g.key.startsWith("project:"))!.items.map((i) => i.id)).toEqual(["c1"]);
        expect(groups.find((g) => g.key === "dossiers")!.items.map((i) => i.id)).toEqual(["task-418"]);
        expect(groups.find((g) => g.key === "threads")!.items.map((i) => i.id)).toEqual(["v1"]);
    });

    it("passes everything through when the Space is revealed — the show-all escape hatch", () => {
        const groups = buildSubjectGroups({
            ...BASE,
            spaceScope: { channeloids: ["c1"], tabids: [], runorefs: [] } as unknown as SpaceScope,
            spaceDossierId: "task-418",
            revealed: true,
        });
        expect(groups.find((g) => g.key === "dossiers")!.items).toHaveLength(2);
        expect(groups.find((g) => g.key === "threads")!.items).toHaveLength(2);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/subjects.test.ts`
Expected: FAIL — cannot resolve `./subjects`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/jarvis/subjects.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Subjects column's model: channels, dossiers and conversations are three kinds of one list. Pure —
// no jotai, no React — so the grouping and Space-scoping rules unit-test without a store.

import type { JarvisConversation } from "./jarviscontract";
import { mentionedDossierIds } from "./mentions";

export type SubjectKind = "channel" | "dossier" | "conversation";

export type Subject =
    | { kind: "channel"; id: string; label: string; projectName: string }
    | { kind: "dossier"; id: string; label: string; status: string }
    | { kind: "conversation"; id: string; label: string };

export interface SubjectGroup {
    key: string;
    label: string;
    items: Subject[];
}

export interface SubjectInput {
    channels: Channel[] | null;
    dossiers: SpaceSummary[];
    conversations: JarvisConversation[];
    projectNameFor: (channel: Channel) => string;
    spaceScope: SpaceScope | null;
    spaceDossierId: string | null;
    revealed: boolean;
}

const MARKS: Record<SubjectKind, "#" | "▤" | "~"> = {
    channel: "#",
    dossier: "▤",
    conversation: "~",
};

export function subjectMark(kind: SubjectKind): "#" | "▤" | "~" {
    return MARKS[kind];
}

export function buildSubjectGroups(input: SubjectInput): SubjectGroup[] {
    // a revealed surface or a null scope means Global: every kind passes through untouched.
    const scoped = input.spaceScope != null && !input.revealed;
    const channelOids = scoped ? new Set(input.spaceScope!.channeloids ?? []) : null;

    const channels = (input.channels ?? []).filter((c) => channelOids == null || channelOids.has(c.oid));
    // a Space *is* a dossier, so scoping the record list means showing that one record.
    const dossiers = scoped && input.spaceDossierId != null
        ? input.dossiers.filter((d) => d.id === input.spaceDossierId)
        : input.dossiers;
    // a conversation has no attribution edge; "on this task" can only mean it cited the task.
    const conversations = scoped && input.spaceDossierId != null
        ? input.conversations.filter((v) => mentionedDossierIds(v).includes(input.spaceDossierId!))
        : input.conversations;

    const groups: SubjectGroup[] = [];

    // channels group by project, in first-seen order, so the column matches the rail users know.
    const byProject = new Map<string, Subject[]>();
    for (const c of channels) {
        const project = input.projectNameFor(c);
        const item: Subject = { kind: "channel", id: c.oid, label: c.name ?? c.oid, projectName: project };
        const list = byProject.get(project);
        if (list) {
            list.push(item);
        } else {
            byProject.set(project, [item]);
        }
    }
    for (const [project, items] of byProject) {
        groups.push({ key: "project:" + project, label: project, items });
    }

    if (dossiers.length > 0) {
        groups.push({
            key: "dossiers",
            label: "Records · dossiers",
            items: dossiers.map((d) => ({ kind: "dossier", id: d.id, label: d.objective, status: d.status })),
        });
    }
    if (conversations.length > 0) {
        groups.push({
            key: "threads",
            label: "Threads",
            items: conversations.map((v) => ({ kind: "conversation", id: v.id, label: v.title })),
        });
    }
    return groups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/subjects.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/subjects.ts frontend/app/view/jarvis/subjects.test.ts
git commit -m "feat(jarvis): model channels, dossiers and conversations as one subject list"
```

---

### Task 4: Stage composition rules

The Stage keeps its four bands for every subject kind and omits the ones a subject cannot have. This encodes the spec's composition table as one pure function, so a band can never silently appear on the wrong subject.

**Files:**
- Create: `frontend/app/view/jarvis/stagecompose.ts`
- Create: `frontend/app/view/jarvis/stagecompose.test.ts`

**Interfaces:**
- Consumes: `SubjectKind`, `subjectMark` from `./subjects`.
- Produces: `composeStage(kind: SubjectKind): StageComposition` and `interface StageComposition`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/stagecompose.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { composeStage } from "./stagecompose";
import type { SubjectKind } from "./subjects";

describe("composeStage", () => {
    it("gives a channel the run controls: autonomy, profile, pipeline, worker composer", () => {
        const s = composeStage("channel");
        expect(s).toMatchObject({
            mark: "#",
            showAutonomy: true,
            showProfile: true,
            showPipeline: true,
            recordBand: "attributed",
            thread: "run",
            composerTarget: "worker-or-jarvis",
            showFleet: true,
        });
        expect(s.reachText).toBeNull();
        expect(s.absenceChip).toBeNull();
    });

    it("strips every channel-only control from a conversation and drops the fleet section", () => {
        const s = composeStage("conversation");
        expect(s).toMatchObject({
            mark: "~",
            showAutonomy: false,
            showProfile: false,
            showPipeline: false,
            recordBand: "mentions",
            thread: "turns",
            composerTarget: "jarvis-thread",
            showFleet: false,
        });
        expect(s.fleetTitle).toBeNull();
        expect(s.absenceChip).toBe("No channel · no fleet · no profile");
        expect(s.reachText).toBe("all projects");
    });

    it("makes a dossier its own record band and keeps a record-scoped fleet", () => {
        const s = composeStage("dossier");
        expect(s).toMatchObject({
            mark: "▤",
            showAutonomy: false,
            showProfile: false,
            showPipeline: false,
            recordBand: "subject",
            thread: "record",
            composerTarget: "jarvis-record",
            showFleet: true,
            fleetTitle: "Fleet · on this record",
        });
        expect(s.absenceChip).toBe("Record · not a run");
        expect(s.reachText).toBe("this record + its runs");
    });

    it("never shows autonomy or the profile drawer outside a channel", () => {
        for (const kind of ["dossier", "conversation"] as SubjectKind[]) {
            const s = composeStage(kind);
            expect(s.showAutonomy).toBe(false);
            expect(s.showProfile).toBe(false);
        }
    });

    it("names the fleet section exactly when it is shown", () => {
        for (const kind of ["channel", "dossier", "conversation"] as SubjectKind[]) {
            const s = composeStage(kind);
            expect(s.showFleet).toBe(s.fleetTitle != null);
        }
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/stagecompose.test.ts`
Expected: FAIL — cannot resolve `./stagecompose`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/jarvis/stagecompose.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What the Stage draws for each subject kind. The rule is "absent rather than empty": a band a subject
// cannot have is not rendered, never greyed out and parked. One table so a control cannot drift onto the
// wrong subject.

import { subjectMark, type SubjectKind } from "./subjects";

export interface StageComposition {
    mark: "#" | "▤" | "~";
    showAutonomy: boolean;
    showProfile: boolean;
    reachText: string | null; // static statement of grounding reach; not a control (Spaces own scoping)
    absenceChip: string | null;
    recordBand: "attributed" | "subject" | "mentions";
    showPipeline: boolean;
    thread: "run" | "record" | "turns";
    composerTarget: "worker-or-jarvis" | "jarvis-record" | "jarvis-thread";
    showFleet: boolean;
    fleetTitle: string | null;
}

const TABLE: Record<SubjectKind, Omit<StageComposition, "mark">> = {
    channel: {
        showAutonomy: true,
        showProfile: true,
        reachText: null,
        absenceChip: null,
        recordBand: "attributed",
        showPipeline: true,
        thread: "run",
        composerTarget: "worker-or-jarvis",
        showFleet: true,
        fleetTitle: "Fleet",
    },
    dossier: {
        showAutonomy: false,
        showProfile: false,
        reachText: "this record + its runs",
        absenceChip: "Record · not a run",
        recordBand: "subject",
        showPipeline: false,
        thread: "record",
        composerTarget: "jarvis-record",
        showFleet: true,
        fleetTitle: "Fleet · on this record",
    },
    conversation: {
        showAutonomy: false,
        showProfile: false,
        reachText: "all projects",
        absenceChip: "No channel · no fleet · no profile",
        recordBand: "mentions",
        showPipeline: false,
        thread: "turns",
        composerTarget: "jarvis-thread",
        showFleet: false,
        fleetTitle: null,
    },
};

export function composeStage(kind: SubjectKind): StageComposition {
    return { mark: subjectMark(kind), ...TABLE[kind] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/stagecompose.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/jarvis/stagecompose.ts frontend/app/view/jarvis/stagecompose.test.ts
git commit -m "feat(jarvis): encode the Stage composition table per subject kind"
```

---

### Task 5: Record band cases and edge encoding

A run has zero or more attributed records. The collapsed band must make a weak inferred link visually distinct from a confirmed one, or the attribution model is untrustworthy at a glance.

**Files:**
- Create: `frontend/app/view/jarvis/recordband.ts`
- Create: `frontend/app/view/jarvis/recordband.test.ts`

**Interfaces:**
- Consumes: `AmbientTag` from `@/app/view/agents/ambient`; `SubjectKind` from `./subjects`.
- Produces:
  - `type BandCase` (discriminated on `case`: `"none" | "one" | "several" | "subject" | "mentions"`)
  - `recordBandCase(input: BandInput): BandCase`
  - `edgeLineStyle(tag: AmbientTag): { style: "solid" | "dashed" | "dotted"; weightPx: number }`
  - `edgeLabel(tag: AmbientTag): string`
  - `interface BandInput { kind: SubjectKind; tags: AmbientTag[]; mentionedIds: string[] }`

Edge ordering for the primary: `confirmed` beats `informing`, then `strong > medium > weak`. `ambient.ts` documents that the server already orders edges confidence-descending, but the band sorts explicitly so the strongest edge is deterministic regardless of input order.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/recordband.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AmbientTag } from "@/app/view/agents/ambient";
import { edgeLabel, edgeLineStyle, recordBandCase } from "./recordband";

function tag(taskId: string, state: string, bucket: string): AmbientTag {
    return { taskId, label: taskId.toUpperCase(), state, bucket };
}

describe("recordBandCase", () => {
    it("states the absence when a run has no attributed record", () => {
        expect(recordBandCase({ kind: "channel", tags: [], mentionedIds: [] })).toEqual({ case: "none" });
    });

    it("returns the single edge when there is exactly one", () => {
        const t = tag("task-418", "confirmed", "strong");
        expect(recordBandCase({ kind: "channel", tags: [t], mentionedIds: [] })).toEqual({ case: "one", edge: t });
    });

    it("promotes the strongest edge to primary and keeps the rest as others", () => {
        const weak = tag("task-377", "informing", "weak");
        const strong = tag("task-418", "confirmed", "strong");
        const medium = tag("task-402", "informing", "medium");
        const band = recordBandCase({ kind: "channel", tags: [weak, strong, medium], mentionedIds: [] });
        expect(band).toMatchObject({ case: "several" });
        if (band.case !== "several") throw new Error("expected several");
        expect(band.primary.taskId).toBe("task-418");
        expect(band.others.map((o) => o.taskId)).toEqual(["task-402", "task-377"]);
    });

    it("prefers a confirmed edge over an informing one of the same bucket", () => {
        const informing = tag("task-a", "informing", "strong");
        const confirmed = tag("task-b", "confirmed", "strong");
        const band = recordBandCase({ kind: "channel", tags: [informing, confirmed], mentionedIds: [] });
        if (band.case !== "several") throw new Error("expected several");
        expect(band.primary.taskId).toBe("task-b");
    });

    it("makes a dossier subject its own band, ignoring any tags", () => {
        expect(recordBandCase({ kind: "dossier", tags: [tag("x", "confirmed", "strong")], mentionedIds: [] })).toEqual({
            case: "subject",
        });
    });

    it("gives a conversation its mentioned ids, never an attribution case", () => {
        expect(
            recordBandCase({ kind: "conversation", tags: [tag("x", "confirmed", "strong")], mentionedIds: ["task-418"] })
        ).toEqual({ case: "mentions", ids: ["task-418"] });
    });

    it("gives a conversation that cited no record an empty mentions band, not none", () => {
        expect(recordBandCase({ kind: "conversation", tags: [], mentionedIds: [] })).toEqual({ case: "mentions", ids: [] });
    });
});

describe("edgeLineStyle", () => {
    it("draws a strong edge solid and heaviest", () => {
        expect(edgeLineStyle(tag("t", "confirmed", "strong"))).toEqual({ style: "solid", weightPx: 2.5 });
    });

    it("draws medium dashed and weak dotted so strength is legible without colour", () => {
        expect(edgeLineStyle(tag("t", "informing", "medium"))).toEqual({ style: "dashed", weightPx: 1.5 });
        expect(edgeLineStyle(tag("t", "informing", "weak"))).toEqual({ style: "dotted", weightPx: 1 });
    });

    it("falls back to the weakest treatment for an unknown bucket rather than overstating it", () => {
        expect(edgeLineStyle(tag("t", "informing", "nonsense"))).toEqual({ style: "dotted", weightPx: 1 });
    });
});

describe("edgeLabel", () => {
    it("names both the state and the confidence", () => {
        expect(edgeLabel(tag("t", "confirmed", "strong"))).toBe("confirmed · strong");
        expect(edgeLabel(tag("t", "informing", "weak"))).toBe("informing · weak");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/recordband.test.ts`
Expected: FAIL — cannot resolve `./recordband`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/jarvis/recordband.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The record band's case selection and edge encoding. A run has zero or more attributed records, and the
// collapsed line must distinguish a weak inferred link from a confirmed one — otherwise the attribution
// model reads as certain when it is not.

import type { AmbientTag } from "@/app/view/agents/ambient";
import type { SubjectKind } from "./subjects";

export type BandCase =
    | { case: "none" }
    | { case: "one"; edge: AmbientTag }
    | { case: "several"; primary: AmbientTag; others: AmbientTag[] }
    | { case: "subject" }
    | { case: "mentions"; ids: string[] };

export interface BandInput {
    kind: SubjectKind;
    tags: AmbientTag[];
    mentionedIds: string[];
}

const BUCKET_RANK: Record<string, number> = { strong: 3, medium: 2, weak: 1 };

// unknown buckets rank below weak: never let an unrecognised value present as stronger than it is.
function rank(tag: AmbientTag): number {
    const state = tag.state === "confirmed" ? 10 : 0;
    return state + (BUCKET_RANK[tag.bucket] ?? 0);
}

const LINE: Record<string, { style: "solid" | "dashed" | "dotted"; weightPx: number }> = {
    strong: { style: "solid", weightPx: 2.5 },
    medium: { style: "dashed", weightPx: 1.5 },
    weak: { style: "dotted", weightPx: 1 },
};

export function edgeLineStyle(tag: AmbientTag): { style: "solid" | "dashed" | "dotted"; weightPx: number } {
    return LINE[tag.bucket] ?? LINE.weak;
}

export function edgeLabel(tag: AmbientTag): string {
    return `${tag.state} · ${tag.bucket}`;
}

export function recordBandCase(input: BandInput): BandCase {
    if (input.kind === "dossier") {
        return { case: "subject" };
    }
    if (input.kind === "conversation") {
        return { case: "mentions", ids: input.mentionedIds };
    }
    const tags = input.tags ?? [];
    if (tags.length === 0) {
        return { case: "none" };
    }
    if (tags.length === 1) {
        return { case: "one", edge: tags[0] };
    }
    const sorted = [...tags].sort((a, b) => rank(b) - rank(a));
    return { case: "several", primary: sorted[0], others: sorted.slice(1) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/recordband.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/recordband.ts frontend/app/view/jarvis/recordband.test.ts
git commit -m "feat(jarvis): record-band cases with edge state and confidence on the collapsed line"
```

---

### Task 6: Fleet rollup for a record

A dossier's fleet crosses channels: attribution gives dossier → run ORefs, and workers are per-run. `buildFleetSnapshot` is per-channel, so a record-scoped roster needs a rollup over several channels, deduped by worker.

**Files:**
- Create: `frontend/app/view/jarvis/fleetscope.ts`
- Create: `frontend/app/view/jarvis/fleetscope.test.ts`

**Interfaces:**
- Consumes: `buildFleetSnapshot`, `WorkerState` from `@/app/view/agents/jarvisderive`; `AgentVM` from `@/app/view/agents/agentsviewmodel`.
- Produces: `fleetForRecord(input: RecordFleetInput): RecordFleet` and `interface RecordFleet { workers: WorkerState[]; channelCount: number }`
- `interface RecordFleetInput { channels: Channel[]; agents: AgentVM[]; attributedRunORefs: string[] }`

A channel contributes when it owns at least one run in `attributedRunORefs`. `Channel.runs` carries the run rows; a run's ORef is `"run:" + run.id`. Workers are deduped by `WorkerState.oref` because one worker can be reached through more than one channel path.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/fleetscope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { fleetForRecord } from "./fleetscope";

function agent(id: string, state: AgentVM["state"]): AgentVM {
    return { id, name: id, state } as unknown as AgentVM;
}

// a channel whose dispatch message points at the worker tab, which is what buildFleetSnapshot resolves.
function channel(oid: string, runIds: string[], workerIds: string[]): Channel {
    return {
        oid,
        name: oid,
        runs: runIds.map((id) => ({ id })),
        messages: workerIds.map((w, i) => ({
            id: `m${i}`,
            kind: "dispatch",
            reforef: `tab:${w}`,
            text: "do a thing",
        })),
    } as unknown as Channel;
}

describe("fleetForRecord", () => {
    it("returns no workers and no channels when the record has no attributed runs", () => {
        const out = fleetForRecord({
            channels: [channel("c1", ["r1"], ["w1"])],
            agents: [agent("w1", "working")],
            attributedRunORefs: [],
        });
        expect(out).toEqual({ workers: [], channelCount: 0 });
    });

    it("counts only the channels that own an attributed run", () => {
        const out = fleetForRecord({
            channels: [channel("c1", ["r1"], ["w1"]), channel("c2", ["r9"], ["w9"])],
            agents: [agent("w1", "working"), agent("w9", "working")],
            attributedRunORefs: ["run:r1"],
        });
        expect(out.channelCount).toBe(1);
        expect(out.workers.map((w) => w.oref)).toEqual(["tab:w1"]);
    });

    it("rolls up workers across several channels", () => {
        const out = fleetForRecord({
            channels: [channel("c1", ["r1"], ["w1"]), channel("c2", ["r2"], ["w2"])],
            agents: [agent("w1", "working"), agent("w2", "asking")],
            attributedRunORefs: ["run:r1", "run:r2"],
        });
        expect(out.channelCount).toBe(2);
        expect(out.workers.map((w) => w.oref).sort()).toEqual(["tab:w1", "tab:w2"]);
    });

    it("dedups a worker reachable through two channels", () => {
        const out = fleetForRecord({
            channels: [channel("c1", ["r1"], ["w1"]), channel("c2", ["r2"], ["w1"])],
            agents: [agent("w1", "working")],
            attributedRunORefs: ["run:r1", "run:r2"],
        });
        expect(out.workers).toHaveLength(1);
        expect(out.channelCount).toBe(2);
    });

    it("tolerates a channel with no runs", () => {
        const out = fleetForRecord({
            channels: [channel("c1", [], ["w1"])],
            agents: [agent("w1", "working")],
            attributedRunORefs: ["run:r1"],
        });
        expect(out).toEqual({ workers: [], channelCount: 0 });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/fleetscope.test.ts`
Expected: FAIL — cannot resolve `./fleetscope`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/jarvis/fleetscope.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A record's fleet crosses channels: attribution yields dossier -> run orefs, and workers hang off runs.
// buildFleetSnapshot is per-channel, so this rolls it up over every channel that owns an attributed run
// and dedups by worker oref (one worker can be reached through more than one channel).

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { buildFleetSnapshot, type WorkerState } from "@/app/view/agents/jarvisderive";

export interface RecordFleetInput {
    channels: Channel[];
    agents: AgentVM[];
    attributedRunORefs: string[];
}

export interface RecordFleet {
    workers: WorkerState[];
    channelCount: number;
}

export function fleetForRecord(input: RecordFleetInput): RecordFleet {
    const wanted = new Set(input.attributedRunORefs ?? []);
    if (wanted.size === 0) {
        return { workers: [], channelCount: 0 };
    }
    const workers: WorkerState[] = [];
    const seen = new Set<string>();
    let channelCount = 0;
    for (const channel of input.channels ?? []) {
        const owns = (channel.runs ?? []).some((r) => wanted.has("run:" + r.id));
        if (!owns) continue;
        channelCount++;
        for (const w of buildFleetSnapshot(channel, input.agents)) {
            if (seen.has(w.oref)) continue;
            seen.add(w.oref);
            workers.push(w);
        }
    }
    return { workers, channelCount };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/fleetscope.test.ts`
Expected: PASS (5 tests).

If `buildFleetSnapshot` resolves workers from a message field named differently than `reforef`, fix the
test fixture's message shape to match `jarvisderive.ts` — the production code is correct, the fixture is not.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/fleetscope.ts frontend/app/view/jarvis/fleetscope.test.ts
git commit -m "feat(jarvis): roll a record's fleet up across the channels that own its runs"
```

---

### Task 7: Full suite and typecheck gate

Everything in this plan is additive except the Task 1 refactor. Prove the app is unchanged.

**Files:** none — verification only.

- [ ] **Step 1: Run the whole frontend suite**

Run: `npx vitest run`
Expected: PASS. No test that passed before this plan may fail now.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Lint the new files**

Run: `npx eslint frontend/app/view/jarvis/jarvisturn.tsx frontend/app/view/jarvis/jarvisturnderive.ts frontend/app/view/jarvis/mentions.ts frontend/app/view/jarvis/subjects.ts frontend/app/view/jarvis/stagecompose.ts frontend/app/view/jarvis/recordband.ts frontend/app/view/jarvis/fleetscope.ts`
Expected: no errors.

- [ ] **Step 4: Confirm the Jarvis surface still renders**

The dev app must already be running (`task dev`). If frontend modules changed while it ran, force a full
reload first — HMR can blank the page after module moves, and a blank page is not a test result.

Run: `node scripts/cdp-shot.mjs cdp-shots/foundations-jarvis.png`
Then open the Jarvis surface (`Ctrl+2`) and shoot again. Expected: the recall thread renders turns,
citations and grounding exactly as before Task 1.

- [ ] **Step 5: Report**

State plainly: which tasks landed, the vitest count, and whether the CDP check confirmed no visual change.
Do not claim the surface is verified if the dev app was not running — say it was skipped instead.

---

## Self-Review

**Spec coverage (this plan's slice):**

| Spec section | Task |
|---|---|
| §6 shareable turn renderer | 1 |
| §15.1 "Mentioned here" derivation | 2 |
| §4 subject model, three kinds | 3 |
| §11 Space scoping of the whole Subjects column | 3 |
| §4 Stage composition table | 4 |
| §5 record band 0/1/N + conversation + dossier cases | 5 |
| §5/§15.3 edge state and confidence on the collapsed line | 5 |
| §15.2 fleet-on-record rollup | 6 |

Deferred to the follow-on plan by design, not omission: §3 regions, §7 composer, §8 graph peek, §9
autonomy control, §10 badge, §12 narrow window, §13 entry points, §14 nav and deletions, §17 non-goals,
§18 CDP scenarios, §20 step 7 (acceptance-drift card).

**Placeholder scan:** none. Every step carries runnable code or an exact command.

**Type consistency:** `SubjectKind` is defined in Task 3 and consumed by name in Tasks 4 and 5.
`AmbientTag` is imported from the existing `ambient.ts` in Tasks 5 and 6 — not redefined. `WorkerState`
comes from the existing `jarvisderive.ts` in Task 6. `Terminal` in Task 1 is the existing
`jarviscontract.ts` type. `mentionedDossierIds` has one signature, used by Tasks 3 and 5's consumers.
