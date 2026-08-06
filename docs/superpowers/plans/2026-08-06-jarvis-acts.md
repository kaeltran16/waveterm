# Jarvis acts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every line the Jarvis creature shows carries the action that resolves it, and every utterance carries what it produced — replacing a panel of seven dead-end readouts.

**Architecture:** One typed act (`PetAct`) with three verbs — `do` (run an operation in place, report on the row), `open` (escort to a surface with the right thing focused), `ask` (seed a Jarvis question). A pure module decides *what is offered*; an impure runner decides *how it runs*. Three small Go changes supply what the frontend cannot compute: an off-band index reconcile, the gate's phase index on the attention wire, and the identities of the notes a distillation pass wrote.

**Tech Stack:** React 19, jotai, Tailwind 4, vitest (node env, no jsdom), Go (wshrpc), CDP scenarios for rendered checks.

**Spec:** `docs/superpowers/specs/2026-08-06-jarvis-acts-design.md`

## Global Constraints

- **Colors come from `@theme` tokens in `frontend/tailwindsetup.css`.** Never a raw hex or rgba in a component — runtime theming rewrites those same custom properties, so a hardcoded color silently opts out of every theme.
- **No new SCSS.** Tailwind utilities only.
- **No emojis anywhere.** Comments explain *why*, never *what*; lower case; only where the reason is not obvious.
- **Never hand-edit generated files.** `frontend/app/store/wshclientapi.ts` and `frontend/types/gotypes.d.ts` are produced by `task generate`. Edit the Go definitions and regenerate.
- **No jsdom render or snapshot tests.** Standing decision in this repo: pure logic is extracted and unit-tested; "does it render" is verified by a CDP scenario against the live dev app.
- **Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.** Bare `npx tsc` stack-overflows on this repo. Baseline is clean — any error it reports is yours.
- **Go tests need a Windows-style CGO include path.** Anything importing `jarvisembed` fails to *build* without it, and a Git-Bash POSIX path fails identically and silently:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  ```
- **Never run `prettier --write` on a file you did not author.** It reorders imports and rewraps the whole file, turning a four-line edit into a six-hundred-line diff. Hand-format your own lines to match the file.
- **Any state that must survive a surface switch lives in a module-level atom**, never component `useState` — every surface but Agent unmounts on nav switch.
- **A backend rebuild (`task build:backend`) is required** before Tasks 5, 7, and 9's new RPCs and fields are reachable from a running dev app; without it the frontend gets a route error against a stale `wavesrv`.

## Deviations from the spec, decided while planning

Four things the spec got wrong or under-specified. These are the plan's rulings; the spec has been updated to match.

1. **The distillation pass publishes one event per pass, always** — not "one when there are products and none when there aren't" (spec §6.3). Suppressing barren passes on the backend would leave the last-pass row (spec §4.7) with no data, making a pipeline that runs and writes nothing *invisible* — the exact failure that row exists to prevent. The backend reports the fact; the frontend owns the law about whether it is worth saying.
2. **The dead-button rule is three-state, not two** (spec §9). `loadMemory()` only runs when you visit the Memory surface, so `memNotesAtom` is empty most of the time. A strict "the note must exist" gate would suppress every product's Open button. The predicate returns `true` / `false` / `undefined`, and only an explicit `false` suppresses.
3. **An errand is not a `PetOp`** (spec §3). `PetAct` is the set of acts the pure mapping *offers*; a question the user composes is not offered, it is authored. The errand box calls `sendErrand` directly.
4. **A catch-up needs a bounded fast re-read.** The index status is polled every 15 minutes on purpose (the backend parses the whole vault to count drift). The spec said the existing poll is the completion channel, which is true and too slow to feel: press Catch up and the row keeps saying "stale" for up to fifteen minutes. Task 6 adds a bounded 30-second re-read burst that stops when the index reads `ok` or twelve minutes pass — long enough to cover the measured 5m17s build of a 373-note vault (`pkg/jarvisembed/status.go`).

## File Structure

**New frontend files**

| File | Responsibility |
|---|---|
| `frontend/app/view/jarvis/petacts.ts` | pure: the `PetAct` / `PetOp` / `PetTarget` types and every signals-to-acts mapping |
| `frontend/app/view/jarvis/petacts.test.ts` | the design's assertions about what is offered |
| `frontend/app/view/jarvis/petactrun.ts` | impure: `runAct`, the escorts, `sendErrand`, the catch-up watch |
| `frontend/app/view/jarvis/petactrun.test.ts` | runner behavior against mocked RPC |
| `frontend/app/view/jarvis/peterrand.tsx` | the errand box: input, send, streamed reply |
| `frontend/app/view/agents/settingsstore.ts` | the Settings surface's pending-section atom (no store file exists yet) |

**Modified frontend files**

| File | Change |
|---|---|
| `petstore.ts` | act state, last-pass, errand atoms |
| `petpeek.tsx` | renders acts on rows and utterances; footer inverts |
| `petjoin.ts` | activity adapter carries note products; barren pass yields no utterance |
| `petvoice.ts` | `source` widens to `sources`; drops the `notes-written` kind |
| `petbubble.tsx` | drops the `notes-written` label |
| `petcondition.ts` | the stale condition line stops promising a remedy in prose |
| `petsources.tsx` | exports `loadIndexStatus`; records each pass for the last-pass row |
| `memstore.ts` | pending memory-focus atom + its consume-once reader |
| `cleanupqueue.tsx` | consumes the pending focus: opens itself and scrolls into view |
| `memorysurface.tsx` | clears the pending focus on unmount |
| `settingssurface.tsx` | an id on the embeddings section + the scroll-on-mount effect |

**Modified Go files**

| File | Change |
|---|---|
| `pkg/wshrpc/wshrpctypes_jarvis.go` | `EmbedReconcileCommand` |
| `pkg/wshrpc/wshserver/wshserver_jarvispet.go` | its off-band, single-flighted implementation |
| `pkg/wshrpc/wshrpctypes_channels.go` | `AttentionItem.PhaseIdx` |
| `pkg/jarvis/attention.go` | populate it |
| `pkg/memvault/learn.go` | `RouteLearnings` returns a `RouteResult` carrying written note identities |
| `pkg/memdistill/coordinator.go` | one activity event per pass, carrying the notes |
| `pkg/baseds/baseds.go` | `MemoryActivityData.Notes` |

**New scenario**

`scripts/cdp/scenarios.mjs` — a `pet-acts` scenario.

---

### Task 1: The act model and the vault mapping

**Files:**
- Create: `frontend/app/view/jarvis/petacts.ts`
- Create: `frontend/app/view/jarvis/petacts.test.ts`

**Interfaces:**
- Consumes: `MemoryPruneCandidate` (ambient generated wire type from `frontend/types/gotypes.d.ts` — no import needed, as `memstore.ts` does)
- Produces: `PetAct`, `PetOp`, `PetTarget`, `AskSeed`, `PetActState`, `PetActStatus`, `actsForVault(candidates)`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/petacts.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { actsForVault } from "./petacts";

function cand(id: string, reason: string): MemoryPruneCandidate {
    return { id, title: id, type: "learning", reason, path: `/vault/${id}.md` } as MemoryPruneCandidate;
}

describe("actsForVault", () => {
    it("offers nothing for an empty queue", () => {
        expect(actsForVault([])).toEqual([]);
        expect(actsForVault(null)).toEqual([]);
    });

    it("escorts to the queue, carrying its size in the label", () => {
        const acts = actsForVault([cand("a", "stale"), cand("b", "drift")]);
        expect(acts).toEqual([
            { id: "vault:review", verb: "open", label: "Review 2", target: { kind: "memory-upkeep" } },
        ]);
    });

    it("adds a bounded clear for the superseded subset only", () => {
        const acts = actsForVault([cand("a", "stale"), cand("b", "superseded"), cand("c", "superseded")]);
        expect(acts.map((a) => a.label)).toEqual(["Review 3", "Clear 2 superseded"]);
        expect(acts[1]).toMatchObject({ verb: "do", op: { kind: "clear-superseded", count: 2 } });
    });

    it("offers no clear when nothing is superseded", () => {
        expect(actsForVault([cand("a", "stale")]).map((a) => a.label)).toEqual(["Review 1"]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/petacts.test.ts`
Expected: FAIL — `Failed to resolve import "./petacts"`

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/jarvis/petacts.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What the creature offers to DO about each thing it reports. Pure — no atoms, no rpc, no pixels — for the
// same reason petcondition.ts is (design §3): this module decides WHAT is offered, and passing thunks in
// here would drag the rpc client into the one layer whose whole value is being assertable without one.
//
// The law it implements (design §2): nothing appears on the creature unless it carries the thing that
// resolves it. A row with genuinely nothing to do returns [] and stays a readout — the rate-limit countdown
// is that row, and it is honest rather than an omission.

// The closed set of executable operations. Closed rather than open so petactrun.ts's dispatch is
// exhaustive and a new operation cannot be added without wiring it.
export type PetOp =
    | { kind: "reconcile-index" }
    | { kind: "clear-superseded"; count: number };

// Where an escort lands. An oref goes through the existing openORef; the two surface targets exist because
// the Memory cleanup queue and the Settings embeddings section are not addressable as orefs.
export type PetTarget =
    | { kind: "oref"; ref: string; anchor?: string }
    | { kind: "memory-upkeep" }
    | { kind: "settings-embeddings" };

// The four arguments askAboutSource already takes, carried as data so this pure module can offer an Ask
// without importing the impure helper.
export interface AskSeed {
    ref: string;
    sourceType: string;
    title: string;
    prompt: string;
}

export type PetAct =
    | { id: string; verb: "do"; label: string; op: PetOp }
    | { id: string; verb: "open"; label: string; target: PetTarget }
    | { id: string; verb: "ask"; label: string; seed: AskSeed };

// An act's transient outcome, keyed by act id in petstore.ts. Transient on purpose: the row's real value
// comes from its own poll, and letting an act's return value become the row's value would drift from the
// backend the moment a poll disagreed with a stale result.
export type PetActStatus = "running" | "done" | "error";

export interface PetActState {
    status: PetActStatus;
    text?: string;
}

// pkg/memvault/prune.go's one mechanical reason: a note explicitly replaced by another. Every other reason
// is a judgement about whether the note is still worth keeping, and pruning deletes the file irreversibly.
const SUPERSEDED = "superseded";

export function actsForVault(candidates: MemoryPruneCandidate[] | null | undefined): PetAct[] {
    const list = candidates ?? [];
    if (list.length === 0) {
        return [];
    }
    const acts: PetAct[] = [
        { id: "vault:review", verb: "open", label: `Review ${list.length}`, target: { kind: "memory-upkeep" } },
    ];
    const superseded = list.filter((c) => c.reason === SUPERSEDED).length;
    if (superseded > 0) {
        acts.push({
            id: "vault:clear-superseded",
            verb: "do",
            label: `Clear ${superseded} superseded`,
            op: { kind: "clear-superseded", count: superseded },
        });
    }
    return acts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/petacts.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/petacts.ts frontend/app/view/jarvis/petacts.test.ts
git commit -m "feat(jarvis): the act type the creature's registers terminate in, plus the vault queue's own two verbs"
```

---

### Task 2: The act runner and its state

**Files:**
- Create: `frontend/app/view/jarvis/petactrun.ts`
- Create: `frontend/app/view/jarvis/petactrun.test.ts`
- Modify: `frontend/app/view/jarvis/petstore.ts` (add `petActStateAtom` and its writers)

**Interfaces:**
- Consumes: `PetAct`, `PetActState` (Task 1); `openORef(model, ref, anchor)` from `./openref`; `askAboutSource(oref, sourceType, title, text)` from `./jarvissubjectstore`; `confirmPruneAllSuperseded(count)` from `@/app/view/agents/memstore`
- Produces: `runAct(model, act)`, `setActState(id, state)`, `clearActState(id)`, `petActStateAtom`

- [ ] **Step 1: Add the act-state atom to `petstore.ts`**

Append to `frontend/app/view/jarvis/petstore.ts` (and add `import type { PetActState } from "./petacts";` beside the existing `petvoice` type import):

```ts
// What each act is doing right now, keyed by PetAct.id. Module-level because the peek unmounts and
// remounts while the creature does not, so an outcome has to outlive the panel that showed it.
//
// Deliberately NOT persisted, unlike the corner and the watermark above: "3 archived" restored from a
// previous launch would be a claim about this session that nothing verified.
export const petActStateAtom = atom<Record<string, PetActState>>({}) as PrimitiveAtom<
    Record<string, PetActState>
>;

export function setActState(id: string, state: PetActState): void {
    globalStore.set(petActStateAtom, { ...globalStore.get(petActStateAtom), [id]: state });
}

export function clearActState(id: string): void {
    const next = { ...globalStore.get(petActStateAtom) };
    delete next[id];
    globalStore.set(petActStateAtom, next);
}
```

- [ ] **Step 2: Write the failing test**

Create `frontend/app/view/jarvis/petactrun.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";

const openORef = vi.fn();
const askAboutSource = vi.fn();
const confirmPruneAllSuperseded = vi.fn();
const takePendingMemoryFocus = vi.fn();
vi.mock("./openref", () => ({ openORef: (...a: any[]) => openORef(...a) }));
vi.mock("./jarvissubjectstore", () => ({ askAboutSource: (...a: any[]) => askAboutSource(...a) }));
vi.mock("@/app/view/agents/memstore", () => ({
    confirmPruneAllSuperseded: (...a: any[]) => confirmPruneAllSuperseded(...a),
    memViewAtom: { init: "list" },
    pendingMemoryFocusAtom: { init: null },
    takePendingMemoryFocus,
}));
vi.mock("@/app/view/agents/settingsstore", () => ({
    pendingSettingsSectionAtom: { init: null },
    SETTINGS_SECTION_EMBEDDINGS: "settings-embeddings",
}));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import type { PetAct } from "./petacts";
import { runAct } from "./petactrun";
import { petActStateAtom, petPeekOpenAtom } from "./petstore";

// the runner only ever reads surfaceAtom off the model, so a bare atom pair is a sufficient stand-in
import { atom } from "jotai";
const model = { surfaceAtom: atom("cockpit") } as any;

afterEach(() => {
    vi.clearAllMocks();
    globalStore.set(petActStateAtom, {});
});

describe("runAct — escorts", () => {
    it("closes the peek before navigating, so an anchored overlay is not stranded", async () => {
        globalStore.set(petPeekOpenAtom, true);
        const act: PetAct = {
            id: "x",
            verb: "open",
            label: "Open",
            target: { kind: "oref", ref: "memnote:abc" },
        };
        await runAct(model, act);
        expect(globalStore.get(petPeekOpenAtom)).toBe(false);
        expect(openORef).toHaveBeenCalledWith(model, "memnote:abc", undefined);
    });

    it("routes the memory escort to the memory surface in list view", async () => {
        const act: PetAct = { id: "v", verb: "open", label: "Review 6", target: { kind: "memory-upkeep" } };
        await runAct(model, act);
        expect(globalStore.get(model.surfaceAtom)).toBe("memory");
        expect(openORef).not.toHaveBeenCalled();
    });

    it("routes the settings escort to the settings surface", async () => {
        const act: PetAct = { id: "s", verb: "open", label: "Set up", target: { kind: "settings-embeddings" } };
        await runAct(model, act);
        expect(globalStore.get(model.surfaceAtom)).toBe("settings");
    });
});

describe("runAct — ask", () => {
    it("seeds the question and lands on Jarvis", async () => {
        const act: PetAct = {
            id: "a",
            verb: "ask",
            label: "Ask",
            seed: { ref: "memnote:abc", sourceType: "memory", title: "a note", prompt: "Tell me more." },
        };
        await runAct(model, act);
        expect(askAboutSource).toHaveBeenCalledWith("memnote:abc", "memory", "a note", "Tell me more.");
        expect(globalStore.get(model.surfaceAtom)).toBe("jarvis");
    });
});

describe("runAct — clear superseded", () => {
    it("hands off to the existing confirm modal and keeps no state of its own", async () => {
        const act: PetAct = {
            id: "vault:clear-superseded",
            verb: "do",
            label: "Clear 2 superseded",
            op: { kind: "clear-superseded", count: 2 },
        };
        await runAct(model, act);
        expect(confirmPruneAllSuperseded).toHaveBeenCalledWith(2);
        expect(globalStore.get(petActStateAtom)["vault:clear-superseded"]).toBeUndefined();
    });

    it("records a failure on the act that caused it, never silently", async () => {
        confirmPruneAllSuperseded.mockImplementation(() => {
            throw new Error("modal host missing");
        });
        const act: PetAct = {
            id: "vault:clear-superseded",
            verb: "do",
            label: "Clear 1 superseded",
            op: { kind: "clear-superseded", count: 1 },
        };
        await runAct(model, act);
        expect(globalStore.get(petActStateAtom)["vault:clear-superseded"]).toEqual({
            status: "error",
            text: "modal host missing",
        });
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/petactrun.test.ts`
Expected: FAIL — `Failed to resolve import "./petactrun"`

- [ ] **Step 4: Write the implementation**

Create `frontend/app/view/jarvis/petactrun.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// How an act runs. The impure half of the pair whose pure half is petacts.ts: that module decides what is
// offered, this one is the only place an act touches the network or a surface.
//
// Every failure lands on the act that caused it (design §9). Never a toast: a silently-failed button is
// worse than no button, because it also spends the attention the panel exists to earn.

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { confirmPruneAllSuperseded, memViewAtom, pendingMemoryFocusAtom } from "@/app/view/agents/memstore";
import { pendingSettingsSectionAtom, SETTINGS_SECTION_EMBEDDINGS } from "@/app/view/agents/settingsstore";
import { askAboutSource } from "./jarvissubjectstore";
import { openORef } from "./openref";
import type { PetAct, PetTarget } from "./petacts";
import { clearActState, petPeekOpenAtom, setActState } from "./petstore";

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// The peek closes before every escort: an overlay anchored to the creature, left open over a surface it just
// navigated away from, is stranded (the same reasoning petpeek.tsx already applies to its Open buttons).
async function escort(model: AgentsViewModel, target: PetTarget): Promise<void> {
    if (target.kind === "oref") {
        await openORef(model, target.ref, target.anchor);
        return;
    }
    if (target.kind === "memory-upkeep") {
        // list view, not merely the memory surface: CleanupQueue is not mounted in graph view, so a bare
        // switch can land on a page where the queue does not exist
        globalStore.set(memViewAtom, "list");
        globalStore.set(pendingMemoryFocusAtom, "upkeep");
        globalStore.set(model.surfaceAtom, "memory");
        return;
    }
    globalStore.set(pendingSettingsSectionAtom, SETTINGS_SECTION_EMBEDDINGS);
    globalStore.set(model.surfaceAtom, "settings");
}

async function perform(act: PetAct & { verb: "do" }): Promise<void> {
    const op = act.op;
    if (op.kind === "clear-superseded") {
        // the confirm modal owns the outcome from here, and pruneAllSuperseded reloads the queue itself, so
        // this act keeps no state: a lingering "done" would outlive a cancelled confirmation
        confirmPruneAllSuperseded(op.count);
        clearActState(act.id);
        return;
    }
    throw new Error(`unwired operation: ${op.kind}`);
}

export async function runAct(model: AgentsViewModel, act: PetAct): Promise<void> {
    if (act.verb === "open") {
        globalStore.set(petPeekOpenAtom, false);
        await escort(model, act.target);
        return;
    }
    if (act.verb === "ask") {
        globalStore.set(petPeekOpenAtom, false);
        askAboutSource(act.seed.ref, act.seed.sourceType, act.seed.title, act.seed.prompt);
        globalStore.set(model.surfaceAtom, "jarvis");
        return;
    }
    setActState(act.id, { status: "running" });
    try {
        await perform(act);
    } catch (e) {
        setActState(act.id, { status: "error", text: errText(e) });
    }
}
```

- [ ] **Step 5: Add the two pending-focus atoms the runner writes**

In `frontend/app/view/agents/memstore.ts`, beside `memSelectedPendingPathAtom`:

```ts
// Where a deep link into Memory should land. Consumed once on mount by the section that owns it, the same
// shape as pendingRunFocusAtom: the cleanup queue is collapsed by default and its open flag is component
// state, so an escort that only switched surface would land on a section the user still has to find.
export const pendingMemoryFocusAtom = atom<"upkeep" | null>(null) as PrimitiveAtom<"upkeep" | null>;

// Read-and-clear, so two mounts cannot both honour one escort.
export function takePendingMemoryFocus(): "upkeep" | null {
    const want = globalStore.get(pendingMemoryFocusAtom);
    if (want != null) {
        globalStore.set(pendingMemoryFocusAtom, null);
    }
    return want;
}
```

Create `frontend/app/view/agents/settingsstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Settings surface's only cross-surface state: which section a deep link wants. Its own file rather
// than an atom exported from settingssurface.tsx, so a caller does not have to import a surface component
// to navigate into it.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";

// The dom id of the section, which is also the value carried through the atom — one string, so the
// scroll target and the request cannot disagree.
export const SETTINGS_SECTION_EMBEDDINGS = "settings-embeddings";

export const pendingSettingsSectionAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

export function takePendingSettingsSection(): string | null {
    const want = globalStore.get(pendingSettingsSectionAtom);
    if (want != null) {
        globalStore.set(pendingSettingsSectionAtom, null);
    }
    return want;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/petactrun.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 7: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/jarvis/petactrun.ts frontend/app/view/jarvis/petactrun.test.ts frontend/app/view/jarvis/petstore.ts frontend/app/view/agents/memstore.ts frontend/app/view/agents/settingsstore.ts
git commit -m "feat(jarvis): the runner an act passes through, so a failure lands on the row that offered it rather than nowhere"
```

---

### Task 3: The escorts land somewhere real

**Files:**
- Modify: `frontend/app/view/agents/cleanupqueue.tsx:61-68`
- Modify: `frontend/app/view/agents/memorysurface.tsx:57-69` (the section list) and its surface component
- Modify: `frontend/app/view/agents/settingssurface.tsx:37-69`
- Test: `frontend/app/view/agents/settingsstore.test.ts` (create)

**Interfaces:**
- Consumes: `takePendingMemoryFocus()`, `takePendingSettingsSection()`, `SETTINGS_SECTION_EMBEDDINGS` (Task 2)
- Produces: nothing new — this task makes Task 2's escorts arrive

- [ ] **Step 1: Write the failing test for consume-once**

Create `frontend/app/view/agents/settingsstore.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it } from "vitest";
import {
    pendingSettingsSectionAtom,
    SETTINGS_SECTION_EMBEDDINGS,
    takePendingSettingsSection,
} from "./settingsstore";

describe("takePendingSettingsSection", () => {
    it("returns nothing when no escort is pending", () => {
        globalStore.set(pendingSettingsSectionAtom, null);
        expect(takePendingSettingsSection()).toBeNull();
    });

    it("honours one escort exactly once, so a remount does not re-scroll", () => {
        globalStore.set(pendingSettingsSectionAtom, SETTINGS_SECTION_EMBEDDINGS);
        expect(takePendingSettingsSection()).toBe(SETTINGS_SECTION_EMBEDDINGS);
        expect(takePendingSettingsSection()).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/settingsstore.test.ts`
Expected: PASS if Task 2 landed correctly (the atom and reader already exist). If it FAILS, Task 2 is incomplete — fix Task 2 before continuing.

- [ ] **Step 3: Make the settings escort arrive**

In `frontend/app/view/agents/settingssurface.tsx`, add the imports (`useEffect` from react, and `SETTINGS_SECTION_EMBEDDINGS`, `takePendingSettingsSection` from `./settingsstore`), then inside `SettingsSurface` before the `return`:

```tsx
    // Deep-link landing. The sections are a flat scroll with no routes and embeddings is the last of seven,
    // so a bare surface switch lands at the top of a long page — an escort in name only.
    useEffect(() => {
        const want = takePendingSettingsSection();
        if (want == null) {
            return;
        }
        document.getElementById(want)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, []);
```

and wrap the last section so it has the id the effect looks for:

```tsx
                    <div id={SETTINGS_SECTION_EMBEDDINGS}>
                        <EmbeddingsSection />
                    </div>
```

- [ ] **Step 4: Make the memory escort arrive**

In `frontend/app/view/agents/cleanupqueue.tsx`, add `useEffect` to the react import and `takePendingMemoryFocus` to the memstore import, then inside `CleanupQueue` above the early return:

```tsx
    const sectionRef = useRef<HTMLElement | null>(null);
    // An escort from the creature's vault row means "show me these": the section is collapsed by default
    // and that flag is component state, so without this the escort lands on a heading the user must still
    // find and expand.
    useEffect(() => {
        if (takePendingMemoryFocus() == null) {
            return;
        }
        setOpen(true);
        sectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, []);
```

Attach the ref to the existing `<section className="mt-[30px]">`: `<section ref={sectionRef} className="mt-[30px]">`.

Add `useRef` to the react import.

In `frontend/app/view/agents/memorysurface.tsx`, inside the surface component, drop an unhonoured escort on unmount so it cannot fire on a later visit (the queue can empty between the poll and the click, in which case `CleanupQueue` returns null and never consumes it):

```tsx
    useEffect(() => () => void takePendingMemoryFocus(), []);
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0

- [ ] **Step 6: Run the full frontend suite for regressions**

Run: `npx vitest run`
Expected: PASS (the baseline suite plus Tasks 1-3's new tests)

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/settingsstore.test.ts frontend/app/view/agents/settingssurface.tsx frontend/app/view/agents/cleanupqueue.tsx frontend/app/view/agents/memorysurface.tsx
git commit -m "feat(memory,settings): a deep link into a flat scroll landed at the top of the page, so the two escort targets now open and scroll to the section that was asked for"
```

---

### Task 4: The peek renders the vault's acts, and the footer stops lying

**Files:**
- Modify: `frontend/app/view/jarvis/petpeek.tsx`

**Interfaces:**
- Consumes: `actsForVault` (Task 1), `runAct` + `petActStateAtom` (Task 2)
- Produces: the `Acts` renderer and a `Row` that accepts acts — both reused by Tasks 6, 8, 10

- [ ] **Step 1: Add the act renderer**

In `frontend/app/view/jarvis/petpeek.tsx`, add imports:

```ts
import { memPruneAtom } from "@/app/view/agents/memstore";
import { actsForVault, type PetAct } from "./petacts";
import { runAct } from "./petactrun";
import { petActStateAtom } from "./petstore";
```

and add above `Row`:

```tsx
// A button per act, and the act's own outcome beside it. The outcome sits here rather than in a toast
// because a failure that appeared somewhere else would spend the attention this panel exists to earn
// (design §9).
function Acts({ model, acts }: { model: AgentsViewModel; acts: PetAct[] }) {
    const state = useAtomValue(petActStateAtom);
    if (acts.length === 0) {
        return null;
    }
    return (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {acts.map((a) => {
                const st = state[a.id];
                return (
                    <span key={a.id} className="flex items-center gap-1.5">
                        <button
                            type="button"
                            data-pet-act={a.id}
                            disabled={st?.status === "running"}
                            onClick={() => fireAndForget(() => runAct(model, a))}
                            className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-accent-soft hover:bg-surface-hover disabled:cursor-default disabled:text-muted"
                        >
                            {a.label}
                        </button>
                        {st?.text != null ? (
                            <span
                                className={cn("text-[11px]", st.status === "error" ? "text-error" : "text-muted")}
                            >
                                {st.text}
                            </span>
                        ) : null}
                    </span>
                );
            })}
        </div>
    );
}
```

- [ ] **Step 2: Let a row carry acts**

Replace the existing `Row` with:

```tsx
function Row({
    label,
    value,
    dim,
    model,
    acts,
}: {
    label: string;
    value: string;
    dim?: boolean;
    model?: AgentsViewModel;
    acts?: PetAct[];
}) {
    return (
        <div className="flex items-baseline gap-2">
            <span className="w-[52px] flex-none font-mono text-[9.5px] font-semibold uppercase tracking-[.09em] text-muted">
                {label}
            </span>
            <div className="min-w-0 flex-1">
                <span className={cn("text-[11.5px] leading-[1.45]", dim ? "text-muted" : "text-secondary")}>
                    {value}
                </span>
                {acts != null && acts.length > 0 && model != null ? <Acts model={model} acts={acts} /> : null}
            </div>
        </div>
    );
}
```

Both `model` and `acts` are optional so the rate-limit row — the one row with honestly nothing to do — stays exactly as it is.

- [ ] **Step 3: Wire the vault row and invert the footer**

Inside `PetPeek`, add `const pruneCandidates = useAtomValue(memPruneAtom);` beside the other atom reads, then give the Vault row its acts:

```tsx
                        <Row
                            label="Vault"
                            value={
                                decay == null
                                    ? "no reading"
                                    : decay.queueDepth === 0
                                      ? "clear"
                                      : `${decay.queueDepth} queued for cleanup · ${decay.staleNotes} stale`
                            }
                            dim={decay == null || decay.queueDepth === 0}
                            model={model}
                            acts={actsForVault(pruneCandidates)}
                        />
```

Replace the trailing filled button with a de-emphasised link — a bare navigation is the least meaningful thing on the panel and should not present as its headline:

```tsx
                    <button
                        type="button"
                        onClick={openJarvis}
                        className="cursor-pointer self-start px-1.5 py-0.5 text-[11px] text-muted hover:text-primary"
                    >
                        Open Jarvis
                    </button>
```

- [ ] **Step 4: Add the scenario hook**

Wrap the panel's children in a container the CDP scenario can scope to — a document-wide `button` query would pick up the app bar:

Immediately inside `<PopoverReveal ...>`, wrap all existing children in:

```tsx
                    <div data-pet-peek="1" className="flex flex-col gap-3">
```

and close it before `</PopoverReveal>`. Remove `flex w-[326px] flex-col gap-3` duplication by leaving the width and border classes on `PopoverReveal` and the layout classes on the inner div.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0

- [ ] **Step 6: Verify in the running app**

With `task dev` running, click the creature and confirm the Vault row shows `Review N` (and `Clear N superseded` when the queue has any), that pressing Review lands on the Memory surface with the cleanup queue expanded and scrolled to, and that Open Jarvis is now a quiet link rather than a filled button.

Run: `node scripts/cdp-shot.mjs cdp-shots/pet-acts-vault.png`
Expected: a PNG showing the panel with act buttons on the Vault row

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/jarvis/petpeek.tsx
git commit -m "feat(jarvis): the vault row counted a queue it would not take you to, so it now offers the queue and the one bulk clear that is mechanical"
```

---

### Task 5: An off-band command to catch the index up

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go:36` (add to the interface)
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvispet.go`
- Test: `pkg/wshrpc/wshserver/wshserver_jarvispet_test.go` (create, or extend if it exists)

**Interfaces:**
- Consumes: `jarvisembed.OpenIndex(ctx)`, `(*Index).Reconcile(ctx, vault)`, `wavevault.OpenVault(ctx)`
- Produces: `EmbedReconcileCommand(ctx) error`, and after `task generate`, `RpcApi.EmbedReconcileCommand(client, opts?)` in TypeScript

- [ ] **Step 1: Write the failing test for the single-flight guard**

Create `pkg/wshrpc/wshserver/wshserver_jarvispet_test.go` (if the file exists, append the test):

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import "testing"

// The guard, not the reconcile. A double-press must not run two whole-vault rebuilds against one index db,
// and the second press is not an error the user should see — it is already happening.
func TestReconcileSingleFlight(t *testing.T) {
	reconcileRunning.Store(false)
	if !tryStartReconcile() {
		t.Fatal("first start should win")
	}
	if tryStartReconcile() {
		t.Error("second start should be refused while the first is running")
	}
	finishReconcile()
	if !tryStartReconcile() {
		t.Error("a start after completion should win again")
	}
	finishReconcile()
}
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/wshrpc/wshserver/ -run TestReconcileSingleFlight
```
Expected: FAIL — `undefined: reconcileRunning`, `undefined: tryStartReconcile`

- [ ] **Step 3: Declare the command**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, add to the `JarvisCommands` interface directly below `GetEmbedIndexStatusCommand`:

```go
	EmbedReconcileCommand(ctx context.Context) error                                                                                        // start catching the embedding index up to the vault; returns as soon as the work is dispatched
```

- [ ] **Step 4: Implement it off-band**

In `pkg/wshrpc/wshserver/wshserver_jarvispet.go`, add `"log"`, `"sync/atomic"`, and `"github.com/wavetermdev/waveterm/pkg/wavevault"` to the imports, then append:

```go
// reconcileRunning single-flights the catch-up. Two concurrent whole-vault rebuilds against one index db
// would race each other's writes, and the second press is not a user error — the work is already happening.
var reconcileRunning atomic.Bool

func tryStartReconcile() bool { return reconcileRunning.CompareAndSwap(false, true) }

func finishReconcile() { reconcileRunning.Store(false) }

// EmbedReconcileCommand dispatches the catch-up and returns immediately. It CANNOT do the work inline:
// wshutil.DefaultTimeoutMs is 5000 and binds the server-side context, while a 373-note build measured
// 5m17s (pkg/jarvisembed/status.go). The frontend learns it finished by re-reading GetEmbedIndexStatus,
// which it already polls — so there is no completion event to invent.
func (ws *WshServer) EmbedReconcileCommand(ctx context.Context) error {
	if !tryStartReconcile() {
		return nil
	}
	// detached: the handler returns in milliseconds and its ctx is cancelled with it, which would kill the
	// reconcile a moment after starting it
	bg := context.WithoutCancel(ctx)
	go func() {
		defer finishReconcile()
		ix, err := jarvisembed.OpenIndex(bg)
		if err != nil {
			log.Printf("[jarvispet] reconcile: open index: %v\n", err)
			return
		}
		defer ix.Close()
		v, err := wavevault.OpenVault(bg)
		if err != nil {
			log.Printf("[jarvispet] reconcile: open vault: %v\n", err)
			return
		}
		st, err := ix.Reconcile(bg, v)
		if err != nil {
			log.Printf("[jarvispet] reconcile: %v\n", err)
			return
		}
		log.Printf("[jarvispet] reconcile: embedded=%d pruned=%d rebuilt=%v\n", st.Embedded, st.Pruned, st.Rebuilt)
	}()
	return nil
}
```

- [ ] **Step 5: Run test to verify it passes**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/wshrpc/wshserver/ -run TestReconcileSingleFlight -v
```
Expected: PASS

- [ ] **Step 6: Regenerate the bindings and rebuild the backend**

Run: `task generate`
Expected: `frontend/app/store/wshclientapi.ts` and `pkg/wshrpc/wshclient/wshclient.go` gain `EmbedReconcileCommand`. Do not hand-edit either.

Run: `task build:backend`
Expected: success — without this the dev app routes the new command against a stale `wavesrv`.

- [ ] **Step 7: Commit**

```bash
git add pkg/wshrpc/wshrpctypes_jarvis.go pkg/wshrpc/wshserver/wshserver_jarvispet.go pkg/wshrpc/wshserver/wshserver_jarvispet_test.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts
git commit -m "feat(jarvis): catching the index up took five minutes against a five-second rpc budget, so the command dispatches the work and returns"
```

---

### Task 6: The recall row acts, and stops promising in prose

**Files:**
- Modify: `frontend/app/view/jarvis/petacts.ts`
- Modify: `frontend/app/view/jarvis/petacts.test.ts`
- Modify: `frontend/app/view/jarvis/petactrun.ts`
- Modify: `frontend/app/view/jarvis/petactrun.test.ts`
- Modify: `frontend/app/view/jarvis/petsources.tsx` (export `loadIndexStatus`)
- Modify: `frontend/app/view/jarvis/petcondition.ts:104-112` and `petcondition.test.ts`
- Modify: `frontend/app/view/jarvis/petpeek.tsx`

**Interfaces:**
- Consumes: `RpcApi.EmbedReconcileCommand` (Task 5), `EmbedIndexStatus` (ambient wire type)
- Produces: `actsForRecall(status)`, `PetOp` gains `{ kind: "reconcile-index" }` handling in the runner

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/jarvis/petacts.test.ts`:

```ts
import { actsForRecall } from "./petacts";

function status(state: string, reason?: string): EmbedIndexStatus {
    return { state, reason, enabled: true, haskey: true, indexednodes: 0, vaultnodes: 0, stalenodes: 0 } as EmbedIndexStatus;
}

describe("actsForRecall", () => {
    it("offers nothing when there is no reading or recall is fine", () => {
        expect(actsForRecall(null)).toEqual([]);
        expect(actsForRecall(status("ok"))).toEqual([]);
    });

    it("offers a catch-up for every stale reason, because reconcile is what fixes all three", () => {
        for (const reason of ["content-drift", "model-mismatch", "not-built"]) {
            expect(actsForRecall(status("stale", reason))).toEqual([
                { id: "recall:catchup", verb: "do", label: "Catch up", op: { kind: "reconcile-index" } },
            ]);
        }
    });

    it("escorts to settings when the cause is configuration, which no operation can fix", () => {
        for (const reason of ["disabled", "no-key"]) {
            expect(actsForRecall(status("off", reason))).toEqual([
                { id: "recall:setup", verb: "open", label: "Set up", target: { kind: "settings-embeddings" } },
            ]);
        }
    });

    it("offers a retry for a transient failure, where the result line is the diagnostic", () => {
        for (const reason of ["provider-error", "index-error", "vault-error"]) {
            expect(actsForRecall(status("off", reason))).toEqual([
                { id: "recall:retry", verb: "do", label: "Retry", op: { kind: "reconcile-index" } },
            ]);
        }
    });

    it("offers nothing for a state it has not been taught, rather than guessing a verb", () => {
        expect(actsForRecall(status("rebuilding"))).toEqual([]);
    });
});
```

Append to `frontend/app/view/jarvis/petactrun.test.ts` — add `EmbedReconcileCommand` to the `RpcApi` mock at the top of the file:

```ts
const embedReconcile = vi.fn();
```
and change the `wshclientapi` mock to:
```ts
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { EmbedReconcileCommand: (...a: any[]) => embedReconcile(...a) },
}));
```
and add the mock for the status re-read:
```ts
vi.mock("./petsources", () => ({ loadIndexStatus: vi.fn(async () => true) }));
```
then append the test:

```ts
describe("runAct — catch up the index", () => {
    it("dispatches the reconcile and stays running, because the work outlives the call", async () => {
        embedReconcile.mockResolvedValue(undefined);
        const act: PetAct = {
            id: "recall:catchup",
            verb: "do",
            label: "Catch up",
            op: { kind: "reconcile-index" },
        };
        await runAct(model, act);
        expect(embedReconcile).toHaveBeenCalledTimes(1);
        expect(globalStore.get(petActStateAtom)["recall:catchup"]).toEqual({
            status: "running",
            text: "catching up",
        });
    });

    it("reports a refused dispatch on the row", async () => {
        embedReconcile.mockRejectedValue(new Error("EC-TIME"));
        const act: PetAct = {
            id: "recall:retry",
            verb: "do",
            label: "Retry",
            op: { kind: "reconcile-index" },
        };
        await runAct(model, act);
        expect(globalStore.get(petActStateAtom)["recall:retry"]).toEqual({ status: "error", text: "EC-TIME" });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/jarvis/petacts.test.ts frontend/app/view/jarvis/petactrun.test.ts`
Expected: FAIL — `actsForRecall is not a function`, and the runner throws `unwired operation: reconcile-index`

- [ ] **Step 3: Add the recall mapping**

In `frontend/app/view/jarvis/petacts.ts`, extend `PetOp`:

```ts
export type PetOp =
    | { kind: "reconcile-index" }
    | { kind: "clear-superseded"; count: number };
```

(already declared in Task 1 — no change needed) and append:

```ts
// pkg/jarvisembed/status.go's off-reasons split cleanly in two: these two are a flag and a credential,
// which is a text entry in Settings and not something an operation can fix. Every other off-reason is a
// failure, and for a failure the result of retrying IS the diagnostic.
const CONFIG_REASONS = new Set(["disabled", "no-key"]);

export function actsForRecall(status: EmbedIndexStatus | null | undefined): PetAct[] {
    if (status == null || status.state === "ok") {
        return [];
    }
    if (status.state === "stale") {
        // all three stale reasons — drifted content, another model, never built — are what Reconcile does
        return [{ id: "recall:catchup", verb: "do", label: "Catch up", op: { kind: "reconcile-index" } }];
    }
    if (status.state !== "off") {
        return []; // a state this build has not been taught: recallLine still reports it, but guessing a verb for it would be worse than offering none
    }
    if (CONFIG_REASONS.has(status.reason ?? "")) {
        return [{ id: "recall:setup", verb: "open", label: "Set up", target: { kind: "settings-embeddings" } }];
    }
    return [{ id: "recall:retry", verb: "do", label: "Retry", op: { kind: "reconcile-index" } }];
}
```

- [ ] **Step 4: Export the index read so the runner can re-read it**

In `frontend/app/view/jarvis/petsources.tsx`, change `async function loadIndexStatus` to `export async function loadIndexStatus` and extend its comment:

```ts
// Exported for petactrun.ts: after a catch-up is dispatched, the 15-minute ambient cadence below is far too
// slow to show that the button did anything, so the runner re-reads on a tight bounded burst of its own.
```

- [ ] **Step 5: Wire the operation in the runner**

In `frontend/app/view/jarvis/petactrun.ts`, add imports:

```ts
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { loadIndexStatus } from "./petsources";
import { petIndexAtom } from "./petstore";
```

and add above `perform`:

```ts
// The ambient index poll is every 15 minutes because the backend parses the whole vault to count drift —
// right for ambient polling, and far too slow the moment the user presses a button. This re-reads on a
// tight cadence for long enough to cover a real build (a 373-note vault measured 5m17s) and then stops,
// clearing the act so the row goes back to speaking for itself.
const CATCHUP_POLL_MS = 30_000;
const CATCHUP_WINDOW_MS = 12 * 60_000;

function watchCatchUp(actId: string): void {
    const deadline = Date.now() + CATCHUP_WINDOW_MS;
    const timer = setInterval(() => {
        void loadIndexStatus().then(() => {
            const caughtUp = globalStore.get(petIndexAtom)?.state === "ok";
            if (caughtUp || Date.now() > deadline) {
                clearInterval(timer);
                clearActState(actId);
            }
        });
    }, CATCHUP_POLL_MS);
}
```

and add the branch to `perform`, above the `clear-superseded` branch:

```ts
    if (op.kind === "reconcile-index") {
        await RpcApi.EmbedReconcileCommand(TabRpcClient);
        // stays "running": the rpc returning means the work STARTED, and claiming done here would be the
        // panel's own version of the lie this whole change removes
        setActState(act.id, { status: "running", text: "catching up" });
        watchCatchUp(act.id);
        return;
    }
```

- [ ] **Step 6: Stop the condition line promising a remedy**

In `frontend/app/view/jarvis/petcondition.ts`, replace the stale branch of `conditionLine`:

```ts
        case "cannot-see":
            // Prose that names an action was the original defect: the panel said "ask me anything and I
            // will catch it up" and offered nowhere to do it. Both lines now state the fact; petacts.ts
            // supplies the verb (design §4.1).
            return expr.reason === "off"
                ? "I cannot see as well right now — embeddings are off, so recall is keyword-only."
                : "My index is behind on some notes.";
```

Update the matching assertion in `frontend/app/view/jarvis/petcondition.test.ts` (search for `catch it up`).

- [ ] **Step 7: Wire the recall row in the peek**

In `frontend/app/view/jarvis/petpeek.tsx`, add `actsForRecall` to the `./petacts` import and give the Recall row its acts (`petIndexAtom`'s raw value is already read as `recall`; capture the status too):

```tsx
    const indexStatus = useAtomValue(petIndexAtom);
    const recall = recallLine(indexStatus);
```

```tsx
                        <Row
                            label="Recall"
                            value={recall.text}
                            dim={recall.dim}
                            model={model}
                            acts={actsForRecall(indexStatus)}
                        />
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: PASS — including the updated `petcondition.test.ts`

- [ ] **Step 9: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0

- [ ] **Step 10: Commit**

```bash
git add frontend/app/view/jarvis/petacts.ts frontend/app/view/jarvis/petacts.test.ts frontend/app/view/jarvis/petactrun.ts frontend/app/view/jarvis/petactrun.test.ts frontend/app/view/jarvis/petsources.tsx frontend/app/view/jarvis/petcondition.ts frontend/app/view/jarvis/petcondition.test.ts frontend/app/view/jarvis/petpeek.tsx
git commit -m "feat(jarvis): the top-priority row named its own remedy in prose and offered nowhere to do it, so recall now catches itself up from the panel"
```

---

### Task 7: The gate's phase index reaches the frontend

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_channels.go:109-119`
- Modify: `pkg/jarvis/attention.go` (the gate branch of `BuildAttention`)
- Modify: `pkg/jarvis/attention_test.go`

**Interfaces:**
- Consumes: `reviewGateIdx(run)` (`pkg/jarvis/attention.go:53`)
- Produces: `AttentionItem.PhaseIdx` on the wire, surfacing as `phaseidx` in `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Write the failing test**

Append to `pkg/jarvis/attention_test.go`:

```go
// The frontend must be able to resolve a gate without re-deriving which phase it is: reviewGateIdx encodes
// a precedence rule, and a second implementation in TypeScript is how the two drift.
func TestBuildAttentionCarriesTheGatePhaseIndex(t *testing.T) {
	items := BuildAttention(AttentionInput{Channels: []AttentionChannel{{
		OID:  "ch1",
		Name: "wave",
		Runs: []*waveobj.Run{{
			OID:  "run1",
			Goal: "refactor the parser",
			Phases: []waveobj.RunPhase{
				{State: "done"},
				{Gate: true, State: "done", DoneTs: 1000},
				{State: "pending"},
			},
		}},
	}}})
	if len(items) != 1 {
		t.Fatalf("expected one gate item, got %d", len(items))
	}
	if items[0].PhaseIdx != 1 {
		t.Errorf("PhaseIdx = %d, want 1 (the gate phase reviewGateIdx found)", items[0].PhaseIdx)
	}
}
```

Check the existing tests in that file for the exact `waveobj.Run` / `RunPhase` construction style and match it — if `Phases` uses a different field name or the helper builds runs differently, follow the file.

- [ ] **Step 2: Run test to verify it fails**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/jarvis/ -run TestBuildAttentionCarriesTheGatePhaseIndex
```
Expected: FAIL — `items[0].PhaseIdx undefined`

- [ ] **Step 3: Add the field**

In `pkg/wshrpc/wshrpctypes_channels.go`, inside `AttentionItem`:

```go
	PhaseIdx     int    `json:"phaseidx"` // gate items only: the phase AdvanceRun must address to approve or send back
```

- [ ] **Step 4: Populate it**

In `pkg/jarvis/attention.go`, in the gate append inside `BuildAttention`, add `PhaseIdx: idx,` beside `WaitingSince: run.Phases[idx].DoneTs,`.

- [ ] **Step 5: Run test to verify it passes**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/jarvis/ -run TestBuildAttention -v
```
Expected: PASS, including every pre-existing `TestBuildAttention*`

- [ ] **Step 6: Regenerate and rebuild**

Run: `task generate` then `task build:backend`
Expected: `frontend/types/gotypes.d.ts` gains `phaseidx` on `AttentionItem`

- [ ] **Step 7: Commit**

```bash
git add pkg/wshrpc/wshrpctypes_channels.go pkg/jarvis/attention.go pkg/jarvis/attention_test.go frontend/types/gotypes.d.ts
git commit -m "fix(jarvis): the server computed which phase a gate was waiting at and threw it away, so nothing outside a channel could resolve one"
```

---

### Task 8: The waiting row becomes the waiting items, with borrowed authority

**Files:**
- Modify: `frontend/app/view/jarvis/petacts.ts`
- Modify: `frontend/app/view/jarvis/petacts.test.ts`
- Modify: `frontend/app/view/jarvis/petactrun.ts`
- Modify: `frontend/app/view/jarvis/petactrun.test.ts`
- Modify: `frontend/app/view/jarvis/petpeek.tsx`

**Interfaces:**
- Consumes: `AttentionItem.phaseidx` (Task 7); `tierFromMeta(meta)` from `@/app/view/agents/channelmessages`; `approveGate(channelId, runId, gateIdx)` and `sendBackGate(channelId, runId, gateIdx)` from `@/app/view/agents/runactions`; `channelAtom(oid)` or the channels list for the target channel's meta
- Produces: `actsForAttention(item, tier)`, `PetOp` gains the `gate` variant

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/jarvis/petacts.test.ts`:

```ts
import { actsForAttention } from "./petacts";

function gate(): AttentionItem {
    return {
        kind: "gate",
        key: "gate:run1",
        channelid: "ch1",
        channelname: "wave",
        runid: "run1",
        phaseidx: 1,
        source: "refactor the parser",
        text: "Approve before Jarvis proceeds.",
        action: "Review",
        waitingsince: 1000,
    } as AttentionItem;
}

describe("actsForAttention", () => {
    it("always escorts to the waiting thing, whatever the tier", () => {
        expect(actsForAttention(gate(), "concierge").map((a) => a.label)).toEqual(["Open"]);
    });

    it("adds the resolving verbs only where the target channel granted that authority", () => {
        expect(actsForAttention(gate(), "delegator").map((a) => a.label)).toEqual([
            "Open",
            "Approve",
            "Send back",
        ]);
        expect(actsForAttention(gate(), "gatekeeper").map((a) => a.label)).toEqual(["Open"]);
    });

    it("addresses the run through the phase the server named", () => {
        const acts = actsForAttention(gate(), "delegator");
        expect(acts[1]).toMatchObject({
            verb: "do",
            op: { kind: "gate", channelId: "ch1", runId: "run1", phaseIdx: 1, action: "approve" },
        });
    });

    it("offers only an escort for a kind that has no resolving verb", () => {
        const esc = { ...gate(), kind: "escalation", key: "esc:m1" } as AttentionItem;
        expect(actsForAttention(esc, "delegator").map((a) => a.label)).toEqual(["Open"]);
    });

    it("offers nothing at all for an item with no run to address", () => {
        const orphan = { ...gate(), runid: "" } as AttentionItem;
        expect(actsForAttention(orphan, "delegator")).toEqual([]);
    });
});
```

Append to `frontend/app/view/jarvis/petactrun.test.ts` — add the runactions mock at the top:

```ts
const approveGate = vi.fn();
const sendBackGate = vi.fn();
vi.mock("@/app/view/agents/runactions", () => ({
    approveGate: (...a: any[]) => approveGate(...a),
    sendBackGate: (...a: any[]) => sendBackGate(...a),
}));
```
and the test:

```ts
describe("runAct — resolve a gate", () => {
    it("approves through the existing helper and says so on the row", async () => {
        approveGate.mockResolvedValue(undefined);
        const act: PetAct = {
            id: "gate:run1:approve",
            verb: "do",
            label: "Approve",
            op: { kind: "gate", channelId: "ch1", runId: "run1", phaseIdx: 1, action: "approve" },
        };
        await runAct(model, act);
        expect(approveGate).toHaveBeenCalledWith("ch1", "run1", 1);
        expect(globalStore.get(petActStateAtom)["gate:run1:approve"]).toEqual({
            status: "done",
            text: "approved",
        });
    });

    it("sends back through the existing helper", async () => {
        sendBackGate.mockResolvedValue(undefined);
        const act: PetAct = {
            id: "gate:run1:sendback",
            verb: "do",
            label: "Send back",
            op: { kind: "gate", channelId: "ch1", runId: "run1", phaseIdx: 1, action: "sendback" },
        };
        await runAct(model, act);
        expect(sendBackGate).toHaveBeenCalledWith("ch1", "run1", 1);
        expect(globalStore.get(petActStateAtom)["gate:run1:sendback"]).toEqual({
            status: "done",
            text: "sent back",
        });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/jarvis/petacts.test.ts frontend/app/view/jarvis/petactrun.test.ts`
Expected: FAIL — `actsForAttention is not a function`

- [ ] **Step 3: Extend the operation set and add the mapping**

In `frontend/app/view/jarvis/petacts.ts`, extend `PetOp`:

```ts
export type PetOp =
    | { kind: "reconcile-index" }
    | { kind: "clear-superseded"; count: number }
    | { kind: "gate"; channelId: string; runId: string; phaseIdx: number; action: "approve" | "sendback" };
```

and append:

```ts
// pkg/jarvis/attention.go's kind for a run parked at a review gate. Only this kind has a resolving verb:
// an escalation needs a written answer and an ask needs a picked option, neither of which is a button.
const ATTENTION_GATE = "gate";

// The creature holds no tier of its own — there is no client-level or global tier anywhere in the app — so
// authority is a property of the creature-and-target pair (pet design §6). `tier` is the TARGET channel's,
// read through tierFromMeta by the caller. Carrying, holding and escorting need no trust model at all,
// which is why Open is unconditional.
export function actsForAttention(item: AttentionItem, tier: JarvisTier): PetAct[] {
    if (!item?.runid) {
        return []; // nothing addressable: an item with no run cannot be opened or resolved
    }
    const acts: PetAct[] = [
        {
            id: `${item.key}:open`,
            verb: "open",
            label: "Open",
            target: { kind: "oref", ref: `run:${item.runid}` },
        },
    ];
    if (item.kind !== ATTENTION_GATE || tier !== "delegator") {
        return acts;
    }
    const base = { channelId: item.channelid ?? "", runId: item.runid, phaseIdx: item.phaseidx ?? 0 };
    acts.push({
        id: `${item.key}:approve`,
        verb: "do",
        label: "Approve",
        op: { kind: "gate", ...base, action: "approve" },
    });
    acts.push({
        id: `${item.key}:sendback`,
        verb: "do",
        label: "Send back",
        op: { kind: "gate", ...base, action: "sendback" },
    });
    // Triage is deliberately absent: it needs a verdict and a one-line reason, which is a form and not a
    // button. The Open escort covers it.
    return acts;
}
```

`JarvisTier` is exported from `@/app/view/agents/channelmessages` — import the type at the top of `petacts.ts`:

```ts
import type { JarvisTier } from "@/app/view/agents/channelmessages";
```

Confirm the exported name and its values (`concierge | gatekeeper | delegator`) at `frontend/app/view/agents/channelmessages.ts:65-74` before relying on it; if the type has another name, use the real one in both the module and the test.

- [ ] **Step 4: Wire the operation in the runner**

In `frontend/app/view/jarvis/petactrun.ts`, add the import:

```ts
import { approveGate, sendBackGate } from "@/app/view/agents/runactions";
```

and add to `perform`, above the `clear-superseded` branch:

```ts
    if (op.kind === "gate") {
        if (op.action === "approve") {
            await approveGate(op.channelId, op.runId, op.phaseIdx);
        } else {
            await sendBackGate(op.channelId, op.runId, op.phaseIdx);
        }
        // stays "done" rather than clearing: the attention poll drops the item within ten seconds, and
        // until it does, a resolved gate whose button went quiet would read as a click that missed
        setActState(act.id, { status: "done", text: op.action === "approve" ? "approved" : "sent back" });
        return;
    }
```

With all three operations handled the trailing `throw new Error(\`unwired operation: ...\`)` becomes
unreachable. Leave it: it is the exhaustiveness backstop that makes adding a fourth operation without wiring
it a runtime error on the row rather than a silently dead button.

- [ ] **Step 5: Replace the Waiting row with the waiting items**

In `frontend/app/view/jarvis/petpeek.tsx`, add imports:

```ts
import { attentionAtom } from "@/app/view/agents/attentionstore";
import { channelsAtom } from "@/app/view/agents/channelsstore";
import { tierFromMeta } from "@/app/view/agents/channelmessages";
import { actsForAttention } from "./petacts";
```

Verify `channelsAtom`'s exported name and element shape in `frontend/app/view/agents/channelsstore.ts` before use; the goal is to reach the target channel's `meta` for `tierFromMeta`.

Add a component above `PetPeek`:

```tsx
// The waiting row was one sentence for any number of waiting things. It is the items themselves now: what
// is waiting, how long it has waited, and what you can do about it without leaving the panel.
function Waiting({ model }: { model: AgentsViewModel }) {
    const items = useAtomValue(attentionAtom);
    const channels = useAtomValue(channelsAtom);
    const now = useAtomValue(model.nowAtom);
    if (items.length === 0) {
        return <Row label="Waiting" value="nothing waiting" dim />;
    }
    return (
        <div className="flex items-baseline gap-2">
            <span className="w-[52px] flex-none font-mono text-[9.5px] font-semibold uppercase tracking-[.09em] text-muted">
                Waiting
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
                {items.map((item) => {
                    const channel = channels.find((c) => c.oid === item.channelid);
                    const tier = tierFromMeta(channel?.meta);
                    return (
                        <div key={item.key} className="flex flex-col gap-0.5">
                            <span className="text-[11.5px] leading-[1.45] text-secondary">
                                {item.source || item.text}
                            </span>
                            <span className="font-mono text-[9.5px] text-muted">
                                {item.action} · waiting {ageLabel(Math.max(0, now - item.waitingsince))}
                            </span>
                            <Acts model={model} acts={actsForAttention(item, tier)} />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
```

Replace the existing Waiting `<Row .../>` with `<Waiting model={model} />`. The `posture` prop and `postureLine` import become unused in this file — remove the import if nothing else uses it, but leave `postureLine` in `petcondition.ts` (the bubble and the creature's face still use the posture vocabulary).

- [ ] **Step 6: Run the tests**

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: PASS

- [ ] **Step 7: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/jarvis/petacts.ts frontend/app/view/jarvis/petacts.test.ts frontend/app/view/jarvis/petactrun.ts frontend/app/view/jarvis/petactrun.test.ts frontend/app/view/jarvis/petpeek.tsx
git commit -m "feat(jarvis): a review gate was a sentence saying something waited, so the panel now lists what waits and resolves it where the target channel granted that"
```

---

### Task 9: A distillation pass stops discarding what it wrote

**Files:**
- Modify: `pkg/memvault/learn.go:110-145`
- Modify: `pkg/memvault/route_test.go`
- Modify: `pkg/baseds/baseds.go:75-94`
- Modify: `pkg/memdistill/coordinator.go:31,115-158`
- Modify: `pkg/memdistill/coordinator_test.go:42-66`

**Interfaces:**
- Produces: `memvault.RouteResult{Committed, Queued int, Written []WrittenNote}`, `memvault.WrittenNote{ID, Title}`, `baseds.MemoryActivityNote{Id, Title}`, `MemoryActivityData.Notes`
- Breaking change: `RouteLearnings`'s signature and the `routeFn` field type both change — every call site is listed below

- [ ] **Step 1: Write the failing tests**

Append to `pkg/memvault/route_test.go`:

```go
// The identities were computed and dropped: WriteLearning returns the slug it wrote and RouteLearnings threw
// it away, which is why the creature could only ever announce a count.
func TestRouteLearningsReportsWhatItWrote(t *testing.T) {
	// follow this file's existing setup for hub/vault temp dirs — copy it from
	// TestRouteLearnings_CorrectionCommitsNonCorrectionQueues rather than inventing a second arrangement
	res, err := RouteLearnings(cwd, []LearnCandidate{
		{Type: "feedback", Body: "prefer tailwind over scss\nmore detail", IsCorrection: true},
	}, nil)
	if err != nil {
		t.Fatalf("RouteLearnings: %v", err)
	}
	if res.Committed != 1 {
		t.Fatalf("Committed = %d, want 1", res.Committed)
	}
	if len(res.Written) != 1 {
		t.Fatalf("Written = %+v, want one note", res.Written)
	}
	if res.Written[0].ID == "" {
		t.Error("a written note with no id cannot be opened from the peek, which is the whole point")
	}
	if res.Written[0].Title != "prefer tailwind over scss" {
		t.Errorf("Title = %q, want the note's first line", res.Written[0].Title)
	}
}

// A candidate that deduped against an existing fact wrote nothing, so it is not a product.
func TestRouteLearningsOmitsADedupedCandidate(t *testing.T) {
	// arrange the same candidate twice; the second call must report no written notes
}
```

Append to `pkg/memdistill/coordinator_test.go`:

```go
// One event per pass, always — the frontend decides whether it is worth saying. Suppressing a barren pass
// here would leave the peek's last-pass row with no data, which is how a pipeline that runs and writes
// nothing becomes invisible.
func TestFlush_PublishesOneActivityPerPassCarryingItsNotes(t *testing.T) {
	got := captureActivity(t)
	path := filepath.Join(t.TempDir(), "q.json")
	d := newDistiller(path)
	d.distillFn = func(claudePath, model, corpus string) (string, bool) {
		return `{"candidates":[{"type":"feedback","body":"x","iscorrection":true}],"references":[]}`, true
	}
	d.routeFn = func(cwd string, cands []memvault.LearnCandidate, refs []string) (memvault.RouteResult, error) {
		return memvault.RouteResult{
			Committed: 1,
			Written:   []memvault.WrittenNote{{ID: "prefer-x-ab12", Title: "prefer x"}},
		}, nil
	}
	d.enqueue("/repo/a", "/t/1.jsonl", "/usr/bin/claude")
	d.flush("/repo/a")
	if len(*got) != 1 {
		t.Fatalf("published %d events, want exactly 1 per pass: %+v", len(*got), *got)
	}
	ev := (*got)[0]
	if ev.Kind != baseds.MemoryActivity_DistillBatch {
		t.Errorf("Kind = %q, want %q", ev.Kind, baseds.MemoryActivity_DistillBatch)
	}
	if len(ev.Notes) != 1 || ev.Notes[0].Id != "prefer-x-ab12" || ev.Notes[0].Title != "prefer x" {
		t.Errorf("Notes = %+v, want the one note the pass wrote", ev.Notes)
	}
}

func TestFlush_PublishesABarrenPassWithNoNotes(t *testing.T) {
	got := captureActivity(t)
	path := filepath.Join(t.TempDir(), "q.json")
	d := newDistiller(path)
	d.distillFn = func(claudePath, model, corpus string) (string, bool) {
		return `{"candidates":[],"references":[]}`, true
	}
	d.routeFn = func(cwd string, cands []memvault.LearnCandidate, refs []string) (memvault.RouteResult, error) {
		return memvault.RouteResult{}, nil
	}
	d.enqueue("/repo/a", "/t/1.jsonl", "/usr/bin/claude")
	d.flush("/repo/a")
	if len(*got) != 1 {
		t.Fatalf("published %d events, want 1: a pass that wrote nothing is still a pass the panel reports", len(*got))
	}
	if len((*got)[0].Notes) != 0 {
		t.Errorf("Notes = %+v, want none", (*got)[0].Notes)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/memvault/ ./pkg/memdistill/
```
Expected: FAIL to compile — `res.Committed undefined`, `memvault.RouteResult undefined`

- [ ] **Step 3: Return the identities from the vault writer**

In `pkg/memvault/learn.go`, above `RouteLearnings`:

```go
// WrittenNote identifies one note a routing pass actually created. ID is the slug, which is also the note's
// frontmatter `name` and therefore the id memvault's scan reports — so a caller can address it without a
// second lookup. Title is the note's first line, which is what its `description` carries.
type WrittenNote struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// RouteResult is what a routing pass did. The counts were always returned; the identities were computed at
// the write and discarded, which left every consumer able to announce a volume and nothing else.
type RouteResult struct {
	Committed int
	Queued    int
	Written   []WrittenNote
}
```

Change the signature and body:

```go
func RouteLearnings(cwd string, candidates []LearnCandidate, references []string) (RouteResult, error) {
	hub := HubDirForCwd(cwd)
	var res RouteResult
	for _, cand := range candidates {
		if cand.IsCorrection {
			target := hub
			if target == "" {
				target = DefaultVaultPath()
			}
			wrote, slug, err := WriteLearning(target, cand)
			if err != nil {
				return res, fmt.Errorf("writing learning: %w", err)
			}
			if wrote {
				res.Committed++
				// only a note that was actually created is a product: a deduped candidate carries a slug
				// but wrote no file, and offering to open it would be a dead button
				res.Written = append(res.Written, WrittenNote{ID: slug, Title: firstLine(cand.Body)})
			}
		} else {
			if _, err := WritePending(PendingDir(), cand, cwd); err != nil {
				return res, fmt.Errorf("queuing candidate: %w", err)
			}
			res.Queued++
		}
	}
	if hub != "" {
		for _, cand := range candidates {
			if cand.Supersedes != "" {
				_, slug, _ := WriteLearning(hub, LearnCandidate{Type: cand.Type, Scope: cand.Scope, Body: cand.Body})
				_ = MarkSuperseded(hub, cand.Supersedes, slug)
			}
		}
		if len(references) > 0 {
			_ = TouchReferenced(hub, references, time.Now().UTC().Format(time.RFC3339))
		}
	}
	return res, nil
}
```

`firstLine` is already used by `WriteLearning` in this package — reuse it, do not add a second helper.

- [ ] **Step 4: Carry the notes on the wire**

In `pkg/baseds/baseds.go`, above `MemoryActivityData`:

```go
// MemoryActivityNote is one note a pass wrote, addressable: Id is the vault slug, which is the id the
// memory scan reports, so the frontend can open it without resolving anything.
type MemoryActivityNote struct {
	Id    string `json:"id"`
	Title string `json:"title"`
}
```

and inside `MemoryActivityData`:

```go
	Notes     []MemoryActivityNote `json:"notes,omitempty"` // what the pass wrote; empty means it produced nothing
```

Delete the now-unused `MemoryActivity_NotesWritten` constant.

- [ ] **Step 5: Publish one event per pass**

In `pkg/memdistill/coordinator.go`, change the `routeFn` field type (line 31):

```go
	routeFn   func(cwd string, cands []memvault.LearnCandidate, refs []string) (memvault.RouteResult, error)
```

Change the call and the publish block:

```go
	var res memvault.RouteResult
	if len(cands) > 0 || len(refs) > 0 {
		var rerr error
		res, rerr = d.routeFn(cwd, cands, refs)
		if rerr != nil {
			log.Printf("[memdistill] route learnings: %v\n", rerr)
			return
		}
	}
```

(keep the bucket-clearing block between them unchanged), then replace the two publishes at the end with one:

```go
	// One event per pass, carrying what the pass produced. It used to be two — "I did some work" and "here
	// is what I now believe" — on the argument that they are separate facts. They are, but the first alone
	// is an utterance with nothing behind it, and the panel's own last-pass row is where a pass that wrote
	// nothing belongs. Publishing unconditionally is what keeps that row honest: the frontend decides
	// whether a pass is worth SAYING, and a barren pass suppressed here would be invisible instead of quiet.
	notes := make([]baseds.MemoryActivityNote, 0, len(res.Written))
	for _, w := range res.Written {
		notes = append(notes, baseds.MemoryActivityNote{Id: w.ID, Title: w.Title})
	}
	PublishActivity(baseds.MemoryActivityData{
		Kind: baseds.MemoryActivity_DistillBatch, Cwd: cwd, Sessions: len(sessions),
		Committed: res.Committed, Queued: res.Queued, Notes: notes,
	})
```

- [ ] **Step 6: Fix the other call sites**

Search for every remaining caller and update it:

```bash
grep -rn "RouteLearnings\|routeFn" --include=*.go pkg/ cmd/
```

Expected sites: `pkg/memdistill/coordinator.go:40` (the `memvault.RouteLearnings` default — no change needed, the signature matches), `pkg/memdistill/coordinator_test.go:49` and `:70`-ish (the stub `routeFn`s — update each to return `memvault.RouteResult`), plus any `MemoryLearnCommand` handler in `pkg/wshrpc/wshserver` that calls `RouteLearnings` directly. Update each to the struct return.

- [ ] **Step 7: Run the tests**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/memvault/ ./pkg/memdistill/ ./pkg/wshrpc/...
```
Expected: PASS, including the four new tests

- [ ] **Step 8: Regenerate and rebuild**

Run: `task generate` then `task build:backend`
Expected: `MemoryActivityData` in `frontend/types/gotypes.d.ts` gains `notes`

- [ ] **Step 9: Commit**

```bash
git add pkg/memvault/learn.go pkg/memvault/route_test.go pkg/baseds/baseds.go pkg/memdistill/coordinator.go pkg/memdistill/coordinator_test.go frontend/types/gotypes.d.ts
git commit -m "feat(memory): a distillation pass knew exactly which notes it wrote and reported only how many, so the pass now carries its products"
```

---

### Task 10: One utterance per pass, carrying what it wrote

**Files:**
- Modify: `frontend/app/view/jarvis/petvoice.ts:25-42`
- Modify: `frontend/app/view/jarvis/petjoin.ts:56-96`
- Modify: `frontend/app/view/jarvis/petjoin.test.ts`
- Modify: `frontend/app/view/jarvis/petbubble.tsx:34`
- Modify: `frontend/app/view/jarvis/petpeek.tsx:186-239`

**Interfaces:**
- Consumes: `MemoryActivityData.notes` (Task 9)
- Produces: `PetEvent.sources?: PetEventSource[]` replacing `PetEvent.source?: PetEventSource`

- [ ] **Step 1: Write the failing tests**

In `frontend/app/view/jarvis/petjoin.test.ts`, replace the distillation and notes-written cases with:

```ts
describe("eventFromActivity — a pass carries its products or is not said", () => {
    it("names what it wrote and offers each note as a source", () => {
        const ev = eventFromActivity({
            kind: "distill-batch",
            id: "a1",
            ts: 1000,
            cwd: "/repo",
            sessions: 8,
            committed: 3,
            notes: [
                { id: "prefer-tailwind-ab12", title: "prefer tailwind over scss" },
                { id: "cgo-header-path-cd34", title: "cgo needs a windows include path" },
                { id: "no-jsdom-tests-ef56", title: "no jsdom render tests" },
            ],
        } as MemoryActivityData);
        expect(ev?.text).toBe("I went back over 8 sessions and wrote down 3 things.");
        expect(ev?.sources?.map((s) => s.ref)).toEqual([
            "memnote:prefer-tailwind-ab12",
            "memnote:cgo-header-path-cd34",
            "memnote:no-jsdom-tests-ef56",
        ]);
        expect(ev?.sources?.[0].title).toBe("prefer tailwind over scss");
        expect(ev?.sources?.[0].sourceType).toBe("memory");
    });

    it("says nothing at all for a pass that wrote nothing", () => {
        expect(
            eventFromActivity({
                kind: "distill-batch",
                id: "a2",
                ts: 1000,
                cwd: "/repo",
                sessions: 8,
                notes: [],
            } as MemoryActivityData)
        ).toBeNull();
    });

    it("uses the singular for one note", () => {
        const ev = eventFromActivity({
            kind: "distill-batch",
            id: "a3",
            ts: 1000,
            sessions: 1,
            notes: [{ id: "x-ab12", title: "x" }],
        } as MemoryActivityData);
        expect(ev?.text).toBe("I went back over 1 session and wrote down 1 thing.");
    });

    it("still reports a sweep, which already only speaks when it archived something", () => {
        const ev = eventFromActivity({
            kind: "sweep",
            id: "s1",
            ts: 1000,
            archived: 12,
        } as MemoryActivityData);
        expect(ev?.text).toBe("I tidied the vault — 12 notes archived.");
    });
});
```

Also update the existing volunteered-knowledge tests in that file: `eventFromVolunteer` now sets `sources` (a one-element list) rather than `source`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/jarvis/petjoin.test.ts`
Expected: FAIL — `notes-written` handling still present, `sources` undefined

- [ ] **Step 3: Widen the event type**

In `frontend/app/view/jarvis/petvoice.ts`, drop `"notes-written"` from the `kind` union and replace the `source` field:

```ts
    // Set on any utterance that has products to open: volunteered knowledge carries one, a distillation
    // pass carries the notes it wrote. An utterance with none is either housekeeping that produced nothing
    // openable, or (for a pass) not said at all — see petjoin.ts.
    sources?: PetEventSource[];
```

- [ ] **Step 4: Rewrite the activity adapter**

In `frontend/app/view/jarvis/petjoin.ts`, replace the activity block:

```ts
const ACTIVITY_KINDS = ["sweep", "distill-batch"] as const;
type ActivityKind = (typeof ACTIVITY_KINDS)[number];

function notes(n: number): string {
    return n === 1 ? "1 note" : `${n} notes`;
}

function things(n: number): string {
    return n === 1 ? "1 thing" : `${n} things`;
}

function sessions(n: number | undefined): string {
    if (n == null || n <= 0) {
        return "your recent sessions";
    }
    return n === 1 ? "1 session" : `${n} sessions`;
}

// First person, matching conditionLine in petcondition.ts — the creature is Jarvis with a face, not a
// separate character (design §2), and one voice means one register everywhere.
function activityText(kind: ActivityKind, d: MemoryActivityData): string {
    switch (kind) {
        case "sweep":
            return `I tidied the vault — ${notes(d.archived ?? 0)} archived.`;
        case "distill-batch":
            return `I went back over ${sessions(d.sessions)} and wrote down ${things((d.notes ?? []).length)}.`;
    }
}

// A memory:activity event becomes at most one utterance.
//
// A distillation pass that wrote nothing yields NO utterance: an utterance has to carry the thing it is
// about (design §2 corollary 2), and "I did some work" carries nothing. The pass is still reported — the
// backend publishes every pass and petsources.tsx records it for the peek's last-pass row — so a pipeline
// that keeps producing nothing is visible as a level rather than announced as an event.
export function eventFromActivity(d: MemoryActivityData | null | undefined): PetEvent | null {
    const kind = d?.kind;
    if (d == null || kind == null || !(ACTIVITY_KINDS as readonly string[]).includes(kind)) {
        return null;
    }
    if (!d.id || !d.ts) {
        return null; // no stable id or no timestamp means the watermark cannot order it
    }
    const written = d.notes ?? [];
    if (kind === "distill-batch" && written.length === 0) {
        return null;
    }
    return {
        id: d.id,
        at: d.ts,
        kind: kind as ActivityKind,
        text: activityText(kind as ActivityKind, d),
        // memnote:<slug> is the id memvault's scan reports, so openORef routes it with no lookup
        sources: written.map((n) => ({ ref: `memnote:${n.id}`, title: n.title || n.id, sourceType: "memory" })),
    };
}
```

In `eventFromVolunteer`, change the `source:` field to:

```ts
        sources: d.ref
            ? [{ ref: d.ref, anchor: d.anchor || undefined, title: title || d.ref, sourceType: d.sourcetype ?? "" }]
            : undefined,
```

- [ ] **Step 5: Drop the removed kind from the bubble**

In `frontend/app/view/jarvis/petbubble.tsx`, remove the `"notes-written"` entry from the label record.

- [ ] **Step 6: Render every product in the peek**

In `frontend/app/view/jarvis/petpeek.tsx`, replace the single-source Open/Ask block inside the "What I've said" list with a per-source pair built from the act model. Add to the imports:

```ts
import { memLoadedAtom, memNotesAtom } from "@/app/view/agents/memstore";
import { actsForEvent } from "./petacts";
```

Confirm the loaded-flag atom's exported name in `frontend/app/view/agents/memstore.ts` (it is the flag set once a scan has landed) and use the real name.

Inside `PetPeek`:

```tsx
    const memNotes = useAtomValue(memNotesAtom);
    const memLoaded = useAtomValue(memLoadedAtom);
    // three-state on purpose: loadMemory() only runs when the Memory surface is visited, so "not scanned"
    // must not read as "note gone" — that would suppress every product's Open button almost always
    const noteExists = (id: string): boolean | undefined =>
        memLoaded ? memNotes.some((n) => n.id === id) : undefined;
```

and replace the `e.source != null ? (...) : null` block with:

```tsx
                                        <Acts model={model} acts={actsForEvent(e, noteExists)} />
```

- [ ] **Step 7: Add the event mapping**

Append to `frontend/app/view/jarvis/petacts.ts`:

```ts
// Open and Ask per product. `noteExists` is three-state and passed in rather than read: undefined means
// "not scanned yet", which must not suppress the button — the memory scan only runs when that surface is
// visited, so treating unknown as absent would hide almost every Open there is (design §9).
export function actsForEvent(
    event: { id: string; sources?: PetEventSource[] },
    noteExists: (id: string) => boolean | undefined
): PetAct[] {
    const acts: PetAct[] = [];
    for (const s of event.sources ?? []) {
        const noteId = s.ref.startsWith("memnote:") ? s.ref.slice("memnote:".length) : null;
        if (noteId != null && noteExists(noteId) === false) {
            continue; // known absent: openORef would no-op, and a dead click target is worse than none
        }
        acts.push({
            id: `${event.id}:${s.ref}:open`,
            verb: "open",
            label: `Open ${s.title}`,
            target: { kind: "oref", ref: s.ref, anchor: s.anchor },
        });
        acts.push({
            id: `${event.id}:${s.ref}:ask`,
            verb: "ask",
            label: "Ask",
            seed: {
                ref: s.ref,
                sourceType: s.sourceType,
                title: s.title,
                prompt: `Tell me more about "${s.title}".`,
            },
        });
    }
    return acts;
}
```

Import the type at the top of `petacts.ts`: `import type { PetEventSource } from "./petvoice";` — `petvoice.ts` is pure, so this adds no impure dependency.

Add tests for it in `petacts.test.ts`:

```ts
import { actsForEvent } from "./petacts";

describe("actsForEvent", () => {
    const ev = {
        id: "a1",
        sources: [
            { ref: "memnote:kept-ab12", title: "kept", sourceType: "memory" },
            { ref: "memnote:gone-cd34", title: "gone", sourceType: "memory" },
        ],
    };

    it("offers Open and Ask for each product", () => {
        expect(actsForEvent(ev, () => true).map((a) => a.label)).toEqual([
            "Open kept",
            "Ask",
            "Open gone",
            "Ask",
        ]);
    });

    it("drops a product the scan says is gone", () => {
        expect(actsForEvent(ev, (id) => id !== "gone-cd34").map((a) => a.label)).toEqual(["Open kept", "Ask"]);
    });

    it("keeps every product while the scan is unknown, rather than hiding them all", () => {
        expect(actsForEvent(ev, () => undefined)).toHaveLength(4);
    });

    it("offers nothing for an utterance with no products", () => {
        expect(actsForEvent({ id: "x" }, () => true)).toEqual([]);
    });
});
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: PASS

- [ ] **Step 9: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0

- [ ] **Step 10: Commit**

```bash
git add frontend/app/view/jarvis/petvoice.ts frontend/app/view/jarvis/petjoin.ts frontend/app/view/jarvis/petjoin.test.ts frontend/app/view/jarvis/petbubble.tsx frontend/app/view/jarvis/petpeek.tsx frontend/app/view/jarvis/petacts.ts frontend/app/view/jarvis/petacts.test.ts
git commit -m "feat(jarvis): I went back over 8 sessions told you nothing and offered nothing, so a pass now names what it wrote or does not speak"
```

---

### Task 11: The last-pass row, so silence is not invisibility

**Files:**
- Modify: `frontend/app/view/jarvis/petstore.ts`
- Modify: `frontend/app/view/jarvis/petjoin.ts`
- Modify: `frontend/app/view/jarvis/petjoin.test.ts` (the two new functions live in `petjoin.ts`, so their tests belong in its test file — this repo pairs `foo.ts` with `foo.test.ts` and a third file would break that)
- Modify: `frontend/app/view/jarvis/petsources.tsx`
- Modify: `frontend/app/view/jarvis/petpeek.tsx`

**Interfaces:**
- Consumes: `MemoryActivityData` (Task 9's shape)
- Produces: `petLastPassAtom`, `recordPass(d)`, `passLine(pass, nowMs)`

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/jarvis/petjoin.test.ts`, adding `passFromActivity` and `passLine` to its existing `./petjoin` import:

```ts
describe("passFromActivity", () => {
    it("records a pass with what it covered and what it wrote", () => {
        expect(
            passFromActivity({
                kind: "distill-batch",
                id: "a1",
                ts: 1000,
                sessions: 8,
                notes: [{ id: "x", title: "x" }],
            } as MemoryActivityData)
        ).toEqual({ at: 1000, sessions: 8, written: 1 });
    });

    it("records a barren pass rather than dropping it — that is the whole point of the row", () => {
        expect(
            passFromActivity({ kind: "distill-batch", id: "a2", ts: 1000, sessions: 8 } as MemoryActivityData)
        ).toEqual({ at: 1000, sessions: 8, written: 0 });
    });

    it("ignores a sweep, which is a different pass with its own utterance", () => {
        expect(passFromActivity({ kind: "sweep", id: "s", ts: 1, archived: 2 } as MemoryActivityData)).toBeNull();
    });
});

describe("passLine", () => {
    it("says so plainly when a pass wrote nothing", () => {
        expect(passLine({ at: 1_000_000, sessions: 8, written: 0 }, 1_000_000 + 18 * 60_000)).toBe(
            "18m ago · 8 sessions · nothing written"
        );
    });

    it("counts what a productive pass wrote", () => {
        expect(passLine({ at: 1_000_000, sessions: 8, written: 3 }, 1_000_000 + 18 * 60_000)).toBe(
            "18m ago · 8 sessions · 3 notes written"
        );
    });

    it("reads as not-read-yet when no pass has been seen", () => {
        expect(passLine(null, 0)).toBe("not read yet");
    });
});
```

Check `ageLabel`'s exact output format in `frontend/app/view/jarvis/recallderive.ts` and adjust the two expected strings to match it (it may render `18m` rather than `18m ago` — use whatever it actually produces and build the ` ago` suffix in `passLine`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/petjoin.test.ts`
Expected: FAIL — `passFromActivity is not a function`

- [ ] **Step 3: Add the pure adapter and its wording**

Append to `frontend/app/view/jarvis/petjoin.ts`:

```ts
// The last distillation pass as a LEVEL rather than an event. This is what makes "a pass that wrote nothing
// says nothing" safe: the fact moves into the peek's readout, where a pipeline running fruitlessly is more
// visible than it was when it announced itself and told you nothing (design §4.7).
export interface PetPass {
    at: number; // epoch ms
    sessions: number;
    written: number;
}

export function passFromActivity(d: MemoryActivityData | null | undefined): PetPass | null {
    if (d == null || d.kind !== "distill-batch" || !d.ts) {
        return null;
    }
    return { at: d.ts, sessions: d.sessions ?? 0, written: (d.notes ?? []).length };
}

export function passLine(pass: PetPass | null, nowMs: number): string {
    if (pass == null) {
        return "not read yet"; // the convention every other unread row in the peek already uses
    }
    const wrote = pass.written === 0 ? "nothing written" : `${notes(pass.written)} written`;
    const covered = pass.sessions === 1 ? "1 session" : `${pass.sessions} sessions`;
    return `${ageLabel(Math.max(0, nowMs - pass.at))} ago · ${covered} · ${wrote}`;
}
```

Add `import { ageLabel } from "./recallderive";` to `petjoin.ts`.

- [ ] **Step 4: Persist the last pass**

Append to `frontend/app/view/jarvis/petstore.ts`:

```ts
const LAST_PASS_KEY = "wave:pet.lastpass";

function readLastPass(): PetPass | null {
    try {
        const raw = globalThis.localStorage?.getItem(LAST_PASS_KEY);
        if (!raw) {
            return null;
        }
        const p = JSON.parse(raw);
        return typeof p?.at === "number" && typeof p?.sessions === "number" && typeof p?.written === "number"
            ? { at: p.at, sessions: p.sessions, written: p.written }
            : null;
    } catch {
        return null;
    }
}

// Persisted for the same reason the watermark is: the broker's retained buffer is in-memory, so after a
// wavesrv restart the only record of the last pass is the one this window kept.
export const petLastPassAtom = atom<PetPass | null>(readLastPass()) as PrimitiveAtom<PetPass | null>;

export function recordPass(pass: PetPass): void {
    const prev = globalStore.get(petLastPassAtom);
    if (prev != null && prev.at >= pass.at) {
        return; // a replayed backlog must not roll the row backwards
    }
    globalStore.set(petLastPassAtom, pass);
    try {
        globalThis.localStorage?.setItem(LAST_PASS_KEY, JSON.stringify(pass));
    } catch {
        // quota/disabled — the in-memory atom still holds it for this session
    }
}
```

Add `PetPass` to the type import from `./petjoin` (note `petstore.ts` currently imports types from `./petvoice`; add a second type-only import — `petjoin.ts` is pure, so this creates no cycle).

- [ ] **Step 5: Record every pass as it arrives**

In `frontend/app/view/jarvis/petsources.tsx`, add `passFromActivity` to the `./petjoin` import and `recordPass` to the `./petstore` import, then in both the backlog loop and the live handler, record the pass alongside the utterance mapping:

```ts
        for (const e of events ?? []) {
            const data = e?.data as MemoryActivityData | undefined;
            const pass = passFromActivity(data);
            if (pass != null) {
                recordPass(pass);
            }
            const mapped = eventFromActivity(data);
            if (mapped != null) {
                pushPetEvent(mapped);
            }
        }
```

```ts
            handler: (event) => {
                const pass = passFromActivity(event?.data);
                if (pass != null) {
                    recordPass(pass);
                }
                const mapped = eventFromActivity(event?.data);
                if (mapped != null) {
                    pushPetEvent(mapped);
                }
            },
```

- [ ] **Step 6: Render the row**

In `frontend/app/view/jarvis/petpeek.tsx`, add `passLine` to the `./petjoin` import and `petLastPassAtom` to the `./petstore` import, then add a row below Vault:

```tsx
                        <Row label="Last pass" value={passLine(useAtomValue(petLastPassAtom), now)} dim />
```

Hoist the `useAtomValue` call to the top of the component with the others rather than calling it inline — a hook inside JSX is fine here but the file's convention is to read every atom up front:

```tsx
    const lastPass = useAtomValue(petLastPassAtom);
```

and use `value={passLine(lastPass, now)}`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: PASS

- [ ] **Step 8: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0

- [ ] **Step 9: Commit**

```bash
git add frontend/app/view/jarvis/petjoin.ts frontend/app/view/jarvis/petjoin.test.ts frontend/app/view/jarvis/petstore.ts frontend/app/view/jarvis/petsources.tsx frontend/app/view/jarvis/petpeek.tsx
git commit -m "feat(jarvis): dropping the utterance for a pass that wrote nothing would have hidden a fruitless pipeline, so the pass became a row instead"
```

---

### Task 12: The errand box

**Files:**
- Create: `frontend/app/view/jarvis/peterrand.tsx`
- Modify: `frontend/app/view/jarvis/petstore.ts` (errand atom)
- Modify: `frontend/app/view/jarvis/petactrun.ts` (`sendErrand`)
- Modify: `frontend/app/view/jarvis/petactrun.test.ts`
- Modify: `frontend/app/view/jarvis/petpeek.tsx`

**Interfaces:**
- Consumes: `RpcApi.ConsultCommand` (streaming), `RpcApi.PostChannelMessageCommand`, `RpcApi.ListConsultRuntimesCommand`, `activeChannelIdAtom` from `@/app/view/agents/channelsstore`
- Produces: `sendErrand(channelId, runtime, prompt)`, `petErrandAtom`

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/jarvis/petactrun.test.ts` — extend the `RpcApi` mock with the two commands:

```ts
const postMessage = vi.fn();
const consult = vi.fn();
```
add them to the `wshclientapi` mock object as `PostChannelMessageCommand` and `ConsultCommand`, then:

```ts
describe("sendErrand", () => {
    it("posts the question into the channel and streams the reply into the panel", async () => {
        postMessage.mockResolvedValue(undefined);
        consult.mockReturnValue(
            (async function* () {
                yield { text: "the parser " };
                yield { text: "is fine." };
            })()
        );
        await sendErrand("ch1", "claude", "is the parser ok?");
        expect(postMessage).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ channelid: "ch1", kind: "consult", author: "you", text: "is the parser ok?" })
        );
        expect(globalStore.get(petErrandAtom)).toEqual({
            prompt: "is the parser ok?",
            runtime: "claude",
            text: "the parser is fine.",
            status: "done",
        });
    });

    it("marks the errand failed with its reason, keeping whatever streamed first", async () => {
        postMessage.mockResolvedValue(undefined);
        consult.mockReturnValue(
            (async function* () {
                yield { text: "partial" };
                throw new Error("runtime not installed");
            })()
        );
        await sendErrand("ch1", "claude", "q");
        expect(globalStore.get(petErrandAtom)).toMatchObject({ text: "partial", status: "error" });
    });
});
```

Add `sendErrand` to the `./petactrun` import and `petErrandAtom` to the `./petstore` import in that test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/petactrun.test.ts`
Expected: FAIL — `sendErrand is not a function`

- [ ] **Step 3: Add the errand atom**

Append to `frontend/app/view/jarvis/petstore.ts`:

```ts
export interface PetErrand {
    prompt: string;
    runtime: string;
    text: string;
    status: "streaming" | "done" | "error";
}

// The last errand and its reply. Module-level so a reply still streaming when you close the peek is there
// when you reopen it; session-scoped and unpersisted because the durable copy is the channel message the
// backend posts, which is where a reply worth keeping belongs.
export const petErrandAtom = atom<PetErrand | null>(null) as PrimitiveAtom<PetErrand | null>;
```

- [ ] **Step 4: Implement the send**

Append to `frontend/app/view/jarvis/petactrun.ts`:

```ts
// The errand reuses the Channels surface's consult path exactly (channelactions.ts): post the question as a
// channel message, then stream the runtime's reply. Two consequences that make it the right seam — the
// question and its answer persist as channel messages, so closing the panel loses nothing; and it is not
// tier-gated, because the identical gesture is ungated on that surface and a panel stricter than the
// surface it mirrors would be incoherent.
//
// It needs a channel because CommandConsultData does, and a creature in window chrome has none of its own —
// the same per-channel hole the pet design named. The caller supplies the active channel.
export async function sendErrand(channelId: string, runtime: string, prompt: string): Promise<void> {
    const consultId = crypto.randomUUID();
    globalStore.set(petErrandAtom, { prompt, runtime, text: "", status: "streaming" });
    let acc = "";
    try {
        await RpcApi.PostChannelMessageCommand(TabRpcClient, {
            channelid: channelId,
            kind: "consult",
            author: "you",
            text: prompt,
            reforef: `consult:${consultId}`,
        });
        const gen = RpcApi.ConsultCommand(
            TabRpcClient,
            { channelid: channelId, runtime, prompt, consultid: consultId },
            { timeout: ERRAND_TIMEOUT_MS }
        );
        for await (const chunk of gen) {
            acc += chunk?.text ?? "";
            globalStore.set(petErrandAtom, { prompt, runtime, text: acc, status: "streaming" });
        }
        globalStore.set(petErrandAtom, { prompt, runtime, text: acc, status: "done" });
    } catch (e) {
        // the backend still posts a consult-reply carrying the error, so the channel keeps the full record
        globalStore.set(petErrandAtom, { prompt, runtime, text: acc || errText(e), status: "error" });
    }
}
```

Add the timeout constant near the other module constants, matching the Channels surface's own budget (read `CONSULT_RPC_TIMEOUT_MS` in `frontend/app/view/agents/channelactions.ts` and use the same value with a comment naming where it came from), and add `petErrandAtom` to the `./petstore` import.

- [ ] **Step 5: Build the box**

Create `frontend/app/view/jarvis/peterrand.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Somewhere to type. The panel used to say "ask me anything" in prose and offer no input at all, which is
// the same defect as a row that names its own remedy and no button.
//
// Its own file rather than more of petpeek.tsx: the reply streams, which means state and an effect, and the
// peek is a readout of things decided elsewhere.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { activeChannelAtom } from "@/app/view/agents/channelsstore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { sendErrand } from "./petactrun";
import { petErrandAtom } from "./petstore";

export function PetErrand() {
    const channel = useAtomValue(activeChannelAtom);
    const errand = useAtomValue(petErrandAtom);
    const [draft, setDraft] = useState("");
    const [runtime, setRuntime] = useState<string | null>(null);

    // Read once: the installed set changes when the user installs a cli, not while a panel is open. The
    // first installed runtime wins and its name goes on the button, so which agent answers is never a guess.
    useEffect(() => {
        void RpcApi.ListConsultRuntimesCommand(TabRpcClient)
            .then((r) => setRuntime(r?.runtimes?.find((x) => x.installed)?.runtime ?? null))
            .catch(() => setRuntime(null));
    }, []);

    const blocked = channel == null ? "no channel active" : runtime == null ? "no runtime installed" : null;
    const busy = errand?.status === "streaming";
    const send = () => {
        const prompt = draft.trim();
        if (!prompt || channel == null || runtime == null || busy) {
            return;
        }
        setDraft("");
        fireAndForget(() => sendErrand(channel.oid, runtime, prompt));
    };

    return (
        <div className="flex flex-col gap-2 border-t border-border pt-2.5">
            <div className="flex items-center gap-2">
                <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            send();
                        }
                    }}
                    disabled={blocked != null || busy}
                    placeholder={blocked ?? "Ask me anything"}
                    className="min-w-0 flex-1 rounded-[7px] border border-border bg-surface px-2 py-1 text-[11.5px] text-secondary placeholder:text-muted disabled:placeholder:text-muted"
                />
                <button
                    type="button"
                    onClick={send}
                    disabled={blocked != null || busy || draft.trim() === ""}
                    className="flex-none cursor-pointer rounded-[7px] bg-accent px-2 py-1 text-[11px] font-bold text-background hover:bg-accenthover disabled:cursor-default disabled:bg-surface-hover disabled:text-muted"
                >
                    {runtime != null ? `Ask ${runtime}` : "Ask"}
                </button>
            </div>
            {/* the channel is named because the question lands there as a message: an errand whose
                destination is invisible is an errand you cannot find again */}
            {channel != null ? (
                <span className="font-mono text-[9.5px] text-muted">-&gt; #{channel.name}</span>
            ) : null}
            {errand != null ? (
                <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-[9.5px] text-muted">
                        {errand.runtime} · {errand.status === "streaming" ? "thinking" : errand.status}
                    </span>
                    <span
                        className={cn(
                            "max-h-[120px] overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-[1.45]",
                            errand.status === "error" ? "text-error" : "text-secondary"
                        )}
                    >
                        {errand.text}
                    </span>
                </div>
            ) : null}
        </div>
    );
}
```

Verify `activeChannelAtom`'s element shape (`oid`, `name`) against `frontend/app/view/agents/channelsstore.ts:15-25` and use the real field names.

- [ ] **Step 6: Put it in the panel's primary position**

In `frontend/app/view/jarvis/petpeek.tsx`, import `PetErrand` and place `<PetErrand />` directly above the demoted "Open Jarvis" link.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: PASS

- [ ] **Step 8: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0

- [ ] **Step 9: Verify in the running app**

With `task dev` running and a channel selected, open the peek, type a question, press Enter, and confirm the reply streams into the panel and also appears as a consult message pair in that channel.

- [ ] **Step 10: Commit**

```bash
git add frontend/app/view/jarvis/peterrand.tsx frontend/app/view/jarvis/petstore.ts frontend/app/view/jarvis/petactrun.ts frontend/app/view/jarvis/petactrun.test.ts frontend/app/view/jarvis/petpeek.tsx
git commit -m "feat(jarvis): the panel said ask me anything and had nowhere to type, so it grew an errand box that runs a one-shot agent and keeps the answer in the channel"
```

---

### Task 13: The rendered check

**Files:**
- Modify: `scripts/cdp/scenarios.mjs`

**Interfaces:**
- Consumes: `data-pet-peek="1"` and `data-pet-act="<id>"` (Task 4), the dev-only `__wavePetStore.pushPetEvent` hook (`petstore.ts:149`)

- [ ] **Step 1: Read the existing scenarios**

Read `scripts/cdp/scenarios.mjs` and `scripts/cdp/attach.mjs` in full. Follow the arrange → goto → shot → assert → teardown shape of the scenarios already there; do not invent a new one.

- [ ] **Step 2: Add the scenario**

Add a `pet-acts` scenario that:

1. **Arranges** a peek worth opening — pin the viewport to 1600x950 (the real dev window is small enough that panel content collapses and by-name queries find nothing), then push a distillation utterance carrying two products through the dev hook:
   ```js
   window.__wavePetStore.pushPetEvent({
       id: "cdp-pass-1", at: Date.now(), kind: "distill-batch",
       text: "I went back over 8 sessions and wrote down 2 things.",
       sources: [
           { ref: "memnote:cdp-a", title: "first thing", sourceType: "memory" },
           { ref: "memnote:cdp-b", title: "second thing", sourceType: "memory" },
       ],
   });
   ```
2. **Opens** the peek by clicking the creature — query it by its accessible name `Jarvis condition`, which is deliberately not "Jarvis" (the nav rail owns that).
3. **Asserts**, scoped to `[data-pet-peek]` and never document-wide, that:
   - the panel is present;
   - at least one `[data-pet-act]` button exists;
   - both products render an Open — `[data-pet-act$=":open"]` count is 2;
   - the Last pass row is present.
4. **Records the Review escort as its own step**: click `[data-pet-act="vault:review"]` when it exists, then assert the Memory surface is showing and the cleanup queue heading `To clean up` is visible — this is the graph-view trap from the spec, and it is the one assertion that proves an escort landed rather than merely navigated. If the live vault has an empty cleanup queue, log the skip explicitly rather than passing silently.
5. **Tears down** by pressing Escape and clearing the pushed event.

- [ ] **Step 3: Run the scenario**

Run: `task verify:ui -- pet-acts`
Expected: PASS. Check `cdp-shots/index.html` for the contact sheet.

If it fails with `ECONNREFUSED :9222`, the dev app is not running with the debug flag or another session's edit crashed it — check the dev log for "going away" before treating it as a scenario bug.

- [ ] **Step 4: Run every check one last time**

```bash
npx vitest run
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx eslint frontend/app/view/jarvis frontend/app/view/agents/settingsstore.ts
```
```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/...
```
Expected: vitest PASS, tsc exit 0, eslint clean on the touched paths, Go tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp/scenarios.mjs
git commit -m "test(cdp): a scenario proving the panel's acts render and its escorts land, since there are no jsdom render tests to catch either"
```

---

## Self-review notes

**Spec coverage.** Every section of `docs/superpowers/specs/2026-08-06-jarvis-acts-design.md` maps to a task: the law and the spine (§2, §3) → Tasks 1-2; the condition sentence (§4.1) → Task 6; recall (§4.2) → Tasks 5-6; the rate-limit row's deliberate inaction (§4.3) → no task, by design, and Task 4 preserves it by making `Row`'s act props optional; vault (§4.4) → Tasks 1, 3, 4; waiting (§4.5) → Tasks 7-8; products (§4.6) → Tasks 9-10; the last-pass row (§4.7) → Task 11; the footer (§4.8) → Task 4; the errand box (§5) → Task 12; the backend changes (§6) → Tasks 5, 7, 9; error handling (§9) → the `Acts` renderer in Task 4 and the three-state predicate in Task 10; testing (§10) → every task's test steps plus Task 13.

**Known ordering constraint.** Task 6 depends on Task 5's `task generate` output, and Task 8 on Task 7's. Task 10 depends on Task 9's regenerated `MemoryActivityData`. Running those pairs out of order fails at the typecheck step with a missing generated symbol, which is the intended signal.

**Names to verify before use, flagged in-place rather than guessed:** `JarvisTier`'s exported name and values (`channelmessages.ts`), `channelsAtom` / `activeChannelAtom` element shape (`channelsstore.ts`), the memory scan's loaded-flag atom (`memstore.ts`), `ageLabel`'s exact output (`recallderive.ts`), `CONSULT_RPC_TIMEOUT_MS`'s value (`channelactions.ts`), and `waveobj.Run`/`RunPhase` construction style in `attention_test.go`. Each step says to read the real thing first — a plan that guessed these would produce code that compiles against nothing.
