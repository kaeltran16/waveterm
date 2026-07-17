// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

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
vi.mock("@/app/store/jotaiStore", () => {
    const store = new Map<any, any>();
    return {
        globalStore: {
            get: (a: any) => store.get(a) ?? {},
            set: (a: any, v: any) => store.set(a, v),
        },
    };
});
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
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
