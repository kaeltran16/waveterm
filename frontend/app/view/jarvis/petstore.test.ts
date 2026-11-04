import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it } from "vitest";
import { dismissPetBubble, petBubbleAtom, petEventsAtom, petSaidAtom, petUnreadAtom, removePetEvent } from "./petstore";
import type { PetEvent } from "./petvoice";

const ASK: PetEvent = { id: "ask:a1", at: 2, kind: "ask", text: "which port?", ref: "block:b1" };
const SWEEP: PetEvent = { id: "sweep:1", at: 1, kind: "bg-agent-done", text: "Swept the vault." };

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

describe("dismissPetBubble", () => {
    const RESUME: PetEvent = { id: "resume:r1:1", at: 1, kind: "resume", text: "Where we were — the plan" };

    beforeEach(() => {
        globalStore.set(petUnreadAtom, false);
    });

    it("closes a bubble of the kind asked for and leaves it unread", () => {
        globalStore.set(petBubbleAtom, RESUME);
        dismissPetBubble("resume");
        expect(globalStore.get(petBubbleAtom)).toBeNull();
        expect(globalStore.get(petUnreadAtom)).toBe(true);
    });

    it("leaves a bubble of another kind showing", () => {
        globalStore.set(petBubbleAtom, SWEEP);
        dismissPetBubble("resume");
        expect(globalStore.get(petBubbleAtom)).toBe(SWEEP);
    });

    it("closes any bubble when no kind is named", () => {
        globalStore.set(petBubbleAtom, SWEEP);
        dismissPetBubble();
        expect(globalStore.get(petBubbleAtom)).toBeNull();
    });
});
