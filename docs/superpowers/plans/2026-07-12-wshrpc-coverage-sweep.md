# wshrpc Coverage Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the test-coverage gap on the churned wshrpc RPC plumbing by adding focused unit tests to the four hand-written logic units that currently have zero coverage.

**Architecture:** The affected wshrpc files split cleanly into three buckets: (1) generated code and pure type/const declarations — not testable behavior; (2) already-covered server handlers — `wshserver.go` has seven test files; (3) hand-written plumbing with real branching and *zero* tests — the FE router, the FE client dispatch, the FE response generator, and the Go generic client helper. This sweep targets bucket (3): four independent test files, each exercising observable behavior of an existing implementation, no production code changes.

**Tech Stack:** Go (`testing`), TypeScript + Vitest (`vi.mock`, fake timers). Frontend types `RpcMessage` and `AbstractWshClient` are ambient globals (`frontend/types/gotypes.d.ts`, `frontend/types/custom.d.ts`) — no imports needed for them.

## Global Constraints

- **No production code changes.** The deliverable is tests only. If a test reveals a genuine bug in the implementation, STOP and surface it — do not silently "fix" production code as part of a coverage task.
- **Test behavior, not internals.** Assert observable outputs (routed messages, returned values, thrown errors, channel contents), never private field shapes.
- **Copyright header** on every new file, matching siblings: `// Copyright 2026, Command Line Inc.` / `// SPDX-License-Identifier: Apache-2.0`.
- **Frontend typecheck gotcha:** `npx tsc` stack-overflows on this repo. If you must typecheck, use `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Normal test runs via `npx vitest` are fine.
- **Comments:** only for "why", lower case, only when necessary (repo convention).
- Each task is independent (distinct files, no shared state) and ends with its own passing test run + commit. Tasks 1–4 may be executed in parallel.

## Scope & Exclusions

The goal names 13 files. Most carry no testable behavior; forcing tests onto them would be busywork that violates YAGNI and "test behavior, not internals." Recorded here so the sweep's coverage is honest:

**In scope (zero current coverage, real logic):**
| File | Why |
|---|---|
| `frontend/app/store/wshrouter.ts` | `WshRouter` — message routing, registration, announce/unannounce, response cleanup. Pure logic. |
| `frontend/app/store/wshclient.ts` | `WshClient` + `RpcResponseHelper` — incoming-command dispatch, response lifecycle, call/stream message building. |
| `frontend/app/store/wshrpcutil-base.ts` | `rpcResponseGenerator` + `sendRpcCommand` — async response stream, timeout, terminate/cancel, null-reqid path. |
| `pkg/wshrpc/wshclient/wshclientutil.go` | generic `sendRpcRequest*Helper` + `rtnErr` — nil-client guards and error propagation. |

**Excluded (with rationale):**
| File | Why excluded |
|---|---|
| `pkg/wshrpc/wshrpctypes.go`, `wshrpctypes_builder.go`, `wshrpctypes_const.go`, `wshrpctypes_file.go` | Pure `type`/`interface`/`const` declarations. No logic to exercise. |
| `pkg/wshrpc/wshclient/wshclient.go` | Generated (`// Generated ...`). Go is source of truth; `task generate` owns it. Never hand-test generated files. |
| `frontend/app/store/wshclientapi.ts` | Generated (`// generated ...`). Same rule. |
| `pkg/wshrpc/wshserver/wshserverutil.go` | 27-line `sync.Once` singleton getter. No branching worth a test. |
| `frontend/app/store/wshrouter.ts` init in `wshrpcutil.ts` | `wshrpcutil.ts` is WS/router wiring glue (`globalWS`, `WSControl`); no isolable pure logic. Testing it means mocking the entire WS stack for near-zero behavioral yield. YAGNI. |
| `pkg/wshrpc/wshserver/wshserver.go` | Already covered by 7 test files (`resolvers_test`, `projects_test`, `sessiongroup_test`, `transcript_test`, `memory_learn_test`, `wshserver_run_test`, `maintest_test`). Handlers are thin delegators to services with their own tests; blanket handler tests would need heavy DB fixtures for low marginal coverage. A targeted per-handler audit is possible future work but is out of this sweep. |

---

### Task 1: WshRouter routing tests

**Files:**
- Test: `frontend/app/store/wshrouter.test.ts` (create)
- Under test: `frontend/app/store/wshrouter.ts`

**Interfaces:**
- Consumes: `WshRouter`, `makeFeBlockRouteId`, `makeTabRouteId`, `makeBuilderRouteId` (exported from `wshrouter.ts`). Ambient globals `RpcMessage`, `AbstractWshClient`.
- Produces: nothing consumed by later tasks.

**Mocking note:** `wshrouter.ts` imports `handleWaveEvent` from `@/app/store/wps` (a heavy module). Mock it so the import graph stays light and you can assert event delivery:
```ts
vi.mock("@/app/store/wps", () => ({ handleWaveEvent: vi.fn() }));
```
`util.isBlank` (from `@/util/util`) is pure — let it run for real.

- [ ] **Step 1: Write the test file**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWaveEvent } from "@/app/store/wps";
import { makeBuilderRouteId, makeFeBlockRouteId, makeTabRouteId, WshRouter } from "./wshrouter";

vi.mock("@/app/store/wps", () => ({ handleWaveEvent: vi.fn() }));

class FakeClient implements AbstractWshClient {
    recv: RpcMessage[] = [];
    recvRpcMessage(msg: RpcMessage): void {
        this.recv.push(msg);
    }
}

describe("wshrouter route-id helpers", () => {
    it("prefixes route ids by kind", () => {
        expect(makeFeBlockRouteId("b1")).toBe("feblock:b1");
        expect(makeTabRouteId("t1")).toBe("tab:t1");
        expect(makeBuilderRouteId("x1")).toBe("builder:x1");
    });
});

describe("WshRouter", () => {
    let upstream: FakeClient;
    let router: WshRouter;

    beforeEach(() => {
        vi.clearAllMocks();
        upstream = new FakeClient();
        router = new WshRouter(upstream);
    });

    it("throws when constructed without an upstream client", () => {
        expect(() => new WshRouter(null)).toThrow("upstream client cannot be null");
    });

    it("registerRoute announces to upstream and refuses the reserved sys name", () => {
        const client = new FakeClient();
        router.registerRoute("tab:t1", client);
        expect(upstream.recv).toEqual([
            { command: "routeannounce", data: "tab:t1", source: "tab:t1", route: "$control" },
        ]);
        expect(() => router.registerRoute("sys", client)).toThrow(/reserved name/);
    });

    it("discards routeannounce/routeunannounce (terminal node)", () => {
        const client = new FakeClient();
        router.registerRoute("tab:t1", client);
        router.recvRpcMessage({ command: "routeannounce", route: "tab:t1" });
        router.recvRpcMessage({ command: "routeunannounce", route: "tab:t1" });
        expect(client.recv).toEqual([]);
    });

    it("delivers eventrecv to handleWaveEvent", () => {
        const evt = { event: "test" };
        router.recvRpcMessage({ command: "eventrecv", data: evt });
        expect(handleWaveEvent).toHaveBeenCalledWith(evt);
    });

    it("routes a command to its dest client and registers route info", () => {
        const dest = new FakeClient();
        router.registerRoute("tab:dest", dest);
        const msg: RpcMessage = { command: "test", reqid: "r1", source: "tab:src", route: "tab:dest" };
        router.recvRpcMessage(msg);
        expect(dest.recv).toEqual([msg]);
    });

    it("falls back to upstream when the dest route is not registered", () => {
        const msg: RpcMessage = { command: "test", reqid: "r1", source: "tab:src", route: "tab:missing" };
        router.recvRpcMessage(msg);
        expect(upstream.recv).toContainEqual(msg);
    });

    it("routes a response back to the source and clears route info when not continuing", () => {
        const src = new FakeClient();
        const dest = new FakeClient();
        router.registerRoute("tab:src", src);
        router.registerRoute("tab:dest", dest);
        router.recvRpcMessage({ command: "test", reqid: "r1", source: "tab:src", route: "tab:dest" });
        // response carries resid == reqid; goes back to source
        router.recvRpcMessage({ resid: "r1", data: "ok" });
        expect(src.recv).toContainEqual({ resid: "r1", data: "ok" });
        // route info deleted: a second response for r1 is discarded (source sees only the first)
        src.recv = [];
        router.recvRpcMessage({ resid: "r1", data: "again" });
        expect(src.recv).toEqual([]);
    });

    it("keeps route info for a continuing (cont) response", () => {
        const src = new FakeClient();
        const dest = new FakeClient();
        router.registerRoute("tab:src", src);
        router.registerRoute("tab:dest", dest);
        router.recvRpcMessage({ command: "test", reqid: "r1", source: "tab:src", route: "tab:dest" });
        router.recvRpcMessage({ resid: "r1", data: "chunk1", cont: true });
        router.recvRpcMessage({ resid: "r1", data: "chunk2" });
        expect(src.recv).toEqual([
            { resid: "r1", data: "chunk1", cont: true },
            { resid: "r1", data: "chunk2" },
        ]);
    });

    it("unregisterRoute unannounces upstream and removes the route", () => {
        const client = new FakeClient();
        router.registerRoute("tab:t1", client);
        upstream.recv = [];
        router.unregisterRoute("tab:t1");
        expect(upstream.recv).toEqual([
            { command: "routeunannounce", data: "tab:t1", source: "tab:t1", route: "$control" },
        ]);
        // route gone: a command targeting it now falls back to upstream
        upstream.recv = [];
        router.recvRpcMessage({ command: "x", reqid: "r9", source: "s", route: "tab:t1" });
        client.recv = [];
        expect(client.recv).toEqual([]);
    });

    it("reannounceRoutes re-announces every registered route to upstream", () => {
        router.registerRoute("tab:a", new FakeClient());
        router.registerRoute("tab:b", new FakeClient());
        upstream.recv = [];
        router.reannounceRoutes();
        const announced = upstream.recv.map((m) => m.data).sort();
        expect(announced).toEqual(["tab:a", "tab:b"]);
        expect(upstream.recv.every((m) => m.command === "routeannounce")).toBe(true);
    });
});
```

- [ ] **Step 2: Run the tests, confirm they pass**

Run: `npx vitest run frontend/app/store/wshrouter.test.ts`
Expected: all tests PASS. If a routing assertion fails, re-read `wshrouter.ts` against the test — a genuine mismatch is a bug to surface (Global Constraints), not a silent prod edit.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/store/wshrouter.test.ts
git commit -m "test(wshrpc): cover WshRouter message routing and registration"
```

---

### Task 2: WshClient + RpcResponseHelper dispatch tests

**Files:**
- Test: `frontend/app/store/wshclient.test.ts` (create)
- Under test: `frontend/app/store/wshclient.ts`

**Interfaces:**
- Consumes: `WshClient`, `RpcResponseHelper` (exported from `wshclient.ts`). Ambient `RpcMessage`, `RpcOpts`, `ClientRpcEntry`.
- Produces: nothing consumed by later tasks.

**Mocking note:** `wshclient.ts` imports `sendRpcCommand`, `sendRpcResponse` from `@/app/store/wshrpcutil-base`. Mock that module so you can capture responses and stub the command generator:
```ts
vi.mock("@/app/store/wshrpcutil-base", () => ({
    sendRpcResponse: vi.fn(),
    sendRpcCommand: vi.fn(),
}));
```
`crypto.randomUUID` is available in the vitest (node) environment.

- [ ] **Step 1: Write the test file**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendRpcCommand, sendRpcResponse } from "@/app/store/wshrpcutil-base";
import { RpcResponseHelper, WshClient } from "./wshclient";

vi.mock("@/app/store/wshrpcutil-base", () => ({
    sendRpcResponse: vi.fn(),
    sendRpcCommand: vi.fn(),
}));

describe("RpcResponseHelper", () => {
    beforeEach(() => vi.clearAllMocks());

    it("is done immediately when the command carries no reqid (no response expected)", () => {
        const client = new WshClient("tab:me");
        const helper = new RpcResponseHelper(client, { command: "x" });
        helper.sendResponse({ data: 1 });
        expect(sendRpcResponse).not.toHaveBeenCalled();
    });

    it("stamps resid + source, forwards the response, and finalizes when not continuing", () => {
        const client = new WshClient("tab:me");
        client.openRpcs.set("r1", { reqId: "r1", startTs: 0, command: "x", msgFn: vi.fn() });
        const helper = new RpcResponseHelper(client, { command: "x", reqid: "r1", source: "tab:src" });
        helper.sendResponse({ data: "ok" });
        expect(sendRpcResponse).toHaveBeenCalledWith({ data: "ok", resid: "r1", source: "tab:me" });
        expect(client.openRpcs.has("r1")).toBe(false); // finalized
        // second send is a no-op after done
        (sendRpcResponse as any).mockClear();
        helper.sendResponse({ data: "again" });
        expect(sendRpcResponse).not.toHaveBeenCalled();
    });

    it("keeps the rpc open for a continuing response", () => {
        const client = new WshClient("tab:me");
        client.openRpcs.set("r1", { reqId: "r1", startTs: 0, command: "x", msgFn: vi.fn() });
        const helper = new RpcResponseHelper(client, { command: "x", reqid: "r1", source: "tab:src" });
        helper.sendResponse({ data: "chunk", cont: true });
        expect(client.openRpcs.has("r1")).toBe(true);
    });

    it("exposes the command source", () => {
        const client = new WshClient("tab:me");
        const helper = new RpcResponseHelper(client, { command: "x", source: "tab:src" });
        expect(helper.getSource()).toBe("tab:src");
    });
});

describe("WshClient.wshRpcCall message building", () => {
    beforeEach(() => vi.clearAllMocks());

    it("builds a call message with a generated reqid and routes it through sendRpcCommand", async () => {
        const gen = { next: vi.fn().mockResolvedValue({ value: "result", done: false }) };
        (sendRpcCommand as any).mockReturnValue(gen);
        const client = new WshClient("tab:me");
        const rtn = await client.wshRpcCall("mycmd", { a: 1 }, { timeout: 5000, route: "tab:dest" } as RpcOpts);
        expect(rtn).toBe("result");
        const sentMsg = (sendRpcCommand as any).mock.calls[0][1] as RpcMessage;
        expect(sentMsg.command).toBe("mycmd");
        expect(sentMsg.source).toBe("tab:me");
        expect(sentMsg.timeout).toBe(5000);
        expect(sentMsg.route).toBe("tab:dest");
        expect(sentMsg.reqid).toBeTruthy();
        expect(gen.next).toHaveBeenCalledWith(true); // force single-response termination
    });

    it("omits reqid and returns null on a noresponse call", async () => {
        (sendRpcCommand as any).mockReturnValue(null);
        const client = new WshClient("tab:me");
        const rtn = await client.wshRpcCall("fire", {}, { noresponse: true } as RpcOpts);
        expect(rtn).toBeNull();
        const sentMsg = (sendRpcCommand as any).mock.calls[0][1] as RpcMessage;
        expect(sentMsg.reqid).toBeUndefined();
    });

    it("wshRpcStream rejects noresponse", () => {
        const client = new WshClient("tab:me");
        expect(() => client.wshRpcStream("s", {}, { noresponse: true } as RpcOpts)).toThrow(/noresponse not supported/);
    });
});

describe("WshClient.handleIncomingCommand dispatch", () => {
    beforeEach(() => vi.clearAllMocks());

    it("dispatches to a matching handle_<command> and returns its result", async () => {
        class MyClient extends WshClient {
            async handle_ping(_helper: RpcResponseHelper, data: any) {
                return { pong: data };
            }
        }
        const client = new MyClient("tab:me");
        await client.handleIncomingCommand({ command: "ping", reqid: "r1", data: "hi" });
        expect(sendRpcResponse).toHaveBeenCalledWith(
            expect.objectContaining({ data: { pong: "hi" }, resid: "r1", source: "tab:me" })
        );
    });

    it("routes an unknown command to handle_default and reports the thrown error", async () => {
        const client = new WshClient("tab:me");
        await client.handleIncomingCommand({ command: "nope", reqid: "r1" });
        expect(sendRpcResponse).toHaveBeenCalledWith(
            expect.objectContaining({ error: expect.stringContaining("not supported"), resid: "r1" })
        );
    });
});

describe("WshClient.recvRpcMessage", () => {
    beforeEach(() => vi.clearAllMocks());

    it("treats a message with a command as an incoming request", () => {
        const client = new WshClient("tab:me");
        const spy = vi.spyOn(client, "handleIncomingCommand").mockResolvedValue(undefined);
        client.recvRpcMessage({ command: "x", reqid: "r1" });
        expect(spy).toHaveBeenCalled();
    });

    it("delivers a response to the matching open rpc entry", () => {
        const client = new WshClient("tab:me");
        const msgFn = vi.fn();
        client.openRpcs.set("r1", { reqId: "r1", startTs: 0, command: "x", msgFn });
        const resp: RpcMessage = { resid: "r1", data: "v" };
        client.recvRpcMessage(resp);
        expect(msgFn).toHaveBeenCalledWith(resp);
    });

    it("ignores a response with no resid and one with an unknown resid", () => {
        const client = new WshClient("tab:me");
        // neither should throw
        client.recvRpcMessage({ data: "orphan" });
        client.recvRpcMessage({ resid: "ghost", data: "v" });
    });
});
```

- [ ] **Step 2: Run the tests, confirm they pass**

Run: `npx vitest run frontend/app/store/wshclient.test.ts`
Expected: all tests PASS. A failing assertion means either a test bug or a real defect — surface it before touching `wshclient.ts`.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/store/wshclient.test.ts
git commit -m "test(wshrpc): cover WshClient dispatch and RpcResponseHelper lifecycle"
```

---

### Task 3: rpcResponseGenerator + sendRpcCommand tests

**Files:**
- Test: `frontend/app/store/wshrpcutil-base.test.ts` (create)
- Under test: `frontend/app/store/wshrpcutil-base.ts`

**Interfaces:**
- Consumes: `sendRpcCommand`, `setDefaultRouter` (exported from `wshrpcutil-base.ts`). Ambient `RpcMessage`, `ClientRpcEntry`, `AbstractWshClient`.
- Produces: nothing consumed by later tasks.

**Design note:** `rpcResponseGenerator` is not exported; drive it through the exported `sendRpcCommand(openRpcs, msg)`, which registers an entry in `openRpcs` whose `msgFn` feeds the generator. Install a fake `DefaultRouter` via `setDefaultRouter` first so `sendRpcCommand`'s `DefaultRouter.recvRpcMessage(msg)` is inert. Push responses by calling `openRpcs.get(reqid).msgFn(...)`.

**Mocking note:** the module imports `./ws`, `@/app/store/wps`, `@/util/endpoints`, `@/app/store/wshclient`, `@/app/store/wshrouter` at top level. Those are only used by `initElectronWshrpc`/`shutdownWshrpc`, not by the code under test, but the imports still evaluate. Stub the side-effectful ones so importing the module is clean:
```ts
vi.mock("./ws", () => ({
    addWSReconnectHandler: vi.fn(), initGlobalWS: vi.fn(), globalWS: undefined,
}));
vi.mock("@/app/store/wps", () => ({ setWpsRpcClient: vi.fn(), wpsReconnectHandler: vi.fn() }));
vi.mock("@/util/endpoints", () => ({ getWSServerEndpoint: () => "" }));
```

- [ ] **Step 1: Write the test file**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ws", () => ({ addWSReconnectHandler: vi.fn(), initGlobalWS: vi.fn(), globalWS: undefined }));
vi.mock("@/app/store/wps", () => ({ setWpsRpcClient: vi.fn(), wpsReconnectHandler: vi.fn() }));
vi.mock("@/util/endpoints", () => ({ getWSServerEndpoint: () => "" }));

import { sendRpcCommand, setDefaultRouter } from "./wshrpcutil-base";

class FakeRouter {
    sent: RpcMessage[] = [];
    recvRpcMessage(msg: RpcMessage): void {
        this.sent.push(msg);
    }
}

let router: FakeRouter;

beforeEach(() => {
    router = new FakeRouter();
    setDefaultRouter(router as any);
});

describe("sendRpcCommand", () => {
    it("forwards the message to the default router", () => {
        const openRpcs = new Map<string, ClientRpcEntry>();
        sendRpcCommand(openRpcs, { command: "x", reqid: "r1" });
        expect(router.sent).toEqual([{ command: "x", reqid: "r1" }]);
    });

    it("returns null when the message has no reqid (fire-and-forget)", () => {
        const openRpcs = new Map<string, ClientRpcEntry>();
        const gen = sendRpcCommand(openRpcs, { command: "x" });
        expect(gen).toBeNull();
    });
});

describe("rpcResponseGenerator (via sendRpcCommand)", () => {
    it("registers an open rpc, yields response data, then terminates on a non-cont message", async () => {
        const openRpcs = new Map<string, ClientRpcEntry>();
        const gen = sendRpcCommand(openRpcs, { command: "x", reqid: "r1" });
        await gen.next(); // prime: runs to the first `yield null`
        expect(openRpcs.has("r1")).toBe(true);
        openRpcs.get("r1")!.msgFn({ resid: "r1", data: "hello" });
        const first = await gen.next(false);
        expect(first.value).toBe("hello");
        // no cont on that message -> next resolves done, entry cleaned up
        const done = await gen.next(false);
        expect(done.done).toBe(true);
        expect(openRpcs.has("r1")).toBe(false);
    });

    it("throws when a response carries an error", async () => {
        const openRpcs = new Map<string, ClientRpcEntry>();
        const gen = sendRpcCommand(openRpcs, { command: "x", reqid: "r2" });
        await gen.next();
        openRpcs.get("r2")!.msgFn({ resid: "r2", error: "boom" });
        await expect(gen.next(false)).rejects.toThrow("boom");
        expect(openRpcs.has("r2")).toBe(false); // finally block cleaned up
    });

    it("cancels and stops when the consumer signals termination", async () => {
        const openRpcs = new Map<string, ClientRpcEntry>();
        const gen = sendRpcCommand(openRpcs, { command: "x", reqid: "r3" });
        await gen.next();
        router.sent = [];
        openRpcs.get("r3")!.msgFn({ resid: "r3", data: "d1", cont: true });
        await gen.next(false); // consume d1 (not terminating)
        // now push again and terminate
        openRpcs.get("r3")!.msgFn({ resid: "r3", data: "d2", cont: true });
        const res = await gen.next(true); // shouldTerminate = true
        expect(res.done).toBe(true);
        // a cancel message was routed for r3
        expect(router.sent.some((m) => m.reqid === "r3" && m.cancel === true)).toBe(true);
        expect(openRpcs.has("r3")).toBe(false);
    });

    describe("timeout path", () => {
        beforeEach(() => vi.useFakeTimers());
        afterEach(() => vi.useRealTimers());

        it("injects a timeout error when no response arrives", async () => {
            const openRpcs = new Map<string, ClientRpcEntry>();
            const gen = sendRpcCommand(openRpcs, { command: "x", reqid: "r4", timeout: 1000 });
            await gen.next();
            vi.advanceTimersByTime(1000);
            await expect(gen.next(false)).rejects.toThrow(/EC-TIME/);
        });
    });
});
```

> Note on the prime step: `sendRpcCommand` already calls `rtnGen.next()` once internally to reach the first `yield null`. Calling `await gen.next()` again in the test advances into the `while` loop and is safe because the queue is empty (it awaits `signalPromise`). If a test hangs, drop the extra prime `next()` — the internal prime already registered the entry. Verify empirically when you run.

- [ ] **Step 2: Run the tests, confirm they pass**

Run: `npx vitest run frontend/app/store/wshrpcutil-base.test.ts`
Expected: all tests PASS. Async-generator timing is the likely friction point — if a `next()` hangs, adjust priming per the note above; do not change production code.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/store/wshrpcutil-base.test.ts
git commit -m "test(wshrpc): cover rpcResponseGenerator stream, timeout, and cancel paths"
```

---

### Task 4: wshclientutil generic-helper guard tests (Go)

**Files:**
- Test: `pkg/wshrpc/wshclient/wshclientutil_test.go` (create)
- Under test: `pkg/wshrpc/wshclient/wshclientutil.go`

**Interfaces:**
- Consumes: package-internal `sendRpcRequestCallHelper[T]`, `sendRpcRequestResponseStreamHelper[T]` (same package `wshclient`, so unexported symbols are reachable from the test). `wshrpc.RpcOpts`, `wshrpc.RespOrErrorUnion[T]`.
- Produces: nothing consumed by later tasks.

**Scope note:** These helpers wrap a concrete `*wshutil.WshRpc`. A full round-trip would require wiring `MakeWshRpcWithChannels` plus a server impl and message framing — heavy, and there is no existing channel-wired test to copy. The high-signal, deterministic coverage is the **nil-client guard** on both helpers (returns before touching the transport) and the streaming helper's **error-channel** behavior. Cover those; do not build transport scaffolding for this sweep.

- [ ] **Step 1: Write the test file**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshclient

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestSendRpcRequestCallHelperNilClient(t *testing.T) {
	_, err := sendRpcRequestCallHelper[string](nil, "test", nil, nil)
	if err == nil {
		t.Fatal("expected error for nil wshrpc client")
	}
	if err.Error() != "nil wshrpc passed to wshclient" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSendRpcRequestCallHelperNilClientNoResponse(t *testing.T) {
	// NoResponse path still guards on nil before dispatch
	_, err := sendRpcRequestCallHelper[string](nil, "test", nil, &wshrpc.RpcOpts{NoResponse: true})
	if err == nil {
		t.Fatal("expected error for nil wshrpc client on noresponse path")
	}
}

func TestSendRpcRequestResponseStreamHelperNilClient(t *testing.T) {
	ch := sendRpcRequestResponseStreamHelper[string](nil, "test", nil, nil)
	resp, ok := <-ch
	if !ok {
		t.Fatal("expected one error value before channel close")
	}
	if resp.Error == nil {
		t.Fatal("expected error in stream response for nil client")
	}
	if _, open := <-ch; open {
		t.Fatal("expected channel to be closed after the error")
	}
}
```

- [ ] **Step 2: Run the tests, confirm they pass**

Run: `go test ./pkg/wshrpc/wshclient/ -run 'RpcRequest' -v`
Expected: `PASS` for all three tests. (`sendRpcRequestResponseStreamHelper` uses a goroutine via `rtnErr`; the receive on the channel synchronizes, so no flakiness.)

- [ ] **Step 3: Commit**

```bash
git add pkg/wshrpc/wshclient/wshclientutil_test.go
git commit -m "test(wshrpc): cover wshclient generic-helper nil-client guards"
```

---

## Self-Review

**1. Spec coverage:** The goal is "coverage-sweep" over 13 wshrpc files. Every file is accounted for in Scope & Exclusions — four get new tests, the rest are excluded with a stated reason. Honest and complete.

**2. Placeholder scan:** No TBD/TODO/"add appropriate tests" placeholders. Every test step contains full, runnable code.

**3. Type consistency:** Test symbols match sources — `WshRouter`/`makeTabRouteId` (Task 1), `WshClient`/`RpcResponseHelper` + `openRpcs`/`msgFn` on `ClientRpcEntry` (Task 2), `sendRpcCommand`/`setDefaultRouter` (Task 3), `sendRpcRequestCallHelper`/`sendRpcRequestResponseStreamHelper` + `RpcOpts.NoResponse` + `RespOrErrorUnion.Error` (Task 4). The ambient `RpcMessage` fields used (`command`, `reqid`, `resid`, `source`, `route`, `data`, `cont`, `cancel`, `error`, `timeout`) all exist in `gotypes.d.ts`.

**Known risk (surfaced, not hidden):** Task 3's async-generator priming (`gen.next()` after `sendRpcCommand` already primed once) is the one place empirical timing may differ from the written flow. The task step and inline note tell the implementer exactly how to adjust if a `next()` hangs, without altering production code. Everything else is deterministic.
