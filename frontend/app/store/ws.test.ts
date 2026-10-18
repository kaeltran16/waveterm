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

// mirrors ws.ts: MaxWebSocketSendSize and StableConnTime
const MaxSendBytes = 5 * 1024 * 1024;
const StableConnMs = 2000;

// an rpc command whose JSON is exactly `bytes` long (ascii, so bytes == chars)
function cmdOfSize(bytes: number): WSCommandType {
    const base = JSON.stringify({ wscommand: "rpc", message: { data: "" } }).length;
    return { wscommand: "rpc", message: { data: "x".repeat(bytes - base) } } as any;
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

    it("sends straight through while open", () => {
        const ws = makeWS();
        const send = ws.wsConn.send as any;
        ws.open = true;
        pushCmd(ws, "now");
        expect(send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ wscommand: "rpc", message: { reqid: "now" } }));
        expect(ws.msgQueue).toStrictEqual([]);
    });

    it.each(["routeannounce", "routeunannounce"])("drops a %s instead of queueing it while closed", (command) => {
        const ws = makeWS();
        ws.pushMessage({ wscommand: "rpc", message: { command } } as any);
        expect(ws.msgQueue).toStrictEqual([]);
    });

    it("queues every other command while closed", () => {
        const ws = makeWS();
        const cmds = [
            { wscommand: "rpc" },
            { wscommand: "rpc", message: { command: "getmeta" } },
            { wscommand: "other", message: { command: "routeannounce" } },
        ];
        for (const cmd of cmds) {
            ws.pushMessage(cmd as any);
        }
        expect(ws.msgQueue.map((e) => e.data)).toStrictEqual(cmds);
    });

    it("sends nothing while closed", () => {
        const ws = makeWS();
        ws.sendMessage({ wscommand: "rpc", message: { reqid: "r1" } } as any);
        expect(ws.wsConn.send).not.toHaveBeenCalled();
    });

    it("sends a message at the size cap and refuses one over it", () => {
        const ws = makeWS();
        const send = ws.wsConn.send as any;
        ws.open = true;
        ws.sendMessage(cmdOfSize(MaxSendBytes + 1));
        expect(send).not.toHaveBeenCalled();
        const atCap = cmdOfSize(MaxSendBytes);
        ws.sendMessage(atCap);
        expect(send).toHaveBeenCalledExactlyOnceWith(JSON.stringify(atCap));
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

describe("WSControl close and reconnect", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function makeQuietWS(): WSControl {
        const ws = makeWS();
        vi.spyOn(ws, "connectNow").mockImplementation(() => {});
        return ws;
    }

    it("marks a dropped open link closed and counts a reconnect", () => {
        const ws = makeQuietWS();
        ws.onopen({} as Event);
        ws.onclose({ wasClean: false } as CloseEvent);
        expect(ws.open).toBe(false);
        expect(ws.opening).toBe(false);
        expect(ws.reconnectTimes).toBe(1);
    });

    it("clears a failed connection attempt and retries it", () => {
        const ws = makeQuietWS();
        ws.opening = true;
        ws.onclose({ wasClean: false } as CloseEvent);
        expect(ws.open).toBe(false);
        expect(ws.opening).toBe(false);
        expect(ws.reconnectTimes).toBe(1);
    });

    it("does not retry a close on a link that was neither open nor opening", () => {
        const ws = makeQuietWS();
        ws.onclose({ wasClean: false } as CloseEvent);
        expect(ws.reconnectTimes).toBe(0);
    });

    it("keeps the retry count when the link drops before it proved stable", () => {
        const ws = makeQuietWS();
        ws.onopen({} as Event);
        ws.onclose({ wasClean: false } as CloseEvent);
        vi.advanceTimersByTime(StableConnMs);
        expect(ws.reconnectTimes).toBe(1);
    });
});
