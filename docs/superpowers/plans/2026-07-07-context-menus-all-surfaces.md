# Context Menus Across Cockpit Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add themed right-click menus to the 5 remaining cockpit surfaces (Channels, Activity, Files, Sessions, Memory) and curate two items into the existing card + transcript menus.

**Architecture:** Each right-clickable row gets an `onContextMenu` handler calling `ContextMenuModel.getInstance().showContextMenu(items, e)` — the same imperative API and themed `<ContextMenuHost/>` (already mounted in `cockpit-root`) the shipped feature uses. Every menu item reuses a handler the surface already calls for a button/click; no new backend calls, no new store, no changes to `contextmenu.ts`/`contextmenu.tsx`. Only pure additions inside surface files, plus one small pure helper (`conversationText`) extracted for a unit test.

**Tech Stack:** React 19, jotai, `ContextMenuItem` (ambient global type, `frontend/types/custom.d.ts:153`), Tailwind v4 `@theme` tokens, vitest.

**Spec:** `docs/superpowers/specs/2026-07-07-context-menus-all-surfaces-design.md`

**Git note (overrides the skill's per-task commits):** Per the user's git workflow, do NOT commit per-task and do NOT commit without explicit approval. Tasks 1–8 end at a **typecheck** (Task 1 also at a passing unit test) as their checkpoint. Task 9 runs the full suite + CDP checklist and makes **one** feature commit after the user approves. The spec + this plan fold into that commit (never a docs-only commit).

---

## File Structure

- `frontend/app/view/agents/agentsviewmodel.ts` — MODIFY. Add pure `conversationText(entries)` helper next to `AgentEntry`/`groupTimeline` (Task 1).
- `frontend/app/view/agents/agentsviewmodel.test.ts` — MODIFY. Add `conversationText` tests (Task 1).
- `frontend/app/view/agents/narrationtimeline.tsx` — MODIFY. Add "Copy conversation" to the transcript menu (Task 1).
- `frontend/app/view/agents/agentrow.tsx` — MODIFY. Add "Copy name" to the card menu (Task 2).
- `frontend/app/view/agents/activitysurface.tsx` — MODIFY. Event-row menu (Task 3).
- `frontend/app/view/agents/filessurface.tsx` — MODIFY. Changed-file-row menu (Task 4).
- `frontend/app/view/agents/sessionssurface.tsx` — MODIFY. Session-row menu (Task 5).
- `frontend/app/view/agents/memorysurface.tsx` — MODIFY. Note-row menu (Task 6).
- `frontend/app/view/agents/channelsprimitives.tsx` — MODIFY. Worker-row menu (Task 7).
- `frontend/app/view/agents/channelrail.tsx` — MODIFY. Channel-rail row menu + `onSetTier` prop (Task 8).
- `frontend/app/view/agents/channelssurface.tsx` — MODIFY. Wire `onSetTier` into `<ChannelRail>` (Task 8).

**Why this order:** the one task with pure logic (Task 1) is TDD-first. The rest are view wiring, ordered simplest→richest (a one-line add, then single-menu surfaces, then Channels which needs a new prop + cross-file wiring). Each task is independently reviewable; nothing depends on a later task.

**Typecheck command (used in every task):**
`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows on this repo; baseline is exit 0).

---

### Task 1: Transcript "Copy conversation" (+ testable helper)

Adds a second item to the transcript menu that copies the whole conversation. The join is a pure function, so it's extracted and unit-tested; the menu wiring reuses it.

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`
- Modify: `frontend/app/view/agents/narrationtimeline.tsx`

- [ ] **Step 1: Write the failing test**

In `frontend/app/view/agents/agentsviewmodel.test.ts`, add `conversationText` to the existing import from `./agentsviewmodel` (the long import on line 2 — append `, conversationText` before the closing `} from "./agentsviewmodel";`). Then append this block at the end of the file:

```ts
describe("conversationText", () => {
    it("joins message and user prose with blank lines, dropping tool actions", () => {
        const entries: AgentEntry[] = [
            { kind: "user", text: "add a test" },
            { kind: "action", verb: "Read", target: "file.ts", outcome: "ok" },
            { kind: "message", text: "done — added it" },
        ];
        expect(conversationText(entries)).toBe("add a test\n\ndone — added it");
    });

    it("returns an empty string when there is no prose", () => {
        expect(conversationText([{ kind: "action", verb: "Bash", target: "ls" }])).toBe("");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t conversationText`
Expected: FAIL — `conversationText` is not exported.

- [ ] **Step 3: Add the helper**

In `frontend/app/view/agents/agentsviewmodel.ts`, directly after the `groupTimeline` function (it returns `TimelineItem[]`), add:

```ts
// Joins the prose (message + user) entries of a transcript into one copyable string. Tool actions
// are omitted — they are not conversational content.
export function conversationText(entries: AgentEntry[]): string {
    const out: string[] = [];
    for (const e of entries) {
        if (e.kind === "message" || e.kind === "user") {
            out.push(e.text);
        }
    }
    return out.join("\n\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t conversationText`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire "Copy conversation" into the transcript menu**

In `frontend/app/view/agents/narrationtimeline.tsx`, update the import on line 9 to add `conversationText`:

```tsx
import { conversationText, groupTimeline, summarizeActions, type AgentActionEntry, type AgentEntry } from "./agentsviewmodel";
```

Then replace the existing `copyMenu` factory:

```tsx
    const copyMenu = (text: string) => (e: React.MouseEvent) =>
        ContextMenuModel.getInstance().showContextMenu(
            [{ label: "Copy text", click: () => void navigator.clipboard.writeText(text) }],
            e
        );
```

with:

```tsx
    const copyMenu = (text: string) => (e: React.MouseEvent) =>
        ContextMenuModel.getInstance().showContextMenu(
            [
                { label: "Copy text", click: () => void navigator.clipboard.writeText(text) },
                { label: "Copy conversation", click: () => void navigator.clipboard.writeText(conversationText(entries)) },
            ],
            e
        );
```

(`entries` is the component prop already in scope.)

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 2: Card "Copy name"

Adds a copy group to the existing cockpit card menu (`agentrow.tsx`). One item, before the separator.

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx`

No unit test (view wiring). `ContextMenuModel` and the menu builder already exist here.

- [ ] **Step 1: Add the copy item to the menu builder**

In `frontend/app/view/agents/agentrow.tsx`, in the `onContextMenu` handler, find:

```tsx
        items.push({ type: "separator" });
        items.push({ label: "Close agent", click: () => confirmCloseAgent(agent.id, agent.name) });
```

Insert the copy item immediately **before** the separator so the order becomes copy → separator → destructive:

```tsx
        items.push({ label: "Copy name", click: () => void navigator.clipboard.writeText(agent.name) });
        items.push({ type: "separator" });
        items.push({ label: "Close agent", click: () => confirmCloseAgent(agent.id, agent.name) });
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 3: Activity event-row menu

Adds a right-click menu to each activity event row. Reuses `jump` (module-local, live-only) and `model.activityFilterAtom` (the same set the filter chips use).

**Files:**
- Modify: `frontend/app/view/agents/activitysurface.tsx`

- [ ] **Step 1: Add the import**

In `frontend/app/view/agents/activitysurface.tsx`, add after the existing `@/util/util` import (line 11):

```tsx
import { ContextMenuModel } from "@/app/store/contextmenu";
```

- [ ] **Step 2: Attach the menu to the event row**

Find the event-row `motion.div` (the one with `className="flex gap-4 border-b border-edge-faint px-1 py-3.5 hover:bg-surface"`) and add an `onContextMenu` prop right after that `className`:

```tsx
                                                    className="flex gap-4 border-b border-edge-faint px-1 py-3.5 hover:bg-surface"
                                                    onContextMenu={(ev) => {
                                                        const items: ContextMenuItem[] = [];
                                                        if (e.live) {
                                                            items.push({ label: "Jump to agent", click: () => jump(model, e) });
                                                        }
                                                        items.push({
                                                            label: `Filter to ${TYPE_META[e.type].label}`,
                                                            click: () => globalStore.set(model.activityFilterAtom, e.type),
                                                        });
                                                        items.push({ label: "Copy summary", click: () => void navigator.clipboard.writeText(e.text) });
                                                        items.push({ label: "Copy project", click: () => void navigator.clipboard.writeText(e.project) });
                                                        ContextMenuModel.getInstance().showContextMenu(items, ev);
                                                    }}
```

(`e` is the row's `ActivityEvent`, `model`, `globalStore`, `TYPE_META`, and `jump` are all in scope at this render site.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 4: Files changed-file-row menu

Adds a menu to each browse-mode changed-file row. Row-click already opens the diff, so the menu adds Open-in-editor + copy paths. The menu is built at the `.map` call site (where `state.cwd` and `getApi()` are in scope) and passed to `FileRow` as a new `onContextMenu` prop.

**Files:**
- Modify: `frontend/app/view/agents/filessurface.tsx`

- [ ] **Step 1: Add the import**

In `frontend/app/view/agents/filessurface.tsx`, add after the `@/app/store/global` import (line 8):

```tsx
import { ContextMenuModel } from "@/app/store/contextmenu";
```

- [ ] **Step 2: Add an `onContextMenu` prop to `FileRow`**

Replace the `FileRow` signature and root `<button>` opening tag. Find:

```tsx
function FileRow({ change, selected, onSelect }: { change: GitChange; selected: boolean; onSelect: () => void }) {
    return (
        <button
            onClick={onSelect}
```

with:

```tsx
function FileRow({
    change,
    selected,
    onSelect,
    onContextMenu,
}: {
    change: GitChange;
    selected: boolean;
    onSelect: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
}) {
    return (
        <button
            onClick={onSelect}
            onContextMenu={onContextMenu}
```

- [ ] **Step 3: Build and pass the menu at the map site**

Find the `<FileRow>` usage:

```tsx
                                    <FileRow
                                        change={c}
                                        selected={c.path === selected}
                                        onSelect={() => state.cwd && fireAndForget(() => selectFile(state.cwd!, c.path))}
                                    />
```

Replace with:

```tsx
                                    <FileRow
                                        change={c}
                                        selected={c.path === selected}
                                        onSelect={() => state.cwd && fireAndForget(() => selectFile(state.cwd!, c.path))}
                                        onContextMenu={(ev) => {
                                            const cwd = state.cwd;
                                            if (!cwd) {
                                                return;
                                            }
                                            ContextMenuModel.getInstance().showContextMenu(
                                                [
                                                    { label: "Open in editor", click: () => getApi().openExternal(`${cwd}/${c.path}`) },
                                                    { label: "Copy path", click: () => void navigator.clipboard.writeText(c.path) },
                                                    { label: "Copy absolute path", click: () => void navigator.clipboard.writeText(`${cwd}/${c.path}`) },
                                                ],
                                                ev
                                            );
                                        }}
                                    />
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 5: Sessions session-row menu

Adds a menu to each session row. Reuses `resume` (guarded by `resumecommand`); Resume is disabled (not hidden) when the session is read-only.

**Files:**
- Modify: `frontend/app/view/agents/sessionssurface.tsx`

- [ ] **Step 1: Add the import**

In `frontend/app/view/agents/sessionssurface.tsx`, add after the `@/app/cockpit/cockpit-actions` import (line 7):

```tsx
import { ContextMenuModel } from "@/app/store/contextmenu";
```

- [ ] **Step 2: Attach the menu to the session row**

Find the session-row `motion.div` opening tag (with `className="flex items-center gap-[11px] border-b border-border px-[14px] py-[12px] last:border-b-0 hover:bg-surface-hover"`) and add an `onContextMenu` prop right after that `className`:

```tsx
                                            className="flex items-center gap-[11px] border-b border-border px-[14px] py-[12px] last:border-b-0 hover:bg-surface-hover"
                                            onContextMenu={(ev) => {
                                                const items: ContextMenuItem[] = [
                                                    { label: "Resume", enabled: !!s.resumecommand, click: () => resume(s) },
                                                ];
                                                if (s.resumecommand) {
                                                    items.push({ label: "Copy resume command", click: () => void navigator.clipboard.writeText(s.resumecommand) });
                                                }
                                                items.push({ label: "Copy project path", click: () => void navigator.clipboard.writeText(s.projectpath) });
                                                ContextMenuModel.getInstance().showContextMenu(items, ev);
                                            }}
```

(`s` is the row's `SessionInfo` and `resume` is in scope at this render site.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 6: Memory note-row menu

Adds a menu to each memory note list-row. Reuses `selectNote(id)` and `deleteNote(path)` (both imported store actions). Delete matches the existing no-confirm parity (see spec).

**Files:**
- Modify: `frontend/app/view/agents/memorysurface.tsx`

- [ ] **Step 1: Add the import**

In `frontend/app/view/agents/memorysurface.tsx`, add after the `@/app/store/jotaiStore` import (line 11):

```tsx
import { ContextMenuModel } from "@/app/store/contextmenu";
```

- [ ] **Step 2: Attach the menu to the note row**

Find the note-row `motion.button` and its `onClick={() => fireAndForget(() => selectNote(n.id))}` line. Add an `onContextMenu` prop right after that `onClick`:

```tsx
                                        onClick={() => fireAndForget(() => selectNote(n.id))}
                                        onContextMenu={(ev) =>
                                            ContextMenuModel.getInstance().showContextMenu(
                                                [
                                                    { label: "Open", click: () => fireAndForget(() => selectNote(n.id)) },
                                                    { label: "Copy title", click: () => void navigator.clipboard.writeText(n.title) },
                                                    { label: "Copy path", click: () => void navigator.clipboard.writeText(n.path) },
                                                    { type: "separator" },
                                                    { label: "Delete", click: () => fireAndForget(() => deleteNote(n.path)) },
                                                ],
                                                ev
                                            )
                                        }
```

(`n` is the row's `MemNote`; `selectNote`, `deleteNote`, `fireAndForget` are all in scope.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 7: Channels worker-row menu

Adds a menu to each fleet worker row. Reuses `jumpToAgent`; "Open agent" is disabled when the worker is `gone`.

**Files:**
- Modify: `frontend/app/view/agents/channelsprimitives.tsx`

- [ ] **Step 1: Add the import**

In `frontend/app/view/agents/channelsprimitives.tsx`, add after the `@/app/store/jotaiStore` import (line 8):

```tsx
import { ContextMenuModel } from "@/app/store/contextmenu";
```

- [ ] **Step 2: Attach the menu to the worker row**

In `WorkerRow`, replace the root `<div className="mb-2.5">` opening tag with:

```tsx
        <div
            className="mb-2.5"
            onContextMenu={(ev) =>
                ContextMenuModel.getInstance().showContextMenu(
                    [
                        {
                            label: "Open agent",
                            enabled: w.state !== "gone",
                            click: () => jumpToAgent(model, w.oref.slice("tab:".length)),
                        },
                    ],
                    ev
                )
            }
        >
```

(`w` and `model` are `WorkerRow`'s props; `jumpToAgent` is defined in this file.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 8: Channels channel-rail row menu (+ Autonomy submenu)

Adds a menu to each channel-rail row: Open, an Autonomy submenu (Concierge/Gatekeeper/Delegator, checkbox on current), and Delete channel. Open and Delete reuse existing props; the submenu needs one new `onSetTier` prop wired in `channelssurface.tsx` (reusing the exact `SetChannelTierCommand` call the header button makes).

**Files:**
- Modify: `frontend/app/view/agents/channelrail.tsx`
- Modify: `frontend/app/view/agents/channelssurface.tsx`

- [ ] **Step 1: Add imports and the `onSetTier` prop to `ChannelRail`**

In `frontend/app/view/agents/channelrail.tsx`:

Update the `channelmessages` import (line 12) to also import the tier type:

```tsx
import { tierFromMeta, type JarvisTier } from "./channelmessages";
```

Add the context-menu import after the `@/util/util` import (line 8):

```tsx
import { ContextMenuModel } from "@/app/store/contextmenu";
```

In the props destructure, add `onSetTier` after `onDeleteChannel,`:

```tsx
    onDeleteChannel,
    onSetTier,
```

In the props type, add after `onDeleteChannel: (id: string) => void;`:

```tsx
    onDeleteChannel: (id: string) => void;
    onSetTier: (id: string, tier: JarvisTier) => void;
```

- [ ] **Step 2: Attach the menu to the channel-rail row**

Find the per-channel row wrapper:

```tsx
                    return (
                        <div key={c.oid} className="group relative">
```

Replace that opening `<div>` with an `onContextMenu` that builds the menu (the `tier` const is already computed just above on line 57):

```tsx
                    return (
                        <div
                            key={c.oid}
                            className="group relative"
                            onContextMenu={(ev) =>
                                ContextMenuModel.getInstance().showContextMenu(
                                    [
                                        { label: "Open", click: () => onSelect(c.oid) },
                                        {
                                            label: "Autonomy",
                                            submenu: (["concierge", "gatekeeper", "delegator"] as JarvisTier[]).map(
                                                (t): ContextMenuItem => ({
                                                    label: t.charAt(0).toUpperCase() + t.slice(1),
                                                    type: "checkbox",
                                                    checked: tier === t,
                                                    click: () => onSetTier(c.oid, t),
                                                })
                                            ),
                                        },
                                        { type: "separator" },
                                        { label: "Delete channel", click: () => onDeleteChannel(c.oid) },
                                    ],
                                    ev
                                )
                            }
                        >
```

- [ ] **Step 3: Wire `onSetTier` into `<ChannelRail>` in channelssurface**

In `frontend/app/view/agents/channelssurface.tsx`, find the `<ChannelRail>` usage and its `onDeleteChannel` prop:

```tsx
                    onDeleteChannel={(id) => fireAndForget(() => deleteChannel(id))}
                />
```

Replace with (adds `onSetTier`, reusing the same `SetChannelTierCommand` call the header uses, resolving `mode` from the channel's meta):

```tsx
                    onDeleteChannel={(id) => fireAndForget(() => deleteChannel(id))}
                    onSetTier={(id, t) =>
                        fireAndForget(() =>
                            RpcApi.SetChannelTierCommand(TabRpcClient, {
                                channelid: id,
                                tier: t,
                                mode:
                                    ((channels?.find((c) => c.oid === id)?.meta as Record<string, unknown> | undefined)?.[
                                        "delegator:mode"
                                    ] as string) ?? "report",
                            })
                        )
                    }
                />
```

(`RpcApi`, `TabRpcClient`, and `channels` are already in scope in this file — `RpcApi.SetChannelTierCommand` is called identically in the header at ~line 1011.)

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 9: Full verification + single feature commit

No code changes — this task runs the whole suite, the typecheck, the CDP visual pass, and makes the one approved commit.

- [ ] **Step 1: Full unit-test suite**

Run: `npx vitest run`
Expected: PASS — the prior baseline (752 passed, 2 skipped) plus the 2 new `conversationText` tests → 754 passed, 2 skipped.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: CDP visual pass (dev app on `:9222`)**

Start the dev app if needed (`task dev`), inject data where a surface is empty (`node scripts/inject-live-agents.mjs <scenario>`), then right-click and screenshot each:

- Transcript row → "Copy text / Copy conversation" — `node scripts/cdp-shot.mjs ctx-transcript.png`
- Cockpit card → menu now includes "Copy name" — `node scripts/cdp-shot.mjs ctx-card.png`
- Activity event row → "Jump to agent (live only) / Filter to … / Copy summary / Copy project" — `node scripts/cdp-shot.mjs ctx-activity.png`
- Files changed-file row → "Open in editor / Copy path / Copy absolute path" — `node scripts/cdp-shot.mjs ctx-files.png`
- Sessions row → "Resume (disabled if read-only) / Copy resume command / Copy project path" — `node scripts/cdp-shot.mjs ctx-sessions.png`
- Memory note row → "Open / Copy title / Copy path / — / Delete" — `node scripts/cdp-shot.mjs ctx-memory.png`
- Channels channel-rail row → "Open / Autonomy ▸ / — / Delete channel" and worker row → "Open agent" — `node scripts/cdp-shot.mjs ctx-channels.png`

Expected: each themed panel shows the specified items; each action fires (e.g. "Filter to Asked" narrows Activity; "Autonomy → Gatekeeper" flips the rail chip).

- [ ] **Step 4: Stage the feature + fold in the docs, show the diff, request approval**

Show `git status` + `git diff --stat` for the surface files, the two docs, and the prior uncommitted context-menu files (if committing together). Do NOT stage `frontend/app/store/keybindings/bindings.ts` / `bindings.test.ts` — those are unrelated concurrent work.

Present the commit message and ask for approval per the user's git workflow:

```
feat(contextmenu): right-click menus across cockpit surfaces

Add themed row menus to Channels, Activity, Files, Sessions, Memory and
curate Copy name / Copy conversation into the card + transcript menus.
Each item reuses an existing handler; no new backend calls.
```

- [ ] **Step 5: Commit only after explicit approval**

```bash
git add <surface files> <spec> <plan>
git commit -m "feat(contextmenu): right-click menus across cockpit surfaces"
```

---

## Self-review notes

- **Spec coverage:** every spec surface has a task — Activity(3), Files(4), Sessions(5), Memory(6), Channels rail+worker(7,8); re-curation: card Copy name(2), transcript Copy conversation(1). Usage/Settings intentionally absent (deferred in spec). ✅
- **Type consistency:** `conversationText(entries: AgentEntry[])` defined in Task 1 and imported the same way in narrationtimeline; `onSetTier(id, tier: JarvisTier)` prop defined in channelrail Task 8 and wired with the matching signature in channelssurface Task 8; `ContextMenuItem` is the ambient global used unqualified (as in existing menus). ✅
- **No placeholders:** every code step shows the exact code and the anchor to place it. ✅
- **Naming deviation from spec:** the Channels tier submenu is labeled **"Autonomy"** (matches the rail's existing "autonomy" language and the header tooltip), not "Tier". Flagged for reviewer; trivial to rename.
