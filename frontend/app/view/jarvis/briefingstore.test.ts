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
    ackBriefingVisit,
    askAcrossWorkAsync,
    briefDraftAtom,
    briefingAckAtom,
    briefingAnswerAtom,
    briefingAskStateAtom,
    briefingCursorAtom,
    briefingStateAtom,
    briefScopeAtom,
    briefThreadAtom,
    clearBriefThread,
    hydrateBriefThread,
    loadBriefingAsync,
    primeBriefThread,
} from "./briefingstore";
import { isAnswerTurn, type JarvisConversation, type SourceRef } from "./jarviscontract";

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const completeState = (): WorkState => ({
    projects: [],
    sources: { runs: true, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
});

const mockStateRpc = (state: WorkState) => {
    (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ state });
};

// one wire grounding card, in the generated lowercase-key shape the RPC actually returns
const wireCard = (over: Partial<JarvisConvoGroundingCard> = {}): JarvisConvoGroundingCard => ({
    n: 1,
    sourcetype: "run",
    title: "a run",
    project: "waveterm",
    agems: 1000,
    freshness: "fresh",
    navtarget: "run:r-1",
    ...over,
});

describe("briefing cursor", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        lsMock.clear();
        lsMock.failWrites = false;
        globalStore.set(briefingCursorAtom, null);
        globalStore.set(briefingAskStateAtom, "idle");
        globalStore.set(briefingAnswerAtom, null);
        globalStore.set(briefDraftAtom, "");
        globalStore.set(briefThreadAtom, []);
        globalStore.set(briefScopeAtom, { mode: "all", chips: [], attached: [] });
        globalStore.set(briefingAckAtom, "idle");
        vi.spyOn(Date, "now").mockReturnValue(T0);
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockReset();
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockReset();
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
        expect(globalStore.get(briefingCursorAtom)).toBe(T0);
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
        expect(globalStore.get(briefingCursorAtom)).toBe(T0);
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
        expect(globalStore.get(briefingCursorAtom)).toBe(T0);
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
    });

    it("is pending while in flight, then answered with answer and grounding", async () => {
        let resolve!: (v: CommandJarvisAskRtnData) => void;
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((r) => (resolve = r)));
        const p = askAcrossWorkAsync("what is moving?");
        expect(globalStore.get(briefingAskStateAtom)).toBe("pending");
        resolve({
            answer: "the briefing run",
            grounding: [
                {
                    n: 1,
                    sourcetype: "status",
                    title: "the briefing run",
                    project: "waveterm",
                    agems: 5000,
                    freshness: "fresh",
                    navtarget: "run:r-1",
                },
            ],
            terminal: "answered",
        });
        await p;
        expect(globalStore.get(briefingAskStateAtom)).toBe("answered");
        expect(globalStore.get(briefingAnswerAtom)?.answer).toBe("the briefing run");
        // the wire card is mapped to the view-model card here, freshness included — the band has no other
        // live source for a reading, and a lossy re-derivation is what used to force "unverified"
        expect(globalStore.get(briefingAnswerAtom)?.grounding).toEqual([
            {
                n: 1,
                sourceType: "status",
                title: "the briefing run",
                project: "waveterm",
                ageMs: 5000,
                freshness: "fresh",
                navTarget: "run:r-1",
            },
        ]);
        expect(RpcApi.JarvisAskCommand).toHaveBeenCalledWith(
            expect.anything(),
            { prompt: "what is moving?", cwd: "", attachedorefs: [] },
            { timeout: 180_000 }
        );
    });

    it("sends every attached oref with the stateless ask", async () => {
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
            answer: "a",
            grounding: [],
            terminal: "answered",
        });
        await askAcrossWorkAsync("why?", ["task:t1", "run:r2"]);
        expect(RpcApi.JarvisAskCommand).toHaveBeenCalledWith(
            expect.anything(),
            { prompt: "why?", cwd: "", attachedorefs: ["task:t1", "run:r2"] },
            { timeout: 180_000 }
        );
    });

    it("primes one empty attached thread before the surface mounts", () => {
        const ref = { oref: "run:r1", sourceType: "run", title: "ship it" } as SourceRef;
        primeBriefThread(
            { mode: "attached", chips: [{ label: "This Run", active: true }], attached: [ref] },
            "What changed?"
        );
        expect(globalStore.get(briefDraftAtom)).toBe("What changed?");
        expect(globalStore.get(briefThreadAtom)).toEqual([]);
        expect(globalStore.get(briefScopeAtom).attached).toEqual([ref]);
    });

    it("clears every launch-local thread value", () => {
        const ref = { oref: "run:r1", sourceType: "run", title: "ship it" } as SourceRef;
        globalStore.set(briefDraftAtom, "and then?");
        globalStore.set(briefThreadAtom, [
            { key: "q1", ts: 1, turn: { role: "user", text: "why?", attachments: [ref] } },
        ]);
        globalStore.set(briefScopeAtom, {
            mode: "attached",
            chips: [{ label: "This Run", active: true }],
            attached: [ref],
        });
        globalStore.set(briefingAskStateAtom, "answered");
        globalStore.set(briefingAnswerAtom, { answer: "because", grounding: [], terminal: "answered" });

        clearBriefThread();

        expect(globalStore.get(briefDraftAtom)).toBe("");
        expect(globalStore.get(briefThreadAtom)).toEqual([]);
        expect(globalStore.get(briefScopeAtom)).toEqual({ mode: "all", chips: [], attached: [] });
        expect(globalStore.get(briefingAskStateAtom)).toBe("idle");
        expect(globalStore.get(briefingAnswerAtom)).toBeNull();
    });

    // the ledger cites a dossier as a vault: oref, which only routes as task:. Normalizing in the store
    // is what lets every consumer treat navTarget as clickable without repeating the rule.
    it("normalizes a vault citation to its routable form", async () => {
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
            answer: "a",
            grounding: [wireCard({ navtarget: "vault:d-1" })],
            terminal: "answered",
        });
        await askAcrossWorkAsync("q");
        expect(globalStore.get(briefingAnswerAtom)?.grounding[0].navTarget).toBe("task:d-1");
    });

    // a freshness this build does not know must not be cast through: it would score undefined in the
    // Drew band's severity order and silently rank as the mildest reading there is.
    it("degrades an unrecognized freshness to unverified rather than passing it through", async () => {
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
            answer: "a",
            grounding: [wireCard({ freshness: "quantum-superposition" })],
            terminal: "answered",
        });
        await askAcrossWorkAsync("q");
        expect(globalStore.get(briefingAnswerAtom)?.grounding[0].freshness).toBe("unverified");
    });

    it("renders the error state on RPC failure and keeps the prior answer", async () => {
        globalStore.set(briefingAnswerAtom, { answer: "prior", grounding: [], terminal: "answered" });
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
            grounding: [],
            terminal: "answered",
        });
        await askAcrossWorkAsync("second");
        resolveA({ answer: "first answer", grounding: [], terminal: "answered" });
        await a;
        expect(globalStore.get(briefingAnswerAtom)?.answer).toBe("second answer");
    });
});

describe("hydrateBriefThread", () => {
    const attached: SourceRef = { oref: "run:r1", sourceType: "run", title: "ship it" };
    const conversation = (): JarvisConversation => ({
        id: "c1",
        title: "why?",
        scope: { mode: "attached", chips: [{ label: "This Run", active: true }], attached: [attached] },
        turns: [
            { role: "user", text: "why?", attachments: [attached] },
            {
                role: "jarvis",
                workingSteps: [],
                segments: [{ text: "because ", citationRef: 1 }],
                grounding: [
                    {
                        n: 1,
                        sourceType: "run",
                        title: "a run",
                        project: "waveterm",
                        ageMs: 1000,
                        freshness: "stale",
                        navTarget: "run:r-1",
                    },
                ],
                terminal: "answered",
            },
        ],
    });

    beforeEach(() => {
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockClear();
        clearBriefThread();
    });

    it("restores every turn in order without submitting a new ask", () => {
        hydrateBriefThread(conversation(), T0);
        const thread = globalStore.get(briefThreadAtom);
        expect(thread.map((e) => e.turn.role)).toEqual(["user", "jarvis"]);
        expect(RpcApi.JarvisAskCommand).not.toHaveBeenCalled();
    });

    it("keeps the conversation's attached scope", () => {
        hydrateBriefThread(conversation(), T0);
        expect(globalStore.get(briefScopeAtom).attached).toEqual([attached]);
    });

    it("carries grounding and freshness onto the restored answer", () => {
        hydrateBriefThread(conversation(), T0);
        const answer = globalStore.get(briefThreadAtom)[1];
        expect(answer.turn.role).toBe("jarvis");
        expect(isAnswerTurn(answer.turn) && answer.turn.grounding[0].freshness).toBe("stale");
        expect(answer.answer?.grounding[0].freshness).toBe("stale");
    });

    it("stamps every turn with the thread's own last update, not the current clock", () => {
        hydrateBriefThread(conversation(), T0);
        expect(globalStore.get(briefThreadAtom).map((e) => e.ts)).toEqual([T0, T0]);
    });

    it("resets the launch-local ask state so a hydrated thread cannot inherit one", () => {
        primeBriefThread({ mode: "all", chips: [], attached: [] }, "leftover draft");
        globalStore.set(briefingAnswerAtom, { answer: "stale", grounding: [], terminal: "answered" });
        globalStore.set(briefingAskStateAtom, "pending");
        hydrateBriefThread(conversation(), T0);
        expect(globalStore.get(briefDraftAtom)).toBe("");
        expect(globalStore.get(briefingAnswerAtom)).toBeNull();
        expect(globalStore.get(briefingAskStateAtom)).toBe("idle");
    });
});
