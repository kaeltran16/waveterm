# Jarvis Record Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Jarvis surface's record views trustworthy and correctable — one cache per record, run rows that say what each run did, and attribution edges the operator can confirm, detach, restore and attach.

**Architecture:** Three layers. In Go, `pkg/jarvisattrib` gains a read for human-suppressed edges and `pkg/wshrpc` gains three commands wrapping the already-written `Detach` / `Accept` lifecycle. On the frontend, a new write-side module (`recordactions.ts`) owns every mutation and ends each one with a single invalidation seam, replacing five session caches that were never cleared. In the UI, per-edge controls attach to the two places an edge is already drawn — the record band's expanded panel and the record subject's run list.

**Tech Stack:** Go 1.23 + wshrpc codegen, React 19 + jotai + Tailwind 4, vitest for unit tests, Chrome DevTools Protocol scenarios for live checks.

**Spec:** [`docs/superpowers/specs/2026-08-03-jarvis-record-correction-design.md`](../specs/2026-08-03-jarvis-record-correction-design.md)

## Global Constraints

- **Never hand-edit generated files.** `frontend/app/store/wshclientapi.ts` and `frontend/types/gotypes.d.ts` are produced by `task generate`. Edit the Go definitions and regenerate.
- **Colors come from `@theme` tokens** in `frontend/tailwindsetup.css`. Never a raw hex or rgba in a component — runtime theming overrides those same custom properties, so a hardcoded color silently opts out of every theme.
- **No new SCSS.** Tailwind only.
- **Typecheck with** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. A bare `npx tsc` stack-overflows on this repo, which also means `task check:ts` is broken. The baseline is clean (exit 0), so any error it reports is yours.
- **Go tests need the CGO include path**, as a Windows-style path. From the repo root in PowerShell: `$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"`. A Git-Bash POSIX path silently fails with the same error it fixes.
- **`tsconfig.json` sets `"strict": false`.** Making an atom nullable produces **no** tsc errors at its read sites — `detail.decisions` on a `null` typechecks and crashes the first frame. Find read sites by grep, not by the typechecker.
- **Do not run `prettier --write` on a file you did not author end to end.** It reorganizes imports and rewraps the whole file, turning a four-line edit into a 600-line diff. Hand-format your own lines.
- **One commit at the end, and only with explicit approval.** Do not commit per task. The final task carries the single commit, and the spec document folds into it rather than landing as a docs-only commit.
- **No database migration is needed.** The override log is a file in the vault and no new `waveobj` type is registered.

---

## File Structure

| File | Responsibility |
|---|---|
| `pkg/jarvisattrib/lifecycle.go` | add `DetachedEdges` — the human-suppressed edges for one record or one run |
| `pkg/wshrpc/wshrpctypes_jarvis.go` | three command declarations + their data types |
| `pkg/wshrpc/wshserver/wshserver_jarvis.go` | three handlers + the edge→wire projection |
| `frontend/app/view/jarvis/jarvissubjectstore.ts` | read stores for a record: detail, scope, runs (unchanged ownership, gains force-reload variants) |
| `frontend/app/view/jarvis/tasksstore.ts` | the record *list* only; loses the second detail cache and every write action |
| `frontend/app/view/jarvis/recordactions.ts` | **new** — every record mutation, each ending in one invalidation seam |
| `frontend/app/view/jarvis/recordrunrow.ts` | **new** — pure: what one attributed-run row says |
| `frontend/app/view/jarvis/edgecontrols.ts` | **new** — pure: which controls an edge state gets |
| `frontend/app/view/jarvis/edgecontrolsview.tsx` | **new** — the control row, shared by the band and the record thread |
| `frontend/app/view/jarvis/recordpicker.tsx` | **new** — the attach picker over the record list |
| `frontend/app/view/jarvis/recordthread.tsx` | the record's run rows, their controls, the Detached group |
| `frontend/app/view/jarvis/recordbandview.tsx` | per-edge rows in the expanded panel, attach on the empty case, copy |
| `frontend/app/view/jarvis/stage.tsx` | reads the one keyed detail atom; passes the active run's oref to the band |

Why a separate `recordactions.ts` rather than putting the writes in the store that owns each atom: `jarvissubjectstore` owns the record atoms and `tasksstore` owns the list, so a write that must invalidate both would make the two stores import each other. The new module imports the stores; nothing imports it except components. This mirrors the existing `view/agents/runactions.ts` and `channelactions.ts` convention.

---

## Task 1: One cache per record

Today a dossier's detail is cached twice and only one copy is invalidated. `dossierDetailAtom` (`tasksstore.ts:17`, single value) backs the record subject; `recordDetailAtom` (`jarvissubjectstore.ts:139`, keyed by id) backs the record band and is never cleared. Changing a record's status from the band therefore appears to do nothing, because `setDossierStatus` reloads the other atom.

**Files:**
- Modify: `frontend/app/view/jarvis/jarvissubjectstore.ts` (lines 25, 92-96, 136-141, 225-236)
- Modify: `frontend/app/view/jarvis/tasksstore.ts` (lines 16-17, 31-46)
- Modify: `frontend/app/view/jarvis/stage.tsx` (lines 52, 57, 65, 170-183)
- Test: `frontend/app/view/jarvis/recorddetail.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `recordDetailAtom: PrimitiveAtom<Record<string, DossierDetail>>` — exported from `jarvissubjectstore.ts`, now the only cache of a record's detail.
  - `loadRecordDetail(dossierId: string): void` — cache-guarded, unchanged signature.
  - `reloadRecordDetail(dossierId: string): Promise<void>` — **new**, always refetches and resolves when the atom is written. Task 2 calls this.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/recorddetail.test.ts`:

```typescript
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const getDossier = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { GetDossierCommand: (...a: unknown[]) => getDossier(...a) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import { recordDetailAtom, reloadRecordDetail } from "./jarvissubjectstore";

const detail = (id: string, status: string): DossierDetail =>
    ({ id, status, objective: "o", decisions: [] }) as unknown as DossierDetail;

describe("record detail cache", () => {
    beforeEach(() => {
        globalStore.set(recordDetailAtom, {});
        getDossier.mockReset();
    });

    it("keys the loaded detail by dossier id", async () => {
        getDossier.mockResolvedValue(detail("task-a", "active"));
        await reloadRecordDetail("task-a");
        expect(globalStore.get(recordDetailAtom)["task-a"].status).toBe("active");
    });

    it("replaces a cached detail rather than keeping the stale copy", async () => {
        getDossier.mockResolvedValue(detail("task-a", "active"));
        await reloadRecordDetail("task-a");
        getDossier.mockResolvedValue(detail("task-a", "completed"));
        await reloadRecordDetail("task-a");
        expect(globalStore.get(recordDetailAtom)["task-a"].status).toBe("completed");
    });

    it("leaves other records untouched", async () => {
        getDossier.mockResolvedValue(detail("task-a", "active"));
        await reloadRecordDetail("task-a");
        getDossier.mockResolvedValue(detail("task-b", "paused"));
        await reloadRecordDetail("task-b");
        expect(Object.keys(globalStore.get(recordDetailAtom)).sort()).toEqual(["task-a", "task-b"]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/recorddetail.test.ts`
Expected: FAIL — `reloadRecordDetail` is not exported from `./jarvissubjectstore`.

- [ ] **Step 3: Add `reloadRecordDetail` beside the existing loader**

In `frontend/app/view/jarvis/jarvissubjectstore.ts`, replace `loadRecordDetail` (lines 225-236) with:

```typescript
// The cache-guarded read: a band that opens the same record twice must not refetch it. Every mutation
// goes through recordactions.afterRecordWrite, which drops the key first, so a guarded read is correct
// rather than merely cheap.
export function loadRecordDetail(dossierId: string): void {
    if (globalStore.get(recordDetailAtom)[dossierId] != null) {
        return;
    }
    fireAndForget(() => reloadRecordDetail(dossierId));
}

// The unguarded read. Returns a promise so a write can await the refreshed detail before the UI settles.
export async function reloadRecordDetail(dossierId: string): Promise<void> {
    const detail = await RpcApi.GetDossierCommand(TabRpcClient, { dossierid: dossierId });
    if (detail == null) {
        return;
    }
    globalStore.set(recordDetailAtom, { ...globalStore.get(recordDetailAtom), [dossierId]: detail });
}
```

Also update the comment block above `recordDetailAtom` (lines 136-138), which currently explains the distinction from `dossierDetailAtom`. Replace it with:

```typescript
// A record's detail, keyed by dossier id — the ONLY cache of it. Both readers use this: the record
// subject (the record the user selected) and a channel's record band (the record its run is attributed
// to, usually a different one). It was two atoms, and only one of them was invalidated on write, so
// setting a record's status from the band appeared to do nothing.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/recorddetail.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Point the record subject at the same atom**

In `frontend/app/view/jarvis/jarvissubjectstore.ts`, delete the `selectDossier` import (line 25) and change `selectSubject`'s dossier branch (lines 92-95) from `selectDossier(subject.id)` to:

```typescript
    if (subject.kind === "dossier") {
        loadRecordDetail(subject.id);
        loadRecordScope(subject.id);
        return;
    }
```

Selecting a record you have already opened now serves the cache instead of refetching. That is correct because every write invalidates the key (Task 2); before this change `selectDossier` cleared and refetched on every selection, which is what hid the missing invalidation.

In `frontend/app/view/jarvis/tasksstore.ts`, delete `selectedDossierIdAtom` (line 16), `dossierDetailAtom` (line 17), `selectDossier` (lines 31-35) and `reloadDetail` (lines 37-46). Leave `taskListAtom`, `tasksErrorAtom` and `loadTaskList`. `appendDecision` and `setDossierStatus` move in Task 2 — leave them here for now, but change their `reloadDetail(dossierId)` calls to `await reloadRecordDetail(dossierId)` and add the import.

- [ ] **Step 6: Update the Stage's reads**

In `frontend/app/view/jarvis/stage.tsx`:

Delete the import on line 52 (`import { dossierDetailAtom } from "./tasksstore";`) and the hook on line 57 (`const detail = useAtomValue(dossierDetailAtom);`).

Rename line 65's hook so one value serves both readers:

```typescript
    const recordDetails = useAtomValue(recordDetailAtom);
```

After `const comp = composeStage(subject.kind);` (line 170), add the derivation — it goes here, below the early return, because it needs a non-null `subject`:

```typescript
    // one cache, two readers: the record the user selected, and the record a channel's run is attributed to.
    const detail = subject.kind === "dossier" ? (recordDetails[subject.id] ?? null) : null;
```

Change line 183 to read the renamed value:

```typescript
    const bandDetail =
        subject.kind === "dossier" ? detail : bandRecordId != null ? (recordDetails[bandRecordId] ?? null) : null;
```

Lines 178 (`detail?.objective`) and 220 (`<RecordThread detail={detail} …>`) need no change — they already sit below the early return and now read the derived value.

- [ ] **Step 7: Verify nothing else referenced the deleted atoms**

Run: `grep -rn "dossierDetailAtom\|selectedDossierIdAtom\|selectDossier" frontend/`
Expected: no matches outside `docs/`. Because `tsconfig.json` sets `"strict": false`, a missed read site can typecheck and still crash the first frame, so this grep is the check, not tsc.

- [ ] **Step 8: Typecheck and run the full frontend suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: all pass.

---

## Task 2: The invalidation seam

Five session caches of vault-derived state are never cleared: the whole-vault ambient attribution map, a record's detail, its scope, its attributed runs, and the graph's attribution bloom. Every record mutation now ends in one function that drops all five for that record.

**Files:**
- Create: `frontend/app/view/jarvis/recordactions.ts`
- Modify: `frontend/app/view/agents/ambientstore.ts`
- Modify: `frontend/app/view/jarvis/jarvisgraphstore.ts`
- Modify: `frontend/app/view/jarvis/jarvissubjectstore.ts` (add `reloadRecordScope`)
- Modify: `frontend/app/view/jarvis/tasksstore.ts` (remove the two write actions)
- Modify: `frontend/app/view/jarvis/decisionlog.tsx:6`, `frontend/app/view/jarvis/taskdetail.tsx:11` (import site only)
- Test: `frontend/app/view/jarvis/recordactions.test.ts` (create)

**Interfaces:**
- Consumes: `reloadRecordDetail(dossierId): Promise<void>` from Task 1.
- Produces:
  - `afterRecordWrite(dossierId: string): Promise<void>` — the seam.
  - `appendDecision(dossierId: string, summary: string, rationale: string, links: string[]): void`
  - `setDossierStatus(dossierId: string, status: string): void`
  - `reloadAmbient(): void` from `view/agents/ambientstore.ts`
  - `invalidateBloom(dossierId: string): void` from `jarvisgraphstore.ts`
  - `reloadRecordScope(dossierId: string): Promise<void>` from `jarvissubjectstore.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/recordactions.test.ts`:

```typescript
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const getDossier = vi.fn();
const resolveScope = vi.fn();
const resolveAmbient = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GetDossierCommand: (...a: unknown[]) => getDossier(...a),
        ResolveSpaceScopeCommand: (...a: unknown[]) => resolveScope(...a),
        ResolveAmbientCommand: (...a: unknown[]) => resolveAmbient(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wos", () => ({ loadAndPinWaveObject: vi.fn().mockResolvedValue(null) }));

import { globalStore } from "@/app/store/jotaiStore";
import { graphBloomAtom } from "./jarvisgraphstore";
import { recordDetailAtom, recordRunsAtom, recordScopeAtom } from "./jarvissubjectstore";
import { afterRecordWrite } from "./recordactions";

describe("afterRecordWrite", () => {
    beforeEach(() => {
        getDossier.mockResolvedValue({ id: "task-a", status: "completed", decisions: [] });
        resolveScope.mockResolvedValue({ runorefs: [], channeloids: [], tabids: [] });
        resolveAmbient.mockResolvedValue({ tasks: [], edges: [], decisions: [] });
        globalStore.set(recordDetailAtom, { "task-a": { status: "active" } as unknown as DossierDetail });
        globalStore.set(recordScopeAtom, { "task-a": { runorefs: ["run:old"] } as unknown as SpaceScope });
        globalStore.set(recordRunsAtom, { "task-a": [{ id: "old" }] as unknown as Run[] });
        globalStore.set(graphBloomAtom, new Map([["task-a", { runs: [], links: [] }]]));
    });

    it("replaces the record's detail with a fresh read", async () => {
        await afterRecordWrite("task-a");
        expect(globalStore.get(recordDetailAtom)["task-a"].status).toBe("completed");
    });

    it("re-resolves the record's scope and runs", async () => {
        await afterRecordWrite("task-a");
        expect(globalStore.get(recordScopeAtom)["task-a"].runorefs).toEqual([]);
        expect(globalStore.get(recordRunsAtom)["task-a"]).toEqual([]);
    });

    it("drops the record's graph attribution bloom", async () => {
        await afterRecordWrite("task-a");
        expect(globalStore.get(graphBloomAtom).has("task-a")).toBe(false);
    });

    it("re-reads the whole-vault ambient map", async () => {
        await afterRecordWrite("task-a");
        expect(resolveAmbient).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/recordactions.test.ts`
Expected: FAIL — cannot resolve `./recordactions`.

- [ ] **Step 3: Add `reloadAmbient` to the ambient store**

In `frontend/app/view/agents/ambientstore.ts`, after `ensureAmbient`, add:

```typescript
// A correction changes attribution everywhere the ambient layer draws a tag — Radar findings, run bodies,
// Memory rows — not just the surface the user corrected it on. Clearing the once-per-session latch and
// re-reading is the whole mechanism; there is no per-object invalidation because the read is whole-vault.
export function reloadAmbient(): void {
    loaded = false;
    ensureAmbient();
}
```

`ensureAmbient` already no-ops while a read is in flight, so a burst of corrections coalesces.

- [ ] **Step 4: Add `invalidateBloom` to the graph store**

In `frontend/app/view/jarvis/jarvisgraphstore.ts`, after the bloom loader, add:

```typescript
// The base graph is the vault's node set and a correction does not change it; the bloom IS the attribution,
// so that is the only part that goes stale.
export function invalidateBloom(dossierId: string): void {
    const next = new Map(globalStore.get(graphBloomAtom));
    if (next.delete(dossierId)) {
        globalStore.set(graphBloomAtom, next);
    }
}
```

- [ ] **Step 5: Add `reloadRecordScope` to the subject store**

In `frontend/app/view/jarvis/jarvissubjectstore.ts`, split `loadRecordScope` (lines 108-127) the same way Task 1 split the detail loader:

```typescript
export function loadRecordScope(dossierId: string): void {
    if (globalStore.get(recordScopeAtom)[dossierId] != null) {
        return;
    }
    fireAndForget(() => reloadRecordScope(dossierId));
}

export async function reloadRecordScope(dossierId: string): Promise<void> {
    const scope = await RpcApi.ResolveSpaceScopeCommand(TabRpcClient, { dossierid: dossierId });
    if (scope == null) {
        return;
    }
    globalStore.set(recordScopeAtom, { ...globalStore.get(recordScopeAtom), [dossierId]: scope });
    const runs: Run[] = [];
    for (const oref of scope.runorefs ?? []) {
        const run = await WOS.loadAndPinWaveObject<Run>(oref).catch(() => null);
        if (run != null) {
            runs.push(run);
        }
    }
    globalStore.set(recordRunsAtom, { ...globalStore.get(recordRunsAtom), [dossierId]: runs });
}
```

- [ ] **Step 6: Create the write-side module**

Create `frontend/app/view/jarvis/recordactions.ts`:

```typescript
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Every mutation of a record, and the one seam that keeps the reads honest afterwards. This module
// imports the record stores; nothing imports it but components, which is what keeps the stores from
// having to import each other. Mirrors view/agents/runactions.ts.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { reloadAmbient } from "@/app/view/agents/ambientstore";
import { fireAndForget } from "@/util/util";
import { invalidateBloom } from "./jarvisgraphstore";
import { reloadRecordDetail, reloadRecordScope } from "./jarvissubjectstore";
import { loadTaskList, tasksErrorAtom } from "./tasksstore";

// Refresh every cache of this record that a write can invalidate. The ambient re-read is deliberately not
// awaited: ResolveAmbient sweeps every dossier against every run and shells out to git for commit
// subjects, which is why its call site carries a 30s budget. Blocking a click on that would be worse than
// a tag that updates a beat late.
export async function afterRecordWrite(dossierId: string): Promise<void> {
    invalidateBloom(dossierId);
    reloadAmbient();
    await Promise.all([reloadRecordDetail(dossierId), reloadRecordScope(dossierId)]);
}

// A write that fails must say so rather than leaving the UI asserting a change that did not happen.
// tasksErrorAtom is the surface's existing channel for that.
async function write(dossierId: string, op: () => Promise<void>): Promise<void> {
    try {
        await op();
        await afterRecordWrite(dossierId);
    } catch (e) {
        globalStore.set(tasksErrorAtom, String(e));
    }
}

export function appendDecision(dossierId: string, summary: string, rationale: string, links: string[]): void {
    fireAndForget(() =>
        write(dossierId, async () => {
            await RpcApi.AppendDossierDecisionCommand(TabRpcClient, { dossierid: dossierId, summary, rationale, links });
        })
    );
}

export function setDossierStatus(dossierId: string, status: string): void {
    fireAndForget(() =>
        write(dossierId, async () => {
            await RpcApi.SetDossierStatusCommand(TabRpcClient, { dossierid: dossierId, status });
            // the row can change group or leave the list entirely, which the record's own caches cannot show
            loadTaskList();
        })
    );
}
```

`reloadRecordScope` must always refetch here — that is why Task 2 Step 5 split it. The guarded `loadRecordScope` would see the cached key and return.

Note `loadTaskList` sets the list atom unconditionally; it does not honour a guard, so calling it after a status change is correct.

- [ ] **Step 7: Delete the old write actions and repoint their callers**

In `frontend/app/view/jarvis/tasksstore.ts`, delete `appendDecision` and `setDossierStatus` and the now-unused `reloadRecordDetail` import.

In `frontend/app/view/jarvis/decisionlog.tsx` line 6, change `import { appendDecision } from "./tasksstore";` to `from "./recordactions"`.

In `frontend/app/view/jarvis/taskdetail.tsx` line 11, change `import { setDossierStatus } from "./tasksstore";` to `from "./recordactions"`.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/recordactions.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Typecheck and run the full frontend suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run frontend/app/view/jarvis/ frontend/app/view/agents/`
Expected: all pass.

---

## Task 3: What an attributed-run row says

`recordthread.tsx:64-87` renders each run as short id · goal · status. A dossier's objective is seeded from its run's goal, so the widest column repeats the record's own title on every row. Tracked as JC23.

**Files:**
- Create: `frontend/app/view/jarvis/recordrunrow.ts`
- Test: `frontend/app/view/jarvis/recordrunrow.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `runRow(run: Run, recordObjective: string, now: number): RunRow` where

```typescript
export interface RunRow {
    shortId: string;
    headline: string | null;
    meta: string[];
}
```

Task 4 renders it; the status is left to the caller's existing `runStatusView`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/recordrunrow.test.ts`:

```typescript
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runRow } from "./recordrunrow";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const run = (over: Partial<Run>): Run =>
    ({ id: "a7c7c6cd-1111-2222-3333-444444444444", goal: "the goal", status: "done", createdts: NOW - 2 * HOUR, ...over }) as unknown as Run;

const evidence = (over: Partial<RunEvidence>): RunEvidence =>
    ({ summary: "", files: [], addtotal: 0, deltotal: 0, durationms: 0, capturedts: NOW, hash: "" , ...over }) as unknown as RunEvidence;

describe("runRow", () => {
    it("prefers the run's own evidence summary over its goal", () => {
        const r = run({ evidence: evidence({ summary: "Moved the scope into an atom." }) });
        expect(runRow(r, "the goal", NOW).headline).toBe("Moved the scope into an atom.");
    });

    it("drops the goal when it is the record's objective repeated", () => {
        expect(runRow(run({}), "the goal", NOW).headline).toBeNull();
    });

    it("ignores incidental whitespace and case when comparing goal to objective", () => {
        expect(runRow(run({ goal: "  The   Goal " }), "the goal", NOW).headline).toBeNull();
    });

    it("keeps the goal when it genuinely differs from the objective", () => {
        expect(runRow(run({ goal: "a different goal" }), "the goal", NOW).headline).toBe("a different goal");
    });

    it("shortens the id to eight characters", () => {
        expect(runRow(run({}), "the goal", NOW).shortId).toBe("a7c7c6cd");
    });

    it("reports age, duration and the change stat for a sealed run", () => {
        const r = run({
            evidence: evidence({
                summary: "s",
                durationms: 252_000,
                addtotal: 212,
                deltotal: 48,
                files: [{ path: "a", stat: "M", add: 1, del: 1 }] as unknown as RunEvidence["files"],
            }),
        });
        expect(runRow(r, "o", NOW).meta).toEqual(["2h ago", "4m 12s", "+212/−48 across 1 file"]);
    });

    it("pluralizes the file count", () => {
        const r = run({
            evidence: evidence({
                summary: "s",
                addtotal: 1,
                deltotal: 0,
                files: [{ path: "a" }, { path: "b" }] as unknown as RunEvidence["files"],
            }),
        });
        expect(runRow(r, "o", NOW).meta).toContain("+1/−0 across 2 files");
    });

    it("omits every part it has no source for rather than defaulting it", () => {
        expect(runRow(run({ status: "running", evidence: undefined }), "o", NOW).meta).toEqual(["2h ago"]);
    });

    it("omits the change stat when a sealed run touched no files", () => {
        const r = run({ evidence: evidence({ summary: "s", durationms: 1000 }) });
        expect(runRow(r, "o", NOW).meta).toEqual(["2h ago", "1s"]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/recordrunrow.test.ts`
Expected: FAIL — cannot resolve `./recordrunrow`.

- [ ] **Step 3: Write the derivation**

Create `frontend/app/view/jarvis/recordrunrow.ts`:

```typescript
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What one attributed-run row on a record says. A dossier's objective is seeded from its run's goal, so
// rendering the goal put the record's own title in the widest column of every row — N identical lines
// whose only distinguishing datum was an 8-character id (JC23). The run's evidence summary is the thing
// that actually differs per run.

import { fmtDuration } from "@/app/view/agents/runcompletion";
import { ageLabel } from "./recallderive";

export interface RunRow {
    shortId: string;
    headline: string | null;
    meta: string[];
}

// A goal "differs" from the objective only after trimming, collapsing internal whitespace and lowercasing.
// The match this suppresses is an exact copy, so the normalization absorbs incidental drift, nothing more.
function norm(s: string): string {
    return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function changeStat(ev: RunEvidence): string | null {
    const n = ev.files?.length ?? 0;
    if (n === 0) {
        return null;
    }
    return `+${ev.addtotal ?? 0}/−${ev.deltotal ?? 0} across ${n} file${n === 1 ? "" : "s"}`;
}

export function runRow(run: Run, recordObjective: string, now: number): RunRow {
    const ev = run.evidence;
    const summary = ev?.summary?.trim() ?? "";
    const headline = summary !== "" ? summary : norm(run.goal) === norm(recordObjective) ? null : run.goal;

    // every part is omitted rather than defaulted: an unsealed run has no duration and no change set, and
    // a zero would assert one.
    const meta = [ageLabel(Math.max(0, now - (run.createdts ?? now)))];
    if (ev != null && (ev.durationms ?? 0) > 0) {
        meta.push(fmtDuration(ev.durationms));
    }
    const stat = ev != null ? changeStat(ev) : null;
    if (stat != null) {
        meta.push(stat);
    }
    return { shortId: (run.id ?? "").slice(0, 8), headline, meta };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/recordrunrow.test.ts`
Expected: PASS, 9 tests.

---

## Task 4: Render the new run rows

**Files:**
- Modify: `frontend/app/view/jarvis/recordthread.tsx` (lines 62-89)

**Interfaces:**
- Consumes: `runRow(run, recordObjective, now): RunRow` from Task 3.
- Produces: nothing new. Tasks 8 and 9 add controls beneath these rows.

- [ ] **Step 1: Replace the row body**

In `frontend/app/view/jarvis/recordthread.tsx`, add the import:

```typescript
import { runRow } from "./recordrunrow";
```

Replace the `runs.map` block (lines 64-87) with:

```typescript
                                    {runs.map((r) => {
                                        const view = runStatusView(r.status);
                                        const row = runRow(r, detail.objective ?? "", Date.now());
                                        return (
                                            <div
                                                key={r.id}
                                                className="flex flex-col gap-1 rounded-[10px] border border-border bg-surface px-3 py-2"
                                            >
                                                <div className="flex items-center gap-2.5">
                                                    <span className="flex-none font-mono text-[10.5px] font-semibold text-accent-soft">
                                                        {row.shortId}
                                                    </span>
                                                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-secondary">
                                                        {row.headline}
                                                    </span>
                                                    <span
                                                        className={cn(
                                                            "flex-none font-mono text-[10px]",
                                                            RUN_TONE[view.tone] ?? "text-accent-soft"
                                                        )}
                                                    >
                                                        {view.label}
                                                    </span>
                                                </div>
                                                <span className="font-mono text-[10px] text-muted">
                                                    {row.meta.join(" · ")}
                                                </span>
                                            </div>
                                        );
                                    })}
```

Tone follows the role table already commented at the top of this file: the id is identity (`accent-soft`), the headline is value (`secondary`), the meta line is structure (`muted`), the status is outcome (tonal). No new color tokens.

`row.headline` may be `null`, which React renders as nothing — the row then reads as id, blank, status, with the meta line beneath. That is the intended shape for a run whose goal is the record's objective repeated.

- [ ] **Step 2: Typecheck and run the suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: all pass.

---

## Task 5: List the human-suppressed edges (Go)

`applyOverrides` (`lifecycle.go:60`) drops a detached edge, so nothing can list one. `StateDetached` is declared at `edges.go:52` and has never been emitted.

The override log is the source of truth here rather than the assembled edges. `Detach` also strips a hardened canonical reference (`lifecycle.go:93-106`), so a detached layer-1 edge is **no longer derivable** — assembling alone would silently drop the one row a user most needs to restore. Assembly is used only to enrich a row whose signal still exists.

**Files:**
- Modify: `pkg/jarvisattrib/lifecycle.go`
- Test: `pkg/jarvisattrib/lifecycle_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `func DetachedEdges(ctx context.Context, v *wavevault.Vault, dossierID, runORef string) ([]AttributedEdge, error)` — filters by whichever id is non-empty. An edge whose signal is gone comes back with `Layers == nil`, `Provenance == ""` and `Confidence == 0`; Task 6 projects that as an empty bucket so the UI can omit the chip rather than assert "weak".

- [ ] **Step 1: Write the failing test**

Append to `pkg/jarvisattrib/lifecycle_test.go`:

```go
func TestDetachedEdgesListsASuppressedCanonicalRefAfterItsRefIsStripped(t *testing.T) {
	v := testVault(t)
	id, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-1", Objective: "oauth pkce"})
	if err != nil {
		t.Fatalf("CreateDossier: %v", err)
	}
	d, _ := loadDossier(v, id)
	if err := hardenEdge(v, d, "run:r1"); err != nil {
		t.Fatalf("hardenEdge: %v", err)
	}
	if err := Detach(context.Background(), v, id, "run:r1"); err != nil {
		t.Fatalf("Detach: %v", err)
	}

	// Detach strips the canonical ref, so assembling alone can no longer see this edge. The override log
	// must still surface it, or the only row that can restore it is unreachable.
	got, err := DetachedEdges(context.Background(), v, id, "")
	if err != nil {
		t.Fatalf("DetachedEdges: %v", err)
	}
	if len(got) != 1 || got[0].RunORef != "run:r1" || got[0].State != StateDetached {
		t.Fatalf("want one detached run:r1, got %+v", got)
	}
}

func TestDetachedEdgesDropsARestoredEdge(t *testing.T) {
	v := testVault(t)
	id, _, _ := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-2", Objective: "retries"})
	ctx := context.Background()
	if err := Detach(ctx, v, id, "run:r2"); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	if err := Accept(ctx, v, id, "run:r2"); err != nil {
		t.Fatalf("Accept: %v", err)
	}
	got, err := DetachedEdges(ctx, v, id, "")
	if err != nil {
		t.Fatalf("DetachedEdges: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("a restored edge is still listed as detached: %+v", got)
	}
}

func TestDetachedEdgesFiltersByRunAcrossDossiers(t *testing.T) {
	v := testVault(t)
	ctx := context.Background()
	a, _, _ := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-3", Objective: "alpha"})
	b, _, _ := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-4", Objective: "beta"})
	if err := Detach(ctx, v, a, "run:shared"); err != nil {
		t.Fatalf("Detach a: %v", err)
	}
	if err := Detach(ctx, v, b, "run:other"); err != nil {
		t.Fatalf("Detach b: %v", err)
	}

	got, err := DetachedEdges(ctx, v, "", "run:shared")
	if err != nil {
		t.Fatalf("DetachedEdges: %v", err)
	}
	if len(got) != 1 || got[0].DossierID != a {
		t.Fatalf("want only dossier %s for run:shared, got %+v", a, got)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

From the repo root in PowerShell:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/jarvisattrib/ -run TestDetachedEdges -v
```

Expected: FAIL to build — `undefined: DetachedEdges`.

- [ ] **Step 3: Implement `DetachedEdges`**

Append to `pkg/jarvisattrib/lifecycle.go` (and add `sort` and `strings` to the import block):

```go
// DetachedEdges lists the human-suppressed edges for one dossier (dossierID != "") or one run
// (runORef != ""), so a detach has somewhere to be undone from. The override log is the source of truth
// rather than the assembled edges: Detach also strips a hardened canonical ref, so a detached layer-1
// edge is no longer derivable and assembling alone would drop the very row the user needs. Assembly is
// consulted only to enrich a row whose signal still exists — an edge with no derivable signal comes back
// with no Layers, no Provenance and zero Confidence, which the caller must render as absent rather than
// as weak.
func DetachedEdges(ctx context.Context, v *wavevault.Vault, dossierID, runORef string) ([]AttributedEdge, error) {
	ov, err := readOverrides(v)
	if err != nil {
		return nil, err
	}
	type pair struct{ dossier, run string }
	var pairs []pair
	for key, action := range ov {
		if action != "detach" {
			continue
		}
		parts := strings.SplitN(key, "|", 2)
		if len(parts) != 2 {
			continue
		}
		if dossierID != "" && parts[0] != dossierID {
			continue
		}
		if runORef != "" && parts[1] != runORef {
			continue
		}
		pairs = append(pairs, pair{dossier: parts[0], run: parts[1]})
	}
	if len(pairs) == 0 {
		return nil, nil
	}
	// map iteration is unordered; without this the rows reshuffle between reads
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].dossier != pairs[j].dossier {
			return pairs[i].dossier < pairs[j].dossier
		}
		return pairs[i].run < pairs[j].run
	})

	lk, runs, err := gatherLookups(ctx)
	if err != nil {
		return nil, err
	}
	lk = memoizeCommits(lk)
	now := nowFn()
	// one assembly per distinct dossier, reused across its pairs
	assembled := map[string][]AttributedEdge{}
	out := make([]AttributedEdge, 0, len(pairs))
	for _, p := range pairs {
		edges, ok := assembled[p.dossier]
		if !ok {
			if d, err := loadDossier(v, p.dossier); err == nil {
				edges = assembleEdges(d, runs, lk, now)
			}
			assembled[p.dossier] = edges
		}
		e := AttributedEdge{DossierID: p.dossier, RunORef: p.run, State: StateDetached}
		for _, cand := range edges {
			if cand.RunORef == p.run {
				e.Layers = cand.Layers
				e.Provenance = cand.Provenance
				e.Confidence = cand.Confidence
				break
			}
		}
		out = append(out, e)
	}
	return out, nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/jarvisattrib/ -v
```

Expected: PASS, including the three new tests and every pre-existing one.

---

## Task 6: Three RPC commands

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go`
- Generated by `task generate`: `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, the generated Go files
- Test: `pkg/wshrpc/wshserver/wshserver_jarvis_test.go`

**Interfaces:**
- Consumes: `jarvisattrib.DetachedEdges(ctx, v, dossierID, runORef)` from Task 5.
- Produces, callable from the frontend as `RpcApi.<name>(TabRpcClient, data)`:
  - `DetachDossierEdgeCommand({dossierid, runoref}) → void`
  - `AcceptDossierEdgeCommand({dossierid, runoref}) → void`
  - `ListDetachedEdgesCommand({dossierid, runoref}) → {tasks: AmbientTask[], edges: AmbientEdge[]}`

- [ ] **Step 1: Declare the commands**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, add three lines to the `JarvisCommands` interface, after `SetDossierStatusCommand`:

```go
	DetachDossierEdgeCommand(ctx context.Context, data CommandDossierEdgeData) error                                          // human-reject a dossier<->run attribution; suppressed durably via the override log
	AcceptDossierEdgeCommand(ctx context.Context, data CommandDossierEdgeData) error                                          // human-confirm a dossier<->run attribution and harden it into canonical refs; also restores a detached edge and attaches an unattributed run
	ListDetachedEdgesCommand(ctx context.Context, data CommandListDetachedEdgesData) (*CommandListDetachedEdgesRtnData, error) // the human-suppressed edges for one dossier or one run, so a detach can be undone
```

Then add the data types near the other ambient types:

```go
// CommandDossierEdgeData names one dossier<->run attribution. Both ids are required: an edge is the pair.
type CommandDossierEdgeData struct {
	DossierId string `json:"dossierid"`
	RunORef   string `json:"runoref"`
}

// CommandListDetachedEdgesData asks the inverse question from each end — a record's suppressed runs, or a
// run's suppressed records. Exactly one id is set; setting neither is an error, since an unfiltered read
// would return every correction ever made.
type CommandListDetachedEdgesData struct {
	DossierId string `json:"dossierid,omitempty"`
	RunORef   string `json:"runoref,omitempty"`
}

// CommandListDetachedEdgesRtnData mirrors ResolveAmbient's first two fields so the frontend joins labels
// to edges with the machinery it already has. An edge whose underlying signal is gone (Detach strips a
// hardened ref) carries an empty Provenance and Bucket — absent, never a fabricated "weak".
type CommandListDetachedEdgesRtnData struct {
	Tasks []AmbientTask `json:"tasks"`
	Edges []AmbientEdge `json:"edges"`
}
```

- [ ] **Step 2: Write the failing handler test**

Append to `pkg/wshrpc/wshserver/wshserver_jarvis_test.go`:

```go
func TestListDetachedEdgesRequiresAnId(t *testing.T) {
	ws := &WshServer{}
	if _, err := ws.ListDetachedEdgesCommand(context.Background(), wshrpc.CommandListDetachedEdgesData{}); err == nil {
		t.Fatal("an unfiltered detached-edge read must be rejected, not answered with every correction ever made")
	}
}

func TestDossierEdgeCommandsRequireBothIds(t *testing.T) {
	ws := &WshServer{}
	ctx := context.Background()
	if err := ws.DetachDossierEdgeCommand(ctx, wshrpc.CommandDossierEdgeData{RunORef: "run:r1"}); err == nil {
		t.Fatal("detach without a dossierid must be rejected")
	}
	if err := ws.AcceptDossierEdgeCommand(ctx, wshrpc.CommandDossierEdgeData{DossierId: "task-a"}); err == nil {
		t.Fatal("accept without a runoref must be rejected")
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/wshrpc/wshserver/ -run "DetachedEdges|DossierEdge" -v
```

Expected: FAIL to build — the three methods are undefined.

- [ ] **Step 4: Write the handlers**

Append to `pkg/wshrpc/wshserver/wshserver_jarvis.go`:

```go
func (ws *WshServer) DetachDossierEdgeCommand(ctx context.Context, data wshrpc.CommandDossierEdgeData) error {
	if data.DossierId == "" || data.RunORef == "" {
		return fmt.Errorf("dossierid and runoref are both required")
	}
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return fmt.Errorf("opening vault: %w", err)
	}
	return jarvisattrib.Detach(ctx, v, data.DossierId, data.RunORef)
}

func (ws *WshServer) AcceptDossierEdgeCommand(ctx context.Context, data wshrpc.CommandDossierEdgeData) error {
	if data.DossierId == "" || data.RunORef == "" {
		return fmt.Errorf("dossierid and runoref are both required")
	}
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return fmt.Errorf("opening vault: %w", err)
	}
	return jarvisattrib.Accept(ctx, v, data.DossierId, data.RunORef)
}

func (ws *WshServer) ListDetachedEdgesCommand(ctx context.Context, data wshrpc.CommandListDetachedEdgesData) (*wshrpc.CommandListDetachedEdgesRtnData, error) {
	if data.DossierId == "" && data.RunORef == "" {
		return nil, fmt.Errorf("one of dossierid or runoref is required")
	}
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening vault: %w", err)
	}
	edges, err := jarvisattrib.DetachedEdges(ctx, v, data.DossierId, data.RunORef)
	if err != nil {
		return nil, fmt.Errorf("reading detached edges: %w", err)
	}
	out := wshrpc.CommandListDetachedEdgesRtnData{Tasks: []wshrpc.AmbientTask{}, Edges: []wshrpc.AmbientEdge{}}
	labelled := map[string]bool{}
	for _, e := range edges {
		// a bucket derived from zero confidence reads as "weak", which would assert a strength this row
		// does not have: Detach strips the ref, so the signal behind a detached layer-1 edge is gone.
		bucket := ""
		if len(e.Layers) > 0 {
			bucket = jarvisattrib.Bucket(e.Confidence)
		}
		out.Edges = append(out.Edges, wshrpc.AmbientEdge{
			ORef:       e.RunORef,
			DossierId:  e.DossierID,
			Provenance: e.Provenance,
			Bucket:     bucket,
			State:      string(e.State),
		})
		if labelled[e.DossierID] {
			continue
		}
		labelled[e.DossierID] = true
		label := e.DossierID
		if d, err := jarvisdossier.LoadDossier(v.Retriever(wavevault.AllScope()), e.DossierID); err == nil && d.Objective != "" {
			label = d.Objective
		}
		out.Tasks = append(out.Tasks, wshrpc.AmbientTask{Id: e.DossierID, Label: label})
	}
	return &out, nil
}
```

- [ ] **Step 5: Run the handler tests**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/wshrpc/wshserver/ -run "DetachedEdges|DossierEdge" -v
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Regenerate the bindings**

Run: `task generate`

Then confirm the three commands reached the typed client:

Run: `grep -n "DetachDossierEdgeCommand\|AcceptDossierEdgeCommand\|ListDetachedEdgesCommand" frontend/app/store/wshclientapi.ts`
Expected: three matches. Do not hand-edit that file — if a command is missing, fix the Go declaration and regenerate.

- [ ] **Step 7: Verify the whole backend still builds and typechecks**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/...
```
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 8: Rebuild the backend so a running dev app picks up the new commands**

Run: `task build:backend`

A dev app started before this will answer the three new commands with a route error until it is restarted.

---

## Task 7: The correction actions and the control-gating rule

**Files:**
- Create: `frontend/app/view/jarvis/edgecontrols.ts`
- Create: `frontend/app/view/jarvis/edgecontrols.test.ts`
- Modify: `frontend/app/view/jarvis/recordactions.ts`
- Test: `frontend/app/view/jarvis/recordactions.test.ts` (extend)

**Interfaces:**
- Consumes: `afterRecordWrite(dossierId)` from Task 2; the three commands from Task 6.
- Produces:
  - `edgeControls(state: string): { confirm: boolean; detach: boolean; restore: boolean; confirmFirst: boolean }` from `edgecontrols.ts`
  - `detachEdge(dossierId: string, runORef: string): void`, `acceptEdge(dossierId: string, runORef: string): void` from `recordactions.ts`
  - `detachedEdgesAtom: PrimitiveAtom<Record<string, DetachedEdge[]>>` keyed by `"task:<id>"` or the run oref, plus `loadDetachedEdges(key: string): void`, from `recordactions.ts`, where

```typescript
export interface DetachedEdge {
    dossierId: string;
    runORef: string;
    label: string; // the record's objective
    bucket: string; // "" when Detach stripped the signal and nothing derivable remains
}
```

This is deliberately **not** `AmbientTag`. That shape has a `taskId` and no run oref, so a record-scoped
read — where every row shares the same record and the run is the only distinguishing datum — would render
N identical rows and drop the id that Restore needs. The two views read different fields from this one
shape: the record's Detached group shows the run, the band's shows the record.

- [ ] **Step 1: Write the failing gating test**

Create `frontend/app/view/jarvis/edgecontrols.test.ts`:

```typescript
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { edgeControls } from "./edgecontrols";

describe("edgeControls", () => {
    it("offers both actions on an inferred edge, with no dialog", () => {
        expect(edgeControls("informing")).toEqual({ confirm: true, detach: true, restore: false, confirmFirst: false });
    });

    it("hides Confirm on an already-confirmed edge and asks before detaching it", () => {
        expect(edgeControls("confirmed")).toEqual({ confirm: false, detach: true, restore: false, confirmFirst: true });
    });

    it("offers only Restore on a detached edge", () => {
        expect(edgeControls("detached")).toEqual({ confirm: false, detach: false, restore: true, confirmFirst: false });
    });

    it("treats an unrecognised state as the most cautious case", () => {
        expect(edgeControls("something-new")).toEqual({
            confirm: false,
            detach: true,
            restore: false,
            confirmFirst: true,
        });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/edgecontrols.test.ts`
Expected: FAIL — cannot resolve `./edgecontrols`.

- [ ] **Step 3: Write the gating rule**

Create `frontend/app/view/jarvis/edgecontrols.ts`:

```typescript
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Which correction controls one edge gets. Pure, so the band and the record thread cannot disagree about
// the same edge — they draw it from opposite ends.

export interface EdgeControls {
    confirm: boolean;
    detach: boolean;
    restore: boolean;
    // a confirmed edge is a dispatch reference the worker itself wrote: detaching it overrides the machine
    // rather than correcting a guess, so it asks first.
    confirmFirst: boolean;
}

export function edgeControls(state: string): EdgeControls {
    if (state === "detached") {
        return { confirm: false, detach: false, restore: true, confirmFirst: false };
    }
    if (state === "informing") {
        return { confirm: true, detach: true, restore: false, confirmFirst: false };
    }
    // confirmed, and anything unrecognised: offering Confirm would be a no-op, and an unknown state must
    // not get the cheaper of the two detach paths.
    return { confirm: false, detach: true, restore: false, confirmFirst: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/edgecontrols.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the actions and the detached-edge read**

Append to `frontend/app/view/jarvis/recordactions.ts`:

```typescript
// One suppressed edge. Deliberately not AmbientTag: that shape has a taskId and no run oref, so a
// record-scoped read — where every row shares the same record and the RUN is the distinguishing datum —
// would render N identical rows and drop the id Restore needs. Both ids travel; each view picks the one
// that varies.
export interface DetachedEdge {
    dossierId: string;
    runORef: string;
    label: string;
    bucket: string;
}

// Keyed by "task:<dossierId>" for a record's suppressed runs, or by a run oref for that run's suppressed
// records. Two keys into one atom because the two views ask the inverse question and the answer for one
// says nothing about the other.
export const detachedEdgesAtom = atom<Record<string, DetachedEdge[]>>({}) as PrimitiveAtom<
    Record<string, DetachedEdge[]>
>;

function detachedRequest(key: string): CommandListDetachedEdgesData {
    return key.startsWith("task:") ? { dossierid: key.slice("task:".length) } : { runoref: key };
}

export function loadDetachedEdges(key: string): void {
    fireAndForget(async () => {
        try {
            const rtn = await RpcApi.ListDetachedEdgesCommand(TabRpcClient, detachedRequest(key));
            const labels = new Map((rtn?.tasks ?? []).map((t) => [t.id, t.label]));
            const rows: DetachedEdge[] = (rtn?.edges ?? []).map((e) => ({
                dossierId: e.dossierid,
                runORef: e.oref,
                label: labels.get(e.dossierid) ?? e.dossierid,
                bucket: e.bucket,
            }));
            globalStore.set(detachedEdgesAtom, { ...globalStore.get(detachedEdgesAtom), [key]: rows });
        } catch (e) {
            // a missing undo list must not break the view it decorates
            console.warn("detached edges unavailable", e);
        }
    });
}

// A correction invalidates the caches of the record AND both detached lists that could show it — the
// record's own, and the run's, which a channel's band reads.
async function afterEdgeWrite(dossierId: string, runORef: string): Promise<void> {
    await afterRecordWrite(dossierId);
    loadDetachedEdges("task:" + dossierId);
    loadDetachedEdges(runORef);
}

export function detachEdge(dossierId: string, runORef: string): void {
    fireAndForget(async () => {
        try {
            await RpcApi.DetachDossierEdgeCommand(TabRpcClient, { dossierid: dossierId, runoref: runORef });
            await afterEdgeWrite(dossierId, runORef);
        } catch (e) {
            globalStore.set(tasksErrorAtom, String(e));
        }
    });
}

// One call serves Confirm, Restore and Attach: accepting a pair with no existing edge appends the override
// and hardens the run into the record's refs block, which is a canonical layer-1 edge on the next read.
export function acceptEdge(dossierId: string, runORef: string): void {
    fireAndForget(async () => {
        try {
            await RpcApi.AcceptDossierEdgeCommand(TabRpcClient, { dossierid: dossierId, runoref: runORef });
            await afterEdgeWrite(dossierId, runORef);
        } catch (e) {
            globalStore.set(tasksErrorAtom, String(e));
        }
    });
}
```

Add `import { atom, type PrimitiveAtom } from "jotai";` to the imports at the top of the file.

- [ ] **Step 6: Extend the actions test**

Append to `frontend/app/view/jarvis/recordactions.test.ts` — add the two commands to the `RpcApi` mock at the top of the file first:

```typescript
        DetachDossierEdgeCommand: (...a: unknown[]) => detachCmd(...a),
        ListDetachedEdgesCommand: (...a: unknown[]) => listDetached(...a),
```

with `const detachCmd = vi.fn();` and `const listDetached = vi.fn();` beside the others. Then:

```typescript
describe("detachEdge", () => {
    beforeEach(() => {
        detachCmd.mockReset().mockResolvedValue(undefined);
        listDetached.mockReset().mockResolvedValue({
            tasks: [{ id: "task-a", label: "Alpha" }],
            edges: [{ oref: "run:r1", dossierid: "task-a", provenance: "", bucket: "", state: "detached" }],
        });
        globalStore.set(detachedEdgesAtom, {});
    });

    it("sends both ids to the backend", async () => {
        detachEdge("task-a", "run:r1");
        await vi.waitFor(() => expect(detachCmd).toHaveBeenCalled());
        expect(detachCmd.mock.calls[0][1]).toEqual({ dossierid: "task-a", runoref: "run:r1" });
    });

    it("refreshes the detached list for the record and for the run", async () => {
        detachEdge("task-a", "run:r1");
        await vi.waitFor(() => expect(globalStore.get(detachedEdgesAtom)["run:r1"]).toBeDefined());
        const row = globalStore.get(detachedEdgesAtom)["task:task-a"][0];
        expect(row.label).toBe("Alpha");
        // both ids survive the projection: the record view needs the run, the band view needs the record
        expect(row.runORef).toBe("run:r1");
        expect(row.dossierId).toBe("task-a");
    });

    it("carries an empty bucket through rather than inventing a strength", async () => {
        detachEdge("task-a", "run:r1");
        await vi.waitFor(() => expect(globalStore.get(detachedEdgesAtom)["task:task-a"]).toBeDefined());
        expect(globalStore.get(detachedEdgesAtom)["task:task-a"][0].bucket).toBe("");
    });
});
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: all pass.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

## Task 8: The control row, and the record's Detached group

**Files:**
- Create: `frontend/app/view/jarvis/edgecontrolsview.tsx`
- Modify: `frontend/app/view/jarvis/recordthread.tsx`

**Interfaces:**
- Consumes: `edgeControls(state)` from Task 7; `detachEdge`, `acceptEdge`, `detachedEdgesAtom`, `loadDetachedEdges` from Task 7.
- Produces: `<EdgeControls dossierId, runORef, state, subjectLabel />` — one control row, reused by Task 9 in the record band.

- [ ] **Step 1: Write the shared control row**

Create `frontend/app/view/jarvis/edgecontrolsview.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The correction controls for one attribution edge. Rendered wherever an edge is drawn — a channel's
// record band lists a run's records, a record lists its runs — so the same gesture reaches the same edge
// from either end.

import { modalsModel } from "@/app/store/modalmodel";
import { cn } from "@/util/util";
import { Check, RotateCcw, X } from "lucide-react";
import { edgeControls } from "./edgecontrols";
import { acceptEdge, detachEdge } from "./recordactions";

const BTN = "flex cursor-pointer items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[10.5px] font-semibold";

export function EdgeControls({
    dossierId,
    runORef,
    state,
    subjectLabel,
}: {
    dossierId: string;
    runORef: string;
    state: string;
    // what the confirm dialog names — the record from a run's row, the run from a record's row
    subjectLabel: string;
}) {
    const c = edgeControls(state);
    const detach = () => {
        if (!c.confirmFirst) {
            detachEdge(dossierId, runORef);
            return;
        }
        modalsModel.pushModal("ConfirmModal", {
            title: "Detach a confirmed attribution",
            message: `The worker reported ${subjectLabel} itself when it finished. Detaching overrides that. You can restore it from the Detached group.`,
            confirmLabel: "Detach",
            destructive: true,
            onConfirm: () => detachEdge(dossierId, runORef),
        });
    };
    return (
        <span className="flex flex-none items-center gap-1">
            {c.confirm ? (
                <button type="button" onClick={() => acceptEdge(dossierId, runORef)} className={cn(BTN, "text-muted hover:bg-surface-hover hover:text-success")}>
                    <Check size={11} strokeWidth={2.5} />
                    Confirm
                </button>
            ) : null}
            {c.detach ? (
                <button type="button" onClick={detach} className={cn(BTN, "text-muted hover:bg-surface-hover hover:text-error")}>
                    <X size={11} strokeWidth={2.5} />
                    Not this record
                </button>
            ) : null}
            {c.restore ? (
                <button type="button" onClick={() => acceptEdge(dossierId, runORef)} className={cn(BTN, "text-muted hover:bg-surface-hover hover:text-accent")}>
                    <RotateCcw size={11} strokeWidth={2.5} />
                    Restore
                </button>
            ) : null}
        </span>
    );
}
```

Colors are `@theme` tokens only (`text-muted`, `text-success`, `text-error`, `text-accent`, `bg-surface-hover`) — no raw values.

- [ ] **Step 2: Add controls and the Detached group to the record's run list**

In `frontend/app/view/jarvis/recordthread.tsx`, add imports:

```typescript
import { useEffect } from "react";
import { EdgeControls } from "./edgecontrolsview";
import { detachedEdgesAtom, loadDetachedEdges } from "./recordactions";
```

Inside `RecordThread`, after the existing `useAtomValue` calls, add:

```typescript
    const detachedByKey = useAtomValue(detachedEdgesAtom);
    const detachedKey = detail != null ? "task:" + detail.id : null;
    const detached = detachedKey != null ? (detachedByKey[detachedKey] ?? []) : [];
    useEffect(() => {
        if (detachedKey != null) {
            loadDetachedEdges(detachedKey);
        }
    }, [detachedKey]);
```

Inside the run row's outer `<div>` from Task 4, after the meta line, add the control row:

```tsx
                                                <div className="flex items-center justify-end">
                                                    <EdgeControls
                                                        dossierId={detail.id}
                                                        runORef={"run:" + r.id}
                                                        state={"confirmed"}
                                                        subjectLabel={`run ${row.shortId}`}
                                                    />
                                                </div>
```

The state is `"confirmed"` here rather than derived: a run reaching this list came through `ResolveSpaceScope`, which reads the same attributed edges, and the record's own list does not carry the per-edge state. Detaching therefore always asks first from this side, which is the cautious direction. The band (Task 9) has the real per-edge state and uses it.

Then, after the closing `</div>` of the runs block and before the decisions section, add the group:

```tsx
                        {detached.length > 0 ? (
                            <div className="flex flex-col gap-2">
                                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                                    Detached · {detached.length}
                                </span>
                                {detached.map((d) => (
                                    <div
                                        key={d.runORef}
                                        className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-border px-3 py-2"
                                    >
                                        <span className="flex-none font-mono text-[10.5px] text-muted">
                                            {d.runORef.replace(/^run:/, "").slice(0, 8)}
                                        </span>
                                        {d.bucket !== "" ? (
                                            <span className="flex-none font-mono text-[10px] text-muted">{d.bucket}</span>
                                        ) : null}
                                        <div className="flex-1" />
                                        <EdgeControls
                                            dossierId={d.dossierId}
                                            runORef={d.runORef}
                                            state="detached"
                                            subjectLabel={`run ${d.runORef.replace(/^run:/, "").slice(0, 8)}`}
                                        />
                                    </div>
                                ))}
                            </div>
                        ) : null}
```

Every row in this group shares the record, so the run is what the row names. The confidence bucket renders
only when it is non-empty: `Detach` strips a hardened reference, so a detached layer-1 edge has no
derivable signal left and the backend sends `""` rather than a fabricated "weak". Absent rather than empty
is the surface's stated rule.

- [ ] **Step 3: Typecheck and run the suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: all pass.

---

## Task 9: Per-edge rows in the record band

The band's collapsed row is a single `<button>` (`recordbandview.tsx:152-163`). Nesting controls inside it would re-open the keyboard defect JC19 was filed to fix, so every edge gets a sibling row in the **expanded** panel — including the primary, which today has no row of its own.

**Files:**
- Modify: `frontend/app/view/jarvis/recordbandview.tsx`
- Modify: `frontend/app/view/jarvis/stage.tsx` (pass the active run's oref)

**Interfaces:**
- Consumes: `<EdgeControls>` from Task 8; `detachedEdgesAtom` / `loadDetachedEdges` from Task 7.
- Produces: `RecordBand` gains a `runORef: string | null` prop. Task 10 adds `onAttach` to the same component.

- [ ] **Step 1: Pass the run oref into the band**

In `frontend/app/view/jarvis/stage.tsx`, the active run's oref is already computed inline for the ambient lookup at line 132. Lift it above the `tags` derivation:

```typescript
    const activeRunORef =
        subject?.kind === "channel" && subject.id === channel?.oid && !composing
            ? "run:" + (resolveActiveRunId(allRuns, runIds[subject.id]) ?? "")
            : null;
    const tags = activeRunORef != null ? ambient.tagsFor({ oref: activeRunORef }) : [];
```

Then pass it to the band (line 199-206): add `runORef={activeRunORef}`.

- [ ] **Step 2: Give every edge a row in the expanded panel**

In `frontend/app/view/jarvis/recordbandview.tsx`, add imports:

```typescript
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { EdgeControls } from "./edgecontrolsview";
import { detachedEdgesAtom, loadDetachedEdges } from "./recordactions";
```

Add `runORef` to the props type and destructuring. Inside the component:

```typescript
    const detachedByKey = useAtomValue(detachedEdgesAtom);
    const detached = runORef != null ? (detachedByKey[runORef] ?? []) : [];
    useEffect(() => {
        if (runORef != null) {
            loadDetachedEdges(runORef);
        }
    }, [runORef]);
    const edges: AmbientTag[] =
        band.case === "one" ? [band.edge] : band.case === "several" ? [band.primary, ...band.others] : [];
```

Replace the `others`-only motion block (lines 188-213) with one that lists **every** edge and its controls, so the primary is corrected the same way as the rest:

```tsx
                {expandable && open ? (
                    <motion.div key="edges" variants={composerReveal} initial="initial" animate="animate" exit="exit" className="overflow-hidden">
                        <div className={cn(STAGE_BAND_INSET, "border-t border-border")}>
                            <div className={cn(STAGE_GUTTER, "flex flex-col gap-px py-2")}>
                                {edges.map((e) => (
                                    <div key={e.taskId} className="flex items-center gap-2 rounded-[7px] px-1 py-1 transition-colors duration-[140ms] hover:bg-surface-hover">
                                        <button
                                            type="button"
                                            onClick={() => selectSubject({ kind: "dossier", id: e.taskId })}
                                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                                        >
                                            <EdgeChip tag={e} />
                                            <span className="font-mono text-[10.5px] text-muted">open this record</span>
                                        </button>
                                        {runORef != null ? (
                                            <EdgeControls dossierId={e.taskId} runORef={runORef} state={e.state} subjectLabel={e.label} />
                                        ) : null}
                                    </div>
                                ))}
                                {detached.map((d) => (
                                    <div key={"detached-" + d.dossierId} className="flex items-center gap-2 rounded-[7px] px-1 py-1 opacity-70">
                                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">
                                            Detached · {d.label}
                                        </span>
                                        <EdgeControls dossierId={d.dossierId} runORef={d.runORef} state="detached" subjectLabel={d.label} />
                                    </div>
                                ))}
                            </div>
                        </div>
                    </motion.div>
                ) : null}
```

The row is no longer a single `<button>` wrapping everything — the open-the-record button and the controls are siblings, so neither swallows the other. This is the same structural rule JC19 established for the band's outer control.

- [ ] **Step 3: Typecheck and run the suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: all pass — `recordband.test.ts` covers the pure case selection, which is unchanged.

---

## Task 10: Attaching a record, and the copy that stops being true

`Accept` on a pair with no existing edge appends the override and hardens the run into the record's refs block, so attach needs no new backend. The band's empty case renders in a plain `<div>` (`recordbandview.tsx:164-167`, since `expandable` covers only `one` and `several`), so the control can live directly on that row.

**Files:**
- Create: `frontend/app/view/jarvis/recordpicker.tsx`
- Modify: `frontend/app/view/jarvis/recordbandview.tsx`

**Interfaces:**
- Consumes: `acceptEdge(dossierId, runORef)` from Task 7; `taskListAtom` from `tasksstore.ts`.
- Produces: `<RecordPicker onPick={(dossierId) => void} onCancel={() => void} />`.

- [ ] **Step 1: Write the picker**

Create `frontend/app/view/jarvis/recordpicker.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pick a record to attribute a run to. Mirrors the composer's channel picker: a filtered list rendered in
// place rather than a modal, because the choice only means anything beside the row that raised it.

import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { loadTaskList, taskListAtom } from "./tasksstore";

const MAX_ROWS = 8;

export function RecordPicker({ onPick, onCancel }: { onPick: (dossierId: string) => void; onCancel: () => void }) {
    const records = useAtomValue(taskListAtom);
    const [q, setQ] = useState("");
    useEffect(() => {
        loadTaskList();
    }, []);
    const matches = useMemo(() => {
        const needle = q.trim().toLowerCase();
        const all = records ?? [];
        return (needle === "" ? all : all.filter((r) => r.objective.toLowerCase().includes(needle))).slice(0, MAX_ROWS);
    }, [records, q]);
    return (
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && onCancel()}
                placeholder="Attach to which record?"
                aria-label="Attach to which record"
                className="rounded-[7px] border border-edge-mid bg-background px-2.5 py-1 text-[12px] text-primary placeholder:text-muted focus:border-accent focus:outline-none"
            />
            {records == null ? (
                <span className="font-mono text-[11px] text-muted">Loading records…</span>
            ) : matches.length === 0 ? (
                <span className="font-mono text-[11px] text-muted">No record matches</span>
            ) : (
                matches.map((r) => (
                    <button
                        key={r.id}
                        type="button"
                        onClick={() => onPick(r.id)}
                        className="flex cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1 text-left transition-colors duration-[140ms] hover:bg-surface-hover"
                    >
                        <span className="flex-none font-mono text-[10px] text-accent-soft">{r.id.slice(0, 8)}</span>
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-secondary">{r.objective}</span>
                    </button>
                ))
            )}
        </div>
    );
}
```

- [ ] **Step 2: Wire attach into the band's empty case and change the copy**

In `frontend/app/view/jarvis/recordbandview.tsx`, add `import { RecordPicker } from "./recordpicker";` and `import { acceptEdge } from "./recordactions";`, extend Task 9's React import to `import { useEffect, useState } from "react";`, and add a local `const [attaching, setAttaching] = useState(false);`.

Change `MachineGlyph`'s title (line 21) from `"machine-maintained"` to `"inferred by Jarvis — you can correct it"`.

Replace the `none` case body (lines 72-83) with:

```tsx
            {band.case === "none" ? (
                attaching && runORef != null ? (
                    <RecordPicker
                        onPick={(dossierId) => {
                            acceptEdge(dossierId, runORef);
                            setAttaching(false);
                        }}
                        onCancel={() => setAttaching(false)}
                    />
                ) : (
                    <>
                        <span className="font-mono text-[11px] text-muted">No record attributed to this run</span>
                        <div className="flex-1" />
                        <button
                            type="button"
                            disabled={runORef == null}
                            onClick={() => setAttaching(true)}
                            className="flex-none cursor-pointer rounded-[6px] px-1.5 py-0.5 text-[11px] font-semibold text-muted hover:bg-surface-hover hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Attach a record
                        </button>
                    </>
                )
            ) : band.case === "one" ? (
```

Add `+ Attach another record` to the expanded panel from Task 9, as the last row in the edges list:

```tsx
                                {runORef != null && !attaching ? (
                                    <button
                                        type="button"
                                        onClick={() => setAttaching(true)}
                                        className="self-start cursor-pointer rounded-[6px] px-1 py-1 text-[11px] font-semibold text-muted hover:text-accent"
                                    >
                                        + Attach another record
                                    </button>
                                ) : null}
                                {runORef != null && attaching ? (
                                    <RecordPicker
                                        onPick={(dossierId) => {
                                            acceptEdge(dossierId, runORef);
                                            setAttaching(false);
                                        }}
                                        onCancel={() => setAttaching(false)}
                                    />
                                ) : null}
```

`useState` is acceptable here because the picker is a transient choice: the Jarvis surface unmounts on nav switch and an unfinished attach is a false start, exactly like the `+ Thread` case. Nothing survival-worthy is being held.

- [ ] **Step 3: Typecheck and run the suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: all pass.

---

## Task 11: The live scenario

Unit tests cannot see this surface's most common defect class — a bad hop between atoms. Both new steps must be checked by breaking the fix and watching them go red; a green scenario that cannot fail is not a net.

**Files:**
- Modify: `scripts/cdp/scenarios.mjs`

**Interfaces:**
- Consumes: everything above, running in the dev app.
- Produces: a `jarvis-attribution` scenario registered in the scenario map.

- [ ] **Step 1: Start the dev app**

Run: `tail -f /dev/null | task dev`

The pipe is required — a headless `task dev` dies on stdin EOF. Wait for the window, then confirm the debugging port answers: `curl -s http://localhost:9222/json/version`.

- [ ] **Step 2: Add the scenario**

**What this can and cannot cover.** The two-cache defect is only *visible* in a channel's record band, which needs a run carrying a real attribution edge — `docs/jarvis-tab.md` records that this cannot be arranged from a scenario. So the seam itself is covered by Task 2's unit test (`afterRecordWrite` replaces the record's detail, scope, runs and bloom), and what this scenario proves live is the round trip that exercises the same seam end to end: a detach must remove the run from the record's list and put it in the Detached group, and a restore must put it back. If the invalidation does not run, the list does not change and both halves go red.

In `scripts/cdp/scenarios.mjs`, beside `jarvisSubjectState`, add:

```javascript
// jarvis-attribution: the correction round trip. Detaching a run from a record must remove it from the
// record's run list and surface it under Detached; restoring must put it back. That round trip is also
// the live proof of the invalidation seam — a detach that does not invalidate leaves both lists unchanged,
// so a missing afterRecordWrite reddens both halves.
//
// It ends where it started, which is what makes it safe against the user's real vault (the same reasoning
// as jarvis-subject-state's archive/unarchive step). It needs one record with at least one attributed run
// and REPORTS when the vault has none rather than passing quietly.
const jarvisAttribution = {
    name: "jarvis-attribution",
    surface: "jarvis",
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        await h.goto("jarvis");
        await settle(500);

        // the Records group starts collapsed (subjects.ts DEFAULT_COLLAPSED)
        await h.ev(`(() => {
            const h = [...document.querySelectorAll('button')].find((b) => /^records/i.test((b.innerText || '').trim()));
            if (h) h.click();
            return !!h;
        })()`);
        await settle(300);

        // record rows carry their dossier id in the row's own text; select each until one has runs.
        const recordCount = await h.ev(`(() => {
            const rows = [...document.querySelectorAll('[data-jarvis-subject-kind="dossier"]')];
            return rows.length;
        })()`);
        const selectRecord = (i) =>
            h.ev(`(() => {
                const rows = [...document.querySelectorAll('[data-jarvis-subject-kind="dossier"]')];
                if (!rows[${i}]) return false;
                rows[${i}].click();
                return true;
            })()`);
        // a run row is the only element on the record's thread carrying an EdgeControls detach button
        const runCount = () =>
            h.ev(`[...document.querySelectorAll('button')].filter((b) => /not this record/i.test(b.innerText || '')).length`);

        let found = -1;
        for (let i = 0; i < recordCount && found < 0; i++) {
            await selectRecord(i);
            await settle(600);
            if ((await runCount()) > 0) {
                found = i;
            }
        }
        if (found < 0) {
            rec(
                "1. a record with an attributed run exists to correct",
                false,
                `checked ${recordCount} record rows, none had an attributed run — seed the vault before reading this as a pass`
            );
            return steps;
        }
        const before = await runCount();

        // 1. detach: the run leaves the list and appears under Detached. The dialog fires because a run
        // reaching a record's list is treated as confirmed (see Task 8) — the cautious path.
        await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => /not this record/i.test(x.innerText || ''));
            b.click();
            return true;
        })()`);
        await settle(300);
        await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => /^detach$/i.test((x.innerText || '').trim()));
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await settle(900);
        const afterDetach = await runCount();
        const detachedGroup = await h.ev(`/detached\\s*·\\s*[1-9]/i.test(document.body.innerText || '')`);
        rec(
            "1. detaching removes the run from the record and lists it under Detached",
            afterDetach === before - 1 && detachedGroup === true,
            `runs ${before} -> ${afterDetach}, detachedGroupVisible=${detachedGroup}`
        );

        // 2. restore: the starting state returns. This is also the teardown — the vault is the user's.
        await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => /restore/i.test(x.innerText || ''));
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await settle(900);
        const afterRestore = await runCount();
        const groupGone = await h.ev(`!/detached\\s*·\\s*[1-9]/i.test(document.body.innerText || '')`);
        rec(
            "2. restoring returns the run and empties the Detached group",
            afterRestore === before && groupGone === true,
            `runs ${afterDetach} -> ${afterRestore} (started at ${before}), detachedGroupGone=${groupGone}`
        );
        return steps;
    },
};
```

Register it in the exported scenario map alongside the other `jarvis-*` entries.

The probe's hook already exists: `subjectscolumn.tsx:660` puts `data-jarvis-subject-kind={s.kind}` on every subject row. No markup change is needed — do not add a second attribute for this.

- [ ] **Step 3: Run the scenario**

Run: `task verify:ui -- jarvis-attribution`
Expected: both steps PASS. The contact sheet lands at `cdp-shots/index.html`.

If it reports "none had an attributed run", the vault has no correctable edge and the scenario has proved nothing — seed one and re-run rather than accepting the report as a pass.

- [ ] **Step 4: Prove both steps can fail**

Make `detachEdge` in `recordactions.ts` skip its `afterEdgeWrite` call and re-run: both steps must go red, because the record's run list and its detached list are exactly the caches that call invalidates. Restore it.

Record the observation. A step that was never seen red has not been shown to guard anything, which is how the original narrow-window check shipped green against a broken layout.

- [ ] **Step 5: Re-run the whole Jarvis scenario set for regressions**

Run: `task verify:ui -- jarvis-states jarvis-drawer jarvis-fleet jarvis-subject-state jarvis-contextual jarvis-collapse-order jarvis-narrow jarvis-attribution`
Expected: all pass. Task 9 restructured the band's expanded rows, which `jarvis-measure` asserts a shared left edge for — run that too if the contact sheet shows any jog.

---

## Task 12: Documentation and the single commit

**Files:**
- Modify: `docs/jarvis-tab.md` (§4 record band, §5 thread renderers, §14 state and persistence)
- Modify: `docs/jarvis-consolidation-open-issues.md` (close JC23)
- Modify: `docs/superpowers/specs/2026-08-03-jarvis-record-correction-design.md` (the one correction below)

- [ ] **Step 1: Correct the spec where the plan diverged from it**

Two corrections, both found while planning:

1. **`DetachedEdges` does not work the way the spec describes.** The spec says it assembles the deterministic edges and keeps the detached pairs. `Detach` also strips the hardened canonical reference (`lifecycle.go:93-106`), so a detached layer-1 edge is no longer derivable and assembly alone would drop the very row the confirm dialog exists to protect. Rewrite that paragraph: the override log is the source of truth and assembly only enriches, with an empty provenance and bucket when nothing derivable remains.
2. **The spec's first live check is not arrangeable.** It says to append a decision and assert it appears in the band expanded from a channel. That needs a run carrying a real attribution edge, which `docs/jarvis-tab.md` records as impossible to arrange from a scenario. Replace it with what Task 11 actually built — the detach/restore round trip, which exercises the same invalidation seam — and say that the seam itself is unit-covered in `recordactions.test.ts`.

- [ ] **Step 2: Update the surface reference**

In `docs/jarvis-tab.md`:

- **§4 (record band)** — the expanded panel now lists every edge with per-edge Confirm / Not this record, plus a Detached group and Attach; the collapsed row is unchanged and still the only expand control. Replace the sentence stating that the `none` case says who maintains attribution, since it now offers Attach.
- **§5 (thread renderers)** — the `record` renderer's run rows now carry the run's evidence summary, age, duration and change stat, and their own correction controls.
- **§14 (state and persistence)** — add `detachedEdgesAtom` (keyed by record or run scope key, not persisted) and remove the row for the deleted second detail cache. Note that a record's detail is now one keyed atom with one invalidation seam.

- [ ] **Step 3: Close the tracker item**

In `docs/jarvis-consolidation-open-issues.md`, change JC23's status in the table from `⬜ Open` to `✅ Fixed`, and add a short paragraph to its section recording what the row now shows and why the evidence summary was the right field.

- [ ] **Step 4: Self-review the diff**

Run: `git diff --stat` and read the full diff. Check for commented-out code, debug statements, and any file whose import block was reordered by a formatter you did not intend to run.

- [ ] **Step 5: Final verification before asking to commit**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/...
```
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run`
Expected: PASS.

Run: `task verify:ui -- jarvis-attribution jarvis-subject-state jarvis-measure`
Expected: PASS.

Report any failure with its output rather than describing the work as complete.

- [ ] **Step 6: Ask for approval, then commit once**

Do **not** commit without explicit approval. When granted, one commit carrying the code, the tests, the scenario, the documentation updates and the spec document:

```bash
git add -A
git commit -F <message-file>
```

Write the message to a temp file and use `-F` — this is a Windows environment and PowerShell here-string syntax must not be used inside the Bash tool. Subject line in the repo's style, for example: `feat(jarvis): a record's attribution is something you correct, so a wrong edge stops being permanent`.
