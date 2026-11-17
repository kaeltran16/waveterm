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

// the request options (timeout) of every StreamAgentTranscriptCommand call
const streamOpts: any[] = [];
// per-test projector; null = the default below
let projectorOverride: any = null;
// a generator the test feeds chunks into by hand; return() is recorded but does not end it, like a
// generator with a chunk already in flight when the stream is stopped
function makeFeedGen() {
    const waiting: ((r: IteratorResult<any>) => void)[] = [];
    const buffered: IteratorResult<any>[] = [];
    const deliver = (r: IteratorResult<any>) => {
        const w = waiting.shift();
        if (w) {
            w(r);
        } else {
            buffered.push(r);
        }
    };
    const gen: any = {
        next() {
            const b = buffered.shift();
            return b ? Promise.resolve(b) : new Promise<IteratorResult<any>>((res) => waiting.push(res));
        },
        async return(v: any) {
            returned.push("returned");
            return { value: v, done: true };
        },
        [Symbol.asyncIterator]() {
            return this;
        },
    };
    return {
        gen,
        push: (lines: string[]) => deliver({ value: { lines }, done: false }),
        end: () => deliver({ value: undefined, done: true }),
    };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

// every GetAgentTranscriptCommand request, each answered when the test resolves its promise
const fullReads: {
    data: { path: string; maxlines: number };
    resolve: (lines: string[]) => void;
    reject: (e: Error) => void;
}[] = [];

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GetAgentTranscriptCommand: vi.fn(
            (_client: any, data: any) =>
                new Promise((res, rej) => fullReads.push({ data, resolve: (lines) => res({ lines }), reject: rej }))
        ),
        StreamAgentTranscriptCommand: vi.fn((_client: any, data: any, opts: any) => {
            streamCalls.push(data);
            streamOpts.push(opts);
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
    projectorFor: () =>
        projectorOverride ?? {
            projectRecords: (r: unknown[]) => [{ kind: "message", text: String(r.length) }],
            extractTasks: () => undefined,
        },
}));

afterEach(() => {
    returned.length = 0;
    openCount = 0;
    genFactory = null;
    projectorOverride = null;
    streamOpts.length = 0;
    streamCalls.length = 0;
    fullReads.length = 0;
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

describe("stream setup", () => {
    it("opens no stream for an empty path, and only one per id", async () => {
        const { startTranscriptStream, stopTranscriptStream } = await import("./livetranscript");
        startTranscriptStream("setup-empty", "", "claude");
        expect(openCount).toBe(0);
        startTranscriptStream("setup-dup", "/p/dup.jsonl", "claude");
        startTranscriptStream("setup-dup", "/p/dup.jsonl", "claude");
        expect(openCount).toBe(1);
        stopTranscriptStream("setup-dup");
    });

    it("requests the whole file for pi, by agent name in any case or by session path, and a tail for the rest", async () => {
        const { startTranscriptStream, stopTranscriptStream } = await import("./livetranscript");
        const winPi = "C:\\Users\\u\\.pi\\agent\\sessions\\s.jsonl";
        startTranscriptStream("setup-pi-a", "/p/a.jsonl", "pi");
        startTranscriptStream("setup-pi-b", "/p/b.jsonl", "PI");
        startTranscriptStream("setup-pi-c", winPi);
        startTranscriptStream("setup-other", "/p/d.jsonl", "claude");
        expect(streamCalls.map((c) => [c.path, c.taillines])).toEqual([
            ["/p/a.jsonl", -1],
            ["/p/b.jsonl", -1],
            [winPi, -1],
            ["/p/d.jsonl", 300],
        ]);
        for (const id of ["setup-pi-a", "setup-pi-b", "setup-pi-c", "setup-other"]) {
            stopTranscriptStream(id);
        }
    });

    it("asks for a stream that outlives the server's default request timeout", async () => {
        const { startTranscriptStream, stopTranscriptStream } = await import("./livetranscript");
        startTranscriptStream("setup-timeout", "/p/t.jsonl", "claude");
        expect(streamOpts).toEqual([{ timeout: 31536000000 }]);
        stopTranscriptStream("setup-timeout");
    });
});

describe("stream chunks", () => {
    const readStore = async () => {
        const store = (await import("@/app/store/jotaiStore")) as unknown as { __store: Map<any, any> };
        const atoms = await import("./livetranscriptatoms");
        const get = (a: any) => store.__store.get(a) ?? {};
        return {
            live: () => get(atoms.liveEntriesByIdAtom),
            activity: () => get(atoms.lastActivityByIdAtom),
            tasks: () => get(atoms.tasksByIdAtom),
            waiting: () => get(atoms.waitingByIdAtom),
        };
    };

    it("keeps the agent's waiting queue from its queue-operation records, and drops it with the stream", async () => {
        const feed = makeFeedGen();
        genFactory = () => feed.gen;
        const { startTranscriptStream, stopTranscriptStream } = await import("./livetranscript");
        const s = await readStore();
        const op = (operation: string, extra: object) =>
            JSON.stringify({ type: "queue-operation", operation, timestamp: "2026-11-17T09:00:00.000Z", ...extra });
        startTranscriptStream("chunk-queue", "/p/q.jsonl", "claude");
        feed.push(["{}"]);
        await settle();
        expect(Object.keys(s.waiting())).not.toContain("chunk-queue");
        feed.push([op("enqueue", { content: "typed in the terminal" })]);
        await settle();
        expect(s.waiting()["chunk-queue"]?.map((w: { text: string }) => w.text)).toEqual(["typed in the terminal"]);
        feed.push([op("remove", { content: "typed in the terminal", reason: "absorbed_mid_turn" })]);
        await settle();
        expect(s.waiting()["chunk-queue"]).toEqual([]);
        stopTranscriptStream("chunk-queue");
        expect(Object.keys(s.waiting())).not.toContain("chunk-queue");
    });

    it("stops projecting once the stream is stopped, even for a chunk already in flight", async () => {
        const feed = makeFeedGen();
        genFactory = () => feed.gen;
        const { startTranscriptStream, stopTranscriptStream } = await import("./livetranscript");
        const s = await readStore();
        startTranscriptStream("chunk-cancel", "/p/c.jsonl", "claude");
        feed.push(["a"]);
        await settle();
        expect(s.live()["chunk-cancel"]).toEqual([{ kind: "message", text: "1" }]);
        stopTranscriptStream("chunk-cancel");
        feed.push(["b"]);
        await settle();
        expect(s.live()["chunk-cancel"]).toBeUndefined();
        expect(s.activity()["chunk-cancel"]).toBeUndefined();
    });

    it("skips a chunk with no lines", async () => {
        const feed = makeFeedGen();
        genFactory = () => feed.gen;
        const { startTranscriptStream, stopTranscriptStream } = await import("./livetranscript");
        const s = await readStore();
        startTranscriptStream("chunk-empty", "/p/e.jsonl", "claude");
        feed.push([]);
        await settle();
        expect(s.live()["chunk-empty"]).toBeUndefined();
        expect(s.activity()["chunk-empty"]).toBeUndefined();
        feed.push(["x"]);
        await settle();
        expect(s.live()["chunk-empty"]).toEqual([{ kind: "message", text: "1" }]);
        stopTranscriptStream("chunk-empty");
    });

    it("stamps each stream's last activity with the time its chunk arrived", async () => {
        const feeds: ReturnType<typeof makeFeedGen>[] = [];
        genFactory = () => {
            const f = makeFeedGen();
            feeds.push(f);
            return f.gen;
        };
        const now = vi.spyOn(Date, "now").mockReturnValue(12345);
        try {
            const { startTranscriptStream, stopTranscriptStream } = await import("./livetranscript");
            const s = await readStore();
            startTranscriptStream("chunk-act-1", "/p/a1.jsonl", "claude");
            startTranscriptStream("chunk-act-2", "/p/a2.jsonl", "claude");
            feeds[0].push(["a"]);
            feeds[1].push(["b"]);
            await settle();
            expect(s.activity()["chunk-act-1"]).toBe(12345);
            expect(s.activity()["chunk-act-2"]).toBe(12345);
            stopTranscriptStream("chunk-act-1");
            stopTranscriptStream("chunk-act-2");
        } finally {
            now.mockRestore();
        }
    });

    it("records a task list only when the projector extracts one", async () => {
        const feed = makeFeedGen();
        genFactory = () => feed.gen;
        const list = [{ text: "write tests", done: false }];
        projectorOverride = {
            projectRecords: () => [],
            extractTasks: (r: unknown[]) => (r.length > 1 ? list : undefined),
        };
        const { startTranscriptStream, stopTranscriptStream } = await import("./livetranscript");
        const s = await readStore();
        startTranscriptStream("chunk-tasks", "/p/k.jsonl", "claude");
        feed.push(["a"]);
        await settle();
        expect(Object.keys(s.tasks())).not.toContain("chunk-tasks");
        feed.push(["b"]);
        await settle();
        expect(s.tasks()["chunk-tasks"]).toEqual(list);
        stopTranscriptStream("chunk-tasks");
    });

    it("parses each line once: a later chunk's projection gets the same record objects", async () => {
        const feed = makeFeedGen();
        genFactory = () => feed.gen;
        const seen: unknown[][] = [];
        const tasksSeen: unknown[][] = [];
        projectorOverride = {
            projectRecords: (r: unknown[]) => (seen.push([...r]), []),
            extractTasks: (r: unknown[]) => (tasksSeen.push([...r]), undefined),
        };
        const { startTranscriptStream, stopTranscriptStream } = await import("./livetranscript");
        startTranscriptStream("chunk-once", "/p/once.jsonl", "claude");
        feed.push(['{"n":1}', "not json"]);
        await settle();
        feed.push(['{"n":2}']);
        await settle();
        expect(seen).toHaveLength(2);
        expect(seen[0]).toEqual([{ n: 1 }, undefined]);
        expect(seen[1]).toEqual([{ n: 1 }, undefined, { n: 2 }]);
        expect(seen[1][0]).toBe(seen[0][0]);
        // both passes of a chunk read the same records
        expect(tasksSeen[1][2]).toBe(seen[1][2]);
        stopTranscriptStream("chunk-once");
    });

    it("frees the id once its stream ends, so the id can be opened again", async () => {
        genFactory = () => makeChunkGen([["a"]]);
        const { startTranscriptStream, stopTranscriptStream } = await import("./livetranscript");
        startTranscriptStream("chunk-end", "/p/z.jsonl", "claude");
        await new Promise((r) => setTimeout(r, 10));
        startTranscriptStream("chunk-end", "/p/z.jsonl", "claude");
        expect(openCount).toBe(2);
        await new Promise((r) => setTimeout(r, 10));
        stopTranscriptStream("chunk-end");
    });
});

const uuidLine = (i: number) => JSON.stringify({ uuid: `u${i}` });
const uuidLines = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => uuidLine(from + k));
const uuidsOf = (records: unknown[]) => records.map((r: any) => r?.uuid);

describe("mergeFullRead", () => {
    it("keeps the full read in file order and adds only the streamed records it does not hold", async () => {
        const { mergeFullRead } = await import("./livetranscript");
        const full = [{ uuid: "a" }, { uuid: "b" }, { uuid: "c" }];
        const during = [{ uuid: "c" }, { uuid: "d" }, { uuid: "e" }];
        expect(uuidsOf(mergeFullRead(full, during))).toEqual(["a", "b", "c", "d", "e"]);
    });

    it("returns the full read alone when nothing streamed during it", async () => {
        const { mergeFullRead } = await import("./livetranscript");
        expect(uuidsOf(mergeFullRead([{ uuid: "a" }], []))).toEqual(["a"]);
    });
});

describe("earlier turns", () => {
    const earlier = async () => {
        const store = (await import("@/app/store/jotaiStore")) as unknown as { __store: Map<any, any> };
        const atoms = await import("./livetranscriptatoms");
        return store.__store.get(atoms.earlierByIdAtom) ?? {};
    };

    it("marks a non-pi agent whose first chunk is a full tail", async () => {
        const feed = makeFeedGen();
        genFactory = () => feed.gen;
        const { startTranscriptStream, stopTranscriptStream } = await import("./livetranscript");
        startTranscriptStream("early-full", "/p/early-full.jsonl", "claude");
        feed.push(uuidLines(0, 300));
        await settle();
        expect((await earlier())["early-full"]).toBe("hidden");
        stopTranscriptStream("early-full");
    });

    it("does not mark a short first chunk, even when a later chunk is long", async () => {
        const feed = makeFeedGen();
        genFactory = () => feed.gen;
        const { startTranscriptStream, stopTranscriptStream } = await import("./livetranscript");
        startTranscriptStream("early-short", "/p/early-short.jsonl", "claude");
        feed.push(uuidLines(0, 299));
        await settle();
        feed.push(uuidLines(299, 700));
        await settle();
        expect("early-short" in (await earlier())).toBe(false);
        stopTranscriptStream("early-short");
    });

    it("does not mark a pi session, which reads the whole file", async () => {
        const feed = makeFeedGen();
        genFactory = () => feed.gen;
        const { startTranscriptStream, stopTranscriptStream } = await import("./livetranscript");
        startTranscriptStream("early-pi", "/home/u/.pi/agent/sessions/early.jsonl", "pi");
        feed.push(uuidLines(0, 300));
        await settle();
        expect("early-pi" in (await earlier())).toBe(false);
        stopTranscriptStream("early-pi");
    });
});

describe("showEarlierTranscript", () => {
    const setup = async (id: string) => {
        const feed = makeFeedGen();
        genFactory = () => feed.gen;
        let projected: unknown[] = [];
        projectorOverride = {
            projectRecords: (r: unknown[]) => ((projected = [...r]), []),
            extractTasks: () => undefined,
        };
        const live = await import("./livetranscript");
        const store = (await import("@/app/store/jotaiStore")) as unknown as { __store: Map<any, any> };
        const atoms = await import("./livetranscriptatoms");
        live.startTranscriptStream(id, `/p/${id}.jsonl`, "claude");
        feed.push(uuidLines(100, 400));
        await settle();
        return {
            feed,
            live,
            projected: () => projected,
            earlier: () => (store.__store.get(atoms.earlierByIdAtom) ?? {})[id],
        };
    };

    it("reads the whole file once and merges it with the records streamed during the read", async () => {
        const t = await setup("earlier-merge");
        void t.live.showEarlierTranscript("earlier-merge");
        void t.live.showEarlierTranscript("earlier-merge");
        expect(fullReads.map((r) => r.data)).toEqual([{ path: "/p/earlier-merge.jsonl", maxlines: -1 }]);
        expect(t.earlier()).toBe("loading");
        // u400 was written before the read reached the end of the file, u401 after
        t.feed.push([uuidLine(400), uuidLine(401)]);
        await settle();
        fullReads[0].resolve(uuidLines(0, 401));
        await settle();
        expect(uuidsOf(t.projected())).toEqual(uuidsOf(uuidLines(0, 402).map((l) => JSON.parse(l))));
        expect(t.earlier()).toBe("shown");
        t.feed.push([uuidLine(402)]);
        await settle();
        expect(uuidsOf(t.projected()).slice(-3)).toEqual(["u400", "u401", "u402"]);
        t.live.stopTranscriptStream("earlier-merge");
    });

    it("stops capping retention once the whole file is read", async () => {
        const t = await setup("earlier-uncapped");
        void t.live.showEarlierTranscript("earlier-uncapped");
        fullReads[0].resolve(uuidLines(0, 4500));
        await settle();
        t.feed.push([uuidLine(4500)]);
        await settle();
        expect(t.projected()).toHaveLength(4501);
        expect((t.projected()[0] as any).uuid).toBe("u0");
        t.live.stopTranscriptStream("earlier-uncapped");
    });

    it("keeps the tail and offers the control again when the read fails", async () => {
        const t = await setup("earlier-fail");
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            void t.live.showEarlierTranscript("earlier-fail");
            fullReads[0].reject(new Error("boom"));
            await settle();
            expect(t.earlier()).toBe("hidden");
            expect(t.projected()).toHaveLength(300);
            void t.live.showEarlierTranscript("earlier-fail");
            expect(fullReads).toHaveLength(2);
        } finally {
            err.mockRestore();
            t.live.stopTranscriptStream("earlier-fail");
        }
    });

    it("drops a read that lands after its stream stopped", async () => {
        const t = await setup("earlier-stopped");
        void t.live.showEarlierTranscript("earlier-stopped");
        t.live.stopTranscriptStream("earlier-stopped");
        fullReads[0].resolve(uuidLines(0, 400));
        await settle();
        expect(t.projected()).toHaveLength(300);
        expect(t.earlier()).toBeUndefined();
    });
});

describe("restartActiveStreams and earlier turns", () => {
    // restart re-opens every stream still in the module's map, so each open gets its own feed, found by its path
    const setup = async (id: string) => {
        const feeds: ReturnType<typeof makeFeedGen>[] = [];
        genFactory = () => {
            const f = makeFeedGen();
            feeds.push(f);
            return f.gen;
        };
        let projected: unknown[] = [];
        projectorOverride = {
            projectRecords: (r: unknown[]) => ((projected = [...r]), []),
            extractTasks: () => undefined,
        };
        const live = await import("./livetranscript");
        const store = (await import("@/app/store/jotaiStore")) as unknown as { __store: Map<any, any> };
        const atoms = await import("./livetranscriptatoms");
        const path = `/p/${id}.jsonl`;
        const opens = () => streamCalls.map((c, i) => ({ ...c, feed: feeds[i] })).filter((c) => c.path === path);
        live.startTranscriptStream(id, path, "claude");
        opens()[0].feed.push(uuidLines(100, 400));
        await settle();
        return {
            live,
            opens,
            latest: () => opens()[opens().length - 1],
            projected: () => projected,
            earlier: () => (store.__store.get(atoms.earlierByIdAtom) ?? {})[id],
        };
    };

    it("keeps a stream that read the whole file whole: full re-read, still shown, retention uncapped", async () => {
        const t = await setup("restart-whole");
        void t.live.showEarlierTranscript("restart-whole");
        fullReads[0].resolve(uuidLines(0, 400));
        await settle();
        expect(t.earlier()).toBe("shown");
        t.live.restartActiveStreams();
        expect(t.opens()).toHaveLength(2);
        expect(t.latest().taillines).toBe(-1);
        t.latest().feed.push(uuidLines(0, 4500));
        await settle();
        expect(t.earlier()).toBe("shown");
        t.latest().feed.push([uuidLine(4500)]);
        await settle();
        expect(t.projected()).toHaveLength(4501);
        expect((t.projected()[0] as any).uuid).toBe("u0");
        t.live.stopTranscriptStream("restart-whole");
    });

    it("restarts a tail stream that is not whole as a tail, marked hidden by a full first chunk", async () => {
        const t = await setup("restart-tail");
        expect(t.earlier()).toBe("hidden");
        t.live.restartActiveStreams();
        expect(t.latest().taillines).toBe(300);
        t.latest().feed.push(uuidLines(100, 400));
        await settle();
        expect(t.earlier()).toBe("hidden");
        t.latest().feed.push(uuidLines(400, 4500));
        await settle();
        expect(t.projected()).toHaveLength(4000);
        t.live.stopTranscriptStream("restart-tail");
    });

    it("lets the restarted stream's first chunk settle a read that was in flight", async () => {
        const t = await setup("restart-inflight");
        void t.live.showEarlierTranscript("restart-inflight");
        expect(t.earlier()).toBe("loading");
        t.live.restartActiveStreams();
        expect(t.latest().taillines).toBe(300);
        // the read lands after its stream was replaced and is dropped
        fullReads[0].resolve(uuidLines(0, 400));
        await settle();
        t.latest().feed.push(uuidLines(100, 400));
        await settle();
        expect(t.earlier()).toBe("hidden");
        expect(t.projected()).toHaveLength(300);
        // the control works again on the new stream
        void t.live.showEarlierTranscript("restart-inflight");
        expect(fullReads).toHaveLength(2);
        t.live.stopTranscriptStream("restart-inflight");
    });
});
