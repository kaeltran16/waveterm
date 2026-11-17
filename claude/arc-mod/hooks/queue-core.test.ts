import { describe, expect, it } from "vitest";
import {
    hold,
    isHeld,
    joinNow,
    newQueue,
    newStep,
    personsHeld,
    putBack,
    release,
    report,
    resultsStored,
    settle,
    stepEnded,
    takeBack,
    turnEndPlan,
} from "./queue-core";

const T0 = 1_700_000_000_000;

function queueOf(...items: [string, "person" | "arc"][]) {
    const queue = newQueue("s1");
    items.forEach(([text, who], i) => hold(queue, text, who === "person", T0 + i));
    return queue;
}

const texts = (items: { text: string }[]) => items.map((i) => i.text);

describe("isHeld", () => {
    it("holds the person's queued text and Arc's mid-turn text while a turn runs", () => {
        expect(isHeld({ text: "a", midTurn: true, queue: true }, true)).toBe(true);
        expect(isHeld({ text: "a", queue: true }, true)).toBe(true);
        expect(isHeld({ text: "wake: t-1", midTurn: true }, true)).toBe(true);
    });

    it("runs a text at once outside a turn", () => {
        expect(isHeld({ text: "a", midTurn: true, queue: true }, false)).toBe(false);
        expect(isHeld({ text: "wake: t-1", midTurn: true }, false)).toBe(false);
    });

    it("leaves a text that waits for the turn's end, and a compaction, to run as today", () => {
        expect(isHeld({ text: "wake: t-1" }, true)).toBe(false);
        expect(isHeld({ compact: "keep it" }, true)).toBe(false);
        expect(isHeld({ takeBack: "r1" }, true)).toBe(false);
    });
});

describe("hold", () => {
    it("reports a held person text with its id, text and when it was taken", () => {
        const queue = newQueue("s1");
        const item = hold(queue, "also print the date", true, T0);
        expect(report(queue)).toEqual({ held: [{ id: item.id, text: "also print the date", ts: T0 }], left: [] });
    });

    it("gives every person item its own id", () => {
        const queue = queueOf(["a", "person"], ["a", "person"], ["b", "person"]);
        const ids = report(queue).held.map((h) => h.id);
        expect(new Set(ids).size).toBe(3);
    });

    it("gives no two queues' items the same id", () => {
        const one = newQueue("s1");
        const two = newQueue("s2");
        expect(hold(one, "a", true, T0).id).not.toBe(hold(two, "a", true, T0).id);
    });

    it("holds Arc's text silently: never reported, never given an id", () => {
        const queue = queueOf(["wake: t-1 done", "arc"]);
        expect(report(queue)).toEqual({ held: [], left: [] });
    });
});

describe("joinNow", () => {
    it("joins Arc's held prompts in arrival order, and keeps the person's items and every command held", () => {
        const queue = queueOf(
            ["a", "person"],
            ["wake: t-1", "arc"],
            ["/compact", "person"],
            ["/compact", "arc"],
            ["wake: t-2", "arc"],
            ["b", "person"]
        );
        const before = report(queue);
        expect(texts(joinNow(queue))).toEqual(["wake: t-1", "wake: t-2"]);
        expect(report(queue)).toEqual(before);
        expect(texts(turnEndPlan(queue))).toEqual(["a", "/compact", "/compact", "b"]);
    });

    it("joins nothing when nothing is held", () => {
        expect(joinNow(newQueue("s1"))).toEqual([]);
    });
});

describe("turnEndPlan", () => {
    it("sends consecutive person prompts as one, and each command as a command, in order", () => {
        const queue = queueOf(["a", "person"], ["b", "person"], ["/x", "person"], ["c", "person"]);
        expect(turnEndPlan(queue).map(({ kind, text }) => ({ kind, text }))).toEqual([
            { kind: "prompt", text: "a\nb" },
            { kind: "command", text: "/x" },
            { kind: "prompt", text: "c" },
        ]);
    });

    it("sends each Arc text as its own prompt, never merged with the person's", () => {
        const queue = queueOf(["a", "person"], ["wake: t-1", "arc"], ["wake: t-2", "arc"], ["b", "person"]);
        expect(turnEndPlan(queue).map(({ kind, text }) => ({ kind, text }))).toEqual([
            { kind: "prompt", text: "a" },
            { kind: "prompt", text: "wake: t-1" },
            { kind: "prompt", text: "wake: t-2" },
            { kind: "prompt", text: "b" },
        ]);
    });

    it("empties the queue and reports the person's items as sent", () => {
        const queue = queueOf(["a", "person"], ["wake: t-1", "arc"], ["/x", "person"]);
        const ids = report(queue).held.map((h) => h.id);
        turnEndPlan(queue);
        expect(report(queue)).toEqual({
            held: [],
            left: [
                { id: ids[0], how: "sent" },
                { id: ids[1], how: "sent" },
            ],
        });
    });

    it("never sends a text that already joined", () => {
        const queue = queueOf(["a", "person"], ["/x", "person"], ["wake: t-1", "arc"]);
        const joined = texts(joinNow(queue));
        hold(queue, "b", true, T0 + 10);
        const planned = texts(turnEndPlan(queue));
        expect(joined).toEqual(["wake: t-1"]);
        expect(planned).toEqual(["a", "/x", "b"]);
    });

    it("carries the items each action sends, so a failed send can put them back", () => {
        const queue = queueOf(["a", "person"], ["b", "person"]);
        expect(turnEndPlan(queue).map((action) => texts(action.items))).toEqual([["a", "b"]]);
    });
});

describe("takeBack", () => {
    it("hands back every held person item in order and leaves Arc's held", () => {
        const queue = queueOf(["a", "person"], ["wake: t-1", "arc"], ["/x", "person"], ["b", "person"]);
        const ids = report(queue).held.map((h) => h.id);
        expect(takeBack(queue).map(({ id, text, ts }) => ({ id, text, ts }))).toEqual([
            { id: ids[0], text: "a", ts: T0 },
            { id: ids[1], text: "/x", ts: T0 + 2 },
            { id: ids[2], text: "b", ts: T0 + 3 },
        ]);
        expect(report(queue, "r1")).toEqual({
            held: [],
            left: [
                { id: ids[0], how: "takenback" },
                { id: ids[1], how: "takenback" },
                { id: ids[2], how: "takenback" },
            ],
            takeback: "r1",
        });
        expect(texts(joinNow(queue))).toEqual(["wake: t-1"]);
    });

    it("hands back nothing when only Arc's texts are held", () => {
        expect(takeBack(queueOf(["wake: t-1", "arc"]))).toEqual([]);
    });
});

describe("putBack", () => {
    it("holds taken items again where they were, and forgets that they left", () => {
        const queue = queueOf(["a", "person"], ["b", "person"]);
        const taken = takeBack(queue);
        hold(queue, "c", true, T0 + 10);
        putBack(queue, taken);
        expect(report(queue).held.map((h) => h.text)).toEqual(["a", "b", "c"]);
        expect(report(queue).left).toEqual([]);
    });

    it("puts back an Arc text that failed to join", () => {
        const queue = queueOf(["wake: t-1", "arc"]);
        const joined = joinNow(queue);
        putBack(queue, joined);
        expect(texts(turnEndPlan(queue))).toEqual(["wake: t-1"]);
    });
});

describe("release", () => {
    it("drops the given items with no left entry, so wavesrv reads them as lost and the box gets them back", () => {
        const queue = queueOf(["a", "person"], ["wake: t-1", "arc"], ["b", "person"]);
        const ids = report(queue).held.map((h) => h.id);
        release(queue, personsHeld(queue));
        expect(report(queue)).toEqual({ held: [], left: [] });
        expect(texts(turnEndPlan(queue))).toEqual(["wake: t-1"]);
        expect(ids).toHaveLength(2);
    });

    it("drops only the items it is given", () => {
        const queue = queueOf(["a", "person"]);
        const late = hold(queue, "b", true, T0 + 10);
        release(queue, [late]);
        expect(report(queue).held.map((h) => h.text)).toEqual(["a"]);
    });
});

describe("personsHeld", () => {
    it("is the person's held items in order, Arc's left out", () => {
        const queue = queueOf(["a", "person"], ["wake: t-1", "arc"], ["/x", "person"]);
        expect(texts(personsHeld(queue))).toEqual(["a", "/x"]);
        expect(texts(personsHeld(queue))).toEqual(["a", "/x"]);
    });
});

describe("settle", () => {
    it("drops the left entries a report carried, and keeps the ones it did not", () => {
        const queue = queueOf(["a", "person"], ["b", "person"]);
        const ids = report(queue).held.map((h) => h.id);
        turnEndPlan(queue);
        const sent = report(queue);
        hold(queue, "c", true, T0 + 10);
        const late = takeBack(queue);
        settle(queue, sent.left);
        expect(report(queue).left).toEqual([{ id: late[0]?.id, how: "takenback" }]);
        expect(sent.left.map((l) => l.id)).toEqual(ids);
    });

    it("keeps a failed report's left entries for the next one", () => {
        const queue = queueOf(["a", "person"]);
        const id = report(queue).held[0]?.id;
        turnEndPlan(queue);
        hold(queue, "b", true, T0 + 10);
        expect(report(queue).left).toEqual([{ id, how: "sent" }]);
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
