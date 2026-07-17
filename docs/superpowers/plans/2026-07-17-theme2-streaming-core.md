# Theme 2: Live-transcript streaming core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the confirmed reconnect-freeze bug (streams never resume after a websocket drop) and refactor the live-transcript render/growth path so per-chunk and per-second cost stops scaling with fleet size and session length.

**Architecture:** Two slices. **S1** makes transcript streams restartable on the client (extend `StreamHandle`, register a reconnect handler that stops+reopens active streams) and cancels the leaked server-side goroutine+watcher when the originating websocket connection tears down (a new `WshRpc.CancelRequestsForLink`, called from `pkg/web/ws.go`). **S2** pushes jotai subscriptions down to per-id slices (`atomFamily` + `selectAtom` over the existing whole-map atoms), memoizes the hot components, bounds the retained-lines projection window, clears per-id atoms on stream stop, and consolidates the three 1-second `nowAtom` tickers to a single owner with leaf-level `now` consumption.

**Tech Stack:** React 19, jotai 2.9.3 (`jotai/utils` — `atomFamily`, `selectAtom`, already-used `atomWithStorage`), Vite, Tailwind 4, vitest (frontend), Go (`pkg/wshutil`, `pkg/web`, `pkg/wshrpc/wshserver`), fsnotify.

**Design source:** `docs/superpowers/briefs/2026-07-17-theme2-streaming-core-brief.md` serves as the approved spec. This plan records the decisions the brief left to downstream verification, resolved by a three-lane recon pass (see "Resolved decisions" below). Raw scan evidence: `docs/deferred.md` §"Net-new improvement scan (2026-07-17)" Theme 2.

## Global Constraints

- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows). Baseline is exit 0 — any error it reports is yours.
- **Never hand-edit generated files** (`wshclientapi.ts`, generated Go/TS types). No wshrpc protocol shape changes are needed in this slice, so `task generate` should not be required. If a Go type in `pkg/wshrpc` changes, run `task generate`.
- **No new SCSS.** Colors come from `@theme` tokens in `tailwindsetup.css`; never raw hex/rgba. This slice adds no new colors.
- **Frontend unit tests:** `npx vitest run <file>` or `npx vitest run -t "<name>"`. Go tests: `go test ./pkg/...`.
- **No jsdom/render-test harness exists for the cockpit.** React re-render-count behavior is verified via CDP against the live dev app (`node scripts/cdp-shot.mjs`, populate with `node scripts/inject-live-agents.mjs`), not vitest. Pure logic (projection, selection, atom drop-on-stop) IS unit-tested.
- **Non-goals (do not scope-creep into these):** no wshrpc protocol change; no resume-by-offset (client re-tails on reconnect); no change to transcript projection *output* (only how/when it runs); no light-mode work.
- **Commit discipline:** one commit per task (or logical sub-group), TDD order. Do not commit or push beyond the plan without approval. No co-author line.

## Resolved decisions (from recon — these override open questions in the brief)

1. **S1 server-cancel: DO IT (proper fix, not client-only).** `pkg/web/ws.go` has a deterministic per-connection teardown (`unregisterConn` → `DefaultRouter.UnregisterLink(LinkId)` on socket close), and every in-flight RPC already carries its originating websocket's `ingressLinkId` (`wshrpc.go:347`, getter `GetIngressLinkId()` `:658`). The transcript RPC terminates at the process-global `wshserver.GetMainRpcClient()`. Only the wiring from teardown → ctx-cancel is missing. `pkg/web` already imports `wshserver` (no import cycle). `RpcResponseHandler.close()` (`wshrpc.go:737-744`) invokes the stored `contextCancelFn`; for a streaming handler that fires the `<-ctx.Done() → Finalize()` async path (`wshrpc.go:359-374`), reclaiming the goroutine + fsnotify watcher.
2. **Restart race (must guard).** A stale generator's `finally { streams.delete(id) }` (`livetranscript.ts:69-71`) can delete a freshly-restarted handle. `startTranscriptStream` must capture its own handle and only delete-on-finally if `streams.get(id)` is still that handle.
3. **`reconnectHandlers` is an array with no dedup** (`ws.ts:12`), fired on *every* `onopen` (initial connect + every reconnect). The restart handler must (a) tolerate zero active streams, (b) be registered exactly once (guard against HMR re-registration).
4. **Per-id subscription mechanism: `atomFamily` + `selectAtom`** from `jotai/utils`, layered over the existing whole-map `Record` atoms (kept as the single write target — single source of truth). No `atomFamily`/`selectAtom` precedent exists in the repo; this introduces the minimal idiomatic one. `atomFamily` entries are `.remove(id)`d on stream stop to bound the cache.
5. **Bounded projection: capped retained-lines window** (uniform for both the Claude and Codex projectors, zero projector-internal changes, preserves all existing projection test coverage). Incremental stateful projection is a possible future optimization if the capped re-project still profiles hot — noted, not built (YAGNI).
6. **Per-card-unmount server leak is a documented follow-up, not in scope.** The client's `gen.return()` on unmount never sends a wire cancel, and `WshRpc.cancelRequest` only sets a bool (`wshrpc.go:266-277`) — so a card unmounted while the connection stays up leaks its watcher until the connection drops (when `CancelRequestsForLink` reaps it) or the 1-year timeout. Fixing this cleanly requires changing shared RPC cancellation semantics (higher blast radius). Recorded in `docs/deferred.md` at the end of this slice.
7. **Ticker: single owner.** One always-mounted ticker writes `model.nowAtom`; the three per-surface `setInterval`s are removed; `now` is read only by leaf age/quiet components so no surface reconciles every second.

---

## S1 — Reconnect freeze (confirmed correctness bug)

### Task 1: Client — restartable streams + restart on reconnect

**Files:**
- Modify: `frontend/app/view/agents/livetranscript.ts`
- Test: `frontend/app/view/agents/livetranscript.test.ts` (create)

**Interfaces:**
- Consumes: `addWSReconnectHandler(handler: () => void)` exported from `@/app/store/ws`; `RpcApi.StreamAgentTranscriptCommand`, `TabRpcClient`, `globalStore` (existing imports).
- Produces: `StreamHandle` gains `path: string` and `agent?: string`. New exported `restartActiveStreams(): void`. `startTranscriptStream`/`stopTranscriptStream` signatures unchanged.

- [ ] **Step 1: Write the failing test** — `frontend/app/view/agents/livetranscript.test.ts`

Mock the RPC so `StreamAgentTranscriptCommand` returns a controllable async generator whose `return()` is observable, and assert restart re-opens every active id and survives a late stale-generator finish. (Mock paths — `@/app/store/wshclientapi`, `@/app/store/global`, `@/app/store/ws`, `./transcriptregistry` — must resolve against the real modules; adjust import specifiers to match the actual files if vitest cannot resolve them.)

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const returned: string[] = [];
let openCount = 0;
// a generator that blocks until we release it, and records return()
function makeGen() {
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gen: any = {
        async next() {
            await gate; // never yields a chunk in this test; simulates a live-but-quiet stream
            return { value: undefined, done: true };
        },
        async return(v: any) {
            returned.push("returned");
            release!();
            return { value: v, done: true };
        },
        [Symbol.asyncIterator]() {
            return this;
        },
    };
    return gen;
}

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        StreamAgentTranscriptCommand: vi.fn(() => {
            openCount++;
            return makeGen();
        }),
    },
}));
vi.mock("@/app/store/global", () => {
    const store = new Map<any, any>();
    return {
        globalStore: {
            get: (a: any) => store.get(a) ?? {},
            set: (a: any, v: any) => store.set(a, v),
        },
        TabRpcClient: {},
    };
});
const reconnectHandlers: (() => void)[] = [];
vi.mock("@/app/store/ws", () => ({
    addWSReconnectHandler: (h: () => void) => reconnectHandlers.push(h),
}));
vi.mock("./transcriptregistry", () => ({
    projectorFor: () => ({ project: (l: string[]) => [], extractTasks: () => undefined }),
}));

afterEach(() => {
    returned.length = 0;
    openCount = 0;
    reconnectHandlers.length = 0;
    vi.clearAllMocks();
});

describe("restartActiveStreams", () => {
    it("re-opens every active stream and returns the old generators", async () => {
        const { startTranscriptStream, restartActiveStreams } = await import("./livetranscript");
        startTranscriptStream("a", "/p/a", "claude");
        startTranscriptStream("b", "/p/b", "claude");
        expect(openCount).toBe(2);
        restartActiveStreams();
        // old two returned, two new opens
        expect(returned.length).toBe(2);
        expect(openCount).toBe(4);
    });
});
```

> Note: the exact projector-registry export name (`projectorFor` vs the current registry accessor) and the `globalStore`/`TabRpcClient` import specifiers must match `livetranscript.ts`'s real imports. Read the file first and mock exactly what it imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/livetranscript.test.ts`
Expected: FAIL — `restartActiveStreams` is not exported yet.

- [ ] **Step 3: Implement** — edit `frontend/app/view/agents/livetranscript.ts`

(3a) Extend the handle to carry restart inputs and capture identity in the finally guard:

```ts
interface StreamHandle {
    stop: () => void;
    path: string;
    agent?: string;
}
```

(3b) In `startTranscriptStream`, register the handle object by reference and guard the finally-delete so a stale loop can't clobber a restarted handle:

```ts
export function startTranscriptStream(id: string, path: string, agent?: string): void {
    if (!path || streams.has(id)) {
        return;
    }
    let cancelled = false;
    const gen = RpcApi.StreamAgentTranscriptCommand(
        TabRpcClient,
        { path, taillines: STREAM_TAIL_LINES },
        { timeout: STREAM_TIMEOUT_MS }
    );
    const handle: StreamHandle = {
        path,
        agent,
        stop: () => {
            cancelled = true;
            void gen.return?.(undefined);
        },
    };
    streams.set(id, handle);
    void (async () => {
        const lines: string[] = [];
        try {
            for await (const chunk of gen) {
                if (cancelled) break;
                // ... existing chunk-accumulation body unchanged ...
            }
        } catch {
            // stream ended or errored — keep the last entries, just stop updating
        } finally {
            if (streams.get(id) === handle) {
                streams.delete(id);
            }
        }
    })();
}
```

(Preserve the existing chunk body — `lines.push`, `project(lines)`, the three `globalStore.set(...)` writes — exactly as-is. Only the handle shape and the finally-guard change here.)

(3c) Add the restart function and register it once at module load:

```ts
// On a websocket reconnect the old generators are hung (a socket drop never errored/returned them),
// and useCardStreams won't re-drive start (its wanted-set is unchanged). Stop every active stream and
// re-open it; the fresh startTranscriptStream re-tails STREAM_TAIL_LINES (a small, acceptable catch-up).
export function restartActiveStreams(): void {
    const active = [...streams.entries()].map(([id, h]) => ({ id, path: h.path, agent: h.agent }));
    for (const { id } of active) {
        stopTranscriptStream(id);
    }
    for (const { id, path, agent } of active) {
        startTranscriptStream(id, path, agent);
    }
}

let reconnectRegistered = false;
if (!reconnectRegistered) {
    reconnectRegistered = true;
    addWSReconnectHandler(restartActiveStreams);
}
```

Add `import { addWSReconnectHandler } from "@/app/store/ws";` (verify the export path — `addWSReconnectHandler` is exported from `frontend/app/store/ws.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/livetranscript.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/livetranscript.ts frontend/app/view/agents/livetranscript.test.ts
git commit -m "fix(agents): restart transcript streams on websocket reconnect (S1 client)"
```

---

### Task 2: Server — cancel streaming RPCs when the websocket connection closes

**Files:**
- Modify: `pkg/wshutil/wshrpc.go` (add `CancelRequestsForLink`)
- Modify: `pkg/web/ws.go` (call it from `unregisterConn`)
- Test: `pkg/wshutil/wshrpc_cancel_test.go` (create)

**Interfaces:**
- Consumes: `RpcResponseHandler.GetIngressLinkId() baseds.LinkId`, `RpcResponseHandler.close()`, `WshRpc.ResponseHandlerMap`, `WshRpc.Lock` (all existing in `wshrpc.go`); `wshserver.GetMainRpcClient() *wshutil.WshRpc`.
- Produces: `func (w *WshRpc) CancelRequestsForLink(linkId baseds.LinkId)`.

- [ ] **Step 1: Write the failing test** — `pkg/wshutil/wshrpc_cancel_test.go`

Construct a `WshRpc` with two response handlers on different ingress links, cancel one link, assert only its ctx is cancelled and its handler done. (Use the real `WshRpc`/`RpcResponseHandler` fields; if a constructor like `MakeWshRpc` is required to init `Lock`/`ResponseHandlerMap`, use it, otherwise build the minimal struct.)

```go
package wshutil

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/util/waveutil/baseds"
)

func mkHandler(w *WshRpc, reqId string, link baseds.LinkId) (*RpcResponseHandler, context.Context) {
	ctx, cancel := context.WithCancel(context.Background())
	h := &RpcResponseHandler{
		w:               w,
		ctx:             ctx,
		reqId:           reqId,
		ingressLinkId:   link,
		done:            &atomic.Bool{},
		canceled:        &atomic.Bool{},
		contextCancelFn: &atomic.Pointer[context.CancelFunc]{},
	}
	cf := context.CancelFunc(cancel)
	h.contextCancelFn.Store(&cf)
	return h, ctx
}

func TestCancelRequestsForLink(t *testing.T) {
	w := &WshRpc{ResponseHandlerMap: map[string]*RpcResponseHandler{}}
	hA, ctxA := mkHandler(w, "rA", baseds.LinkId("L1"))
	hB, ctxB := mkHandler(w, "rB", baseds.LinkId("L2"))
	w.ResponseHandlerMap["rA"] = hA
	w.ResponseHandlerMap["rB"] = hB

	w.CancelRequestsForLink(baseds.LinkId("L1"))

	select {
	case <-ctxA.Done():
	default:
		t.Fatal("expected L1 handler ctx to be cancelled")
	}
	select {
	case <-ctxB.Done():
		t.Fatal("L2 handler ctx should NOT be cancelled")
	default:
	}
	if !hA.done.Load() {
		t.Fatal("expected L1 handler done")
	}
}
```

> Verify the real import path for `baseds.LinkId` (recon cited `github.com/wavetermdev/waveterm/pkg/baseds` in `ws.go` imports — use whatever `wshrpc.go` itself imports) and the exact `RpcResponseHandler` field set. Adjust the struct literal to match.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/wshutil/ -run TestCancelRequestsForLink`
Expected: FAIL — `CancelRequestsForLink` undefined.

- [ ] **Step 3: Implement `CancelRequestsForLink`** in `pkg/wshutil/wshrpc.go` (near `cancelRequest`, ~line 277)

Collect matching handlers under the lock, then `close()` them *outside* the lock (a streaming handler's cancel triggers an async `Finalize()` that re-acquires `w.Lock` via `unregisterResponseHandler` — closing under the lock would deadlock).

```go
// CancelRequestsForLink cancels the context of every in-flight response handler whose request
// entered on the given link. Used to reclaim streaming RPCs (goroutine + fsnotify watcher) when the
// originating websocket connection tears down. close() invokes the handler's contextCancelFn, which
// for a streaming handler fires its <-ctx.Done() finalize path.
func (w *WshRpc) CancelRequestsForLink(linkId baseds.LinkId) {
	w.Lock.Lock()
	handlers := make([]*RpcResponseHandler, 0)
	for _, h := range w.ResponseHandlerMap {
		if h.GetIngressLinkId() == linkId {
			handlers = append(handlers, h)
		}
	}
	w.Lock.Unlock()
	for _, h := range handlers {
		h.close()
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/wshutil/ -run TestCancelRequestsForLink`
Expected: PASS.

- [ ] **Step 5: Wire the call site** in `pkg/web/ws.go` `unregisterConn` (lines 239-251). After `UnregisterLink`, cancel the RPCs that entered on that link:

```go
func unregisterConn(wsConnId string, stableId string) {
	GlobalLock.Lock()
	defer GlobalLock.Unlock()
	curConnInfo := RouteToConnMap[stableId]
	if curConnInfo == nil || curConnInfo.ConnId != wsConnId {
		log.Printf("[websocket] warning: trying to unregister connection %q for stableid %q but it is not the current connection (ignoring)\n", wsConnId, stableId)
		return
	}
	delete(RouteToConnMap, stableId)
	if curConnInfo.LinkId != baseds.NoLinkId {
		wshutil.DefaultRouter.UnregisterLink(curConnInfo.LinkId)
		// reclaim streaming RPCs (e.g. StreamAgentTranscript) that entered on this connection —
		// their server ctx is a 1-year timeout with no other cancel, so they leak on drop otherwise.
		wshserver.GetMainRpcClient().CancelRequestsForLink(curConnInfo.LinkId)
	}
}
```

Add `"github.com/wavetermdev/waveterm/pkg/wshrpc/wshserver"` to `ws.go` imports (no cycle: `pkg/web` already imports `wshserver` in `webvdomproto.go`).

- [ ] **Step 6: Build the backend**

Run: `go build ./pkg/... ./cmd/...`
Expected: exit 0 (no import cycle, no unused import).

- [ ] **Step 7: Commit**

```bash
git add pkg/wshutil/wshrpc.go pkg/wshutil/wshrpc_cancel_test.go pkg/web/ws.go
git commit -m "fix(wshrpc): cancel streaming RPCs on websocket connection close (S1 server leak)"
```

---

## S2 — Render/growth cost (full refactor)

### Task 3: Per-id atom slices + drop-on-stop clearing

**Files:**
- Create: `frontend/app/view/agents/livetranscriptatoms.ts` (the per-id read atoms + a helper to drop an id)
- Modify: `frontend/app/view/agents/livetranscript.ts` (drop-on-stop clearing; call the drop helper)
- Test: `frontend/app/view/agents/livetranscriptatoms.test.ts` (create)

**Interfaces:**
- Consumes: `liveEntriesByIdAtom`, `lastActivityByIdAtom`, `tasksByIdAtom` from `./livetranscript`; `AgentEntry`, `CardTask` types.
- Produces:
  - `entriesAtomFor(id: string): Atom<AgentEntry[]>`
  - `activityAtomFor(id: string): Atom<number | undefined>`
  - `tasksAtomFor(id: string): Atom<CardTask[] | undefined>`
  - `dropLiveId(id: string): void` — deletes the id from all three whole-map atoms AND removes the three `atomFamily` entries.
- `stopTranscriptStream` now calls `dropLiveId(id)` after stopping.

- [ ] **Step 1: Write the failing test** — `frontend/app/view/agents/livetranscriptatoms.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { liveEntriesByIdAtom, lastActivityByIdAtom, tasksByIdAtom } from "./livetranscript";
import { entriesAtomFor, activityAtomFor, dropLiveId } from "./livetranscriptatoms";

describe("per-id atom slices", () => {
    it("reads the id's slice and is referentially stable when an unrelated id changes", () => {
        const store = createStore();
        store.set(liveEntriesByIdAtom, { a: [{ kind: "message", index: 0, text: "hi" } as any], b: [] });
        const aAtom = entriesAtomFor("a");
        const before = store.get(aAtom);
        // mutate only b's slice (new whole-map object, a's array reference preserved)
        store.set(liveEntriesByIdAtom, { ...store.get(liveEntriesByIdAtom), b: [{ kind: "message", index: 1, text: "x" } as any] });
        const after = store.get(aAtom);
        expect(after).toBe(before); // a's slice unchanged by reference -> selectAtom will not re-render a
    });

    it("dropLiveId removes the id from all whole-map atoms", () => {
        const store = createStore();
        store.set(liveEntriesByIdAtom, { a: [], b: [] });
        store.set(lastActivityByIdAtom, { a: 1, b: 2 });
        store.set(tasksByIdAtom, { a: [], b: [] });
        dropLiveId("a", store);
        expect("a" in store.get(liveEntriesByIdAtom)).toBe(false);
        expect("a" in store.get(lastActivityByIdAtom)).toBe(false);
        expect("a" in store.get(tasksByIdAtom)).toBe(false);
        expect("b" in store.get(liveEntriesByIdAtom)).toBe(true);
    });
});
```

> `dropLiveId` takes an optional store param for testability (defaults to `globalStore`). If `selectAtom`'s default `Object.is` equality does not preserve reference on the unchanged slice with your write pattern, that is the signal the write path must keep unchanged slices by reference (it already spreads + replaces only `[id]`, so it does).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/livetranscriptatoms.test.ts`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Implement** — `frontend/app/view/agents/livetranscriptatoms.ts`

```ts
import { globalStore } from "@/app/store/global";
import type { Atom, createStore } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import { lastActivityByIdAtom, liveEntriesByIdAtom, tasksByIdAtom } from "./livetranscript";

const EMPTY_ENTRIES: AgentEntry[] = [];

const entriesFamily = atomFamily((id: string) =>
    selectAtom(liveEntriesByIdAtom, (m) => m[id] ?? EMPTY_ENTRIES)
);
const activityFamily = atomFamily((id: string) => selectAtom(lastActivityByIdAtom, (m) => m[id]));
const tasksFamily = atomFamily((id: string) => selectAtom(tasksByIdAtom, (m) => m[id]));

export const entriesAtomFor = (id: string): Atom<AgentEntry[]> => entriesFamily(id);
export const activityAtomFor = (id: string): Atom<number | undefined> => activityFamily(id);
export const tasksAtomFor = (id: string): Atom<CardTask[] | undefined> => tasksFamily(id);

type Store = ReturnType<typeof createStore>;

// Clear an id from every per-id map on stream stop/unmount (unbounded retention otherwise) and drop
// its atomFamily entries so the derived-atom cache stays bounded.
export function dropLiveId(id: string, store: Store = globalStore): void {
    for (const a of [liveEntriesByIdAtom, lastActivityByIdAtom, tasksByIdAtom]) {
        const cur = store.get(a) as Record<string, unknown>;
        if (id in cur) {
            const next = { ...cur };
            delete next[id];
            store.set(a as any, next);
        }
    }
    entriesFamily.remove(id);
    activityFamily.remove(id);
    tasksFamily.remove(id);
}
```

(Import `AgentEntry`/`CardTask` from wherever `livetranscript.ts` sources them — likely `@/app/view/agents/...` types. Verify.)

- [ ] **Step 4: Wire drop-on-stop** in `livetranscript.ts` `stopTranscriptStream`:

```ts
export function stopTranscriptStream(id: string): void {
    const handle = streams.get(id);
    if (!handle) {
        return;
    }
    handle.stop();
    streams.delete(id);
    dropLiveId(id);
}
```

Add `import { dropLiveId } from "./livetranscriptatoms";`.

> Beware a circular import (`livetranscript` ↔ `livetranscriptatoms`): `livetranscriptatoms` imports the *atoms* from `livetranscript`, and `livetranscript` imports `dropLiveId`. ES module cycles resolve fine here because both are used at call-time, not module-eval-time — but if bundling complains, move the three atom *definitions* into `livetranscriptatoms.ts` and have `livetranscript.ts` import them from there (atoms as the shared leaf module). Prefer that layout if any cycle warning appears.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run frontend/app/view/agents/livetranscriptatoms.test.ts` → PASS
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/livetranscriptatoms.ts frontend/app/view/agents/livetranscriptatoms.test.ts frontend/app/view/agents/livetranscript.ts
git commit -m "perf(agents): per-id transcript atom slices + drop-on-stop clearing (S2)"
```

---

### Task 4: Migrate card consumers to per-id subscriptions

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx` (253-254, 269)
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx` (55)
- Modify: `frontend/app/view/agents/runworkercard.tsx` (30-32 and `PhaseHistory`/`RunRollup` if they slice per-id)

**Interfaces:**
- Consumes: `entriesAtomFor`, `activityAtomFor`, `tasksAtomFor` from `./livetranscriptatoms`.
- Produces: no new exports. Each consumer reads only its own id's slice instead of the whole map.

Rationale: a chunk for agent X rewrites the whole map atom; whole-map subscribers all re-render. Reading `entriesAtomFor(agent.id)` re-renders only X's card (selectAtom returns the same reference for unchanged ids).

- [ ] **Step 1: Edit `agentrow.tsx`** — replace whole-map reads with per-id atoms.

Before (253-255, 269):
```ts
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    ...
    const tasks = useAtomValue(tasksByIdAtom)[agent.id];
```
After:
```ts
    const liveEntries = useAtomValue(entriesAtomFor(agent.id));
    const lastActivityStamp = useAtomValue(activityAtomFor(agent.id));
    const entries = liveEntries.length > 0 ? liveEntries : agent.previousInfo ?? [];
    ...
    const tasks = useAtomValue(tasksAtomFor(agent.id));
```
Update the `quiet` line (257) to use the per-id stamp: `const quiet = isQuiet(lastActivityStamp, now);` (the `now` decoupling itself lands in Task 5). Update imports: drop `liveEntriesByIdAtom`/`lastActivityByIdAtom`/`tasksByIdAtom` from the `./livetranscript` import if no longer used; add `entriesAtomFor, activityAtomFor, tasksAtomFor` from `./livetranscriptatoms`.

- [ ] **Step 2: Edit `agentdetailsrail.tsx:55`** — `const liveEntries = useAtomValue(liveEntriesByIdAtom);` → read the focused agent's slice via `entriesAtomFor(agent.id)` (adjust the `[agent.id]` index-out that follows).

- [ ] **Step 3: Edit `runworkercard.tsx:30-32`** — replace the three whole-map reads with the per-id atoms for the worker's id. If `PhaseHistory`/`RunRollup` (same file) aggregate across multiple ids, leave them on the whole map (they genuinely need it) but confirm they are not in the per-chunk hot path for a single card; note any that remain whole-map.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Behavioral check (CDP)** — with the dev app running and `scripts/inject-live-agents.mjs` populated, confirm a card still shows live narration + task chip + quiet state (no functional regression). Full render-count validation is Task 10.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/agentrow.tsx frontend/app/view/agents/agentdetailsrail.tsx frontend/app/view/agents/runworkercard.tsx
git commit -m "perf(agents): subscribe cards to per-id transcript slices (S2)"
```

---

### Task 5: Isolate surface reconcile + memoize the card

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (90, 166-168, and the `<AgentRow now={now} .../>` call site)
- Modify: `frontend/app/view/agents/agentrow.tsx` (`AgentRow` export → `React.memo`; remove `now` prop; leaf quiet/age)
- Create: `frontend/app/view/agents/recentactivityrail.tsx` (extracted self-subscribing recent-activity component) — *only if* CockpitSurface reads the maps solely to build recent activity; otherwise inline-isolate.

**Interfaces:**
- Consumes: `entriesAtomFor`/`activityAtomFor` (Task 3), `model.nowAtom`.
- Produces: `AgentRow` no longer takes a `now` prop. A leaf `now` consumer (small `useAtomValue(model.nowAtom)` in a quiet/age indicator) replaces the prop-drilled `now`.

Rationale: two re-render triggers remain after Task 4 — (B) the 1s tick and CockpitSurface's own whole-map + `nowAtom` reads. Memoizing `AgentRow` is only effective if its props are stable across a sibling's chunk and across ticks; the `now` prop breaks that every second, and CockpitSurface re-rendering per chunk re-creates props.

- [ ] **Step 1: Decouple `now` from `AgentRow`.** Trace every use of the `now` prop in `agentrow.tsx` (recon: line 257 `isQuiet(lastActivity[agent.id], now)`; check for others). Replace prop-drilled `now` with a leaf that reads the atom where the value is actually rendered. Minimal approach: compute `quiet` in a tiny child that subscribes to `model.nowAtom` itself, e.g.:

```tsx
function QuietGate({ agentId, children }: { agentId: string; children: (quiet: boolean) => React.ReactNode }) {
    const now = useAtomValue(model.nowAtom);
    const stamp = useAtomValue(activityAtomFor(agentId));
    return <>{children(isQuiet(stamp, now))}</>;
}
```
or, if `quiet` only toggles a leaf visual, inline a `<QuietDot agentId={agent.id} />`. Remove `now` from `AgentRow`'s params and its type. Remove the `now` read from any code path that would otherwise force a full-card re-render each second.

- [ ] **Step 2: Memoize `AgentRow`.** Change `export function AgentRow(...)` to a memoized export:
```tsx
export const AgentRow = React.memo(function AgentRow({ ... }: {...}) { ... });
```
Ensure all callback props passed from CockpitSurface (`onCursor`, `onOpen`, …) are `useCallback`-stable, and `agent`/`rect`/motion-values identities are stable across an unrelated chunk. If any handler is re-created per render in CockpitSurface, wrap it in `useCallback`.

- [ ] **Step 3: Stop CockpitSurface reconciling per chunk / per second.** Remove `const now = useAtomValue(model.nowAtom);` (90) and the whole-map reads (166-167) from `CockpitSurface`'s body. Move `buildRecentActivity` into a self-subscribing child (`RecentActivityRail`) that reads `liveEntriesByIdAtom`/`lastActivityByIdAtom` + `model.nowAtom` internally and renders the recent list, so only that child re-renders on a chunk/tick — not the grid. Remove the `now={now}` prop from the `<AgentRow .../>` call.

- [ ] **Step 4: Typecheck + existing tests.**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0
Run: `npx vitest run frontend/app/view/agents/` → all green (no behavior test broken)

- [ ] **Step 5: CDP render-count check.** With the populated dev app: chunk one agent and confirm sibling cards do NOT re-render (React DevTools "Highlight updates", or a temporary render counter); confirm the surface does not reconcile every second (only leaf age/quiet indicators do). Capture before/after for Task 10.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/cockpitsurface.tsx frontend/app/view/agents/agentrow.tsx frontend/app/view/agents/recentactivityrail.tsx
git commit -m "perf(agents): memoize AgentRow + isolate surface reconcile from chunks/ticks (S2)"
```

---

### Task 6: Memoize markdown + timeline grouping

**Files:**
- Modify: `frontend/app/view/agents/markdownmessage.tsx`
- Modify: `frontend/app/view/agents/narrationtimeline.tsx` (449)

**Interfaces:** no new exports. `MarkdownMessage` becomes memoized; `groupTimeline` result is `useMemo`'d.

- [ ] **Step 1: Hoist the remark plugins array + memoize `MarkdownMessage`.** In `markdownmessage.tsx`:

```tsx
const REMARK_PLUGINS = [remarkGfm];

function renderMd(text: string) {
    return (
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MD_COMPONENTS}>
            {text}
        </ReactMarkdown>
    );
}

export const MarkdownMessage = React.memo(function MarkdownMessage({ text, className }: { text: string; className?: string }) {
    const segments = splitInsightBlocks(text);
    return (
        <div className={cn("agent-md", className)}>
            {segments.map((seg, i) =>
                seg.kind === "insight" ? (
                    <InsightCallout key={i} text={seg.text} />
                ) : (
                    <Fragment key={i}>{renderMd(seg.text)}</Fragment>
                )
            )}
        </div>
    );
});
```
(`React.memo` on `{ text, className }` — both primitives, so it re-parses only when the text actually changes, not on every parent re-render.)

- [ ] **Step 2: Memoize `groupTimeline` in `narrationtimeline.tsx:449`:**
```tsx
const items = useMemo(() => groupTimeline(entries), [entries]);
```
(`entries` is now referentially stable per-id from Task 4, so this memo holds across sibling chunks and ticks.) Add `useMemo` to the React import if absent.

- [ ] **Step 3: Typecheck + tests.**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0
Run: `npx vitest run frontend/app/view/agents/` → green

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/markdownmessage.tsx frontend/app/view/agents/narrationtimeline.tsx
git commit -m "perf(agents): memoize MarkdownMessage + groupTimeline (S2)"
```

---

### Task 7: Cap the rendered narration timeline

**Files:**
- Modify: `frontend/app/view/agents/narrationtimeline.tsx`
- Test: extend `frontend/app/view/agents/narrationtimeline` coverage if a pure grouping test exists; otherwise add a small pure test for the cap helper.

**Interfaces:** `NarrationTimeline` renders at most the last `TIMELINE_RENDER_CAP` grouped items; the card is height-bounded with stick-to-bottom so off-screen history is safely dropped from the DOM.

- [ ] **Step 1: Add the cap.** After `const items = useMemo(() => groupTimeline(entries), [entries]);`, render only the tail:
```tsx
const TIMELINE_RENDER_CAP = 200; // grouped items kept in the DOM; card is stick-to-bottom
const visibleItems = items.length > TIMELINE_RENDER_CAP ? items.slice(items.length - TIMELINE_RENDER_CAP) : items;
```
Map over `visibleItems` instead of `items`. Keep `lastMessageIdx` computed against the full `entries` (accent-latest correctness) but ensure the accent lookup still resolves against a rendered item (if the accented message is beyond the cap it simply isn't shown — acceptable, it's old history).

> Full windowing/virtualization (react-window etc.) is a heavier alternative; a tail-cap is the KISS choice and matches the stick-to-bottom UX. If Task 10 profiling shows the cap is insufficient for very tall cards, revisit with virtualization.

- [ ] **Step 2: Typecheck + tests + CDP.** `node --stack-size=4000 …/tsc.js --noEmit` → 0; `npx vitest run frontend/app/view/agents/` → green; CDP: confirm a long-running agent's card still scrolls and sticks to bottom with the newest narration.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/narrationtimeline.tsx
git commit -m "perf(agents): cap rendered narration timeline to the visible tail (S2)"
```

---

### Task 8: Bound the retained-lines projection window

**Files:**
- Modify: `frontend/app/view/agents/livetranscript.ts` (the chunk loop's `lines` accumulation)
- Test: `frontend/app/view/agents/livetranscript.test.ts` (extend)

**Interfaces:** the per-chunk projection runs over a bounded `lines` window (`MAX_RETAINED_LINES`) instead of unbounded history, making per-chunk cost O(window) not O(total session). Projection *output* for inputs within the window is identical to today.

- [ ] **Step 1: Write the failing test** (extend `livetranscript.test.ts`): a pure helper `capLines(lines, max)` keeps only the last `max` entries.
```ts
import { capLines } from "./livetranscript";
describe("capLines", () => {
    it("keeps all when under the cap", () => {
        expect(capLines(["a", "b"], 5)).toEqual(["a", "b"]);
    });
    it("keeps only the last max lines when over", () => {
        expect(capLines(["a", "b", "c", "d"], 2)).toEqual(["c", "d"]);
    });
});
```

- [ ] **Step 2: Run → FAIL** (`capLines` not exported). `npx vitest run frontend/app/view/agents/livetranscript.test.ts`

- [ ] **Step 3: Implement.** In `livetranscript.ts`:
```ts
const MAX_RETAINED_LINES = 4000; // live-card working set; full history lives on disk (focus/interior view)

export function capLines(lines: string[], max: number): string[] {
    return lines.length > max ? lines.slice(lines.length - max) : lines;
}
```
In the chunk loop, cap after appending so `lines` never grows unbounded and `project`/`extractTasks` run over the bounded window:
```ts
lines.push(...chunk.lines);
if (lines.length > MAX_RETAINED_LINES) {
    lines.splice(0, lines.length - MAX_RETAINED_LINES);
}
const entries = project(lines);
// ... rest unchanged
```

> `MAX_RETAINED_LINES` (4000) must comfortably exceed what `TIMELINE_RENDER_CAP` (Task 7) can show, so the visible timeline is always fully backed. The projector tolerates an orphan `tool_result` (a `tool_use` trimmed out of the window) — verify `projectTranscript` does not throw on an unmatched result before committing; recon indicates it correlates via a map and skips unmatched. If it throws, lower risk by raising the cap or guarding the correlation.

- [ ] **Step 4: Run → PASS + typecheck.** `npx vitest run frontend/app/view/agents/livetranscript.test.ts` → PASS; `node --stack-size=4000 …/tsc.js --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/livetranscript.ts frontend/app/view/agents/livetranscript.test.ts
git commit -m "perf(agents): bound retained transcript lines to a fixed window (S2)"
```

---

### Task 9: Consolidate the 1-second tickers to a single owner

**Files:**
- Create: `frontend/app/view/agents/nowticker.tsx` (a single `NowTicker` component that owns the interval) — or a `useNowTicker()` idempotent hook, whichever fits the mount points.
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (remove ticker at 98-101)
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx` (remove ticker at 81-84)
- Modify: `frontend/app/view/agents/usagesurface.tsx` (remove ticker at 476-479)
- Modify: wherever the cockpit shell mounts (e.g. `frontend/app/cockpit/cockpit-root.tsx`) to mount `<NowTicker/>` once.

**Interfaces:** exactly one interval writes `model.nowAtom`; readers are unchanged (`app-bar.tsx:29`, leaf age/quiet indicators, etc.).

- [ ] **Step 1: Implement the single ticker.**
```tsx
export function NowTicker() {
    useEffect(() => {
        const t = setInterval(() => globalStore.set(model.nowAtom, Date.now()), 1000);
        return () => clearInterval(t);
    }, []);
    return null;
}
```
Mount `<NowTicker/>` once high in the cockpit tree (a place mounted for the lifetime of the app — verify the cockpit root). Remove the three per-surface `setInterval` effects. Confirm `model.nowAtom` still initialises to `Date.now()` at `agents.tsx:69` (unchanged).

- [ ] **Step 2: Typecheck + CDP.** `node --stack-size=4000 …/tsc.js --noEmit` → 0. CDP: confirm age labels/countdowns still update once per second across cockpit, focus rail, and usage surface (each of which now relies on the single ticker being mounted). If the usage surface can be shown without the cockpit root mounted, keep a ticker there too, or mount `NowTicker` at a shared ancestor of all three — verify the mount topology before deleting the usage ticker.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/nowticker.tsx frontend/app/view/agents/cockpitsurface.tsx frontend/app/view/agents/agentdetailsrail.tsx frontend/app/view/agents/usagesurface.tsx frontend/app/cockpit/cockpit-root.tsx
git commit -m "perf(agents): single nowAtom ticker instead of three per-surface intervals (S2)"
```

---

### Task 10: Validation pass + deferred-followup note

**Files:**
- Modify: `docs/deferred.md` (record the per-card-unmount server-leak follow-up + the incremental-projection future option)

- [ ] **Step 1: Full typecheck + test suite.**
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0
Run: `npx vitest run` → green (at minimum `frontend/app/view/agents/` and `frontend/app/store/`)
Run: `go test ./pkg/wshutil/ ./pkg/web/ ./pkg/wshrpc/...` → green

- [ ] **Step 2: Before/after CDP + profiler pass** on a populated cockpit (`node scripts/inject-live-agents.mjs <scenario>`, dev app on `:9222`). Record: (a) per-chunk re-render scope — a single agent's chunk should re-render only that card (+ recent-activity rail), not the fleet; (b) idle reconcile — the surface should not re-render every second (only leaf age/quiet). Report the numbers. If any sub-change (e.g. the timeline cap, or a specific memo) shows no measurable benefit and adds complexity, flag it for removal rather than keeping it blindly (per the brief's validation clause).

- [ ] **Step 3: S1 behavioral verification.** Simulate a websocket drop (kill/restart the wavesrv socket, or force a reconnect) and confirm live narration/task-chip/git-refresh resume without remounting the surface. If feasible, observe the server goroutine/watcher count returns to baseline after reconnect (the `CancelRequestsForLink` path). Document the method used and the outcome.

- [ ] **Step 4: Record follow-ups in `docs/deferred.md`** (append a Theme-2 residue entry): (a) per-card-unmount-while-connected still leaks the server watcher until the connection drops or the 1-year timeout — durable fix needs `WshRpc.cancelRequest` to cancel the ctx + the client to emit a wire cancel on `gen.return()` (shared RPC-cancellation blast radius); (b) incremental stateful projection is available as a future optimization if the capped re-project profiles hot.

- [ ] **Step 5: Commit**

```bash
git add docs/deferred.md
git commit -m "docs: Theme 2 streaming-core validation + deferred follow-ups"
```

---

## Self-review checklist (run before execution)

- **Spec coverage:** S1 client restart (Task 1) ✓; S1 server cancel (Task 2) ✓; per-id subscription (Tasks 3-4) ✓; memoization (Tasks 5-6) ✓; timeline windowing (Task 7) ✓; bounded projection + drop-on-stop retention (Tasks 3, 8) ✓; ticker consolidation (Task 9) ✓; validation (Task 10) ✓.
- **Type consistency:** `entriesAtomFor`/`activityAtomFor`/`tasksAtomFor`/`dropLiveId` names are used identically in Tasks 3, 4, 5. `restartActiveStreams`, `capLines`, `CancelRequestsForLink`, `NowTicker` names are stable across their defining/consuming tasks.
- **Ordering/coupling:** Task 3 (per-id atoms) precedes Task 4 (consumers) precedes Tasks 5-6 (memoization depends on stable per-id references). Task 7 (cap) after Task 6 (memoized grouping). Task 2 (Go) is independent of all FE tasks and may run in parallel. Task 9 is independent of the atom chain.
- **Known verification points flagged inline:** projector orphan-`tool_result` tolerance (Task 8); circular-import fallback (Task 3); `NowTicker` mount topology covering all three surfaces (Task 9); exact mock/import specifiers for the vitest suites (Tasks 1, 3).
