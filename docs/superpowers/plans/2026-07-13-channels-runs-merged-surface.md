# Merged Channels Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the Channels tab's `Chat｜Runs` split into a single surface where "a channel *is* its runs" — delete the chat message stream, re-home its four capabilities (consult, ad-hoc dispatch, autonomy control, notes+summary) into Runs-native affordances, and give the surface one two-face composer driven by typed `@`-commands.

**Architecture:** Transform `channelssurface.tsx` from a `chat｜runs`-toggled host into a single always-runs surface. Extract the run *body* out of `RunsView` (which currently owns its own run strip, composers, and profile column) into a reusable `RunBody`. The surface then owns the chrome: header + single autonomy toggle + ⚙, a collapsible overview strip, a single run strip with local selection, `RunBody`, one bottom composer with a **Launch** face (`@quick`/`@run`/`@ask`) and a **Talk** face (message the live worker), and a reworked right rail (Needs you / Consults / Fleet here). No backend changes except one small deferred notes field.

**Tech Stack:** React 19, jotai, Tailwind 4 (`@theme` tokens), `motion/react`, vitest for pure logic, CDP for visual verification (no jsdom render harness for the cockpit).

## Global Constraints

- **Source of truth:** `docs/superpowers/specs/2026-07-13-channels-runs-merged-surface-design.md` (the design brief + decisions log #1–14). The visual reference is `wave-handoff/wave/project/Wave-channels-merged.dc.html` — port pixel values (colors, spacing, radii) from there, but map every color to an existing `@theme` token; **never** raw hex/rgba in markup.
- **No new SCSS.** Tailwind utilities only; convert any touched SCSS.
- **Never hand-edit generated files** (`wshclientapi.ts`, `frontend/types/gotypes.d.ts`). Edit Go + `task generate` if a type must change.
- **Typecheck** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows). Baseline is clean (exit 0) — any error it reports is yours.
- **Cockpit components have no jsdom/render harness.** Pure logic (parsers, derivations) gets vitest TDD. React components are verified by building and screenshotting the live dev app over CDP: `node scripts/cdp-shot.mjs [out.png]` (dev app must be running; inject data with `node scripts/inject-live-agents.mjs <scenario>` if needed).
- **Single frontend test:** `npx vitest run <file>` or `npx vitest run -t "<name>"`.
- **Launch modes are `Quick · Run · Ask`** (decision #11). `Run`'s engine (pipeline|orchestrator + plan gate) is the channel's ⚙ profile (`defaultmode`/`defaultplangate`), never chosen per-dispatch.
- **Composer commands are `@quick`/`@run`/`@ask`** (decision #12), a curated vocabulary. The removed `@claude`/`@codex`/`@jarvis`/`@name` mentions stay gone as user-facing input; `sendChannelMessage`'s `planMessage` parser remains only as internal transport.
- **Autonomy toggle** maps to the existing `SetChannelTierCommand`: on → `"gatekeeper"`, off → `"concierge"` (decision #4). `delegator` is no longer offered from the UI.

---

## File Structure

**Create:**
- `frontend/app/view/agents/runbody.tsx` — `RunBody` component: the extracted run body (header w/o steer, rollup, stepper, phase rail, orchestrator body, gate/ask/blocked cards). Given a `run` prop.
- `frontend/app/view/agents/composercommand.ts` — pure: `parseComposerCommand`, `LAUNCH_COMMANDS`, `runFooterFor`, `composerFace`.
- `frontend/app/view/agents/composercommand.test.ts` — vitest for the above.

**Modify:**
- `frontend/app/view/agents/channelssurface.tsx` — the transform target (owns chrome + run strip + composer + context panel).
- `frontend/app/view/agents/runssurface.tsx` — extract body sub-components into `runbody.tsx` (or export them); `RunHeader` gets a `hideSteer` prop; `RunsView` retired at the end.
- `frontend/app/view/agents/profilepanel.tsx` — reused behind the ⚙ (verify it exposes `defaultmode`/`defaultplangate` editing; no change expected).

**Reuse unchanged:** `channelrail.tsx`, `runmodel.ts`, `runactions.ts`, `channelactions.ts`, `channelmessages.ts`, `channelsstore.ts`, `channelderive.ts`, `composer-shell.tsx`, `attentioncard.tsx`, `jarviscards.ts`, `jarvisderive.ts`, `element/collapsiblerail.tsx`, `markdownmessage.tsx`.

---

## Phase 1 — Extract `RunBody` (pure refactor, no behavior change)

### Task 1.1: Add a steer-less `RunHeader` variant and extract `RunBody`

**Files:**
- Modify: `frontend/app/view/agents/runssurface.tsx` (`RunHeader` ~364-433; run body branches ~861-909)
- Create: `frontend/app/view/agents/runbody.tsx`

**Interfaces:**
- Produces: `export function RunBody({ model, channel, agents, run }: { model: AgentsViewModel; channel: Channel; agents: AgentVM[]; run: Run }): JSX.Element` — renders exactly the current run body (orchestrator body when `isOrchestrator(run)`, else pipeline body: `RunHeader` + `RunRollup` + `CompactStepper` + `PhaseRail` + Cancel), **with no run strip, no new-run composer, no steer composer, no ProfilePanel.**
- Consumes: the existing private body sub-components from `runssurface.tsx` (`RunHeader`, `RunRollup`, `CompactStepper`, `PhaseRail`, `OrchestratorBody`, `PhaseNode`, `StatusPill`, `PlanPreview`, `ReviewGateCard`, `AskCard`, `BlockedCard`, `StartingCard`, `TriageChip`, `ShipMarker`, `DispatchedAgents`). Move these into `runbody.tsx` and `export` the ones `RunsView` still needs, or re-export from `runssurface.tsx`. Keep their internals byte-for-byte.

**Approach:** Least-churn — move the body sub-components (runssurface.tsx:92-660 range, the private helpers) into `runbody.tsx`, export them, and have `runssurface.tsx` import what it still uses. Add a `hideSteer?: boolean` prop to `RunHeader`; when true it renders the status pill + goal + Cancel/Pause but **omits the steer toggle button and the inline steer `ComposerShell`** (currently runssurface.tsx:404-430). `RunBody` passes `hideSteer` and `steering=false`.

- [ ] **Step 1: Create `runbody.tsx` and move body sub-components into it**

Cut the private components listed above from `runssurface.tsx` into `runbody.tsx`, preserving imports. Export each (`export function PhaseRail(...)`, etc.). In `runssurface.tsx`, add `import { RunHeader, RunRollup, CompactStepper, PhaseRail, OrchestratorBody } from "./runbody";` (only what `RunsView` still references).

- [ ] **Step 2: Add `hideSteer` to `RunHeader`**

In `RunHeader` props add `hideSteer?: boolean;`. Guard the steer toggle button and the inline steer composer block with `{!hideSteer && (...)}`. Default `false` so `RunsView`'s existing behavior is unchanged.

- [ ] **Step 3: Add the `RunBody` export**

In `runbody.tsx`:

```tsx
export function RunBody({ model, channel, agents, run }: {
    model: AgentsViewModel; channel: Channel; agents: AgentVM[]; run: Run;
}) {
    const now = Date.now();
    const liveTabIds = new Set(agents.filter((a) => a.blockId).map((a) => `tab:${a.tabId}`)); // match runssurface's liveTabIds derivation
    if (isOrchestrator(run)) {
        return (
            <OrchestratorBody model={model} channel={channel} agents={agents} run={run}
                now={now} liveTabIds={liveTabIds}
                steering={false} steerDraft="" setSteerDraft={() => {}}
                onSteerToggle={() => {}} onSteerClose={() => {}} />
        );
    }
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <RunHeader run={run} agents={agents} channel={channel} hideSteer
                steering={false} steerDraft="" setSteerDraft={() => {}}
                onSteerToggle={() => {}} onSteerClose={() => {}} />
            {/* RunRollup + CompactStepper + PhaseRail + Cancel — copy the exact JSX from runssurface.tsx:876-909 */}
        </div>
    );
}
```

> The exact liveTabIds derivation, `RunRollup`/`CompactStepper`/`PhaseRail` props, and the Cancel button must match `runssurface.tsx:876-909` verbatim — copy them, don't re-invent. `OrchestratorBody` already tolerates `steering=false` (it just won't show the steer composer).

- [ ] **Step 4: Verify no behavior change — typecheck + build + CDP**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run the dev app, open a channel with a run, confirm the phase rail / orchestrator body renders identically to before (screenshot via `node scripts/cdp-shot.mjs`). `RunsView` still renders its own header steer button (unchanged, since it passes `hideSteer` false).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/runbody.tsx frontend/app/view/agents/runssurface.tsx
git commit -m "refactor(agents): extract RunBody from RunsView"
```

---

## Phase 2 — Pure logic: composer commands + footer + face

### Task 2.1: `composercommand.ts` (TDD)

**Files:**
- Create: `frontend/app/view/agents/composercommand.ts`
- Test: `frontend/app/view/agents/composercommand.test.ts`

**Interfaces:**
- Produces:
  - `export type LaunchMode = "quick" | "run" | "ask";`
  - `export interface ComposerCommand { mode: LaunchMode; runtime?: string; body: string; }`
  - `export function parseComposerCommand(text: string): ComposerCommand`
  - `export const LAUNCH_COMMANDS: { cmd: string; mode: LaunchMode; desc: string }[]`
  - `export function runFooterFor(profile: JarvisProfile | undefined): string`
  - `export function composerFace(run: Run | undefined, agents: AgentVM[]): { face: "launch" } | { face: "talk"; worker: AgentVM }`
- Consumes: `steerTarget` from `./runmodel`; `JarvisProfile`, `Run` (ambient globals); `AgentVM` from `./agentsviewmodel`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { parseComposerCommand, runFooterFor, LAUNCH_COMMANDS } from "./composercommand";

describe("parseComposerCommand", () => {
    it("defaults a bare goal to run", () => {
        expect(parseComposerCommand("fix auth token refresh")).toEqual({ mode: "run", body: "fix auth token refresh" });
    });
    it("parses @quick", () => {
        expect(parseComposerCommand("@quick add a spinner")).toEqual({ mode: "quick", body: "add a spinner" });
    });
    it("parses @run and strips the command", () => {
        expect(parseComposerCommand("@run migrate totals")).toEqual({ mode: "run", body: "migrate totals" });
    });
    it("parses @ask with default runtime", () => {
        expect(parseComposerCommand("@ask where is cart total computed?")).toEqual({ mode: "ask", body: "where is cart total computed?" });
    });
    it("parses @ask <runtime> override", () => {
        expect(parseComposerCommand("@ask codex any coupon validation?")).toEqual({ mode: "ask", runtime: "codex", body: "any coupon validation?" });
    });
    it("does not treat a mid-text @ as a command", () => {
        expect(parseComposerCommand("add @mentions to the composer")).toEqual({ mode: "run", body: "add @mentions to the composer" });
    });
    it("trims the goal", () => {
        expect(parseComposerCommand("  @quick   spin  ")).toEqual({ mode: "quick", body: "spin" });
    });
});

describe("runFooterFor", () => {
    it("orchestrator", () => {
        expect(runFooterFor({ playbook: [], defaultmode: "orchestrator" })).toBe("→ adaptive lead · splits the work · set in ⚙");
    });
    it("pipeline with gate", () => {
        expect(runFooterFor({ playbook: [], defaultmode: "pipeline", defaultplangate: true })).toBe("→ pipeline run · stops at a review gate · set in ⚙");
    });
    it("pipeline no gate", () => {
        expect(runFooterFor({ playbook: [], defaultmode: "pipeline", defaultplangate: false })).toBe("→ pipeline run · no gate · set in ⚙");
    });
    it("undefined profile defaults to pipeline + gate", () => {
        expect(runFooterFor(undefined)).toBe("→ pipeline run · stops at a review gate · set in ⚙");
    });
});

describe("LAUNCH_COMMANDS", () => {
    it("has quick/run/ask in order", () => {
        expect(LAUNCH_COMMANDS.map((c) => c.mode)).toEqual(["quick", "run", "ask"]);
        expect(LAUNCH_COMMANDS.map((c) => c.cmd)).toEqual(["@quick", "@run", "@ask"]);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/composercommand.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `composercommand.ts`**

```ts
import { steerTarget } from "./runmodel";
import type { AgentVM } from "./agentsviewmodel";

export type LaunchMode = "quick" | "run" | "ask";
export interface ComposerCommand { mode: LaunchMode; runtime?: string; body: string; }

export const LAUNCH_COMMANDS: { cmd: string; mode: LaunchMode; desc: string }[] = [
    { cmd: "@quick", mode: "quick", desc: "one worker, no phases" },
    { cmd: "@run", mode: "run", desc: "managed run · channel strategy" },
    { cmd: "@ask", mode: "ask", desc: "one-shot consult · no worker" },
];

const KNOWN_RUNTIMES = new Set(["claude", "codex", "antigravity"]);

export function parseComposerCommand(text: string): ComposerCommand {
    const trimmed = text.trim();
    const m = /^@(quick|run|ask)\b\s*(.*)$/is.exec(trimmed);
    if (!m) {
        return { mode: "run", body: trimmed };
    }
    const mode = m[1].toLowerCase() as LaunchMode;
    let rest = m[2].trim();
    if (mode === "ask") {
        const rm = /^(\w+)\s+(.*)$/s.exec(rest);
        if (rm && KNOWN_RUNTIMES.has(rm[1].toLowerCase())) {
            return { mode, runtime: rm[1].toLowerCase(), body: rm[2].trim() };
        }
    }
    return { mode, body: rest };
}

export function runFooterFor(profile: JarvisProfile | undefined): string {
    if (profile?.defaultmode === "orchestrator") {
        return "→ adaptive lead · splits the work · set in ⚙";
    }
    const gate = profile?.defaultplangate ?? true;
    return gate
        ? "→ pipeline run · stops at a review gate · set in ⚙"
        : "→ pipeline run · no gate · set in ⚙";
}

export function composerFace(run: Run | undefined, agents: AgentVM[]): { face: "launch" } | { face: "talk"; worker: AgentVM } {
    const worker = run ? steerTarget(run, agents) : undefined;
    return worker ? { face: "talk", worker } : { face: "launch" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/composercommand.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/composercommand.ts frontend/app/view/agents/composercommand.test.ts
git commit -m "feat(agents): composer command parser + run footer + face resolution"
```

---

## Phase 3 — Transform the surface: delete chat, single run strip, RunBody

### Task 3.1: Own run selection + run strip + RunBody in `ChannelsSurface`; delete the chat branch

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (toggle 1167-1184; branch 1294-1373; chat rows 141-587; chat `Composer` 589-788; header controls 1186-1291)

**Interfaces:**
- Consumes: `RunBody` (Task 1.1); `defaultRunId`, `resolveActiveRunId`, `phaseProgressDots` from `./runmodel`; `createRun`, `pendingRunDraftAtom` from `./runactions`; `Channel.runs`.

- [ ] **Step 1: Remove the `chat｜runs` toggle and always render runs**

Delete the toggle block (channelssurface.tsx:1167-1184). Delete `view`/`setView` state (964) and the effect that resets it (982-989); the surface is always "runs". Remove the `view === "runs" ? <RunsView/> : <chat>` conditional (1294-1373).

- [ ] **Step 2: Add surface-owned run selection + run strip**

Add local selection mirroring the old `RunsView`:

```tsx
const runs = (active?.runs ?? []).filter((r) => !dismissed.has(r.id));
const [activeRunId, setActiveRunId] = useState<string | undefined>(() => defaultRunId(runs));
useEffect(() => { setActiveRunId((cur) => resolveActiveRunId(runs, cur)); }, [active?.oid, runs.length]);
const run = runs.find((r) => r.id === activeRunId);
```

Build the run strip from the mockup (`Wave-channels-merged.dc.html`, run-strip block): one tab per run (goal, status dot via `phaseProgressDots`/`runStatusView`, a `Q` badge when the run is a quick dispatch), plus a `+ New run` tab that clears `activeRunId` to show the launch composer. Use `@theme` tokens for all colors.

- [ ] **Step 3: Render `RunBody` (or the new-run empty state)**

```tsx
{run ? (
    <RunBody model={model} channel={active} agents={agents} run={run} />
) : (
    /* new-run empty state — port from Wave-channels-merged.dc.html "Start a run in #<channel>" block */
)}
```

- [ ] **Step 4: Delete the chat row components and chat `Composer`**

Remove `ConsultRow` (141), `JarvisRow` (220), `GatekeeperRow` (276), `EscalationRow` (381), `OutcomeRow` (463-504), `MessageRow` (506), `CommandHint` (571), and the chat `Composer` (589-788) — they are unused after Step 1/3. Keep `OptionList`, `useSettle`, `formatUsd`, `consultIdOf`, `jarvisReqIdOf` **only if** still referenced by the Consults panel (Task 5.2); otherwise remove. Remove the now-unused `shownMessages` derivation and chat-only imports.

> `RunsView` is now unused by the surface. Do not delete `runssurface.tsx` yet — Task 6.1 retires it after ProfilePanel is re-homed.

- [ ] **Step 5: Typecheck + CDP verify**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
Dev app: open a channel; confirm the run strip + phase rail render, no chat, no toggle. Screenshot.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(agents): merge channels surface to runs-only (delete chat stream + toggle)"
```

---

## Phase 4 — Header: single autonomy toggle + ⚙

### Task 4.1: Replace the 3-tier control with the `Observing ⟷ Handling asks` toggle

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (tier control 1186-1221; delegator-confirm bar 1222-1253; runMode/planGate control 1254-1291)

**Interfaces:**
- Consumes: `tierFromMeta` from `./channelmessages` (current tier); `setChannelTier` from `./channelsstore`; `ProfilePanel` from `./profilepanel`.

- [ ] **Step 1: Remove the three header controls**

Delete the 3-segment tier control (1186-1221), the delegator-confirm inline bar (1222-1253), and the `pipeline|orchestrator` + plan-gate control (1254-1291). Remove `confirmDelegator` state and `runMode`/`planGate` header state if no longer used elsewhere (the strategy now lives only in ⚙).

- [ ] **Step 2: Add the autonomy toggle**

Port the toggle from the mockup (header block). Current state: `const on = tierFromMeta(active?.meta) !== "concierge";` (gatekeeper or delegator both read as "on"). On click:

```tsx
const toggleAutonomy = () => {
    if (!active) return;
    const next = on ? "concierge" : "gatekeeper";
    const mode = (active.meta?.["delegator:mode"] as string) ?? "report";
    fireAndForget(() => setChannelTier(active.oid, next, mode));
};
```

Labels/tooltips: `on` → "Handling asks" / "Jarvis auto-answers routine asks and escalates real forks to you."; `off` → "Observing" / "Jarvis stays hands-off; every worker ask routes to you." (Copy verbatim from the mockup.) Colors via `@theme` tokens.

- [ ] **Step 3: Add the ⚙ button → ProfilePanel drawer**

Add a `⚙` icon button in the header opening `ProfilePanel` (channel `defaultmode`/`defaultplangate` live here now). Render `ProfilePanel` in a right-hand drawer/modal (reuse `ModalShell` or a `CollapsibleRail` extra-icon pattern). Confirm `ProfilePanel` writes via `setChannelProfile(channelId, override)` — read `frontend/app/view/agents/profilepanel.tsx` first; if it only edited principles/playbook, add `defaultmode`/`defaultplangate` controls there (a select + checkbox) wired to `setChannelProfile`.

- [ ] **Step 4: Typecheck + CDP verify**

`node --stack-size=4000 …/tsc.js --noEmit` → 0. Dev app: toggle flips label + persists (reopen channel); ⚙ opens the profile drawer. Screenshot both states.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/channelssurface.tsx frontend/app/view/agents/profilepanel.tsx
git commit -m "feat(agents): single autonomy toggle + profile behind gear"
```

---

## Phase 5 — The two-face composer

### Task 5.1: Build the unified composer (Launch + Talk) with `@`-command autocomplete

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (add the bottom composer; extend `send`)

**Interfaces:**
- Consumes: `parseComposerCommand`, `runFooterFor`, `composerFace`, `LAUNCH_COMMANDS` (Task 2.1); `activeMentionQuery` from `./channelderive`; `ComposerShell` from `./composer-shell`; `sendChannelMessage`, `steerWorker` from `./channelactions`; `createRun`, `getJarvisProfile` from `./runactions`.

- [ ] **Step 1: Fetch the channel's profile on channel change**

```tsx
const [profile, setProfile] = useState<JarvisProfile | undefined>(undefined);
useEffect(() => {
    if (!active) { setProfile(undefined); return; }
    let live = true;
    getJarvisProfile(active.oid).then((r) => { if (live) setProfile(r.resolved); }).catch(() => {});
    return () => { live = false; };
}, [active?.oid]);
```

- [ ] **Step 2: Compute the composer face**

```tsx
const face = composerFace(run, agents); // { face: "launch" } | { face: "talk"; worker }
```

- [ ] **Step 3: Build the Launch face**

A single `ComposerShell` at the bottom (max-width column). Its `inputRegion` is a controlled `textarea` (reuse the highlight-backdrop pattern from the old chat `Composer` if wanted, else plain). `overlay` = the `@`-command autocomplete: on caret change, `const q = activeMentionQuery(value, caret);` show the popover **only when `q && q.start === 0`** (a leading `@` token — mid-text `@` is not a command). Filter `LAUNCH_COMMANDS` by `c.cmd.startsWith("@" + q.query)`; accept inserts `"<cmd> "` at position 0. Footer: when the parsed/selected mode is `run`, show `runFooterFor(profile)`; for `quick` show "→ spawns one worker in #<channel>"; for `ask` show "→ no worker · answer lands in Consults". Placeholder `Give Jarvis a goal…`. `sendLabel` "Run ⏎" (or "Ask" for ask mode).

- [ ] **Step 4: Build the Talk face**

When `face.face === "talk"`: render `ComposerShell` addressed to `face.worker` — a small header chip (worker name + "live" + phase) and a `+ New run` button that clears `activeRunId` (breaks back to Launch). Placeholder `Message <worker.name>…`, `sendLabel` "Send ⏎", **no command autocomplete.** Footer: "→ injected as a follow-up turn to <worker.name>".

- [ ] **Step 5: Extend `send` to route by face + command**

```tsx
const send = () => {
    const text = draft.trim();
    if (!text || !active) return;
    setDraft("");
    if (face.face === "talk") {
        fireAndForget(() => steerWorker({ channelId: active.oid, workerORef: `tab:${face.worker.tabId}`, agents, text }));
        return;
    }
    const cmd = parseComposerCommand(text);
    if (cmd.mode === "run") {
        fireAndForget(() => createRun(active.oid, cmd.body, { mode: profile?.defaultmode, planGate: profile?.defaultplangate }));
        return;
    }
    const transport = cmd.mode === "quick"
        ? `@${cmd.runtime ?? "claude"} ${cmd.body}`
        : `ask @${cmd.runtime ?? "claude"} ${cmd.body}`;
    fireAndForget(() => sendChannelMessage({
        model, channelId: active.oid, projectPath: active.projectpath ?? "",
        projectName: active.name ?? "agent", roster, agents, text: transport,
    }));
};
```

> This mirrors the `Ctrl+P` palette deps exactly (dispatch → `@runtime goal`, run → `createRun`, consult → `ask @runtime goal`), so the two launchers stay consistent (decision #12). Verify `face.worker.tabId` is the correct field for the `tab:` oref (`steerWorker` requires a `tab:`-prefixed `workerORef`; cross-check against `runmodel.steerTarget`/`phaseWorkers` which key on `oref.slice(4)`).

- [ ] **Step 6: Typecheck + CDP verify**

`tsc` → 0. Dev app: (a) new-run → type "fix X" → Enter launches a Run; (b) type `@` → menu shows quick/run/ask; `@quick fix` launches a worker; `@ask codex q` posts a consult; (c) select a run with a live worker → composer flips to Talk; typing + Enter steers it. Screenshot each.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(agents): two-face composer with @quick/@run/@ask commands"
```

---

## Phase 6 — Re-home capabilities: overview strip + context panel

### Task 6.1: Collapsible overview strip (Jarvis summary + notes)

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (add strip below header)
- Create/append: `docs/deferred.md` (notes backend gap)

**Interfaces:**
- Consumes: `RpcApi.JarvisCommand` (stream, via `TabRpcClient`); `buildFleetSnapshot`, `buildJarvisPrompt` from `./jarvisderive`; `consultStreamsAtom`/`setConsultStream` from `./channelsstore` for streaming.

- [ ] **Step 1: Build the collapsible strip, collapsed by default**

Port from the mockup "Overview & notes" block: a caret + one-line summary when collapsed (e.g. `Overview & notes · N runs`). When open, two columns: **Channel notes** (left) and **Jarvis summary** (right, labelled "Jarvis summary" per decision #14).

- [ ] **Step 2: Wire the Jarvis summary button**

Reproduce the summary path from `sendChannelMessage`'s jarvis branch (channelactions.ts:113-149): build the fleet snapshot, stream `RpcApi.JarvisCommand` chunks into `consultStreamsAtom` (or local state), render the streamed markdown via `markdownmessage.tsx`. Not gated by the autonomy toggle.

- [ ] **Step 3: Notes — render read-only placeholder + log the gap**

`Channel` has no notes field and there is no set-notes RPC (backend out of scope). Render the notes area as a **disabled placeholder** ("Channel notes — coming soon") so the UI is honest, and append to `docs/deferred.md`:

```markdown
## Channel notes (merged surface)
The merged Channels surface shows a "Channel notes" area, but `waveobj.Channel` has no notes field
and no set-notes RPC exists. v1 renders it disabled. Backend follow-up: add `Channel.meta["channel:notes"]`
(or a dedicated field) + a `SetChannelNotesCommand`, then wire the textarea.
```

- [ ] **Step 4: Typecheck + CDP verify + commit**

`tsc` → 0. Dev app: expand strip, run Jarvis summary → streamed text; notes disabled. Screenshot.

```bash
git add frontend/app/view/agents/channelssurface.tsx docs/deferred.md
git commit -m "feat(agents): overview strip with Jarvis summary (notes deferred)"
```

### Task 6.2: Context panel — Needs you / Consults / Fleet here

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`ContextPanel`, 793-947)

**Interfaces:**
- Consumes: `pendingAsks`, `escalationPending`, `fleetCounts` from `./jarviscards`; `buildFleetSnapshot` from `./jarvisderive`; `reviewGate` from `./runmodel`; `AttentionCard`/`AttentionBanner` from `./attentioncard`; `CollapsibleRail`/`RailSection` from `@/app/element/collapsiblerail`.

- [ ] **Step 1: Unify "Needs you"**

Build one attention list = live-worker asks (`pendingAsks(buildFleetSnapshot(active, agents), active.messages ?? [])`) + Jarvis escalations + **review gates** (`reviewGate(run)` across `active.runs`). Render with `AttentionCard`/`AttentionBanner`; each item's click selects the owning run (`setActiveRunId`). Count badge = list length. Empty state: "All clear — Jarvis is handling routine asks."

- [ ] **Step 2: Consults section**

Render consult results from `active.messages` (kind `"consult"`, `reforef: "consult:<id>"`) + live text from `consultStreamsAtom`. Each card: runtime chip + question + streamed answer + a "Dispatch ↗" button that promotes the consult to a run (`createRun(active.oid, question, { mode: profile?.defaultmode, planGate: profile?.defaultplangate })`). Reuse the old `ConsultRow` internals if retained; otherwise a compact card.

- [ ] **Step 3: Fleet here**

Keep the existing "fleet" `RailSection` (`buildFleetSnapshot` + `fleetCounts`) — label "Fleet here" (decision #14). Header shows `N working · M waiting`.

- [ ] **Step 4: Typecheck + CDP verify + commit**

`tsc` → 0. Dev app: gate/escalation/ask all appear under Needs you; consult cards render + dispatch; fleet roster shows. Screenshot.

```bash
git add frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(agents): context panel — unified Needs you, Consults, Fleet here"
```

---

## Phase 7 — Retire `RunsView` + final cleanup

### Task 7.1: Remove the now-dead `RunsView` shell

**Files:**
- Modify/Delete: `frontend/app/view/agents/runssurface.tsx`

- [ ] **Step 1: Confirm `RunsView` is unimported**

Run: `grep -rn "RunsView\|runssurface" frontend --include=*.ts --include=*.tsx` (via Grep). Expected: only `runssurface.tsx` itself (and its moved-out re-exports).

- [ ] **Step 2: Delete `RunsView` and its now-unused shell code**

Remove `RunsView` (the run strip, new-run composer, ProfilePanel column). Any body sub-components moved to `runbody.tsx` in Task 1.1 stay there. If nothing remains in `runssurface.tsx`, delete the file and fix imports.

- [ ] **Step 3: Full typecheck + vitest + CDP smoke**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → 0.
Run: `npx vitest run frontend/app/view/agents/` → all pass.
Dev app: full walk (launch each mode, steer, gate approve, Jarvis summary, autonomy toggle). Screenshots.

- [ ] **Step 4: Commit**

```bash
git add -A frontend/app/view/agents/
git commit -m "refactor(agents): retire RunsView shell after merge"
```

---

## Self-Review (spec coverage)

- **§3.1 channel rail keep** → unchanged (reused). ✔
- **§3.2 header + autonomy toggle → SetChannelTierCommand gatekeeper/concierge + ⚙** → Task 4.1. ✔
- **§3.3 overview/notes strip (Jarvis summary)** → Task 6.1 (notes deferred, logged). ✔ (gap surfaced, not hidden)
- **§3.4 single run strip** → Task 3.1 Step 2. ✔
- **§3.5 extract RunBody (not reuse RunsView whole)** → Task 1.1; retire in 7.1. ✔
- **§3.6 two-face composer + `@`-commands** → Task 2.1 (logic) + Task 5.1 (UI). ✔
- **§3.7 context panel Needs you/Consults/Fleet here** → Task 6.2. ✔
- **§4 capability re-homing** → consult→Consults (6.2), dispatch→`@quick` (5.1), autonomy→toggle (4.1), notes/summary→overview (6.1). ✔
- **§5 removals** (chat stream, toggle, `@runtime` mentions, Steer-as-verb, 3-tier control) → Tasks 3.1 + 4.1 + 5.1. ✔
- **Decision #11 modes / #12 commands / #13 no-nav-change / #14 Jarvis summary** → covered. ✔
- **Deferred:** true one-phase Quick backend Run mode (Quick still = dispatch path); channel-notes backend field. Logged. ✔

---

## Execution Handoff

Two options:
1. **Subagent-Driven (recommended)** — one fresh subagent per task, review between tasks. Best here: several tasks are large component edits that benefit from a clean context each. Phase 1 (RunBody extraction) and Phase 3 (surface transform) are the risk points — review those diffs closely.
2. **Inline Execution** — batch with checkpoints.

**Note on ordering:** Phases 1→7 are strictly ordered (each depends on the previous). Phase 2 (pure logic) is the only one that can be done out of order / in parallel with Phase 1.
