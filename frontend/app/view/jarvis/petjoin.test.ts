// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { eventFromActivity, eventFromResume, indexSignal, recallLine } from "./petjoin";

function status(over: Partial<EmbedIndexStatus>): EmbedIndexStatus {
    return { state: "ok", enabled: true, haskey: true, indexednodes: 0, vaultnodes: 0, stalenodes: 0, ...over };
}

function activity(over: Partial<MemoryActivityData>): MemoryActivityData {
    return { kind: "sweep", id: "a1", ts: 1_700_000_000_000, ...over };
}

describe("indexSignal", () => {
    it("narrows each state the backend can report", () => {
        expect(indexSignal(status({ state: "ok" }))).toEqual({ state: "ok" });
        expect(indexSignal(status({ state: "off" }))).toEqual({ state: "off" });
        expect(indexSignal(status({ state: "stale" }))).toEqual({ state: "stale" });
    });

    // the important one: an unknown state must not read as healthy, or a future backend state would
    // silently present as "recall is fine" — the exact failure rank 1 exists to expose.
    it("yields no signal for an unrecognised state rather than defaulting to ok", () => {
        expect(indexSignal(status({ state: "rebuilding" }))).toBeUndefined();
        expect(indexSignal(status({ state: "" }))).toBeUndefined();
    });

    it("yields no signal when the read failed entirely", () => {
        expect(indexSignal(null)).toBeUndefined();
        expect(indexSignal(undefined)).toBeUndefined();
    });
});

describe("recallLine", () => {
    it("distinguishes never-read from read-and-healthy", () => {
        expect(recallLine(null)).toEqual({ text: "not read yet", dim: true });
        expect(recallLine(status({ state: "ok", indexednodes: 373 }))).toEqual({ text: "ok · 373 indexed", dim: false });
    });

    it("names why recall is degraded, which is the diagnostic the register exists for", () => {
        expect(recallLine(status({ state: "off", reason: "disabled" })).text).toBe("off — embeddings are turned off");
        expect(recallLine(status({ state: "off", reason: "no-key" })).text).toBe("off — no API key configured");
        expect(recallLine(status({ state: "stale", reason: "model-mismatch" })).text).toBe(
            "stale — indexed with a different model"
        );
    });

    it("carries the drift count when staleness is measurable", () => {
        expect(recallLine(status({ state: "stale", reason: "content-drift", stalenodes: 7 })).text).toBe(
            "stale — notes have changed since indexing (7)"
        );
    });

    // a reason this build has never been taught is still more useful than silence
    it("falls through to the raw reason rather than swallowing an unknown one", () => {
        expect(recallLine(status({ state: "off", reason: "quota-exhausted" })).text).toBe("off — quota-exhausted");
    });

    it("reports a bare state when no reason came back", () => {
        expect(recallLine(status({ state: "stale" })).text).toBe("stale");
    });
});

describe("eventFromActivity", () => {
    it("maps a gardener sweep, carrying the archived count", () => {
        const e = eventFromActivity(activity({ kind: "sweep", archived: 12 }));
        expect(e).toMatchObject({ id: "a1", at: 1_700_000_000_000, kind: "sweep" });
        expect(e?.text).toContain("12 notes");
    });

    it("maps a distillation batch and a notes-written event", () => {
        expect(eventFromActivity(activity({ kind: "distill-batch", sessions: 8 }))?.text).toContain("8 sessions");
        expect(eventFromActivity(activity({ kind: "notes-written", committed: 3 }))?.text).toContain("3 notes");
    });

    it("singularises a count of one", () => {
        expect(eventFromActivity(activity({ kind: "sweep", archived: 1 }))?.text).toContain("1 note ");
        expect(eventFromActivity(activity({ kind: "distill-batch", sessions: 1 }))?.text).toContain("1 session");
    });

    it("falls back to unnumbered wording when the batch reports no session count", () => {
        const e = eventFromActivity(activity({ kind: "distill-batch" }));
        expect(e?.text).toBe("I went back over your recent sessions while you were out.");
    });

    it("rejects a kind the creature has no register for", () => {
        expect(eventFromActivity(activity({ kind: "reindexed" }))).toBeNull();
    });

    // without both, the watermark cannot order the event, so it would either re-speak forever or
    // suppress everything after it.
    it("rejects an event with no stable id or no timestamp", () => {
        expect(eventFromActivity(activity({ id: "" }))).toBeNull();
        expect(eventFromActivity(activity({ ts: 0 }))).toBeNull();
        expect(eventFromActivity(null)).toBeNull();
    });

    it("does not mark activity as already reported by the condition register", () => {
        expect(eventFromActivity(activity({ kind: "sweep", archived: 4 }))?.reportedAsCondition).toBeUndefined();
    });
});

describe("eventFromResume", () => {
    const card: ResumeCardData = { taskId: "t1", summary: "  paused at the migration step  ", status: "blocked", updated: 1_700_000_000_500 };

    it("speaks the narrative, trimmed", () => {
        const e = eventFromResume({ card, runoref: "run:abc" });
        expect(e?.kind).toBe("resume");
        expect(e?.at).toBe(1_700_000_000_500);
        expect(e?.text).toBe("Where we were — paused at the migration step");
    });

    // stability is the whole point: an id derived from the read time would re-say the same narrative on
    // every launch, which is the opposite of push-once.
    it("derives an id that is stable across reads and changes only with a new narrative", () => {
        const a = eventFromResume({ card, runoref: "run:abc" });
        const b = eventFromResume({ card, runoref: "run:abc" });
        expect(a?.id).toBe(b?.id);
        const later = eventFromResume({ card: { ...card, updated: 1_700_000_001_000 }, runoref: "run:abc" });
        expect(later?.id).not.toBe(a?.id);
    });

    it("falls back to the task id when no run oref came back", () => {
        expect(eventFromResume({ card })?.id).toContain("t1");
    });

    it("stays silent on an absent, empty or undatable narrative", () => {
        expect(eventFromResume({})).toBeNull();
        expect(eventFromResume(null)).toBeNull();
        expect(eventFromResume({ card: { ...card, summary: "   " } })).toBeNull();
        expect(eventFromResume({ card: { ...card, updated: 0 } })).toBeNull();
    });
});
