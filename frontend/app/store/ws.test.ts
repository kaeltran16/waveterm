// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { globalStore } from "./jotaiStore";
import { WSControl } from "./ws";
import { INITIAL_LINK, wsLinkAtom } from "./wslink";

function makeWS(): WSControl {
    const ws = new WSControl("", "stable", vi.fn());
    ws.wsConn = { send: vi.fn(), close: vi.fn() } as any;
    return ws;
}

function pushCmd(ws: WSControl, reqid: string) {
    ws.pushMessage({ wscommand: "rpc", message: { reqid } } as any);
}

describe("WSControl message queue", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("caps the disconnected backlog by dropping the oldest", () => {
        const ws = makeWS();
        for (let i = 0; i < 205; i++) {
            pushCmd(ws, "r" + i);
        }
        expect(ws.msgQueue.length).toBe(200);
        expect((ws.msgQueue[0].data as any).message.reqid).toBe("r5");
        expect((ws.msgQueue[ws.msgQueue.length - 1].data as any).message.reqid).toBe("r204");
    });

    it("sends fresh queued messages after reconnect", () => {
        const ws = makeWS();
        const send = ws.wsConn.send as any;
        pushCmd(ws, "fresh");
        ws.open = true;
        ws.runMsgQueue();
        expect(send).toHaveBeenCalledWith(JSON.stringify({ wscommand: "rpc", message: { reqid: "fresh" } }));
        expect(ws.msgQueue.length).toBe(0);
    });

    it("drops stale queued commands on drain instead of head-of-line blocking fresh traffic", () => {
        const ws = makeWS();
        const send = ws.wsConn.send as any;
        pushCmd(ws, "old");
        vi.setSystemTime(Date.now() + 6000);
        ws.open = true;
        ws.runMsgQueue();
        expect(ws.msgQueue.length).toBe(0);
        expect(send).not.toHaveBeenCalled();
    });

    it("parses frames defensively and answers pings", () => {
        const ws = makeWS();
        const send = ws.wsConn.send as any;
        expect(() => ws.onmessage({ data: "{not json" } as any)).not.toThrow();
        ws.onmessage({ data: JSON.stringify({ type: "ping" }) } as any);
        expect(JSON.parse(send.mock.calls[0][0])).toEqual({ type: "pong", stime: expect.any(Number) });
    });

    it("clears the ping interval on shutdown", () => {
        const ws = makeWS();
        expect(ws.pingIntervalId).toBeTruthy();
        ws.shutdown();
        expect(ws.noReconnect).toBe(true);
        expect(ws.pingIntervalId).toBeNull();
    });
});

describe("WSControl link state", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        globalStore.set(wsLinkAtom, INITIAL_LINK);
    });
    afterEach(() => vi.useRealTimers());

    it("marks the link connected on open and lost on a later close", () => {
        const ws = makeWS();
        ws.onopen({} as Event);
        expect(globalStore.get(wsLinkAtom)).toEqual({ connected: true, everConnected: true, lostAt: null });

        const before = Date.now();
        ws.onclose({ wasClean: false } as CloseEvent);
        const link = globalStore.get(wsLinkAtom);
        expect(link.connected).toBe(false);
        expect(link.everConnected).toBe(true);
        expect(link.lostAt).toBeGreaterThanOrEqual(before);
        expect(link.lostAt).toBeLessThanOrEqual(Date.now());
    });

    it("keeps the first drop time when a retry fails", () => {
        const ws = makeWS();
        ws.onopen({} as Event);
        ws.onclose({ wasClean: false } as CloseEvent);
        const lostAt = globalStore.get(wsLinkAtom).lostAt;
        vi.setSystemTime(Date.now() + 5000);
        ws.onclose({ wasClean: false } as CloseEvent);
        expect(globalStore.get(wsLinkAtom).lostAt).toBe(lostAt);
    });
});
