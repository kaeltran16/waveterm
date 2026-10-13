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
        ["malformed", JSON.stringify("abc")],
        ["nonpositive", JSON.stringify(0)],
        ["negative", JSON.stringify(-5)],
        ["future", JSON.stringify(T0 + 1000)],
    ])("falls back to seven days ago for a %s cursor", async (_name, stored) => {
        lsMock.store.set("jarvis.briefing.lastseen", stored);
        mockStateRpc(completeState());
        await loadBriefingAsync();
        expect(RpcApi.JarvisStateCommand).toHaveBeenCalledWith(expect.anything(), {
            project: "",
            sincems: T0 - SEVEN_DAYS_MS,
        }, { timeout: 180_000 });
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
});
