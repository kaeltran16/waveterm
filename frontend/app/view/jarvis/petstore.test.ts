import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it } from "vitest";
import { petBubbleAtom, petEventsAtom, petSaidAtom, removePetEvent } from "./petstore";
import type { PetEvent } from "./petvoice";

const ASK: PetEvent = { id: "ask:a1", at: 2, kind: "ask", text: "which port?", ref: "block:b1" };
const SWEEP: PetEvent = { id: "sweep:1", at: 1, kind: "sweep", text: "Swept the vault." };

describe("removePetEvent — answered means gone", () => {
    beforeEach(() => {
        globalStore.set(petEventsAtom, [ASK, SWEEP]);
        globalStore.set(petSaidAtom, [ASK, SWEEP]);
        globalStore.set(petBubbleAtom, ASK);
    });

    // once the queue row clears, an ask left in what was said leads the quiet peek as stale news
    it("drops the ask from what the creature said, not only from what it may say", () => {
        removePetEvent(ASK.id);
        expect(globalStore.get(petEventsAtom).map((e) => e.id)).toEqual([SWEEP.id]);
        expect(globalStore.get(petSaidAtom).map((e) => e.id)).toEqual([SWEEP.id]);
    });

    it("takes down a bubble that is still showing it", () => {
        removePetEvent(ASK.id);
        expect(globalStore.get(petBubbleAtom)).toBeNull();
    });

    it("leaves a bubble saying something else alone", () => {
        globalStore.set(petBubbleAtom, SWEEP);
        removePetEvent(ASK.id);
        expect(globalStore.get(petBubbleAtom)).toEqual(SWEEP);
    });
});
