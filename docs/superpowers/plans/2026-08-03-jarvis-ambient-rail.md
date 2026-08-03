# Jarvis Ambient Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the three Jarvis ambient views — the continuity resume narrative, the proactive related-prior-work suggestion, and the relevant-past-decisions list — out of the run body's three render branches into one context-rail section chosen by the subject on the Stage, so a sealed run and a record subject stop showing none of them.

**Architecture:** A pure derivation module decides which of the three views apply to the current subject and what each is keyed to; a thin view turns that into a `RailSection`; the rail pushes it last. The three existing call sites in the run body are deleted, so there is exactly one home. No Go changes, no codegen, no new RPC — both meta keys are already written by the server and already arrive on the run's `waveobj:update`.

**Tech Stack:** TypeScript, React 19, jotai, Tailwind 4, vitest, Chrome DevTools Protocol scenarios (`scripts/cdp/`).

**Spec:** `docs/superpowers/specs/2026-08-03-jarvis-ambient-rail-design.md`

## Global Constraints

- **Never commit without explicit user approval.** This repo batches into one commit at the end. Every task below ends with a verification step, not a commit; Task 6 is the single approval-gated commit.
- **The spec and this plan fold into that same feature commit** — never a separate docs-only commit.
- **Typecheck with** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Bare `npx tsc` stack-overflows on this repo, which also means `task check:ts` is broken. The baseline is clean (exit 0), so any error it reports is yours.
- **Colors come from `@theme` tokens** in `frontend/tailwindsetup.css` — never raw hex or rgba in components. A hardcoded color silently opts out of every runtime theme.
- **Never hand-edit generated files.** Nothing in this plan touches them.
- **Do not run `npx prettier --write` on files you did not author.** It reorders imports and rewraps the whole file, turning a 4-line edit into a 600-line diff. Hand-format your own lines.
- **Do not add a CDP scenario named `jarvis-ambient`** or a near-variant — that name is already taken (`scripts/cdp/scenarios.mjs:570`).
- The section's user-facing label is exactly **`Worth knowing`**.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/app/view/jarvis/ambientrail.ts` | **new.** Pure: which of the three views apply to a subject, and what each is keyed to. Returns data, never JSX. |
| `frontend/app/view/jarvis/ambientrail.test.ts` | **new.** Unit tests for the above. |
| `frontend/app/view/jarvis/ambientrailview.tsx` | **new.** Thin: turns that data into a `RailSection`, reusing the three existing card components unchanged. |
| `frontend/app/view/jarvis/jarvissubjectstore.ts` | **modify.** Add derived `stageRunAtom` — the one resolution of "which run is the Stage showing". |
| `frontend/app/view/jarvis/stage.tsx` | **modify.** Read `stageRunAtom` instead of resolving the run inline, twice. |
| `frontend/app/view/jarvis/stagerail.tsx` | **modify.** Push the ambient section last, after Fleet. |
| `frontend/app/view/agents/runbody.tsx` | **modify.** Delete the three ambient call sites and their now-unused imports. |
| `scripts/cdp/scenarios.mjs` | **modify.** Extend three existing scenarios; pin the rail open in each. |
| `docs/jarvis-tab.md` | **modify.** §7 gains a fifth rail section. |

---

## Task 1: The pure derivation

**Files:**
- Create: `frontend/app/view/jarvis/ambientrail.ts`
- Test: `frontend/app/view/jarvis/ambientrail.test.ts`

**Interfaces:**
- Consumes: `readResumeCard(run: Run): ResumeVM | null` from `frontend/app/view/agents/resume.ts:32`; `readProactiveSuggestion(run: Run): ProactiveVM | null` from `frontend/app/view/agents/proactive.ts:32`; `SubjectKind = "channel" | "dossier" | "conversation"` from `./subjects`.
- Produces: `ambientRailFor(input: AmbientRailInput): AmbientRailModel | null` and both of those types. Task 3 calls it.

**Why the derivation reads the meta itself rather than letting the view do it:** the section must be *absent rather than empty* — the rail's own rule. Deciding "is there anything to show" is the derivation's job, and `readResumeCard` / `readProactiveSuggestion` are the existing single source of truth for the dismissed flag, the `status: "hit"` gate and the non-empty-summary check. Re-implementing those guards here would create a second source of truth. The one fact the derivation cannot compute is whether the attribution engine has decisions for a run — that needs the ambient provider, which is not pure — so it arrives as a `hasDecisions` boolean.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/ambientrail.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

// resume.ts / proactive.ts reach the object service and WOS on their *write* path (dismissal). These tests
// exercise only the synchronous meta reads, so stub the backend layer the way jarvissubjectstore.test.ts does.
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/services", () => ({ ObjectService: {} }));

import { ambientRailFor } from "./ambientrail";

const NOW = 1_700_000_000_000;

const run = (over: Partial<Run> & { meta?: Record<string, unknown> }): Run =>
    ({
        id: "a7c7c6cd-1111-2222-3333-444444444444",
        oid: "a7c7c6cd-1111-2222-3333-444444444444",
        goal: "the goal",
        status: "done",
        meta: {},
        ...over,
    }) as unknown as Run;

const withResume = (over: { id?: string; oid?: string; summary?: string; updated?: number }): Run =>
    run({
        id: over.id ?? "a7c7c6cd-1111-2222-3333-444444444444",
        oid: over.oid ?? over.id ?? "a7c7c6cd-1111-2222-3333-444444444444",
        meta: {
            "jarvis:resume": {
                taskId: "task-1",
                summary: over.summary ?? "Landed the boundary; two call sites still bypass it.",
                status: "completed",
                updated: over.updated ?? NOW,
            },
        },
    });

const withProactive = (): Run =>
    run({
        meta: {
            "jarvis:proactive": {
                status: "hit",
                nodeId: "dec-1",
                sourceType: "decision",
                title: "Drop-oldest on overflow",
                snippet: "chose drop-oldest to bound memory",
                why: "Related to this run",
            },
        },
    });

// No dismissal-atom reset is needed: the optimistic hide lives in the card components, and the derivation
// reads only run.meta — including the persisted dismissed flag, which the last test covers.
describe("ambientRailFor", () => {
    it("gives a sealed run its resume narrative — the case the run body cannot draw", () => {
        const r = withResume({});
        const m = ambientRailFor({ kind: "channel", run: r });
        expect(m?.resumeRun).toBe(r);
    });

    it("keys relevant decisions to the run's oref when the engine has any", () => {
        const r = run({});
        const m = ambientRailFor({ kind: "channel", run: r, hasDecisions: true });
        expect(m?.decisionsORef).toBe("run:a7c7c6cd-1111-2222-3333-444444444444");
    });

    it("gives a run with a hit suggestion its proactive card", () => {
        const r = withProactive();
        expect(ambientRailFor({ kind: "channel", run: r })?.proactiveRun).toBe(r);
    });

    it("is absent rather than empty when a run carries nothing at all", () => {
        expect(ambientRailFor({ kind: "channel", run: run({}) })).toBeNull();
    });

    it("is absent on a channel with no resolved run", () => {
        expect(ambientRailFor({ kind: "channel", run: null, hasDecisions: true })).toBeNull();
    });

    it("picks a record's most recent narrative by its updated stamp", () => {
        const older = withResume({ id: "11111111-1111-1111-1111-111111111111", updated: NOW - 5000 });
        const newest = withResume({ id: "22222222-2222-2222-2222-222222222222", updated: NOW });
        const middle = withResume({ id: "33333333-3333-3333-3333-333333333333", updated: NOW - 1000 });
        const m = ambientRailFor({ kind: "dossier", recordRuns: [older, newest, middle] });
        expect(m?.resumeRun).toBe(newest);
    });

    it("shows a record no proactive suggestion — a suggestion is about a dispatch, not a record", () => {
        const m = ambientRailFor({ kind: "dossier", recordRuns: [withResume({}), withProactive()] });
        expect(m?.proactiveRun).toBeNull();
        expect(m?.decisionsORef).toBeNull();
    });

    it("is absent on a record whose runs carry no narrative", () => {
        expect(ambientRailFor({ kind: "dossier", recordRuns: [run({}), withProactive()] })).toBeNull();
    });

    it("is absent on a thread — all three views are run-scoped", () => {
        expect(ambientRailFor({ kind: "conversation" })).toBeNull();
    });

    it("does not count a narrative the user dismissed", () => {
        const r = run({
            meta: {
                "jarvis:resume": { taskId: "t", summary: "s", status: "completed", updated: NOW },
                "jarvis:resume:dismissed": true,
            },
        });
        expect(ambientRailFor({ kind: "channel", run: r })).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/ambientrail.test.ts`

Expected: FAIL — `Failed to resolve import "./ambientrail"`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/jarvis/ambientrail.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Which ambient views apply to the subject on the Stage. Pure, and returns data rather than JSX so the
// decision is testable without a renderer — this table used to be implicit in which run render branch
// happened to draw, which is how a sealed run (RunCompletion, not RunHeader) came to show none of them.
//
// | subject | resume | proactive | decisions |
// | channel with a run | that run, any status | that run | that run's oref |
// | channel, draft or no run | — | — | — |
// | dossier | most recent by ResumeVM.updated | — | — |
// | conversation | — | — | — |
//
// A dossier gets no suggestion because a suggestion is written at dispatch and is about that goal; across a
// record's runs it would be several stale ones competing. A dossier gets no decisions block because a record
// already renders its own decision log in the thread (decisionlog.tsx). A conversation gets nothing at all:
// every one of the three is run-scoped and a thread has no run.

import { readProactiveSuggestion } from "@/app/view/agents/proactive";
import { readResumeCard } from "@/app/view/agents/resume";
import type { SubjectKind } from "./subjects";

export interface AmbientRailInput {
    kind: SubjectKind;
    // the run the Stage resolved (channel subjects) — see jarvissubjectstore.stageRunAtom
    run?: Run | null;
    // a record's attributed runs (dossier subjects) — see jarvissubjectstore.recordRunsAtom
    recordRuns?: Run[];
    // whether the attribution engine has decisions for `run`. Not derivable here: it needs the ambient
    // provider, which is not pure.
    hasDecisions?: boolean;
}

export interface AmbientRailModel {
    resumeRun: Run | null;
    proactiveRun: Run | null;
    decisionsORef: string | null;
}

// the most recent narrative wins: "where this stands" is singular, and ResumeVM.updated makes the pick
// deterministic. Earlier narratives stay reachable as history through the record's own run list.
function latestNarrated(runs: Run[]): Run | null {
    let best: Run | null = null;
    let bestUpdated = -Infinity;
    for (const r of runs) {
        const vm = readResumeCard(r);
        if (vm == null) {
            continue;
        }
        if (vm.updated >= bestUpdated) {
            best = r;
            bestUpdated = vm.updated;
        }
    }
    return best;
}

export function ambientRailFor(input: AmbientRailInput): AmbientRailModel | null {
    let model: AmbientRailModel;
    if (input.kind === "channel") {
        const run = input.run ?? null;
        if (run == null) {
            return null;
        }
        model = {
            resumeRun: readResumeCard(run) != null ? run : null,
            proactiveRun: readProactiveSuggestion(run) != null ? run : null,
            decisionsORef: input.hasDecisions ? `run:${run.id}` : null,
        };
    } else if (input.kind === "dossier") {
        model = { resumeRun: latestNarrated(input.recordRuns ?? []), proactiveRun: null, decisionsORef: null };
    } else {
        return null;
    }
    // absent rather than empty: a section drawn with nothing in it is worse than no section
    if (model.resumeRun == null && model.proactiveRun == null && model.decisionsORef == null) {
        return null;
    }
    return model;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/ambientrail.test.ts`

Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

Expected: exit 0, no output. If it reports errors in files you did not touch, stop — the baseline is supposed to be clean, so report it rather than working around it.

---

## Task 2: One resolution of "which run is the Stage showing"

**Files:**
- Modify: `frontend/app/view/jarvis/jarvissubjectstore.ts` (add after `activeRunIdAtom`, around line 135)
- Modify: `frontend/app/view/jarvis/stage.tsx:126-134` and `:186`

**Interfaces:**
- Consumes: `resolveActiveRunId(visibleRuns: Run[], current: string | undefined): string | undefined` from `frontend/app/view/agents/runmodel.ts:228`; `activeChannelAtom`, `activeChannelRunsAtom` from `frontend/app/view/agents/channelsstore.ts:15,26`.
- Produces: `stageRunAtom: Atom<Run | null>`. Task 3 reads it.

**Why this is a task and not a line in Task 3:** the rail needs the run the Stage resolved, and `stagerail.tsx` does not receive it. Resolving it a second time in the rail would let the two disagree about which run is on screen. `jarvissubjectstore.ts` already imports from `channelsstore` (`selectChannel`, line 10), so this adds no new module cycle.

**One deliberate behaviour change.** Today `stage.tsx` resolves the run *twice*, with different guards: the `activeRunId` used for the record band checks `subject.id === channel?.oid` (line 129), and the `run` handed to `RunBody` does not (line 186). Mid-switch between channels those disagree, so the Stage can render the previous channel's run while the band reports no run. Both now read one atom that carries the guard, so they agree. Expect no visible change outside that switch window.

- [ ] **Step 1: Add the derived atom**

In `frontend/app/view/jarvis/jarvissubjectstore.ts`, add these imports to the existing import block:

```ts
import { activeChannelAtom, activeChannelRunsAtom, selectChannel } from "@/app/view/agents/channelsstore";
import { resolveActiveRunId } from "@/app/view/agents/runmodel";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
```

(The first line replaces the existing `import { selectChannel } from "@/app/view/agents/channelsstore";` at line 10; the third replaces the existing `import { atom, type PrimitiveAtom } from "jotai";` at line 12.)

Then, immediately **after** the `activeRunIdAtom` declaration (around line 135), add:

```ts
// The run the Stage is showing, resolved once. Both the Stage and the context rail need it — the Stage to
// render the run body, the rail to derive its ambient section — and this used to be resolved inline in
// stage.tsx twice with different guards, so the two could name different runs mid-channel-switch.
export const stageRunAtom: Atom<Run | null> = atom((get) => {
    const subject = get(activeSubjectAtom);
    if (subject == null || subject.kind !== "channel") {
        return null;
    }
    const channel = get(activeChannelAtom);
    // the runs list belongs to the *active* channel, so a subject that has not caught up to it yet would
    // otherwise resolve a run out of the previous channel's list
    if (channel == null || subject.id !== channel.oid) {
        return null;
    }
    // a draft run is not a Run yet (the server requires a goal), so nothing should auto-resolve underneath it
    if (get(composingRunAtom)[subject.id] ?? false) {
        return null;
    }
    const runs = get(activeChannelRunsAtom);
    const id = resolveActiveRunId(runs, get(activeRunIdAtom)[subject.id]);
    return runs.find((r) => r.id === id) ?? null;
});
```

- [ ] **Step 2: Point the Stage at it**

In `frontend/app/view/jarvis/stage.tsx`, add `stageRunAtom` to the existing import from `./jarvissubjectstore` (the block at lines 33-43).

Replace lines 126-134, which currently read:

```tsx
    const composing = subject?.kind === "channel" && (composingRun[subject.id] ?? false);
    const open = subject != null ? (bandOpen[subject.id] ?? false) : false;
    const activeRunId =
        subject?.kind === "channel" && subject.id === channel?.oid && !composing
            ? resolveActiveRunId(allRuns, runIds[subject.id])
            : undefined;
    // null rather than "run:" when nothing resolves: the band hangs Attach and every per-edge correction off
    // this oref, and an empty one would write a correction against no run at all.
    const activeRunORef = activeRunId != null ? "run:" + activeRunId : null;
```

with:

```tsx
    const composing = subject?.kind === "channel" && (composingRun[subject.id] ?? false);
    const open = subject != null ? (bandOpen[subject.id] ?? false) : false;
    // one resolution, shared with the context rail (jarvissubjectstore.stageRunAtom). Resolved inline here
    // twice with different guards, the band and the run body could name different runs mid-channel-switch.
    const run = useAtomValue(stageRunAtom) ?? undefined;
    // null rather than "run:" when nothing resolves: the band hangs Attach and every per-edge correction off
    // this oref, and an empty one would write a correction against no run at all.
    const activeRunORef = run != null ? "run:" + run.id : null;
```

Then delete the second resolution. It is at line 186 *before* the edit above, which is one line shorter than
what it replaced — so anchor on the content, not the number. Delete this line entirely:

```tsx
    const run = composing ? undefined : allRuns.find((r) => r.id === resolveActiveRunId(allRuns, runIds[subject.id]));
```

- [ ] **Step 3: Remove what is now unused**

In `frontend/app/view/jarvis/stage.tsx`:

- Delete `const runIds = useAtomValue(activeRunIdAtom);` (line 61) — its only two readers were the resolutions just removed.
- Remove `activeRunIdAtom` from the `./jarvissubjectstore` import block.
- Remove `resolveActiveRunId` from the `@/app/view/agents/runmodel` import at line 20, keeping `liveWorkers`.

Keep `allRuns` (`activeChannelRunsAtom`): the pending-run-focus effect at line 104 still reads it. Keep `composingRun` and `composing`: the record band and the empty state still use them.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

Expected: exit 0. An "unused variable" error here means step 3 was incomplete. Note that `tsconfig.json` sets `"strict": false`, so a null-safety mistake will **not** show up here — it crashes the first frame instead. That is what step 5 is for.

- [ ] **Step 5: Confirm the surface still renders**

The cockpit has no jsdom render harness; "does it render" is covered over CDP against the running dev app.

Run: `task verify:ui -- surface-smoke jarvis-subject-state`

Expected: PASS on both. If the run reports `ECONNREFUSED :9222`, the dev app is not up or another session's edit crashed it — check the dev log for "going away" before assuming a CDP fault.

---

## Task 3: The rail section

**Files:**
- Create: `frontend/app/view/jarvis/ambientrailview.tsx`
- Modify: `frontend/app/view/jarvis/stagerail.tsx`

**Interfaces:**
- Consumes: `ambientRailFor` / `AmbientRailInput` from Task 1; `stageRunAtom` from Task 2; `RailSection` from `frontend/app/element/collapsiblerail.tsx:18`; `ResumeCard` from `frontend/app/view/agents/resumeviews.tsx`; `ProactiveCard` from `frontend/app/view/agents/proactiveviews.tsx`; `RelevantDecisions` from `frontend/app/view/agents/ambientviews.tsx:59`; `ambientProviderAtom` / `ensureAmbient` from `frontend/app/view/agents/ambientstore`.
- Produces: `ambientSection(input: AmbientRailInput): RailSection | null`.

At the end of this task the cards render in **both** the rail and the run body. That is deliberate — it lets a reviewer see the rail version working before Task 4 removes the old one.

- [ ] **Step 1: Write the section builder**

Create `frontend/app/view/jarvis/ambientrailview.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one home for the three ambient views: the continuity resume narrative, the proactive "related prior
// work" suggestion, and the attribution engine's relevant past decisions. They used to hang off RunHeader
// and the run body's pipeline branch, so a sealed run — which renders RunCompletion instead — showed none of
// them, and a record subject never showed the narrative that names it. Which views apply is ambientrail's
// decision, not whichever branch happened to render.
//
// The three card components are reused unchanged, dismissal included: this file only chooses and frames them.

import type { RailSection } from "@/app/element/collapsiblerail";
import { RelevantDecisions } from "@/app/view/agents/ambientviews";
import { ProactiveCard } from "@/app/view/agents/proactiveviews";
import { ResumeCard } from "@/app/view/agents/resumeviews";
import { Sparkles } from "lucide-react";
import { ambientRailFor, type AmbientRailInput } from "./ambientrail";

// "Ambient" is this codebase's word for these views, not a user's, and the rail's own title is already
// "Context" — so the section reads in the register of its siblings (Needs you, Consults, Fleet).
export const AMBIENT_SECTION_LABEL = "Worth knowing";

export function ambientSection(input: AmbientRailInput): RailSection | null {
    const model = ambientRailFor(input);
    if (model == null) {
        return null;
    }
    return {
        id: "ambient",
        icon: <Sparkles size={18} strokeWidth={1.8} />,
        label: AMBIENT_SECTION_LABEL,
        content: (
            <div className="flex flex-col gap-2.5">
                <div className="font-mono text-[9px] uppercase tracking-[.09em] text-muted">
                    {AMBIENT_SECTION_LABEL}
                </div>
                {model.resumeRun != null ? <ResumeCard run={model.resumeRun} /> : null}
                {model.proactiveRun != null ? <ProactiveCard run={model.proactiveRun} /> : null}
                {model.decisionsORef != null ? <RelevantDecisions oref={model.decisionsORef} /> : null}
            </div>
        ),
    };
}
```

- [ ] **Step 2: Wire it into the rail**

In `frontend/app/view/jarvis/stagerail.tsx`:

Add to the imports:

```tsx
import { ambientProviderAtom, ensureAmbient } from "@/app/view/agents/ambientstore";
import { useEffect } from "react";
import { ambientSection } from "./ambientrailview";
```

and add `recordRunsAtom` and `stageRunAtom` to the existing `./jarvissubjectstore` import block (lines 28-34).

Inside `StageRail`, alongside the other `useAtomValue` calls (after line 76):

```tsx
    const ambient = useAtomValue(ambientProviderAtom);
    const stageRun = useAtomValue(stageRunAtom);
    const recordRuns = useAtomValue(recordRunsAtom);
    // the provider is lazy, and this rail reads decisionsFor *before* RelevantDecisions mounts and calls
    // ensureAmbient itself — so without this the section would judge "no decisions" on an unloaded map.
    useEffect(() => ensureAmbient(), []);
```

Then, **after** the `if (comp?.showFleet) { ... }` block that ends at line 244 and **before** the `profileChannelId` declaration at line 248, add:

```tsx
    // last, after Fleet: this is the only unsolicited, dismissible section, so it must not sit above live
    // fleet state — and it must never be first, because CollapsibleRail draws sections[0].icon as the
    // collapsed strip's single glyph and that has to stay the Needs-you bell.
    const ambientSec =
        subject != null
            ? ambientSection({
                  kind: subject.kind,
                  run: stageRun,
                  recordRuns: recordId != null ? (recordRuns[recordId] ?? []) : [],
                  hasDecisions: stageRun != null && ambient.decisionsFor({ oref: `run:${stageRun.id}` }).length > 0,
              })
            : null;
    if (ambientSec != null) {
        sections.push(ambientSec);
    }
```

`recordId` is already in scope from line 103.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

Expected: exit 0.

- [ ] **Step 4: See it render on a sealed run**

This is the case that is broken today, so verify it by eye before automating it.

1. Make sure the dev app is running (`task dev`).
2. Inject a sealed run carrying a narrative, or reuse one: open the Jarvis surface, pick a channel with a completed run, and select that run in the run switcher.
3. Confirm the rail's **Worth knowing** section appears with the narrative, and that the section is **absent** on a thread subject and on a channel whose run carries nothing.
4. Capture it: `node scripts/cdp-shot.mjs cdp-shots/ambient-rail-manual.png`

If the section never appears on any run, check that the rail is open — `stageRailOpenAtom` persists to localStorage under `jarvis.stagerail.open`, and a previous narrow-window session may have left it collapsed.

---

## Task 4: One home — delete the run-body call sites

**Files:**
- Modify: `frontend/app/view/agents/runbody.tsx:38-40`, `:190-191`, `:573-575`
- Modify: `docs/jarvis-tab.md` §7 (line 340) and its §1 composition table

**Interfaces:** consumes nothing new; produces nothing. This task is the point of the change — skipping it leaves two homes for the same three views, which is the design that was explicitly rejected.

**Every line number below is pre-edit.** All three edits are in one file and the first two are deletions, so each one shifts what follows it upward. Anchor on the quoted content, not the number.

- [ ] **Step 1: Remove the two cards from the run header**

In `frontend/app/view/agents/runbody.tsx`, delete lines 190-191:

```tsx
            <ResumeCard run={run} />
            <ProactiveCard run={run} />
```

They sit between the closing `</div>` of the header row and the `{!hideSteer && steering && target ? (` block. Leave everything around them alone.

- [ ] **Step 2: Remove the decisions block from the pipeline branch**

In the same file, delete lines 573-575:

```tsx
                    <div className="mb-4">
                        <RelevantDecisions oref={sourceRefForRun(run).oref} />
                    </div>
```

They sit between `<RunHeader ... />` and `<CancelSurvivorsCard ... />`.

- [ ] **Step 3: Remove the now-unused imports**

In the same file:

- Line 38: change `import { AmbientTags, RelevantDecisions } from "./ambientviews";` to `import { AmbientTags } from "./ambientviews";` — `AmbientTags` is still used at line 153 and must stay.
- Line 39: delete `import { ProactiveCard } from "./proactiveviews";`
- Line 40: delete `import { ResumeCard } from "./resumeviews";`

Keep `sourceRefForRun` (line 37): still used by `AskJarvisButton` at line 175 and `AmbientTags` at line 153.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

Expected: exit 0. An unused-import error means step 3 was incomplete.

- [ ] **Step 5: Update the surface reference doc**

In `docs/jarvis-tab.md` §7 (Context rail, line 340), add a fifth numbered entry after the **Fleet** entry:

```markdown
5. **Worth knowing** — the three ambient views, in one place, chosen by the subject rather than by which run
   render branch drew (`ambientrail.ts` decides, `ambientrailview.tsx` frames). A channel with a resolved run
   gets the run's resume narrative at **any** status, its proactive suggestion and its relevant past
   decisions; a record gets the most recent narrative across its attributed runs (`ResumeVM.updated`) and
   nothing else, since a suggestion is about a dispatch and the record's own decision log already renders in
   the thread; a thread gets nothing, all three being run-scoped. Drawn **last**, after Fleet: it is the only
   unsolicited, dismissible section, and it must never be first because `CollapsibleRail` draws
   `sections[0].icon` as the collapsed strip's one glyph. Collapsing the rail hides it, which is correct —
   these are dismissible asides, the opposite of Needs you's "always drawn, never filtered".
```

In §1's per-kind composition table (line 73 onward), add a row so the table states where ambient content lands per subject kind:

```markdown
| Worth knowing | run's narrative + suggestion + decisions | most recent narrative | — |
```

- [ ] **Step 6: Confirm the cards left the run body and stayed in the rail**

Run: `task verify:ui -- surface-smoke jarvis-subject-state`

Expected: PASS on both. Then by eye in the dev app: open a run that is still executing and confirm the resume/proactive/decisions blocks no longer appear inline in the run body, while **Worth knowing** still shows them in the rail.

---

## Task 5: Update the three CDP scenarios

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` — `jarvisContinuityResume` (line 760), `jarvisProactive` (line 851), `jarvisAmbient` (line 569)

**Interfaces:** consumes the harness helpers already in that file — `h.ev`, `h.rpc`, `h.goto`, `h.shot`, and `resetRail(h)` at line 1763. Produces no exports.

**All three need the rail pinned open**, because `stageRailOpenAtom` persists to localStorage (`jarvisstore.ts:57`) and a previous scenario that drove a narrow window leaves it collapsed — the exact order-dependence recorded at `docs/jarvis-consolidation-open-issues.md:135-137`. `resetRail` is declared later in the file than two of these scenarios; that is fine, because the module fully evaluates before any scenario runs. Do not "fix" it by moving code.

- [ ] **Step 1: Assert the sealed run's narrative renders — the assertion this scenario never had**

`jarvis-continuity-resume` currently verifies that the run reached `done` and that a later Jarvis question returns a grounded answer. It never asserts the narrative renders, because until now it could not: the narrative is written at the `done` boundary, which is the transition that switches the renderer to `RunCompletion`.

In `jarvisContinuityResume.arrange`, after the `advancerun` call and before the `return`, add:

```js
        // the narrative renders in the rail now, and stageRailOpenAtom is persisted — a previous scenario
        // that drove a narrow width would leave it collapsed and hide it. The assert's own reload picks
        // this up.
        await h.ev(`localStorage.setItem('jarvis.stagerail.open', 'true')`);
```

In `jarvisContinuityResume.assert`, immediately after the existing `"run advanced to done (E's rest-boundary trigger)"` step and **before** `await h.goto("jarvis")`, add:

```js
        // The narrative renders in the rail's "Worth knowing" section. Reload first: the channel was created
        // out-of-band and the Subjects column renders a snapshot refreshed by loadChannels() (same reason
        // jarvis-proactive reloads).
        await h.ev("location.reload()");
        await h.ev("new Promise((r) => setTimeout(r, 2500))");
        await h.goto("jarvis");
        const pickedChannel = await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')]
                .find((x) => (x.textContent || '').includes('verify-continuity'));
            if (!b) return false;
            b.click();
            return true;
        })()`);
        // Evidence is sealed off-band (sealAsync, wshserver_runs.go:430), so the run only reaches the
        // done+evidence branch a moment after the status flips. Poll rather than sample once.
        // innerText reflects CSS text-transform and the card's eyebrow is uppercased — compare upper.
        let narrative = { eyebrow: false, dismiss: false };
        for (let i = 0; i < 20; i++) {
            await h.ev("new Promise((r) => setTimeout(r, 500))");
            narrative = await h.ev(`(() => {
                const body = (document.body.innerText || '').toUpperCase();
                return {
                    eyebrow: body.includes('WHERE THIS STANDS'),
                    dismiss: !!document.querySelector('button[aria-label="Dismiss resume summary"]'),
                };
            })()`);
            if (narrative.eyebrow && narrative.dismiss) break;
        }
        steps.push({
            step: "the sealed run's resume narrative renders in the rail",
            ok: pickedChannel === true && narrative.eyebrow && narrative.dismiss,
            detail: JSON.stringify({ pickedChannel, ...narrative }),
        });
```

- [ ] **Step 2: Run it and confirm the new step passes**

Run: `task verify:ui -- jarvis-continuity-resume`

Expected: PASS, including the new step. The existing grounding step must stay green — the reload happens before `newThread`, so the thread it creates is still fresh.

If the new step fails with `eyebrow: false`, check in the dev app whether the run actually carries `jarvis:resume`: `pkg/jarviscontinuity.CaptureRunBoundary` returns nothing when no dossier references the run, and this scenario relies on the dossier written at `createrun`.

- [ ] **Step 3: Retarget the proactive scenario at the rail**

`jarvis-proactive`'s probes read `document.body.innerText` and `button[aria-label="Dismiss suggestion"]`, both of which find the card in an **open** rail. **Do not rewrite the probes** — only pin the rail and correct the step copy, which currently claims the run body.

In `jarvisProactive.arrange`, after the `setmeta` call and before the `return`, add:

```js
        // the suggestion renders in the rail now; stageRailOpenAtom is persisted, so pin it open. The
        // assert's own reload picks this up.
        await h.ev(`localStorage.setItem('jarvis.stagerail.open', 'true')`);
```

In `jarvisProactive.assert`, change the two step labels:

- `"proactive card renders on the run body (label + suggestion title)"` → `"proactive card renders in the rail (label + suggestion title)"`
- `"dismiss (×) removes the card from the run body"` → `"dismiss (×) removes the card from the rail"`

Leave the third step (`"dismissal persisted to run.meta (survives reload)"`) exactly as it is: dismissal did not move.

- [ ] **Step 4: Run it**

Run: `task verify:ui -- jarvis-proactive`

Expected: PASS on all three steps.

- [ ] **Step 5: Pin the rail in the ambient-tags scenario**

`jarvis-ambient` counts elements whose text is exactly `"Relevant past decisions"` across the cockpit, jarvis, radar and memory surfaces. On the Jarvis surface that count now comes from the rail, so the rail has to be open — and unlike the other two, this scenario's assert never reloads, so setting localStorage alone would not reach the live atom.

Replace `jarvisAmbient.arrange`, which currently reads:

```js
    async arrange() {
        return {};
    },
```

with:

```js
    // "Relevant past decisions" renders in the Jarvis rail now rather than the run body, and
    // stageRailOpenAtom is persisted — a previous scenario that collapsed it would zero the jarvis count.
    // resetRail sets the flag *and* reloads, which this scenario's assert does not do on its own.
    async arrange(h) {
        return resetRail(h);
    },
```

- [ ] **Step 6: Run it**

Run: `task verify:ui -- jarvis-ambient`

Expected: PASS. This scenario reports honestly when the profile's vault holds no attributed runs (`total === 0` tolerances), so read its `detail` output rather than only its verdict — a pass with `decisions: 0` everywhere proves nothing about the move.

- [ ] **Step 7: Run the whole Jarvis set together, for order-dependence**

Run: `task verify:ui -- jarvis-states jarvis-fleet jarvis-ask jarvis-contextual jarvis-ambient jarvis-multiturn jarvis-continuity-resume jarvis-proactive jarvis-drawer jarvis-subject-state jarvis-collapse-order jarvis-narrow jarvis-measure`

Expected: PASS across the set. This ordering matters: `jarvis-collapse-order` and `jarvis-narrow` drive narrow widths and persist a collapsed rail, so running them before the three touched here is exactly the interference the pins exist to survive. If a scenario fails only in this combined run, the pin is missing or placed after the reload it needs to precede.

---

## Task 6: Commit

**Files:** all of the above, plus `docs/superpowers/specs/2026-08-03-jarvis-ambient-rail-design.md` and `docs/superpowers/plans/2026-08-03-jarvis-ambient-rail.md`.

- [ ] **Step 1: Self-review the diff**

Run: `git diff` and `git status`

Check: no commented-out code, no debug statements, no stray `cdp-shots/ambient-rail-manual.png` staged, and no files touched beyond the nine in the File Structure table plus the two docs. This repo is edited from parallel sessions, so re-check `git status` for changes that are not yours and stage only your own files.

- [ ] **Step 2: Confirm the full check set is green**

Run:

```bash
npx vitest run frontend/app/view/jarvis/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx eslint frontend/app/view/jarvis/ambientrail.ts frontend/app/view/jarvis/ambientrail.test.ts frontend/app/view/jarvis/ambientrailview.tsx
```

Expected: vitest all-pass, tsc exit 0, eslint clean. Pre-existing `no-undef` complaints under `scripts/*.mjs` are known and not yours.

- [ ] **Step 3: Ask for approval, then commit**

**Stop and ask the user before running this.** This repo never commits without explicit approval, and the spec and plan documents fold into this same feature commit rather than landing separately.

```bash
git add frontend/app/view/jarvis/ambientrail.ts frontend/app/view/jarvis/ambientrail.test.ts frontend/app/view/jarvis/ambientrailview.tsx frontend/app/view/jarvis/jarvissubjectstore.ts frontend/app/view/jarvis/stage.tsx frontend/app/view/jarvis/stagerail.tsx frontend/app/view/agents/runbody.tsx scripts/cdp/scenarios.mjs docs/jarvis-tab.md docs/superpowers/specs/2026-08-03-jarvis-ambient-rail-design.md docs/superpowers/plans/2026-08-03-jarvis-ambient-rail.md
git commit -m "fix(jarvis): a run's ambient views belong to the subject, not to whichever branch rendered it" -m "The resume narrative, the proactive suggestion and the relevant-decisions list hung off RunHeader and the run body's pipeline branch, so a sealed run — which renders RunCompletion instead — showed none of the three, and an orchestrator run lost the decisions. The narrative is written at the done boundary, which is the transition that switches the renderer, so it was written precisely when it became undrawable. They now live in one subject-derived rail section, which also gives a record the narrative that names it."
```

---

## Self-Review

**Spec coverage.** Section 2's decision (one rail section) → Tasks 1 and 3. Section 3's per-subject table → Task 1, encoded in `ambientRailFor` and its ten tests. Section 4's structure, label, icon and ordering → Tasks 1, 3 and 4, including the "never first" constraint. Section 4's three deletions → Task 4. Section 5's `stageRunAtom` extraction and the record's existing `Run[]` → Task 2 and Task 3's wiring. Section 5's noted snapshot limit needs no code — it is documented in the spec and unchanged by this plan. Section 6's absent-rather-than-empty → Task 1's `null` return and its two "is absent" tests. Section 7's unit cases → Task 1 step 1; its three scenario extensions and the rail-pinning requirement → Task 5. Section 8's file table → the File Structure table, plus the `docs/jarvis-tab.md` update in Task 4 step 5.

**Type consistency.** `ambientRailFor(input: AmbientRailInput): AmbientRailModel | null` is defined in Task 1 and called with that exact input shape in Task 3; `ambientSection(input: AmbientRailInput)` reuses the same type rather than restating it. `stageRunAtom: Atom<Run | null>` is produced in Task 2 and read in Tasks 2 and 3. Field names `resumeRun` / `proactiveRun` / `decisionsORef` are identical in the interface, the implementation, the tests and the view.

**One risk worth stating.** Task 1's test mocks three store modules (`@/app/store/wshclientapi`, `@/app/store/wshrpcutil`, `@/app/store/services`) because `ambientrail.ts` imports `resume.ts` and `proactive.ts` for their meta-read guards, and those files also carry a dismissal write path that reaches the object service. This mirrors `jarvissubjectstore.test.ts`, which mocks the first two for the same reason. If vitest resolves them without the mocks, the mocks are harmless; if a mock turns out to be insufficient rather than unnecessary, add the missing one rather than moving the guards into `ambientrail.ts`, which would create a second source of truth for "is there a narrative".
