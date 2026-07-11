# Runs View Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish three deferred controls (inline Steer, Edit plan, retire Pause) and a four-part visual/interaction pass (composer parity, new-run state, empty states, motion) on the channel Runs view — all front-end only.

**Architecture:** One new shared component (`ComposerShell`) is extracted first and consumed by the chat composer, the new-run panel, and the inline steer composer. All Runs behavior changes are pure helpers added to `runmodel.ts` (unit-tested) wired into a `runssurface.tsx` that stays a thin view shell. Motion reuses the existing shared entrance guard and `useSettle` hook. No wire-protocol change, no backend build, no `task generate`.

**Tech Stack:** React 19, TypeScript, Tailwind 4, jotai, `motion/react`. Tests: vitest (pure helpers only — there is no jsdom/render harness in this repo). Typecheck via `tsc`. Visual verification via Chrome DevTools Protocol against the live dev app.

## Global Constraints

- **FE-only.** No Go changes, no `task build:backend`, no `task generate`. Reuse existing RPCs only: `steerWorker`/`steerRunLead`, `FileReadCommand`, `FileWriteCommand`, `CreateRunCommand`, `AdvanceRunCommand`, `CancelRunCommand`.
- **Never hand-edit generated files** (`wshclientapi.ts` et al.). Nothing is regenerated this batch.
- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline is clean, exit 0). `npx tsc` stack-overflows on this repo — do not use it.
- **Single unit-test file** for new helpers: `frontend/app/view/agents/runmodel.test.ts`. Run one file with `npx vitest run frontend/app/view/agents/runmodel.test.ts`.
- **No commits inside tasks.** Per repo owner's git policy, all changes are batched into ONE commit at the very end, only after explicit approval. Each task ends with a verify checkpoint, not a commit.
- **Copy/style:** no emojis in code or UI copy. Comments explain "why," lower-case, only when necessary. Match existing file conventions (the `// Copyright 2026, Command Line Inc.` + SPDX header on new files).
- **Reduced motion:** every animation must degrade under `MotionConfig reducedMotion="user"` / `motion-reduce:animate-none`, matching the chat surface.
- **Visual verification is best-effort.** It requires `tail -f /dev/null | task dev` running; capture with `node scripts/cdp-shot.mjs [out.png]`. Never `Page.reload`. If dev is not running, mark the visual step UNVERIFIED with that reason — do not claim it passed.

---

## File Structure

**Create:**
- `frontend/app/view/agents/composer-shell.tsx` — the shared composer frame (card + footer row + Send button + built-in auto-growing textarea, with slots for a custom input region and an overlay). One responsibility: the composer's look and Send affordance.

**Modify:**
- `frontend/app/view/agents/channelssurface.tsx` — refactor the existing chat `Composer` to build on `ComposerShell` (mechanical, no behavior change).
- `frontend/app/view/agents/runssurface.tsx` — inline Steer, Edit-plan wiring, retire Pause + Re-dispatch, new-run state + tabs + empty state, motion.
- `frontend/app/view/agents/runmodel.ts` — new pure helpers: `steerTarget`, `planDirty`, `resolveActiveRunId`, `phaseProgressDots`, `phaseRailIds`.
- `frontend/app/view/agents/runmodel.test.ts` — tests for the new helpers.

**Reuse (no edits):**
- `frontend/app/element/motiontokens.ts` — `cardVariants`, `computeEntrances`, `initialEntranceState`.
- `frontend/app/element/motionhooks.ts` — `useSettle`.
- `frontend/app/view/agents/channelactions.ts` — `steerWorker`.
- `frontend/app/view/agents/runactions.ts` — `createRun`, `approveGate`, `sendBackGate`, `cancelRun`.
- `frontend/util/util.ts` — `stringToBase64`, `base64ToString`, `fireAndForget`, `cn`.

**Task order:** Task 1 (`ComposerShell`) is a prerequisite for Tasks 2 and 5. Tasks 2–6 all edit `runssurface.tsx` and must run sequentially (one implementer per task, review between). Task 4 is a pure deletion and can slot anywhere after Task 1.

---

## Task 1: Extract `ComposerShell` and refactor the chat composer onto it

**Files:**
- Create: `frontend/app/view/agents/composer-shell.tsx`
- Modify: `frontend/app/view/agents/channelssurface.tsx` (the `Composer` function, currently lines ~518–719, and its import block)

**Interfaces:**
- Produces: `ComposerShell(props)` where
  ```ts
  {
    onSubmit: () => void;              // Send / Enter (no shift)
    value?: string;                    // used only by the built-in textarea
    onChange?: (next: string) => void; // used only by the built-in textarea
    placeholder?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    inputRegion?: ReactNode;           // custom input (chat's backdrop+textarea); when set, value/onChange are ignored
    overlay?: ReactNode;               // absolutely-positioned sibling above the card (chat's mention dropdown)
    footerLeft?: ReactNode;            // slot before the flex spacer
    footerRight?: ReactNode;           // slot after the spacer, before Send
    sendLabel?: string;                // default "Send ⏎"
    sendDisabled?: boolean;            // default falls back to `disabled`
  }
  ```
- Consumes: nothing (leaf component).

This task has **no unit test** — `ComposerShell` is a React component and this repo has no render harness (see CLAUDE.md). Verification is typecheck + a CDP visual check that the chat mention dropdown still works. The refactor is mechanical: the chat composer's behavior (highlighting, caret sync, suggestion nav, plan chip, `@ mention agent` button) must be preserved byte-for-byte; only its outer frame markup moves into `ComposerShell`.

- [ ] **Step 1: Create `composer-shell.tsx`**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The shared composer frame used by the channel chat composer, the Runs new-run panel, and the inline
// steer composer, so the three read as one system. Owns the rounded card, the footer row, and the Send
// button. Callers either use the built-in auto-growing textarea (value/onChange/onSubmit) or pass a
// custom `inputRegion` (chat's mention-highlight backdrop + textarea) plus an `overlay` (chat's mention
// dropdown). Outer positioning/padding around the card belongs to the caller (bottom bar vs centered
// panel vs inline steer), so it is intentionally not owned here.

import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

export function ComposerShell({
    onSubmit,
    value,
    onChange,
    placeholder,
    disabled,
    autoFocus,
    inputRegion,
    overlay,
    footerLeft,
    footerRight,
    sendLabel = "Send ⏎",
    sendDisabled,
}: {
    onSubmit: () => void;
    value?: string;
    onChange?: (next: string) => void;
    placeholder?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    inputRegion?: ReactNode;
    overlay?: ReactNode;
    footerLeft?: ReactNode;
    footerRight?: ReactNode;
    sendLabel?: string;
    sendDisabled?: boolean;
}) {
    const taRef = useRef<HTMLTextAreaElement>(null);
    // grow the built-in textarea to fit its content (capped by max-h). Chat supplies its own inputRegion
    // and sizes itself via the highlight backdrop, so this only runs for the built-in path.
    useLayoutEffect(() => {
        const ta = taRef.current;
        if (ta && inputRegion == null) {
            ta.style.height = "0px";
            ta.style.height = `${ta.scrollHeight}px`;
        }
    }, [value, inputRegion]);
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
        }
    };
    return (
        <div className="relative">
            {overlay}
            <div className="rounded-[12px] border border-edge-mid bg-surface-raised px-[15px] py-3">
                <div className="relative">
                    {inputRegion ?? (
                        <textarea
                            ref={taRef}
                            value={value ?? ""}
                            onChange={(e) => onChange?.(e.target.value)}
                            onKeyDown={onKeyDown}
                            rows={1}
                            autoFocus={autoFocus}
                            placeholder={placeholder}
                            disabled={disabled}
                            className="max-h-[160px] w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-[1.5] text-primary placeholder:text-muted focus:outline-none disabled:opacity-50"
                            style={{ caretColor: "var(--color-primary)" }}
                        />
                    )}
                </div>
                <div className="mt-2.5 flex items-center gap-2.5">
                    {footerLeft}
                    <div className="flex-1" />
                    {footerRight}
                    <button
                        type="button"
                        onClick={onSubmit}
                        disabled={sendDisabled ?? disabled}
                        className="shrink-0 cursor-pointer rounded-[8px] bg-accent px-[15px] py-1.5 text-[12.5px] font-semibold text-background hover:bg-accenthover disabled:opacity-50"
                    >
                        {sendLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Refactor chat `Composer` in `channelssurface.tsx` to use `ComposerShell`**

Add the import near the other local view imports:
```tsx
import { ComposerShell } from "./composer-shell";
```

Replace the `Composer` function's `return (...)` (currently lines ~617–717, the block that starts `<div className="flex-none px-6 pb-[18px] pt-2">` and ends before the closing of the function) with the version below. All the logic above the return (`taRef`, `pendingCaret`, `sugg`, `sel`, `segments`, `matches`, `open`, `accept`, `insertAt`, `syncSuggest`, `onKeyDown`, the `useEffect`/`useLayoutEffect`) is UNCHANGED — only the JSX frame moves into `ComposerShell` via its `overlay` / `inputRegion` / `footerLeft` / `footerRight` slots:

```tsx
    return (
        <div className="flex-none px-6 pb-[18px] pt-2">
            <ComposerShell
                onSubmit={onSend}
                disabled={disabled}
                sendLabel="Send ⏎"
                overlay={
                    open ? (
                        <div className="absolute bottom-full left-0 mb-1.5 w-[240px] overflow-hidden rounded-[9px] border border-edge-strong bg-surface-raised shadow-lg">
                            {matches.map((c, i) => (
                                <button
                                    key={c.name}
                                    type="button"
                                    onMouseDown={(e) => {
                                        e.preventDefault();
                                        accept(c);
                                    }}
                                    onMouseEnter={() => setSel(i)}
                                    className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left ${
                                        i === sel ? "bg-accentbg" : ""
                                    }`}
                                >
                                    <span className="font-mono text-[12.5px] text-primary">@{c.name}</span>
                                    <span className="ml-auto font-mono text-[9px] uppercase tracking-[.06em] text-muted">
                                        {c.kind}
                                    </span>
                                </button>
                            ))}
                        </div>
                    ) : null
                }
                inputRegion={
                    <>
                        <div
                            aria-hidden
                            className="pointer-events-none min-h-[22px] whitespace-pre-wrap break-words text-[14px] leading-[1.5] text-primary"
                        >
                            {segments.map((s, i) =>
                                s.kind === "mention" ? (
                                    <span key={i} className="rounded-[3px] bg-accentbg text-accent-soft">
                                        {s.text}
                                    </span>
                                ) : s.kind === "command" ? (
                                    <span key={i} className="font-semibold text-accent">
                                        {s.text}
                                    </span>
                                ) : (
                                    <span key={i}>{s.text}</span>
                                )
                            )}
                            {"​"}
                        </div>
                        <textarea
                            ref={taRef}
                            value={value}
                            onChange={(e) => {
                                onChange(e.target.value);
                                syncSuggest();
                            }}
                            onKeyDown={onKeyDown}
                            onKeyUp={syncSuggest}
                            onClick={syncSuggest}
                            onBlur={() => setSugg(null)}
                            rows={1}
                            placeholder={placeholder}
                            disabled={disabled}
                            className="absolute inset-0 h-full w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent text-[14px] leading-[1.5] text-transparent placeholder:text-muted focus:outline-none disabled:opacity-50"
                            style={{ caretColor: "var(--color-primary)" }}
                        />
                    </>
                }
                footerLeft={
                    <button
                        type="button"
                        onMouseDown={(e) => {
                            e.preventDefault();
                            insertAt();
                        }}
                        disabled={disabled}
                        className="cursor-pointer rounded-[7px] border border-edge-mid px-2.5 py-1 font-mono text-[11.5px] text-ink-mid hover:border-edge-strong disabled:opacity-50"
                    >
                        @ mention agent
                    </button>
                }
                footerRight={
                    chip ? (
                        <span
                            className={cn(
                                "shrink-0 truncate font-mono text-[11px]",
                                chip.tone === "warn" ? "text-asking" : "text-muted"
                            )}
                        >
                            {chip.label}
                        </span>
                    ) : null
                }
            />
            <CommandHint />
        </div>
    );
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no new errors. (`cn` is already imported in `channelssurface.tsx`.)

- [ ] **Step 4: Verify chat composer unchanged (visual, best-effort)**

With `tail -f /dev/null | task dev` running: open a channel, type `@` in the composer, confirm the mention dropdown appears and accepting a suggestion inserts `@name `, the highlight still colors mentions, and Send works. Capture `node scripts/cdp-shot.mjs`. If dev is not running, mark UNVERIFIED (reason: dev app not running) and rely on typecheck.

---

## Task 2: Inline Steer (replace `window.prompt`)

**Files:**
- Modify: `frontend/app/view/agents/runmodel.ts` (add `steerTarget`)
- Test: `frontend/app/view/agents/runmodel.test.ts`
- Modify: `frontend/app/view/agents/runssurface.tsx` (`RunsView` header Steer button, currently ~lines 524–553)

**Interfaces:**
- Produces: `steerTarget(run: Run, agents: AgentVM[]): AgentVM | undefined` — the worker a Steer targets: the first worker of the current phase, or `undefined` when the run is terminal or no such worker exists.
- Consumes: `steerWorker` from `./channelactions`; `ComposerShell` from `./composer-shell`; existing `currentPhaseIndex`, `phaseWorkers`, `isTerminal`.

- [ ] **Step 1: Write the failing test**

Add to `runmodel.test.ts`. Add `steerTarget` to the existing import from `./runmodel`:
```ts
describe("steerTarget", () => {
    it("returns the first worker of the current phase", () => {
        const r = run({
            status: "executing",
            phases: [phase({ state: "running", workerorefs: ["tab:t1"] })],
        });
        expect(steerTarget(r, [agent({ id: "t1" })])?.id).toBe("t1");
    });
    it("returns undefined when the run is terminal", () => {
        const r = run({
            status: "done",
            phases: [phase({ state: "done", workerorefs: ["tab:t1"] })],
        });
        expect(steerTarget(r, [agent({ id: "t1" })])).toBeUndefined();
    });
    it("returns undefined when the current phase has no live worker", () => {
        const r = run({ status: "executing", phases: [phase({ state: "running" })] });
        expect(steerTarget(r, [])).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts -t steerTarget`
Expected: FAIL — `steerTarget is not a function` / not exported.

- [ ] **Step 3: Implement `steerTarget`**

Append to `runmodel.ts`:
```ts
// The worker a Steer targets: the first worker of the current phase. Undefined on a terminal run or when
// that phase has no live worker (the Steer affordance is hidden/disabled in those cases).
export function steerTarget(run: Run, agents: AgentVM[]): AgentVM | undefined {
    if (isTerminal(run.status)) {
        return undefined;
    }
    const phase = (run.phases ?? [])[currentPhaseIndex(run)];
    if (!phase) {
        return undefined;
    }
    return phaseWorkers(phase, agents)[0];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts -t steerTarget`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the inline Steer UI in `runssurface.tsx`**

Add imports (extend existing lines):
```tsx
import { steerTarget /* ...existing... */ } from "./runmodel";
import { ComposerShell } from "./composer-shell";
```

In `RunsView`, add local state near the other `useState`s (~line 403–405):
```tsx
    const [steering, setSteering] = useState(false);
    const [steerDraft, setSteerDraft] = useState("");
```

Reset it when the active run changes — extend the existing effect that lands on the default run (~line 408) or add:
```tsx
    useEffect(() => {
        setSteering(false);
        setSteerDraft("");
    }, [activeRunId]);
```

Replace the header Steer button block (currently the `<button ... onClick={() => { const idx = currentPhaseIndex(run); ... window.prompt(...) ... }}>Steer</button>`, ~lines 525–544) with a toggle that opens the inline composer:
```tsx
                                    <button
                                        type="button"
                                        disabled={!steerTarget(run, agents)}
                                        onClick={() => setSteering((v) => !v)}
                                        className="rounded-[8px] border border-edge-mid px-2.5 py-1.5 text-[11.5px] font-semibold text-secondary hover:border-edge-strong disabled:opacity-40"
                                    >
                                        Steer
                                    </button>
```

Immediately after the run header block (after the `</div>` that closes the header `flex items-start gap-3`, ~line 554, before the `run.status === "executing"` rollup), add the inline steer composer:
```tsx
                            {steering && steerTarget(run, agents) ? (
                                <div className="mb-4 max-w-[760px]">
                                    <ComposerShell
                                        value={steerDraft}
                                        onChange={setSteerDraft}
                                        autoFocus
                                        placeholder={`Steer ${steerTarget(run, agents)?.name}…`}
                                        sendLabel="Steer ⏎"
                                        onSubmit={() => {
                                            const target = steerTarget(run, agents);
                                            const text = steerDraft.trim();
                                            if (!target || !text) {
                                                return;
                                            }
                                            setSteerDraft("");
                                            setSteering(false);
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
```

Remove the now-unused `window.prompt` code. `steerWorker` is already imported in `runssurface.tsx` (line 16); `currentPhaseIndex` may become unused in this file — remove it from the import only if the typecheck flags it.

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 7: Verify (visual, best-effort)**

With dev running and a run that has a live worker (`node scripts/inject-live-agents.mjs <scenario>` if needed): click Steer, confirm the inline composer opens (no `window.prompt`), type + Enter resumes the worker and the composer closes. Capture a shot. If dev is not running, mark UNVERIFIED.

---

## Task 3: Edit plan in the review gate

**Files:**
- Modify: `frontend/app/view/agents/runmodel.ts` (add `planDirty`)
- Test: `frontend/app/view/agents/runmodel.test.ts`
- Modify: `frontend/app/view/agents/runssurface.tsx` (`PlanPreview` ~lines 78–141 and `ReviewGateCard` ~lines 143–184)

**Interfaces:**
- Produces: `planDirty(edited: string, saved: string): boolean` — whether unsaved edits exist (used to flush before Approve).
- Consumes: `FileReadCommand`, `FileWriteCommand` (already available via `RpcApi`); `stringToBase64` from `@/util/util`.

- [ ] **Step 1: Write the failing test**

Add to `runmodel.test.ts` (add `planDirty` to the `./runmodel` import):
```ts
describe("planDirty", () => {
    it("is false when edited equals saved", () => {
        expect(planDirty("abc", "abc")).toBe(false);
    });
    it("is true when edited differs from saved", () => {
        expect(planDirty("abc x", "abc")).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts -t planDirty`
Expected: FAIL — `planDirty is not a function`.

- [ ] **Step 3: Implement `planDirty`**

Append to `runmodel.ts`:
```ts
// True when the plan editor holds unsaved changes; Approve must flush these first so no edit is lost.
export function planDirty(edited: string, saved: string): boolean {
    return edited !== saved;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts -t planDirty`
Expected: PASS (2 tests).

- [ ] **Step 5: Make `PlanPreview` editable and expose a flush handle**

Add imports to `runssurface.tsx`:
```tsx
import { planDirty /* ...existing... */ } from "./runmodel";
import { base64ToString, fireAndForget, stringToBase64 } from "@/util/util";
```
(`base64ToString` and `fireAndForget` are already imported — add `stringToBase64` to that line.)

`PlanPreview` currently takes `{ path }`. Change it to accept a ref-setter so the gate can flush before Approve, and add edit state. Replace the `PlanPreview` component body's state + render with:

```tsx
function PlanPreview({ path, onEditorReady }: { path: string; onEditorReady?: (flush: () => Promise<void>) => void }) {
    const [load, setLoad] = useState<{ status: "loading" | "error" | "ok"; text: string; lines: number }>({
        status: "loading",
        text: "",
        lines: 0,
    });
    const [override, setOverride] = useState<boolean | null>(null); // user's explicit collapse toggle; null = auto
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [saveErr, setSaveErr] = useState(false);

    useEffect(() => {
        let alive = true;
        setLoad({ status: "loading", text: "", lines: 0 });
        setOverride(null);
        setEditing(false);
        setSaveErr(false);
        fireAndForget(async () => {
            try {
                const fileData = await RpcApi.FileReadCommand(TabRpcClient, { info: { path } });
                const text = fileData?.data64 ? base64ToString(fileData.data64) : "";
                if (alive) {
                    setLoad(
                        text.trim()
                            ? { status: "ok", text, lines: text.split("\n").length }
                            : { status: "error", text: "", lines: 0 }
                    );
                }
            } catch {
                if (alive) {
                    setLoad({ status: "error", text: "", lines: 0 });
                }
            }
        });
        return () => {
            alive = false;
        };
    }, [path]);

    const save = async () => {
        try {
            await RpcApi.FileWriteCommand(TabRpcClient, { info: { path }, data64: stringToBase64(draft) });
            setLoad({ status: "ok", text: draft, lines: draft.split("\n").length });
            setSaveErr(false);
            setEditing(false);
        } catch {
            setSaveErr(true); // keep the edit in the textarea; never silently drop it
        }
    };

    // let the gate flush a pending edit before it advances the run
    useEffect(() => {
        onEditorReady?.(async () => {
            if (editing && planDirty(draft, load.text)) {
                await save();
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editing, draft, load.text]);

    const large = load.status === "ok" && load.lines > PLAN_PREVIEW_COLLAPSE_LINES;
    const open = editing || (override ?? !large); // editing forces the section open
    const filename = path.split(/[/\\]/).pop() ?? path;
    return (
        <div className="border-b border-asking/20">
            <div className="flex w-full items-center gap-2 px-3.5 py-2">
                <button type="button" onClick={() => setOverride(!open)} className="flex min-w-0 flex-1 items-center gap-2 hover:opacity-80">
                    <span className="font-mono text-[8px] text-asking">{open ? "▼" : "▶"}</span>
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-asking">Plan</span>
                    <span className="truncate font-mono text-[10.5px] text-muted">
                        {filename}
                        {load.status === "ok" ? ` · ${load.lines} lines` : ""}
                    </span>
                </button>
                {load.status === "ok" && !editing ? (
                    <button
                        type="button"
                        onClick={() => {
                            setDraft(load.text);
                            setEditing(true);
                        }}
                        className="flex-none rounded-[6px] border border-edge-mid px-2 py-0.5 font-mono text-[10px] text-ink-mid hover:border-edge-strong"
                    >
                        Edit
                    </button>
                ) : null}
                {editing ? (
                    <button
                        type="button"
                        onClick={() => fireAndForget(save)}
                        className="flex-none rounded-[6px] border border-accent/50 bg-accentbg/40 px-2 py-0.5 font-mono text-[10px] text-accent-soft hover:bg-accentbg/60"
                    >
                        Save
                    </button>
                ) : null}
            </div>
            {open ? (
                <div className="sc max-h-[320px] overflow-y-auto px-3.5 pb-3">
                    {editing ? (
                        <textarea
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            className="h-[300px] w-full resize-none rounded-[8px] border border-edge-mid bg-background px-3 py-2 font-mono text-[12px] leading-[1.5] text-secondary focus:outline-none"
                        />
                    ) : load.status === "loading" ? (
                        <span className="text-[12px] text-muted">Loading plan…</span>
                    ) : load.status === "error" ? (
                        <span className="text-[12px] text-muted">Couldn't read plan · {filename}</span>
                    ) : (
                        <MarkdownMessage text={load.text} className="text-[12.5px] leading-[1.55] text-secondary" />
                    )}
                    {saveErr ? <div className="mt-1.5 text-[11px] text-error">Couldn't save the plan — try again.</div> : null}
                </div>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 6: Flush edits before Approve in `ReviewGateCard`**

In `ReviewGateCard`, capture the flush callback and call it before `approveGate`. Replace the component with:

```tsx
function ReviewGateCard({ channelId, run, gateIdx }: { channelId: string; run: Run; gateIdx: number }) {
    const gatePhase = run.phases[gateIdx];
    const artifact = (gatePhase.artifacts ?? [])[0];
    const flushRef = useRef<() => Promise<void>>(async () => {});
    return (
        <div className="mt-3 max-w-[760px] overflow-hidden rounded-[12px] border border-asking/40 bg-lane-asking">
            <div className="flex items-center gap-2 border-b border-asking/20 px-3.5 py-2.5">
                <span className="h-[7px] w-[7px] rounded-full bg-asking" />
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-asking">Review gate</span>
                <span className="flex-1 text-[11.5px] text-ink-mid">
                    {run.mode === "orchestrator" ? "plan ready — approve to let the lead proceed" : "approve before execution starts"}
                </span>
                {artifact ? <span className="font-mono text-[10.5px] text-muted">{artifact}</span> : null}
            </div>
            {artifact ? (
                <PlanPreview
                    path={resolveArtifactPath(run.projectpath, artifact)}
                    onEditorReady={(flush) => {
                        flushRef.current = flush;
                    }}
                />
            ) : null}
            <div className="flex items-center gap-2.5 px-3.5 py-3">
                <button
                    type="button"
                    onClick={() =>
                        fireAndForget(async () => {
                            await flushRef.current(); // persist any unsaved plan edit first
                            await approveGate(channelId, run.id, gateIdx);
                        })
                    }
                    className="rounded-[8px] bg-accent px-4 py-2 text-[12px] font-bold text-background hover:bg-accent/90"
                >
                    {run.mode === "orchestrator" ? "Approve & proceed" : "Approve & execute"}
                </button>
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={() => fireAndForget(() => sendBackGate(channelId, run.id, gateIdx))}
                    className="rounded-[8px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-secondary hover:border-asking hover:text-asking"
                >
                    Send back
                </button>
            </div>
        </div>
    );
}
```

Note: the disabled "Edit plan" button is removed from the footer here (its function now lives in the Plan header). Add `useRef` to the React import in `runssurface.tsx` if not already present (it is — line 13).

- [ ] **Step 7: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 8: Verify (visual, best-effort)**

With dev running and a run parked at a review gate: click Edit in the Plan header, change text, Save, confirm the rendered plan updates. Then edit again without saving and click Approve — confirm the run advances and the file on disk has the edit (re-open the gate on a `sendback`, or read the artifact). If dev is not running, mark UNVERIFIED.

---

## Task 4: Retire the dead Pause and Re-dispatch buttons

**Files:**
- Modify: `frontend/app/view/agents/runssurface.tsx` (`BlockedCard` ~lines 200–237; run header `Pause` button ~lines 545–552)

No unit test (pure deletion of inert UI). Verify by typecheck + visual.

- [ ] **Step 1: Remove the Pause button from the run header**

Delete the disabled Pause `<button>` block in the header actions (the one with `title="Pause is coming in a later piece"`). The header's action group keeps only the Steer button (from Task 2). If that leaves a now-empty wrapper `<div className="flex flex-none gap-1.5">`, keep it (it still holds Steer).

- [ ] **Step 2: Remove the Re-dispatch button from `BlockedCard`**

In `BlockedCard`, delete the disabled Re-dispatch `<button>` (the one with `title="Re-dispatch is coming in a later piece"`). Keep "Take control" and "Cancel run". The action row becomes:
```tsx
            <div className="flex items-center gap-2">
                {worker ? (
                    <button
                        type="button"
                        onClick={() => jumpToAgent(model, worker.id)}
                        className="rounded-[8px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-secondary hover:border-edge-strong"
                    >
                        Take control
                    </button>
                ) : null}
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={() => fireAndForget(() => cancelRun(channelId, run.id))}
                    className="rounded-[8px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-muted hover:border-error hover:text-error"
                >
                    Cancel run
                </button>
            </div>
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Verify (visual, best-effort)**

Run header shows only Steer (+ the run title/status). A blocked run's card shows only Take control + Cancel run. If dev is not running, mark UNVERIFIED.

---

## Task 5: New-run state, run-tab progress + dismiss, empty state

**Files:**
- Modify: `frontend/app/view/agents/runmodel.ts` (add `resolveActiveRunId`, `phaseProgressDots`)
- Test: `frontend/app/view/agents/runmodel.test.ts`
- Modify: `frontend/app/view/agents/runssurface.tsx` (`RunsView` — run tabs ~485–510, empty/body ~514–579, bottom composer ~583–609)

**Interfaces:**
- Produces:
  - `resolveActiveRunId(visibleRuns: Run[], current: string | undefined): string | undefined` — keep `current` if it is still visible, else fall back to `defaultRunId(visibleRuns)`.
  - `phaseProgressDots(run: Run): PhaseTone[]` — one tone per phase, for the per-tab progress dots.
- Consumes: `ComposerShell`; `composerSummary` (existing); `runStatusView`, `defaultRunId`, `phaseStateView` (existing).

- [ ] **Step 1: Write the failing tests**

Add to `runmodel.test.ts` (add `resolveActiveRunId, phaseProgressDots` to the `./runmodel` import):
```ts
describe("resolveActiveRunId", () => {
    it("keeps the current id when still visible", () => {
        expect(resolveActiveRunId([run({ id: "a" }), run({ id: "b" })], "b")).toBe("b");
    });
    it("falls back to the default when the current id is gone", () => {
        expect(resolveActiveRunId([run({ id: "a", createdts: 5, status: "executing" })], "b")).toBe("a");
    });
    it("returns undefined when nothing is visible", () => {
        expect(resolveActiveRunId([], "b")).toBeUndefined();
    });
});

describe("phaseProgressDots", () => {
    it("maps each phase to its tone in order", () => {
        const r = run({ phases: [phase({ state: "done" }), phase({ state: "running" }), phase({ state: "pending" })] });
        expect(phaseProgressDots(r)).toEqual(["done", "running", "pending"]);
    });
    it("is empty for a run with no phases", () => {
        expect(phaseProgressDots(run({ phases: [] }))).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts -t "resolveActiveRunId|phaseProgressDots"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the helpers**

Append to `runmodel.ts`:
```ts
// The run id to select given the currently-visible tabs: keep the current selection if it is still
// visible, else land on the default (most-recent non-terminal). Undefined selects the new-run state.
export function resolveActiveRunId(visibleRuns: Run[], current: string | undefined): string | undefined {
    if (current && visibleRuns.some((r) => r.id === current)) {
        return current;
    }
    return defaultRunId(visibleRuns);
}

// One tone per phase, for a run tab's compact progress dots.
export function phaseProgressDots(run: Run): PhaseTone[] {
    return (run.phases ?? []).map((p) => phaseStateView(p.state).tone);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts -t "resolveActiveRunId|phaseProgressDots"`
Expected: PASS (5 tests).

- [ ] **Step 5: Add dismiss state and visible-runs derivation in `RunsView`**

Add imports:
```tsx
import { phaseProgressDots, resolveActiveRunId /* ...existing... */ } from "./runmodel";
```

At the top of `RunsView`, replace `const runs = channel.runs ?? [];` with a dismiss-aware visible list:
```tsx
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());
    const runs = (channel.runs ?? []).filter((r) => !dismissed.has(r.id));
```

Clear dismissals when the channel changes (they are view-local, per-channel):
```tsx
    useEffect(() => {
        setDismissed(new Set());
    }, [channel.oid]);
```

Replace the existing land-on-default effect (~lines 408–413) to route through the helper:
```tsx
    useEffect(() => {
        setActiveRunId((cur) => resolveActiveRunId(runs, cur));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channel.oid, runs.length]);
```

Add the dismiss handler:
```tsx
    const dismissTab = (id: string) => {
        const next = new Set(dismissed);
        next.add(id);
        setDismissed(next);
        const visible = (channel.runs ?? []).filter((r) => !next.has(r.id));
        setActiveRunId((cur) => (cur === id ? defaultRunId(visible) : cur));
    };
```
(`defaultRunId` is already imported in `runssurface.tsx`.)

- [ ] **Step 6: Enrich the run tabs (dots + dismiss ×)**

Replace the run-tab `runs.map((r) => { ... <button> ... </button> })` block (~485–502) with:
```tsx
                {runs.map((r) => {
                    const { tone } = runStatusView(r.status);
                    const dots = phaseProgressDots(r);
                    const isActive = r.id === activeRunId;
                    return (
                        <div
                            key={r.id}
                            className={
                                "group flex max-w-[250px] flex-none items-center gap-2 rounded-[9px] border px-3 py-2 " +
                                (isActive ? "border-accent/50 bg-accentbg/40" : "border-edge-mid hover:border-edge-strong")
                            }
                        >
                            <button
                                type="button"
                                onClick={() => setActiveRunId(r.id)}
                                className="flex min-w-0 items-center gap-2"
                            >
                                <span className={"h-[7px] w-[7px] flex-none rounded-full bg-current " + (TONE_CLASS[tone] ?? "text-muted")} />
                                <span className="truncate text-[12px] font-semibold text-primary">{r.goal}</span>
                            </button>
                            {dots.length > 0 ? (
                                <span className="flex flex-none items-center gap-0.5">
                                    {dots.map((t, i) => (
                                        <span
                                            key={i}
                                            className={"h-[4px] w-[4px] rounded-full bg-current " + (PHASE_TONE_CLASS[t] ?? "text-muted")}
                                        />
                                    ))}
                                </span>
                            ) : null}
                            <button
                                type="button"
                                onClick={() => dismissTab(r.id)}
                                title="Dismiss from this list (does not cancel the run)"
                                className="flex-none font-mono text-[13px] leading-none text-muted opacity-0 hover:text-secondary group-hover:opacity-100"
                            >
                                ×
                            </button>
                        </div>
                    );
                })}
```
(`TONE_CLASS` and `PHASE_TONE_CLASS` are module-level in this file.)

- [ ] **Step 7: Replace the empty body with the new-run compose panel and remove the bottom composer**

Replace the `else` branch of `run ? (...) : (...)` — currently the terse `<div className="mt-10 text-center ...">{runs.length === 0 ? "No runs yet." : ...}</div>` (~575–579) — with the compose panel:
```tsx
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
```

Delete the always-present bottom composer block entirely — the `<div className="flex-none px-6 pb-[18px] pt-2">` containing the `<input ... placeholder="Give Jarvis a goal to start a run…">` and its Start-run row (~583–609). The `ProfilePanel` after it stays.

`startRun` is unchanged. The `<input>`-based composer is gone; `draft`/`setDraft` now feed the panel's `ComposerShell`.

- [ ] **Step 8: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. Remove any import left unused by deleting the old composer (e.g. none expected — `composerSummary` is still used).

- [ ] **Step 9: Verify (visual, best-effort)**

With dev running: `+ New run` shows the centered "Start a run" panel and no bottom composer; typing a goal + Enter starts a run and switches to it. Selecting an existing run shows its detail with no bottom composer. Run tabs show progress dots; hovering a tab reveals ×, which removes it from the strip and reselects sanely (and does not cancel the run). An empty channel shows the same panel. If dev is not running, mark UNVERIFIED.

---

## Task 6: Motion parity

**Files:**
- Modify: `frontend/app/view/agents/runmodel.ts` (add `phaseRailIds`)
- Test: `frontend/app/view/agents/runmodel.test.ts`
- Modify: `frontend/app/view/agents/runssurface.tsx` (`RunsView` root, `PhaseRail`)

**Interfaces:**
- Produces: `phaseRailIds(run: Run): string[]` — stable per-phase ids for the entrance guard.
- Consumes: `cardVariants`, `computeEntrances`, `initialEntranceState` from `@/app/element/motiontokens`; `useSettle` from `@/app/element/motionhooks`; `AnimatePresence`, `MotionConfig`, `motion` from `motion/react`.

- [ ] **Step 1: Write the failing test**

Add to `runmodel.test.ts` (add `phaseRailIds` to the import):
```ts
describe("phaseRailIds", () => {
    it("returns one stable id per phase", () => {
        expect(phaseRailIds(run({ phases: [phase(), phase(), phase()] }))).toEqual(["p0", "p1", "p2"]);
    });
    it("is empty for no phases", () => {
        expect(phaseRailIds(run({ phases: [] }))).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts -t phaseRailIds`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement `phaseRailIds`**

Append to `runmodel.ts`:
```ts
// Stable per-phase ids for the shared no-cascade entrance guard: a newly-appended phase animates in,
// a run switch/first mount is silent (the guard treats a new scope id as already-present).
export function phaseRailIds(run: Run): string[] {
    return (run.phases ?? []).map((_, i) => `p${i}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts -t phaseRailIds`
Expected: PASS (2 tests).

- [ ] **Step 5: Wrap the RunsView tree in `MotionConfig` and compute entrances**

Add imports to `runssurface.tsx`:
```tsx
import { cardVariants, computeEntrances, initialEntranceState } from "@/app/element/motiontokens";
import { useSettle } from "@/app/element/motionhooks";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { phaseRailIds /* ...existing... */ } from "./runmodel";
```

In `RunsView`, compute the entrance set for the active run's phases (place after `run` is resolved, near the other derivations):
```tsx
    const railIds = run ? phaseRailIds(run) : [];
    const entranceRef = useRef(initialEntranceState());
    const { animate: entranceIds } = computeEntrances(entranceRef.current, activeRunId, railIds);
    const railKey = railIds.join(",");
    useLayoutEffect(() => {
        entranceRef.current = computeEntrances(entranceRef.current, activeRunId, railIds).state;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeRunId, railKey]);
```
Add `useLayoutEffect` to the React import (line 13 currently imports `useEffect, useRef, useState`).

Wrap the outermost returned element of `RunsView` in `<MotionConfig reducedMotion="user"> ... </MotionConfig>` (the `<div className="flex min-h-0 flex-1">`).

Pass `entranceIds` into `PhaseRail`:
```tsx
                            {expanded ? (
                                <PhaseRail model={model} run={run} agents={agents} channelId={channel.oid} liveTabIds={liveTabIds} now={now} entranceIds={entranceIds} />
                            ) : null}
```

- [ ] **Step 6: Animate phase blocks in `PhaseRail`**

Extend `PhaseRail`'s props with `entranceIds: Set<string>` and wrap each phase block in a `motion.div`. Change the signature and the `phases.map` wrapper:
```tsx
function PhaseRail({ model, run, agents, channelId, liveTabIds, now, entranceIds }: { model: AgentsViewModel; run: Run; agents: AgentVM[]; channelId: string; liveTabIds: Set<string>; now: number; entranceIds: Set<string> }) {
    const phases = run.phases ?? [];
    const trackedWorkers = isOrchestrator(run) ? phases.flatMap((p) => phaseWorkers(p, agents)) : [];
    useSubagentTracking(trackedWorkers);
    return (
        <AnimatePresence initial={false}>
            {phases.map((p, i) => {
                const v = phaseStateView(p.state);
                const thread = phaseThread(run, i, agents, liveTabIds);
                const workers = phaseWorkers(p, agents);
                const notLast = i < phases.length - 1;
                return (
                    <motion.div
                        key={i}
                        layout
                        variants={cardVariants}
                        initial={entranceIds.has(`p${i}`) ? "initial" : false}
                        animate="animate"
                    >
                        {/* ...existing phase-block body unchanged (boundary, node, kind, artifacts, threads)... */}
                    </motion.div>
                );
            })}
        </AnimatePresence>
    );
}
```
Keep the entire existing inner JSX of each phase block; only the outer wrapper changed from `<div key={i}>` to the `<motion.div key={i} ...>`.

- [ ] **Step 7: Settle a phase node when it completes**

Give the phase node a one-shot settle when its state becomes `done`. Since `useSettle` is a hook, extract the node into a tiny component so it can hold the hook. Add near the other `runssurface.tsx` components:
```tsx
function PhaseNode({ tone, icon, done, notLast }: { tone: string; icon: string; done: boolean; notLast: boolean }) {
    const settling = useSettle(done);
    return (
        <div className="flex w-9 flex-none flex-col items-center">
            <div
                className={
                    "flex h-9 w-9 flex-none items-center justify-center rounded-[10px] border border-current font-mono text-[14px] font-bold " +
                    (PHASE_TONE_CLASS[tone] ?? "text-muted") +
                    (settling ? " animate-[settle_0.5s_ease-out] motion-reduce:animate-none" : "")
                }
            >
                {icon}
            </div>
            {notLast ? <div className="my-1 min-h-[22px] w-0.5 flex-1 bg-edge-mid" /> : null}
        </div>
    );
}
```
In `PhaseRail`, replace the inline node markup (the `<div className="flex w-9 flex-none flex-col items-center">...</div>`) with:
```tsx
                            <PhaseNode tone={v.tone} icon={v.icon} done={p.state === "done"} notLast={notLast} />
```
(The `settle` keyframe is already defined and used by the chat surface — `animate-[settle_0.5s_ease-out]` in `channelssurface.tsx` — so it is available globally.)

- [ ] **Step 8: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 9: Run the full runmodel test file**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts`
Expected: PASS (all suites, including the pre-existing ones).

- [ ] **Step 10: Verify (visual, best-effort)**

With dev running: switching between run tabs does NOT cascade-animate the phases (silent on switch); a newly-started run's phases animate in once; a phase completing shows a brief settle on its node. Confirm reduced-motion (OS setting) disables the animations. If dev is not running, mark UNVERIFIED.

---

## Final: Batched commit (approval-gated)

Per the repo owner's git policy, do NOT commit during the tasks. After all tasks pass typecheck + `npx vitest run frontend/app/view/agents/runmodel.test.ts` and the visual checks are done (or explicitly marked unverified):

- [ ] **Step 1: Self-review the full diff**

Run: `git status` and `git --no-pager diff --stat` then review each changed file. Confirm: no `window.prompt` remains in `runssurface.tsx`; no disabled Pause/Re-dispatch buttons remain; no commented-out code or debug logs; the chat composer diff is a pure extraction.

- [ ] **Step 2: Present the change set and commit message for approval**

Show the files (M/A) with a one-line summary each and this proposed message, then ask "Awaiting approval. Proceed? (yes/no)":
```
feat(runs): inline steer, editable plan gate, new-run panel, motion polish
```

- [ ] **Step 3: Commit only after explicit approval**

```bash
git add frontend/app/view/agents/composer-shell.tsx frontend/app/view/agents/channelssurface.tsx frontend/app/view/agents/runssurface.tsx frontend/app/view/agents/runmodel.ts frontend/app/view/agents/runmodel.test.ts
git commit -m "feat(runs): inline steer, editable plan gate, new-run panel, motion polish"
```

---

## Self-Review

**Spec coverage:**
- Item A (Steer inline) → Task 2. ✓
- Item B (Edit plan) → Task 3. ✓
- Item C (retire Pause + Re-dispatch) → Task 4. ✓
- Item D (new-run state + tabs) → Task 5. ✓
- Item E (shared ComposerShell) → Task 1. ✓
- Item F (empty & loading) → Task 5 (empty state folds into the new-run panel). Loading: the spec's loading case is handled upstream by the existing `channels == null` guard in `ChannelsSurface`; `RunsView` renders only with a resolved channel, so no separate skeleton is added (YAGNI). This is a deliberate narrowing, noted here.
- Item G (motion parity) → Task 6. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows complete code. ✓

**Type consistency:** Helper names are used identically across tasks and match `runmodel.ts` style: `steerTarget`, `planDirty`, `resolveActiveRunId`, `phaseProgressDots`, `phaseRailIds`. `ComposerShell` prop names (`onSubmit`, `value`, `onChange`, `inputRegion`, `overlay`, `footerLeft`, `footerRight`, `sendLabel`, `sendDisabled`, `autoFocus`) are consistent between Task 1's definition and its consumers in Tasks 2 and 5. `PhaseRail` gains `entranceIds: Set<string>` consistently in Task 6 (RunsView passes it, PhaseRail consumes it). Reused symbols (`cardVariants`, `computeEntrances`, `initialEntranceState`, `useSettle`, `steerWorker`, `composerSummary`, `defaultRunId`, `TONE_CLASS`, `PHASE_TONE_CLASS`) exist at the cited locations. ✓

**Known deviation from the writing-plans skill:** per-task `git commit` steps are intentionally replaced by verify checkpoints + one approval-gated commit at the end, because the repo owner's CLAUDE.md forbids auto-commits and mandates a single batched commit. This overrides the skill's frequent-commit default.
