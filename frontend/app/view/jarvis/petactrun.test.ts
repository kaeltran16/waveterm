// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openORef = vi.fn();
const askAboutSource = vi.fn();
const confirmPruneAllSuperseded = vi.fn();
const embedReconcile = vi.fn();
const approveGate = vi.fn();
const sendBackGate = vi.fn();

vi.mock("./openref", () => ({ openORef: (...a: any[]) => openORef(...a) }));
vi.mock("./jarvissubjectstore", () => ({ askAboutSource: (...a: any[]) => askAboutSource(...a) }));
// real atoms, not stand-in objects: the runner writes them through globalStore, and jotai's set() needs a
// genuine atom. memstore itself is mocked so this stays a test of the runner rather than of the vault store.
vi.mock("@/app/view/agents/memstore", async () => {
    const { atom } = await import("jotai");
    return {
        confirmPruneAllSuperseded: (...a: any[]) => confirmPruneAllSuperseded(...a),
        memViewAtom: atom("graph"),
        pendingMemoryFocusAtom: atom<"upkeep" | null>(null),
    };
});
vi.mock("@/app/view/agents/runactions", () => ({
    approveGate: (...a: any[]) => approveGate(...a),
    sendBackGate: (...a: any[]) => sendBackGate(...a),
}));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { EmbedReconcileCommand: (...a: any[]) => embedReconcile(...a) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
// petsources.tsx is the always-mounted driver; the runner only borrows its one read
vi.mock("./petsources", () => ({ loadIndexStatus: vi.fn(async () => true) }));

import { memViewAtom, pendingMemoryFocusAtom } from "@/app/view/agents/memstore";
import { pendingSettingsSectionAtom, SETTINGS_SECTION_EMBEDDINGS } from "@/app/view/agents/settingsstore";
import { atom } from "jotai";
import { runAct } from "./petactrun";
import type { PetAct } from "./petacts";
import { petActStateAtom, petIndexAtom, petPeekOpenAtom } from "./petstore";

// the runner only ever reads surfaceAtom off the model, so a bare atom pair is a sufficient stand-in
const model = { surfaceAtom: atom("cockpit") } as any;

afterEach(() => {
    vi.clearAllMocks();
    globalStore.set(petActStateAtom, {});
    globalStore.set(pendingMemoryFocusAtom, null);
    globalStore.set(pendingSettingsSectionAtom, null);
});

describe("runAct — escorts", () => {
    it("closes the peek before navigating, so an anchored overlay is not stranded", async () => {
        globalStore.set(petPeekOpenAtom, true);
        const act: PetAct = {
            id: "x",
            verb: "open",
            label: "Open",
            target: { kind: "oref", ref: "memnote:abc" },
        };
        await runAct(model, act);
        expect(globalStore.get(petPeekOpenAtom)).toBe(false);
        expect(openORef).toHaveBeenCalledWith(model, "memnote:abc", undefined);
    });

    it("routes the memory escort to the memory surface in list view, naming the section it wants", async () => {
        const act: PetAct = { id: "v", verb: "open", label: "Review 6", target: { kind: "memory-upkeep" } };
        await runAct(model, act);
        expect(globalStore.get(model.surfaceAtom)).toBe("memory");
        expect(globalStore.get(memViewAtom)).toBe("list");
        expect(globalStore.get(pendingMemoryFocusAtom)).toBe("upkeep");
        expect(openORef).not.toHaveBeenCalled();
    });

    it("routes the settings escort to the settings surface, naming the embeddings section", async () => {
        const act: PetAct = { id: "s", verb: "open", label: "Set up", target: { kind: "settings-embeddings" } };
        await runAct(model, act);
        expect(globalStore.get(model.surfaceAtom)).toBe("settings");
        expect(globalStore.get(pendingSettingsSectionAtom)).toBe(SETTINGS_SECTION_EMBEDDINGS);
    });
});

describe("runAct — ask", () => {
    it("seeds the question and lands on Jarvis", async () => {
        const act: PetAct = {
            id: "a",
            verb: "ask",
            label: "Ask",
            seed: { ref: "memnote:abc", sourceType: "memory", title: "a note", prompt: "Tell me more." },
        };
        await runAct(model, act);
        expect(askAboutSource).toHaveBeenCalledWith("memnote:abc", "memory", "a note", "Tell me more.");
        expect(globalStore.get(model.surfaceAtom)).toBe("jarvis");
    });
});

describe("runAct — clear superseded", () => {
    it("hands off to the existing confirm modal and keeps no state of its own", async () => {
        const act: PetAct = {
            id: "vault:clear-superseded",
            verb: "do",
            label: "Clear 2 superseded",
            op: { kind: "clear-superseded", count: 2 },
        };
        await runAct(model, act);
        expect(confirmPruneAllSuperseded).toHaveBeenCalledWith(2);
        expect(globalStore.get(petActStateAtom)["vault:clear-superseded"]).toBeUndefined();
    });

    it("records a failure on the act that caused it, never silently", async () => {
        confirmPruneAllSuperseded.mockImplementation(() => {
            throw new Error("modal host missing");
        });
        const act: PetAct = {
            id: "vault:clear-superseded",
            verb: "do",
            label: "Clear 1 superseded",
            op: { kind: "clear-superseded", count: 1 },
        };
        await runAct(model, act);
        expect(globalStore.get(petActStateAtom)["vault:clear-superseded"]).toEqual({
            status: "error",
            text: "modal host missing",
        });
    });
});

describe("runAct — catch up the index", () => {
    // fake timers so the bounded re-read burst is drivable rather than a 30-second wait, and so the
    // interval cannot outlive the test
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        globalStore.set(petIndexAtom, null);
    });

    const catchup: PetAct = {
        id: "recall:catchup",
        verb: "do",
        label: "Catch up",
        op: { kind: "reconcile-index" },
    };

    it("dispatches the reconcile and stays running, because the work outlives the call", async () => {
        embedReconcile.mockResolvedValue(undefined);
        await runAct(model, catchup);
        expect(embedReconcile).toHaveBeenCalledTimes(1);
        expect(globalStore.get(petActStateAtom)["recall:catchup"]).toEqual({
            status: "running",
            text: "catching up",
        });
    });

    it("stops watching and clears the act once the index reads ok", async () => {
        embedReconcile.mockResolvedValue(undefined);
        await runAct(model, catchup);
        globalStore.set(petIndexAtom, { state: "ok" } as EmbedIndexStatus);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(globalStore.get(petActStateAtom)["recall:catchup"]).toBeUndefined();
    });

    it("gives up after the window rather than watching forever", async () => {
        embedReconcile.mockResolvedValue(undefined);
        await runAct(model, catchup);
        globalStore.set(petIndexAtom, { state: "stale" } as EmbedIndexStatus);
        await vi.advanceTimersByTimeAsync(12 * 60_000 + 30_000);
        expect(globalStore.get(petActStateAtom)["recall:catchup"]).toBeUndefined();
    });

    it("reports a refused dispatch on the row", async () => {
        embedReconcile.mockRejectedValue(new Error("EC-TIME"));
        const act: PetAct = {
            id: "recall:retry",
            verb: "do",
            label: "Retry",
            op: { kind: "reconcile-index" },
        };
        await runAct(model, act);
        expect(globalStore.get(petActStateAtom)["recall:retry"]).toEqual({ status: "error", text: "EC-TIME" });
    });
});

describe("runAct — resolve a gate", () => {
    it("approves through the existing helper and says so on the row", async () => {
        approveGate.mockResolvedValue(undefined);
        const act: PetAct = {
            id: "gate:run1:approve",
            verb: "do",
            label: "Approve",
            op: { kind: "gate", channelId: "ch1", runId: "run1", phaseIdx: 1, action: "approve" },
        };
        await runAct(model, act);
        expect(approveGate).toHaveBeenCalledWith("ch1", "run1", 1);
        expect(globalStore.get(petActStateAtom)["gate:run1:approve"]).toEqual({
            status: "done",
            text: "approved",
        });
    });

    it("sends back through the existing helper", async () => {
        sendBackGate.mockResolvedValue(undefined);
        const act: PetAct = {
            id: "gate:run1:sendback",
            verb: "do",
            label: "Send back",
            op: { kind: "gate", channelId: "ch1", runId: "run1", phaseIdx: 1, action: "sendback" },
        };
        await runAct(model, act);
        expect(sendBackGate).toHaveBeenCalledWith("ch1", "run1", 1);
        expect(globalStore.get(petActStateAtom)["gate:run1:sendback"]).toEqual({
            status: "done",
            text: "sent back",
        });
    });

    it("reports a refused advance on the act, so a failed approval is never silent", async () => {
        approveGate.mockRejectedValue(new Error("run is no longer at that gate"));
        const act: PetAct = {
            id: "gate:run1:approve",
            verb: "do",
            label: "Approve",
            op: { kind: "gate", channelId: "ch1", runId: "run1", phaseIdx: 1, action: "approve" },
        };
        await runAct(model, act);
        expect(globalStore.get(petActStateAtom)["gate:run1:approve"]).toEqual({
            status: "error",
            text: "run is no longer at that gate",
        });
    });
});
