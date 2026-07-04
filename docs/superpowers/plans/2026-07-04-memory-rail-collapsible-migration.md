# Memory Detail Rail → CollapsibleRail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Memory surface's bespoke always-open `DetailRail` with the shared `CollapsibleRail`, so the memory tab's drawer matches the Agent/Channels/Cockpit surfaces (same width, border, collapse affordance, animation).

**Architecture:** `CollapsibleRail` is unchanged — auto-expand-on-select works because the caller owns `openAtom`. Drawer-open and edit-draft state move into module-scope jotai atoms in `memstore.ts` (so a draft survives the collapse-triggered unmount). `memorysurface.tsx` swaps its `<aside>` for `CollapsibleRail` inside the existing content row; `Header`/`SyncStrip` stay full-surface-width rows above it, so the top controls never shift on toggle.

**Tech Stack:** React 19, jotai, motion/react, Tailwind 4, vitest. Design ref: `frontend/app/element/collapsiblerail.tsx`. Spec: `docs/superpowers/specs/2026-07-04-memory-rail-collapsible-migration-design.md`.

## Global Constraints

- **Never hand-edit generated files.** These changes touch no generated files.
- **tsc gotcha:** typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (never `npx tsc`). Baseline is clean (exit 0) — any error it reports is yours.
- **Single frontend test run:** `npx vitest run frontend/app/view/agents/memstore.test.ts`.
- **Git workflow (user STRICT rule, overrides the skill's per-task commits):** do NOT commit per task. Each task ends with a **Checkpoint** (stage + show diff + await approval). One batched commit at the very end, only after explicit "yes".
- **Comments:** only for "why", lower case, only when necessary (repo/user convention).
- `CollapsibleRail`'s expanded width is 300px (`RAIL_EXPANDED_PX`); collapsed 44px. Do not reintroduce the old 330px.

---

### Task 1: Drawer + edit-draft state in memstore

Add the four atoms and make `selectNote` open the drawer and clear stale edit state. This is the only unit-testable piece; test it with a mocked RPC layer.

**Files:**
- Modify: `frontend/app/view/agents/memstore.ts`
- Test (create): `frontend/app/view/agents/memstore.test.ts`

**Interfaces:**
- Consumes: `globalStore` (`@/app/store/jotaiStore`), `atom`/`PrimitiveAtom` (jotai), existing `memSelectedIdAtom`, `memBodyAtom`, `memNotesAtom`.
- Produces (relied on by Task 2):
  - `memRailOpenAtom: PrimitiveAtom<boolean>` — default `true`.
  - `memEditingAtom: PrimitiveAtom<boolean>` — default `false`.
  - `memDraftAtom: PrimitiveAtom<string>` — default `""`.
  - `memConflictAtom: PrimitiveAtom<boolean>` — default `false`.
  - `selectNote(id: string): Promise<void>` — now also, synchronously before its `await`, sets `memRailOpenAtom=true`, `memEditingAtom=false`, `memConflictAtom=false`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/memstore.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

// selectNote fires MemoryReadCommand over TabRpcClient; stub the RPC layer so the test
// exercises only the synchronous atom side-effects (open drawer, clear edit state).
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { MemoryReadCommand: vi.fn().mockResolvedValue({ body: "", note: { updatedts: 0 } }) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import { memConflictAtom, memEditingAtom, memNotesAtom, memRailOpenAtom, selectNote } from "./memstore";
import type { MemNote } from "./memtypes";

const note = (id: string): MemNote =>
    ({ id, path: `/vault/${id}.md`, source: "vault", title: id, description: "", type: "user", scope: "global", updatedts: 0 }) as MemNote;

describe("memstore drawer + edit state", () => {
    beforeEach(() => {
        globalStore.set(memNotesAtom, [note("a"), note("b")]);
        // simulate a collapsed drawer with a stale edit session, then verify selectNote resets it
        globalStore.set(memRailOpenAtom, false);
        globalStore.set(memEditingAtom, true);
        globalStore.set(memConflictAtom, true);
    });

    it("selectNote opens the drawer and clears stale edit state", async () => {
        await selectNote("a");
        expect(globalStore.get(memRailOpenAtom)).toBe(true);
        expect(globalStore.get(memEditingAtom)).toBe(false);
        expect(globalStore.get(memConflictAtom)).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/memstore.test.ts`
Expected: FAIL — `memRailOpenAtom`/`memEditingAtom`/`memConflictAtom`/`memDraftAtom` are not exported (import error), and `selectNote` does not set them.

- [ ] **Step 3: Add the atoms**

In `frontend/app/view/agents/memstore.ts`, after the `memReflowAnimatedAtom` declaration (currently line 34), add:

```ts
// Drawer open/closed (shared CollapsibleRail). Module-scope so it persists across MemorySurface
// remounts; default open because the detail view is the point of the tab.
export const memRailOpenAtom = atom<boolean>(true) as PrimitiveAtom<boolean>;

// Edit draft lifted out of the rail component: CollapsibleRail unmounts its content when collapsed,
// so an in-progress draft would be lost on collapse if held in local useState.
export const memEditingAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const memDraftAtom = atom<string>("") as PrimitiveAtom<string>;
export const memConflictAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
```

- [ ] **Step 4: Wire `selectNote`**

In `selectNote` (currently starts line 58), add the drawer-open + edit-reset side effects immediately after setting the selected id. Replace:

```ts
export async function selectNote(id: string): Promise<void> {
    globalStore.set(memSelectedIdAtom, id);
    globalStore.set(memBodyAtom, null);
```

with:

```ts
export async function selectNote(id: string): Promise<void> {
    globalStore.set(memSelectedIdAtom, id);
    globalStore.set(memBodyAtom, null);
    globalStore.set(memRailOpenAtom, true); // selecting a note opens a collapsed drawer
    globalStore.set(memEditingAtom, false); // leaving a note drops its edit mode/conflict
    globalStore.set(memConflictAtom, false);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/memstore.test.ts`
Expected: PASS (1 passing).

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no new errors.

- [ ] **Step 7: Checkpoint (no commit)**

Run: `git add -N frontend/app/view/agents/memstore.ts frontend/app/view/agents/memstore.test.ts && git diff --stat`
Show the diff summary to the reviewer. Do NOT commit — the batched commit happens after Task 2 is approved.

---

### Task 2: Swap DetailRail for CollapsibleRail

Replace the bespoke `<aside>` with `CollapsibleRail`, and make `DetailBody` read edit state from the Task 1 atoms instead of local `useState`. Verified by tsc + live-app CDP (no render harness exists for the cockpit — CLAUDE.md).

**Files:**
- Modify: `frontend/app/view/agents/memorysurface.tsx`

**Interfaces:**
- Consumes (from Task 1): `memRailOpenAtom`, `memEditingAtom`, `memDraftAtom`, `memConflictAtom`.
- Consumes (existing): `CollapsibleRail`, `type RailSection` (`@/app/element/collapsiblerail`); `RAIL_ICON` (`./railicons`).
- Produces: the rendered Memory surface using the shared rail. No new exports.

- [ ] **Step 1: Update imports**

At the top of `frontend/app/view/agents/memorysurface.tsx`, add:

```ts
import { CollapsibleRail, type RailSection } from "@/app/element/collapsiblerail";
import { RAIL_ICON } from "./railicons";
```

Extend the existing `./memstore` import to include the new atoms:

```ts
import {
    deleteNote,
    loadMemory,
    memBodyAtom,
    memConflictAtom,
    memDraftAtom,
    memEditingAtom,
    memEdgesAtom,
    memLoadedAtom,
    memNotesAtom,
    memRailOpenAtom,
    memReflowAnimatedAtom,
    memSearchAtom,
    memSelectedIdAtom,
    memViewAtom,
    saveNote,
    selectNote,
} from "./memstore";
```

Add `useAtom` to the jotai import (it currently imports only `useAtomValue`):

```ts
import { useAtom, useAtomValue } from "jotai";
```

- [ ] **Step 2: `DetailBody` reads edit state from atoms**

`DetailBody` currently receives `editing/draft/conflict` and their setters as props from `DetailRail`. Change its signature to take only the note-derived props and read/write the edit atoms itself. Replace the `DetailBody` prop destructuring header (currently `function DetailBody({ sel, body, related, editing, draft, conflict, setDraft, startEdit, doSave, setEditing, setConflict }: {...})`) with:

```tsx
function DetailBody({
    sel,
    body,
    related,
}: {
    sel: MemNote;
    body: { body: string; mtime: number } | null;
    related: MemNote[];
}) {
    const [editing, setEditing] = useAtom(memEditingAtom);
    const [draft, setDraft] = useAtom(memDraftAtom);
    const [conflict, setConflict] = useAtom(memConflictAtom);

    const startEdit = () => {
        setDraft(body?.body ?? "");
        setConflict(false);
        setEditing(true);
    };
    const doSave = () => {
        const baseMtime = body?.mtime ?? 0;
        fireAndForget(async () => {
            const r = await saveNote(sel.path, draft, baseMtime);
            if (r.conflict) {
                setConflict(true); // file changed on disk since open; reload to see it
            } else {
                setEditing(false);
            }
        });
    };
```

Leave the entire JSX body of `DetailBody` (from `const m = typeMeta(sel.type);` onward) unchanged — it already references `editing`, `draft`, `conflict`, `setDraft`, `startEdit`, `doSave`, `setEditing`, `setConflict`, which are now locals.

- [ ] **Step 3: Replace `DetailRail` with a CollapsibleRail builder**

Replace the whole `DetailRail` function (currently lines ~313-384, the `<aside>` version with its own `useState`/`useEffect`) with a component that builds one `RailSection` and hands it to `CollapsibleRail`:

```tsx
function DetailRail({ notes }: { notes: MemNote[] }) {
    const selectedId = useAtomValue(memSelectedIdAtom);
    const body = useAtomValue(memBodyAtom);
    const edges = useAtomValue(memEdgesAtom);
    const sel = notes.find((n) => n.id === selectedId);

    const relatedIds = new Set<string>();
    if (sel) {
        for (const e of edges) {
            if (e.from === sel.id) relatedIds.add(e.to);
            if (e.to === sel.id) relatedIds.add(e.from);
        }
    }
    const related = notes.filter((n) => relatedIds.has(n.id));

    const sections: RailSection[] = [
        {
            id: "detail",
            icon: RAIL_ICON.info,
            label: "Memory detail",
            content: (
                <AnimatePresence mode="wait">
                    <motion.div
                        key={sel ? sel.id : "empty"}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1, transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid } }}
                        exit={{ opacity: 0, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } }}
                    >
                        {!sel ? (
                            <div className="text-[13px] text-ink-mid">Select a memory to see its content.</div>
                        ) : (
                            <DetailBody sel={sel} body={body} related={related} />
                        )}
                    </motion.div>
                </AnimatePresence>
            ),
        },
    ];

    return <CollapsibleRail openAtom={memRailOpenAtom} ariaLabel="Memory detail" sections={sections} />;
}
```

Note: the reset-edit-on-selection `useEffect` that lived in the old `DetailRail` is gone — `selectNote` (Task 1) now owns that reset. `useState` is no longer used by `DetailRail`; leave the `useState` import in place only if `MemorySurface` still uses it (it does — `mountedEmpty`, `newOpen`, `focusedCwd`).

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. Common misses: an unused `useState`/`useEffect` import (only remove if truly unused), or a leftover reference to a removed `DetailBody` prop.

- [ ] **Step 5: Re-run the memstore test (guard against regressions)**

Run: `npx vitest run frontend/app/view/agents/memstore.test.ts`
Expected: PASS.

- [ ] **Step 6: Live-app visual/behavior verification (CDP)**

The cockpit has no render-test harness; verify in the running dev app.

1. Ensure `task dev` is running (WebView2 CDP on `:9222`).
2. If memory is empty, inject data: `node scripts/inject-live-agents.mjs <scenario>` (see script header), or create a note via "New memory".
3. Screenshot the Memory tab: `node scripts/cdp-shot.mjs memory-open.png`.

Confirm each:
- (a) Drawer is **open** on entry, width ~300px, border matches the Agent rail (`border-border`).
- (b) Click the collapse chevron → drawer shrinks to the 44px strip with the info glyph; **Header (Search/Graph·List/New memory) and SyncStrip (Pull/Project now) do not move**.
- (c) While collapsed, click a note in the list → drawer expands and shows that note's detail.
- (d) Start editing a note, type in the textarea, collapse the drawer, expand again → the draft text is **still there** (proves the atom lift).
- (e) Switch to Graph view, toggle the drawer → nodes stay put (no re-simulation), canvas just resizes.

Capture before/after screenshots for the reviewer.

- [ ] **Step 7: Checkpoint (no commit)**

Run: `git diff --stat`
Show the full diff and the CDP screenshots to the reviewer.

---

### Final: Batched commit (after approval)

- [ ] **Step 1: Request approval per the STRICT git workflow**

Show: files to commit with M/A status and one-line summaries, plus the proposed message:

```
refactor(memory): use shared CollapsibleRail for the detail drawer
```

Ask: "Awaiting approval. Proceed? (yes/no)"

- [ ] **Step 2: Commit only on explicit "yes"**

```bash
git add frontend/app/view/agents/memstore.ts \
        frontend/app/view/agents/memstore.test.ts \
        frontend/app/view/agents/memorysurface.tsx \
        docs/superpowers/specs/2026-07-04-memory-rail-collapsible-migration-design.md \
        docs/superpowers/plans/2026-07-04-memory-rail-collapsible-migration.md
git commit -m "refactor(memory): use shared CollapsibleRail for the detail drawer"
```

---

## Notes for the implementer

- **Why lift edit state to atoms (Task 1):** `CollapsibleRail` renders an icon-only branch when collapsed, unmounting `sections[].content`. Local `useState` in `DetailBody` would be destroyed on collapse, silently discarding a draft. Atoms outlive the unmount.
- **Why the header can't shift (Task 2):** `Header` and `SyncStrip` are `flex-none` rows above the `flex min-h-0 flex-1` content row; the rail lives *inside* that content row. Rail width changes reflow only the content row, never the two rows above it. Do not move the rail out to a full-height sibling (that is the Agent-surface topology and would make the header reflow).
- **Width note:** the drawer is now 300px, not the old 330px — intentional (matches the app-bar usage column for a continuous divider, per `collapsiblerail.tsx:24`).
