// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const returned: string[] = [];
let openCount = 0;
// per-test generator factory so a test can stream real chunks; null = the blocking default
let genFactory: (() => any) | null = null;
// every StreamAgentTranscriptCommand request payload (path + taillines)
const streamCalls: { path: string; taillines: number }[] = [];
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
// a generator that yields fixed chunks then completes
function makeChunkGen(chunks: string[][]) {
    let i = 0;
    const gen: any = {
        async next() {
            if (i < chunks.length) {
                return { value: { lines: chunks[i++] }, done: false };
            }
            return { value: undefined, done: true };
        },
        async return(v: any) {
            returned.push("returned");
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
        StreamAgentTranscriptCommand: vi.fn((_client: any, data: any) => {
            streamCalls.push(data);
            openCount++;
            return (genFactory ?? makeGen)();
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
        __store: store,
    };
});
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
const reconnectHandlers: (() => void)[] = [];
vi.mock("@/app/store/ws", () => ({
    addWSReconnectHandler: (h: () => void) => reconnectHandlers.push(h),
}));
vi.mock("./transcriptregistry", () => ({
    // project reflects the retained line count, so a test can observe capping
    projectorFor: () => ({
        project: (l: string[]) => [{ kind: "message", text: String(l.length) }],
        extractTasks: () => undefined,
    }),
}));

afterEach(() => {
    returned.length = 0;
    openCount = 0;
    genFactory = null;
    streamCalls.length = 0;
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

describe("pi full-history streaming", () => {
    it("requests taillines -1 for a pi agent and 300 for claude", async () => {
        const { startTranscriptStream } = await import("./livetranscript");
        startTranscriptStream("p", "/home/u/.pi/agent/sessions/s.jsonl", "pi");
        startTranscriptStream("c", "/home/u/.claude/projects/x/y.jsonl", "claude");
        const byPath = new Map(streamCalls.map((c) => [c.path, c]));
        expect(byPath.get("/home/u/.pi/agent/sessions/s.jsonl")?.taillines).toBe(-1);
        expect(byPath.get("/home/u/.claude/projects/x/y.jsonl")?.taillines).toBe(300);
    });

    it("retains every streamed line for pi but caps claude at 4000", async () => {
        genFactory = () => makeChunkGen(Array.from({ length: 4500 }, (_, i) => [`line-${i}`]));
        const { startTranscriptStream } = await import("./livetranscript");
        const store = (await import("@/app/store/jotaiStore")) as unknown as { __store: Map<any, any> };
        const { liveEntriesByIdAtom } = await import("./livetranscriptatoms");
        startTranscriptStream("pi1", "/home/u/.pi/agent/sessions/s2.jsonl", "pi");
        startTranscriptStream("c1", "/home/u/.claude/projects/x/y2.jsonl", "claude");
        await new Promise((r) => setTimeout(r, 20));
        const live = store.__store.get(liveEntriesByIdAtom) ?? {};
        // pi retains all 4500 streamed lines; claude keeps only the last 4000
        expect(live["pi1"]?.[0]?.text).toBe("4500");
        expect(live["c1"]?.[0]?.text).toBe("4000");
    });
});
