# Orchestrator Run UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give orchestrator-mode runs a dedicated body in the channel Runs view — a lead transcript that fills available height and a rich, clickable dispatched-agents section — leaving pipeline runs untouched.

**Architecture:** `RunWorkerCard` gains a `fill` variant (feed grows instead of the 260px cap). A pure `leadWorker` helper is extracted (and `steerTarget` re-expressed on it). The run header + inline steer composer are lifted into a shared `RunHeader` so both bodies reuse them. A new `OrchestratorBody` arranges the reused header/gate/ask/transcript/dispatched/blocked/ship/cancel pieces in a flex-fill column; `RunsView` branches to it (outside its scroll container) when `isOrchestrator(run)`. Dispatched agents adopt the Agents-tab idiom and open a child's transcript via the already-wired `focusSubagentAtom` + `jumpToAgent` path.

**Tech Stack:** React 19, TypeScript, Tailwind 4, jotai, `motion/react`. Tests: vitest (pure helpers only — no jsdom/render harness in this repo). Typecheck via `tsc`. Visual verification via Chrome DevTools Protocol against the live dev app.

## Global Constraints

- **FE-only.** No Go changes, no `task build:backend`, no `task generate`. Reuse existing RPCs and atoms only (`subagentsByIdAtom`, `focusSubagentAtom`, `livetranscript`, `cancelRun`, `steerWorker`, gate RPCs).
- **Never hand-edit generated files** (`wshclientapi.ts` et al.). Nothing is regenerated this batch.
- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline clean, exit 0). `npx tsc` stack-overflows on this repo — do not use it.
- **Single unit-test file** for new helpers: `frontend/app/view/agents/runmodel.test.ts`. Run one file with `npx vitest run frontend/app/view/agents/runmodel.test.ts`.
- **No commits inside tasks.** Per repo owner's git policy, all changes are batched into ONE approval-gated commit at the very end. Each task ends with a verify checkpoint, not a commit.
- **Copy/style:** no emojis in code or UI copy. Comments explain "why," lower-case, only when necessary. Keep the `// Copyright 2026, Command Line Inc.` + SPDX header on touched files.
- **Reduced motion:** no new animation is introduced; the reused `RunWorkerCard` flow bar already degrades under `motion-reduce`.
- **Visual verification is best-effort.** Requires `tail -f /dev/null | task dev` running; capture with `node scripts/cdp-shot.mjs [out.png]`; inject an orchestrator run with `node scripts/inject-live-agents.mjs <scenario>`. Never `Page.reload`. If dev is not running, mark the visual step UNVERIFIED with that reason — do not claim it passed.

---

## File Structure

**Modify:**
- `frontend/app/view/agents/runmodel.ts` — add pure `leadWorker(run, agents)`; re-express `steerTarget` on it.
- `frontend/app/view/agents/runmodel.test.ts` — tests for `leadWorker` + a regression test for `steerTarget`.
- `frontend/app/view/agents/runworkercard.tsx` — add `fill?: boolean` to `RunWorkerCard`.
- `frontend/app/view/agents/runssurface.tsx` — rewrite `SubagentRows` → `DispatchedAgents`; extract `RunHeader`; add `OrchestratorBody`; branch the body in `RunsView`.

**Reuse (no edits):**
- `frontend/app/view/agents/subagentsstore.ts` — `subagentsByIdAtom`, `focusSubagentAtom`.
- `frontend/app/view/agents/agentsurface.tsx` — renders `SubagentInterior` when `focusSubagentAtom.parentId === focusedAgent.id`.
- `frontend/app/view/agents/channelsprimitives.ts` — `jumpToAgent` (sets `focusIdAtom` + `surfaceAtom="agent"`).
- `frontend/app/view/agents/session-models/sessionviewmodel.ts` — `SubagentVM`, `SubagentState`.
- `frontend/app/store/jotaiStore.ts` — `globalStore`.

**Task order:** Task 1 (helper) → Task 2 (`fill`) → Task 3 (`DispatchedAgents`) are independent of each other but all feed Task 5. Task 4 (`RunHeader` extraction) is a mechanical prerequisite for Task 5. Tasks 3, 4, 5 all edit `runssurface.tsx` and must run sequentially. Recommended sequence: 1, 2, 3, 4, 5.

---

## Task 1: `leadWorker` pure helper + `steerTarget` refactor

**Files:**
- Modify: `frontend/app/view/agents/runmodel.ts` (add `leadWorker`; rewrite `steerTarget` body ~lines 215-226)
- Test: `frontend/app/view/agents/runmodel.test.ts`

**Interfaces:**
- Produces: `leadWorker(run: Run, agents: AgentVM[]): AgentVM | undefined` — the first worker of the run's current phase (`phaseWorkers(run.phases[currentPhaseIndex(run)], agents)[0]`), or `undefined` when there is no such phase/worker. Not terminal-gated (a terminal run can still show its last lead's transcript).
- Consumes: existing `currentPhaseIndex`, `phaseWorkers`, `isTerminal`.

- [ ] **Step 1: Write the failing tests**

Add `leadWorker` to the existing `./runmodel` import in `runmodel.test.ts`, then append:
```ts
describe("leadWorker", () => {
    it("returns the first worker of the current phase", () => {
        const r = run({
            status: "executing",
            phases: [phase({ state: "running", workerorefs: ["tab:t1"] })],
        });
        expect(leadWorker(r, [agent({ id: "t1" })])?.id).toBe("t1");
    });
    it("returns undefined when the current phase has no live worker", () => {
        const r = run({ status: "executing", phases: [phase({ state: "running" })] });
        expect(leadWorker(r, [])).toBeUndefined();
    });
    it("still resolves the lead on a terminal run (not terminal-gated)", () => {
        const r = run({
            status: "done",
            phases: [phase({ state: "done", workerorefs: ["tab:t1"] })],
        });
        expect(leadWorker(r, [agent({ id: "t1" })])?.id).toBe("t1");
    });
});

describe("steerTarget (regression after refactor)", () => {
    it("returns undefined on a terminal run even though a worker exists", () => {
        const r = run({
            status: "done",
            phases: [phase({ state: "done", workerorefs: ["tab:t1"] })],
        });
        expect(steerTarget(r, [agent({ id: "t1" })])).toBeUndefined();
    });
    it("returns the current phase worker on a live run", () => {
        const r = run({
            status: "executing",
            phases: [phase({ state: "running", workerorefs: ["tab:t1"] })],
        });
        expect(steerTarget(r, [agent({ id: "t1" })])?.id).toBe("t1");
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts -t "leadWorker"`
Expected: FAIL — `leadWorker is not a function` / not exported.

- [ ] **Step 3: Implement `leadWorker` and re-express `steerTarget`**

In `runmodel.ts`, replace the existing `steerTarget` (currently ~lines 215-226) with:
```ts
// The lead worker of the run's current phase (orchestrator: the single long-lived lead; pipeline: the
// current phase's worker). Undefined when that phase has no live worker. Not terminal-gated so a
// finished run can still surface its last lead's transcript.
export function leadWorker(run: Run, agents: AgentVM[]): AgentVM | undefined {
    const phase = (run.phases ?? [])[currentPhaseIndex(run)];
    if (!phase) {
        return undefined;
    }
    return phaseWorkers(phase, agents)[0];
}

// The worker a Steer targets: the current phase's lead. Undefined on a terminal run (Steer is
// hidden/disabled there) or when that phase has no live worker.
export function steerTarget(run: Run, agents: AgentVM[]): AgentVM | undefined {
    if (isTerminal(run.status)) {
        return undefined;
    }
    return leadWorker(run, agents);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts -t "leadWorker|steerTarget"`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

## Task 2: `RunWorkerCard` `fill` variant

**Files:**
- Modify: `frontend/app/view/agents/runworkercard.tsx` (signature ~line 28; card wrapper ~line 45; feed container ~line 109-116)

**Interfaces:**
- Produces: `RunWorkerCard({ model, agent, now, fill? })` — `fill?: boolean` (default false). When true, the card is a flex column that grows to fill its parent and its transcript feed uses `min-h-0 flex-1` instead of `max-h-[260px]`. Default false keeps every existing call byte-identical.
- Consumes: `cn` (already imported).

No unit test (React component; repo has no render harness). Verify by typecheck + Task 5's visual check.

- [ ] **Step 1: Add the `fill` prop to the signature**

Change the function signature (~line 28) from:
```tsx
export function RunWorkerCard({ model, agent, now }: { model: AgentsViewModel; agent: AgentVM; now: number }) {
```
to:
```tsx
export function RunWorkerCard({ model, agent, now, fill }: { model: AgentsViewModel; agent: AgentVM; now: number; fill?: boolean }) {
```

- [ ] **Step 2: Make the card wrapper fill-capable**

Change the outer card `div` (~line 45) from:
```tsx
        <div className="overflow-hidden rounded-[12px] border border-edge-mid bg-lane">
```
to:
```tsx
        <div className={cn("overflow-hidden rounded-[12px] border border-edge-mid bg-lane", fill && "flex min-h-0 flex-1 flex-col")}>
```

- [ ] **Step 3: Make the feed grow when filling**

Replace the feed block (currently ~lines 109-116, the `{entries.length > 0 ? (...) : null}` for the live feed) with:
```tsx
                    {/* live feed — capped in pipeline (many stacked cards); fills in the orchestrator body */}
                    {entries.length > 0 ? (
                        <div className={cn("relative", fill && "min-h-0 flex-1")}>
                            <div ref={scrollRef} onScroll={onScroll} className={cn("sc overflow-y-auto px-3 pb-2", fill ? "h-full" : "max-h-[260px]")}>
                                <NarrationTimeline entries={entries} accentLatest active={working} />
                            </div>
                            {!atBottom ? <JumpToLatestPill onClick={jumpToBottom} /> : null}
                        </div>
                    ) : fill ? (
                        // hold the vertical space so the lead card still fills before its first entries stream in
                        <div className="min-h-0 flex-1" />
                    ) : null}
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (`cn` is already imported in `runworkercard.tsx`.)

---

## Task 3: Rich `DispatchedAgents` (rewrite of `SubagentRows`)

**Files:**
- Modify: `frontend/app/view/agents/runssurface.tsx` (replace `SubagentRows` ~lines 341-370; add imports; update the one call site ~line 436)

**Interfaces:**
- Produces: `DispatchedAgents({ model, leadId })` — the lead's dispatched Task subagents as rich rows. Renders `null` when the lead has none. A row with a `transcriptPath` is clickable and opens that child's transcript interior.
- Consumes: `subagentsByIdAtom` (already imported), `focusSubagentAtom` (add import), `globalStore` (add import), `jumpToAgent` (already imported), `SubagentState` type (add import), `AgentsViewModel` (already imported).

No unit test (React component). Verify by typecheck + Task 5's visual check.

- [ ] **Step 1: Add imports**

At the top of `runssurface.tsx`, add:
```tsx
import { globalStore } from "@/app/store/jotaiStore";
```
Add `focusSubagentAtom` to the existing `./subagentsstore` import:
```tsx
import { focusSubagentAtom, subagentsByIdAtom } from "./subagentsstore";
```
Add the `SubagentState` type import (colocate near the other `./session-models` imports):
```tsx
import type { SubagentState } from "./session-models/sessionviewmodel";
```

- [ ] **Step 2: Add the tone map and replace `SubagentRows` with `DispatchedAgents`**

Replace the entire `SubagentRows` component (currently ~lines 341-370, including its leading comment) with:
```tsx
// dispatched-agent state -> text tone class (dot + state pill share it via bg-current / text-*)
const SUB_TONE_CLASS: Record<SubagentState, string> = {
    working: "text-accent",
    success: "text-success",
    failure: "text-error",
    done: "text-muted",
};

// Live Task-tool subagents an orchestrator lead has dispatched, rendered as rich rows beneath its
// transcript. Reads the disk-backed subagent store (populated by useSubagentTracking); renders nothing
// until the lead spawns any. A row with a transcript is clickable and opens that child's live interior
// on the agent surface — the same path the Agents tab uses (focusSubagentAtom + jumpToAgent). Finished
// children are kept (a run wants the whole fan-out as history, not just what is still live).
function DispatchedAgents({ model, leadId }: { model: AgentsViewModel; leadId: string }) {
    const subs = useAtomValue(subagentsByIdAtom)[leadId] ?? [];
    if (subs.length === 0) {
        return null;
    }
    const openChild = (s: (typeof subs)[number]) => {
        if (!s.transcriptPath) {
            return;
        }
        globalStore.set(focusSubagentAtom, {
            parentId: leadId,
            agentId: s.id,
            transcriptPath: s.transcriptPath,
            label: s.type || "subagent",
        });
        jumpToAgent(model, leadId);
    };
    return (
        <div className="mt-3 overflow-hidden rounded-[10px] border border-edge-mid bg-background">
            <div className="flex items-center gap-2 border-b border-edge-mid px-3 py-2">
                <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-muted">Dispatched</span>
                <span className="font-mono text-[10px] text-secondary">{subs.length}</span>
            </div>
            <div className="sc max-h-[220px] overflow-y-auto py-1">
                {subs.map((s) => {
                    const tone = SUB_TONE_CLASS[s.state] ?? "text-muted";
                    return (
                        <div
                            key={s.id}
                            onClick={() => openChild(s)}
                            className={
                                "flex items-center gap-2.5 px-3 py-1.5 " +
                                (s.transcriptPath ? "cursor-pointer hover:bg-surface-hover" : "")
                            }
                        >
                            <span className="font-mono text-[11px] font-semibold text-edge-strong">↳</span>
                            <span className={"h-[6px] w-[6px] flex-none rounded-full bg-current " + tone} />
                            <div className="min-w-0 flex-1">
                                <div className="truncate font-mono text-[11.5px] font-semibold text-secondary">
                                    {s.type || "subagent"}
                                </div>
                                {s.model ? <div className="truncate font-mono text-[9.5px] text-muted">{s.model}</div> : null}
                            </div>
                            <span className={"shrink-0 whitespace-nowrap font-mono text-[9.5px] font-medium " + tone}>
                                {s.state}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
```

- [ ] **Step 3: Update the existing call site in `PhaseRail`**

In `PhaseRail`, change the pipeline/orchestrator worker loop (~line 436) from:
```tsx
                                                {isOrchestrator(run) ? <SubagentRows leadId={w.id} /> : null}
```
to:
```tsx
                                                {isOrchestrator(run) ? <DispatchedAgents model={model} leadId={w.id} /> : null}
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. No `SubagentRows` reference should remain (grep to confirm: `git grep -n SubagentRows frontend/` returns nothing).

---

## Task 4: Extract `RunHeader` (shared by both bodies)

**Files:**
- Modify: `frontend/app/view/agents/runssurface.tsx` (add `RunHeader` component; rewire the pipeline arm's inline header + steer composer ~lines 651-698 to use it)

**Interfaces:**
- Produces: `RunHeader({ run, agents, channel, steering, steerDraft, setSteerDraft, onSteerToggle, onSteerClose })` — the run status pill + goal + Steer toggle button, and (when `steering`) the inline steer `ComposerShell`. Pure presentation over passed-in steer state.
- Consumes: `StatusPill`, `steerTarget`, `ComposerShell`, `steerWorker`, `fireAndForget` (all already in-file).

No unit test (React component). Verify: pipeline run still shows its header + steer exactly as before (typecheck + Task 5 visual).

- [ ] **Step 1: Add the `RunHeader` component**

Add above `RunsView` (e.g. after `CompactStepper`), extracting the existing header + steer markup verbatim into a component:
```tsx
// The run header (status + goal + Steer toggle) and the inline steer composer, shared by the pipeline
// rail body and the orchestrator body. Steer state is owned by RunsView and passed down so it resets
// on run switch. The steer target is the current phase's lead (steerTarget); the button is disabled
// when there is none (terminal run / no live worker).
function RunHeader({
    run,
    agents,
    channel,
    steering,
    steerDraft,
    setSteerDraft,
    onSteerToggle,
    onSteerClose,
}: {
    run: Run;
    agents: AgentVM[];
    channel: Channel;
    steering: boolean;
    steerDraft: string;
    setSteerDraft: (s: string) => void;
    onSteerToggle: () => void;
    onSteerClose: () => void;
}) {
    const target = steerTarget(run, agents);
    return (
        <>
            <div className="mb-4 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                    <div className="mb-1.5">
                        <StatusPill status={run.status} />
                    </div>
                    <div className="text-[19px] font-bold leading-tight tracking-[-0.01em] text-primary">{run.goal}</div>
                </div>
                <div className="flex flex-none gap-1.5">
                    <button
                        type="button"
                        disabled={!target}
                        onClick={onSteerToggle}
                        className="rounded-[8px] border border-edge-mid px-2.5 py-1.5 text-[11.5px] font-semibold text-secondary hover:border-edge-strong disabled:opacity-40"
                    >
                        Steer
                    </button>
                </div>
            </div>
            {steering && target ? (
                <div className="mb-4 max-w-[760px]">
                    <ComposerShell
                        value={steerDraft}
                        onChange={setSteerDraft}
                        autoFocus
                        placeholder={`Steer ${target.name}…`}
                        sendLabel="Steer ⏎"
                        onSubmit={() => {
                            const text = steerDraft.trim();
                            if (!target || !text) {
                                return;
                            }
                            setSteerDraft("");
                            onSteerClose();
                            fireAndForget(() =>
                                steerWorker({
                                    channelId: channel.oid,
                                    workerORef: `tab:${target.id}`,
                                    agents,
                                    text,
                                })
                            );
                        }}
                    />
                </div>
            ) : null}
        </>
    );
}
```

- [ ] **Step 2: Add the steer callbacks in `RunsView`**

In `RunsView`, near the other derivations (after `const run = runs.find(...)`, ~line 514), add:
```tsx
    const onSteerToggle = () => setSteering((v) => !v);
    const onSteerClose = () => setSteering(false);
```

- [ ] **Step 3: Rewire the pipeline arm to use `RunHeader`**

In `RunsView`'s `run ? (...)` arm, replace the inline header block **and** the inline steer composer block (currently ~lines 651-698 — the `{/* run header */}` `<div className="mb-4 flex items-start gap-3">…</div>` through the `{steering && steerTarget(run, agents) ? (…) : null}` block) with a single:
```tsx
                            <RunHeader
                                run={run}
                                agents={agents}
                                channel={channel}
                                steering={steering}
                                steerDraft={steerDraft}
                                setSteerDraft={setSteerDraft}
                                onSteerToggle={onSteerToggle}
                                onSteerClose={onSteerClose}
                            />
```
Leave the `RunRollup`, `CompactStepper`, `PhaseRail`, and `Cancel run` blocks that follow unchanged.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Verify pipeline header unchanged (visual, best-effort)**

With dev running and a **pipeline** run selected: the header (status pill + goal + Steer) and the inline steer composer behave exactly as before. Capture `node scripts/cdp-shot.mjs`. If dev is not running, mark UNVERIFIED (reason: dev app not running) and rely on typecheck.

---

## Task 5: `OrchestratorBody` + the body branch in `RunsView`

**Files:**
- Modify: `frontend/app/view/agents/runssurface.tsx` (add `OrchestratorBody`; add imports; branch the body in `RunsView` ~lines 647-737)

**Interfaces:**
- Consumes: `RunHeader` (Task 4), `RunWorkerCard` with `fill` (Task 2), `DispatchedAgents` (Task 3), `leadWorker` (Task 1), plus in-file `ReviewGateCard`, `AskCard`, `BlockedCard`, `StartingCard`, `ShipMarker`, `useSubagentTracking`, `currentPhaseIndex`, `phaseThread`, `isTerminal`, `cancelRun`, `fireAndForget`.

No unit test (React component). Verify by typecheck + full test run + visual.

- [ ] **Step 1: Add imports**

Add `currentPhaseIndex` and `leadWorker` to the existing `./runmodel` import in `runssurface.tsx` (alongside `phaseThread`, `phaseWorkers`, `isTerminal`, `isOrchestrator`, etc.):
```tsx
import {
    composerSummary,
    currentPhaseIndex,
    defaultRunId,
    isOrchestrator,
    isTerminal,
    leadWorker,
    planDirty,
    phaseProgressDots,
    phaseRailIds,
    phaseStateView,
    phaseThread,
    phaseWorkers,
    recordedWorkerTabs,
    resolveActiveRunId,
    resolveArtifactPath,
    runStatusView,
    steerTarget,
} from "./runmodel";
```
(`RunWorkerCard` and `useSubagentTracking` are already imported.)

- [ ] **Step 2: Add the `OrchestratorBody` component**

Add above `RunsView` (after `RunHeader`):
```tsx
// Dedicated body for an orchestrator run: one long-lived lead in one phase. A flex-fill column so the
// lead transcript grows to the viewport (RunWorkerCard fill), with its dispatched subagents beneath it.
// Reuses the same header/gate/ask/blocked/ship/cancel pieces as the pipeline rail — only the layout is
// orchestrator-specific. Not wrapped in the surface's scroll container: the transcript owns scrolling.
function OrchestratorBody({
    model,
    channel,
    agents,
    run,
    now,
    liveTabIds,
    steering,
    steerDraft,
    setSteerDraft,
    onSteerToggle,
    onSteerClose,
}: {
    model: AgentsViewModel;
    channel: Channel;
    agents: AgentVM[];
    run: Run;
    now: number;
    liveTabIds: Set<string>;
    steering: boolean;
    steerDraft: string;
    setSteerDraft: (s: string) => void;
    onSteerToggle: () => void;
    onSteerClose: () => void;
}) {
    const idx = currentPhaseIndex(run);
    const thread = phaseThread(run, idx, agents, liveTabIds);
    const lead = leadWorker(run, agents);
    // populate subagentsByIdAtom[lead] for DispatchedAgents (as PhaseRail does for pipeline)
    useSubagentTracking(lead ? [lead] : []);
    return (
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-3 pt-5">
            <RunHeader
                run={run}
                agents={agents}
                channel={channel}
                steering={steering}
                steerDraft={steerDraft}
                setSteerDraft={setSteerDraft}
                onSteerToggle={onSteerToggle}
                onSteerClose={onSteerClose}
            />
            {thread.showGate ? <ReviewGateCard channelId={channel.oid} run={run} gateIdx={idx} /> : null}
            {thread.showAsk && thread.askAgent && thread.askKind ? (
                <AskCard model={model} agent={thread.askAgent} kind={thread.askKind} />
            ) : null}
            {thread.showWorkers && lead ? (
                <div className="mt-3 flex min-h-0 flex-1 flex-col">
                    <RunWorkerCard model={model} agent={lead} now={now} fill />
                    <DispatchedAgents model={model} leadId={lead.id} />
                </div>
            ) : null}
            {thread.showStarting ? <StartingCard /> : null}
            {thread.showBlocked ? <BlockedCard model={model} channelId={channel.oid} run={run} worker={lead} /> : null}
            {thread.showShip ? <ShipMarker /> : null}
            {!isTerminal(run.status) ? (
                <button
                    type="button"
                    onClick={() => fireAndForget(() => cancelRun(channel.oid, run.id))}
                    className="mt-4 flex-none self-start rounded-[8px] border border-edge-mid px-3 py-1.5 text-[11.5px] font-semibold text-muted hover:border-error hover:text-error"
                >
                    Cancel run
                </button>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 3: Branch the body in `RunsView`**

In `RunsView`'s return, replace the body container (currently the `<div className="sc min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-5"><div>{run ? (...) : (...)}</div></div>`, ~lines 647-737) so the orchestrator arm renders `OrchestratorBody` **outside** the scroll container:
```tsx
            {run && isOrchestrator(run) ? (
                <OrchestratorBody
                    model={model}
                    channel={channel}
                    agents={agents}
                    run={run}
                    now={now}
                    liveTabIds={liveTabIds}
                    steering={steering}
                    steerDraft={steerDraft}
                    setSteerDraft={setSteerDraft}
                    onSteerToggle={onSteerToggle}
                    onSteerClose={onSteerClose}
                />
            ) : (
                <div className="sc min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-5">
                    <div>
                        {run ? (
                            <>
                                <RunHeader
                                    run={run}
                                    agents={agents}
                                    channel={channel}
                                    steering={steering}
                                    steerDraft={steerDraft}
                                    setSteerDraft={setSteerDraft}
                                    onSteerToggle={onSteerToggle}
                                    onSteerClose={onSteerClose}
                                />
                                {run.status === "executing" && primaryWorker ? (
                                    <RunRollup agent={primaryWorker} now={now} />
                                ) : null}
                                <CompactStepper run={run} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />
                                {expanded ? (
                                    <PhaseRail model={model} run={run} agents={agents} channelId={channel.oid} liveTabIds={liveTabIds} now={now} entranceIds={entranceIds} />
                                ) : null}
                                {!isTerminal(run.status) ? (
                                    <button
                                        type="button"
                                        onClick={() => fireAndForget(() => cancelRun(channel.oid, run.id))}
                                        className="mt-4 rounded-[8px] border border-edge-mid px-3 py-1.5 text-[11.5px] font-semibold text-muted hover:border-error hover:text-error"
                                    >
                                        Cancel run
                                    </button>
                                ) : null}
                            </>
                        ) : (
                            <div className="mx-auto mt-10 w-full max-w-[620px]">
                                <div className="mb-1 text-center text-[17px] font-bold text-primary">Start a run</div>
                                <div className="mb-5 text-center text-[13px] text-muted">Give Jarvis a goal for #{channel.name}</div>
                                <ComposerShell
                                    value={draft}
                                    onChange={setDraft}
                                    onSubmit={startRun}
                                    autoFocus
                                    placeholder="Give Jarvis a goal to start a run…"
                                    sendLabel="Start run ⏎"
                                    footerLeft={
                                        <span className="font-mono text-[11.5px] text-ink-mid">{composerSummary(runMode, planGate)}</span>
                                    }
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}
```
This preserves the pipeline arm and new-run panel exactly; it only adds the orchestrator arm ahead of them and moves the pipeline/new-run bodies inside the `else`. The surrounding `<div className="flex min-w-0 flex-1 flex-col">` (which also holds the run-tabs strip) and the trailing `<ProfilePanel/>` are unchanged.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Run the full runmodel test file**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts`
Expected: PASS (all suites, including the pre-existing ones and Task 1's additions).

- [ ] **Step 6: Verify (visual, best-effort)**

With dev running and an **orchestrator** run injected (`node scripts/inject-live-agents.mjs <scenario>` — pick/adjust a scenario whose run has `mode: "orchestrator"`):
- The lead transcript fills the surface height (not a 260px box); scrolling happens inside it.
- The dispatched section shows rich rows (↳ + state dot + type + model + state pill); a row with a transcript is clickable and, on click, switches to the agent surface with that child's interior open (Esc / breadcrumb returns).
- Finished subagents still appear (as `done`/`success`).
- A **pipeline** run still renders the stepper + phase rail unchanged.
- Plan-gate (orchestrator held → `awaiting-review`), blocked (worker exited), and done (ship) states still appear in the orchestrator body.
Capture `node scripts/cdp-shot.mjs`. If dev is not running, mark UNVERIFIED (reason: dev app not running).

---

## Final: Batched commit (approval-gated)

Per the repo owner's git policy, do NOT commit during the tasks. After all tasks pass typecheck + `npx vitest run frontend/app/view/agents/runmodel.test.ts` and the visual checks are done (or explicitly marked unverified):

- [ ] **Step 1: Self-review the full diff**

Run `git status` and `git --no-pager diff --stat`, then review each changed file. Confirm: no `SubagentRows` reference remains; the pipeline arm renders identically (header via `RunHeader`, rollup/stepper/rail/cancel unchanged); `RunWorkerCard fill` defaults false so all other call sites are unaffected; no commented-out code or debug logs.

- [ ] **Step 2: Present the change set and commit message for approval**

Show the files (M) with a one-line summary each and this proposed message, then ask "Awaiting approval. Proceed? (yes/no)":
```
feat(runs): dedicated orchestrator body with fill-height transcript and rich dispatched agents
```

- [ ] **Step 3: Commit only after explicit approval**

```bash
git add frontend/app/view/agents/runmodel.ts frontend/app/view/agents/runmodel.test.ts frontend/app/view/agents/runworkercard.tsx frontend/app/view/agents/runssurface.tsx
git commit -m "feat(runs): dedicated orchestrator body with fill-height transcript and rich dispatched agents"
```

---

## Self-Review

**Spec coverage:**
- Problem 1 (cramped transcript) → Task 2 (`fill` variant) + Task 5 (fill-height orchestrator body). ✓
- Problem 2 (poor dispatched UI) → Task 3 (`DispatchedAgents`: rich rows, click-to-open). ✓
- Problem 3 (dead pipeline chrome) → Task 5 (orchestrator body drops stepper/rail/rollup). ✓
- Decision "dedicated body, not fork" → Task 5 reuses `RunHeader`/`RunWorkerCard`/gate/ask/blocked/ship/cancel; only layout differs. ✓
- Decision "fill via variant" → Task 2. ✓
- Decision "agenttree idiom + show finished" → Task 3 (keeps all subs; click via `focusSubagentAtom` + `jumpToAgent`). ✓
- Decision "one pure seam `leadWorker`" → Task 1. ✓
- Non-goal "pipeline untouched" → Task 4/5 keep the pipeline arm byte-identical apart from the mechanical `RunHeader` extraction (verified in Task 4 Step 5). ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows complete code. ✓

**Type consistency:** `leadWorker(run, agents): AgentVM | undefined` defined in Task 1, consumed in Task 5. `RunWorkerCard`'s `fill?: boolean` defined in Task 2, passed in Task 5. `DispatchedAgents({ model, leadId })` defined in Task 3, called in Task 3 (PhaseRail) and Task 5 (OrchestratorBody) with the same props. `RunHeader` props defined in Task 4 match both call sites in Task 4 and Task 5. `SUB_TONE_CLASS` keyed by `SubagentState` (`working|success|failure|done`), matching `sessionviewmodel.ts`. Reused symbols (`currentPhaseIndex`, `phaseThread`, `phaseWorkers`, `useSubagentTracking`, `subagentsByIdAtom`, `focusSubagentAtom`, `jumpToAgent`, `cancelRun`, `steerWorker`, `ComposerShell`, `StatusPill`) exist at the cited locations. ✓

**Known deviation from the writing-plans skill:** per-task `git commit` steps are intentionally replaced by verify checkpoints + one approval-gated commit at the end, because the repo owner's CLAUDE.md forbids auto-commits and mandates a single batched commit. This overrides the skill's frequent-commit default.
