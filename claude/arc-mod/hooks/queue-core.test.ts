import { describe, expect, it } from "vitest";
import {
    actionEnded,
    hold,
    isHeld,
    joinNow,
    newQueue,
    newStep,
    nextAction,
    putBack,
    resultsStored,
    stepEnded,
} from "./queue-core";

function queueOf(...items: string[]) {
    const queue = newQueue();
    items.forEach((text) => hold(queue, text));
    return queue;
}

const texts = (items: { text: string }[]) => items.map((i) => i.text);

describe("isHeld", () => {
    it("holds a mid-turn text while a turn runs", () => {
        expect(isHeld({ text: "wake: t-1", midTurn: true }, true)).toBe(true);
    });

    it("runs a text at once outside a turn", () => {
        expect(isHeld({ text: "wake: t-1", midTurn: true }, false)).toBe(false);
    });

    it("leaves a text that waits for the turn's end, and a compaction, to run as today", () => {
        expect(isHeld({ text: "a" }, true)).toBe(false);
        expect(isHeld({ compact: "keep the plan" }, true)).toBe(false);
    });
});

describe("joinNow", () => {
    it("joins the held prompts in arrival order and keeps every command held", () => {
        const queue = queueOf("a", "/compact", "b");
        expect(texts(joinNow(queue))).toEqual(["a", "b"]);
        expect(texts(queue.held)).toEqual(["/compact"]);
    });

    it("joins nothing when nothing is held", () => {
        expect(joinNow(newQueue())).toEqual([]);
    });
});

describe("nextAction", () => {
    it("releases an action only once the one before it is taken, the rest still held", () => {
        const queue = queueOf("a", "/compact", "b");
        expect(nextAction(queue)).toMatchObject({ kind: "prompt", text: "a" });
        expect(nextAction(queue)).toBeNull();
        expect(texts(queue.held)).toEqual(["/compact", "b"]);
        actionEnded(queue);
        expect(nextAction(queue)).toMatchObject({ kind: "command", text: "/compact" });
        actionEnded(queue);
        expect(nextAction(queue)).toMatchObject({ kind: "prompt", text: "b" });
        actionEnded(queue);
        expect(nextAction(queue)).toBeNull();
    });

    it("never sends a text that already joined", () => {
        const queue = queueOf("a", "/compact");
        joinNow(queue);
        expect(nextAction(queue)).toMatchObject({ kind: "command", text: "/compact" });
    });

    it("carries the items it sends, so a failed send can put them back", () => {
        const queue = queueOf("a");
        expect(texts(nextAction(queue)!.items)).toEqual(["a"]);
    });
});

describe("putBack", () => {
    it("holds taken items again where they were", () => {
        const queue = queueOf("a", "b", "c");
        const action = nextAction(queue)!;
        putBack(queue, action.items);
        expect(texts(queue.held)).toEqual(["a", "b", "c"]);
    });

    it("puts back a text that failed to join, ahead of one that came after it", () => {
        const queue = queueOf("a");
        const joined = joinNow(queue);
        hold(queue, "b");
        putBack(queue, joined);
        expect(texts(queue.held)).toEqual(["a", "b"]);
    });
});

describe("step", () => {
    it("joins once the response is whole and every call it made has its result", () => {
        const step = newStep();
        expect(stepEnded(step, 2)).toBe(false);
        expect(resultsStored(step, 1)).toBe(false);
        expect(resultsStored(step, 1)).toBe(true);
    });

    it("waits for the response's end when its calls finish while it still streams", () => {
        const step = newStep();
        expect(resultsStored(step, 1)).toBe(false);
        expect(resultsStored(step, 1)).toBe(false);
        expect(stepEnded(step, 2)).toBe(true);
    });

    it("joins once per step", () => {
        const step = newStep();
        stepEnded(step, 1);
        expect(resultsStored(step, 1)).toBe(true);
        expect(resultsStored(step, 1)).toBe(false);
    });

    it("never joins at a step that called no tool: the turn's end sends the rest", () => {
        expect(stepEnded(newStep(), 0)).toBe(false);
    });
});
