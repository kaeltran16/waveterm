import { describe, expect, it } from "vitest";
import {
    eventLabel,
    nextUtterance,
    unreadAfterLeaving,
    unreadAfterSaying,
    type PetEvent,
    type PetWatermark,
} from "./petvoice";

function ev(id: string, at: number, extra: Partial<PetEvent> = {}): PetEvent {
    return { id, at, kind: "bg-agent-done", text: `event ${id}`, ...extra };
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
        expect(nextUtterance([], null)).toEqual({ utterance: null, watermark: null, heard: [] });
    });

    it("says the newest of several rather than a digest of all", () => {
        const events = [ev("a", 1000), ev("c", 3000), ev("b", 2000)];
        const spoken = nextUtterance(events, null);
        expect(spoken.utterance?.id).toBe("c");
    });

    it("treats a notify event as a normal utterance", () => {
        const e = ev("n1", 1000, { kind: "notify" });
        const spoken = nextUtterance([e], null);
        expect(spoken.utterance).toEqual(e);
    });
});

describe("the watermark", () => {
    it("suppresses a re-report of the same event", () => {
        const e = ev("a", 1000);
        const first = nextUtterance([e], null);
        expect(first.utterance?.id).toBe("a");
        const second = nextUtterance([e], first.watermark);
        expect(second).toEqual({ utterance: null, watermark: null, heard: [] });
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

describe("volunteered knowledge", () => {
    const vol = (id: string, at: number): PetEvent => ({
        id,
        at,
        kind: "loose-end",
        text: "Still open - finish the migration",
        sources: [{ ref: "task:task-a", title: "Finish the migration", sourceType: "dossier" }],
    });

    it("speaks a knowledge utterance like any other event", () => {
        const { utterance, watermark } = nextUtterance([vol("loose-end:task-a:900", 900)], null);
        expect(utterance?.kind).toBe("loose-end");
        expect(utterance?.sources?.[0].ref).toBe("task:task-a");
        expect(watermark).toEqual({ at: 900, id: "loose-end:task-a:900" });
    });

    // the whole reason the backend stamps (at, id) from the fact rather than from emission time
    it("stays silent when the same fact is re-emitted", () => {
        const fact = vol("loose-end:task-a:900", 900);
        const { watermark } = nextUtterance([fact], null);
        const again = nextUtterance([fact], watermark);
        expect(again.utterance).toBeNull();
        expect(again.watermark).toBeNull();
    });

    it("speaks again once the fact moves to a new bucket", () => {
        const { watermark } = nextUtterance([vol("loose-end:task-a:900", 900)], null);
        const next = nextUtterance([vol("loose-end:task-a:1800", 1800)], watermark);
        expect(next.utterance?.id).toBe("loose-end:task-a:1800");
    });
});

describe("heard — a burst stays reachable", () => {
    // Two notifications in one second: the newest is spoken, and the other must still reach the peek,
    // which reads back only what the creature remembered hearing.
    it("returns every new event, newest first", () => {
        const events = [ev("a", 1000), ev("c", 3000), ev("b", 2000)];
        expect(nextUtterance(events, null).heard.map((e) => e.id)).toEqual(["c", "b", "a"]);
    });

    it("leaves out events already past the watermark", () => {
        const old = ev("a", 1000);
        const fresh = ev("b", 2000);
        expect(nextUtterance([old, fresh], mark(old)).heard.map((e) => e.id)).toEqual(["b"]);
    });
});

describe("said once", () => {
    it("is the utterance, but is not remembered", () => {
        const once = ev("b", 2000, { kind: "notify", transient: true });
        const spoken = nextUtterance([ev("a", 1000), once], null);
        expect(spoken.utterance).toEqual(once);
        expect(spoken.heard.map((e) => e.id)).toEqual(["a"]);
        expect(spoken.watermark).toEqual(mark(once));
    });

    it("leaves a normal event unchanged: spoken and remembered", () => {
        const kept = ev("a", 1000, { kind: "notify" });
        const spoken = nextUtterance([kept], null);
        expect(spoken.utterance).toEqual(kept);
        expect(spoken.heard).toEqual([kept]);
    });

    it("its bubble leaving marks nothing unread, where a kept one does", () => {
        const once = ev("a", 1000, { transient: true });
        expect(unreadAfterLeaving(once, false)).toBe(false);
        expect(unreadAfterLeaving(once, true)).toBe(true);
        expect(unreadAfterLeaving(ev("b", 1000), false)).toBe(true);
    });

    it("saying it keeps the marker for what is kept, and a kept utterance clears it", () => {
        const once = ev("b", 2000, { transient: true });
        const alone = nextUtterance([once], null);
        expect(unreadAfterSaying(alone, null, false)).toBe(false);
        expect(unreadAfterSaying(alone, null, true)).toBe(true);
        // a kept bubble pushed aside unopened, and a kept event remembered in the same burst
        expect(unreadAfterSaying(alone, ev("a", 1000), false)).toBe(true);
        expect(unreadAfterSaying(nextUtterance([ev("a", 1000), once], null), null, false)).toBe(true);
        expect(unreadAfterSaying(nextUtterance([ev("c", 3000)], null), once, true)).toBe(false);
    });
});

describe("eventLabel — the register in words", () => {
    it("names a kind by its register, never the raw kind", () => {
        expect(eventLabel(ev("a", 1, { kind: "resume" }))).toBe("Where we were");
        expect(eventLabel(ev("a", 1, { kind: "bg-agent-done" }))).toBe("While you were out");
        expect(eventLabel(ev("a", 1, { kind: "ask" }))).toBe("Asking you");
    });

    it("names a notification by its level", () => {
        expect(eventLabel(ev("n", 1, { kind: "notify", level: "info" }))).toBe("Notice");
        expect(eventLabel(ev("n", 1, { kind: "notify", level: "warn" }))).toBe("Warning");
        expect(eventLabel(ev("n", 1, { kind: "notify", level: "error" }))).toBe("Error");
        expect(eventLabel(ev("n", 1, { kind: "notify" }))).toBe("Notice");
    });
});
