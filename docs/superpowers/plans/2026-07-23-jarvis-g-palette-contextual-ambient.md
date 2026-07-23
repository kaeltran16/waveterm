# Jarvis G — Plan 4: Ctrl+P "Ask Jarvis" + quick-ask handoff + contextual entries + ambient + real citation navigation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver sub-project G's remaining entry points — a `Ctrl+P` "Ask Jarvis" lead group that hands a typed question off into the Jarvis surface, small "Ask Jarvis about this" contextual actions on Run/Radar/Memory, fixture-driven ambient attribution on those surfaces, and real click-through navigation from `[n]` citations / grounding cards into the native object's surface.

**Architecture:** Pure frontend; no Go/wshrpc change. The palette "ask" is a builder mirroring `palette-launch.ts` whose `run()` reuses the existing `startConversation` + `submitJarvisQuery` module-scope streaming (the answer streams in the Jarvis surface, not inline in the palette — the palette is a list-of-actions overlay with no inline-render capability). Citation navigation is a small total `orefNavPlan` classifier + an `openORef(model, oref)` dispatcher covering the sourceTypes with a clean focus path today (`channel`, `run`, `agent`); other types no-op deliberately. Contextual entries build a `SourceRef`, `startConversation` in an `attached` scope, and switch to the Jarvis surface — the same producer→consumer handoff direction as Plan 3's `channelactions` `@jarvis` handoff. Ambient attribution is a provider seam (`AmbientProvider`) with a deterministic fixture implementation, owned by `view/agents/` so it adds no `agents → jarvis` coupling.

**Tech Stack:** React 19 + jotai, Vitest, the repo's CDP scenario harness (`scripts/cdp/`), Tailwind 4 `@theme` tokens. No Go, no `task generate`.

**This is Plan 4 of 4 for sub-project G** (see the [G spec](../specs/2026-07-23-jarvis-ui-surface-design.md) §9 steps 5–6, §"Palette lead group · contextual entries · ambient", and §"The 12 states"):
- Plan 1 (done): surface shell + G⇄F conversation contract + surface states on fixtures.
- Plan 2 (done): backend shim `JarvisConverseCommand` + wire Recall mode to real SQLite.
- Plan 3 (done): fleet-manager migration into Fleet mode + Channels removal + `@jarvis` reroute.
- **Plan 4 (this):** Ctrl+P "ask-jarvis" lead group + quick-ask states (8–10) + contextual entries (state 11 real) + ambient fixtures + real `[n]`/card navigation. Completes G's internal decomposition.

## Decisions made (confirmed with the human before writing — open to revision at plan review)

These diverge from the G spec's literal wording; they were confirmed after a full dependency trace of the shipped Plan 1–3 code.

1. **Quick-ask (state 9) hands off to the surface; no inline palette streaming.** The command palette (`command-palette.tsx`) is architecturally a list of `run()`-and-dismiss items with **no** inline/streamed content rendering — every existing dispatch "surfaces the result, then closes." The G spec's "compact cited-answer renders inline in the palette" would be net-new overlay capability (streaming subscription + compact renderer + result state). Decision: the ask-jarvis `run()` starts a real conversation and opens the Jarvis surface, where the cited answer streams (states 9/grounded render in the surface). This matches every existing palette dispatch and the contract's own handoff-payload design. State 8 (composing) is the palette input; state 10 (continued into full surface) is the landing.
2. **Citation/card navigation covers `channel` + `run` + `agent`; other sourceTypes no-op.** There is no generic oref router in the codebase. Only `channel` (`selectChannel`), `run` (`pendingRunFocusAtom` via the run's `channeloid`), and `agent` (`model.openTerminal`) have a clean per-object focus path today. `memory` would need a new pending-focus atom + `MemorySurface` consumption; `radar` has no per-finding oref focus at all; `decision`/`commit`/`task` have no surface. Decision: ship `openORef` for the clean-today types and no-op (never error) for the rest. The `openORef` seam is the durable part; later cycles extend it.
3. **Ambient attribution is a fixture provider owned by `view/agents/`, with deterministic placeholder data.** The real edges come from attribution engine D (v2). The provider (`AmbientProvider`) is the durable seam; the fixture keys off the oref hash so dev/CDP shows believable placeholder tags on real rows. Ambient lives in `view/agents/` (it decorates agents surfaces and needs no jarvis dependency), keeping the `agents → jarvis` boundary clean. Placeholder data is recorded in `docs/deferred.md`.
4. **Radar finding `SourceRef` oref = `radar:<finding.id>`.** A `RadarFinding` is a sub-object of `RadarReport` (a WaveObj), so it has no `makeORef` convention. `radar:<finding.id>` matches its `sourceType:"radar"` and the `memory:<id>` convention already attested in `recallderive.test.ts`. It is used as an attachment/`SourceRef` only (radar click-through nav is deferred per decision 2), so no report-resolution is needed this cycle.

## What this plan deliberately does NOT do

- **No backend change.** No new wshrpc command, no `task generate`. If you find yourself editing Go, stop — you've misread the plan.
- **No inline result rendering in the command palette** (decision 1). The palette stays list-of-actions; results render in the Jarvis surface.
- **No `memory`/`radar`/`decision`/`commit`/`task` citation navigation** (decision 2). Those clicks no-op. No new `MemorySurface`/`RadarSurface` focus plumbing.
- **No `@jarvis` channel-composer trigger.** Plan 3 rerouted the `@jarvis` *summary* handoff, but per the `scenarios.mjs` note (lines 192–197) the live trigger (a `@jarvis`-classified channel message) has no composer entry point. Wiring that trigger is a Channels-composer concern, **out of scope here** — Plan 4's live entry point is the Ctrl+P ask-jarvis group (which drives the *recall* path, not the fleet-summary handoff).
- **No Tasks surface.** Ambient "task tags" are non-interactive placeholder chips; there is no Tasks destination to open (v2).
- **No composer model-picker; no light mode; no second command palette or new global shortcut** (invariants).

## Global Constraints

Every task's requirements implicitly include these. Values copied verbatim from CLAUDE.md, the G spec, Plan 3, and the codebase.

- **Dependency-direction rule (extended from Plan 3).** `view/jarvis/` may import from `view/agents/` (shared domain, channelsstore, primitives, run/radar/memory types). `view/agents/` must **not** import from `view/jarvis/` **except sanctioned producer→consumer handoffs** (a Channels/Run/Radar/Memory surface handing off *to* Jarvis). After Plan 4 the guard `grep -rn 'from "@/app/view/jarvis\|from "\.\./jarvis\|view/jarvis' frontend/app/view/agents` must show **exactly these**: `channelactions.ts` (Plan 3 `@jarvis` handoff), `cockpitshell.tsx` (renders `<JarvisSurface>` — the shell surface router, pre-existing), and the three Plan 4 contextual-entry imports in `runbody.tsx`, `radarfindingdetail.tsx`, `memorysurface.tsx`. Any *other* hit is a leak. Ambient (`view/agents/ambient*`) must add **no** `agents → jarvis` import.
- **Surface unmounts on nav-switch** (only the agent surface stays mounted). Every survive-worthy value lives in a module atom written via `globalStore.set`, never component `useState`. The quick-ask conversation and contextual-entry state already flow through `jarvisstore`'s module atoms (`conversationsByIdAtom`, `activeConversationIdAtom`, `jarvisModeAtom`, `jarvisDraftAtom`) — reuse them.
- **Reuse existing recall plumbing unchanged.** `startConversation(scope): string`, `submitJarvisQuery(convId, text)`, and the atoms above (`jarvisstore.ts`). The backend is the Plan 2 `JarvisConverseCommand` shim, reached only through `submitJarvisQuery` — do not call the RPC directly from the palette or a surface.
- **Model access is by prop.** Components receive `model: AgentsViewModel` as a prop (no hook/context). `model.surfaceAtom` (`agents.tsx:74`), `model.openTerminal(agentId)` (`agents.tsx:147`), `model.paletteOpenAtom`. `SurfaceKey` values include `"jarvis"`, `"channels"`, `"agent"` (`agents.tsx:29–39`).
- **ORef format** is `"<otype>:<oid>"` (single colon). `WOS.makeORef(otype, oid)` returns `null` on blank input (`wos.ts:51`); `WOS.splitORef` **throws** on malformed input (`wos.ts:25`) — do not use it in a total classifier; parse by hand.
- **Dark mode only; `@theme` tokens** (`frontend/tailwindsetup.css`) — never raw hex; existing cockpit fonts; restrained motion. New markup reuses the same token classes as the surrounding code (`text-primary`/`text-muted`/`text-secondary`/`text-accent-soft`/`border-border`/`border-edge-mid`/`bg-surface`/`bg-accentbg`, etc.).
- **No jsdom render tests** (standing decision). Pure logic → Vitest; rendering/wiring → CDP `verify:ui`. Preserve every existing Plan 1–3 CDP scenario.
- **Typecheck (FE)** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` overflows). Baseline is clean; any error it reports is yours.
- **Vitest single file:** `node node_modules/vitest/vitest.mjs run frontend/app/view/<path>.test.ts`. Full FE suite: `node node_modules/vitest/vitest.mjs run`.
- **Git (per CLAUDE.md):** commits need explicit human approval and are batched — do NOT auto-commit or push. Each task's final step is **"stage + checkpoint for review."** This plan doc folds into the one feature commit at the end (never a docs-only commit).
- **`prettier --write` gotcha:** never run it on `scripts/cdp/*.mjs` (`.editorconfig` omits `.mjs` → 2-space reindent). Hand-match 4-space style.
- **HMR-after-`git mv` gotcha:** this plan has no `git mv`, but if the dev app is running when new files land, a hard `location.reload()` may be needed before CDP verify (see the `hmr-blank-after-git-mv` note). No file moves here, so risk is low.

## File Structure

**New** (`frontend/app/view/jarvis/`):

| File | Responsibility |
|---|---|
| `openref.ts` | `orefNavPlan(oref)` (pure, total classifier) + `openORef(model, oref)` (async dispatcher: `channel`/`run`/`agent` open their native surface; others no-op). Imports `selectChannel`/`runAtom` (`../agents/channelsstore`), `pendingRunFocusAtom` (`../agents/runactions`), `WOS` — all `jarvis → agents`, allowed. |
| `openref.test.ts` | Unit tests for `orefNavPlan` routing (channel/run/agent/unsupported/malformed). |
| `contextualentry.tsx` | `sourceRefForRun/Radar/Memory` (pure) + `attachedScope(ref)` (pure) + `suggestedPrompt(sourceType)` (pure) + `openJarvisWithSource(model, ref)` + the `<AskJarvisButton>` component. Imported by the three agents surfaces as sanctioned handoffs. |
| `contextualentry.test.ts` | Unit tests for the `sourceRef*` builders + `attachedScope`. |

**New** (`frontend/app/cockpit/`):

| File | Responsibility |
|---|---|
| `palette-ask.ts` | `buildAskItems(goal, deps): AskItem[]` — pure builder mirroring `palette-launch.ts`; empty goal → `[]`, else one rich ask row whose `run()` calls the injected `deps.ask(question)`. |
| `palette-ask.test.ts` | Unit tests for `buildAskItems` (empty vs non-empty goal, field shape, `run()` calls dep). |

**New** (`frontend/app/view/agents/`):

| File | Responsibility |
|---|---|
| `ambient.ts` | `AmbientProvider` interface + `AmbientTag`/`AmbientDecision` types + `fixtureAmbientProvider` (deterministic placeholder, keyed off oref hash). Agents-owned; no jarvis import. |
| `ambient.test.ts` | Unit tests for `fixtureAmbientProvider` determinism + empty-oref guard. |
| `ambientviews.tsx` | `<AmbientTags oref>` (chips) + `<RelevantDecisions oref>` (inline cards) reading `fixtureAmbientProvider`. Agents-owned. |

**Modified:**

| File | Change |
|---|---|
| `frontend/app/view/jarvis/jarvissurface.tsx` | Thread `model` into `<ConversationView>` and `<GroundingRail>`. |
| `frontend/app/view/jarvis/conversationview.tsx` | Accept `model`; replace the `[n]` `console.log` stub with `openORef(model, card.navTarget)`. |
| `frontend/app/view/jarvis/groundingrail.tsx` | Accept `model`; replace the card `console.log` stub with `openORef(model, card.navTarget)`. |
| `frontend/app/cockpit/command-palette.tsx` | Add `"ask-jarvis"` to `PaletteKind`; build ask items from `launchGoal`; inject the ask lead group in the `default` scope branch; add the lead-block render arm; wire `deps.ask`. |
| `frontend/app/view/agents/runbody.tsx` | Thread `model` into `RunHeader`; add `<AskJarvisButton>` (contextual) + `<AmbientTags>` in the header, `<RelevantDecisions>` in the body. |
| `frontend/app/view/agents/radarfindingdetail.tsx` | Add `<AskJarvisButton>` in the actions block + `<AmbientTags>`/`<RelevantDecisions>`. |
| `frontend/app/view/agents/radarfindingslist.tsx` | Add `<AmbientTags>` to the finding row footer. |
| `frontend/app/view/agents/memorysurface.tsx` | Thread `model` into `DetailBody`; add `<AskJarvisButton>` + `<AmbientTags>`/`<RelevantDecisions>`; `<AmbientTags>` on list rows. |
| `frontend/app/view/agents/channelchrome.tsx` | `RunStrip`: add `<AmbientTags>` to each run row. |
| `scripts/cdp/scenarios.mjs` | Add `jarvis-ask` (palette handoff) + `jarvis-ambient` scenarios; extend `jarvis-states` with a citation-click smoke. |
| `docs/superpowers/specs/2026-07-23-jarvis-ui-surface-design.md` | §9 steps 5–6 → done. |
| `docs/superpowers/specs/2026-07-23-jarvis-second-brain-meta-spec.md` | Tracking table: add P4 to G's Plan cell. |
| `docs/deferred.md` | Record the ambient placeholder-data fabrication. |

**Unchanged (verify, don't touch):** `jarviscontract.ts`, `recallderive.ts`, `jarvisstore.ts` (its exports are reused, not modified), `jarvisfixtures.ts`, `composer.tsx`, `fleetmode.tsx`, `palette-launch.ts` (mirrored, not edited), `channelmessages.ts`.

---

### Task 1: Real `[n]` / grounding-card navigation (`openORef`)

Replace the two `console.log("[jarvis] open source", …)` stubs with real navigation for the sourceTypes that have a clean focus path (`channel`/`run`/`agent`); other types no-op. The correctness lives in a pure, total classifier (`orefNavPlan`); the dispatcher (`openORef`) performs the side effects. Independent of the palette and contextual work — a good first slice.

**Files:**
- Create: `frontend/app/view/jarvis/openref.ts`, `frontend/app/view/jarvis/openref.test.ts`
- Modify: `frontend/app/view/jarvis/jarvissurface.tsx`, `frontend/app/view/jarvis/conversationview.tsx`, `frontend/app/view/jarvis/groundingrail.tsx`

**Interfaces:**
- Produces: `orefNavPlan(oref: string): OrefNav` and `openORef(model: AgentsViewModel, oref: string): Promise<void>`.
- Consumes: `selectChannel` + `runAtom` (`../agents/channelsstore`), `pendingRunFocusAtom` (`../agents/runactions`), `WOS.makeORef`/`WOS.loadAndPinWaveObject` (`@/app/store/wos`), `globalStore` (`@/app/store/global`), `AgentsViewModel` (`../agents/agents`).

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/openref.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { orefNavPlan } from "./openref";

describe("orefNavPlan", () => {
    it("routes channel/run/agent to their kinds", () => {
        expect(orefNavPlan("channel:abc")).toEqual({ kind: "channel", oid: "abc" });
        expect(orefNavPlan("run:11111111-1111-1111-1111-111111111111")).toEqual({
            kind: "run",
            oid: "11111111-1111-1111-1111-111111111111",
        });
        expect(orefNavPlan("agent:a1")).toEqual({ kind: "agent", oid: "a1" });
    });
    it("marks types with no clean focus path as unsupported (no throw)", () => {
        for (const ot of ["memory", "radar", "decision", "commit", "task", "session"]) {
            expect(orefNavPlan(`${ot}:x`)).toEqual({ kind: "unsupported", otype: ot });
        }
    });
    it("is total on malformed input (never throws)", () => {
        expect(orefNavPlan("").kind).toBe("unsupported");
        expect(orefNavPlan("nope").kind).toBe("unsupported");
        expect(orefNavPlan("run:").kind).toBe("unsupported");
        expect(orefNavPlan(":x").kind).toBe("unsupported");
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis/openref.test.ts`
Expected: FAIL — cannot resolve `./openref`.

- [ ] **Step 3: Write `openref.ts`**

Create `frontend/app/view/jarvis/openref.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Open a Jarvis grounding source (an oref) in its native cockpit surface. There is no generic oref router
// in the app; navigation is per-surface (a pending-focus atom + a surfaceAtom flip). Plan 4 covers the
// sourceTypes with a clean focus path today — channel / run / agent — and no-ops for the rest (memory and
// radar need new per-object focus plumbing; decision/commit/task have no surface). orefNavPlan is a pure,
// total classifier (never throws); openORef performs the side effects.

import { globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import type { AgentsViewModel } from "../agents/agents";
import { runAtom, selectChannel } from "../agents/channelsstore";
import { pendingRunFocusAtom } from "../agents/runactions";

export type OrefNav =
    | { kind: "channel"; oid: string }
    | { kind: "run"; oid: string }
    | { kind: "agent"; oid: string }
    | { kind: "unsupported"; otype: string };

// pure + total: classify an oref into a nav plan. Malformed input or an unroutable otype => unsupported.
export function orefNavPlan(oref: string): OrefNav {
    const parts = (oref ?? "").split(":");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
        return { kind: "unsupported", otype: parts[0] ?? "" };
    }
    const [otype, oid] = parts;
    if (otype === "channel" || otype === "run" || otype === "agent") {
        return { kind: otype, oid };
    }
    return { kind: "unsupported", otype };
}

// impure: open the oref in its native surface. Unsupported kinds are a deliberate no-op (never an error).
export async function openORef(model: AgentsViewModel, oref: string): Promise<void> {
    const plan = orefNavPlan(oref);
    if (plan.kind === "channel") {
        await selectChannel(plan.oid);
        globalStore.set(model.surfaceAtom, "channels");
        return;
    }
    if (plan.kind === "run") {
        const ref = WOS.makeORef("run", plan.oid);
        if (!ref) {
            return;
        }
        await WOS.loadAndPinWaveObject(ref);
        const run = globalStore.get(runAtom(plan.oid));
        if (run?.channeloid) {
            globalStore.set(pendingRunFocusAtom, { channelId: run.channeloid, runId: plan.oid });
            globalStore.set(model.surfaceAtom, "channels");
        }
        return;
    }
    if (plan.kind === "agent") {
        model.openTerminal(plan.oid);
    }
}
```

> Verify while writing: `runAtom` is exported from `channelsstore.ts` (~line 45, `WOS.getWaveObjectAtom<Run>(WOS.makeORef("run", runId))`); `pendingRunFocusAtom` from `runactions.ts` (~line 24); `selectChannel` from `channelsstore.ts` (~line 93). `Run.channeloid` is optional (`gotypes.d.ts`). If `loadAndPinWaveObject` returns the object directly you may read it from the return value instead of re-reading `runAtom` — either is fine; keep whichever typechecks cleanly.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis/openref.test.ts`
Expected: PASS (all three `describe` cases).

- [ ] **Step 5: Thread `model` and replace the two stubs**

In `frontend/app/view/jarvis/jarvissurface.tsx`:
- `<ConversationView conversation={conv} />` → `<ConversationView conversation={conv} model={model} />`
- `<GroundingRail conversation={conv} />` → `<GroundingRail conversation={conv} model={model} />`

In `frontend/app/view/jarvis/conversationview.tsx`:
- add imports: `import type { AgentsViewModel } from "@/app/view/agents/agents";` and `import { openORef } from "./openref";`
- change `Answer`'s signature to receive `model` and thread it from `ConversationView`. `ConversationView({ conversation })` → `ConversationView({ conversation, model }: { conversation: JarvisConversation; model: AgentsViewModel })`; pass `model` into each `<Answer turn={turn} model={model} />`; `Answer({ turn })` → `Answer({ turn, model }: { turn: JarvisAnswerTurn; model: AgentsViewModel })`.
- replace the citation button's `onClick`:
  `onClick={() => card && console.log("[jarvis] open source", card.navTarget)}` → `onClick={() => { if (card) void openORef(model, card.navTarget); }}`

In `frontend/app/view/jarvis/groundingrail.tsx`:
- add imports: `import type { AgentsViewModel } from "@/app/view/agents/agents";` and `import { openORef } from "./openref";`
- change `Card`'s signature to receive `model`: `Card({ card })` → `Card({ card, model }: { card: GroundingCard; model: AgentsViewModel })`; `GroundingRail({ conversation })` → `GroundingRail({ conversation, model }: { conversation: JarvisConversation; model: AgentsViewModel })`; pass `model` into each `<Card key={c.n} card={c} model={model} />`.
- replace the card's `onClick`:
  `onClick={() => console.log("[jarvis] open source", card.navTarget)}` → `onClick={() => void openORef(model, card.navTarget)}`

- [ ] **Step 6: Dependency guard + typecheck**

```bash
grep -rn 'from "@/app/view/jarvis\|from "\.\./jarvis\|view/jarvis' frontend/app/view/agents
```
Expected: still only `channelactions.ts` + `cockpitshell.tsx` (Task 1 adds no `agents → jarvis` import — `openref.ts` imports `agents → ` the other way).

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```
Expected: exit 0.

- [ ] **Step 7: CDP smoke — clicking a citation does not crash**

Extend the `jarvisStates` scenario in `scripts/cdp/scenarios.mjs`: after rendering the `grounded` fixture, click the first grounding card and the first inline `[n]` button, then assert no uncaught error and the surface is still coherent (the fixture's fake `run:0000…` id has no live run, so nav no-ops cleanly — the assertion is "click handler wired, no throw"). Add near the end of `jarvisStates.assert`, before the fixture loop's teardown:

```js
        // Plan 4: citation/card click is wired to openORef (real nav for channel/run/agent; fake fixture
        // ids no-op cleanly). Assert the click path runs without throwing.
        await h.ev(`(() => {
            const b = [...document.querySelectorAll('[data-fixture]')].find((x) => x.getAttribute('data-fixture') === 'grounded');
            if (b) b.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 200))");
        const clickOk = await h.ev(`(() => {
            const card = document.querySelector('button[class*="rounded-[10px]"]');
            const cite = [...document.querySelectorAll('p button')].find((x) => /^\\d+$/.test((x.textContent||'').trim()));
            try { card && card.click(); cite && cite.click(); return true; } catch (e) { return String(e); }
        })()`);
        steps.push({ step: "citation/card click runs without throwing", ok: clickOk === true, detail: String(clickOk) });
```

Hand-match 4-space style. Run `task verify:ui -- jarvis-states`; expected PASS.

> If the selector for the card/citation button proves brittle in the live DOM, prefer a `data-testid` you add to the card/citation buttons in Step 5 over a class-substring match — a stable hook is worth the two extra attributes.

- [ ] **Step 8: Stage + checkpoint** (`git add` the new + modified files; do not commit).

---

### Task 2: `Ctrl+P` "Ask Jarvis" lead group + handoff (states 8, 10)

Add a palette lead group that turns the typed goal into a recall conversation and opens the Jarvis surface. Mirrors `palette-launch.ts` (pure builder + injected deps); the impure handoff is wired in `command-palette.tsx`.

**Files:**
- Create: `frontend/app/cockpit/palette-ask.ts`, `frontend/app/cockpit/palette-ask.test.ts`
- Modify: `frontend/app/cockpit/command-palette.tsx`

**Interfaces:**
- Produces: `buildAskItems(goal: string, deps: AskDeps): AskItem[]`, `interface AskItem { key; glyph; mode; desc; footer; run }`, `interface AskDeps { ask: (question: string) => void }`.
- Consumes (in `command-palette.tsx`): `startConversation`/`submitJarvisQuery` + `activeConversationIdAtom`/`jarvisModeAtom` (`@/app/view/jarvis/jarvisstore`), the existing `launchGoal` (`command-palette.tsx:75`), `model.surfaceAtom`, `close` (`command-palette.tsx:66`). This is a `cockpit → jarvis` import (the shell composing a surface), not `agents → jarvis`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/cockpit/palette-ask.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildAskItems } from "./palette-ask";

describe("buildAskItems", () => {
    it("returns nothing for an empty goal", () => {
        expect(buildAskItems("", { ask: () => {} })).toEqual([]);
        expect(buildAskItems("   ", { ask: () => {} })).toEqual([]);
    });
    it("returns one ask row echoing the trimmed goal", () => {
        const items = buildAskItems("  why did we drop worktrees  ", { ask: () => {} });
        expect(items).toHaveLength(1);
        expect(items[0].key).toBe("ask-jarvis");
        expect(items[0].desc).toBe("why did we drop worktrees");
        expect(items[0].mode).toBe("Ask Jarvis");
    });
    it("run() forwards the trimmed goal to deps.ask", () => {
        const ask = vi.fn();
        buildAskItems("  q  ", { ask })[0].run();
        expect(ask).toHaveBeenCalledWith("q");
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node node_modules/vitest/vitest.mjs run frontend/app/cockpit/palette-ask.test.ts`
Expected: FAIL — cannot resolve `./palette-ask`.

- [ ] **Step 3: Write `palette-ask.ts`**

Create `frontend/app/cockpit/palette-ask.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure builder for the command palette's "Ask Jarvis" lead group (mirrors palette-launch.ts). Given the
// typed goal it returns a single rich row whose run() hands the question to deps.ask — which (in
// command-palette.tsx) starts a recall conversation and opens the Jarvis surface. Empty goal => no row.

export interface AskItem {
    key: string; // "ask-jarvis"
    glyph: string; // monospace badge glyph (matches the launch rows' glyph slot)
    mode: string; // "Ask Jarvis"
    desc: string; // the echoed question
    footer: string; // one-line echo shown in the palette footer when selected
    run: () => void;
}

export interface AskDeps {
    ask: (question: string) => void; // start a recall conversation + open the Jarvis surface
}

export function buildAskItems(goal: string, deps: AskDeps): AskItem[] {
    const q = goal.trim();
    if (q === "") {
        return [];
    }
    return [
        {
            key: "ask-jarvis",
            glyph: "✦",
            mode: "Ask Jarvis",
            desc: q,
            footer: `Recall across your Wave knowledge, grounded — “${q}”`,
            run: () => deps.ask(q),
        },
    ];
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node node_modules/vitest/vitest.mjs run frontend/app/cockpit/palette-ask.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the ask group into `command-palette.tsx`**

(a) Extend the kind union (`command-palette.tsx:27`):
```ts
type PaletteKind = "launch" | "ask-jarvis" | "command" | "agent" | "session" | "channel";
```

(b) Add imports at the top of `command-palette.tsx`:
```ts
import { buildAskItems } from "./palette-ask";
import { startConversation, submitJarvisQuery, activeConversationIdAtom, jarvisModeAtom } from "@/app/view/jarvis/jarvisstore";
```

(c) Build the ask handoff + items in the component body, near where `launchItems` is built. The handoff mirrors the `contextual`-scope default and reuses module-scope streaming so the answer keeps arriving after the palette closes:
```ts
    const askDeps = {
        ask: (question: string) => {
            const scope = {
                mode: "all" as const,
                chips: [
                    { label: "This project", active: false },
                    { label: "All Wave", active: true },
                ],
                attached: [],
            };
            const id = startConversation(scope);
            submitJarvisQuery(id, question);
            globalStore.set(activeConversationIdAtom, id);
            globalStore.set(jarvisModeAtom, "recall");
            globalStore.set(model.surfaceAtom, "jarvis");
            close();
        },
    };
    const askItems = buildAskItems(launchGoal, askDeps);
```

> `startConversation` already sets `activeConversationIdAtom` internally, but set it again here so the handoff is explicit and order-independent; it is idempotent. `launchGoal` is defined at `command-palette.tsx:75`.

(d) Map `AskItem → PaletteItem` and inject as a lead group in the `default` scope branch (`command-palette.tsx:271–278`), placed **after** the launch group so existing launch muscle-memory is undisturbed:
```ts
    } else if (parsed.scope === "default") {
        const ranked = rankPaletteItems(items, query);
        groups = GROUP_ORDER.map((kind) => ({ kind, items: ranked.filter((it) => it.kind === kind) })).filter(
            (g) => g.items.length > 0
        );
        const askPalItems = askItems.map((ai) => ({
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
        if (askPalItems.length > 0) {
            groups = [{ kind: "ask-jarvis", items: askPalItems }, ...groups];
        }
        if (launchItems.length > 0) {
            groups = [{ kind: "launch", items: launchItems }, ...groups];
        }
    }
```

(e) Add the render arm. In the `groups.map(...)` ternary (`command-palette.tsx:350`+), the launch arm renders the accent-railed rich block. Add an `ask-jarvis` arm that reuses the same rich-row markup with a Jarvis lead label. The simplest faithful change: broaden the existing rich-block condition to `g.kind === "launch" || g.kind === "ask-jarvis"` and choose the header text by kind:
```tsx
                g.kind === "launch" || g.kind === "ask-jarvis" ? (
                    <div key={g.kind} className="relative mx-0.5 mb-2 mt-1 rounded-[10px] bg-accent/5 px-1 pb-1">
                        <div className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-accent/80" />
                        <div className="px-3 pb-1 pt-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-accent-soft">
                            {g.kind === "launch" ? (
                                <>Launch in <span className="text-accent-100">#{targetChannel?.name}</span></>
                            ) : (
                                <>Ask Jarvis</>
                            )}
                        </div>
                        {g.items.map((it) => { /* unchanged rich-row body */ })}
                    </div>
                ) : (
```
Keep the rich-row body identical to the launch rows (glyph badge, `it.mode`, `it.desc`, active `⏎`, `flatIndex.get(it.key)!`). The footer bar already shows `it.footer` for the selected rich row — extend the `selFooter` computation (`command-palette.tsx:299`) from `kind === "launch"` to `(kind === "launch" || kind === "ask-jarvis")` so the ask row's footer shows too.

> `GROUP_LABELS` (`command-palette.tsx:47`) is typed `Record<Exclude<PaletteKind, "launch">, string>`. Since `ask-jarvis` renders through the rich-block arm (not the generic label renderer), change that type to `Record<Exclude<PaletteKind, "launch" | "ask-jarvis">, string>` so it does not demand an `ask-jarvis` label. Verify tsc.

- [ ] **Step 6: Dependency guard + typecheck**

```bash
grep -rn 'from "@/app/view/jarvis\|from "\.\./jarvis\|view/jarvis' frontend/app/view/agents
```
Expected: unchanged (the palette is in `cockpit/`, not `agents/` — this import does not affect the `agents` guard).

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```
Expected: exit 0.

- [ ] **Step 7: CDP — Ctrl+P ask row appears and hands off to the Jarvis surface**

Add a `jarvisAsk` scenario to `scripts/cdp/scenarios.mjs`. Open the palette, type a goal, assert the ask row renders; fire it and assert the surface switches to Jarvis (Recall) with the typed question as a user turn. Do **not** assert the model's answer text (it streams from the live backend and is timing-sensitive) — the navigation + user turn is the deterministic signal.

```js
// --- jarvis ask: Ctrl+P "Ask Jarvis" lead group hands a question off to the Jarvis surface (Plan 4) ---
const jarvisAsk = {
    name: "jarvis-ask",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("cockpit");
        // open the palette. Verify the actual open chord/trigger for this build; the model exposes
        // paletteOpenAtom, opened by the palette keybinding. Fallback: click the palette trigger button.
        const opened = await h.ev(`(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }));
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 250))");
        // type a goal into the palette input.
        const typed = await h.ev(`(() => {
            const inp = document.querySelector('input');
            if (!inp) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inp, 'why did we drop worktrees');
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 250))");
        const askRow = await h.ev(`(() => (document.body.innerText || '').includes('Ask Jarvis'))()`);
        steps.push({ step: "type goal -> Ask Jarvis lead row present", ok: opened && typed && askRow === true, detail: `askRow=${askRow}` });
        // fire the ask row (click it) and assert the handoff.
        await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Ask Jarvis'));
            if (b) b.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 600))");
        const landed = await h.ev(`(() => {
            const label = (document.querySelector('nav .text-accent') || {}).textContent || '';
            const body = document.body.innerText || '';
            return { onJarvis: body.includes('Jarvis'), userTurn: body.includes('why did we drop worktrees') };
        })()`);
        steps.push({
            step: "fire Ask row -> Jarvis surface shows the question as a user turn",
            ok: landed.onJarvis === true && landed.userTurn === true,
            detail: JSON.stringify(landed),
        });
        await h.shot("cdp-shots/jarvis-ask.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};
```
Append `jarvisAsk` to the `SCENARIOS` array. Hand-match 4-space style. Run `task verify:ui -- jarvis-ask`.

> The palette-open chord is the one genuinely per-build unknown here. Confirm it against `keybindings/bindings.ts` (search for `paletteOpenAtom`); if `Ctrl+P` is wrong, use the real chord or the palette trigger button. The row-present + handoff assertions are the durable checks.

- [ ] **Step 8: Stage + checkpoint.**

---

### Task 3: Contextual entries on Run / Radar / Memory (state 11 real)

An "Ask Jarvis about this" action on each of the three detail views that opens Jarvis with the object attached as a `SourceRef` and a suggested prompt pre-filled. Reuses the `attached`-scope shape the `contextual` fixture already models. These are sanctioned `agents → jarvis` handoff imports.

**Files:**
- Create: `frontend/app/view/jarvis/contextualentry.tsx`, `frontend/app/view/jarvis/contextualentry.test.ts`
- Modify: `frontend/app/view/agents/runbody.tsx`, `frontend/app/view/agents/radarfindingdetail.tsx`, `frontend/app/view/agents/memorysurface.tsx`

**Interfaces:**
- Produces: `sourceRefForRun(run: Run): SourceRef`, `sourceRefForRadar(finding: RadarFinding): SourceRef`, `sourceRefForMemory(note: MemNote): SourceRef`, `attachedScope(ref: SourceRef): JarvisScope`, `suggestedPrompt(t: SourceType): string`, `openJarvisWithSource(model, ref)`, and `<AskJarvisButton model sourceRef label>`.
- Consumes: `startConversation` + `jarvisModeAtom` + `jarvisDraftAtom` (`./jarvisstore`), `SourceRef`/`SourceType`/`JarvisScope` (`./jarviscontract`), `WOS.makeORef`, `AgentsViewModel` (`../agents/agents`), `MemNote` (`../agents/memtypes`), global `Run`/`RadarFinding` types.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/contextualentry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { attachedScope, sourceRefForMemory, sourceRefForRadar, sourceRefForRun } from "./contextualentry";

describe("contextual-entry SourceRef builders", () => {
    it("builds a run SourceRef from id + goal", () => {
        const ref = sourceRefForRun({ id: "r1", goal: "ship the thing" } as any);
        expect(ref).toEqual({ oref: "run:r1", sourceType: "run", title: "ship the thing" });
    });
    it("builds a radar SourceRef as radar:<finding.id>", () => {
        const ref = sourceRefForRadar({ id: "f9", risk: "retry storm" } as any);
        expect(ref).toEqual({ oref: "radar:f9", sourceType: "radar", title: "retry storm" });
    });
    it("builds a memory SourceRef as memory:<note.id>", () => {
        const ref = sourceRefForMemory({ id: "m3", title: "worktree gotcha" } as any);
        expect(ref).toEqual({ oref: "memory:m3", sourceType: "memory", title: "worktree gotcha" });
    });
    it("wraps a ref in an attached scope with an active chip", () => {
        const ref = sourceRefForRun({ id: "r1", goal: "g" } as any);
        const scope = attachedScope(ref);
        expect(scope.mode).toBe("attached");
        expect(scope.attached).toEqual([ref]);
        expect(scope.chips.some((c) => c.active)).toBe(true);
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis/contextualentry.test.ts`
Expected: FAIL — cannot resolve `./contextualentry`.

- [ ] **Step 3: Write `contextualentry.tsx`**

Create `frontend/app/view/jarvis/contextualentry.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Contextual entry into Jarvis from Run / Radar / Memory: build a SourceRef for the object, start a recall
// conversation in an "attached" scope with a suggested prompt pre-filled, and open the Jarvis surface. This
// is the same producer->consumer handoff direction as channelactions' @jarvis handoff (agents surface ->
// Jarvis), so the agents surfaces importing AskJarvisButton is a sanctioned agents->jarvis import.

import { globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import type { AgentsViewModel } from "../agents/agents";
import type { MemNote } from "../agents/memtypes";
import type { JarvisScope, SourceRef, SourceType } from "./jarviscontract";
import { jarvisDraftAtom, jarvisModeAtom, startConversation } from "./jarvisstore";

export function sourceRefForRun(run: Run): SourceRef {
    return { oref: WOS.makeORef("run", run.id) ?? `run:${run.id}`, sourceType: "run", title: run.goal };
}
export function sourceRefForRadar(finding: RadarFinding): SourceRef {
    return { oref: `radar:${finding.id}`, sourceType: "radar", title: finding.risk };
}
export function sourceRefForMemory(note: MemNote): SourceRef {
    return { oref: `memory:${note.id}`, sourceType: "memory", title: note.title };
}

const CHIP_LABEL: Partial<Record<SourceType, string>> = {
    run: "This Run",
    radar: "This finding",
    memory: "This memory",
};

export function attachedScope(ref: SourceRef): JarvisScope {
    return { mode: "attached", chips: [{ label: CHIP_LABEL[ref.sourceType] ?? "This source", active: true }], attached: [ref] };
}

export function suggestedPrompt(t: SourceType): string {
    switch (t) {
        case "run":
            return "What changed in this Run and why?";
        case "radar":
            return "Explain this Radar finding.";
        case "memory":
            return "Recall decisions related to this.";
        default:
            return "";
    }
}

export function openJarvisWithSource(model: AgentsViewModel, ref: SourceRef): void {
    startConversation(attachedScope(ref)); // creates + activates the conversation (jarvisstore)
    globalStore.set(jarvisDraftAtom, suggestedPrompt(ref.sourceType));
    globalStore.set(jarvisModeAtom, "recall");
    globalStore.set(model.surfaceAtom, "jarvis");
}

export function AskJarvisButton({
    model,
    sourceRef,
    label,
}: {
    model: AgentsViewModel;
    sourceRef: SourceRef;
    label: string;
}) {
    return (
        <button
            type="button"
            onClick={() => openJarvisWithSource(model, sourceRef)}
            className="rounded border border-accent/25 px-2.5 py-1.5 text-[11.5px] font-semibold text-accent-soft hover:border-accent/40"
        >
            {label}
        </button>
    );
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis/contextualentry.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the button to the three detail views**

**Radar** (`radarfindingdetail.tsx`) — `RadarFindingDetail` already has `model`. Add the import `import { AskJarvisButton, sourceRefForRadar } from "@/app/view/jarvis/contextualentry";` and place the button in the actions block (~lines 235–254, alongside "Start investigation" / "Open run"):
```tsx
<AskJarvisButton model={model} sourceRef={sourceRefForRadar(finding)} label="Explain with Jarvis" />
```

**Run** (`runbody.tsx`) — thread `model` into `RunHeader` so the button is shared by both `RunBody` and `OrchestratorBody` (which both render `<RunHeader>` and both already have `model`). 
- `RunHeader({ run, agents, channel, steering, … })` → add `model` to the props type and destructure: `RunHeader({ run, agents, channel, model, steering, … }: { …; model: AgentsViewModel; … })`.
- At both call sites (`runbody.tsx:317` in `OrchestratorBody`, `runbody.tsx:537` in `RunBody`) add `model={model}` to `<RunHeader …>`.
- Add the import `import { AskJarvisButton, sourceRefForRun } from "@/app/view/jarvis/contextualentry";`.
- Render the button in `RunHeader`'s header row **outside** the `!hideSteer` block (so it shows in the merged surface too), e.g. inside the `<div className="mb-4 flex items-start gap-3">` after the `min-w-0 flex-1` goal column and before the steer group:
```tsx
<div className="flex flex-none gap-1.5">
    <AskJarvisButton model={model} sourceRef={sourceRefForRun(run)} label="Ask Jarvis" />
</div>
```
(If a `flex flex-none` actions wrapper already exists, add the button there instead of a second wrapper.)

**Memory** (`memorysurface.tsx`) — thread `model` into `DetailBody` (one hop).
- `DetailBody({ sel, body, related })` → `DetailBody({ sel, body, related, model }: { …; model: AgentsViewModel })`.
- At the call site (`memorysurface.tsx:474`): `<DetailBody sel={sel} body={body} related={related} model={model} />` (`MemorySurface` has `model`).
- Add the import `import { AskJarvisButton, sourceRefForMemory } from "@/app/view/jarvis/contextualentry";`.
- Add the button to the non-editing action row (~lines 342–353, beside "Edit"/"Delete"):
```tsx
<AskJarvisButton model={model} sourceRef={sourceRefForMemory(sel)} label="Ask Jarvis" />
```

- [ ] **Step 6: Dependency guard + typecheck**

```bash
grep -rn 'from "@/app/view/jarvis\|from "\.\./jarvis\|view/jarvis' frontend/app/view/agents
```
Expected: now **five** hits — `channelactions.ts`, `cockpitshell.tsx`, and the three new ones (`runbody.tsx`, `radarfindingdetail.tsx`, `memorysurface.tsx`). All sanctioned handoffs. No others.

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```
Expected: exit 0.

- [ ] **Step 7: CDP — contextual entry opens Jarvis with the source attached**

The rendered result (an attached conversation) is already CDP-covered by the `contextual` fixture in `jarvis-states`; the *builders* are unit-tested (Step 1). Add a lightweight assertion to the existing `runs-lifecycle` scenario (which already creates a real run): after the run is visible, click "Ask Jarvis" and assert the surface switches to Jarvis with an attached chip and the suggested prompt in the composer.

```js
        // Plan 4: contextual entry — click "Ask Jarvis" on the run, land on the Jarvis surface with the
        // source attached and a suggested prompt pre-filled.
        const asked = await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Ask Jarvis');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const onJarvis = await h.ev(`(() => {
            const body = document.body.innerText || '';
            const draft = (document.querySelector('input[placeholder="Ask Jarvis…"]') || {}).value || '';
            return { chip: body.includes('This Run'), draft: draft.includes('changed in this Run') };
        })()`);
        steps.push({ step: "contextual Ask Jarvis -> attached chip + suggested prompt", ok: asked === true && onJarvis.chip && onJarvis.draft, detail: JSON.stringify(onJarvis) });
```
Place this inside `runsLifecycle.assert` after the run-detail assertions and before its teardown; keep the run's own assertions intact. Hand-match 4-space style. Run `task verify:ui -- runs-lifecycle`.

> If `runs-lifecycle` does not render a run *detail* (only the list), move this assertion to whichever scenario opens a run detail, or open the run first. The unit tests carry the builder correctness regardless.

- [ ] **Step 8: Stage + checkpoint.**

---

### Task 4: Ambient attribution — provider seam + fixture tags/cards

A provider interface (`AmbientProvider`) with a deterministic fixture implementation, plus two tiny render components, wired onto Run/Radar/Memory rows (tags) and details (relevant-decision cards). Owned by `view/agents/` — no jarvis dependency. Explicitly placeholder data (the real edges are attribution engine D, v2).

**Files:**
- Create: `frontend/app/view/agents/ambient.ts`, `frontend/app/view/agents/ambient.test.ts`, `frontend/app/view/agents/ambientviews.tsx`
- Modify: `frontend/app/view/agents/runbody.tsx`, `frontend/app/view/agents/radarfindingdetail.tsx`, `frontend/app/view/agents/radarfindingslist.tsx`, `frontend/app/view/agents/memorysurface.tsx`, `frontend/app/view/agents/channelchrome.tsx`, `docs/deferred.md`

**Interfaces:**
- Produces: `interface AmbientTag { label; taskId }`, `interface AmbientDecision { title; oref; ageMs }`, `interface AmbientProvider { tagsFor(oref): AmbientTag[]; decisionsFor(oref): AmbientDecision[] }`, `fixtureAmbientProvider`, and `<AmbientTags oref>` / `<RelevantDecisions oref>`.
- Consumes: nothing outside `view/agents/` (deliberately jarvis-free).

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/ambient.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fixtureAmbientProvider } from "./ambient";

describe("fixtureAmbientProvider", () => {
    it("returns nothing for a blank oref", () => {
        expect(fixtureAmbientProvider.tagsFor("")).toEqual([]);
        expect(fixtureAmbientProvider.decisionsFor("")).toEqual([]);
    });
    it("is deterministic for a given oref", () => {
        const a = fixtureAmbientProvider.tagsFor("run:abc");
        const b = fixtureAmbientProvider.tagsFor("run:abc");
        expect(a).toEqual(b);
        expect(a.length).toBeGreaterThan(0);
    });
    it("varies tags across orefs (covers more than one task label)", () => {
        const labels = new Set(
            ["run:a", "run:b", "run:c", "radar:d", "memory:e"].map((o) => fixtureAmbientProvider.tagsFor(o)[0]?.label)
        );
        expect(labels.size).toBeGreaterThan(1);
    });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node node_modules/vitest/vitest.mjs run frontend/app/view/agents/ambient.test.ts`
Expected: FAIL — cannot resolve `./ambient`.

- [ ] **Step 3: Write `ambient.ts`**

Create `frontend/app/view/agents/ambient.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Ambient attribution provider seam. The real edges come from attribution engine D (v2); this cycle ships
// a deterministic FIXTURE keyed off the oref hash so dev/CDP shows believable placeholder task tags and
// "relevant past decision" cards on real Run/Radar/Memory rows. PLACEHOLDER data — see docs/deferred.md.
// The durable part is the AmbientProvider interface: D replaces fixtureAmbientProvider behind it.

export interface AmbientTag {
    label: string;
    taskId: string;
}
export interface AmbientDecision {
    title: string;
    oref: string;
    ageMs: number;
}
export interface AmbientProvider {
    tagsFor(oref: string): AmbientTag[];
    decisionsFor(oref: string): AmbientDecision[];
}

const TASKS = ["channel-scaling", "radar-loop", "tauri-migration", "recall-engine"];
const DECISIONS = [
    { title: "Decision: drop-oldest on overflow", oref: "decision:placeholder-1", ageMs: 2 * 24 * 60 * 60 * 1000 },
    { title: "Decision: shared working tree", oref: "decision:placeholder-2", ageMs: 5 * 24 * 60 * 60 * 1000 },
];

function hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

export const fixtureAmbientProvider: AmbientProvider = {
    tagsFor(oref) {
        if (!oref) {
            return [];
        }
        const label = TASKS[hash(oref) % TASKS.length];
        return [{ label, taskId: label }];
    },
    decisionsFor(oref) {
        if (!oref || hash(oref) % 2 === 0) {
            return []; // ~half of objects surface a related decision
        }
        return [DECISIONS[hash(oref) % DECISIONS.length]];
    },
};
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node node_modules/vitest/vitest.mjs run frontend/app/view/agents/ambient.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `ambientviews.tsx`**

Create `frontend/app/view/agents/ambientviews.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Ambient attribution render bits: task tag chips (row-level) and a "relevant past decision" card block
// (detail-level). Read from the fixture provider; non-interactive (no Tasks surface exists in v1). Marked
// visually as ambient so it never reads as a confirmed edge.

import { ageLabel } from "@/app/view/jarvis/recallderive";
import { fixtureAmbientProvider } from "./ambient";

export function AmbientTags({ oref }: { oref: string }) {
    const tags = fixtureAmbientProvider.tagsFor(oref);
    if (tags.length === 0) {
        return null;
    }
    return (
        <span className="flex flex-wrap items-center gap-1">
            {tags.map((t) => (
                <span
                    key={t.taskId}
                    title="Ambient task attribution (placeholder)"
                    className="rounded-[4px] border border-edge-mid px-1.5 py-px font-mono text-[9px] uppercase tracking-[.06em] text-muted"
                >
                    {t.label}
                </span>
            ))}
        </span>
    );
}

export function RelevantDecisions({ oref }: { oref: string }) {
    const decisions = fixtureAmbientProvider.decisionsFor(oref);
    if (decisions.length === 0) {
        return null;
    }
    return (
        <div className="flex flex-col gap-1.5">
            <div className="font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-muted">
                Relevant past decisions
            </div>
            {decisions.map((d) => (
                <div key={d.oref} className="rounded-[9px] border border-border bg-surface px-3 py-2">
                    <div className="text-[12.5px] font-semibold text-secondary">{d.title}</div>
                    <div className="text-[11px] text-muted">{ageLabel(d.ageMs)}</div>
                </div>
            ))}
        </div>
    );
}
```

> `ageLabel` is a pure helper from `recallderive.ts` — importing it (`agents → jarvis`) would violate the dependency rule. Instead, **copy the 5-line `ageLabel` into `ambient.ts`** (or inline a local `agoLabel` in `ambientviews.tsx`) so ambient stays jarvis-free. Do not import from `view/jarvis`. (Verify the guard in Step 7.)

- [ ] **Step 6: Wire tags + cards into the surfaces**

- **Run rows** (`channelchrome.tsx`, `RunStrip`): import `AmbientTags` + `WOS`; add `<AmbientTags oref={WOS.makeORef("run", run.id) ?? ""} />` beside the phase progress area (~channelchrome.tsx:126–132).
- **Run detail** (`runbody.tsx`): add `<AmbientTags oref={...} />` in `RunHeader` near `StatusPill`, and `<RelevantDecisions oref={...} />` in the body column (after the header, before `CompactStepper`, ~runbody.tsx:548–550). Reuse `sourceRefForRun(run).oref` or `WOS.makeORef("run", run.id)`.
- **Radar rows** (`radarfindingslist.tsx`): add `<AmbientTags oref={"radar:" + finding.id} />` to the row footer meta (~radarfindingslist.tsx:153–178).
- **Radar detail** (`radarfindingdetail.tsx`): add `<AmbientTags oref={"radar:" + finding.id} />` in the status chip row (~79–104) and `<RelevantDecisions oref={"radar:" + finding.id} />` after "Why it matters" (~108–110).
- **Memory rows** (`memorysurface.tsx`, `ListView`): add `<AmbientTags oref={"memory:" + note.id} />` in the note-row content (~186–229).
- **Memory detail** (`memorysurface.tsx`, `DetailBody`): add `<AmbientTags oref={"memory:" + sel.id} />` near the type/scope header (~282–288) and `<RelevantDecisions oref={"memory:" + sel.id} />` near the "Related memory" section (~360–384).

Import `AmbientTags`/`RelevantDecisions` from `./ambientviews` in each file. Match surrounding spacing/token classes.

- [ ] **Step 7: Dependency guard + typecheck**

```bash
grep -rn 'from "@/app/view/jarvis\|from "\.\./jarvis\|view/jarvis' frontend/app/view/agents
```
Expected: still exactly the five sanctioned handoff hits from Task 3 — **ambient added none** (if `ambientviews.tsx` or `ambient.ts` shows up here, you imported `ageLabel` from jarvis; inline it instead, per Step 5).

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```
Expected: exit 0.

- [ ] **Step 8: Record the fabrication + CDP tag render**

Append to `docs/deferred.md` (create the file if absent) a note: *"Jarvis ambient attribution (Plan 4) ships PLACEHOLDER data via `fixtureAmbientProvider` (deterministic oref hash) — task tags + relevant-decision cards are fabricated until attribution engine D (v2) implements the `AmbientProvider` seam."*

Add a `jarvis-ambient` CDP check (or extend `surface-smoke`): goto `radar`/`memory`, assert at least one ambient tag chip renders. Because tags key off real orefs, they appear on populated rows; if a surface is empty in the harness, assert on whichever of Run/Radar/Memory has data (or inject via `inject-live-agents`). Example assertion snippet:
```js
const hasTag = await h.ev(`(() => {
    const els = [...document.querySelectorAll('span[title="Ambient task attribution (placeholder)"]')];
    return els.length > 0;
})()`);
```
Run `task verify:ui -- <scenario>`; expected PASS when the surface has ≥1 row.

- [ ] **Step 9: Stage + checkpoint.**

---

### Task 5: Full verification + docs fold-in

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-jarvis-ui-surface-design.md` (§9), `docs/superpowers/specs/2026-07-23-jarvis-second-brain-meta-spec.md` (tracking table)

- [ ] **Step 1: Full FE test suite**

```bash
node node_modules/vitest/vitest.mjs run
```
Expected: all PASS (incl. the four new unit files; no regression in Plan 1–3 tests).

- [ ] **Step 2: Full typecheck**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Dependency-direction guard (final)**

```bash
grep -rn 'from "@/app/view/jarvis\|from "\.\./jarvis\|view/jarvis' frontend/app/view/agents
```
Expected: exactly five hits — `channelactions.ts`, `cockpitshell.tsx`, `runbody.tsx`, `radarfindingdetail.tsx`, `memorysurface.tsx`. Any other is a leak (especially an ambient file — fix by inlining `ageLabel`).

- [ ] **Step 4: Lint the touched files**

```bash
npx eslint frontend/app/view/jarvis frontend/app/cockpit/command-palette.tsx frontend/app/cockpit/palette-ask.ts frontend/app/view/agents/ambient.ts frontend/app/view/agents/ambientviews.tsx frontend/app/view/agents/runbody.tsx frontend/app/view/agents/radarfindingdetail.tsx frontend/app/view/agents/radarfindingslist.tsx frontend/app/view/agents/memorysurface.tsx frontend/app/view/agents/channelchrome.tsx
```
Expected: no new errors (pre-existing `no-undef` in `scripts/*.mjs` is unrelated — do not touch).

- [ ] **Step 5: CDP regression — all scenarios**

`task verify:ui -- jarvis-states jarvis-fleet jarvis-ask runs-lifecycle surface-smoke channels` (use the real scenario names in `scenarios.mjs`). Expected: PASS table; contact sheet at `cdp-shots/index.html`. Confirms Plan 1–3 states still render and the Plan 4 palette handoff, contextual entry, ambient tags, and citation-click smoke all render.

- [ ] **Step 6: Docs fold-in**

- In the G spec §9 (`2026-07-23-jarvis-ui-surface-design.md`), mark steps **5 and 6 done**, noting the four confirmed decisions (quick-ask handoff not inline; nav covers channel/run/agent; ambient fixture in `view/agents/`; radar oref = `radar:<id>`).
- In the meta-spec tracking table (`2026-07-23-jarvis-second-brain-meta-spec.md`), add **P4** to G's Plan cell and update the Built cell to note G is feature-complete pending merge.

- [ ] **Step 7: Self-review the diff**, then **stage + checkpoint** — `git add` all touched + new files including this plan doc (it folds into the eventual feature commit). Do **not** commit. Report what was verified (tsc, vitest, eslint, CDP) with the actual command output.

---

## Self-Review

**Spec coverage** (G spec §9 steps 5–6 + §"Palette lead group · contextual entries · ambient" + §"The 12 states"):
- "Ctrl+P 'ask-jarvis' lead group + handoff" → Task 2. State 8 (composing) = palette input; state 10 (continued into surface) = the handoff landing.
- "Compact cited-answer / weak / not-found states render inline in the palette" → **amended by decision 1** (palette is list-only; the answer streams in the surface). Documented in "Decisions made".
- "Contextual entries on Run/Radar/Memory (open Jarvis with the object attached)" → Task 3; state 11 real. The `contextual` fixture already CDP-renders the resulting attached conversation.
- "Ambient attribution on Run/Radar/Memory rows + relevant-decision cards, behind a provider interface" → Task 4; `AmbientProvider` seam + `fixtureAmbientProvider`, owned by `view/agents/`.
- "Inline [n] citations opening native source surfaces" → Task 1; **partial by decision 2** (channel/run/agent; others no-op) — documented.
- "No composer model-picker / second palette / new global shortcut / light mode" → honored (no such code).

**Placeholder scan:** no "TBD"/"handle appropriately"/"similar to". Intentional per-repo unknowns are flagged inline for verification, not left vague: the palette-open chord in Task 2 Step 7 (verify against `keybindings/bindings.ts`), the `loadAndPinWaveObject` return shape in Task 1 Step 3, and the CDP selector robustness notes. Ambient data is explicitly PLACEHOLDER and recorded in `docs/deferred.md`.

**Type consistency:** `SourceRef`/`SourceType`/`JarvisScope` are consumed from `jarviscontract.ts` unchanged. `sourceRefFor*` return `SourceRef` and are asserted field-for-field in Task 3 Step 1. `AskItem`/`AskDeps` (Task 2 Step 3) match the `buildAskItems` call + the `AskItem → PaletteItem` mapping in Task 2 Step 5. `AmbientProvider`/`AmbientTag`/`AmbientDecision` (Task 4 Step 3) match the components in Step 5 and the tests in Step 1. `openORef(model, oref)` / `orefNavPlan(oref)` signatures (Task 1) match the call sites in `conversationview.tsx`/`groundingrail.tsx` (Step 5). `AskJarvisButton`'s `{ model, sourceRef, label }` props match all three call sites (Task 3 Step 5).

**Green-after-each-task:** Task 1 ships a self-contained nav helper + rewired stubs (tsc-clean, unit-green). Task 2 adds the palette group (cockpit-only import; no `agents` guard change). Task 3 introduces exactly three new sanctioned `agents → jarvis` handoff imports (guard: 5 total). Task 4 adds ambient with **zero** new `agents → jarvis` imports (guard stays at 5). Each task ends tsc-clean + test-green; the dependency guard is checked at the end of every task.

**Dependency-rule audit:** the only new `agents → jarvis` imports are the three contextual-entry `AskJarvisButton` imports (Task 3) — the same producer→consumer handoff direction Plan 3 sanctioned for `channelactions`. `openref.ts` and `palette-ask.ts` import the *other* direction (jarvis→agents) or live in `cockpit/`. Ambient is deliberately jarvis-free (inlined `ageLabel`).
