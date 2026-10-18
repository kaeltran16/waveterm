// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { JarvisStateCommand: vi.fn() } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

const lsMock = vi.hoisted(() => {
    const store = new Map<string, string>();
    const mock = {
        store,
        failWrites: false,
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => {
            if (mock.failWrites) {
                throw new Error("quota");
            }
            store.set(k, v);
        },
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
    };
    (globalThis as any).localStorage = mock;
    (globalThis as any).window = { localStorage: mock };
    return mock;
});

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { SEVEN_DAYS_MS } from "./briefingmodel";
import {
    ackBriefingVisit,
    briefingAckAtom,
    briefingCursorAtom,
    briefingSeenMarksAtom,
    briefingStateAtom,
    loadBriefingAsync,
    markBriefingSeen,
    SEEN_HOLD_MS,
    settleSeen,
} from "./briefingstore";

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const completeState = (): WorkState => ({
    projects: [],
    sources: { runs: true, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
});

const mockStateRpc = (state: WorkState) => {
    (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ state });
};

describe("briefing cursor", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        lsMock.clear();
        lsMock.failWrites = false;
        globalStore.set(briefingCursorAtom, null);
        globalStore.set(briefingSeenMarksAtom, []);
        globalStore.set(briefingAckAtom, "idle");
        vi.spyOn(Date, "now").mockReturnValue(T0);
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockReset();
    });

    it("first use falls back to seven days ago for the fetch; the cursor moves only on acknowledge", async () => {
        mockStateRpc(completeState());
        await loadBriefingAsync();
        expect(RpcApi.JarvisStateCommand).toHaveBeenCalledWith(expect.anything(), {
            project: "",
            sincems: T0 - SEVEN_DAYS_MS,
        }, { timeout: 180_000 });
        // load alone must not mark the delta seen
        expect(globalStore.get(briefingCursorAtom)).toBe(null);
        expect(globalStore.get(briefingAckAtom)).toBe("waiting");
        const st = globalStore.get(briefingStateAtom);
        expect(st.snapshot?.complete).toBe(true);
        ackBriefingVisit();
        // the look is held, not applied: the cursor waits out the hour
        expect(globalStore.get(briefingCursorAtom)).toBe(null);
        expect(globalStore.get(briefingSeenMarksAtom)).toEqual([{ through: T0, at: T0 }]);
        expect(globalStore.get(briefingAckAtom)).toBe("saved");
    });

    it.each([
        ["malformed", "abc"],
        ["numeric string", "5"],
        ["nonpositive", 0],
        ["negative", -5],
        ["future", T0 + 1000],
        ["not a number", NaN],
        ["infinite", Infinity],
    ])("falls back to seven days ago for a %s cursor", async (_name, stored) => {
        globalStore.set(briefingCursorAtom, stored as number);
        mockStateRpc(completeState());
        await loadBriefingAsync();
        expect(RpcApi.JarvisStateCommand).toHaveBeenCalledWith(
            expect.anything(),
            {
                project: "",
                sincems: T0 - SEVEN_DAYS_MS,
            },
            { timeout: 180_000 }
        );
        expect(globalStore.get(briefingStateAtom).snapshot?.actualCursor).toBe(T0 - SEVEN_DAYS_MS);
    });

    it.each([
        ["right now", T0, T0 - SEVEN_DAYS_MS],
        ["a day ago", T0 - DAY, T0 - SEVEN_DAYS_MS],
        ["ten days ago", T0 - 10 * DAY, T0 - 10 * DAY],
    ])(
        "reads a cursor from %s as the visit and fetches from the earlier of it and seven days ago",
        async (_name, cursor, since) => {
            globalStore.set(briefingCursorAtom, cursor);
            mockStateRpc(completeState());
            await loadBriefingAsync();
            expect(RpcApi.JarvisStateCommand).toHaveBeenCalledWith(
                expect.anything(),
                {
                    project: "",
                    sincems: since,
                },
                { timeout: 180_000 }
            );
            expect(globalStore.get(briefingStateAtom).snapshot?.actualCursor).toBe(cursor);
        }
    );

    it("shows the load in progress over the previous snapshot with the old error cleared", async () => {
        mockStateRpc(completeState());
        await loadBriefingAsync();
        const previous = globalStore.get(briefingStateAtom).snapshot;
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("rpc broke"));
        await loadBriefingAsync();
        expect(globalStore.get(briefingStateAtom).error).toBe("rpc broke");
        let resolve!: (v: CommandJarvisStateRtnData) => void;
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((r) => (resolve = r)));
        const pending = loadBriefingAsync();
        expect(globalStore.get(briefingStateAtom)).toStrictEqual({ snapshot: previous, loading: true, error: null });
        resolve({ state: completeState() });
        await pending;
    });

    it("ends a failed load not loading, with the error text and the previous snapshot", async () => {
        mockStateRpc(completeState());
        await loadBriefingAsync();
        const previous = globalStore.get(briefingStateAtom).snapshot;
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc broke"));
        await loadBriefingAsync();
        expect(globalStore.get(briefingStateAtom)).toStrictEqual({
            snapshot: previous,
            loading: false,
            error: "rpc broke",
        });
    });

    it("is not complete when the records leg is missing, even with the runs leg present", async () => {
        mockStateRpc({
            projects: [],
            sources: { runs: true, sessions: true, dossiers: false, efforts: true, attention: "volatile" },
        });
        await loadBriefingAsync();
        expect(globalStore.get(briefingStateAtom).snapshot?.complete).toBe(false);
    });

    it("writes nothing to storage when no seen mark is due", async () => {
        globalStore.set(briefingCursorAtom, T0 - DAY);
        globalStore.set(briefingSeenMarksAtom, [{ through: T0 - 1000, at: T0 - 1000 }]);
        const setItem = vi.spyOn(lsMock, "setItem");
        mockStateRpc(completeState());
        await loadBriefingAsync();
        expect(setItem).not.toHaveBeenCalled();
    });

    it("drops a due mark that is behind the cursor without moving the cursor", async () => {
        globalStore.set(briefingCursorAtom, T0 - 1000);
        globalStore.set(briefingSeenMarksAtom, [{ through: T0 - DAY, at: T0 - DAY }]);
        mockStateRpc(completeState());
        await loadBriefingAsync();
        expect(globalStore.get(briefingCursorAtom)).toBe(T0 - 1000);
        expect(globalStore.get(briefingSeenMarksAtom)).toEqual([]);
    });

    it("acknowledgment advances from queryStartedAt, never response time", async () => {
        let resolve!: (v: CommandJarvisStateRtnData) => void;
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((r) => (resolve = r)));
        const pending = loadBriefingAsync();
        vi.spyOn(Date, "now").mockReturnValue(T0 + 60_000); // the response lands a minute later
        resolve({ state: completeState() });
        await pending;
        ackBriefingVisit();
        expect(globalStore.get(briefingSeenMarksAtom)).toEqual([{ through: T0, at: T0 + 60_000 }]);
    });

    it("does not advance on RPC failure and keeps the previous snapshot", async () => {
        globalStore.set(briefingCursorAtom, T0 - DAY);
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc broke"));
        await loadBriefingAsync();
        expect(globalStore.get(briefingCursorAtom)).toBe(T0 - DAY);
        expect(globalStore.get(briefingStateAtom).error).toBeTruthy();
    });

    it("does not advance on partial source health; acknowledge is a no-op", async () => {
        globalStore.set(briefingCursorAtom, T0 - DAY);
        const partial: WorkState = {
            projects: [],
            sources: { runs: false, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
        };
        mockStateRpc(partial);
        await loadBriefingAsync();
        const st = globalStore.get(briefingStateAtom);
        expect(st.snapshot?.complete).toBe(false);
        expect(st.snapshot?.state.sources.runs).toBe(false);
        ackBriefingVisit();
        expect(globalStore.get(briefingCursorAtom)).toBe(T0 - DAY);
        expect(globalStore.get(briefingSeenMarksAtom)).toEqual([]);
        expect(globalStore.get(briefingAckAtom)).toBe("waiting");
    });

    it("a stale generation's snapshot is discarded and acknowledgment uses the current one", async () => {
        let resolveA!: (v: CommandJarvisStateRtnData) => void;
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((r) => (resolveA = r)));
        const a = loadBriefingAsync();
        mockStateRpc(completeState()); // generation B resolves immediately
        await loadBriefingAsync();
        resolveA({ state: completeState() }); // generation A lands late
        await a;
        ackBriefingVisit();
        expect(globalStore.get(briefingSeenMarksAtom)).toEqual([{ through: T0, at: T0 }]);
        expect(globalStore.get(briefingStateAtom).snapshot?.queryStartedAt).toBe(T0);
    });

    it("a stale generation's late snapshot does not overwrite the current one", async () => {
        let resolveA!: (v: CommandJarvisStateRtnData) => void;
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((r) => (resolveA = r)));
        const a = loadBriefingAsync();
        mockStateRpc(completeState()); // generation B resolves immediately
        await loadBriefingAsync();
        resolveA({
            state: {
                projects: [],
                sources: { runs: false, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
            },
        }); // generation A lands late, and looks different
        await a;
        const st = globalStore.get(briefingStateAtom);
        expect(st.snapshot?.complete).toBe(true);
        expect(st.loading).toBe(false);
        expect(st.error).toBeNull();
    });

    it("a stale generation's late failure does not set an error on the current load", async () => {
        let rejectA!: (e: Error) => void;
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce(
            new Promise((_r, rej) => (rejectA = rej))
        );
        const a = loadBriefingAsync();
        mockStateRpc(completeState());
        await loadBriefingAsync();
        rejectA(new Error("late failure"));
        await a;
        const st = globalStore.get(briefingStateAtom);
        expect(st.error).toBeNull();
        expect(st.snapshot?.complete).toBe(true);
    });

    it("flags the unsaved marker when localStorage writes fail during acknowledgment", async () => {
        lsMock.failWrites = true;
        try {
            mockStateRpc(completeState());
            await loadBriefingAsync();
            expect(globalStore.get(briefingStateAtom).snapshot?.complete).toBe(true);
            ackBriefingVisit();
            expect(globalStore.get(briefingAckAtom)).toBe("failed");
            expect(globalStore.get(briefingStateAtom).error).toBeNull();
        } finally {
            lsMock.failWrites = false;
        }
    });

    it("never regresses a cursor another window already advanced", async () => {
        globalStore.set(briefingCursorAtom, T0 + 10_000);
        mockStateRpc(completeState());
        await loadBriefingAsync();
        ackBriefingVisit();
        expect(globalStore.get(briefingCursorAtom)).toBe(T0 + 10_000);
        expect(globalStore.get(briefingSeenMarksAtom)).toEqual([]);
    });

    it("acknowledging before any load does nothing", async () => {
        vi.resetModules();
        const fresh = await import("./briefingstore");
        const { globalStore: freshStore } = await import("@/app/store/jotaiStore");
        expect(() => fresh.ackBriefingVisit()).not.toThrow();
        expect(freshStore.get(fresh.briefingAckAtom)).toBe("idle");
        expect(freshStore.get(fresh.briefingSeenMarksAtom)).toEqual([]);
    });

    it("does not stack a mark that reaches only as far as a mark already held", async () => {
        const held = { through: T0, at: T0 - 1000 };
        globalStore.set(briefingSeenMarksAtom, [held]);
        mockStateRpc(completeState());
        await loadBriefingAsync();
        ackBriefingVisit();
        expect(globalStore.get(briefingSeenMarksAtom)).toEqual([held]);
        expect(globalStore.get(briefingAckAtom)).toBe("saved");
    });

    it("does not add a mark that reaches only as far as the cursor", async () => {
        globalStore.set(briefingCursorAtom, T0);
        mockStateRpc(completeState());
        await loadBriefingAsync();
        ackBriefingVisit();
        expect(globalStore.get(briefingSeenMarksAtom)).toEqual([]);
        expect(globalStore.get(briefingAckAtom)).toBe("saved");
    });

    it.each([
        ["malformed", "abc"],
        ["not a number", NaN],
        ["infinite", Infinity],
    ])("treats a %s stored cursor as no cursor when acknowledging", async (_name, stored) => {
        globalStore.set(briefingCursorAtom, stored as number);
        mockStateRpc(completeState());
        await loadBriefingAsync();
        ackBriefingVisit();
        expect(globalStore.get(briefingSeenMarksAtom)).toEqual([{ through: T0, at: T0 }]);
    });

    it("keeps seen rows for the hold, then clears them on the next load", async () => {
        globalStore.set(briefingCursorAtom, T0 - DAY);
        mockStateRpc(completeState());
        await loadBriefingAsync();
        ackBriefingVisit();

        vi.spyOn(Date, "now").mockReturnValue(T0 + SEEN_HOLD_MS - 1);
        await loadBriefingAsync();
        expect(globalStore.get(briefingStateAtom).snapshot?.actualCursor).toBe(T0 - DAY);

        vi.spyOn(Date, "now").mockReturnValue(T0 + SEEN_HOLD_MS);
        await loadBriefingAsync();
        expect(globalStore.get(briefingStateAtom).snapshot?.actualCursor).toBe(T0);
        expect(globalStore.get(briefingCursorAtom)).toBe(T0);
        expect(globalStore.get(briefingSeenMarksAtom)).toEqual([]);
    });

    it("holds each look on its own clock, so a later look does not delay an earlier one", async () => {
        mockStateRpc(completeState());
        await loadBriefingAsync();
        ackBriefingVisit(); // seen through T0 at T0

        vi.spyOn(Date, "now").mockReturnValue(T0 + SEEN_HOLD_MS / 2);
        await loadBriefingAsync();
        ackBriefingVisit(); // seen through T0 + half the hold

        vi.spyOn(Date, "now").mockReturnValue(T0 + SEEN_HOLD_MS);
        await loadBriefingAsync();
        expect(globalStore.get(briefingStateAtom).snapshot?.actualCursor).toBe(T0);
        expect(globalStore.get(briefingSeenMarksAtom)).toEqual([
            { through: T0 + SEEN_HOLD_MS / 2, at: T0 + SEEN_HOLD_MS / 2 },
        ]);
    });

    it("mark seen clears at once and its undo restores the held marks", async () => {
        globalStore.set(briefingCursorAtom, T0 - DAY);
        mockStateRpc(completeState());
        await loadBriefingAsync();
        ackBriefingVisit();
        const undo = markBriefingSeen();
        expect(globalStore.get(briefingCursorAtom)).toBe(T0);
        expect(globalStore.get(briefingSeenMarksAtom)).toEqual([]);
        undo();
        expect(globalStore.get(briefingCursorAtom)).toBe(T0 - DAY);
        expect(globalStore.get(briefingSeenMarksAtom)).toEqual([{ through: T0, at: T0 }]);
    });
});

describe("settleSeen", () => {
    it("never moves the cursor back for a mark behind it", () => {
        expect(settleSeen(T0, [{ through: T0 - DAY, at: T0 - DAY }], T0)).toEqual({ cursor: T0, marks: [] });
    });

    it("drops malformed marks from storage", () => {
        expect(settleSeen(null, [{ through: "x" } as unknown as { through: number; at: number }], T0)).toEqual({
            cursor: null,
            marks: [],
        });
    });

    it("ignores a mark whose through or at is not a finite number", () => {
        const marks = [
            { through: "x", at: T0 - 2 * SEEN_HOLD_MS },
            { through: T0, at: "1" },
        ] as unknown as { through: number; at: number }[];
        expect(settleSeen(null, marks, T0)).toEqual({ cursor: null, marks: [] });
    });

    it("moves the cursor to the latest due mark and keeps the marks still held", () => {
        const held = { through: T0, at: T0 - SEEN_HOLD_MS + 1 };
        const marks = [{ through: T0 - 2 * DAY, at: T0 - 2 * DAY }, { through: T0 - DAY, at: T0 - DAY }, held];
        expect(settleSeen(T0 - 3 * DAY, marks, T0)).toEqual({ cursor: T0 - DAY, marks: [held] });
    });

    it("lets a due mark seed an empty cursor whatever its value", () => {
        expect(settleSeen(null, [{ through: 0, at: 0 }], T0)).toEqual({ cursor: 0, marks: [] });
    });
});
