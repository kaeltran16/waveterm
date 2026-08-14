// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { JarvisStateCommand: vi.fn(), JarvisAskCommand: vi.fn() } }));
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
    askAcrossWorkAsync,
    briefingAnswerAtom,
    briefingAskStateAtom,
    briefingCursorAtom,
    briefingStateAtom,
    loadBriefingAsync,
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
        globalStore.set(briefingAskStateAtom, "idle");
        globalStore.set(briefingAnswerAtom, null);
        vi.spyOn(Date, "now").mockReturnValue(T0);
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockReset();
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockReset();
    });

    it("first use falls back to seven days ago and stores the query start on success", async () => {
        mockStateRpc(completeState());
        await loadBriefingAsync();
        expect(RpcApi.JarvisStateCommand).toHaveBeenCalledWith(expect.anything(), {
            project: "",
            sincems: T0 - SEVEN_DAYS_MS,
        });
        expect(globalStore.get(briefingCursorAtom)).toBe(T0);
        const st = globalStore.get(briefingStateAtom);
        expect(st.snapshot?.complete).toBe(true);
        expect(st.snapshot?.cursorSaved).toBe(true);
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
        });
    });

    it("advances from queryStartedAt, never response time", async () => {
        let resolve!: (v: CommandJarvisStateRtnData) => void;
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((r) => (resolve = r)));
        const pending = loadBriefingAsync();
        vi.spyOn(Date, "now").mockReturnValue(T0 + 60_000); // the response lands a minute later
        resolve({ state: completeState() });
        await pending;
        expect(globalStore.get(briefingCursorAtom)).toBe(T0);
    });

    it("does not advance on RPC failure and keeps the previous snapshot", async () => {
        globalStore.set(briefingCursorAtom, T0 - DAY);
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc broke"));
        await loadBriefingAsync();
        expect(globalStore.get(briefingCursorAtom)).toBe(T0 - DAY);
        expect(globalStore.get(briefingStateAtom).error).toBeTruthy();
    });

    it("does not advance on partial source health but still renders the snapshot", async () => {
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
        expect(globalStore.get(briefingCursorAtom)).toBe(T0 - DAY);
    });

    it("discards a stale generation's snapshot and cursor write", async () => {
        let resolveA!: (v: CommandJarvisStateRtnData) => void;
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((r) => (resolveA = r)));
        const a = loadBriefingAsync();
        mockStateRpc(completeState()); // generation B resolves immediately
        await loadBriefingAsync();
        resolveA({ state: completeState() }); // generation A lands late
        await a;
        expect(globalStore.get(briefingCursorAtom)).toBe(T0);
        expect(globalStore.get(briefingStateAtom).snapshot?.queryStartedAt).toBe(T0);
    });

    it("keeps the accepted snapshot and flags the unsaved marker when localStorage writes fail", async () => {
        lsMock.failWrites = true;
        try {
            mockStateRpc(completeState());
            await loadBriefingAsync();
            const st = globalStore.get(briefingStateAtom);
            expect(st.snapshot?.complete).toBe(true);
            expect(st.snapshot?.cursorSaved).toBe(false);
        } finally {
            lsMock.failWrites = false;
        }
    });

    it("never regresses a cursor another window already advanced", async () => {
        globalStore.set(briefingCursorAtom, T0 + 10_000);
        mockStateRpc(completeState());
        await loadBriefingAsync();
        expect(globalStore.get(briefingCursorAtom)).toBe(T0 + 10_000);
    });

    it("is pending while in flight, then answered with answer and sources", async () => {
        let resolve!: (v: CommandJarvisAskRtnData) => void;
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((r) => (resolve = r)));
        const p = askAcrossWorkAsync("what is moving?");
        expect(globalStore.get(briefingAskStateAtom)).toBe("pending");
        resolve({
            answer: "the briefing run",
            sources: [{ oref: "run:r-1", sourcetype: "status", title: "the briefing run" }],
            terminal: "answered",
        });
        await p;
        expect(globalStore.get(briefingAskStateAtom)).toBe("answered");
        expect(globalStore.get(briefingAnswerAtom)?.answer).toBe("the briefing run");
        expect(RpcApi.JarvisAskCommand).toHaveBeenCalledWith(
            expect.anything(),
            { prompt: "what is moving?", cwd: "" },
            { timeout: 180_000 }
        );
    });

    it("renders the error state on RPC failure and keeps the prior answer", async () => {
        globalStore.set(briefingAnswerAtom, { answer: "prior", sources: [], terminal: "answered" });
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ask broke"));
        await askAcrossWorkAsync("status?");
        expect(globalStore.get(briefingAskStateAtom)).toBe("error");
        expect(globalStore.get(briefingAnswerAtom)?.answer).toBe("prior");
    });

    it("a newer ask supersedes a slower one", async () => {
        let resolveA!: (v: CommandJarvisAskRtnData) => void;
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((r) => (resolveA = r)));
        const a = askAcrossWorkAsync("first");
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            answer: "second answer",
            sources: [],
            terminal: "answered",
        });
        await askAcrossWorkAsync("second");
        resolveA({ answer: "first answer", sources: [], terminal: "answered" });
        await a;
        expect(globalStore.get(briefingAnswerAtom)?.answer).toBe("second answer");
    });
});
