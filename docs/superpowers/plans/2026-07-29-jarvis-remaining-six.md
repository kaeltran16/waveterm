# Jarvis Remaining Six — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last six open Jarvis items — JC17, JC8's cancel half, JC16 step 4 plus the overlay step, gaps 12b, 12c and last-subject persistence.

**Architecture:** Six independent changes, not one system. Four are frontend-only; one adds two wshrpc commands and two summary fields; one touches both. Each keeps its decision in a pure, unit-testable function and its wiring thin — the surface's recurring defect class is a bad hop *between* atoms, which unit tests cannot see, so anything cross-atom gets a CDP step instead.

**Tech Stack:** React 19 + jotai + Tailwind 4 (frontend), Go + wshrpc + SQLite/wstore (backend), vitest (unit), CDP scenarios via `task verify:ui` (live surface).

**Spec:** [`docs/superpowers/specs/2026-07-29-jarvis-remaining-six-design.md`](../specs/2026-07-29-jarvis-remaining-six-design.md)

## Global Constraints

- **Commits.** This repo's CLAUDE.md overrides the usual per-task commit: **never commit without explicit approval**, and batch into **one commit at the end**. Task steps below therefore end at "verify", not "commit". The spec and this plan fold into that single feature commit — never a separate docs-only commit.
- **Typecheck.** `npx tsc` stack-overflows here. Always run `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is exit 0; any error is yours.
- **Never hand-edit generated files.** Go is the source of truth for wire types. After changing anything under `pkg/wshrpc`, run `task generate` — do not edit `frontend/app/store/wshclientapi.ts` or the generated TS types.
- **No new SCSS.** Tailwind only. No raw hex/rgba — use `@theme` tokens from `tailwindsetup.css`.
- **No emojis** in code, comments, or UI copy.
- **Comments explain "why", never "what".** Lower case, only where the reason is not obvious.
- **Prettier.** Do not run `prettier --write` on files you did not author end-to-end — it reorders imports and reflows whole files, turning a 4-line edit into a 600-line diff. Hand-format your own lines to match the file.
- **Go tests** need the CGO flags the Taskfile sets. `go test ./pkg/wshrpc/wshserver/` works today; if it build-fails, use the Taskfile's `CGO_CFLAGS` with a Windows-style `-I` path.
- **Tuned constants — only two in this whole plan.** `CURSOR_COMMIT_MS = 150` (Task 1) and `NAV_NARROW_WINDOW_PX = 900` (Task 3). Everything else derives from `STAGE_MIN_PX` and the mirrored region widths.

## File Structure

**Created**
- `frontend/app/view/jarvis/subjectcursor.ts` — the idle-commit scheduler (Task 1)
- `frontend/app/view/jarvis/subjectcursor.test.ts` — its tests
- `frontend/app/view/jarvis/subjectrestore.ts` — the pure last-subject restore decision (Task 8)
- `frontend/app/view/jarvis/subjectrestore.test.ts` — its tests
- `frontend/app/view/agents/navrailwidth.ts` + `.test.ts` — nav rail width rule (Task 3)

**Modified**
- `frontend/app/view/jarvis/subjectscolumn.tsx` — cursor wiring (1), thread menu (6)
- `frontend/app/view/jarvis/jarviscontract.ts` — `cancelled` terminal, `streaming` flag (2)
- `frontend/app/view/jarvis/jarvisstore.ts` — stream registry, cancel, archive/delete, rehydrate (2, 6, 7)
- `frontend/app/view/jarvis/jarvisturnderive.ts` / `jarvisturn.tsx` — badge + Cancel control (2)
- `frontend/app/view/jarvis/jarvislayout.ts` + `.test.ts` — overlay step (4)
- `frontend/app/view/jarvis/jarvissurface.tsx` / `stagerail.tsx` — overlay rendering (4)
- `frontend/app/view/agents/navrail.tsx` — self-collapse (3)
- `frontend/app/view/jarvis/subjects.ts` + `.test.ts` — archived threads (6)
- `frontend/app/view/jarvis/tasksstore.ts` — nullable list (8)
- `pkg/wshrpc/wshrpctypes_jarvis.go`, `pkg/wshrpc/wshserver/wshserver_jarvis.go` (+ test) — commands + summary fields (5)
- `scripts/cdp/scenarios.mjs` — `jarvis-narrow` scenario, restore + thread-lifecycle steps
- `docs/jarvis-tab.md`, `docs/jarvis-consolidation-open-issues.md` — status (Task 9)

---

### Task 1: JC17 — commit the cursor on idle

`j`/`k` currently fires `selectSubject` per keypress — an RPC, a record-scope resolve, and a prune of any unasked thread passed over. The `listnav.ts` contract (`cursor == selection`) is shared by five surfaces and stays untouched; only the commit timing changes.

**Files:**
- Create: `frontend/app/view/jarvis/subjectcursor.ts`
- Test: `frontend/app/view/jarvis/subjectcursor.test.ts`
- Modify: `frontend/app/view/jarvis/subjectscolumn.tsx:161-174` (the `listNav` controller)

**Interfaces:**
- Produces: `createCommitScheduler(commit: (id: string) => void, delayMs?: number): CommitScheduler` where `CommitScheduler = { schedule(id: string): void; flush(): void; cancel(): void }`, and `CURSOR_COMMIT_MS: number`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/jarvis/subjectcursor.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommitScheduler, CURSOR_COMMIT_MS } from "./subjectcursor";

describe("createCommitScheduler", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("does not commit before the idle window elapses", () => {
        const commit = vi.fn();
        createCommitScheduler(commit).schedule("channel:a");
        vi.advanceTimersByTime(CURSOR_COMMIT_MS - 1);
        expect(commit).not.toHaveBeenCalled();
    });

    it("commits once for a burst, with the last id", () => {
        const commit = vi.fn();
        const s = createCommitScheduler(commit);
        s.schedule("channel:a");
        s.schedule("channel:b");
        s.schedule("dossier:c");
        vi.advanceTimersByTime(CURSOR_COMMIT_MS);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledWith("dossier:c");
    });

    it("commits each deliberate move separately", () => {
        const commit = vi.fn();
        const s = createCommitScheduler(commit);
        s.schedule("channel:a");
        vi.advanceTimersByTime(CURSOR_COMMIT_MS);
        s.schedule("channel:b");
        vi.advanceTimersByTime(CURSOR_COMMIT_MS);
        expect(commit.mock.calls).toEqual([["channel:a"], ["channel:b"]]);
    });

    it("flush commits immediately and only once", () => {
        const commit = vi.fn();
        const s = createCommitScheduler(commit);
        s.schedule("channel:a");
        s.flush();
        expect(commit).toHaveBeenCalledWith("channel:a");
        vi.advanceTimersByTime(CURSOR_COMMIT_MS * 2);
        expect(commit).toHaveBeenCalledTimes(1);
    });

    it("flush with nothing pending does nothing", () => {
        const commit = vi.fn();
        createCommitScheduler(commit).flush();
        expect(commit).not.toHaveBeenCalled();
    });

    it("cancel drops the pending commit", () => {
        const commit = vi.fn();
        const s = createCommitScheduler(commit);
        s.schedule("channel:a");
        s.cancel();
        vi.advanceTimersByTime(CURSOR_COMMIT_MS * 2);
        expect(commit).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run frontend/app/view/jarvis/subjectcursor.test.ts`
Expected: FAIL — cannot resolve `./subjectcursor`.

- [ ] **Step 3: Write the scheduler**

Create `frontend/app/view/jarvis/subjectcursor.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Subjects column commits its cursor on idle rather than on every keypress. Moving the cursor is just a
// highlight; committing it runs selectSubject, which fires a selectChannel RPC, resolves a record scope and
// prunes an unasked thread on the way past. Holding j through thirty subjects cost thirty round trips.
//
// Deliberately NOT a change to listnav.ts's "cursor == selection" contract: five surfaces share it, and the
// same keys meaning different things per surface is a worse cost than the one this removes.

export const CURSOR_COMMIT_MS = 150;

export interface CommitScheduler {
    schedule: (id: string) => void;
    flush: () => void;
    cancel: () => void;
}

export function createCommitScheduler(commit: (id: string) => void, delayMs = CURSOR_COMMIT_MS): CommitScheduler {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: string | null = null;

    const clearTimer = () => {
        if (timer != null) {
            clearTimeout(timer);
            timer = null;
        }
    };
    const take = (): string | null => {
        const next = pending;
        pending = null;
        return next;
    };

    return {
        schedule: (id) => {
            pending = id;
            clearTimer();
            timer = setTimeout(() => {
                timer = null;
                const next = take();
                if (next != null) {
                    commit(next);
                }
            }, delayMs);
        },
        // an explicit selection — Enter, a click — must not wait out the idle window
        flush: () => {
            clearTimer();
            const next = take();
            if (next != null) {
                commit(next);
            }
        },
        cancel: () => {
            clearTimer();
            pending = null;
        },
    };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run frontend/app/view/jarvis/subjectcursor.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire the column to it**

In `frontend/app/view/jarvis/subjectscolumn.tsx`, add to the imports:

```ts
import { createCommitScheduler, type CommitScheduler } from "./subjectcursor";
```

Add `useRef` to the existing `react` import. Then, immediately above the `navIds` memo (currently line 161), insert:

```tsx
    // the cursor moves on every keypress; committing it waits for the user to stop. See subjectcursor.ts.
    const [cursorKey, setCursorKey] = useState<string | undefined>(undefined);
    const commitRef = useRef<CommitScheduler | null>(null);
    if (commitRef.current == null) {
        commitRef.current = createCommitScheduler((key) => {
            const i = key.indexOf(":");
            selectSubject({ kind: key.slice(0, i) as SubjectKind, id: key.slice(i + 1) });
        });
    }
    useEffect(() => () => commitRef.current?.cancel(), []);

    const activeKey = active != null ? `${active.kind}:${active.id}` : undefined;
    // a selection made anywhere else (a click, the palette, a Radar landing, a boot restore) moves the
    // cursor to match. During a j/k burst activeKey does not change, so this cannot fight the cursor.
    useEffect(() => setCursorKey(activeKey), [activeKey]);
```

Replace the `listNav` memo (lines 162-173) with:

```tsx
    const listNav = useMemo<ListNavController>(
        () => ({
            surface: "jarvis",
            navigableIds: navIds,
            cursorId: cursorKey ?? activeKey,
            setCursor: (key) => {
                setCursorKey(key);
                commitRef.current?.schedule(key);
            },
            activate: () => commitRef.current?.flush(),
        }),
        [navIds, cursorKey, activeKey]
    );
```

Replace `isActive` (line 176) so the highlight follows the cursor rather than lagging it by the idle window:

```tsx
    const isActive = (s: Subject) => (cursorKey ?? activeKey) === `${s.kind}:${s.id}`;
```

- [ ] **Step 6: Make a click beat a pending cursor commit**

A click calls `selectSubject` directly, so a commit still queued from `j`/`k` would land afterwards and move the user off what they clicked. In the same file, find the subject row's `onClick={() => selectSubject({ kind: s.kind, id: s.id })}` (there are two — the collapsed-strip button near line 93 and the full row) and change **both** to:

```tsx
onClick={() => {
    commitRef.current?.cancel();
    selectSubject({ kind: s.kind, id: s.id });
}}
```

Note the collapsed-strip button lives in the `CollapsedSubjects` component, which has no access to `commitRef`. Leave that one as-is — it renders only when the column is a 56px strip, where `j`/`k` and clicking do not compete. Change only the full row's handler.

- [ ] **Step 7: Verify**

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: all pass.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 2: JC8 — cancel an in-flight query

The wire-cancel path already exists: `sendRpcCommand` wraps `gen.return()` to send `{cancel:true}`, and the server's `emit` unwinds on `ctx.Done()`. What is missing is a handle on the generator and a terminal that says the user stopped it.

**Files:**
- Modify: `frontend/app/view/jarvis/jarviscontract.ts:22` (Terminal), `:70-76` (JarvisAnswerTurn)
- Modify: `frontend/app/view/jarvis/jarvisturnderive.ts:16-27` (badge)
- Modify: `frontend/app/view/jarvis/jarvisstore.ts:202-251` (submit), plus a new `cancelJarvisQuery`
- Modify: `frontend/app/view/jarvis/jarvisturn.tsx:51-85` (Cancel control)
- Modify: `frontend/app/view/jarvis/conversationview.tsx:34`, `recordthread.tsx:99` (pass the cancel handler)
- Test: `frontend/app/view/jarvis/jarvisturnderive.test.ts`

**Interfaces:**
- Produces: `cancelJarvisQuery(convId: string, answerIdx: number): void` from `jarvisstore.ts`; `Terminal` gains `"cancelled"`; `JarvisAnswerTurn` gains `streaming?: boolean`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing badge and ordering tests**

Append to `frontend/app/view/jarvis/jarvisturnderive.test.ts`:

```ts
it("draws a cancelled turn muted, not as a failure", () => {
    // a cancel is the user's own decision - neither a statement about the corpus (weak/notfound) nor a
    // request failure (error), so amber or red would misdescribe it.
    expect(terminalBadge("cancelled")).toEqual({ label: "Cancelled", tone: "muted" });
});

describe("terminalAfterStreamFailure", () => {
    it("reports an error when the stream died on its own", () => {
        expect(terminalAfterStreamFailure(false)).toBe("error");
    });

    it("leaves a cancelled turn alone", () => {
        // gen.return() can surface in the stream's catch. Without this the catch would overwrite
        // "cancelled" with "error" and tell the user something broke when they are the one who stopped it.
        expect(terminalAfterStreamFailure(true)).toBeNull();
    });
});
```

Add `terminalAfterStreamFailure` to the file's existing import from `./jarvisturnderive`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run frontend/app/view/jarvis/jarvisturnderive.test.ts`
Expected: FAIL — `terminalBadge("cancelled")` returns `null` (and tsc would reject the argument).

- [ ] **Step 3: Extend the contract**

In `frontend/app/view/jarvis/jarviscontract.ts`, replace line 20-22:

```ts
// "weak" and "notfound" are statements about the corpus; "error" is a statement about the request — it
// never reached an answer. Collapsing the two made a dead backend read as "I looked and found little".
// "cancelled" is a statement about the user: they stopped it, so it is neither.
export type Terminal = "answered" | "weak" | "notfound" | "error" | "cancelled";
```

And in `JarvisAnswerTurn` (line 70-76), add the streaming flag:

```ts
export interface JarvisAnswerTurn {
    role: "jarvis";
    workingSteps: WorkingStep[];
    segments: AnswerSegment[];
    grounding: GroundingCard[];
    terminal: Terminal;
    // true only while the converse stream is open. `terminal` cannot express this: it starts at "answered"
    // and is only meaningful once the stream ends, so the Cancel control needs its own signal.
    streaming?: boolean;
}
```

- [ ] **Step 4: Add the badge case and the ordering rule**

In `frontend/app/view/jarvis/jarvisturnderive.ts`, inside `terminalBadge`'s switch, after the `"error"` case:

```ts
        case "cancelled":
            return { label: "Cancelled", tone: "muted" };
```

And below `terminalBadge`, add the rule the stream's catch consults, so the invariant has a name and a test
rather than living as an inline condition:

```ts
// What a failed converse stream should become. Null means "leave the turn alone": a user cancel has
// already set its own terminal, and gen.return() can surface here as a throw.
export function terminalAfterStreamFailure(cancelled: boolean): Terminal | null {
    return cancelled ? null : "error";
}
```

- [ ] **Step 5: Run the badge test and confirm it passes**

Run: `npx vitest run frontend/app/view/jarvis/jarvisturnderive.test.ts`
Expected: PASS.

- [ ] **Step 6: Register the live stream and add cancel**

In `frontend/app/view/jarvis/jarvisstore.ts`, above `submitJarvisQuery` (line 202), add:

```ts
// Live converse streams, keyed conversation:answerIdx. The generator is the cancel handle: calling
// gen.return() sends the wire cancel (wshrpcutil-base.ts), which unwinds the server's streaming goroutine
// through ctx.Done() - so there is no separate abort protocol to build.
const liveStreams = new Map<string, { gen: AsyncGenerator<any, void, boolean>; cancelled: boolean }>();

const streamKey = (convId: string, answerIdx: number) => `${convId}:${answerIdx}`;

export function cancelJarvisQuery(convId: string, answerIdx: number): void {
    const key = streamKey(convId, answerIdx);
    const live = liveStreams.get(key);
    if (live == null || live.cancelled) {
        return;
    }
    // mark first: gen.return() can surface in the stream's catch, which would otherwise overwrite this
    // with "error" and tell the user something broke when they are the one who stopped it.
    live.cancelled = true;
    patchAnswer(convId, answerIdx, { terminal: "cancelled", streaming: false });
    void live.gen.return(undefined);
}
```

- [ ] **Step 7: Hold the handle in the submit path**

In `submitJarvisQuery`, mark the new turn as streaming — change the `answerTurn` literal to:

```ts
    const answerTurn: JarvisAnswerTurn = {
        role: "jarvis",
        workingSteps: [],
        segments: [],
        grounding: [],
        terminal: "answered",
        streaming: true,
    };
```

Then, inside the `fireAndForget` callback, register the generator and clean up. Replace the `try { const gen = RpcApi.JarvisConverseCommand(...)` opening so the generator is captured, and restructure the tail:

```ts
        const key = streamKey(convId, answerIdx);
        try {
            const gen = RpcApi.JarvisConverseCommand(
                TabRpcClient,
                {
                    conversationid: convId,
                    prompt: trimmed,
                    scopemode: conv.scope.mode,
                    projectpath: "",
                    attachedorefs: conv.scope.attached.map((a) => a.oref),
                    requestid: `${convId}-${answerIdx}`,
                },
                { timeout: JARVIS_RPC_TIMEOUT_MS }
            );
            liveStreams.set(key, { gen, cancelled: false });
            for await (const chunk of gen) {
                // ... existing chunk handling, unchanged ...
            }
        } catch {
            // preserve whatever streamed, but say what actually happened: the request died. Marking it
            // "weak" drew the amber grounding badge, so a dead backend and a thin corpus were the same turn.
            const terminal = terminalAfterStreamFailure(liveStreams.get(key)?.cancelled === true);
            if (terminal != null) {
                patchAnswer(convId, answerIdx, { terminal });
            }
        } finally {
            liveStreams.delete(key);
            patchAnswer(convId, answerIdx, { streaming: false });
        }
```

Note the `finally` clears `streaming` for every exit — natural completion, error and cancel alike — so the Cancel control disappears exactly when the stream closes.

- [ ] **Step 8: Render the Cancel control**

In `frontend/app/view/jarvis/jarvisturn.tsx`, extend `JarvisAnswer`'s props:

```tsx
export function JarvisAnswer({
    turn,
    model,
    onRetry,
    onCancel,
}: {
    turn: JarvisAnswerTurn;
    model: AgentsViewModel;
    onRetry?: () => void;
    onCancel?: () => void;
}) {
```

A streaming turn has no badge, so the Cancel control cannot live inside the `badge != null` block. Insert it immediately after `<JarvisWorkingSteps turn={turn} />`:

```tsx
            {turn.streaming && onCancel != null ? (
                <div className="mb-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="cursor-pointer rounded-[7px] border border-edge-mid px-2.5 py-1 font-mono text-[11px] text-muted hover:border-edge-strong hover:text-secondary"
                    >
                        Cancel
                    </button>
                </div>
            ) : null}
```

And widen the Retry condition so a cancelled turn offers it too:

```tsx
                    {(turn.terminal === "error" || turn.terminal === "cancelled") && onRetry != null ? (
```

- [ ] **Step 9: Pass the handler from both turn lists**

In `frontend/app/view/jarvis/conversationview.tsx`, beside the existing `onRetry` at line 34:

```tsx
                            onCancel={() => cancelJarvisQuery(conversation.id, i)}
```

Do the same in `frontend/app/view/jarvis/recordthread.tsx` beside its `onRetry` at line 99. Add `cancelJarvisQuery` to each file's existing import from `./jarvisstore`.

- [ ] **Step 10: Verify**

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: all pass.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 3: JC16 layer 1 — the nav rail collapses itself

78px → 56px below a narrow window. It lives in `navrail.tsx` because the nav rail is global chrome shared by every surface; driving it from inside Jarvis was the original and correct objection. No coordination with Jarvis is needed — the surface's `ResizeObserver` simply measures a wider surface.

**Files:**
- Create: `frontend/app/view/agents/navrailwidth.ts`, `frontend/app/view/agents/navrailwidth.test.ts`
- Modify: `frontend/app/view/agents/navrail.tsx:74-88`

**Interfaces:**
- Produces: `navRailCollapsed(windowWidth: number): boolean` and `NAV_NARROW_WINDOW_PX: number`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/navrailwidth.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { NAV_NARROW_WINDOW_PX, navRailCollapsed } from "./navrailwidth";

describe("navRailCollapsed", () => {
    it("stays wide on a roomy window", () => {
        expect(navRailCollapsed(1920)).toBe(false);
        expect(navRailCollapsed(NAV_NARROW_WINDOW_PX)).toBe(false);
    });

    it("collapses below the threshold", () => {
        expect(navRailCollapsed(NAV_NARROW_WINDOW_PX - 1)).toBe(true);
        expect(navRailCollapsed(720)).toBe(true);
    });

    it("treats an unmeasured width as roomy rather than slamming shut on the first frame", () => {
        expect(navRailCollapsed(0)).toBe(false);
    });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run frontend/app/view/agents/navrailwidth.test.ts`
Expected: FAIL — cannot resolve `./navrailwidth`.

- [ ] **Step 3: Write the rule**

Create `frontend/app/view/agents/navrailwidth.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Step 4 of the design's narrow-window collapse order. It lives with the nav rail rather than in
// jarvislayout.ts because the nav rail is global chrome shared by every surface — collapsing it from inside
// one surface would be the wrong layer. Jarvis needs no wiring for it: its own ResizeObserver just measures
// a wider surface once this fires.

export const NAV_NARROW_WINDOW_PX = 900;

export function navRailCollapsed(windowWidth: number): boolean {
    // a width of 0 is the unmeasured first frame, not the narrowest possible window
    return windowWidth > 0 && windowWidth < NAV_NARROW_WINDOW_PX;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run frontend/app/view/agents/navrailwidth.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Apply it in the nav rail**

In `frontend/app/view/agents/navrail.tsx`, add imports (`useEffect`, `useState` from react if not already present, plus `cn` from `@/util/util` if not already imported):

```ts
import { navRailCollapsed } from "./navrailwidth";
```

Inside the component, above the `return`:

```tsx
    const [narrow, setNarrow] = useState(() => navRailCollapsed(window.innerWidth));
    useEffect(() => {
        const onResize = () => setNarrow(navRailCollapsed(window.innerWidth));
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);
```

Replace the `<nav>` opening tag (line 81):

```tsx
        <nav
            className={cn(
                "flex shrink-0 flex-col gap-[3px] border-r border-border bg-surface py-2.5",
                narrow ? "w-[56px]" : "w-[78px]"
            )}
        >
```

Then hide the label when narrow. In `renderItem`, replace the label span (line 76):

```tsx
                {narrow ? null : <span className="relative z-[1] text-[10px] font-semibold">{label}</span>}
```

Because the label carries the item's name, add the accessible name to the button so a 56px rail is still operable. On the `<button>` inside `renderItem`, add:

```tsx
                aria-label={label}
                title={label}
```

- [ ] **Step 6: Verify**

Run: `npx vitest run frontend/app/view/agents/`
Expected: all pass.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 4: JC16 layer 2 — the context rail becomes an overlay

Once collapsing both regions still leaves the Stage under its floor, the rail stops taking inline width and floats over the Stage's right edge. This buys 44px of surface floor (740 → 696).

**Files:**
- Modify: `frontend/app/view/jarvis/jarvislayout.ts:27-64`
- Modify: `frontend/app/view/jarvis/jarvislayout.test.ts` (whole file — the helper goes away)
- Modify: `frontend/app/view/jarvis/jarvissurface.tsx:58-70`
- Modify: `frontend/app/view/jarvis/stagerail.tsx:216-228`

**Interfaces:**
- Produces: `LayoutCollapse` gains `railOverlay: boolean`; `StageRail` gains an `overlay?: boolean` prop.
- Consumes: nothing from other tasks. Task 3 is independent — the two layers do not talk.

- [ ] **Step 1: Rewrite the layout tests**

Replace the whole of `frontend/app/view/jarvis/jarvislayout.test.ts`. The `surfaceFor(window) = window - 78` helper goes away: once the nav rail is 78 *or* 56 (Task 3) that is no longer one number, and `collapseFor` is surface-relative anyway. Window-level behaviour belongs to the CDP scenario, which measures the real thing.

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    collapseFor,
    RAIL_WIDE_PX,
    STAGE_MIN_PX,
    stageWidth,
    SUBJECTS_WIDE_PX,
    type LayoutCollapse,
} from "./jarvislayout";

// asserted in SURFACE width throughout: the nav rail is variable (navrailwidth.ts), so a window->surface
// helper would be a second, silently drifting source of truth. The CDP scenario owns window widths.
const NOTHING: LayoutCollapse = { railCollapsed: false, subjectsCollapsed: false, railOverlay: false };

describe("collapseFor", () => {
    it("collapses nothing while the Stage clears its floor", () => {
        expect(collapseFor(1400)).toEqual(NOTHING);
        expect(stageWidth(1400, collapseFor(1400))).toBeGreaterThanOrEqual(STAGE_MIN_PX);
    });

    it("yields the context rail first — the design's step 1", () => {
        expect(collapseFor(1000)).toEqual({ railCollapsed: true, subjectsCollapsed: false, railOverlay: false });
    });

    it("yields the Subjects column only after the rail — step 2", () => {
        expect(collapseFor(800)).toEqual({ railCollapsed: true, subjectsCollapsed: true, railOverlay: false });
    });

    it("floats the rail once collapsing both is still not enough", () => {
        expect(collapseFor(700)).toEqual({ railCollapsed: true, subjectsCollapsed: true, railOverlay: true });
    });

    it("never collapses Subjects while the rail is still wide", () => {
        for (let w = 400; w <= 2400; w += 4) {
            const c = collapseFor(w);
            if (c.subjectsCollapsed) {
                expect(c.railCollapsed).toBe(true);
            }
        }
    });

    it("never overlays the rail before collapsing Subjects", () => {
        for (let w = 400; w <= 2400; w += 4) {
            const c = collapseFor(w);
            if (c.railOverlay) {
                expect(c.subjectsCollapsed).toBe(true);
            }
        }
    });

    // rule 5, as a width assertion rather than "the thread is still mounted" — the mounted check passed on
    // the broken layout, which is how this shipped. 696 is where the order runs out of regions to yield.
    it("holds the Stage at or above its floor wherever the order can", () => {
        for (let w = 696; w <= 2400; w += 2) {
            expect(stageWidth(w, collapseFor(w))).toBeGreaterThanOrEqual(STAGE_MIN_PX);
        }
    });

    it("still gives the Stage every pixel the order can free below that", () => {
        const c = collapseFor(600);
        expect(c).toEqual({ railCollapsed: true, subjectsCollapsed: true, railOverlay: true });
        expect(stageWidth(600, c)).toBeGreaterThan(stageWidth(600, NOTHING));
    });

    it("collapses nothing on an unmeasured (zero) width rather than slamming shut on the first frame", () => {
        expect(collapseFor(0)).toEqual(NOTHING);
    });

    it("is monotonic — a wider surface never collapses more", () => {
        const weight = (c: LayoutCollapse) =>
            Number(c.railCollapsed) + Number(c.subjectsCollapsed) + Number(c.railOverlay);
        let prev = collapseFor(500);
        for (let w = 504; w <= 2400; w += 4) {
            const c = collapseFor(w);
            expect(weight(c)).toBeLessThanOrEqual(weight(prev));
            prev = c;
        }
    });

    it("the mirrored widths still match the components they came from", () => {
        expect(SUBJECTS_WIDE_PX).toBe(272);
        expect(RAIL_WIDE_PX).toBe(300);
    });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run frontend/app/view/jarvis/jarvislayout.test.ts`
Expected: FAIL — `railOverlay` is not a property of `LayoutCollapse`.

- [ ] **Step 3: Add the overlay step**

In `frontend/app/view/jarvis/jarvislayout.ts`, replace `LayoutCollapse`, `chromeWidth` and `collapseFor` (lines 27-64):

```ts
export interface LayoutCollapse {
    railCollapsed: boolean; // 1. context rail -> its 44px strip
    subjectsCollapsed: boolean; // 2. Subjects column -> status dots
    railOverlay: boolean; // 3. context rail leaves the flow entirely and floats over the Stage
}

export function chromeWidth(collapse: LayoutCollapse): number {
    return (
        (collapse.subjectsCollapsed ? SUBJECTS_NARROW_PX : SUBJECTS_WIDE_PX) +
        // an overlaid rail costs no inline width at all - that is the point of the step
        (collapse.railOverlay ? 0 : collapse.railCollapsed ? RAIL_NARROW_PX : RAIL_WIDE_PX)
    );
}

export function stageWidth(surfaceWidth: number, collapse: LayoutCollapse): number {
    return surfaceWidth - chromeWidth(collapse);
}

// surfaceWidth is the Jarvis surface's own width — the window minus the nav rail. The nav rail collapses
// itself (view/agents/navrailwidth.ts, the design's step 4); this module never sees it, it just measures a
// wider surface when that happens.
//
// A width of 0 (the first frame, before the observer has measured) must not read as "narrowest" and slam
// every region shut, so it collapses nothing.
export function collapseFor(surfaceWidth: number): LayoutCollapse {
    const collapse: LayoutCollapse = { railCollapsed: false, subjectsCollapsed: false, railOverlay: false };
    if (surfaceWidth <= 0) {
        return collapse;
    }
    // apply the order in sequence, stopping as soon as the Stage clears its floor.
    if (stageWidth(surfaceWidth, collapse) >= STAGE_MIN_PX) {
        return collapse;
    }
    collapse.railCollapsed = true;
    if (stageWidth(surfaceWidth, collapse) >= STAGE_MIN_PX) {
        return collapse;
    }
    collapse.subjectsCollapsed = true;
    if (stageWidth(surfaceWidth, collapse) >= STAGE_MIN_PX) {
        return collapse;
    }
    // last resort: the rail leaves the flow. Below this the order has nothing left and the Stage goes under
    // its floor — rule 5 forbids taking it from the thread or the composer, so that residual stands.
    collapse.railOverlay = true;
    return collapse;
}
```

- [ ] **Step 4: Run and confirm they pass**

Run: `npx vitest run frontend/app/view/jarvis/jarvislayout.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Render the overlay**

In `frontend/app/view/jarvis/jarvissurface.tsx`, pass the flag through (line 67):

```tsx
                <StageRail model={model} comp={comp} overlay={collapse.railOverlay} />
```

In `frontend/app/view/jarvis/stagerail.tsx`, take the prop and wrap. Change the component signature to accept `overlay`:

```tsx
export function StageRail({
    model,
    comp,
    overlay,
}: {
    model: AgentsViewModel;
    comp: StageComposition | null;
    overlay?: boolean;
}) {
```

(Keep the existing prop types for `model` and `comp` exactly as they are today; only add `overlay`.)

Then replace the returned fragment (lines 216-228):

```tsx
    return (
        <>
            {/* below the width where collapsing to strips is still enough, the rail leaves the flow rather
                than take the Stage under its floor. Absolute, not fixed: it must clip to the surface. */}
            <div className={overlay ? "absolute bottom-0 right-0 top-0 z-10 flex" : "contents"}>
                <CollapsibleRail
                    openAtom={stageRailOpenAtom}
                    ariaLabel="Stage context"
                    sections={sections}
                    forceCollapsed={profileOpen}
                />
            </div>
            {/* the ⚙ drawer shares the right-edge slot: it has no strip of its own and the rail above
                force-collapses while it is open, so the two never stack. */}
            <ProfilePanel channelId={comp?.showProfile && subject?.kind === "channel" ? subject.id : ""} />
        </>
    );
```

`contents` keeps the non-overlay case laying out exactly as it does today — the wrapper box disappears from the flow, so the rail remains a direct flex child of the surface row.

- [ ] **Step 6: Confirm the surface row can host an absolute child**

`jarvissurface.tsx:62` is `<div ref={rowRef} data-jarvis-region="surface" className="flex min-h-0 flex-1">`. Add `relative` so the overlay positions against the surface row rather than an ancestor:

```tsx
            <div ref={rowRef} data-jarvis-region="surface" className="relative flex min-h-0 flex-1">
```

- [ ] **Step 7: Verify**

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: all pass.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 5: Backend — conversation lifecycle commands and summary fields

One struct edit and one handler edit serve both 12b (archive needs the flag readable) and 12c (dedup needs the attachments). Two new commands wrap store functions that already exist.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go:12-30` (interface), `:109-114` (summary), plus two new data types
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go:287-301` (list handler), plus two new handlers
- Test: `pkg/wshrpc/wshserver/wshserver_jarvis_test.go`

**Interfaces:**
- Produces (Go): `DeleteJarvisConversationCommand(ctx, CommandDeleteJarvisConversationData) error`, `ArchiveJarvisConversationCommand(ctx, CommandArchiveJarvisConversationData) error`. `JarvisConversationSummary` gains `AttachedORefs []string` (json `attachedorefs`) and `Archived bool` (json `archived`).
- Produces (TS, after `task generate`): `RpcApi.DeleteJarvisConversationCommand`, `RpcApi.ArchiveJarvisConversationCommand`, and the two new summary fields.
- Consumes: `wstore.DeleteJarvisConversation` (exists), `wstore.MetaKey_Archived` (exists, `pkg/wstore/wstore_channel.go:331`).

- [ ] **Step 1: Write the failing Go tests**

Append to `pkg/wshrpc/wshserver/wshserver_jarvis_test.go`. The package's `TestMain` (`maintest_test.go`) already points the data dir at a temp dir and runs the migrations, so tests use a plain `context.Background()` and clean up after themselves — match `TestJarvisConverseCreatesAndPersistsTurns` at the top of the file. Conversation ids must parse as UUIDs, hence the fixed literals rather than free-form strings.

```go
// newTestConvo creates a conversation with a deterministic UUID and removes it when the test ends.
func newTestConvo(t *testing.T, ctx context.Context, oid, title string, orefs []string) *waveobj.JarvisConvo {
	t.Helper()
	convo, err := wstore.CreateJarvisConversation(ctx, oid, title, "all", "", orefs)
	if err != nil {
		t.Fatalf("creating conversation: %v", err)
	}
	t.Cleanup(func() {
		// already-deleted is fine: the delete test removes it itself
		_ = wstore.DBDelete(ctx, waveobj.OType_JarvisConversation, oid)
	})
	return convo
}

func TestDeleteJarvisConversationCommandRemovesIt(t *testing.T) {
	ctx := context.Background()
	convo := newTestConvo(t, ctx, "dddddddd-0000-0000-0000-0000000000d1", "throwaway", nil)
	ws := &WshServer{}
	if err := ws.DeleteJarvisConversationCommand(ctx, wshrpc.CommandDeleteJarvisConversationData{ConversationId: convo.OID}); err != nil {
		t.Fatalf("deleting: %v", err)
	}
	if _, err := wstore.GetJarvisConversation(ctx, convo.OID); err == nil {
		t.Fatal("expected the conversation to be gone")
	}
}

func TestDeleteJarvisConversationCommandRequiresAnId(t *testing.T) {
	err := (&WshServer{}).DeleteJarvisConversationCommand(context.Background(), wshrpc.CommandDeleteJarvisConversationData{})
	if err == nil {
		t.Fatal("expected an error for an empty conversationid")
	}
}

func TestArchiveJarvisConversationCommandRoundTrips(t *testing.T) {
	ctx := context.Background()
	convo := newTestConvo(t, ctx, "dddddddd-0000-0000-0000-0000000000d2", "keep me", nil)
	ws := &WshServer{}
	data := wshrpc.CommandArchiveJarvisConversationData{ConversationId: convo.OID, Archived: true}
	if err := ws.ArchiveJarvisConversationCommand(ctx, data); err != nil {
		t.Fatalf("archiving: %v", err)
	}
	// the summary is the only shape the frontend sees, so a flag it does not carry is write-only
	summary := findSummary(t, ws, ctx, convo.OID)
	if !summary.Archived {
		t.Fatal("expected the summary to report archived")
	}
	data.Archived = false
	if err := ws.ArchiveJarvisConversationCommand(ctx, data); err != nil {
		t.Fatalf("unarchiving: %v", err)
	}
	if findSummary(t, ws, ctx, convo.OID).Archived {
		t.Fatal("expected unarchive to clear the flag")
	}
}

func TestListJarvisConversationsCarriesAttachedORefs(t *testing.T) {
	ctx := context.Background()
	orefs := []string{"run:dddddddd-0000-0000-0000-0000000000f1"}
	convo := newTestConvo(t, ctx, "dddddddd-0000-0000-0000-0000000000d3", "about a run", orefs)
	got := findSummary(t, &WshServer{}, ctx, convo.OID).AttachedORefs
	if len(got) != 1 || got[0] != orefs[0] {
		t.Fatalf("expected the summary to carry %v, got %v", orefs, got)
	}
}

func findSummary(t *testing.T, ws *WshServer, ctx context.Context, oid string) wshrpc.JarvisConversationSummary {
	t.Helper()
	rtn, err := ws.ListJarvisConversationsCommand(ctx)
	if err != nil {
		t.Fatalf("listing: %v", err)
	}
	for _, s := range rtn.Conversations {
		if s.Id == oid {
			return s
		}
	}
	t.Fatalf("conversation %s missing from the list", oid)
	return wshrpc.JarvisConversationSummary{}
}
```

The file already imports `context`, `testing`, `waveobj`, `wshrpc` and `wstore` — no import changes needed.

- [ ] **Step 2: Run and confirm they fail**

Run: `go test ./pkg/wshrpc/wshserver/ -run "JarvisConversation" -v`
Expected: FAIL to compile — the commands and fields do not exist.

- [ ] **Step 3: Add the types**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, add two lines to the `JarvisCommands` interface after `ListJarvisConversationsCommand` (line 16):

```go
	DeleteJarvisConversationCommand(ctx context.Context, data CommandDeleteJarvisConversationData) error   // delete one recall conversation
	ArchiveJarvisConversationCommand(ctx context.Context, data CommandArchiveJarvisConversationData) error // hide a conversation from the active Threads list; reversible
```

Add the data types near the other `Command…Data` structs:

```go
type CommandDeleteJarvisConversationData struct {
	ConversationId string `json:"conversationid"`
}

type CommandArchiveJarvisConversationData struct {
	ConversationId string `json:"conversationid"`
	Archived       bool   `json:"archived"`
}
```

Extend the summary (line 109):

```go
type JarvisConversationSummary struct {
	Id        string `json:"id"`
	Title     string `json:"title"`
	ScopeMode string `json:"scopemode"`
	UpdatedTs int64  `json:"updatedts"`
	// the frontend only ever sees summaries, so a field the summary omits is unreachable: without
	// AttachedORefs the per-source dedup cannot survive a restart, and without Archived the flag is
	// write-only.
	AttachedORefs []string `json:"attachedorefs,omitempty"`
	Archived      bool     `json:"archived,omitempty"`
}
```

- [ ] **Step 4: Add the handlers and populate the summary**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`, extend the list handler's loop body (line 293) to carry both fields:

```go
	for _, conversation := range conversations {
		archived, _ := conversation.Meta[wstore.MetaKey_Archived].(bool)
		out = append(out, wshrpc.JarvisConversationSummary{
			Id:            conversation.OID,
			Title:         conversation.Title,
			ScopeMode:     conversation.ScopeMode,
			UpdatedTs:     conversation.UpdatedTs,
			AttachedORefs: conversation.AttachedORefs,
			Archived:      archived,
		})
	}
```

Then add the two handlers below it, mirroring `wshserver_channels.go`'s channel pair:

```go
func (ws *WshServer) DeleteJarvisConversationCommand(ctx context.Context, data wshrpc.CommandDeleteJarvisConversationData) error {
	if data.ConversationId == "" {
		return fmt.Errorf("conversationid is required")
	}
	if err := wstore.DeleteJarvisConversation(ctx, data.ConversationId); err != nil {
		return fmt.Errorf("deleting conversation: %w", err)
	}
	return nil
}

func (ws *WshServer) ArchiveJarvisConversationCommand(ctx context.Context, data wshrpc.CommandArchiveJarvisConversationData) error {
	if data.ConversationId == "" {
		return fmt.Errorf("conversationid is required")
	}
	err := wstore.DBUpdateFn(ctx, data.ConversationId, func(c *waveobj.JarvisConvo) {
		if c.Meta == nil {
			c.Meta = make(waveobj.MetaMapType)
		}
		c.Meta[wstore.MetaKey_Archived] = data.Archived
	})
	if err != nil {
		return fmt.Errorf("updating conversation archived flag: %w", err)
	}
	return nil
}
```

Ensure `waveobj` and `wstore` are imported in the file (both already are for the existing handlers; add `fmt` if missing).

- [ ] **Step 5: Run the Go tests and confirm they pass**

Run: `go test ./pkg/wshrpc/wshserver/ -run "JarvisConversation" -v`
Expected: PASS, 4 tests.

- [ ] **Step 6: Regenerate the TypeScript client**

Run: `task generate`
Expected: `frontend/app/store/wshclientapi.ts` gains `DeleteJarvisConversationCommand` and `ArchiveJarvisConversationCommand`; the generated TS `JarvisConversationSummary` gains `attachedorefs?` and `archived?`. Do not hand-edit either.

- [ ] **Step 7: Verify the whole backend surface still builds**

Run: `go test ./pkg/wshrpc/... ./pkg/wstore/`
Expected: ok.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 6: Gap 12b — a thread can be deleted or archived

Mirrors the channel path exactly rather than inventing a second shape: the same right-click menu, the same `ConfirmModal`, the same trailing `Archived · N` group.

**Files:**
- Modify: `frontend/app/view/jarvis/jarvisstore.ts` (two mutators, archived on the rail conversation)
- Modify: `frontend/app/view/jarvis/subjects.ts:130-147` (split archived threads out)
- Modify: `frontend/app/view/jarvis/subjects.test.ts` (cover the split)
- Modify: `frontend/app/view/jarvis/subjectscolumn.tsx` (thread row menu)

**Interfaces:**
- Consumes: `RpcApi.DeleteJarvisConversationCommand`, `RpcApi.ArchiveJarvisConversationCommand`, `summary.archived` — all from Task 5.
- Produces: `deleteJarvisConversation(id: string): Promise<void>`, `archiveJarvisConversation(id: string, archived: boolean): Promise<void>` from `jarvisstore.ts`; `JarvisConversation` gains `archived?: boolean`.

- [ ] **Step 1: Write the failing grouping test**

Append to `frontend/app/view/jarvis/subjects.test.ts`, reusing the file's existing `convo(id, title, taskIds)` and `ch(oid, name, project, archived)` helpers rather than hand-rolling fixtures. Match the `buildSubjectGroups` input shape the neighbouring tests in that file already use:

```ts
it("files an archived thread under Archived, not Threads", () => {
    const groups = buildSubjectGroups({
        channels: [],
        dossiers: [],
        conversations: [convo("t1", "live question", []), { ...convo("t2", "put away", []), archived: true }],
        projectNameFor: () => "proj",
        spaceScope: null,
        spaceDossierId: null,
        revealed: false,
    } as SubjectInput);
    expect(groups.find((g) => g.key === "threads")?.items.map((i) => i.id)).toEqual(["t1"]);
    expect(groups.find((g) => g.key === "archived")?.items.map((i) => i.id)).toEqual(["t2"]);
});

it("counts archived channels and archived threads in one group", () => {
    // two "Archived" headers for two kinds would read as two different states
    const groups = buildSubjectGroups({
        channels: [ch("c1", "old", "proj", true)],
        dossiers: [],
        conversations: [{ ...convo("t2", "put away", []), archived: true }],
        projectNameFor: () => "proj",
        spaceScope: null,
        spaceDossierId: null,
        revealed: false,
    } as SubjectInput);
    const archived = groups.find((g) => g.key === "archived");
    expect(archived?.label).toBe("Archived · 2");
    expect(archived?.items.map((i) => i.kind)).toEqual(["channel", "conversation"]);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run frontend/app/view/jarvis/subjects.test.ts`
Expected: FAIL — the archived thread appears under `threads`.

- [ ] **Step 3: Carry `archived` onto the rail conversation**

In `frontend/app/view/jarvis/jarviscontract.ts`, add to `JarvisConversation` (line 80):

```ts
    // set from the persisted summary; a locally-created thread is never archived
    archived?: boolean;
```

In `frontend/app/view/jarvis/jarvisstore.ts`, extend `summaryToRailConversation` (line 100):

```ts
export function summaryToRailConversation(summary: JarvisConversationSummary): JarvisConversation {
    return {
        id: summary.id,
        title: summary.title,
        turns: [],
        scope: { mode: summary.scopemode as JarvisScope["mode"], chips: [], attached: [] },
        archived: summary.archived === true,
    };
}
```

- [ ] **Step 4: Split archived threads in the grouping**

In `frontend/app/view/jarvis/subjects.ts`, replace the `conversations` group block (lines 133-139) and fold archived threads into the existing archived group. Above the group pushes, partition:

```ts
    // archived threads join the channels' trailing group rather than getting one of their own: two
    // "Archived" headers for two kinds would read as two different states.
    const liveConversations = conversations.filter((v) => v.archived !== true);
    const archivedConversations = conversations.filter((v) => v.archived === true);
```

Use `liveConversations` in the `threads` group:

```ts
    if (liveConversations.length > 0) {
        groups.push({
            key: "threads",
            label: "Threads",
            items: liveConversations.map((v) => ({ kind: "conversation", id: v.id, label: v.title })),
        });
    }
```

And extend the archived group to hold both kinds:

```ts
    const archivedItems: Subject[] = [
        ...archived.map((c) => ({
            kind: "channel" as const,
            id: c.oid,
            label: c.name ?? c.oid,
            projectName: input.projectNameFor(c),
        })),
        ...archivedConversations.map((v) => ({ kind: "conversation" as const, id: v.id, label: v.title })),
    ];
    if (archivedItems.length > 0) {
        groups.push({
            key: "archived",
            label: `Archived · ${archivedItems.length}`,
            items: archivedItems,
        });
    }
```

- [ ] **Step 5: Run the grouping test and confirm it passes**

Run: `npx vitest run frontend/app/view/jarvis/subjects.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the two mutators**

In `frontend/app/view/jarvis/jarvisstore.ts`, below `loadJarvisConversations` (line 114):

```ts
// Thread lifecycle. Mirrors channelsstore's delete/archive: mutate, then re-list, because the Threads group
// is built from the summary snapshot rather than from a live subscription.
export async function deleteJarvisConversation(id: string): Promise<void> {
    await RpcApi.DeleteJarvisConversationCommand(TabRpcClient, { conversationid: id });
    // drop the live copy too, else the deleted thread survives in conversationsByIdAtom for the session
    const byId = { ...globalStore.get(conversationsByIdAtom) };
    delete byId[id];
    globalStore.set(conversationsByIdAtom, byId);
    if (globalStore.get(activeConversationIdAtom) === id) {
        globalStore.set(activeConversationIdAtom, null);
    }
    loadJarvisConversations();
}

export async function archiveJarvisConversation(id: string, archived: boolean): Promise<void> {
    await RpcApi.ArchiveJarvisConversationCommand(TabRpcClient, { conversationid: id, archived });
    loadJarvisConversations();
}
```

- [ ] **Step 7: Give thread rows the menu**

In `frontend/app/view/jarvis/subjectscolumn.tsx`, import the two mutators from `./jarvisstore` and add a menu builder beside `channelMenu`:

```tsx
    // threads get the same right-click affordances channels got, for the same reason: a row you cannot
    // remove is a permanent one. No rename — a thread's title comes from its first turn.
    const threadMenu = (id: string, title: string, archived: boolean, ev: React.MouseEvent) => {
        ContextMenuModel.getInstance().showContextMenu(
            [
                {
                    label: archived ? "Unarchive thread" : "Archive thread",
                    icon: <Archive size={15} />,
                    click: () => fireAndForget(() => archiveJarvisConversation(id, !archived)),
                },
                { type: "separator" },
                {
                    label: "Delete thread",
                    icon: <Trash2 size={15} />,
                    danger: true,
                    click: () =>
                        modalsModel.pushModal("ConfirmModal", {
                            title: "Delete thread",
                            message: `Delete "${title}"? This can't be undone.`,
                            confirmLabel: "Delete thread",
                            destructive: true,
                            onConfirm: () => fireAndForget(() => deleteJarvisConversation(id)),
                        }),
                },
            ],
            ev
        );
    };
```

The subject row currently wires only the channel case, at `subjectscolumn.tsx:425`:

```tsx
                                        onContextMenu={channel != null ? (ev) => channelMenu(channel, ev) : undefined}
```

Replace that single line so the handler dispatches by kind (`channel` is the already-resolved `Channel | undefined` in scope at that point):

```tsx
                                        onContextMenu={(ev) => {
                                            if (channel != null) {
                                                channelMenu(channel, ev);
                                                return;
                                            }
                                            if (s.kind === "conversation") {
                                                const conv = conversations.find((v) => v.id === s.id);
                                                threadMenu(s.id, s.label, conv?.archived === true, ev);
                                            }
                                        }}
```

- [ ] **Step 8: Verify**

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: all pass.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 7: Gap 12c — dedup survives a restart

`sourceConversationAtom` is session state, so asking about the same Run after a restart starts a second thread. With the summary now carrying its attachments, the map can be rebuilt on load.

**Files:**
- Modify: `frontend/app/view/jarvis/jarvisstore.ts:109-114` (`loadJarvisConversations`)
- Test: `frontend/app/view/jarvis/jarvisstore.test.ts` (exists — append there)

**Interfaces:**
- Consumes: `summary.attachedorefs` from Task 5; `sourceConversationAtom` from `jarvissubjectstore.ts`.
- Produces: `rehydrateSourceMap(summaries, existing): Record<string, string>` — pure, exported for the test.

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/jarvis/jarvisstore.test.ts`, importing `rehydrateSourceMap` from `./jarvisstore`:

```ts
describe("rehydrateSourceMap", () => {
    it("maps each attached oref to its persisted thread", () => {
        const map = rehydrateSourceMap(
            [
                { id: "t1", title: "a", scopemode: "attached", updatedts: 2, attachedorefs: ["run:r1"] },
                { id: "t2", title: "b", scopemode: "attached", updatedts: 1, attachedorefs: ["task:d1"] },
            ] as any,
            {}
        );
        expect(map).toEqual({ "run:r1": "t1", "task:d1": "t2" });
    });

    it("keeps a live in-session mapping over a persisted one", () => {
        // the session's own thread is the one holding unsent state; a restart-time rebuild must not steal
        // the oref out from under it.
        const map = rehydrateSourceMap(
            [{ id: "old", title: "a", scopemode: "attached", updatedts: 1, attachedorefs: ["run:r1"] }] as any,
            { "run:r1": "live" }
        );
        expect(map["run:r1"]).toBe("live");
    });

    it("ignores summaries with no attachments", () => {
        const map = rehydrateSourceMap([{ id: "t1", title: "a", scopemode: "all", updatedts: 1 }] as any, {});
        expect(map).toEqual({});
    });

    it("lets the newest thread win when two claim the same oref", () => {
        // GetJarvisConversations returns newest-first, so the first summary to claim an oref is the newest
        const map = rehydrateSourceMap(
            [
                { id: "new", title: "a", scopemode: "attached", updatedts: 2, attachedorefs: ["run:r1"] },
                { id: "old", title: "b", scopemode: "attached", updatedts: 1, attachedorefs: ["run:r1"] },
            ] as any,
            {}
        );
        expect(map["run:r1"]).toBe("new");
    });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run frontend/app/view/jarvis/jarvisstore.test.ts`
Expected: FAIL — `rehydrateSourceMap` is not exported.

- [ ] **Step 3: Implement and wire it**

In `frontend/app/view/jarvis/jarvisstore.ts`, add above `loadJarvisConversations`:

```ts
// Rebuild the oref -> conversation map from persisted summaries, so asking about the same Run after a
// restart continues its thread instead of minting an identical second one. Summaries arrive newest-first,
// so the first claim on an oref wins; an in-session mapping always beats a persisted one.
export function rehydrateSourceMap(
    summaries: JarvisConversationSummary[],
    existing: Record<string, string>
): Record<string, string> {
    const next: Record<string, string> = {};
    for (const summary of summaries) {
        for (const oref of summary.attachedorefs ?? []) {
            if (next[oref] == null) {
                next[oref] = summary.id;
            }
        }
    }
    return { ...next, ...existing };
}
```

Then extend the loader:

```ts
export function loadJarvisConversations(): void {
    fireAndForget(async () => {
        const result = await RpcApi.ListJarvisConversationsCommand(TabRpcClient);
        const summaries = result?.conversations ?? [];
        globalStore.set(persistedSummariesAtom, summaries);
        globalStore.set(sourceConversationAtom, rehydrateSourceMap(summaries, globalStore.get(sourceConversationAtom)));
    });
}
```

Import `sourceConversationAtom` from `./jarvissubjectstore`. **Check for an import cycle first:** `jarvissubjectstore.ts` already imports from `jarvisstore.ts`. If adding the reverse import creates a cycle vitest or Vite complains about, move `sourceConversationAtom` into `jarvisstore.ts` beside `persistedSummariesAtom` and re-export it from `jarvissubjectstore.ts` so existing importers are unaffected.

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run frontend/app/view/jarvis/jarvisstore.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify**

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: all pass.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 8: Last-subject persistence

Every launch lands on the empty Stage. Restoring needs a loaded-vs-empty distinction per subject kind: `channelsAtom` already has one, the other two do not.

**Files:**
- Create: `frontend/app/view/jarvis/subjectrestore.ts`, `frontend/app/view/jarvis/subjectrestore.test.ts`
- Modify: `frontend/app/view/jarvis/tasksstore.ts:13,22` (nullable)
- Modify: `frontend/app/view/jarvis/jarvisstore.ts:65,89` (nullable summaries)
- Modify: `frontend/app/view/jarvis/jarvissubjectstore.ts:31` (persisted atom)
- Modify: `frontend/app/view/jarvis/subjectscolumn.tsx` (read sites + the restore effect)
- Modify: `frontend/app/view/jarvis/subjects.ts` (input type)

**Interfaces:**
- Produces: `restoreDecision(stored: StoredSubject | null, lists: SubjectListState): RestoreAction` where `RestoreAction = {action:"wait"} | {action:"select"; subject: StoredSubject} | {action:"clear"}`; `persistedSubjectAtom` (an `atomWithStorage` of `ActiveSubject | null`).
- Consumes: nothing. **`StoredSubject` is declared locally and is structurally identical to `ActiveSubject` (`{kind, id}`) on purpose** — importing `ActiveSubject` would point `subjectrestore.ts` at `jarvissubjectstore.ts`, which already imports the store, and the pure module must not sit in that cycle. TypeScript accepts one for the other structurally; do not "fix" this by adding the import.

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/jarvis/subjectrestore.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { restoreDecision } from "./subjectrestore";

const LOADED = { channels: ["c1"], dossiers: ["d1"], conversations: ["t1"] };
const UNLOADED = { channels: null, dossiers: null, conversations: null };

describe("restoreDecision", () => {
    it("does nothing when nothing was stored", () => {
        expect(restoreDecision(null, LOADED)).toEqual({ action: "clear" });
    });

    it("waits while the matching kind's list has not loaded", () => {
        expect(restoreDecision({ kind: "channel", id: "c1" }, UNLOADED)).toEqual({ action: "wait" });
        expect(restoreDecision({ kind: "dossier", id: "d1" }, { ...LOADED, dossiers: null })).toEqual({
            action: "wait",
        });
    });

    it("does not wait on a list it does not need", () => {
        // a stored channel must not be held up by a thread list that has not landed
        expect(restoreDecision({ kind: "channel", id: "c1" }, { ...LOADED, conversations: null })).toEqual({
            action: "select",
            subject: { kind: "channel", id: "c1" },
        });
    });

    it("selects the stored subject once its list holds the id", () => {
        expect(restoreDecision({ kind: "conversation", id: "t1" }, LOADED)).toEqual({
            action: "select",
            subject: { kind: "conversation", id: "t1" },
        });
    });

    it("clears a stored subject its loaded list no longer holds", () => {
        // a persisted id can name a channel, record or thread that has since been deleted
        expect(restoreDecision({ kind: "dossier", id: "gone" }, LOADED)).toEqual({ action: "clear" });
    });

    it("clears rather than waits when the list loaded empty", () => {
        expect(restoreDecision({ kind: "channel", id: "c1" }, { ...LOADED, channels: [] })).toEqual({
            action: "clear",
        });
    });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run frontend/app/view/jarvis/subjectrestore.test.ts`
Expected: FAIL — cannot resolve `./subjectrestore`.

- [ ] **Step 3: Write the decision**

Create `frontend/app/view/jarvis/subjectrestore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Restoring the last subject on boot. The hard part is not persistence but validation: a stored id can name
// a channel, record or thread that no longer exists, and the lists load asynchronously. So each kind's list
// is null until it has loaded, and the decision waits only on the ONE list the stored subject needs.
//
// Degrading to the empty Stage is deliberate and silent — the surface's rule is absent rather than empty.

import type { SubjectKind } from "./subjects";

export interface StoredSubject {
    kind: SubjectKind;
    id: string;
}

// null means "not loaded yet"; [] means "loaded, and there are none"
export interface SubjectListState {
    channels: string[] | null;
    dossiers: string[] | null;
    conversations: string[] | null;
}

export type RestoreAction = { action: "wait" } | { action: "select"; subject: StoredSubject } | { action: "clear" };

function listFor(kind: SubjectKind, lists: SubjectListState): string[] | null {
    if (kind === "channel") {
        return lists.channels;
    }
    return kind === "dossier" ? lists.dossiers : lists.conversations;
}

export function restoreDecision(stored: StoredSubject | null, lists: SubjectListState): RestoreAction {
    if (stored == null) {
        return { action: "clear" };
    }
    const list = listFor(stored.kind, lists);
    if (list == null) {
        return { action: "wait" };
    }
    return list.includes(stored.id) ? { action: "select", subject: stored } : { action: "clear" };
}
```

- [ ] **Step 4: Run and confirm they pass**

Run: `npx vitest run frontend/app/view/jarvis/subjectrestore.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Make the two lists nullable**

In `frontend/app/view/jarvis/tasksstore.ts` line 13:

```ts
// null until the first load lands: "no records yet" and "the list has not arrived" are different states,
// and the boot-time subject restore has to tell them apart. Matches channelsAtom.
export const taskListAtom = atom<SpaceSummary[] | null>(null) as PrimitiveAtom<SpaceSummary[] | null>;
```

In `frontend/app/view/jarvis/jarvisstore.ts` line 65:

```ts
export const persistedSummariesAtom = atom<JarvisConversationSummary[] | null>(null);
```

Fix the derived reader at line 89 so a null list is not treated as empty:

```ts
    const persisted = (get(persistedSummariesAtom) ?? [])
        .filter((summary) => !liveIds.has(summary.id))
        .map(summaryToRailConversation);
```

- [ ] **Step 6: Fix every read site tsc reports**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

Expected: errors at each place that assumed a non-null array. Work through them; the known ones are:

- `subjectscolumn.tsx:115` — `const dossiers = useAtomValue(taskListAtom);` then `dossiers.length` at line 154. Use `(dossiers?.length ?? 0)`.
- `subjectscolumn.tsx:144-152` — `buildSubjectGroups({ dossiers, ... })`. Pass `dossiers ?? []`.
- `subjects.ts` — the `SubjectInput.dossiers` type stays `SpaceSummary[]`; the column adapts at the call site, so the pure module keeps one meaning of empty.

At each site ask which of the two states the code means. Do **not** blanket-add `?? []` in a place where the difference matters — that is the whole point of the change.

- [ ] **Step 7: Persist the active subject**

In `frontend/app/view/jarvis/jarvissubjectstore.ts`, add beside `activeSubjectAtom` (line 31):

```ts
// the last subject, persisted across launches. Only the id pair is stored — the subject itself is
// re-resolved on boot, because a stored id can name something that has since been deleted.
export const persistedSubjectAtom = atomWithStorage<ActiveSubject | null>("jarvis.subject.last", null);
```

Import `atomWithStorage` from `jotai/utils`. Then write it whenever the subject changes — at the end of `selectSubject`'s first line block, immediately after `globalStore.set(activeSubjectAtom, subject)` (line 72):

```ts
    globalStore.set(persistedSubjectAtom, subject);
```

- [ ] **Step 8: Restore on boot**

In `frontend/app/view/jarvis/subjectscolumn.tsx`, below the existing load effect (line 132-135), add:

```tsx
    // restore the last subject once — and only once its own kind's list has loaded. One attempt, like
    // pendingRunFocusAtom's `landed` guard: a stored id that never resolves must not retry forever.
    const [stored, setStored] = useAtom(persistedSubjectAtom);
    // the derived conversationsAtom coalesces a null summary list to [], so it cannot say "not loaded".
    // Read the raw summaries for that signal and keep conversationsAtom for the ids themselves.
    const summaries = useAtomValue(persistedSummariesAtom);
    const restoredRef = useRef(false);
    useEffect(() => {
        if (restoredRef.current || active != null) {
            return;
        }
        const decision = restoreDecision(stored, {
            channels: channels?.map((c) => c.oid) ?? null,
            dossiers: dossiers?.map((d) => d.id) ?? null,
            conversations: summaries == null ? null : conversations.map((v) => v.id),
        });
        if (decision.action === "wait") {
            return;
        }
        restoredRef.current = true;
        if (decision.action === "select") {
            selectSubject(decision.subject);
            return;
        }
        setStored(null);
    }, [stored, channels, dossiers, conversations, summaries, active, setStored]);
```

Add the imports: `persistedSubjectAtom` from `./jarvissubjectstore`, `restoreDecision` from `./subjectrestore`, `persistedSummariesAtom` from `./jarvisstore`, and `useAtom` from `jotai` if the file imports only `useAtomValue`.

- [ ] **Step 9: Verify**

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: all pass.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.
Run: `npx vitest run`
Expected: no regressions anywhere in the frontend suite.

---

### Task 9: CDP coverage and documentation

The surface's most common defect class is a bad hop between atoms, which the unit suite cannot see. Three of these changes are exactly that class, so they need live steps. Every new step must be checked by breaking its own fix and confirming only that step reddens — a green scenario that cannot fail is not a net.

**Files:**
- Modify: `scripts/cdp/scenarios.mjs`
- Modify: `docs/jarvis-tab.md`, `docs/jarvis-consolidation-open-issues.md`

- [ ] **Step 1: Add the `jarvis-narrow` scenario**

In `scripts/cdp/scenarios.mjs`, add the scenario below, following the file's existing `{name, surface, arrange, assert}` shape (see `jarvis-subject-state` at line 1041 for the `h.goto` / `h.ev` / `rec` idiom).

**Formatting:** `.editorconfig` omits `.mjs`, so `prettier --write` would reindent this whole file to 2-space. Hand-format at 4-space to match. Never run prettier on `scripts/*.mjs`.

```js
{
    name: "jarvis-narrow",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        await h.goto("jarvis");
        await settle(400);

        // measured, not computed: the point of this scenario is that the live layout agrees with
        // jarvislayout.ts's arithmetic. STAGE_MIN_PX mirrored here deliberately - if they drift, this fails.
        const STAGE_MIN = 640;
        const boxes = () =>
            h.ev(`(() => {
                const q = (sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    return { left: r.left, right: r.right, width: r.width };
                };
                return JSON.stringify({
                    surface: q('[data-jarvis-region="surface"]'),
                    stage: q('[data-jarvis-region="stage"]'),
                    subjects: q('[data-jarvis-region="subjects"]'),
                    rail: q('aside[aria-label="Stage context"]'),
                });
            })()`);

        // raw CDP passthrough - the harness exposes h.cdp for exactly this (attach.mjs:141). verify.mjs
        // re-applies VERIFY_VIEWPORT after every scenario, so no teardown is needed here.
        const atWidth = async (width) => {
            await h.cdp("Emulation.setDeviceMetricsOverride", {
                width,
                height: 1000,
                deviceScaleFactor: 1,
                mobile: false,
            });
            await settle(350);
            return JSON.parse(await boxes());
        };

        for (const width of [1600, 1200, 1000, 900]) {
            const b = await atWidth(width);
            const ok = b.stage != null && b.stage.width >= STAGE_MIN;
            rec(`stage holds its floor at ${width}px`, ok, `stage=${Math.round(b.stage?.width ?? 0)}px`);
        }

        // below the point where strips are still enough, the rail must stop taking inline width: its box
        // overlaps the Stage's rather than sitting beside it.
        const narrow = await atWidth(800);
        const overlapping = narrow.rail != null && narrow.stage != null && narrow.rail.left < narrow.stage.right;
        rec(
            "rail overlays the Stage once collapsing is not enough",
            overlapping,
            `rail.left=${Math.round(narrow.rail?.left ?? 0)} stage.right=${Math.round(narrow.stage?.right ?? 0)}`
        );
        rec(
            "stage still holds its floor with the rail overlaid",
            narrow.stage != null && narrow.stage.width >= STAGE_MIN,
            `stage=${Math.round(narrow.stage?.width ?? 0)}px`
        );

        await h.shot("jarvis-narrow");
        return steps;
    },
},
```

Register the scenario in whatever list `scripts/cdp/scenarios.mjs` exports, alongside the other `jarvis-*` entries.

Assertion gotcha in this harness: rail and section headings are Tailwind `uppercase` and `innerText` applies `text-transform`, so any text match must be case-insensitive. The rail's `aria-label` is on the `<aside>`; the button carrying that label exists only in the collapsed strip.

- [ ] **Step 2: Add the restore and thread-lifecycle steps**

Extend `jarvis-subject-state` with: select a subject, reload the page, confirm the same subject is active; then delete it and reload, confirming the empty Stage. Add a step that right-clicks a thread row, archives it, and confirms it moves into the `Archived · N` group.

- [ ] **Step 3: Run the scenarios**

Run: `task verify:ui -- surface-smoke jarvis-states jarvis-fleet jarvis-contextual jarvis-drawer jarvis-subject-state jarvis-narrow`
Expected: all steps pass. The dev app must be running (`task dev`); if CDP refuses on `:9222`, check the dev log for a crash rather than retrying.

- [ ] **Step 4: Break each new fix and confirm the right step reddens**

For each new step, revert its fix, re-run, confirm only that step fails, then restore. Record which revert reddens which step — `docs/jarvis-tab.md` § Verifying holds that table.

- [ ] **Step 5: Update the docs**

In `docs/jarvis-tab.md`:
- § 1 — the collapse ladder gains the overlay step and the nav rail's own rule.
- § 2 — thread rows gain Archive / Delete; note the `Archived · N` group now holds both kinds.
- § 5 — the terminal table gains `cancelled`; note Cancel is available while streaming.
- § 13 — `j`/`k` unchanged as keys, but state that the commit is idle-debounced.
- § 14 — the last subject is now persisted and validated on boot.
- Known gaps — delete the 12b, 12c and last-subject rows; narrow 11b to the sub-696px surface residual.
- § Verifying — add the new scenario and its revert-reddens mapping.

In `docs/jarvis-consolidation-open-issues.md`: mark JC17 fixed (debounced commit, contract untouched), JC8 fully fixed (cancel landed), and JC16 fixed including step 4, with the residual stated.

- [ ] **Step 6: Final verification**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — exit 0.
Run: `npx vitest run` — all pass.
Run: `go test ./pkg/wshrpc/... ./pkg/wstore/` — ok.
Run: `npx eslint frontend/app/view/jarvis/ frontend/app/view/agents/navrail.tsx scripts/cdp/scenarios.mjs` — no new hits (2 pre-existing in this tree).

- [ ] **Step 7: Present for commit approval**

Do not commit. Summarise what landed, what was verified with which command and what output, and ask for approval to make the single batched commit (code + spec + plan + doc updates together).
