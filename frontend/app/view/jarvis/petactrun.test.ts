// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";

const openAddress = vi.fn();
const askAboutSource = vi.fn();
const startIndexCatchUp = vi.fn();
const postMessage = vi.fn();
const consult = vi.fn();

vi.mock("./openref", () => ({ openAddress: (...a: any[]) => openAddress(...a) }));
vi.mock("./jarvissubjectstore", () => ({ askAboutSource: (...a: any[]) => askAboutSource(...a) }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        PostChannelMessageCommand: (...a: any[]) => postMessage(...a),
        ConsultCommand: (...a: any[]) => consult(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("./petindex", () => ({ startIndexCatchUp: (...a: any[]) => startIndexCatchUp(...a) }));

import { pendingSettingsSectionAtom, SETTINGS_SECTION_EMBEDDINGS } from "@/app/view/agents/settingsstore";
import { atom } from "jotai";
import { runAct, sendErrand } from "./petactrun";
import type { PetAct } from "./petacts";
import { petActStateAtom, petErrandAtom, petPeekOpenAtom } from "./petstore";

// the runner only ever reads surfaceAtom off the model, so a bare atom pair is a sufficient stand-in
const model = { surfaceAtom: atom("cockpit") } as any;

afterEach(() => {
    vi.clearAllMocks();
    globalStore.set(petActStateAtom, {});
    globalStore.set(pendingSettingsSectionAtom, null);
    globalStore.set(petPeekOpenAtom, false);
});

describe("runAct — escorts", () => {
    it("closes the peek once the landing succeeds, so an anchored overlay is not stranded", async () => {
        globalStore.set(petPeekOpenAtom, true);
        openAddress.mockResolvedValue({ ok: true });
        const act: PetAct = {
            id: "x",
            verb: "open",
            label: "Open",
            target: { kind: "oref", ref: "memnote:abc" },
        };
        await runAct(model, act);
        expect(globalStore.get(petPeekOpenAtom)).toBe(false);
        expect(openAddress).toHaveBeenCalledWith(model, "memnote:abc", { anchor: undefined }, expect.any(Function));
    });

    // the landing leaves the user where they were, so the act that asked is where its failure is read
    it("keeps the peek open and reports a failed landing on the act", async () => {
        globalStore.set(petPeekOpenAtom, true);
        openAddress.mockImplementation(
            async (_model: unknown, _address: string, _hint: unknown, report: (r: unknown) => void) => {
                const result = { ok: false, reason: "unavailable", message: "That record no longer exists" };
                report(result);
                return result;
            }
        );
        const act: PetAct = { id: "gone", verb: "open", label: "Open", target: { kind: "oref", ref: "task:gone" } };
        await runAct(model, act);
        expect(globalStore.get(petPeekOpenAtom)).toBe(true);
        expect(globalStore.get(petActStateAtom)["gone"]).toEqual({
            status: "error",
            text: "That record no longer exists",
        });
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
            seed: { ref: "task:abc", sourceType: "dossier", title: "a record", prompt: "Tell me more." },
        };
        await runAct(model, act);
        expect(askAboutSource).toHaveBeenCalledWith("task:abc", "dossier", "a record", "Tell me more.");
        expect(globalStore.get(model.surfaceAtom)).toBe("jarvis");
    });
});

describe("runAct — catch up the index", () => {
    it("delegates the shared catch-up lifecycle using the action's id", async () => {
        startIndexCatchUp.mockResolvedValue(undefined);
        const act: PetAct = {
            id: "recall:catchup",
            verb: "do",
            label: "Catch up",
            op: { kind: "reconcile-index" },
        };

        await runAct(model, act);

        expect(startIndexCatchUp).toHaveBeenCalledWith("recall:catchup");
    });

    it("reports a refused dispatch on the row", async () => {
        startIndexCatchUp.mockRejectedValue(new Error("EC-TIME"));
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

describe("sendErrand", () => {
    afterEach(() => globalStore.set(petErrandAtom, null));

    it("posts the question into the channel and streams the reply into the panel", async () => {
        postMessage.mockResolvedValue(undefined);
        consult.mockReturnValue(
            (async function* () {
                yield { text: "the parser " };
                yield { text: "is fine." };
            })()
        );
        await sendErrand("ch1", "claude", "is the parser ok?");
        expect(postMessage).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ channelid: "ch1", kind: "consult", author: "you", text: "is the parser ok?" })
        );
        expect(globalStore.get(petErrandAtom)).toEqual({
            prompt: "is the parser ok?",
            runtime: "claude",
            text: "the parser is fine.",
            status: "done",
        });
    });

    it("marks the errand failed with its reason, keeping whatever streamed first", async () => {
        postMessage.mockResolvedValue(undefined);
        consult.mockReturnValue(
            (async function* () {
                yield { text: "partial" };
                throw new Error("runtime not installed");
            })()
        );
        await sendErrand("ch1", "claude", "q");
        expect(globalStore.get(petErrandAtom)).toMatchObject({ text: "partial", status: "error" });
    });

    it("reports the reason when nothing streamed at all", async () => {
        postMessage.mockRejectedValue(new Error("no such channel"));
        await sendErrand("ch-gone", "claude", "q");
        expect(globalStore.get(petErrandAtom)).toEqual({
            prompt: "q",
            runtime: "claude",
            text: "no such channel",
            status: "error",
        });
    });
});
