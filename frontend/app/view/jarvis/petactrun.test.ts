// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";

const openAddress = vi.fn();
const postMessage = vi.fn();
const consult = vi.fn();

vi.mock("./openref", () => ({ openAddress: (...a: any[]) => openAddress(...a) }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        PostChannelMessageCommand: (...a: any[]) => postMessage(...a),
        ConsultCommand: (...a: any[]) => consult(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { atom } from "jotai";
import { runAct, sendErrand } from "./petactrun";
import type { PetAct } from "./petacts";
import { petActStateAtom, petErrandAtom, petPeekOpenAtom } from "./petstore";

// the runner only ever reads surfaceAtom off the model, so a bare atom pair is a sufficient stand-in
const model = { surfaceAtom: atom("cockpit") } as any;

afterEach(() => {
    vi.clearAllMocks();
    globalStore.set(petActStateAtom, {});
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
