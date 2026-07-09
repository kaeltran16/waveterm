# Channels Real-World Report Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the concrete, code-level usability findings from `docs/agents/channels-realworld-report/report.md` — the five top findings plus the two secondary UI findings and fleet-panel hygiene — in one coherent batch.

**Architecture:** All fixes are localized to the Channels agent-cockpit surface (`frontend/app/view/agents/channels*.tsx` + its pure `channelderive.ts` / `jarviscards.ts` / `jarvisderive.ts` helpers), except the channel-rename fix which adds one backend wshrpc command mirroring the existing `DeleteChannelCommand`, then regenerates bindings. Pure-logic changes are unit-tested (vitest); UI-wiring changes are verified against the live dev app over CDP (there is no jsdom/render-test harness for the cockpit).

**Tech Stack:** React 19 + jotai + Tailwind 4 (frontend); Go + wshrpc (backend); vitest (unit tests); CDP `:9222` against `cargo tauri dev` (visual verification).

---

## Scope

**In scope (this plan):**

| Task | Report finding | Backlog | Kind |
|---|---|---|---|
| 1 | #3 stale rail tiers (§A3) | #2 | FE-only |
| 2 | #5 send looks like nothing (§C9) | (#12 in verdict table) | FE-only |
| 3 | secondary: steer indistinguishable (§C12) | — | FE-only |
| 4 | search box is not an input (§A2) | #4 | FE-only |
| 5 | #4 no guard into Delegator (§B6) | #6 | FE-only |
| 6 | fleet "gone" hygiene (§16) | #9 | FE-only |
| 7 | **#1** "NEEDS YOU" lies about being resolved (§14/§22) | #1(part)/#8(part) | FE-only + tests |
| 8 | **#2** rename backend (§A5) | #3 | Backend + regen |
| 9 | **#2** rename affordance (§A5) | #3 | FE-only |
| 10 | **#2** name channel at creation (§A1) | #1 | FE-only |

**Deferred (documented at the end, NOT built here):** consult inheriting global CLAUDE.md (§C10, needs external-CLI behavior change), ambient nav-icon/titlebar badge (backlog #8, multi-surface), per-worker dismiss for gone workers (needs persistence — Task 6 grouping covers the legibility), the Activity-tab "N need you" double-count (report explicitly did not confirm it; note to reuse Task 7's helper if confirmed), and the `cdp-test-channels.mjs` selector-scoping harness bug (test-infra, optional).

**Execution ordering:** Tasks 1–7 and 9–10 all touch `channelssurface.tsx` and/or `channelrail.tsx`, so they must be executed **sequentially** (one subagent per task, review between) to avoid edit conflicts. Task 8 (Go backend) is file-disjoint and may run in parallel with any FE task, but Task 9 depends on Task 8's regenerated `RpcApi.RenameChannelCommand`. Recommended order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10.

---

## File Structure

**Modified — frontend:**
- `frontend/app/view/agents/channelsstore.ts` — add `setChannelTier` (T1), `renameChannel` (T9) helpers.
- `frontend/app/view/agents/channelssurface.tsx` — auto-scroll (T2), steer tag (T3), delegator guard (T5), fleet grouping (T6), needs-you filter (T7), rename/name wiring (T9/T10), use `setChannelTier` (T1).
- `frontend/app/view/agents/channelrail.tsx` — search input (T4), rename affordance (T9), name-at-creation (T10).
- `frontend/app/view/agents/channelderive.ts` — pure `filterChannels` (T4); rewrite `channelHasAsk` to share Task 7's logic (T7).
- `frontend/app/view/agents/jarviscards.ts` — pure `answeredAskORefs` + `pendingAsks` (T7).
- `frontend/app/view/agents/jarvisderive.ts` — add `askORef` to `WorkerState` (T7).

**Modified — frontend tests:**
- `frontend/app/view/agents/channelderive.test.ts` — `filterChannels` (T4).
- `frontend/app/view/agents/jarviscards.test.ts` — `answeredAskORefs` + `pendingAsks` (T7).
- `frontend/app/view/agents/jarvisderive.test.ts` — `askORef` population (T7).

**Modified — backend (T8):**
- `pkg/wshrpc/wshrpctypes.go` — `RenameChannelCommand` interface method + `CommandRenameChannelData` struct.
- `pkg/wshrpc/wshserver/wshserver.go` — `RenameChannelCommand` implementation.
- **Generated (do not hand-edit)** by `task generate`: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`.

---

## Verification conventions (all tasks)

- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — baseline is clean (exit 0). (`npx tsc` stack-overflows on this repo; do not use it.)
- **Unit tests:** `npx vitest run frontend/app/view/agents/<file>.test.ts`.
- **Visual (dev app):** the dev app must be running via `tail -f /dev/null | task dev` (headless `task dev` dies on stdin EOF). Capture with `node scripts/cdp-shot.mjs <out.png>`; drive DOM/keys over raw CDP on `:9222`. **Never** `Page.reload` — it breaks Tauri boot. If the dev app is not running, state that the visual step is unverified rather than claiming it passed.
- Do not commit; the user batches commits and approves them (see repo git policy).

---

## Task 1: Live rail badges refresh on tier change (report §A3 / backlog #2)

**Problem:** switching a channel's tier via the header dial (or rail context menu) doesn't update its rail badge until a full nav-tab-cycle, because the rail reads the `channelsAtom` snapshot and only `createChannel`/`deleteChannel` call `loadChannels()`. `SetChannelTierCommand` persists correctly but never refreshes the snapshot.

**Fix:** add a `setChannelTier` store helper that awaits the RPC then calls `loadChannels()` (identical pattern to create/delete), and route both tier call sites through it.

**Files:**
- Modify: `frontend/app/view/agents/channelsstore.ts`
- Modify: `frontend/app/view/agents/channelssurface.tsx:965-976` (rail `onSetTier`) and `:1021-1032` (header dial)

- [ ] **Step 1: Add `setChannelTier` to the store**

In `frontend/app/view/agents/channelsstore.ts`, after `deleteChannel` (ends line 66), add:

```ts
// Persist a channel's autonomy tier, then refresh the snapshot-fed rail so its badge updates
// immediately. The rail reads the channelsAtom snapshot (not live WOS), so a tier change is
// invisible until loadChannels() re-fetches — mirrors how create/delete already refresh.
export async function setChannelTier(channelId: string, tier: string, mode: string): Promise<void> {
    await RpcApi.SetChannelTierCommand(TabRpcClient, { channelid: channelId, tier, mode });
    await loadChannels();
}
```

- [ ] **Step 2: Route the rail context-menu tier switch through it**

In `channelssurface.tsx`, add `setChannelTier` to the existing import from `./channelsstore` (the block at lines 40-50). Then replace the `onSetTier` handler passed to `<ChannelRail>` (lines 965-976):

```tsx
                    onSetTier={(id, t) =>
                        fireAndForget(() =>
                            setChannelTier(
                                id,
                                t,
                                ((channels?.find((c) => c.oid === id)?.meta as Record<string, unknown> | undefined)?.[
                                    "delegator:mode"
                                ] as string) ?? "report"
                            )
                        )
                    }
```

- [ ] **Step 3: Route the header dial through it**

In `channelssurface.tsx`, replace the header-dial `onClick` (lines 1021-1032) so the tier button uses `setChannelTier`:

```tsx
                                            onClick={() =>
                                                fireAndForget(() =>
                                                    setChannelTier(
                                                        active.oid,
                                                        t,
                                                        ((active.meta as Record<string, unknown> | undefined)?.[
                                                            "delegator:mode"
                                                        ] as string) ?? "report"
                                                    )
                                                )
                                            }
```

(Note: Task 5 will further wrap the `delegator` branch of this same handler with a confirm. Do Task 1's plain swap now; Task 5 edits the same call site.)

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no new errors.

- [ ] **Step 5: Visual verify (dev app)**

With the dev app running: on a channel, switch its tier via the header dial from C→G. Confirm the rail badge for that row flips to `G` immediately, without leaving the Channels tab. Capture `scripts/cdp-shot.mjs` before/after. If the dev app is not running, mark this step unverified.

---

## Task 2: Transcript auto-scroll on new message (report §C9)

**Problem:** the transcript never scrolls to reveal a just-sent message; the viewport stays wherever it was, so a send looks like it did nothing.

**Fix:** ref the transcript scroll container; after messages change or the channel switches, scroll to the bottom when (a) the channel just switched, (b) the newest message is the user's own (`author === "you"`), or (c) the user was already near the bottom. Track near-bottom via an `onScroll` handler.

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (component `ChannelsSurface`, and the transcript `<div>` at line 1088)

- [ ] **Step 1: Add refs + scroll effect in `ChannelsSurface`**

In `channelssurface.tsx`, inside `ChannelsSurface`, just after the existing `idsKey`/entrance `useLayoutEffect` block (ends ~line 911), add:

```tsx
    // Auto-scroll the transcript: always on channel switch and on the user's own send; on an incoming
    // message only if the user was already near the bottom (standard chat behavior). Fixes the "my send
    // did nothing" confusion from the real-world report (§C9).
    const scrollRef = useRef<HTMLDivElement>(null);
    const nearBottomRef = useRef(true);
    const prevActiveRef = useRef<string | undefined>(undefined);
    const onTranscriptScroll = () => {
        const el = scrollRef.current;
        if (el) {
            nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }
    };
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        const channelChanged = prevActiveRef.current !== activeId;
        prevActiveRef.current = activeId;
        const last = shownMessages[shownMessages.length - 1];
        if (channelChanged || last?.author === "you" || nearBottomRef.current) {
            el.scrollTop = el.scrollHeight;
            nearBottomRef.current = true;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeId, idsKey]);
```

(`useRef` and `useLayoutEffect` are already imported at line 19.)

- [ ] **Step 2: Attach the ref + handler to the transcript container**

In `channelssurface.tsx`, the transcript scroll `<div>` at line 1088 currently reads:

```tsx
                        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-[22px]">
```

Change it to:

```tsx
                        <div
                            ref={scrollRef}
                            onScroll={onTranscriptScroll}
                            className="min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-[22px]"
                        >
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Visual verify (dev app)**

With the dev app running: scroll a populated channel up so the latest message is off-screen, then send a plain post. Confirm the transcript jumps to the bottom and the new message is visible. Then scroll up and simulate an incoming message (e.g. a consult reply) — confirm it does NOT yank the viewport unless you were near the bottom. Capture before/after. If dev app not running, mark unverified.

---

## Task 3: Steer directive gets a visible tag (report §C12)

**Problem:** a steer directive (`kind === "directive"`) renders identically to a plain human post — no badge — so once sent it's indistinguishable from an idle chat note. `MessageRow` only special-cases `kind === "dispatch"`.

**Fix:** add a muted `steer` tag for directive rows, mirroring the existing dispatch tag.

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`MessageRow`, lines 440-488)

- [ ] **Step 1: Tag directive rows**

In `MessageRow`, replace the derived flags + header tags. Change (line 452):

```tsx
    const isDispatch = msg.kind === "dispatch";
```

to:

```tsx
    const isDispatch = msg.kind === "dispatch";
    const isSteer = msg.kind === "directive";
```

Then in the header row (line 459), add the steer tag right after the dispatch tag:

```tsx
                    {isDispatch ? <Tag label="dispatch" tone="muted" /> : null}
                    {isSteer ? <Tag label="steer" tone="muted" /> : null}
                    {isDispatch && worker?.state === "asking" ? <Tag label="asking" tone="asking" /> : null}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Visual verify (dev app)**

With the dev app running: dispatch a worker, then steer it (`@<name> ...`). Confirm the sent directive row now shows a `STEER` badge and is visually distinct from a plain post. Capture. If dev app not running, mark unverified.

---

## Task 4: Wire up the channel search box (report §A2 / backlog #4)

**Problem:** the rail's "Search channels" box is a decorative `<div>` + `<span>`, not an input — no state, no filter.

**Fix:** extract a pure `filterChannels(channels, query)` helper (unit-tested), replace the decorative box with a real `<input>`, and render the filtered list.

**Files:**
- Modify: `frontend/app/view/agents/channelderive.ts`
- Test: `frontend/app/view/agents/channelderive.test.ts`
- Modify: `frontend/app/view/agents/channelrail.tsx`

- [ ] **Step 1: Write the failing test for `filterChannels`**

In `frontend/app/view/agents/channelderive.test.ts`, add (adjust the top-of-file import to include `filterChannels` from `./channelderive`):

```ts
describe("filterChannels", () => {
    const ch = (name: string): Channel => ({ oid: name, name, createdts: 0, messages: [] }) as unknown as Channel;
    const list = [ch("waveterm"), ch("cdp-flow"), ch("Wave-API")];
    it("returns the list unchanged for a blank query", () => {
        expect(filterChannels(list, "  ")).toHaveLength(3);
    });
    it("matches case-insensitively on a substring", () => {
        expect(filterChannels(list, "wave").map((c) => c.name)).toEqual(["waveterm", "Wave-API"]);
    });
    it("returns empty when nothing matches", () => {
        expect(filterChannels(list, "zzz")).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/channelderive.test.ts -t filterChannels`
Expected: FAIL — `filterChannels is not a function` / not exported.

- [ ] **Step 3: Implement `filterChannels`**

In `frontend/app/view/agents/channelderive.ts`, add near the top (after the imports, before `avatarColor`):

```ts
// Case-insensitive substring filter over channel names for the rail search box. A blank query returns
// the list unchanged.
export function filterChannels(channels: Channel[], query: string): Channel[] {
    const q = query.trim().toLowerCase();
    return q ? channels.filter((c) => c.name.toLowerCase().includes(q)) : channels;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/channelderive.test.ts -t filterChannels`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the real input into the rail**

In `frontend/app/view/agents/channelrail.tsx`:

1. Change the React import (line 10) to add `useMemo`:
```tsx
import { useMemo, useState } from "react";
```
2. Add `filterChannels` to the existing `./channelderive` import (line 12):
```tsx
import { channelHasAsk, filterChannels } from "./channelderive";
```
3. Inside `ChannelRail`, after the `confirmId` state (line 40), add:
```tsx
    const [query, setQuery] = useState("");
    const filtered = useMemo(() => filterChannels(channels ?? [], query), [channels, query]);
```
4. Replace the decorative search box (lines 43-48) with a real input:
```tsx
            <div className="border-b border-edge-faint px-3.5 py-3">
                <div className="flex items-center gap-2 rounded-[8px] border border-edge-mid bg-surface-raised px-2.5 py-1.5 text-muted focus-within:border-accent">
                    <span className="h-[11px] w-[11px] rounded-full border-[1.4px] border-current" />
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search channels"
                        className="w-full bg-transparent text-[12.5px] text-primary placeholder:text-muted focus:outline-none"
                    />
                </div>
            </div>
```
5. Change the channel list map (line 58) from `(channels ?? []).map((c) => {` to:
```tsx
                {filtered.map((c) => {
```

- [ ] **Step 6: Typecheck + full agents test run**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (expect exit 0), then `npx vitest run frontend/app/view/agents/channelderive.test.ts` (expect all PASS).

- [ ] **Step 7: Visual verify (dev app)**

With the dev app running: type into the search box; confirm the channel list filters live and clearing the box restores the full list. The "+ New channel" action stays visible below. Capture. If dev app not running, mark unverified.

---

## Task 5: Guard the step up to Delegator (report §B6 / backlog #6)

**Problem:** clicking the `delegator` segment on the header dial silently arms autonomous worker-spawning — no confirmation.

**Fix:** when the user clicks `delegator` while the channel is not already delegator, show an inline confirm bar instead of switching immediately; only "Enable" commits the tier. (Per-arming-transition confirm — no persistence; documented as such.)

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`ChannelsSurface` state + header dial region, lines 851-1043)

- [ ] **Step 1: Add confirm state + reset on channel switch**

In `channelssurface.tsx`, after `const [draft, setDraft] = useState("");` (line 851), add:

```tsx
    const [confirmDelegator, setConfirmDelegator] = useState(false);
```

Then in the existing `useEffect(() => { setView(defaultView(active)); }, [activeId])` (lines 872-875), add a reset so a stale confirm never carries across channels:

```tsx
    useEffect(() => {
        setView(defaultView(active));
        setConfirmDelegator(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeId]);
```

- [ ] **Step 2: Intercept the delegator click on the header dial**

In `channelssurface.tsx`, replace the header-dial `onClick` (the version left by Task 1, lines ~1021-1032) so the delegator step is gated:

```tsx
                                            onClick={() => {
                                                if (t === "delegator" && tier !== "delegator") {
                                                    setConfirmDelegator(true);
                                                    return;
                                                }
                                                fireAndForget(() =>
                                                    setChannelTier(
                                                        active.oid,
                                                        t,
                                                        ((active.meta as Record<string, unknown> | undefined)?.[
                                                            "delegator:mode"
                                                        ] as string) ?? "report"
                                                    )
                                                );
                                            }}
```

- [ ] **Step 3: Render the inline confirm bar**

In `channelssurface.tsx`, immediately after the closing `</div>` of the tier-dial control (the `div` that opens at line 1013 and closes at line 1042, inside the `active && view === "chat"` block), add the confirm bar so it sits in the header next to the dial:

```tsx
                            {active && view === "chat" && confirmDelegator ? (
                                <div className="flex flex-none items-center gap-2 rounded-[7px] border border-asking/50 bg-lane-asking px-2.5 py-1">
                                    <span className="font-mono text-[11px] text-ink-mid">
                                        Jarvis will spawn &amp; run workers on its own.
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setConfirmDelegator(false);
                                            fireAndForget(() =>
                                                setChannelTier(
                                                    active.oid,
                                                    "delegator",
                                                    ((active.meta as Record<string, unknown> | undefined)?.[
                                                        "delegator:mode"
                                                    ] as string) ?? "report"
                                                )
                                            );
                                        }}
                                        className="cursor-pointer rounded-[5px] border border-accent/50 bg-accentbg/40 px-2 py-0.5 font-mono text-[11px] text-accent-soft hover:bg-accentbg/60"
                                    >
                                        Enable
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setConfirmDelegator(false)}
                                        className="cursor-pointer rounded-[5px] px-2 py-0.5 font-mono text-[11px] text-muted hover:text-secondary"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            ) : null}
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Visual verify (dev app)**

With the dev app running: click `delegator` on a concierge/gatekeeper channel. Confirm (a) the tier does NOT change and the confirm bar appears; (b) "Cancel" dismisses it with no tier change; (c) clicking `delegator` again then "Enable" flips the tier to delegator and the placeholder updates to "Jarvis is managing this channel". Confirm clicking `concierge`/`gatekeeper` is still immediate (no confirm). Capture. If dev app not running, mark unverified.

---

## Task 6: Fleet-panel "gone" hygiene (report §16 / backlog #9)

**Problem:** the fleet section renders a flat list where finished ("gone") workers sit undifferentiated directly under "Fleet here · N working" — reads as a contradiction.

**Fix:** partition the snapshot into live (state !== "gone") and gone; render live rows first, then collapse gone rows under a "Done · N" disclosure (collapsed by default). (Per-worker dismiss is deferred — needs persistence; grouping resolves the legibility complaint.)

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`ContextPanel`, lines 719-840)

- [ ] **Step 1: Add disclosure state + partition in `ContextPanel`**

In `channelssurface.tsx`, inside `ContextPanel`, after `const counts = fleetCounts(snapshot);` (line 732), add:

```tsx
    const [showGone, setShowGone] = useState(false);
    const liveWorkers = snapshot.filter((w) => w.state !== "gone");
    const goneWorkers = snapshot.filter((w) => w.state === "gone");
```

(`useState` is already imported at line 19.)

- [ ] **Step 2: Rebuild the fleet section content**

In `channelssurface.tsx`, replace the `fleet` section's `content` (lines 781-792) with:

```tsx
            content: (
                <div>
                    <div className={label}>
                        Fleet here · {counts.working} working · {counts.waiting} waiting
                    </div>
                    {snapshot.length === 0 ? (
                        <p className="text-[11.5px] text-muted">No workers dispatched here yet.</p>
                    ) : (
                        <>
                            {liveWorkers.length === 0 ? (
                                <p className="text-[11.5px] text-muted">No active workers.</p>
                            ) : (
                                liveWorkers.map((w) => <WorkerRow key={w.oref} model={model} w={w} />)
                            )}
                            {goneWorkers.length > 0 ? (
                                <div className="mt-1">
                                    <button
                                        type="button"
                                        onClick={() => setShowGone((v) => !v)}
                                        className="mb-1.5 flex w-full cursor-pointer items-center gap-1.5 font-mono text-[10px] uppercase tracking-[.09em] text-muted hover:text-secondary"
                                    >
                                        <span>{showGone ? "▾" : "▸"}</span> Done · {goneWorkers.length}
                                    </button>
                                    {showGone ? goneWorkers.map((w) => <WorkerRow key={w.oref} model={model} w={w} />) : null}
                                </div>
                            ) : null}
                        </>
                    )}
                </div>
            ),
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Visual verify (dev app)**

With the dev app running: open a channel that has both a live worker and one or more gone workers. Confirm live workers render directly under the header, and gone workers are hidden behind a collapsed "Done · N" toggle that expands/collapses on click. Capture. If dev app not running, mark unverified.

---

## Task 7: "NEEDS YOU" excludes Jarvis-answered asks (report §14/§22 / backlog #1, #8) — TDD

**Problem (top finding):** an ask that Jarvis auto-answered (a `jarvis-answered` card exists) still shows in the fleet panel's "NEEDS YOU · 1" and lights the rail attention dot, because both derive purely from live worker `state === "asking"` and never consult whether Jarvis already resolved it.

**Fix:** carry the worker's current ask oref into the snapshot (`WorkerState.askORef`), add pure helpers `answeredAskORefs(messages)` and `pendingAsks(snapshot, messages)` that drop asks with a matching `jarvis-answered` card, and route both the "NEEDS YOU" panel and the rail dot (`channelHasAsk`) through `pendingAsks` so they share one source of truth. Matching is by the worker's *current* ask oref, so a brand-new ask from the same worker still surfaces.

**Files:**
- Modify: `frontend/app/view/agents/jarvisderive.ts`
- Test: `frontend/app/view/agents/jarvisderive.test.ts`
- Modify: `frontend/app/view/agents/jarviscards.ts`
- Test: `frontend/app/view/agents/jarviscards.test.ts`
- Modify: `frontend/app/view/agents/channelderive.ts` (`channelHasAsk`)
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`ContextPanel`)

- [ ] **Step 1: Write the failing tests for the pure helpers**

In `frontend/app/view/agents/jarviscards.test.ts`, extend the top import to include the two new helpers, and append:

```ts
const answeredCard = (askORef: string) =>
    JSON.stringify({ askORef, workerORef: "tab:x", question: "q", options: [{ label: "y" }], choice: 0 });

describe("answeredAskORefs", () => {
    it("collects askORefs from jarvis-answered cards only (not escalations)", () => {
        const msgs = [
            { id: "1", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: answeredCard("block:a") },
            { id: "2", kind: "jarvis-escalation", author: "jarvis", text: "", ts: 0, data: answeredCard("block:b") },
            { id: "3", kind: "human", author: "you", text: "hi", ts: 0 },
        ] as ChannelMessage[];
        const s = answeredAskORefs(msgs);
        expect(s.has("block:a")).toBe(true);
        expect(s.has("block:b")).toBe(false);
        expect(s.size).toBe(1);
    });
});

describe("pendingAsks", () => {
    const w = (askORef?: string, state = "asking") => ({ state, askORef, oref: "tab:x" });
    it("keeps an asking worker with no answered card", () => {
        expect(pendingAsks([w("block:a")], [] as ChannelMessage[])).toHaveLength(1);
    });
    it("drops an asking worker whose ask Jarvis already answered", () => {
        const msgs = [{ id: "1", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: answeredCard("block:a") }] as ChannelMessage[];
        expect(pendingAsks([w("block:a")], msgs)).toHaveLength(0);
    });
    it("keeps a NEW ask from a worker whose PREVIOUS ask was answered", () => {
        const msgs = [{ id: "1", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: answeredCard("block:old") }] as ChannelMessage[];
        expect(pendingAsks([w("block:new")], msgs)).toHaveLength(1);
    });
    it("ignores non-asking workers", () => {
        expect(pendingAsks([w("block:a", "working")], [] as ChannelMessage[])).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/jarviscards.test.ts -t "pendingAsks|answeredAskORefs"`
Expected: FAIL — `answeredAskORefs`/`pendingAsks` not exported.

- [ ] **Step 3: Implement the pure helpers**

In `frontend/app/view/agents/jarviscards.ts`, after `escalationPending` (ends line 62), add:

```ts
// The set of ask orefs Jarvis has already auto-answered in this channel (jarvis-answered cards).
export function answeredAskORefs(messages: ChannelMessage[]): Set<string> {
    const out = new Set<string>();
    for (const m of messages) {
        if (m.kind !== "jarvis-answered") {
            continue;
        }
        const card = parseCardData(m);
        if (card?.askORef) {
            out.add(card.askORef);
        }
    }
    return out;
}

// Workers genuinely blocked on the human: asking, and not already auto-answered by Jarvis. An ask Jarvis
// answered on the worker's behalf is Jarvis's to resume, not a "needs you" for the human — so it drops
// out even if the worker's live state is briefly still "asking". Matched by the worker's CURRENT ask
// oref, so a new ask from the same worker still surfaces. Generic over any {state, askORef}-shaped row.
export function pendingAsks<T extends { state: string; askORef?: string }>(
    snapshot: T[],
    messages: ChannelMessage[]
): T[] {
    const answered = answeredAskORefs(messages);
    return snapshot.filter((w) => w.state === "asking" && !(w.askORef && answered.has(w.askORef)));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/jarviscards.test.ts`
Expected: PASS (existing + 5 new tests).

- [ ] **Step 5: Add `askORef` to `WorkerState` + populate it**

In `frontend/app/view/agents/jarvisderive.ts`:

1. In the `WorkerState` interface (lines 10-17), add after `askText`:
```ts
    askORef?: string; // the worker's current ask oref (when asking), used to drop Jarvis-answered asks
```
2. In `buildFleetSnapshot`'s live branch (lines 43-51), add the field:
```tsx
        if (live) {
            return {
                oref,
                name: live.name,
                state: live.state,
                task: live.task || undefined,
                dispatchTask,
                askText: live.state === "asking" ? live.ask?.questions?.[0]?.question : undefined,
                askORef: live.state === "asking" ? live.ask?.oref : undefined,
            };
        }
```

- [ ] **Step 6: Write + run a test that the snapshot carries `askORef`**

In `frontend/app/view/agents/jarvisderive.test.ts`, add a case (adapt to the file's existing `AgentVM`/`Channel` fixture helpers already present in that file — reuse them; do not invent new shapes):

```ts
it("carries the live ask oref for an asking worker", () => {
    const channel = { name: "c", messages: [{ id: "d", kind: "dispatch", author: "claude", text: "go", reforef: "tab:w1", ts: 0 }] } as unknown as Channel;
    const agents = [{ id: "w1", name: "claude", state: "asking", task: "", ask: { oref: "block:ask1", questions: [{ question: "q?" }] } }] as unknown as AgentVM[];
    const snap = buildFleetSnapshot(channel, agents);
    expect(snap[0].askORef).toBe("block:ask1");
});
```

Run: `npx vitest run frontend/app/view/agents/jarvisderive.test.ts`
Expected: PASS.

- [ ] **Step 7: Route the "NEEDS YOU" panel through `pendingAsks`**

In `channelssurface.tsx`:

1. Add `pendingAsks` to the existing `./jarviscards` import (line 51):
```tsx
import { autonomyExplainer, escalationPending, fleetCounts, parseCardData, pendingAsks } from "./jarviscards";
```
2. In `ContextPanel`, replace `const asking = snapshot.filter((w) => w.state === "asking");` (line 731) with:
```tsx
    const asking = pendingAsks(snapshot, channel?.messages ?? []);
```

- [ ] **Step 8: Route the rail attention dot through the same logic**

In `frontend/app/view/agents/channelderive.ts`, rewrite `channelHasAsk` (lines 34-47) so the rail dot uses the same "genuinely needs you" definition (no separate copy of the rule):

1. Add imports near the top (after the existing `channelmessages` import at line 8):
```ts
import { buildFleetSnapshot } from "./jarvisderive";
import { pendingAsks } from "./jarviscards";
```
2. Replace the body of `channelHasAsk`:
```ts
// A channel is "waiting on you" when any worker it dispatched (or steered) is asking AND Jarvis has not
// already auto-answered that ask. Shares pendingAsks with the fleet panel so the rail dot and the
// "NEEDS YOU" count never disagree.
export function channelHasAsk(channel: Channel, agents: AgentVM[]): boolean {
    return pendingAsks(buildFleetSnapshot(channel, agents), channel.messages ?? []).length > 0;
}
```

(No import cycle: `channelderive` → `jarvisderive`/`jarviscards`; `jarviscards` → `channelmessages`; `jarvisderive` → `agentsviewmodel`.)

- [ ] **Step 9: Typecheck + full agents test suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (expect exit 0), then `npx vitest run frontend/app/view/agents/` (expect all PASS — confirm no existing `channelderive`/`jarviscards`/`jarvisderive` test regressed).

- [ ] **Step 10: Visual verify (dev app, best-effort)**

With the dev app running and a channel that has a `jarvis-answered` card whose worker is still in `asking` state (e.g. via the ask-injection path the report used): confirm the "NEEDS YOU" section and rail dot do NOT count that ask, while a genuinely-unanswered ask still does. Note: reproducing a live answered-but-asking state may be impractical over CDP — if so, rely on the unit tests and mark the visual step unverified with that reason.

---

## Task 8: RenameChannelCommand backend (report §A5 / backlog #3)

**Problem:** there is no backend command to rename a channel; without one there is no way to disambiguate same-project channels after creation.

**Fix:** add a `RenameChannelCommand` wshrpc command mirroring `SetChannelReadCommand`/`DeleteChannelCommand` (validate id + name, `DBUpdateFn` to set `ch.Name`, emit a WOS update), then regenerate bindings and rebuild the backend.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Generated: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts` (via `task generate` — do NOT hand-edit)

- [ ] **Step 1: Declare the command in the RPC interface**

In `pkg/wshrpc/wshrpctypes.go`, in the `WshRpcInterface`, add after the `SetChannelReadCommand` line (line 120):

```go
	RenameChannelCommand(ctx context.Context, data CommandRenameChannelData) error // renames a channel (its rail display name)
```

- [ ] **Step 2: Declare the command data struct**

In `pkg/wshrpc/wshrpctypes.go`, after `CommandSetChannelReadData` (ends line 763), add:

```go
type CommandRenameChannelData struct {
	ChannelId string `json:"channelid"`
	Name      string `json:"name"`
}
```

- [ ] **Step 3: Implement the server command**

In `pkg/wshrpc/wshserver/wshserver.go`, after `SetChannelReadCommand` (ends line 1743), add:

```go
func (ws *WshServer) RenameChannelCommand(ctx context.Context, data wshrpc.CommandRenameChannelData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	name := strings.TrimSpace(data.Name)
	if name == "" {
		return fmt.Errorf("name is required")
	}
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		ch.Name = name
	})
	if err != nil {
		return fmt.Errorf("renaming channel: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}
```

Confirm `strings` is imported in `wshserver.go` (it is used widely; if the import is somehow absent, add `"strings"` to the import block).

- [ ] **Step 4: Regenerate bindings**

Run: `task generate`
Expected: exit 0; `RpcApi.RenameChannelCommand` now appears in `frontend/app/store/wshclientapi.ts` and `RenameChannelCommand` in `pkg/wshrpc/wshclient/wshclient.go`. (Do not hand-edit these.)

Verify: `grep -n "RenameChannelCommand" frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go` returns hits in both.

- [ ] **Step 5: Build the backend**

Run: `task build:backend`
Expected: exit 0 (Go compiles with the new command). If the running dev app must pick up the new backend, restart `task dev` after this.

- [ ] **Step 6: Frontend typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (the generated `wshclientapi.ts` typechecks; no callers yet).

---

## Task 9: Rename affordance in the rail (report §A5 / backlog #3)

**Problem:** no rename UI exists anywhere (row, hover, context menu).

**Fix:** add a `renameChannel` store helper (RPC + `loadChannels()`), a "Rename channel" context-menu item, and an inline rename `<input>` on the row (commit on Enter/blur, cancel on Escape). Depends on Task 8's generated `RpcApi.RenameChannelCommand`.

**Files:**
- Modify: `frontend/app/view/agents/channelsstore.ts`
- Modify: `frontend/app/view/agents/channelrail.tsx`
- Modify: `frontend/app/view/agents/channelssurface.tsx` (pass the new prop)

- [ ] **Step 1: Add `renameChannel` to the store**

In `frontend/app/view/agents/channelsstore.ts`, after `setChannelTier` (from Task 1), add:

```ts
export async function renameChannel(channelId: string, name: string): Promise<void> {
    await RpcApi.RenameChannelCommand(TabRpcClient, { channelid: channelId, name });
    await loadChannels();
}
```

- [ ] **Step 2: Add the `onRenameChannel` prop + rename state to the rail**

In `frontend/app/view/agents/channelrail.tsx`:

1. Add to the `ChannelRail` props type (after `onSetTier`, line 37):
```tsx
    onRenameChannel: (id: string, name: string) => void;
```
2. Add `onRenameChannel` to the destructured params (after `onSetTier` at line 37 in the argument list).
3. After the `query`/`filtered` state (added in Task 4), add rename state:
```tsx
    const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
    const [renameDraft, setRenameDraft] = useState("");
```

- [ ] **Step 3: Add the context-menu "Rename channel" item**

In `channelrail.tsx`, in the `onContextMenu` menu array (lines 70-84), add a Rename item and a separator before "Delete channel":

```tsx
                                        {
                                            label: "Rename channel",
                                            click: () => {
                                                setRenameDraft(c.name);
                                                setRenamingId(c.oid);
                                            },
                                        },
                                        { type: "separator" },
                                        { label: "Delete channel", click: () => onDeleteChannel(c.oid) },
```

- [ ] **Step 4: Render the inline rename row (vs the normal button)**

In `channelrail.tsx`, wrap the existing row `<button>` (lines 90-134) so that when `renamingId === c.oid` an input row renders instead (an `<input>` must not live inside a `<button>`). Introduce `const renaming = renamingId === c.oid;` next to `const confirming = confirmId === c.oid;` (line 63), then:

```tsx
                            {renaming ? (
                                <div className="flex w-full items-center gap-2.5 rounded-[8px] bg-accentbg px-2.5 py-2">
                                    <span className="font-mono text-[13px] font-semibold text-accent">#</span>
                                    <input
                                        autoFocus
                                        value={renameDraft}
                                        onChange={(e) => setRenameDraft(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                                e.preventDefault();
                                                const n = renameDraft.trim();
                                                if (n && n !== c.name) {
                                                    onRenameChannel(c.oid, n);
                                                }
                                                setRenamingId(undefined);
                                            }
                                            if (e.key === "Escape") {
                                                e.preventDefault();
                                                setRenamingId(undefined);
                                            }
                                        }}
                                        onBlur={() => {
                                            const n = renameDraft.trim();
                                            if (n && n !== c.name) {
                                                onRenameChannel(c.oid, n);
                                            }
                                            setRenamingId(undefined);
                                        }}
                                        className="flex-1 rounded-[5px] border border-accent bg-surface px-1 text-[13px] text-primary focus:outline-none"
                                    />
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => onSelect(c.oid)}
                                    className={cn(
                                        "flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition-colors duration-[140ms]",
                                        active ? "bg-accentbg" : "hover:bg-surface-hover"
                                    )}
                                >
                                    {/* ...existing button children unchanged (# / name / unread / ask dot / tier chip)... */}
                                </button>
                            )}
```

Keep every child of the existing `<button>` exactly as-is inside the `) : (` branch. Also guard the delete-affordance overlay (lines 136-197) so it does not render while renaming — change its wrapper condition to only show when `!renaming` (e.g. wrap the whole overlay `<div>` in `{!renaming ? ( ... ) : null}`).

- [ ] **Step 5: Pass the prop from the surface**

In `frontend/app/view/agents/channelssurface.tsx`:
1. Add `renameChannel` to the `./channelsstore` import block (lines 40-50).
2. On `<ChannelRail>` (lines 955-977), add:
```tsx
                    onRenameChannel={(id, name) => fireAndForget(() => renameChannel(id, name))}
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 7: Visual verify (dev app — requires the Task 8 backend build)**

With the rebuilt dev app running: right-click a rail row → "Rename channel"; confirm the row becomes an input pre-filled with the current name; type a new name + Enter; confirm the rail row updates immediately and two same-project channels can now be told apart. Confirm Escape cancels. Capture. If dev app not running, mark unverified.

---

## Task 10: Name a channel at creation (report §A1 / backlog #1)

**Problem:** the "+ New channel" picker creates a channel named verbatim after the project — no way to give it a distinct name — so same-project channels always collide.

**Fix:** after a project is picked, show an inline "Channel name" input pre-filled with the project name; "Create" commits `onPickProject(editedName, path)`. (`pickProject` already calls `createChannel(name, path)`, so passing the edited name is all that's needed.)

> This is the "complete" fix for finding #2's root cause; Task 9's rename already gives after-the-fact disambiguation, so Task 10 is the lowest-priority item in the batch and may be dropped if the user wants to stop earlier.

**Files:**
- Modify: `frontend/app/view/agents/channelrail.tsx` (the `picking` block, lines 209-227)

- [ ] **Step 1: Add pending-project + name state**

In `channelrail.tsx`, after the rename state (Task 9), add:

```tsx
    const [pending, setPending] = useState<{ name: string; path: string } | null>(null);
    const [newName, setNewName] = useState("");
    // clear a half-finished pick when the picker closes, so reopening starts on the project list
    useEffect(() => {
        if (!picking) {
            setPending(null);
        }
    }, [picking]);
```

Change the React import to also bring in `useEffect`:
```tsx
import { useEffect, useMemo, useState } from "react";
```

- [ ] **Step 2: Add the two-step picker (project list → name input)**

In `channelrail.tsx`, replace the `picking` block (lines 209-227) with:

```tsx
                {picking ? (
                    <div className="mt-1 flex flex-col gap-1 px-1.5">
                        {pending ? (
                            <div className="flex flex-col gap-1.5 rounded-[7px] border border-border bg-surface-raised p-2">
                                <input
                                    autoFocus
                                    value={newName}
                                    onChange={(e) => setNewName(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            e.preventDefault();
                                            onPickProject(newName.trim() || pending.name, pending.path);
                                            setPending(null);
                                        }
                                        if (e.key === "Escape") {
                                            e.preventDefault();
                                            setPending(null);
                                        }
                                    }}
                                    placeholder="Channel name"
                                    className="rounded-[5px] border border-edge-mid bg-surface px-2 py-1 text-[12px] text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                                />
                                <div className="flex items-center gap-1.5">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            onPickProject(newName.trim() || pending.name, pending.path);
                                            setPending(null);
                                        }}
                                        className="cursor-pointer rounded-[5px] border border-accent/50 bg-accentbg/40 px-2 py-0.5 font-mono text-[11px] text-accent-soft hover:bg-accentbg/60"
                                    >
                                        Create
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setPending(null)}
                                        className="cursor-pointer rounded-[5px] px-2 py-0.5 font-mono text-[11px] text-muted hover:text-secondary"
                                    >
                                        Back
                                    </button>
                                    <span className="ml-auto truncate font-mono text-[10px] text-muted">in {pending.name}</span>
                                </div>
                            </div>
                        ) : (
                            <>
                                {Object.entries(projects).map(([name, p]) => (
                                    <button
                                        key={name}
                                        type="button"
                                        onClick={() => {
                                            setPending({ name, path: p?.path ?? "" });
                                            setNewName(name);
                                        }}
                                        className="cursor-pointer truncate rounded-[7px] border border-border bg-surface-raised px-2.5 py-1.5 text-left text-[12px] font-medium text-ink-mid hover:border-accent"
                                    >
                                        {name}
                                    </button>
                                ))}
                                {Object.keys(projects).length === 0 ? (
                                    <span className="px-1 text-[11px] text-muted">
                                        No projects — add one from the Cockpit “+ New project”.
                                    </span>
                                ) : null}
                            </>
                        )}
                    </div>
                ) : null}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Visual verify (dev app)**

With the dev app running: click "+ New channel" → pick a project → confirm the name input appears pre-filled with the project name; edit it to something distinct → "Create"; confirm a channel with the custom name is created and selected, and the rail no longer collides with a same-project channel. Confirm "Back" returns to the project list and Escape cancels. Capture. If dev app not running, mark unverified.

---

## Final verification (after all tasks)

- [ ] `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
- [ ] `npx vitest run frontend/app/view/agents/` → all PASS (new: `filterChannels`, `answeredAskORefs`, `pendingAsks`, snapshot `askORef`).
- [ ] `task build:backend` → exit 0.
- [ ] Re-read the 10 findings against the running dev app; note any that remain visually unverified (and why) rather than claiming them fixed.
- [ ] Update `docs/agents/channels-improvements.md` status lines for #1, #2, #3, #4, #6, #9 to reflect what shipped (and what's still deferred), so the backlog stays the single source of truth.

## Deferred (out of scope for this plan — rationale)

- **Consult padding from global CLAUDE.md (§C10):** consult shells out to a bare `claude -p` inheriting the operator's global config; skipping user-level scaffolding needs an external-CLI flag/env change with cross-runtime behavior risk. Recommend a separate spec, or documenting that consult inherits the full global config.
- **Ambient nav-icon/titlebar "need you" badge (backlog #8):** spans the left nav rail + titlebar (multiple surfaces outside the Channels tree); larger, separate change.
- **Per-worker dismiss for gone workers (backlog #9, second half):** needs persistence of dismissed state; Task 6's grouping resolves the reported legibility contradiction without it.
- **Activity-tab "N need you" double-count (§G22):** the report did not confirm the Activity counter double-counts resolved asks. If confirmed, reuse Task 7's `pendingAsks`/`answeredAskORefs` in the Activity counter's codepath (`activityevents.ts` / `activitydiscovery.ts`) rather than duplicating the rule. Do not change unverified behavior.
- **`cdp-test-channels.mjs` selector scoping (§C9 note):** test-infra reliability, not product; optional follow-up.

---

## Self-Review

- **Spec coverage:** report findings #1–#5 → Tasks 7, 8+9+10, 1, 5, 2; secondary steer → Task 3; verdict-table §A2/#4 → Task 4; §16/#9 → Task 6. Backlog #1→T9/T10, #2→T1, #3→T8/T9, #4→T4, #6→T5, #9→T6, #8(part)→T7. Deferrals explicitly listed with rationale. No in-scope finding is left without a task.
- **Placeholder scan:** every code step contains the actual code; no TBD/"handle errors"/"similar to". Test steps show real assertions.
- **Type consistency:** `setChannelTier(channelId, tier, mode)` / `renameChannel(channelId, name)` used identically at every call site; `RpcApi.RenameChannelCommand({channelid, name})` matches `CommandRenameChannelData{ChannelId, Name}`; `WorkerState.askORef` populated in `jarvisderive.ts` and consumed by `pendingAsks`; `pendingAsks(snapshot, messages)` signature identical in `channelssurface.tsx` and `channelderive.ts`.
