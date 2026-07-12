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
        expect(openRpcs.has("r1")).toBe(true);
        openRpcs.get("r1")!.msgFn({ resid: "r1", data: "hello" });
        const first = await gen.next(false);
        expect(first.value).toBe("hello");
        const done = await gen.next(false);
        expect(done.done).toBe(true);
        expect(openRpcs.has("r1")).toBe(false);
    });

    it("throws when a response carries an error", async () => {
        const openRpcs = new Map<string, ClientRpcEntry>();
        const gen = sendRpcCommand(openRpcs, { command: "x", reqid: "r2" });
        openRpcs.get("r2")!.msgFn({ resid: "r2", error: "boom" });
        await expect(gen.next(false)).rejects.toThrow("boom");
        expect(openRpcs.has("r2")).toBe(false);
    });

    it("cancels and stops when the consumer signals termination", async () => {
        const openRpcs = new Map<string, ClientRpcEntry>();
        const gen = sendRpcCommand(openRpcs, { command: "x", reqid: "r3" });
        router.sent = [];
        openRpcs.get("r3")!.msgFn({ resid: "r3", data: "d1", cont: true });
        await gen.next(false);
        openRpcs.get("r3")!.msgFn({ resid: "r3", data: "d2", cont: true });
        const res = await gen.next(true);
        expect(res.done).toBe(true);
        expect(router.sent.some((m) => m.reqid === "r3" && m.cancel === true)).toBe(true);
        expect(openRpcs.has("r3")).toBe(false);
    });

    describe("timeout path", () => {
        beforeEach(() => vi.useFakeTimers());
        afterEach(() => vi.useRealTimers());

        it("injects a timeout error when no response arrives", async () => {
            const openRpcs = new Map<string, ClientRpcEntry>();
            const gen = sendRpcCommand(openRpcs, { command: "x", reqid: "r4", timeout: 1000 });
            vi.advanceTimersByTime(1000);
            await expect(gen.next(false)).rejects.toThrow(/EC-TIME/);
        });
    });
});
