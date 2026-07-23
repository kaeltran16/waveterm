# Jarvis G — Plan 3: Fleet-manager migration into the surface + Channels removal + `@jarvis` reroute

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the fleet manager out of the Channels surface and into a first-class **Fleet mode** of the Jarvis surface — relocate its UI cluster, rebuild the roster/autonomy/summary/profile controls under `view/jarvis/`, strip those controls from Channels, and reroute the in-channel `@jarvis` *summary* to hand off to the surface while leaving delegator-tier worker dispatch in-channel.

**Architecture:** Pure frontend; no Go/wshrpc change — every backend behavior reuses existing RPCs unchanged (`JarvisCommand`, `JarvisDecomposeCommand`, `SetChannelTierCommand`, `getJarvisProfile`/`setChannelProfile`). Per the approved relocation decision, only the **fleet-UI cluster** (`profilepanel`, `principleseditor`, `profilemodel`, `usefleetsummary`) moves into `view/jarvis/`; the **shared Channels+Jarvis domain layer** (`jarvisderive.ts`, `jarviscards.ts`) stays in `view/agents/` because 7+ surviving Channels files depend on it and `jarviscards` depends on `channelmessages` — a wholesale move would invert/bidirectionally-couple the two feature dirs. Fleet mode reuses the existing active-channel selection from `channelsstore` rather than introducing a second one. The `@jarvis` reroute is a jotai handoff (a pending-summary atom + a surface/mode switch), mirroring the `pendingRunDraft`/`pendingRunFocus` handoff already in `channelssurface`.

**Tech Stack:** React 19 + jotai, Vitest, the repo's CDP scenario harness (`scripts/cdp/`), Tailwind 4 `@theme` tokens. No Go, no `task generate`.

**This is Plan 3 of ~4 for sub-project G** (see the [G spec](../specs/2026-07-23-jarvis-ui-surface-design.md) §"Fleet migration + `@jarvis` rerouting" and §9, and [Plan 2](2026-07-23-jarvis-g-recall-backend-shim.md)):
- Plan 1 (done): surface shell + G⇄F conversation contract + surface states on fixtures.
- Plan 2 (done): backend shim `JarvisConverseCommand` + wire Recall mode to real SQLite.
- **Plan 3 (this):** fleet-manager migration into Fleet mode + Channels removal + `@jarvis` reroute. ← the risky slice; changes shipping Channels behavior.
- Plan 4: `Ctrl+P` "ask-jarvis" lead group + quick-ask states (8–10) + contextual entries + ambient fixtures + real `[n]`/card navigation.

## Decisions made (diverge from the spec's literal wording — open to revision at plan review)

The spec's fleet-migration section predates a full dependency trace. Three decisions were confirmed with the human before writing this plan; they reshape it away from the spec's "relocate all 5 files + update all importers":

1. **Relocation = split, not wholesale.** Move only the fleet-UI cluster (`profilepanel.tsx`, `principleseditor.tsx`, `profilemodel.ts` + test, `usefleetsummary.ts`) into `view/jarvis/`. **Leave `jarvisderive.ts` + `jarviscards.ts` in `view/agents/`** — they are shared domain (`WorkerState`, `buildFleetSnapshot`, ask-parsing, `parseCardData`, `tierChip`, unread counts) imported by `channelderive`, `channelneeds`, `channelrail`, `channelsprimitives`, `channelactions`, `channelcontextpanel`, `cockpitsurface` (all staying). Fleet mode imports them cross-dir (`../agents/…`).
2. **Profile drawer moves to Fleet mode.** The `⚙` `ProfilePanel` (which edits run-engine/plan-gate **and** playbook/principles) relocates. Channels keeps only the run-defaults **read** — `channelssurface`'s `getJarvisProfile` effect that feeds the composer/`createRun` is **untouched**; only the *editing UI* leaves Channels. Consequence: editing a channel's profile now happens in Jarvis Fleet mode, not the Channels `⚙`.
3. **`@jarvis` reroute = summary handoff, dispatch stays.** Delegator-tier `@jarvis` still dispatches a worker in-channel unchanged (incl. `fanout` via `JarvisDecomposeCommand`). The observe-only summary branch no longer streams into the channel; it sets a handoff and navigates to Jarvis Fleet mode, which runs the summary there.

## What this plan deliberately does NOT do

- **No backend change.** No new wshrpc command, no `task generate`. If you find yourself editing Go, stop — you've misread the plan.
- **No new channel-selection model.** Fleet mode reuses `channelsstore`'s `activeChannelAtom` / `activeChannelIdAtom` / `selectChannel`. A channel selected in Channels is the same one Fleet mode manages, and vice-versa.
- **No move of `jarvisderive.ts` / `jarviscards.ts`** and no move of their tests (`jarvisderive.test.ts`, `jarviscards.test.ts` stay in `view/agents/`). Decision 1.
- **No change to `@jarvis` parsing.** `planMessage`/`planDelegate`/`tierFromMeta` in `channelmessages.ts` are unchanged (`channelmessages.test.ts` stays green as-is). The reroute lives entirely in `channelactions.ts`'s summary branch + the handoff atom.
- **No ambient attribution, no `Ctrl+P` group, no contextual entries** — those are Plan 4.
- **The `mentionCandidates` `@jarvis` handle stays** (`channelderive.ts` line ~150) — it is just the composer's mention token and needs no change.

## Global Constraints

Every task's requirements implicitly include these. Values copied verbatim from CLAUDE.md, Plan 2, and the codebase.

- **Split-relocation dependency rule.** `view/jarvis/` may import from `view/agents/` (shared domain, channelsstore, primitives). `view/agents/` must **not** import from `view/jarvis/` — with the single sanctioned exception of the `@jarvis` handoff in `channelactions.ts` (Channels handing off *to* Jarvis; a legitimate producer→consumer direction). After each task, `grep -rn 'view/jarvis\|from "\.\./jarvis' frontend/app/view/agents` must show only that one handoff import.
- **Surface unmounts on nav-switch** (only the agent surface stays mounted). Every survive-worthy value lives in a module atom written via `globalStore.set`, never component `useState`. The `@jarvis` handoff payload and Fleet mode's cross-nav state follow this.
- **Reuse existing RPCs unchanged.** `JarvisCommand` (summary), `JarvisDecomposeCommand` (fanout dispatch), `SetChannelTierCommand` (via `setChannelTier`), `getJarvisProfile`/`setChannelProfile`/`getGlobalProfile`/`setGlobalProfile` (via `runactions`, used by `ProfilePanel`). Timeouts already correct in the moved files (`JARVIS_RPC_TIMEOUT_MS = 130_000`).
- **Dark mode only; `@theme` tokens** (`frontend/tailwindsetup.css`) — never raw hex; existing cockpit fonts; restrained motion. Relocated markup already conforms; new Fleet-mode markup must reuse the same token classes (`text-primary`/`text-muted`/`text-secondary`/`text-accent-soft`/`border-border`/`border-edge-mid`/`bg-surface`/`bg-accentbg`, etc.).
- **No jsdom render tests** (standing decision). Pure logic → Vitest; rendering → CDP `verify:ui`. Preserve every existing Plan 1/2 CDP scenario.
- **Typecheck (FE)** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` overflows). Baseline is clean; any error it reports is yours.
- **Vitest single file:** `node node_modules/vitest/vitest.mjs run frontend/app/view/<path>.test.ts`. Full FE suite: `node node_modules/vitest/vitest.mjs run`.
- **Git (per CLAUDE.md):** commits need explicit human approval and are batched — do NOT auto-commit or push. Each task's final step is **"stage + checkpoint for review."** This plan doc folds into the one feature commit at the end (never a docs-only commit).
- **`prettier --write` gotcha:** never run it on `scripts/cdp/*.mjs` (`.editorconfig` omits `.mjs` → 2-space reindent). Hand-match 4-space style.
- **File moves preserve history:** use `git mv` (not delete+create) so the relocated files keep blame.

## File Structure

**Moved** (via `git mv`, `frontend/app/view/agents/` → `frontend/app/view/jarvis/`):

| File | Post-move import fixes |
|---|---|
| `profilepanel.tsx` | `./principleseditor` and `./profilemodel` resolve locally (they move too). `profileRailOpenAtom` import changes `./railstore` → `./jarvisstore` (atom relocates — Task 1 step). `./runactions` → `../agents/runactions`. |
| `principleseditor.tsx` | `./profilemodel` resolves locally. No other `./` imports to repoint (uses global ambient types). |
| `profilemodel.ts` | No cross-file `./` imports (pure). Moves clean. |
| `profilemodel.test.ts` | `./profilemodel` resolves locally. Moves clean. |
| `usefleetsummary.ts` | `./jarvisderive` → `../agents/jarvisderive`; `./agentsviewmodel` → `../agents/agentsviewmodel`. |

**New** (`frontend/app/view/jarvis/`):

| File | Responsibility |
|---|---|
| `fleetmode.tsx` | The Fleet-mode composition: a channel selector, the autonomy tier toggle, the worker roster, the on-demand fleet summary, and the `⚙` profile drawer. Reuses `channelsstore` selection + `model.agentsAtom` + the shared domain helpers + the relocated `useFleetSummary`/`ProfilePanel`. Consumes the `@jarvis` handoff (Task 3). |

**Modified:**

| File | Change |
|---|---|
| `frontend/app/view/jarvis/jarvisstore.ts` | Add `profileRailOpenAtom` (relocated from `agents/railstore`) and `pendingFleetSummaryAtom` (the `@jarvis` handoff, Task 3). |
| `frontend/app/view/jarvis/jarvissurface.tsx` | Replace the Fleet-mode placeholder with `<FleetMode model={model} />` (thread the model through). |
| `frontend/app/view/agents/channelchrome.tsx` | `ChannelHeader`: drop the autonomy toggle + `⚙` (and their props). `OverviewStrip`: drop the Jarvis-summary pane + `summary`/`onRunSummary` props + `SummaryState` import. |
| `frontend/app/view/agents/channelssurface.tsx` | Remove `useFleetSummary`, `ProfilePanel` render + import, `profileRailOpenAtom` import + `setProfileOpen`, `toggleAutonomy` + `autonomyOn` + `tier`, and the removed props at the `ChannelHeader`/`OverviewStrip` call sites. Keep the `getJarvisProfile` effect, notes, and everything else. |
| `frontend/app/view/agents/channelcontextpanel.tsx` | Remove the now-dead `profileRailOpenAtom` read + the force-collapse-on-profile-open coordination. |
| `frontend/app/view/agents/railstore.ts` | Delete `profileRailOpenAtom` (relocated to `jarvisstore`). |
| `frontend/app/view/agents/channelactions.ts` | `sendChannelMessage` `kind:"jarvis"` summary branch: replace the in-channel post+`JarvisCommand` stream with the handoff (set `pendingFleetSummaryAtom` + `jarvisModeAtom` + `model.surfaceAtom`). Keep the dispatch branch. Remove now-unused imports. |
| `frontend/app/view/jarvis/usefleetsummary.ts` | Extend `runSummary(channel, agents, focus?)` so the handoff can pass the `@jarvis <focus>` text (Task 3). |

**Unchanged (verify, don't touch):** `jarvisderive.ts`, `jarviscards.ts` and their tests; `channelmessages.ts` + `channelmessages.test.ts`; `channelsstore.ts`; the `getJarvisProfile` read path in `channelssurface`.

---

### Task 1: Relocate the fleet-UI cluster into `view/jarvis/` and strip the fleet controls from Channels

This is one cohesive change ("the fleet controls leave Channels"): the relocation and the Channels removal are inseparable because `channelssurface` imports `ProfilePanel`/`useFleetSummary` directly and shares `profileRailOpenAtom` with `ProfilePanel`. Splitting them would either break the build or leave a broken `⚙`. After this task the moved files exist under `view/jarvis/` but are not yet rendered (Fleet mode still shows its placeholder) — that is a valid, green intermediate.

**Files:**
- Move: `profilepanel.tsx`, `principleseditor.tsx`, `profilemodel.ts`, `profilemodel.test.ts`, `usefleetsummary.ts` (agents → jarvis)
- Modify: `frontend/app/view/jarvis/jarvisstore.ts`, `frontend/app/view/agents/channelchrome.tsx`, `frontend/app/view/agents/channelssurface.tsx`, `frontend/app/view/agents/channelcontextpanel.tsx`, `frontend/app/view/agents/railstore.ts`

**Interfaces:**
- Produces: relocated `ProfilePanel` (`{ channelId: string }`), `useFleetSummary()`, and `frontend/app/view/jarvis/jarvisstore.ts` now exports `profileRailOpenAtom` (`atom(false)`).
- Consumes: `runactions` (`getJarvisProfile`/`setChannelProfile`/`getGlobalProfile`/`setGlobalProfile`), `jarvisderive`/`agentsviewmodel` — all from `../agents/`.

- [ ] **Step 1: Move the five files with `git mv`**

```bash
git mv frontend/app/view/agents/profilepanel.tsx      frontend/app/view/jarvis/profilepanel.tsx
git mv frontend/app/view/agents/principleseditor.tsx  frontend/app/view/jarvis/principleseditor.tsx
git mv frontend/app/view/agents/profilemodel.ts        frontend/app/view/jarvis/profilemodel.ts
git mv frontend/app/view/agents/profilemodel.test.ts   frontend/app/view/jarvis/profilemodel.test.ts
git mv frontend/app/view/agents/usefleetsummary.ts     frontend/app/view/jarvis/usefleetsummary.ts
```

- [ ] **Step 2: Relocate `profileRailOpenAtom` into `jarvisstore.ts`**

In `frontend/app/view/jarvis/jarvisstore.ts`, add near the other UI atoms (after `groundingRailOpenAtom`, ~line 39):

```ts
// The Jarvis Fleet-mode profile drawer (the ⚙). Relocated from agents/railstore in Plan 3 — the profile
// editor now lives in Fleet mode, not the Channels header. Session-scoped, not persisted.
export const profileRailOpenAtom = atom(false);
```

Then in `frontend/app/view/agents/railstore.ts`, delete the `profileRailOpenAtom` declaration (the `export const profileRailOpenAtom = atom(false);` line and its doc-comment block, ~lines 34–37).

- [ ] **Step 3: Fix the moved files' imports**

In `frontend/app/view/jarvis/profilepanel.tsx`:
- change `import { getGlobalProfile, getJarvisProfile, setChannelProfile, setGlobalProfile } from "./runactions";` → `from "../agents/runactions";`
- change `import { profileRailOpenAtom } from "./railstore";` → `import { profileRailOpenAtom } from "./jarvisstore";`
- (`./principleseditor` and `./profilemodel` stay — both moved alongside.)

In `frontend/app/view/jarvis/usefleetsummary.ts`:
- change `import { type AgentVM } from "./agentsviewmodel";` → `from "../agents/agentsviewmodel";`
- change `import { buildFleetSnapshot, buildJarvisPrompt } from "./jarvisderive";` → `from "../agents/jarvisderive";`

(`principleseditor.tsx` → `./profilemodel` and `profilemodel.test.ts` → `./profilemodel` resolve locally; no edit.)

- [ ] **Step 4: Strip the fleet controls from `channelchrome.tsx`**

`ChannelHeader` — remove the autonomy toggle and the `⚙`. Change its props to drop `autonomyOn`/`onToggleAutonomy`/`onOpenProfile`, and replace the whole `{channel ? ( <> … </> ) : null}` block (the `<span>Jarvis</span>` + toggle button + `⚙` button, ~lines 38–80) with nothing (the header keeps only the `#`, name, and project path). New signature + trailing markup:

```tsx
export function ChannelHeader({ channel }: { channel: Channel | null }) {
    return (
        <div className="flex flex-none items-center gap-2.5 border-b border-border bg-background px-6 py-3">
            <span className="font-mono text-[17px] font-bold text-muted">#</span>
            <div className="min-w-0">
                <div className="truncate text-[15px] font-bold tracking-[-0.01em] text-primary">
                    {channel?.name ?? "no channel"}
                </div>
                {channel?.projectpath ? (
                    <div className="truncate font-mono text-[11.5px] text-muted">{channel.projectpath}</div>
                ) : null}
            </div>
            <div className="flex-1" />
        </div>
    );
}
```

`OverviewStrip` — remove the Jarvis-summary pane. Drop `summary`/`onRunSummary` from its props, delete the `import { type SummaryState } from "./usefleetsummary";` line, and delete the `Avatar`/`MarkdownMessage` imports **only if now unused** (they are used only by the summary pane in this file — verify with a grep; if unused, remove `import { Avatar } from "./channelsprimitives";` and `import { MarkdownMessage } from "./markdownmessage";`). Replace the open-body (`{open ? ( <div …> …two columns… </div> ) : null}`, ~lines 125–168) with a notes-only body:

```tsx
export function OverviewStrip({
    open,
    onToggle,
    runCount,
    notes,
    onNotesChange,
}: {
    open: boolean;
    onToggle: () => void;
    runCount: number;
    notes: string;
    onNotesChange: (value: string) => void;
}) {
    return (
        <div className="flex-none border-b border-border bg-background">
            <button
                type="button"
                onClick={onToggle}
                className="flex w-full cursor-pointer items-center gap-2.5 px-6 py-2 hover:bg-surface"
            >
                <span className={"font-mono text-[7px] text-muted transition-transform " + (open ? "rotate-90" : "")}>
                    ▶
                </span>
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-muted">
                    Overview &amp; notes
                </span>
                <span className="font-mono text-[11px] text-ink-mid">
                    · {runCount} run{runCount === 1 ? "" : "s"}
                </span>
                <div className="flex-1" />
                {!open ? (
                    <span className="truncate text-[11px] text-muted" style={{ maxWidth: 420 }}>
                        {notes.trim() ? notes.trim() : "No notes yet"}
                    </span>
                ) : null}
            </button>
            {open ? (
                <div className="px-6 pb-3.5 pt-0.5">
                    <div className="mb-1.5 font-mono text-[8.5px] font-semibold uppercase tracking-[.08em] text-muted">
                        Channel notes
                    </div>
                    <textarea
                        value={notes}
                        onChange={(e) => onNotesChange(e.target.value)}
                        placeholder="Notes for this channel…"
                        rows={4}
                        className="w-full resize-y rounded-[10px] border border-border bg-background px-3 py-2.5 text-[12.5px] leading-[1.6] text-secondary outline-none focus:border-accent/40"
                    />
                </div>
            ) : null}
        </div>
    );
}
```

(`RunStrip` is unchanged.)

- [ ] **Step 5: Strip the fleet wiring from `channelssurface.tsx`**

Remove these imports:
- `import { ProfilePanel } from "./profilepanel";`
- `import { profileRailOpenAtom } from "./railstore";`
- `import { useFleetSummary } from "./usefleetsummary";`

Remove these hook/derivation lines from the component body:
- `const setProfileOpen = useSetAtom(profileRailOpenAtom);` (~line 72)
- `const { summary, runSummary, reset: resetSummary } = useFleetSummary();` (~line 93)
- `const tier = tierFromMeta(active?.meta as Record<string, unknown> | undefined);` and `const autonomyOn = tier !== "concierge";` (~lines 127–128)
- `const toggleAutonomy = () => { … };` (the whole function, ~lines 230–237)
- In the `useEffect(() => { resetSummary(); attach.clear(); setOverviewOpen(false); … }, [activeId]);` (~lines 135–140), drop the `resetSummary();` call (keep `attach.clear()` + `setOverviewOpen(false)`).

Keep `tierFromMeta` in the import from `./channelmessages` **only if still used elsewhere** — after removing `tier`, grep the file for `tierFromMeta`; if it has no other use, drop it from that import (`import { type RosterEntry } from "./channelmessages";`). `setChannelTier` **stays** (the `ChannelRail` `onSetTier` at ~line 347 still uses it).

Update the JSX call sites:
- `<ChannelHeader channel={active} autonomyOn={autonomyOn} onToggleAutonomy={toggleAutonomy} onOpenProfile={() => setProfileOpen((o) => !o)} />` → `<ChannelHeader channel={active} />`
- `<OverviewStrip open={overviewOpen} onToggle={…} runCount={runs.length} summary={summary} onRunSummary={() => runSummary(activeForDerive!, agents)} notes={notesDraft} onNotesChange={onNotesChange} />` → drop `summary` and `onRunSummary` (keep `open`/`onToggle`/`runCount`/`notes`/`onNotesChange`).
- Delete the `<ProfilePanel channelId={active?.oid ?? ""} />` element (~line 505).

Leave the `getJarvisProfile` effect (~lines 144–160) and `profile`/`setProfile` **intact** — they feed the composer's run-defaults and are not the drawer.

- [ ] **Step 6: Remove the dead profile-drawer coordination in `channelcontextpanel.tsx`**

The context panel force-collapses when the profile drawer is open. With the drawer gone from Channels, that coordination is dead. Change `import { channelRailOpenAtom, profileRailOpenAtom } from "./railstore";` → `import { channelRailOpenAtom } from "./railstore";`, delete `const profileOpen = useAtomValue(profileRailOpenAtom);` (~line 145), and simplify whatever expression consumed `profileOpen` (it gated a force-collapse to 0 — remove the `profileOpen` term so the rail follows only its own open state). Read the surrounding lines and adjust the collapse expression so it no longer references `profileOpen`.

- [ ] **Step 7: Verify no `agents → jarvis` import leaked and the build is clean**

```bash
grep -rn 'from "\.\./jarvis\|view/jarvis' frontend/app/view/agents
```
Expected: **no output** (Task 3 introduces the one sanctioned handoff import; it does not exist yet).

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```
Expected: exit 0.

- [ ] **Step 8: Run the relocated unit test + the unaffected shared-domain tests**

```bash
node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis/profilemodel.test.ts frontend/app/view/agents/jarvisderive.test.ts frontend/app/view/agents/jarviscards.test.ts frontend/app/view/agents/channelmessages.test.ts
```
Expected: all PASS (proves the move didn't break `profilemodel`, and the shared domain + `@jarvis` parsing are untouched).

- [ ] **Step 9: CDP smoke — Channels still renders without fleet controls**

Run the existing Channels CDP scenario(s): `task verify:ui -- channels` (use the actual scenario name from `scripts/cdp/scenarios.mjs`; list them if unsure). Expected: PASS — the Channels surface renders; the header shows no autonomy toggle / `⚙`, and the overview strip shows notes only.

- [ ] **Step 10: Stage + checkpoint** (`git add` the moved + modified files; do not commit).

---

### Task 2: Build Jarvis Fleet mode

**Files:**
- Create: `frontend/app/view/jarvis/fleetmode.tsx`
- Modify: `frontend/app/view/jarvis/jarvissurface.tsx`

**Interfaces:**
- Consumes: `channelsstore` (`channelsAtom`, `activeChannelAtom`, `activeChannelIdAtom`, `activeChannelMessagesAtom`, `selectChannel`, `setChannelTier`, `loadChannels`), `model.agentsAtom`, `tierFromMeta` (`../agents/channelmessages`), `buildFleetSnapshot`/`fleetCostUsd` (`../agents/jarvisderive`), `fleetCounts`/`tierChip`/`autonomyExplainer` (`../agents/jarviscards`), `Avatar` (`../agents/channelsprimitives`), the relocated `useFleetSummary` + `ProfilePanel`, and `profileRailOpenAtom` (`./jarvisstore`).
- Produces: `export function FleetMode({ model }: { model: AgentsViewModel }).`

- [ ] **Step 1: Write `fleetmode.tsx`**

Create `frontend/app/view/jarvis/fleetmode.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Jarvis Fleet mode: the migrated fleet manager. Manages ONE channel's fleet at a time — reusing the
// Channels active-channel selection (channelsstore) so the two surfaces never disagree. Composes a channel
// selector, the autonomy tier toggle, the worker roster, the on-demand fleet summary, and the ⚙ profile
// drawer. All backend behavior reuses existing RPCs (SetChannelTier via setChannelTier, JarvisCommand via
// useFleetSummary, getJarvisProfile/setChannelProfile via ProfilePanel). No new state model.

import { fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import type { AgentsViewModel } from "../agents/agents";
import { tierFromMeta } from "../agents/channelmessages";
import { Avatar } from "../agents/channelsprimitives";
import {
    activeChannelAtom,
    activeChannelIdAtom,
    activeChannelMessagesAtom,
    channelsAtom,
    loadChannels,
    selectChannel,
    setChannelTier,
} from "../agents/channelsstore";
import { autonomyExplainer, fleetCounts } from "../agents/jarviscards";
import { buildFleetSnapshot, fleetCostUsd } from "../agents/jarvisderive";
import { ProfilePanel } from "./profilepanel";
import { profileRailOpenAtom } from "./jarvisstore";
import { useFleetSummary } from "./usefleetsummary";

const STATE_TONE: Record<string, string> = {
    working: "text-working",
    asking: "text-asking",
    idle: "text-muted",
    gone: "text-ink-mid",
};

export function FleetMode({ model }: { model: AgentsViewModel }) {
    const channels = useAtomValue(channelsAtom);
    const activeId = useAtomValue(activeChannelIdAtom);
    const active = useAtomValue(activeChannelAtom);
    const messages = useAtomValue(activeChannelMessagesAtom);
    const agents = useAtomValue(model.agentsAtom);
    const setProfileOpen = useSetAtom(profileRailOpenAtom);
    const { summary, runSummary } = useFleetSummary();

    useEffect(() => {
        fireAndForget(loadChannels);
    }, []);

    // splice row-backed messages onto the pinned channel so buildFleetSnapshot / the summary derive from the
    // same source as the Channels surface (mirrors channelssurface's activeForDerive).
    const activeForDerive = active ? { ...active, messages } : null;
    const snapshot = activeForDerive ? buildFleetSnapshot(activeForDerive, agents) : [];
    const counts = fleetCounts(snapshot);
    const cost = fleetCostUsd(snapshot);
    const tier = tierFromMeta(active?.meta as Record<string, unknown> | undefined);
    const autonomyOn = tier !== "concierge";
    const explainer = autonomyExplainer(tier);

    const toggleAutonomy = () => {
        if (!active) {
            return;
        }
        const next = autonomyOn ? "concierge" : "gatekeeper";
        const mode = ((active.meta as Record<string, unknown> | undefined)?.["delegator:mode"] as string) ?? "report";
        fireAndForget(() => setChannelTier(active.oid, next, mode));
    };

    if (!channels || channels.length === 0) {
        return (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted">
                No channels yet. Create a channel in the Channels surface to manage its fleet here.
            </div>
        );
    }

    return (
        <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
                {/* channel selector + autonomy + profile trigger */}
                <div className="flex flex-none items-center gap-2.5 border-b border-border bg-background px-6 py-3">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[.08em] text-muted">Fleet</span>
                    <select
                        value={activeId ?? ""}
                        onChange={(e) => fireAndForget(() => selectChannel(e.target.value))}
                        className="rounded-[7px] border border-edge-mid bg-surface px-2 py-1 text-[12.5px] font-semibold text-primary"
                    >
                        {channels.map((c) => (
                            <option key={c.oid} value={c.oid}>
                                #{c.name}
                            </option>
                        ))}
                    </select>
                    <div className="flex-1" />
                    {active ? (
                        <>
                            <button
                                type="button"
                                onClick={toggleAutonomy}
                                title={explainer.blurb}
                                className={
                                    "flex cursor-pointer items-center gap-2.5 rounded-[9px] border px-2.5 py-1.5 " +
                                    (autonomyOn ? "border-accent/40 bg-accentbg/20" : "border-edge-mid bg-background")
                                }
                            >
                                <span className={"text-[11.5px] font-bold " + (autonomyOn ? "text-accent-soft" : "text-secondary")}>
                                    {autonomyOn ? "Handling asks" : "Observing"}
                                </span>
                                <span
                                    className={
                                        "relative h-[18px] w-[34px] flex-none rounded-full transition-colors " +
                                        (autonomyOn ? "bg-accent" : "bg-edge-mid")
                                    }
                                >
                                    <span
                                        className={
                                            "absolute top-0.5 h-[14px] w-[14px] rounded-full transition-all " +
                                            (autonomyOn ? "left-[18px] bg-background" : "left-0.5 bg-secondary")
                                        }
                                    />
                                </span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setProfileOpen((o) => !o)}
                                title="Channel profile — playbook, principles, run engine & plan gate"
                                className="flex h-8 w-8 flex-none items-center justify-center rounded border border-edge-mid bg-background text-[15px] text-muted hover:border-edge-strong hover:text-secondary"
                            >
                                ⚙
                            </button>
                        </>
                    ) : null}
                </div>

                {/* fleet counts + summary */}
                <div className="flex flex-none items-center gap-3 border-b border-border bg-background px-6 py-2.5 text-[11.5px] text-muted">
                    <span>{counts.working} working</span>
                    <span>{counts.waiting} waiting</span>
                    {cost > 0 ? <span>${cost.toFixed(2)}</span> : null}
                    <div className="flex-1" />
                    <button
                        type="button"
                        onClick={() => activeForDerive && runSummary(activeForDerive, agents)}
                        disabled={!activeForDerive || snapshot.length === 0}
                        className="rounded-[7px] border border-accent/25 px-2.5 py-1 text-[11px] font-bold text-accent-soft hover:border-accent/40 disabled:opacity-40"
                    >
                        Summarize the fleet
                    </button>
                </div>
                {summary ? (
                    <div className="flex-none border-b border-border bg-background px-6 py-3">
                        <div className="mb-1.5 flex items-center gap-1.5">
                            <Avatar name="jarvis" />
                            <span className="font-mono text-[8.5px] font-semibold uppercase tracking-[.08em] text-accent-soft">
                                Jarvis {summary.status === "streaming" ? "· thinking…" : ""}
                            </span>
                        </div>
                        <div className="whitespace-pre-wrap text-[12.5px] leading-[1.6] text-secondary">{summary.text || "…"}</div>
                    </div>
                ) : null}

                {/* worker roster */}
                <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-6 py-4">
                    {snapshot.length === 0 ? (
                        <div className="pt-10 text-center text-[13px] text-muted">
                            No workers dispatched in #{active?.name} yet.
                        </div>
                    ) : (
                        snapshot.map((w) => (
                            <div key={w.oref} className="flex items-center gap-2.5 rounded-[9px] border border-edge-mid bg-surface px-3 py-2">
                                <Avatar name={w.name} />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-[13px] font-semibold text-primary">{w.name}</div>
                                    {w.task ? <div className="truncate text-[11.5px] text-muted">{w.task}</div> : null}
                                </div>
                                {w.askText ? <span className="truncate text-[11px] text-asking" style={{ maxWidth: 220 }}>{w.askText}</span> : null}
                                <span className={"font-mono text-[10px] font-semibold uppercase tracking-[.06em] " + (STATE_TONE[w.state] ?? "text-muted")}>
                                    {w.state}
                                </span>
                            </div>
                        ))
                    )}
                </div>
            </div>
            <ProfilePanel channelId={activeId ?? ""} />
        </div>
    );
}
```

> Note on tokens: `text-working`/`text-asking` are the cockpit state tokens used elsewhere (e.g. `runbody`/`runmodel` `TONE_CLASS`). Confirm they exist in `tailwindsetup.css`; if a name differs, use the actual state token (do not introduce raw hex). `Avatar`'s import path/props are as used by `channelchrome`/`channelsprimitives` — verify the prop name (`name`).

- [ ] **Step 2: Render Fleet mode in the surface**

In `frontend/app/view/jarvis/jarvissurface.tsx`:
- Change the signature to use the model: `export function JarvisSurface({ model }: { model: AgentsViewModel })` (drop the `_model` rename).
- Add `import { FleetMode } from "./fleetmode";`.
- Replace the placeholder block:

```tsx
{mode === "fleet" ? (
    <div className="flex flex-1 items-center justify-center text-[13px] text-muted">
        Fleet manager — migrated in Plan 3.
    </div>
) : (
```
with:
```tsx
{mode === "fleet" ? (
    <FleetMode model={model} />
) : (
```

(The `conv`/Recall branch is unchanged. `activeConversationAtom` is still read for the recall branch only — leave it.)

- [ ] **Step 3: Verify the `agents → jarvis` rule + build**

```bash
grep -rn 'from "\.\./jarvis\|view/jarvis' frontend/app/view/agents
```
Expected: still **no output** (Fleet mode imports agents→ok; the reverse hasn't been added).

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```
Expected: exit 0.

- [ ] **Step 4: CDP smoke — Fleet mode renders**

Add a `jarvis-fleet` scenario to `scripts/cdp/scenarios.mjs` (mirror the existing `jarvis-*` scenarios: arrange = ensure at least one channel + a dispatched worker via `node scripts/inject-live-agents.mjs <scenario>` if needed; goto the jarvis surface, click the `Fleet` mode toggle; assert the roster / autonomy toggle render). Hand-match 4-space style (do not `prettier --write` `.mjs`). Run `task verify:ui -- jarvis-fleet`; expected PASS, contact sheet updated.

- [ ] **Step 5: Stage + checkpoint.**

---

### Task 3: Reroute the `@jarvis` summary to the surface (keep dispatch in-channel)

**Files:**
- Modify: `frontend/app/view/jarvis/jarvisstore.ts`, `frontend/app/view/jarvis/usefleetsummary.ts`, `frontend/app/view/jarvis/fleetmode.tsx`, `frontend/app/view/agents/channelactions.ts`

**Interfaces:**
- Produces: `pendingFleetSummaryAtom` in `jarvisstore.ts` (`atom<{ channelId: string; focus: string } | null>(null)`); `useFleetSummary().runSummary(channel, agents, focus?)`.
- Consumes (in `channelactions.ts`): `pendingFleetSummaryAtom`, `jarvisModeAtom` (`../jarvis/jarvisstore`), `model.surfaceAtom`. **This is the single sanctioned `agents → jarvis` import** (a handoff, per the Global Constraints).

- [ ] **Step 1: Add the handoff atom**

In `frontend/app/view/jarvis/jarvisstore.ts`, add near `pendingFleetSummary` peers (after `profileRailOpenAtom`):

```ts
// @jarvis handoff: a Channels @jarvis summary sets this + switches to Fleet mode, which selects the channel,
// runs the summary once, and clears it. null = no pending handoff. Module atom so it survives the nav-switch.
export const pendingFleetSummaryAtom = atom<{ channelId: string; focus: string } | null>(null);
```

- [ ] **Step 2: Let `runSummary` accept a focus**

In `frontend/app/view/jarvis/usefleetsummary.ts`, change the signature + the `buildJarvisPrompt` call:

```ts
    runSummary: (channel: Channel, agents: AgentVM[], focus?: string) => void;
```
```ts
    const runSummary = (channel: Channel, agents: AgentVM[], focus = "") => {
        const snapshot = buildFleetSnapshot(channel, agents);
        if (snapshot.length === 0) {
            setSummary({ status: "done", text: "No workers dispatched in this channel yet." });
            return;
        }
        const prompt = buildJarvisPrompt(snapshot, channel, focus);
```

(The rest of `useFleetSummary` is unchanged.)

- [ ] **Step 3: Consume the handoff in Fleet mode**

In `frontend/app/view/jarvis/fleetmode.tsx`:
- add `pendingFleetSummaryAtom` to the `./jarvisstore` import.
- add `const setPendingSummary = useSetAtom(pendingFleetSummaryAtom);` and `const pendingSummary = useAtomValue(pendingFleetSummaryAtom);`
- add an effect (after the `loadChannels` effect) that lands the handoff exactly once — select the target channel, then run the summary when its messages are the target's, then clear:

```tsx
    // land an @jarvis summary handoff: select the channel, then (once it's active) run the summary once.
    useEffect(() => {
        if (!pendingSummary) {
            return;
        }
        if (activeId !== pendingSummary.channelId) {
            fireAndForget(() => selectChannel(pendingSummary.channelId));
            return; // re-runs when activeId flips to the target
        }
        if (activeForDerive) {
            runSummary(activeForDerive, agents, pendingSummary.focus);
            setPendingSummary(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingSummary, activeId, messages]);
```

(`activeForDerive`/`runSummary`/`agents` are already in scope from Task 2.)

- [ ] **Step 4: Reroute the summary branch in `channelactions.ts`**

In `sendChannelMessage`, the `if (plan.kind === "jarvis") { … }` block: **keep** everything up to and including the `if (del.action === "dispatch") { … return; }` branch (the dispatch/fanout path is unchanged). **Replace** everything after it (the summary path: the `reqId`, the `PostChannelMessageCommand` anchor, the `buildFleetSnapshot`/`buildJarvisPrompt`, the `JarvisCommand` stream, and the `setConsultStream` calls — down to the `return;` that closes the `kind === "jarvis"` block) with the handoff:

```ts
        // observe-only summary: hand off to the Jarvis surface (Fleet mode) instead of streaming in-channel.
        globalStore.set(pendingFleetSummaryAtom, { channelId, focus: plan.text });
        globalStore.set(jarvisModeAtom, "fleet");
        globalStore.set(model.surfaceAtom, "jarvis");
        return;
```

Add the import: `import { jarvisModeAtom, pendingFleetSummaryAtom } from "@/app/view/jarvis/jarvisstore";`.

Remove now-unused imports from `channelactions.ts`:
- `buildFleetSnapshot`, `buildJarvisPrompt` from `./jarvisderive` — **only if** no other branch uses them (grep the file; the dispatch/fanout path does not — they were summary-only). If the whole `./jarvisderive` import becomes empty, delete the line.
- `activeChannelAtom`, `activeChannelMessagesAtom` from `./channelsstore` — **only if** now unused (they were spliced for the summary's `channelBase`/`channel`). Keep `consultStreamKey`/`consultStreamsAtom`/`setConsultStream` **only if** the `consult` branch still uses them (it does — `setConsultStream` is used by the `@ask` consult path; verify before removing anything).

> Grep-guard every removal: `grep -n "buildFleetSnapshot\|buildJarvisPrompt\|activeChannelAtom\|activeChannelMessagesAtom" frontend/app/view/agents/channelactions.ts` after editing; delete an import only when its symbol has zero remaining references.

- [ ] **Step 5: Verify the single sanctioned handoff import + build**

```bash
grep -rn 'from "@/app/view/jarvis\|from "\.\./jarvis\|view/jarvis' frontend/app/view/agents
```
Expected: **exactly one** hit — the `channelactions.ts` handoff import. No others.

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```
Expected: exit 0.

- [ ] **Step 6: Unit tests — parsing unchanged, dispatch preserved**

```bash
node node_modules/vitest/vitest.mjs run frontend/app/view/agents/channelmessages.test.ts
```
Expected: PASS unchanged (`planMessage`/`planDelegate` untouched — the reroute is purely in `channelactions`'s side-effect branch, so the parsing contract and the delegator dispatch decision are intact).

- [ ] **Step 7: CDP — `@jarvis <focus>` navigates to Fleet mode and summarizes**

Add/extend a CDP scenario: type `@jarvis status` in a non-delegator channel's composer, send; assert the surface switches to Jarvis / Fleet mode and the summary pane appears (streaming → done). If reproducing a live model call in CDP is flaky, assert only the navigation + that `runSummary` was invoked (summary pane present), not the model text. Run `task verify:ui -- <scenario>`; expected PASS.

- [ ] **Step 8: Stage + checkpoint.**

---

### Task 4: Full verification + docs fold-in

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-jarvis-second-brain-meta-spec.md` (tracking table), `docs/superpowers/specs/2026-07-23-jarvis-ui-surface-design.md` (§9 status)

- [ ] **Step 1: Full FE test suite**

```bash
node node_modules/vitest/vitest.mjs run
```
Expected: all PASS (no regression from the move or the reroute).

- [ ] **Step 2: Full typecheck**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Dependency-direction guard (final)**

```bash
grep -rn 'from "@/app/view/jarvis\|from "\.\./jarvis\|view/jarvis' frontend/app/view/agents
```
Expected: exactly one hit (the `channelactions.ts` handoff). Any other hit is a leaked `agents → jarvis` import — fix before finishing.

- [ ] **Step 4: Lint the touched files**

```bash
npx eslint frontend/app/view/jarvis frontend/app/view/agents/channelactions.ts frontend/app/view/agents/channelchrome.tsx frontend/app/view/agents/channelssurface.tsx frontend/app/view/agents/channelcontextpanel.tsx frontend/app/view/agents/railstore.ts
```
Expected: no new errors (pre-existing `no-undef` in `scripts/*.mjs` is unrelated — do not touch).

- [ ] **Step 5: CDP regression — all `jarvis-*` + `channels` scenarios**

`task verify:ui -- jarvis-empty jarvis-active jarvis-grounded jarvis-fleet channels` (use the real scenario names). Expected: PASS table; contact sheet at `cdp-shots/index.html`. This confirms Plan 1/2 recall states still render and the new Fleet mode + Channels-without-fleet-controls render.

- [ ] **Step 6: Docs fold-in**

- In the meta-spec tracking table (`2026-07-23-jarvis-second-brain-meta-spec.md`), update G's **Plan** cell to link all three plans (Plan 1, Plan 2, Plan 3). Do not add a separate Built column change until the feature is merged.
- In the G spec (`2026-07-23-jarvis-ui-surface-design.md`) §9, mark internal-decomposition step 4 (fleet migration) done and note the three confirmed decisions (split relocation; profile drawer → Fleet mode; `@jarvis` summary handoff + dispatch preserved) so the spec and the shipped code agree.

- [ ] **Step 7: Self-review the diff**, then **stage + checkpoint** — `git add` all touched files including the moved files and this plan doc (the plan folds into the eventual feature commit). Do **not** commit. Report what was verified (tsc, vitest, eslint, CDP) with the actual command output.

---

## Self-Review

**Spec coverage** (G spec §"Fleet migration + `@jarvis` rerouting"):
- "Relocate `jarvisderive`, `jarviscards`, `usefleetsummary`, `profilepanel`, `profilemodel` + tests" → **amended by decision 1**: only `usefleetsummary`/`profilepanel`/`profilemodel`(+test)/`principleseditor` relocate (Task 1); `jarvisderive`/`jarviscards`(+tests) stay. Documented in "Decisions made".
- "Remove the fleet controls from Channels (OverviewStrip Jarvis block, autonomy toggle, profile drawer)" → Task 1 steps 4–6.
- "Reroute `@jarvis`" → Task 3. "The `channelderive.ts` address-book handle stays" → honored (untouched; noted in "What this plan does NOT do").
- "Existing backend RPCs reused unchanged" → no Go change (Architecture + Global Constraints).
- G spec §9 step 4 → this whole plan. §"Two modes inside the one surface" Fleet mode → Task 2.

**Placeholder scan:** no "TBD"/"handle appropriately"/"similar to". The one intentional per-repo unknown is flagged inline for verification, not left vague: state-tone token names (`text-working`/`text-asking`) and `Avatar` prop — Task 2 step 1 says verify against `tailwindsetup.css`/`channelsprimitives` and substitute the real token, never raw hex.

**Type consistency:** `pendingFleetSummaryAtom` shape (`{ channelId; focus }`) is defined in Task 3 step 1 and consumed with the same fields in Task 3 steps 3–4. `runSummary`'s extended `(channel, agents, focus?)` signature (Task 3 step 2) matches its call sites in Task 2 (`runSummary(activeForDerive, agents)`, focus defaulted) and Task 3 (`runSummary(activeForDerive, agents, pendingSummary.focus)`). `FleetMode({ model })` (Task 2) matches the render site `<FleetMode model={model} />` (Task 2 step 2). `ChannelHeader`/`OverviewStrip` new prop shapes (Task 1 step 4) match their updated call sites (Task 1 step 5).

**Green-after-each-task:** Task 1 leaves moved files unused-but-compiling (Fleet placeholder still shown) — valid. Tasks 2–3 each end tsc-clean + test-green. The `agents → jarvis` guard is checked at the end of every task and must show 0 hits until Task 3 introduces exactly 1.
