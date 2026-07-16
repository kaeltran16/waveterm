// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWaveEvent } from "@/app/store/wps";
import { makeFeBlockRouteId, makeTabRouteId, WshRouter } from "./wshrouter";

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
        router.recvRpcMessage({ resid: "r1", data: "ok" });
        expect(src.recv).toContainEqual({ resid: "r1", data: "ok" });
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
        // route actually removed: a later command for it now falls back to upstream, not the client
        client.recv = [];
        upstream.recv = [];
        router.recvRpcMessage({ command: "x", reqid: "r9", source: "s", route: "tab:t1" });
        expect(client.recv).toEqual([]);
        expect(upstream.recv.some((m) => m.reqid === "r9")).toBe(true);
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
