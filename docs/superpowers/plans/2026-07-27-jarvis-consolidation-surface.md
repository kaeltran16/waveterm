# Jarvis Consolidation — Merged Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble one Jarvis surface from the tested pieces, then cut the nav rail from 11 entries to 8 by deleting Channels, Graph and Tasks.

**Architecture:** A new `jarvissurface.tsx` composes three regions — Subjects column, Stage, context rail — and dispatches on subject kind through `composeStage()` from the foundations plan. The Stage is four separate band components so the thread region is a stable sibling that never unmounts when the record expands or the graph opens. The cutover is one task at the end: until it runs, the merged surface is reachable but the old entries still exist, so the app is never broken mid-plan.

**Tech Stack:** TypeScript, React 19, jotai, Tailwind 4, motion/react, vitest, CDP verification.

**Spec:** `docs/superpowers/specs/2026-07-27-jarvis-consolidation-design.md`
**Design:** `wave-handoff/wave/project/Wave-jarvis-consolidated.dc.html` — open it. It is the authority on visual detail this plan does not restate; the state switcher covers 13 states.
**Prerequisite:** `2026-07-27-jarvis-consolidation-foundations.md` must be complete. This plan consumes its exports and does not re-derive them.

## Global Constraints

- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Never bare `npx tsc` — it stack-overflows. Baseline clean.
- **No jsdom render tests.** Standing project decision (`surface-render-tests-declined`): components are verified over CDP, pure logic by vitest. **Do not write render or snapshot tests, and do not add `@testing-library/react`.** If a component contains logic you want to test, extract the logic to a pure module and test that.
- **No raw colours.** Every colour is an existing `@theme` token from `frontend/app/tailwindsetup.css` (`text-muted`, `bg-surface`, `border-border`, `text-accent-soft`, `bg-asking`, `text-success`, `text-warning`, …). If a needed shade has no token, add one to `tailwindsetup.css` — never inline a hex or `rgba()`.
- **No new SCSS.** Tailwind only.
- **Dark theme only.** Light/Paper mode is permanently out of scope — never add a light variant.
- **Fixed chrome dimensions:** 46px app bar, 78px nav rail, rail 300px open / 44px collapsed (`CollapsibleRail` already enforces the rail).
- **Per-subject state lives in module-scope jotai atoms**, keyed by subject id — never `useState` in the surface. The surface unmounts on nav switch, and surface-local state is lost (`surfaces-unmount-on-nav-switch`).
- **The thread and composer must never unmount** to make room for anything. Live worker output is expensive to remount.
- **Comments explain "why", never "what".** Lower case. Only where non-obvious.
- **No emojis in code or output.**
- Before any CDP verification, the dev app must be running and, if frontend modules moved, force a full `location.reload()` first — HMR can blank the page after module moves, and a blank page is not a test result.
- Do not commit unless a Commit step says to. Never add a co-author trailer.

---

### Task 1: Autonomy ladder

Replace the binary autonomy toggle with the real three-rung nested ladder plus the Delegator-only dispatch mode.

**Files:**
- Create: `frontend/app/view/jarvis/autonomyladder.tsx`
- Create: `frontend/app/view/jarvis/autonomyladder.ts`
- Create: `frontend/app/view/jarvis/autonomyladder.test.ts`

**Interfaces:**
- Consumes: `JarvisTier`, `tierFromMeta` from `@/app/view/agents/channelmessages`; `autonomyExplainer` from `@/app/view/agents/jarviscards`; `setChannelTier` from `@/app/view/agents/channelsstore`.
- Produces:
  - `LADDER: { tier: JarvisTier; label: string; blurb: string }[]` — index order is rung order
  - `rungState(tier: JarvisTier, rung: JarvisTier): "active" | "implied" | "off"`
  - `DISPATCH_MODES: readonly ["report", "manage", "fanout"]`
  - `showsDispatchMode(tier: JarvisTier): boolean`
  - `<AutonomyLadder channelId={string} tier={JarvisTier} mode={string} />`

The ladder is nested: `delegator` implies `gatekeeper` implies `concierge` (`pkg/jarvis/resolve.go:32`). A rung below the current tier is `implied` — filled, but not the selection. The dispatch mode is shown only at Delegator, the only tier where it means anything.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/autonomyladder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DISPATCH_MODES, LADDER, rungState, showsDispatchMode } from "./autonomyladder";

describe("LADDER", () => {
    it("orders the rungs from least to most autonomy", () => {
        expect(LADDER.map((r) => r.tier)).toEqual(["concierge", "gatekeeper", "delegator"]);
    });

    it("states the nesting in each blurb above the floor", () => {
        expect(LADDER[1].blurb).toContain("implies Concierge");
        expect(LADDER[2].blurb).toContain("implies Gatekeeper");
    });
});

describe("rungState", () => {
    it("marks the current tier active and everything below it implied", () => {
        expect(rungState("delegator", "delegator")).toBe("active");
        expect(rungState("delegator", "gatekeeper")).toBe("implied");
        expect(rungState("delegator", "concierge")).toBe("implied");
    });

    it("marks rungs above the current tier off", () => {
        expect(rungState("gatekeeper", "delegator")).toBe("off");
        expect(rungState("concierge", "gatekeeper")).toBe("off");
        expect(rungState("concierge", "delegator")).toBe("off");
    });

    it("makes the floor active at concierge — never merely implied", () => {
        expect(rungState("concierge", "concierge")).toBe("active");
    });
});

describe("showsDispatchMode", () => {
    it("shows the dispatch mode only at delegator", () => {
        expect(showsDispatchMode("delegator")).toBe(true);
        expect(showsDispatchMode("gatekeeper")).toBe(false);
        expect(showsDispatchMode("concierge")).toBe(false);
    });

    it("offers exactly the three backend modes", () => {
        expect(DISPATCH_MODES).toEqual(["report", "manage", "fanout"]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/autonomyladder.test.ts`
Expected: FAIL — cannot resolve `./autonomyladder`.

- [ ] **Step 3: Write the derivation**

Create `frontend/app/view/jarvis/autonomyladder.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The autonomy ladder's shape. The tiers are nested, not alternatives (pkg/jarvis/resolve.go): delegator
// implies gatekeeper implies concierge. Rendering it as accumulation is the whole point — three separate
// buttons would misrepresent the backend.

import type { JarvisTier } from "@/app/view/agents/channelmessages";

export const LADDER: { tier: JarvisTier; label: string; blurb: string }[] = [
    {
        tier: "concierge",
        label: "Concierge",
        blurb: "Jarvis watches and narrates. Every ask reaches you.",
    },
    {
        tier: "gatekeeper",
        label: "Gatekeeper",
        blurb: "implies Concierge, and answers routine asks itself. Real forks still escalate.",
    },
    {
        tier: "delegator",
        label: "Delegator",
        blurb: "implies Gatekeeper, and dispatches follow-up work without asking first.",
    },
];

const RANK: Record<JarvisTier, number> = { concierge: 0, gatekeeper: 1, delegator: 2 };

export function rungState(tier: JarvisTier, rung: JarvisTier): "active" | "implied" | "off" {
    if (rung === tier) return "active";
    return RANK[rung] < RANK[tier] ? "implied" : "off";
}

export const DISPATCH_MODES = ["report", "manage", "fanout"] as const;

// the dispatch mode only governs how a delegator fans work out; below that tier it has nothing to act on.
export function showsDispatchMode(tier: JarvisTier): boolean {
    return tier === "delegator";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/autonomyladder.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the component**

Create `frontend/app/view/jarvis/autonomyladder.tsx`. Write through the existing `setChannelTier`, which
already takes `(id, tier, mode)`. Consult the design's Stage header for spacing and the fill treatment.

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The channel's autonomy control in the Stage header. Three nested rungs with accumulating fill, plus the
// dispatch mode at Delegator only.

import { setChannelTier } from "@/app/view/agents/channelsstore";
import type { JarvisTier } from "@/app/view/agents/channelmessages";
import { cn, fireAndForget } from "@/util/util";
import { DISPATCH_MODES, LADDER, rungState, showsDispatchMode } from "./autonomyladder";

export function AutonomyLadder({ channelId, tier, mode }: { channelId: string; tier: JarvisTier; mode: string }) {
    const setTier = (next: JarvisTier) => fireAndForget(() => setChannelTier(channelId, next, mode));
    const setMode = (next: string) => fireAndForget(() => setChannelTier(channelId, tier, next));
    return (
        <div className="flex items-center gap-2 rounded-[8px] border border-border bg-surface py-0.5 pl-2.5 pr-1">
            <span className="font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">Autonomy</span>
            <div className="flex items-end gap-0.5">
                {LADDER.map((rung, i) => {
                    const state = rungState(tier, rung.tier);
                    return (
                        <button
                            key={rung.tier}
                            type="button"
                            title={`${rung.label} — ${rung.blurb}`}
                            onClick={() => setTier(rung.tier)}
                            className={cn(
                                "flex cursor-pointer flex-col items-center gap-[3px] rounded-[6px] border px-2 pb-1 pt-[3px]",
                                state === "active" && "border-accent/40 bg-accent/20 text-primary",
                                state === "implied" && "border-transparent bg-accent/10 text-accent-soft",
                                state === "off" && "border-transparent bg-transparent text-muted"
                            )}
                        >
                            <span className="text-[10.5px] font-bold">{rung.label}</span>
                            {/* the bar grows with the rung so the ladder reads as accumulation, not as a picker */}
                            <span
                                className={cn(
                                    "w-full rounded-[2px]",
                                    state === "off" ? "bg-edge-mid" : "bg-accent"
                                )}
                                style={{ height: 3 + i * 2 }}
                            />
                        </button>
                    );
                })}
            </div>
            {showsDispatchMode(tier) ? (
                <div className="ml-1 flex items-center gap-0.5 border-l border-border pl-1.5">
                    {DISPATCH_MODES.map((m) => (
                        <button
                            key={m}
                            type="button"
                            onClick={() => setMode(m)}
                            className={cn(
                                "cursor-pointer rounded-[5px] px-1.5 py-0.5 font-mono text-[10px]",
                                mode === m ? "bg-success/15 text-success" : "text-muted hover:text-secondary"
                            )}
                        >
                            {m}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. If `setChannelTier`'s signature differs from `(id, tier, mode)`, match the real one — check `channelsstore.ts`.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/jarvis/autonomyladder.ts frontend/app/view/jarvis/autonomyladder.tsx frontend/app/view/jarvis/autonomyladder.test.ts
git commit -m "feat(jarvis): three-rung nested autonomy ladder with delegator-only dispatch mode"
```

---

### Task 2: Subjects column

One left column for all three subject kinds, replacing three near-identical rails.

**Files:**
- Create: `frontend/app/view/jarvis/subjectscolumn.tsx`
- Create: `frontend/app/view/jarvis/jarvissubjectstore.ts`

**Interfaces:**
- Consumes: `buildSubjectGroups`, `subjectMark`, `Subject`, `SubjectGroup` from `./subjects`; `channelsAtom`, `selectChannel` from `@/app/view/agents/channelsstore`; `taskListAtom`, `loadTaskList`, `selectDossier` from `./tasksstore`; `jarvisConversationsAtom`, `loadJarvisConversations` from `./jarvisstore`; `activeSpaceAtom`, `spaceScopeAtom`, `spaceRevealAtom` from `@/app/view/agents/spacestore`; `spaceBannerText` from `@/app/view/agents/spacescope`; `projectsAtom` from `@/app/view/agents/projectsstore`.
- Produces:
  - `activeSubjectAtom: PrimitiveAtom<{ kind: SubjectKind; id: string } | null>` (in `jarvissubjectstore.ts`)
  - `selectSubject(subject: { kind: SubjectKind; id: string }): void`
  - `<SubjectsColumn model={AgentsViewModel} />`

`activeSubjectAtom` is module-scope because the surface unmounts on nav switch. `selectSubject` fans out to the existing per-kind selection (`selectChannel` / `selectDossier` / set the active conversation) so each kind's store stays the source of truth for its own detail.

- [ ] **Step 1: Create the subject store**

Create `frontend/app/view/jarvis/jarvissubjectstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Which subject the Stage is showing. Module-scope so it survives the surface unmount on nav switch, and
// so the per-kind stores below it stay the single source of truth for their own detail.

import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { selectChannel } from "@/app/view/agents/channelsstore";
import { atom, type PrimitiveAtom } from "jotai";
import { setActiveConversation } from "./jarvisstore";
import type { SubjectKind } from "./subjects";
import { selectDossier } from "./tasksstore";

export interface ActiveSubject {
    kind: SubjectKind;
    id: string;
}

export const activeSubjectAtom = atom<ActiveSubject | null>(null) as PrimitiveAtom<ActiveSubject | null>;

export function selectSubject(subject: ActiveSubject): void {
    globalStore.set(activeSubjectAtom, subject);
    if (subject.kind === "channel") {
        fireAndForget(() => selectChannel(subject.id));
        return;
    }
    if (subject.kind === "dossier") {
        selectDossier(subject.id);
        return;
    }
    setActiveConversation(subject.id);
}
```

- [ ] **Step 2: Add `setActiveConversation` and a conversations atom if absent**

Read `frontend/app/view/jarvis/jarvisstore.ts`. It already holds the conversation list and active id for
the recall surface. If a setter named `setActiveConversation(id: string)` and an exported list atom do not
exist, add them beside the existing atoms, following the file's existing `globalStore.set` style. Do not
rename anything already exported — other callers depend on it.

- [ ] **Step 3: Write the component**

Create `frontend/app/view/jarvis/subjectscolumn.tsx`. It is a 272px column: filter field, `+ Channel` /
`+ Thread` actions, the Space banner when a Space is active, then the grouped list. A selected channel or
dossier expands to its runs. See the design's Subjects column for row spacing and the status-dot treatment.

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Subjects column: channels, records and threads in one grouped list. Replaces ChannelRail,
// HistoryRail and the Tasks list — one column, three kinds.

import { SpaceBanner } from "@/app/view/agents/spacebanner";
import { channelsAtom } from "@/app/view/agents/channelsstore";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { spaceBannerText } from "@/app/view/agents/spacescope";
import { activeSpaceAtom, spaceRevealAtom, spaceScopeAtom } from "@/app/view/agents/spacestore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { activeSubjectAtom, selectSubject } from "./jarvissubjectstore";
import { jarvisConversationsAtom, loadJarvisConversations } from "./jarvisstore";
import { buildSubjectGroups, subjectMark, type Subject } from "./subjects";
import { loadTaskList, taskListAtom } from "./tasksstore";

export function SubjectsColumn({ model }: { model: AgentsViewModel }) {
    const channels = useAtomValue(channelsAtom);
    const dossiers = useAtomValue(taskListAtom);
    const conversations = useAtomValue(jarvisConversationsAtom);
    const projects = useAtomValue(projectsAtom);
    const active = useAtomValue(activeSubjectAtom);
    const activeSpace = useAtomValue(activeSpaceAtom);
    const spaceScope = useAtomValue(spaceScopeAtom);
    const revealed = useAtomValue(spaceRevealAtom).has("jarvis");

    useEffect(() => {
        loadTaskList();
        loadJarvisConversations();
    }, []);

    // project name for a channel: the bound project's display name, else the channel's own path tail.
    const projectNameFor = (channel: Channel) => {
        const match = projects?.find((p) => p.path === channel.projectpath);
        return match?.name ?? (channel.projectpath ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "unbound";
    };

    const groups = buildSubjectGroups({
        channels,
        dossiers,
        conversations,
        projectNameFor,
        spaceScope,
        spaceDossierId: activeSpace?.id ?? null,
        revealed,
    });

    const totalBefore = (channels?.length ?? 0) + dossiers.length + conversations.length;
    const totalAfter = groups.reduce((n, g) => n + g.items.length, 0);

    const isActive = (s: Subject) => active?.kind === s.kind && active?.id === s.id;

    return (
        <div className="flex w-[272px] flex-none flex-col border-r border-border bg-background">
            {activeSpace != null ? (
                <SpaceBanner
                    surface="jarvis"
                    text={spaceBannerText(activeSpace.objective, Math.max(0, totalBefore - totalAfter), revealed)}
                    revealed={revealed}
                />
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
                {groups.map((g) => (
                    <div key={g.key} className="mb-2">
                        <div className="flex items-center gap-2 px-2 py-1.5">
                            <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                                {g.label}
                            </span>
                            <div className="h-px flex-1 bg-border" />
                        </div>
                        {g.items.map((s) => (
                            <button
                                key={s.kind + ":" + s.id}
                                type="button"
                                onClick={() => selectSubject({ kind: s.kind, id: s.id })}
                                className={cn(
                                    "flex w-full cursor-pointer items-center gap-2 rounded-[8px] px-2.5 py-[7px] text-left hover:bg-surface-hover",
                                    isActive(s) && "bg-accent/10"
                                )}
                            >
                                <span
                                    className={cn(
                                        "w-[9px] flex-none font-mono text-[12px]",
                                        isActive(s) ? "text-accent-soft" : "text-muted"
                                    )}
                                >
                                    {subjectMark(s.kind)}
                                </span>
                                <span
                                    className={cn(
                                        "min-w-0 flex-1 truncate text-[12.5px]",
                                        isActive(s) ? "font-semibold text-primary" : "font-medium text-secondary"
                                    )}
                                >
                                    {s.label}
                                </span>
                            </button>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. `projectsAtom`'s element shape may differ — match what `projectsstore.ts` exports rather than assuming `{ name, path }`.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/jarvis/subjectscolumn.tsx frontend/app/view/jarvis/jarvissubjectstore.ts frontend/app/view/jarvis/jarvisstore.ts
git commit -m "feat(jarvis): one Subjects column for channels, records and threads"
```

---

### Task 3: Record band component

All five band cases from one component, driven by `recordBandCase()`.

**Files:**
- Create: `frontend/app/view/jarvis/recordbandview.tsx`

**Interfaces:**
- Consumes: `recordBandCase`, `edgeLabel`, `edgeLineStyle`, `BandCase` from `./recordband`; `TaskDetail` from `./taskdetail`; `AmbientTag` from `@/app/view/agents/ambient`.
- Produces: `<RecordBand kind={SubjectKind} tags={AmbientTag[]} mentionedIds={string[]} detail={DossierDetail | null} open={boolean} onToggle={() => void} />`

The collapsed line must render each edge's `edgeLabel` and a swatch using `edgeLineStyle` — a `border-top` whose style and width come from the returned values. Expanding a `several` band opens the primary in full with the others as one-line rows beneath. It must never become a tab strip.

- [ ] **Step 1: Write the component**

Create `frontend/app/view/jarvis/recordbandview.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The record band: docked above the thread, never a destination. Its whole job is to make attribution
// legible at a glance — a weak inferred link must not read like a confirmed one — so the collapsed line
// carries each edge's state, confidence and line style.

import type { AmbientTag } from "@/app/view/agents/ambient";
import { cn } from "@/util/util";
import { edgeLabel, edgeLineStyle, recordBandCase } from "./recordband";
import type { SubjectKind } from "./subjects";
import { TaskDetail } from "./taskdetail";

function EdgeChip({ tag }: { tag: AmbientTag }) {
    const line = edgeLineStyle(tag);
    return (
        <span className="flex items-center gap-[7px] rounded-[6px] border border-border px-2 py-[3px]">
            <span
                className="w-4 flex-none"
                style={{ borderTopStyle: line.style, borderTopWidth: line.weightPx, borderTopColor: "currentColor" }}
            />
            <span className="text-[11.5px] font-semibold text-secondary">{tag.label}</span>
            <span className="font-mono text-[9.5px] text-muted">{edgeLabel(tag)}</span>
        </span>
    );
}

export function RecordBand({
    kind,
    tags,
    mentionedIds,
    detail,
    open,
    onToggle,
}: {
    kind: SubjectKind;
    tags: AmbientTag[];
    mentionedIds: string[];
    detail: DossierDetail | null;
    open: boolean;
    onToggle: () => void;
}) {
    const band = recordBandCase({ kind, tags, mentionedIds });
    // a dossier subject IS the record, so its panel is always open and has no collapse affordance.
    const expandable = band.case === "one" || band.case === "several";
    const showPanel = band.case === "subject" || (expandable && open);

    return (
        <div className="flex-none border-b border-border bg-surface">
            <div
                className={cn("flex items-center gap-2.5 px-4 py-2.5", expandable && "cursor-pointer")}
                onClick={expandable ? onToggle : undefined}
            >
                {band.case === "none" ? (
                    <>
                        <span className="font-mono text-[11px] text-muted">No record attributed to this run</span>
                        <div className="flex-1" />
                        <span className="text-[11px] font-semibold text-accent-soft">Attach a record</span>
                        <span className="text-[11px] font-semibold text-muted">Create one from this run</span>
                    </>
                ) : band.case === "one" ? (
                    <>
                        <EdgeChip tag={band.edge} />
                        <div className="flex-1" />
                        <span className="text-[11px] font-semibold text-muted">{open ? "Collapse" : "Expand the record"}</span>
                    </>
                ) : band.case === "several" ? (
                    <>
                        <EdgeChip tag={band.primary} />
                        {band.others.map((o) => (
                            <EdgeChip key={o.taskId} tag={o} />
                        ))}
                        <div className="flex-1" />
                        <span className="text-[11px] font-semibold text-muted">{open ? "Collapse" : "Expand"}</span>
                    </>
                ) : band.case === "mentions" ? (
                    <>
                        <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                            Mentioned here
                        </span>
                        {band.ids.map((id) => (
                            <span
                                key={id}
                                className="rounded-[5px] border border-dashed border-accent/40 px-1.5 py-px font-mono text-[11px] text-accent-soft"
                            >
                                {id}
                            </span>
                        ))}
                        <span className="font-mono text-[11px] text-muted">
                            {band.ids.length === 0
                                ? "this thread has cited no record"
                                : "derived from this thread's citations — a conversation carries no attribution of its own"}
                        </span>
                    </>
                ) : (
                    <>
                        <span className="font-mono text-[11px] text-accent-soft">{detail?.id ?? ""}</span>
                        <span className="text-[12.5px] font-semibold text-secondary">Selected from Records</span>
                        <div className="flex-1" />
                        <span className="font-mono text-[11px] text-muted">the subject itself</span>
                    </>
                )}
            </div>
            {showPanel && detail != null ? (
                <div className="max-h-[420px] overflow-y-auto border-t border-border bg-background">
                    <TaskDetail detail={detail} />
                </div>
            ) : null}
            {/* the others are one-line rows under the primary — expanding must never produce a tab strip */}
            {expandable && open && band.case === "several" ? (
                <div className="flex flex-col gap-px border-t border-border px-4 py-2">
                    {band.others.map((o) => (
                        <div key={o.taskId} className="flex items-center gap-2 py-1">
                            <EdgeChip tag={o} />
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. `TaskDetail`'s prop name is `detail` — confirm against `taskdetail.tsx`.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/jarvis/recordbandview.tsx
git commit -m "feat(jarvis): record band with all five attribution cases"
```

---

### Task 4: The Stage

Four bands with subject-kind dispatch. The thread region is a stable sibling — it must not be inside a conditional that also governs the record band or the graph.

**Files:**
- Create: `frontend/app/view/jarvis/stage.tsx`
- Create: `frontend/app/view/jarvis/stageheader.tsx`
- Create: `frontend/app/view/jarvis/recordthread.tsx`

**Interfaces:**
- Consumes: `composeStage` from `./stagecompose`; `RecordBand` from `./recordbandview`; `AutonomyLadder` from `./autonomyladder`; `RunBody` from `@/app/view/agents/runbody`; `ConversationView` from `./conversationview`; `tierFromMeta` from `@/app/view/agents/channelmessages`; the ambient provider from `@/app/view/agents/ambientstore`; `mentionedDossierIds` from `./mentions`.
- Produces: `<Stage model={AgentsViewModel} />`, `<StageHeader … />`, `<RecordThread detail={DossierDetail | null} />`

`RecordThread` is the dossier subject's thread region: record activity (attributed runs, appended decisions) with the header line "no phases — a record does not run". It does **not** re-render the dossier's fields — those live in the record band above it.

- [ ] **Step 1: Write the Stage header**

Create `frontend/app/view/jarvis/stageheader.tsx`. It renders the mark, title, subtitle, then — per
`composeStage` — the reach text (static, **not** a control), the absence chip, the autonomy ladder, the ⚙
profile button, and the Graph button.

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Stage header. Which controls exist is decided by composeStage, never inline — a control must not be
// able to drift onto a subject that cannot have it.

import type { JarvisTier } from "@/app/view/agents/channelmessages";
import { cn } from "@/util/util";
import { AutonomyLadder } from "./autonomyladder";
import type { StageComposition } from "./stagecompose";

export function StageHeader({
    comp,
    title,
    subtitle,
    channelId,
    tier,
    mode,
    onOpenProfile,
    onOpenGraph,
}: {
    comp: StageComposition;
    title: string;
    subtitle: string;
    channelId: string | null;
    tier: JarvisTier;
    mode: string;
    onOpenProfile: () => void;
    onOpenGraph: () => void;
}) {
    return (
        <div className="flex h-11 flex-none items-center gap-2.5 border-b border-border bg-surface px-4">
            <span className="font-mono text-[13px] font-semibold text-accent-soft">{comp.mark}</span>
            <span className="text-[14px] font-bold tracking-[-.01em] text-primary">{title}</span>
            <span className="font-mono text-[11px] text-muted">{subtitle}</span>
            <div className="flex-1" />
            {/* a statement of reach, not a scope picker — Spaces own scoping, and two controls for one
                thing would be two sources of truth. */}
            {comp.reachText != null ? (
                <span className="rounded-[7px] border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-secondary">
                    Grounded in: {comp.reachText}
                </span>
            ) : null}
            {comp.absenceChip != null ? (
                <span className="rounded-[6px] border border-dashed border-border px-2 py-[3px] font-mono text-[10.5px] text-muted">
                    {comp.absenceChip}
                </span>
            ) : null}
            {comp.showAutonomy && channelId != null ? (
                <AutonomyLadder channelId={channelId} tier={tier} mode={mode} />
            ) : null}
            {comp.showProfile ? (
                <button
                    type="button"
                    onClick={onOpenProfile}
                    title="Channel profile — playbook, principles, run engine, plan gate"
                    className="h-[26px] w-7 cursor-pointer rounded-[7px] border border-border bg-surface text-[12px] text-secondary hover:text-primary"
                >
                    ⚙
                </button>
            ) : null}
            <button
                type="button"
                onClick={onOpenGraph}
                title="Peek the vault graph around this subject"
                className="cursor-pointer rounded-[7px] border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-primary"
            >
                Graph
            </button>
        </div>
    );
}
```

- [ ] **Step 2: Write the record thread**

Create `frontend/app/view/jarvis/recordthread.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A record's thread region. The record's own fields live in the band above; this is its activity — the
// runs attributed to it and the decisions appended to it.

export function RecordThread({ detail }: { detail: DossierDetail | null }) {
    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 pb-2.5 pt-4">
            <div className="flex items-center gap-2.5">
                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                    Record activity
                </span>
                <div className="h-px flex-1 bg-border" />
                <span className="font-mono text-[10.5px] text-muted">no phases — a record does not run</span>
            </div>
            {detail == null ? (
                <div className="text-[13px] text-muted">Loading…</div>
            ) : (
                <div className="flex flex-col gap-2">
                    {(detail.decisions ?? []).map((d) => (
                        <div key={d.id} className="rounded-[10px] border border-border bg-surface px-3 py-2.5">
                            <div className="text-[12.5px] leading-[1.45] text-secondary">{d.summary}</div>
                            <div className="mt-1 font-mono text-[10px] text-muted">{d.rationale}</div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
```

Match `DossierDetail`'s real field names — read the generated type before writing this. If decisions carry
different keys than `summary` / `rationale`, use the real ones.

- [ ] **Step 3: Write the Stage**

Create `frontend/app/view/jarvis/stage.tsx`. The critical structural requirement: `RunBody` /
`ConversationView` / `RecordThread` occupy one thread slot that is a **sibling** of the record band and the
graph overlay, so expanding the record or opening the graph never unmounts the thread.

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Stage: header, record band, thread, composer. The thread slot is a sibling of the band and the graph
// overlay — never nested inside either — so expanding a record or peeking the graph cannot unmount live
// worker output.

import { useAtomValue } from "jotai";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { ambientProviderAtom } from "@/app/view/agents/ambientstore";
import { activeChannelAtom, activeChannelRunsAtom } from "@/app/view/agents/channelsstore";
import { tierFromMeta } from "@/app/view/agents/channelmessages";
import { SurfaceEmptyState } from "@/app/view/agents/surfacescaffold";
import { ConversationView } from "./conversationview";
import { activeConversationAtom } from "./jarvisstore";
import { activeSubjectAtom } from "./jarvissubjectstore";
import { mentionedDossierIds } from "./mentions";
import { RecordBand } from "./recordbandview";
import { RecordThread } from "./recordthread";
import { composeStage } from "./stagecompose";
import { StageHeader } from "./stageheader";
import { dossierDetailAtom } from "./tasksstore";

export function Stage({ model }: { model: AgentsViewModel }) {
    const subject = useAtomValue(activeSubjectAtom);
    const channel = useAtomValue(activeChannelAtom);
    const detail = useAtomValue(dossierDetailAtom);
    const conversation = useAtomValue(activeConversationAtom);
    const ambient = useAtomValue(ambientProviderAtom);

    if (subject == null) {
        return (
            <SurfaceEmptyState
                title="Point me at some work."
                body="I dispatch runs, keep the record of what they did, and remember it afterwards. Start a channel and I'll drive it — or just ask me something and I'll tell you what I can and can't ground."
            />
        );
    }

    const comp = composeStage(subject.kind);
    const tier = tierFromMeta((channel?.meta as Record<string, unknown>) ?? {});
    const mode = ((channel?.meta as Record<string, unknown>)?.["delegator:mode"] as string) ?? "report";

    return (
        <div className="relative flex min-w-0 flex-1 flex-col bg-background">
            <StageHeader
                comp={comp}
                title={subject.kind === "channel" ? (channel?.name ?? "") : subject.kind === "dossier" ? (detail?.objective ?? "") : (conversation?.title ?? "")}
                subtitle=""
                channelId={subject.kind === "channel" ? subject.id : null}
                tier={tier}
                mode={mode}
                onOpenProfile={() => {}}
                onOpenGraph={() => {}}
            />
            <RecordBand
                kind={subject.kind}
                tags={comp.recordBand === "attributed" ? ambient.tagsFor({ oref: "run:" + subject.id }) : []}
                mentionedIds={conversation != null ? mentionedDossierIds(conversation) : []}
                detail={detail}
                open={false}
                onToggle={() => {}}
            />
            {/* one thread slot, three renderers — a sibling of the band above and the overlay below */}
            <div className="flex min-h-0 flex-1 flex-col">
                {comp.thread === "record" ? (
                    <RecordThread detail={detail} />
                ) : comp.thread === "turns" ? (
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        <ConversationView conversation={conversation} model={model} />
                    </div>
                ) : null}
            </div>
        </div>
    );
}
```

The `run` thread case, the record-band open state, the profile drawer, the graph overlay and the composer
are wired in Tasks 5–7. Leave the handlers as no-ops here — do not stub them with fake behaviour.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. Confirm the real export name for the ambient provider atom in `ambientstore.ts`; if it
differs from `ambientProviderAtom`, use the real one.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/jarvis/stage.tsx frontend/app/view/jarvis/stageheader.tsx frontend/app/view/jarvis/recordthread.tsx
git commit -m "feat(jarvis): Stage with four bands and subject-kind dispatch"
```

---

### Task 5: Run thread and record-band open state

Wire the channel subject's thread to `RunBody`, and give the record band real open/close state that survives the surface unmount.

**Files:**
- Modify: `frontend/app/view/jarvis/jarvissubjectstore.ts` (add the band-open atom)
- Modify: `frontend/app/view/jarvis/stage.tsx`

**Interfaces:**
- Consumes: `RunBody` from `@/app/view/agents/runbody`; `resolveActiveRunId`, `defaultRunId` from `@/app/view/agents/runmodel`; `pendingRunFocusAtom` from `@/app/view/agents/runactions`.
- Produces: `recordBandOpenAtom: PrimitiveAtom<Record<string, boolean>>` keyed by subject id; `activeRunIdAtom: PrimitiveAtom<Record<string, string | undefined>>` keyed by channel id.

Both are keyed records rather than single values because the user switches subjects and must find each one as they left it (spec §13, "the last subject you were on, exactly as you left it").

- [ ] **Step 1: Add the per-subject atoms**

Append to `frontend/app/view/jarvis/jarvissubjectstore.ts`:

```ts
// keyed by subject id, not a single value: switching subjects must return each one to the state it was in
// (spec: "the last subject you were on, exactly as you left it").
export const recordBandOpenAtom = atom<Record<string, boolean>>({}) as PrimitiveAtom<Record<string, boolean>>;
export const activeRunIdAtom = atom<Record<string, string | undefined>>({}) as PrimitiveAtom<
    Record<string, string | undefined>
>;

export function toggleRecordBand(subjectId: string): void {
    const prev = globalStore.get(recordBandOpenAtom);
    globalStore.set(recordBandOpenAtom, { ...prev, [subjectId]: !prev[subjectId] });
}

export function setActiveRunId(channelId: string, runId: string | undefined): void {
    const prev = globalStore.get(activeRunIdAtom);
    globalStore.set(activeRunIdAtom, { ...prev, [channelId]: runId });
}
```

- [ ] **Step 2: Wire the run thread and band state into the Stage**

In `stage.tsx`: read `recordBandOpenAtom` and `activeRunIdAtom`; pass `open={bandOpen[subject.id] ?? false}`
and `onToggle={() => toggleRecordBand(subject.id)}` to `RecordBand`; and in the thread slot add the run case:

```tsx
{comp.thread === "run" ? (
    run != null ? (
        <RunBody model={model} channel={channel!} agents={agents} run={run} />
    ) : (
        <SurfaceEmptyState
            title={`Start a run in #${channel?.name ?? "channel"}`}
            body="Give Jarvis a goal below. @quick spawns one worker, @run kicks off the channel's full strategy, and @ask is a one-shot consult."
        />
    )
) : comp.thread === "record" ? (
```

Resolve `run` from `activeChannelRunsAtom` + `activeRunIdAtom` using the existing `resolveActiveRunId` /
`defaultRunId` helpers, exactly as `channelssurface.tsx` does today. Read that file's run-resolution block
and reuse its logic rather than inventing a second one.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Verify the record band expands without disturbing the thread**

With the dev app running, open the merged surface, select a channel with a live run, and expand the record
band. Run: `node scripts/cdp-shot.mjs cdp-shots/stage-band-expand.png`
Expected: the band's panel appears above the thread; the thread keeps its scroll position and any live
worker output keeps streaming. If the transcript resets, the thread is nested inside the band's conditional
— fix the structure, not the symptom.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/jarvis/jarvissubjectstore.ts frontend/app/view/jarvis/stage.tsx
git commit -m "feat(jarvis): run thread in the Stage with per-subject record-band state"
```

---

### Task 6: One composer

One composer that retargets in place. `@jarvis` stops navigating; `@run` / `@quick` on a non-channel subject open a channel picker.

**Files:**
- Create: `frontend/app/view/jarvis/stagecomposer.tsx`
- Create: `frontend/app/view/jarvis/composertarget.ts`
- Create: `frontend/app/view/jarvis/composertarget.test.ts`
- Modify: `frontend/app/view/agents/channelactions.ts` (delete the surface-flipping `@jarvis` handoff)

**Interfaces:**
- Consumes: `parseComposerCommand`, `composerFace` from `@/app/view/agents/composercommand`; `StageComposition` from `./stagecompose`.
- Produces:
  - `resolveComposerTarget(input: TargetInput): ComposerTarget`
  - `interface ComposerTarget { audience: "worker" | "jarvis"; label: string; needsChannelPicker: boolean }`
  - `<StageComposer … />`

The chip colour carries the distinction: a worker audience is `success`-toned, Jarvis is `accent`-toned. That is the only cue that tells the user whether a keystroke reaches a running agent.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/composertarget.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveComposerTarget } from "./composertarget";

describe("resolveComposerTarget", () => {
    it("targets the live worker on a channel with one, when no command is typed", () => {
        const t = resolveComposerTarget({
            composerTarget: "worker-or-jarvis",
            draft: "make it faster",
            workerName: "impl-2",
            runLabel: "run 4c",
        });
        expect(t).toEqual({ audience: "worker", label: "impl-2 · run 4c", needsChannelPicker: false });
    });

    it("switches to Jarvis the moment @ask is typed, even on a channel with a live worker", () => {
        const t = resolveComposerTarget({
            composerTarget: "worker-or-jarvis",
            draft: "@ask why did we drop it",
            workerName: "impl-2",
            runLabel: "run 4c",
        });
        expect(t.audience).toBe("jarvis");
        expect(t.needsChannelPicker).toBe(false);
    });

    it("targets Jarvis on a channel with no live worker", () => {
        const t = resolveComposerTarget({
            composerTarget: "worker-or-jarvis",
            draft: "anything",
            workerName: undefined,
            runLabel: undefined,
        });
        expect(t.audience).toBe("jarvis");
    });

    it("always targets Jarvis on a conversation and never asks for a channel to chat", () => {
        const t = resolveComposerTarget({ composerTarget: "jarvis-thread", draft: "keep going" });
        expect(t).toEqual({ audience: "jarvis", label: "Jarvis · this thread", needsChannelPicker: false });
    });

    it("needs a channel picker for @run on a conversation — there is no channel in scope", () => {
        const t = resolveComposerTarget({ composerTarget: "jarvis-thread", draft: "@run investigate it" });
        expect(t.needsChannelPicker).toBe(true);
    });

    it("needs a channel picker for @quick on a record too", () => {
        const t = resolveComposerTarget({ composerTarget: "jarvis-record", draft: "@quick check the flag" });
        expect(t.needsChannelPicker).toBe(true);
        expect(t.label).toBe("Jarvis · scoped to this record");
    });

    it("does not need a picker for @ask on a record", () => {
        expect(resolveComposerTarget({ composerTarget: "jarvis-record", draft: "@ask what changed" }).needsChannelPicker).toBe(
            false
        );
    });

    it("treats a bare goal on a record as a dispatch, so it needs a picker", () => {
        // parseComposerCommand defaults a bare goal to @run — the picker rule must follow that default.
        expect(resolveComposerTarget({ composerTarget: "jarvis-record", draft: "add the counter" }).needsChannelPicker).toBe(
            true
        );
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/composertarget.test.ts`
Expected: FAIL — cannot resolve `./composertarget`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/jarvis/composertarget.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Who the composer is talking to. The user must never be unsure whether a keystroke reaches a running
// worker or Jarvis, so this is one pure decision consumed by the chip, the placeholder and the send path.

import { parseComposerCommand } from "@/app/view/agents/composercommand";
import type { StageComposition } from "./stagecompose";

export interface TargetInput {
    composerTarget: StageComposition["composerTarget"];
    draft: string;
    workerName?: string;
    runLabel?: string;
}

export interface ComposerTarget {
    audience: "worker" | "jarvis";
    label: string;
    needsChannelPicker: boolean;
}

export function resolveComposerTarget(input: TargetInput): ComposerTarget {
    const cmd = parseComposerCommand(input.draft ?? "");
    const dispatching = cmd.mode === "run" || cmd.mode === "quick";

    if (input.composerTarget === "worker-or-jarvis") {
        // an explicit @ask beats the live worker: typing it is the user asking Jarvis, not the worker.
        if (cmd.mode === "ask" || input.workerName == null) {
            return { audience: "jarvis", label: "Jarvis", needsChannelPicker: false };
        }
        return {
            audience: "worker",
            label: input.runLabel ? `${input.workerName} · ${input.runLabel}` : input.workerName,
            needsChannelPicker: false,
        };
    }
    // off-channel subjects have no channel to dispatch into, so a dispatch must pick one first.
    const label = input.composerTarget === "jarvis-record" ? "Jarvis · scoped to this record" : "Jarvis · this thread";
    return { audience: "jarvis", label, needsChannelPicker: dispatching };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/composertarget.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Delete the `@jarvis` surface-flipping handoff**

Open `frontend/app/view/agents/channelactions.ts` around line 115. Remove the block that sets
`pendingFleetSummaryAtom`, flips `jarvisModeAtom`, and writes `model.surfaceAtom = "jarvis"`. Replace it
with posting the fleet summary into the current thread — the same `useFleetSummary` path the rail's
"Summarize the fleet" button uses. Drop the now-unused imports of `jarvisModeAtom` and
`pendingFleetSummaryAtom` from `@/app/view/jarvis/jarvisstore`.

- [ ] **Step 6: Write the composer**

Create `frontend/app/view/jarvis/stagecomposer.tsx`, reusing the existing `LaunchComposer` / `TalkComposer`
bodies from `@/app/view/agents/channelcomposers` and choosing between them with `resolveComposerTarget`.
Render the "Talking to" line above the input with the chip toned by `audience` — `success` for a worker,
`accent` for Jarvis. When `needsChannelPicker` is true, show the channel picker before dispatch instead of
sending.

- [ ] **Step 7: Typecheck and run the composer tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Run: `npx vitest run frontend/app/view/agents/composercommand.test.ts frontend/app/view/jarvis/composertarget.test.ts`
Expected: exit 0 and PASS. The existing `composercommand` tests must not change — the parser is untouched.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/jarvis/composertarget.ts frontend/app/view/jarvis/composertarget.test.ts frontend/app/view/jarvis/stagecomposer.tsx frontend/app/view/agents/channelactions.ts
git commit -m "feat(jarvis): one retargeting composer; @jarvis posts in place instead of navigating"
```

---

### Task 7: Context rail and graph peek

One `CollapsibleRail` whose Fleet section follows the subject, and the graph as an overlay that can only be left by opening something.

**Files:**
- Create: `frontend/app/view/jarvis/stagerail.tsx`
- Create: `frontend/app/view/jarvis/graphpeek.tsx`
- Modify: `frontend/app/view/jarvis/stage.tsx` (mount the overlay, wire the Graph button)

**Interfaces:**
- Consumes: `CollapsibleRail`, `RailSection` from `@/app/element/collapsiblerail`; the Needs-you / Consults section builders from `@/app/view/agents/channelcontextpanel`; `GroundingRail` sections from `./groundingrail`; `fleetForRecord` from `./fleetscope`; `buildFleetSnapshot`, `fleetCostUsd` from `@/app/view/agents/jarvisderive`; `fleetCounts` from `@/app/view/agents/jarviscards`; `JarvisGraph` from `./jarvisgraph`; `loadGraph`, `selectNode`, `focusDossier`, `graphSelectedIdAtom` from `./jarvisgraphstore`.
- Produces: `<StageRail model={AgentsViewModel} comp={StageComposition} />`, `<GraphPeek onClose={() => void} onOpenSubject={(s: ActiveSubject) => void} />`

Rail composition: Needs you (always), Grounding (when there is an answer), Fleet (per `comp.showFleet`,
titled `comp.fleetTitle`). A channel's roster comes from `buildFleetSnapshot`; a record's comes from
`fleetForRecord`. **Needs you is never filtered by a Space** — an ask from a channel outside focus still
appears, tagged "outside focus".

- [ ] **Step 1: Write the rail**

Create `frontend/app/view/jarvis/stagerail.tsx`. Build the `RailSection[]` conditionally and hand it to one
`CollapsibleRail` with a module-scope `openAtom`. Reuse the existing section bodies — do not rewrite the
Needs-you row or the grounding card.

- [ ] **Step 2: Write the graph peek**

Create `frontend/app/view/jarvis/graphpeek.tsx`: an absolutely-positioned overlay (`absolute inset-0`) over
the Stage with a translucent backdrop, the `JarvisGraph` canvas, and a side panel whose actions are *Open
run on the Stage*, *Open record*, and *Ask Jarvis about this node*. Every action calls `onOpenSubject` and
then `onClose`. `Esc` also closes. Call `loadGraph()` on mount if not loaded, and `focusDossier()` when the
selected node is a dossier.

The overlay must be a sibling of the thread inside the Stage, never a wrapper around it.

- [ ] **Step 3: Wire it into the Stage**

In `stage.tsx`, add a module-scope `graphPeekOpenAtom`, set it from the header's `onOpenGraph`, and render
`<GraphPeek/>` as the last child of the Stage's root — after the composer, so it layers above everything
without containing any of it.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Verify the graph opens and closes into an object**

With the dev app running: open the merged surface, press the Graph button, click a node, then use *Open run
on the Stage*.
Run: `node scripts/cdp-shot.mjs cdp-shots/graph-peek.png`
Expected: the overlay covers the Stage; choosing an action closes it and puts that object on the Stage. Live
worker output must still be streaming underneath when the overlay closes — if the transcript restarted, the
overlay is wrapping the thread instead of layering over it.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/stagerail.tsx frontend/app/view/jarvis/graphpeek.tsx frontend/app/view/jarvis/stage.tsx
git commit -m "feat(jarvis): one context rail and the graph as an overlay, not a destination"
```

---

### Task 8: Assemble the surface

Replace `jarvissurface.tsx` with the three-region composition. After this task the merged surface is live on the existing Jarvis nav entry, and Channels/Graph/Tasks still exist — nothing is broken.

**Files:**
- Modify: `frontend/app/view/jarvis/jarvissurface.tsx` (full rewrite)
- Delete: `frontend/app/view/jarvis/fleetmode.tsx`, `frontend/app/view/jarvis/historyrail.tsx`

**Interfaces:**
- Consumes: `SubjectsColumn`, `Stage`, `StageRail`.
- Produces: `<JarvisSurface model={AgentsViewModel} />` — same export name and props as today, so `cockpitshell.tsx` needs no change in this task.

- [ ] **Step 1: Rewrite the surface**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one Jarvis surface: Subjects · Stage · context rail. Channels, records, threads and the graph all
// live here — the graph as an overlay, a record as a band, never as separate destinations.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { useAtomValue } from "jotai";
import { activeSubjectAtom } from "./jarvissubjectstore";
import { Stage } from "./stage";
import { StageRail } from "./stagerail";
import { SubjectsColumn } from "./subjectscolumn";
import { composeStage } from "./stagecompose";

export function JarvisSurface({ model }: { model: AgentsViewModel }) {
    const subject = useAtomValue(activeSubjectAtom);
    const comp = subject != null ? composeStage(subject.kind) : null;
    return (
        <div className="absolute inset-0 flex bg-background">
            <SubjectsColumn model={model} />
            <Stage model={model} />
            {comp != null ? <StageRail model={model} comp={comp} /> : null}
        </div>
    );
}
```

- [ ] **Step 2: Delete the superseded components**

```bash
git rm frontend/app/view/jarvis/fleetmode.tsx frontend/app/view/jarvis/historyrail.tsx
```

`fleetmode.tsx` is now the rail's Fleet section; `historyrail.tsx` is now part of the Subjects column. If
anything still imports `FleetMode`, `jarvisModeAtom`, or `HistoryRail`, remove those references — the
mode switch no longer exists.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. Every error here is a leftover reference to the deleted mode switch — fix them, don't suppress them.

- [ ] **Step 4: Full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Verify all three subject kinds render**

With the dev app running and a full reload done, open the Jarvis entry and select a channel, then a record,
then a thread. Shoot each: `node scripts/cdp-shot.mjs cdp-shots/subject-channel.png` (and `-record`, `-thread`).
Expected: per the composition table — no autonomy ladder or ⚙ on a record or thread, no Fleet section on a
thread, the record band present in its right case for each.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/app/view/jarvis
git commit -m "feat(jarvis): assemble the merged surface — Subjects, Stage, one rail"
```

---

### Task 9: Cut over the nav rail

Delete three `SurfaceKey`s and everything that referenced them. This is the task that takes the rail from 11 entries to 8.

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx:29-56` (`SurfaceKey`, `SURFACE_ORDER`)
- Modify: `frontend/app/view/agents/navrail.tsx` (`ICON`, `ITEMS`, badges)
- Modify: `frontend/app/view/agents/cockpitshell.tsx` (surface switch, imports)
- Modify: `frontend/app/store/keybindings/bindings.ts` (`GO_TARGETS`, `ESC_HOME_SURFACES`)
- Modify: `frontend/app/view/jarvis/openref.ts` (route to the merged surface; make `task` routable)
- Delete: `frontend/app/view/agents/channelssurface.tsx`, `frontend/app/view/jarvis/taskssurface.tsx`, `frontend/app/view/jarvis/jarvisgraphsurface.tsx`
- Create: `frontend/app/view/agents/surfaceorder.test.ts`

**Interfaces:**
- Produces: `SurfaceKey` with 9 members; `SURFACE_ORDER` with 8.

- [ ] **Step 1: Write the failing guard test**

Create `frontend/app/view/agents/surfaceorder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SURFACE_ORDER } from "./agents";
import { ITEMS } from "./navrail";

describe("SURFACE_ORDER", () => {
    it("has exactly 8 entries so Ctrl+1..8 covers every one — no surface is unreachable by chord", () => {
        expect(SURFACE_ORDER).toHaveLength(8);
    });

    it("no longer carries the merged-away surfaces", () => {
        expect(SURFACE_ORDER).not.toContain("channels");
        expect(SURFACE_ORDER).not.toContain("graph");
        expect(SURFACE_ORDER).not.toContain("tasks");
    });

    it("matches the nav rail's order exactly, so the chord numbers line up with what the user sees", () => {
        expect(ITEMS.map((i) => i.key)).toEqual([...SURFACE_ORDER]);
    });

    it("keeps Jarvis second — Ctrl+2 is the merged surface", () => {
        expect(SURFACE_ORDER[1]).toBe("jarvis");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/surfaceorder.test.ts`
Expected: FAIL — `SURFACE_ORDER` has 11 entries.

- [ ] **Step 3: Shrink `SurfaceKey` and `SURFACE_ORDER`**

In `frontend/app/view/agents/agents.tsx`, remove `"channels"`, `"graph"` and `"tasks"` from the
`SurfaceKey` union, and set:

```ts
// Ordered to match the NavRail (navrail.tsx ITEMS) so Ctrl+1..8 line up with what the user sees. All 8
// entries are chorded — there is no unchorded remainder.
export const SURFACE_ORDER: SurfaceKey[] = [
    "cockpit",
    "jarvis",
    "agent",
    "radar",
    "sessions",
    "files",
    "memory",
    "usage",
];
```

- [ ] **Step 4: Update the nav rail**

In `navrail.tsx`: drop the `channels`, `graph` and `tasks` entries from `ICON` and `ITEMS`, drop the
`MessagesSquare`, `Waypoints` and `ListTodo` imports, and move the channel-ask badge to Jarvis:

```tsx
    // Two disjoint "needs you" badges: Jarvis counts asks a channel dispatched/steered; Cockpit counts
    // standalone asks (launched from the cockpit/Agent tab, no channel). Disjoint by construction — an ask
    // is channel-attributed or not, never both — so no ask is counted twice.
    const badges: Partial<Record<SurfaceKey, number>> = {
        cockpit: standalonePendingAskCount(chanList, agents),
        jarvis: channelPendingAskCount(chanList, agents),
    };
```

- [ ] **Step 5: Update the surface switch**

In `cockpitshell.tsx`: delete the `channels`, `graph` and `tasks` branches and the
`ChannelsSurface` / `JarvisGraphSurface` / `TasksSurface` imports. `JarvisSurface` already covers all three.

- [ ] **Step 6: Update the keybindings**

In `frontend/app/store/keybindings/bindings.ts`:
- `GO_TARGETS`: change `{ letter: "c", surface: "channels", label: "Channels" }` to
  `{ letter: "c", surface: "jarvis", label: "Jarvis (channels, records, recall)" }`. Remove the duplicate
  `jarvis` target if one exists — two letters for one surface is fine, two entries with the same letter is not.
- `ESC_HOME_SURFACES`: replace `"channels"` with `"jarvis"`.

- [ ] **Step 7: Route orefs at the merged surface, and make a record openable**

In `frontend/app/view/jarvis/openref.ts`:
- Replace both `globalStore.set(model.surfaceAtom, "channels")` calls with `"jarvis"`.
- Add `task` to `OrefNav` and `orefNavPlan` — a dossier now **has** a surface, so a `task:` oref is
  routable for the first time. Its `openORef` branch calls `selectSubject({ kind: "dossier", id: oid })`.
  Update the file's header comment: `task` is no longer in the unsupported list.

This is what makes the graph peek's *Open record* action and a `[n]` citation on a task card work.

- [ ] **Step 8: Delete the merged-away surfaces**

```bash
git rm frontend/app/view/agents/channelssurface.tsx frontend/app/view/jarvis/taskssurface.tsx frontend/app/view/jarvis/jarvisgraphsurface.tsx
```

- [ ] **Step 9: Run the guard test and typecheck**

Run: `npx vitest run frontend/app/view/agents/surfaceorder.test.ts`
Expected: PASS (4 tests).

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. Errors here are dangling references to the deleted surfaces — fix each at its source.

- [ ] **Step 10: Full suite**

Run: `npx vitest run`
Expected: PASS. Pay attention to `frontend/app/store/keybindings/store.test.ts` — it asserts chord
coverage and will catch a `SURFACE_ORDER` mistake.

- [ ] **Step 11: Commit**

```bash
git add -A frontend/app frontend/app/store/keybindings/bindings.ts
git commit -m "feat(jarvis): cut the nav rail to 8 entries — Channels, Graph and Tasks merge into Jarvis"
```

---

### Task 10: CDP scenarios and the verification gate

Update the harness for the new surface set and add scenarios for what unit tests cannot reach.

**Files:**
- Modify: `scripts/cdp/attach.mjs` (`SURFACE_LABEL`)
- Modify: `scripts/cdp/scenarios.mjs` (retarget `surface: "channels"`, add new scenarios)

**Interfaces:**
- Consumes: the `h` harness (`h.rpc`, `h.goto`, `h.ev`, `h.shot`) documented at the top of `scenarios.mjs`.
- Produces: scenarios `jarvis-subject-kinds`, `jarvis-record-band`, `jarvis-graph-peek`.

Asserts are RPC-based or DOM-based — never jotai atom reads (`globalStore` is not exposed on `window`).

- [ ] **Step 1: Fix `SURFACE_LABEL`**

In `scripts/cdp/attach.mjs`, remove the `channels: "Channels"` entry. The map now lists exactly the 8 nav
labels plus `settings`. It already omits `graph` and `tasks` — that gap closes itself now that those keys
are gone.

- [ ] **Step 2: Retarget the existing scenarios**

In `scripts/cdp/scenarios.mjs`, change `surface: "channels"` to `surface: "jarvis"` at both occurrences
(lines 18 and 685 at time of writing). Any assert that finds a DOM node by a Channels-specific label must
be updated to the merged surface's markup — run each and fix what actually breaks rather than guessing.

- [ ] **Step 3: Add the subject-kinds scenario**

Add a scenario named `jarvis-subject-kinds` that: creates a channel over a temp cwd via
`h.rpc("createchannel", …)`, goes to the `jarvis` surface, and for each of the three subject kinds asserts
via `h.ev` that the composition table held —

- channel selected: an autonomy control is present, a ⚙ button is present
- record selected: no autonomy control, no ⚙, a record band is present
- thread selected: no autonomy control, no ⚙, no Fleet heading in the rail

Delete the channel in `teardown`.

- [ ] **Step 4: Add the record-band scenario**

Add `jarvis-record-band` asserting the zero case renders the absence line and both CTAs (*Attach a record*,
*Create one from this run*) for a freshly created run with no attribution — the case a fixture would
otherwise never show.

- [ ] **Step 5: Add the graph-peek scenario**

Add `jarvis-graph-peek` asserting: the overlay opens from the header button; `Esc` closes it; and after
closing, the Stage still shows the same subject it had before. This is the guard for "the peek is never a
destination".

- [ ] **Step 6: Run the harness**

Run: `task verify:ui -- jarvis-subject-kinds jarvis-record-band jarvis-graph-peek`
Expected: PASS table, exit 0. A contact sheet lands in `cdp-shots/index.html`.

- [ ] **Step 7: Run the full harness**

Run: `task verify:ui`
Expected: every scenario PASS. If a pre-existing scenario fails for a reason unrelated to this plan, say so
explicitly in the report rather than fixing it silently or calling the run clean.

- [ ] **Step 8: Final gate**

Run: `npx vitest run`
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Run: `npx eslint frontend/app/view/jarvis`
Expected: PASS, exit 0, no errors.

- [ ] **Step 9: Commit**

```bash
git add scripts/cdp/attach.mjs scripts/cdp/scenarios.mjs
git commit -m "test(jarvis): CDP scenarios for subject kinds, the record band and the graph peek"
```

- [ ] **Step 10: Report**

State: tasks landed, vitest count, `verify:ui` result, and the nav rail's entry count. Name anything
skipped. Do not report the merge as verified if `task verify:ui` was not run against a live dev app.

---

## Deferred, not forgotten

Spec §17 lists the Jarvis **acceptance-drift proactive card** on the dossier Stage as new behaviour rather
than consolidation. It is deliberately not in this plan. Schedule it separately once the merge is verified.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3 three regions | 8 |
| §4 subject model in the column | 2 |
| §4 Stage composition applied | 4, 8 |
| §5 record band, all cases | 3, 5 |
| §6 run thread + Jarvis turns | 5 (renderer from foundations Task 1) |
| §7 one composer, `@jarvis` in place, channel picker | 6 |
| §8 graph peek | 7 |
| §9 autonomy ladder | 1 |
| §10 needs-you badge, disjoint | 9 |
| §11 Space scoping; needs-you never filtered | 2, 7 |
| §12 narrow window collapse | 7 (`CollapsibleRail` supplies 300/44 and `forceCollapsed`) |
| §13 entry points | 5 (per-subject state), 9 (`openref` routing) |
| §14 nav, chords, deletions | 9 |
| §15 new derivations | foundations 2, 6 |
| §16 reach text static, not a control | 4 |
| §18 CDP scenarios | 10 |

**Gap found and closed during review:** the spec's §14 deletion list omitted `openref.ts`, which hardcodes
`surfaceAtom = "channels"` twice and classifies `task:` orefs as unsupported. Both are now Task 9 Step 7 —
without it, every grounding citation that pointed at a channel or run would navigate to a deleted surface,
and the graph peek's *Open record* action would have nothing to call.

**Placeholder scan:** Tasks 6 Step 6, 7 Steps 1–2 and 10 Steps 3–5 describe components and scenarios in
prose rather than full code, and say which existing module to reuse. That is deliberate: their visual detail
is specified by the design file, which is named as the authority, and the pure logic they consume is already
fully specified and tested. No step says "TBD", "handle edge cases", or "add error handling".

**Type consistency:** `SubjectKind` / `Subject` / `ActiveSubject`, `StageComposition`, `BandCase`,
`AmbientTag`, `JarvisTier` and `WorkerState` are each defined once — in the foundations plan or in existing
code — and imported by name everywhere else. `composeStage()` is the only source of composition booleans;
no task re-derives them. `resolveComposerTarget` is the only source of composer audience.
