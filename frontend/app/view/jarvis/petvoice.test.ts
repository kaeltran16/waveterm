import { describe, expect, it } from "vitest";
import { nextUtterance, type PetEvent, type PetWatermark } from "./petvoice";

function ev(id: string, at: number, extra: Partial<PetEvent> = {}): PetEvent {
    return { id, at, kind: "sweep", text: `event ${id}`, ...extra };
}

const mark = (e: PetEvent): PetWatermark => ({ at: e.at, id: e.id });

describe("nextUtterance", () => {
    it("says one thing for one new event", () => {
        const e = ev("a", 1000);
        const spoken = nextUtterance([e], null);
        expect(spoken.utterance).toEqual(e);
        expect(spoken.watermark).toEqual(mark(e));
    });

    it("is silent on an empty event set", () => {
        expect(nextUtterance([], null)).toEqual({ utterance: null, watermark: null });
    });

    it("says the newest of several rather than a digest of all", () => {
        const events = [ev("a", 1000), ev("c", 3000), ev("b", 2000)];
        const spoken = nextUtterance(events, null);
        expect(spoken.utterance?.id).toBe("c");
    });
});

describe("the watermark", () => {
    it("suppresses a re-report of the same event", () => {
        const e = ev("a", 1000);
        const first = nextUtterance([e], null);
        expect(first.utterance?.id).toBe("a");
        const second = nextUtterance([e], first.watermark);
        expect(second).toEqual({ utterance: null, watermark: null });
    });

    it("lets a genuinely newer event through while still suppressing the old one", () => {
        const old = ev("a", 1000);
        const fresh = ev("b", 2000);
        const spoken = nextUtterance([old, fresh], mark(old));
        expect(spoken.utterance?.id).toBe("b");
        expect(nextUtterance([old, fresh], spoken.watermark).utterance).toBeNull();
    });

    // two events stamped in the same millisecond must not collapse into one, or whichever the poller
    // happened to list first would be permanently unspeakable.
    it("breaks a same-millisecond tie by id instead of dropping one", () => {
        const a = ev("a", 1000);
        const b = ev("b", 1000);
        const spoken = nextUtterance([a, b], null);
        expect(spoken.utterance?.id).toBe("b");
        expect(nextUtterance([a, b], spoken.watermark).utterance).toBeNull();
        // and from a's position, b is still ahead
        expect(nextUtterance([a, b], mark(a)).utterance?.id).toBe("b");
    });
});

describe("report-once", () => {
    it("does not speak an event the condition level already shows", () => {
        const sweep = ev("a", 1000, { reportedAsCondition: true });
        const spoken = nextUtterance([sweep], null);
        expect(spoken.utterance).toBeNull();
        // but it counts as reported: the watermark advances so it is never reconsidered
        expect(spoken.watermark).toEqual(mark(sweep));
        expect(nextUtterance([sweep], spoken.watermark)).toEqual({ utterance: null, watermark: null });
    });

    it("falls through to the newest speakable event when the newest is a condition change", () => {
        const speakable = ev("a", 1000, { kind: "resume" });
        const condition = ev("b", 2000, { reportedAsCondition: true });
        const spoken = nextUtterance([speakable, condition], null);
        expect(spoken.utterance?.id).toBe("a");
        // the watermark is the newest SEEN event, not the one spoken, so neither is offered again
        expect(spoken.watermark).toEqual(mark(condition));
        expect(nextUtterance([speakable, condition], spoken.watermark).utterance).toBeNull();
    });

    it("is silent when every new event is already reported as a condition", () => {
        const events = [ev("a", 1000, { reportedAsCondition: true }), ev("b", 2000, { reportedAsCondition: true })];
        expect(nextUtterance(events, null).utterance).toBeNull();
    });
});
