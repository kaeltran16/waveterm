// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";

const openORef = vi.fn();
const askAboutSource = vi.fn();
const confirmPruneAllSuperseded = vi.fn();

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
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { memViewAtom, pendingMemoryFocusAtom } from "@/app/view/agents/memstore";
import { pendingSettingsSectionAtom, SETTINGS_SECTION_EMBEDDINGS } from "@/app/view/agents/settingsstore";
import { atom } from "jotai";
import { runAct } from "./petactrun";
import type { PetAct } from "./petacts";
import { petActStateAtom, petPeekOpenAtom } from "./petstore";

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
