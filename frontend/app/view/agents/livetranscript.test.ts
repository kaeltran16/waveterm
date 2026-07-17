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

describe("capLines", () => {
    it("keeps all when under the cap", async () => {
        const { capLines } = await import("./livetranscript");
        expect(capLines(["a", "b"], 5)).toEqual(["a", "b"]);
    });
    it("keeps only the last max lines when over", async () => {
        const { capLines } = await import("./livetranscript");
        expect(capLines(["a", "b", "c", "d"], 2)).toEqual(["c", "d"]);
    });
});

describe("restartActiveStreams", () => {
    it("re-opens every active stream and returns the old generators", async () => {
        const { startTranscriptStream, restartActiveStreams, stopTranscriptStream } = await import("./livetranscript");
        startTranscriptStream("a", "/p/a", "claude");
        startTranscriptStream("b", "/p/b", "claude");
        expect(openCount).toBe(2);
        restartActiveStreams();
        // old two returned, two new opens
        expect(returned.length).toBe(2);
        expect(openCount).toBe(4);

        // let the stale generators' finally blocks settle (their return() already
        // resolved the blocking gate synchronously during restartActiveStreams's
        // stop(), but the for-await loop's finally runs on a later microtask)
        await new Promise((r) => setTimeout(r, 0));
        stopTranscriptStream("a");
        // proves the map still holds the restarted handle for "a": stop() reaches the
        // NEW generator and calls its return() -> 3rd push. If the finally-guard were
        // an unconditional streams.delete(id), the stale generator's finally would
        // already have deleted "a" (and "b") from the map, making this stop() a no-op
        // and returned.length would stay at 2.
        expect(returned.length).toBe(3);
    });
});
