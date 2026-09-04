import { describe, expect, it } from "vitest";
import {
    conditionLine,
    conditionsFor,
    DRIFT_QUEUE_BAND,
    EXPRESSION_RANK,
    expressionFor,
    isWindowConstrained,
    postureFor,
    postureLine,
    type PetSignals,
} from "./petcondition";

const OFF: PetSignals["index"] = { state: "off" };
const STALE: PetSignals["index"] = { state: "stale" };
const HOT: PetSignals["rateLimit"] = { provider: "claude", pct: 94, resetAt: 1_800_000_000 };
const QUEUE: PetSignals["decay"] = { queueDepth: DRIFT_QUEUE_BAND, staleNotes: 2 };

describe("expressionFor — each rank fires in isolation", () => {
    it("rank 1: an index that is off or stale is cannot-see, carrying which", () => {
        expect(expressionFor({ index: OFF })).toEqual({ kind: "cannot-see", reason: "off" });
        expect(expressionFor({ index: STALE })).toEqual({ kind: "cannot-see", reason: "stale" });
    });

    it("rank 2: a depleting window is tired, carrying whose reading it is, the reading, and its reset", () => {
        expect(expressionFor({ rateLimit: HOT })).toEqual({
            kind: "tired",
            provider: "claude",
            pct: 94,
            resetAt: 1_800_000_000,
        });
    });

    it("rank 3: a queue at the band is drifting, carrying its depth", () => {
        expect(expressionFor({ decay: QUEUE })).toEqual({ kind: "drifting", queueDepth: DRIFT_QUEUE_BAND });
    });
});

describe("expressionFor — strict precedence", () => {
    it("keeps the underlying window constraint available when recall wins the expression", () => {
        expect(expressionFor({ index: OFF, rateLimit: HOT }).kind).toBe("cannot-see");
        expect(isWindowConstrained(HOT)).toBe(true);
        expect(isWindowConstrained({ provider: "claude", pct: 60 })).toBe(false);
        expect(isWindowConstrained(undefined)).toBe(false);
    });

    it("cannot-see beats every lower rank present at the same time", () => {
        expect(expressionFor({ index: OFF, rateLimit: HOT }).kind).toBe("cannot-see");
        expect(expressionFor({ index: OFF, decay: QUEUE }).kind).toBe("cannot-see");
        expect(expressionFor({ index: OFF, rateLimit: HOT, decay: QUEUE }).kind).toBe("cannot-see");
    });

    it("tired beats drifting", () => {
        expect(expressionFor({ rateLimit: HOT, decay: QUEUE }).kind).toBe("tired");
    });

    it("ranks the four expressions in the design's order", () => {
        expect(EXPRESSION_RANK["cannot-see"]).toBeLessThan(EXPRESSION_RANK.tired);
        expect(EXPRESSION_RANK.tired).toBeLessThan(EXPRESSION_RANK.drifting);
        expect(EXPRESSION_RANK.drifting).toBeLessThan(EXPRESSION_RANK["at-rest"]);
    });
});

describe("expressionFor — nothing present is at-rest", () => {
    it("yields at-rest for no signals at all", () => {
        expect(expressionFor({})).toEqual({ kind: "at-rest" });
    });

    // an absent field means "no signal", never "signal absent" — which is what lets the ranks with no
    // source yet ship inert instead of firing on undefined.
    it("yields at-rest when a signal is present but says nothing is wrong", () => {
        expect(expressionFor({ index: { state: "ok" } }).kind).toBe("at-rest");
        expect(expressionFor({ rateLimit: { provider: "claude", pct: 12 } }).kind).toBe("at-rest");
        expect(expressionFor({ decay: { queueDepth: DRIFT_QUEUE_BAND - 1, staleNotes: 1 } }).kind).toBe("at-rest");
        expect(expressionFor({ attention: { reviewGates: 3, escalations: 1, blockedWorkers: 2 } }).kind).toBe(
            "at-rest"
        );
    });

    it("does not treat a zero-depth queue or a zero reading as drift", () => {
        expect(expressionFor({ decay: { queueDepth: 0, staleNotes: 0 } }).kind).toBe("at-rest");
        expect(expressionFor({ rateLimit: { provider: "claude", pct: 0 } }).kind).toBe("at-rest");
    });
});

describe("postureFor", () => {
    it("prefers a gate, then an escalation, then a blocked worker", () => {
        expect(postureFor({ attention: { reviewGates: 1, escalations: 1, blockedWorkers: 1 } })).toBe("review-gate");
        expect(postureFor({ attention: { reviewGates: 0, escalations: 1, blockedWorkers: 1 } })).toBe("escalation");
        expect(postureFor({ attention: { reviewGates: 0, escalations: 0, blockedWorkers: 1 } })).toBe("blocked-worker");
    });

    it("is none with nothing waiting, and none with no attention signal at all", () => {
        expect(postureFor({ attention: { reviewGates: 0, escalations: 0, blockedWorkers: 0 } })).toBe("none");
        expect(postureFor({})).toBe("none");
    });

    // posture is independent of condition: the two registers answer different questions, and the
    // precedence in expressionFor must not silence what is waiting.
    it("is unaffected by the condition signals", () => {
        const signals: PetSignals = {
            index: OFF,
            rateLimit: HOT,
            attention: { reviewGates: 0, escalations: 2, blockedWorkers: 0 },
        };
        expect(expressionFor(signals).kind).toBe("cannot-see");
        expect(postureFor(signals)).toBe("escalation");
    });
});

describe("wording", () => {
    const now = 1_800_000_000 * 1000; // the reset moment itself

    it("names the cause of a cannot-see rather than only the symptom", () => {
        expect(conditionLine({ kind: "cannot-see", reason: "off" }, now)).toContain("embeddings are off");
        expect(conditionLine({ kind: "cannot-see", reason: "stale" }, now)).toContain("behind");
    });

    it("only claims recall is keyword-only when it actually is, and no longer promises a remedy in prose", () => {
        // A behind index still does semantic recall: jarvisrecall calls the index, and the index reconciles
        // itself inside that query (jarvisembed prepareQuery). Saying "keyword-only" there described a
        // degradation that was not happening. Embeddings being OFF is the case that genuinely is keyword-only.
        //
        // Neither line names an action any more. The stale line used to read "ask me anything and I will
        // catch it up" while the panel offered nowhere to do it — prose that names an action was the
        // original defect. petacts.ts supplies the verb now (design §4.1).
        const behind = conditionLine({ kind: "cannot-see", reason: "stale" }, now);
        expect(behind).not.toContain("keyword-only");
        expect(behind.toLowerCase()).not.toContain("ask");
        expect(behind).toBe("My index is behind on some notes.");
        expect(conditionLine({ kind: "cannot-see", reason: "off" }, now)).toContain("keyword-only");
    });

    it("carries the reading, and the reset only when there is one", () => {
        expect(conditionLine({ kind: "tired", provider: "claude", pct: 94, resetAt: 1_800_003_600 }, now)).toBe(
            "Running low on Claude — 94% of the window used, back in 1h 0m."
        );
        expect(conditionLine({ kind: "tired", provider: "claude", pct: 94 }, now)).toBe(
            "Running low on Claude — 94% of the window used."
        );
    });

    // rate limits are per-provider, and the highest reading wins across providers. Without the name, a
    // codex window at 94% is indistinguishable from a claude one, and the countdown belongs to whichever
    // provider won — which is how a codex reading got read as the claude window it was not.
    it("names the provider the reading belongs to", () => {
        expect(conditionLine({ kind: "tired", provider: "codex", pct: 94, resetAt: 1_800_003_600 }, now)).toBe(
            "Running low on Codex — 94% of the window used, back in 1h 0m."
        );
    });

    // "running low" wording the same at 86% and at 100% understates a window that is simply gone.
    it("says a spent window is spent rather than running low", () => {
        expect(conditionLine({ kind: "tired", provider: "claude", pct: 100, resetAt: 1_800_003_600 }, now)).toBe(
            "Claude's window is spent — back in 1h 0m."
        );
        expect(conditionLine({ kind: "tired", provider: "claude", pct: 100 }, now)).toBe("Claude's window is spent.");
    });

    it("gives every expression and every posture a line", () => {
        expect(conditionLine({ kind: "drifting", queueDepth: 9 }, now)).toContain("9 notes");
        expect(conditionLine({ kind: "at-rest" }, now)).not.toBe("");
        expect(postureLine("review-gate")).not.toBe("");
        expect(postureLine("escalation")).not.toBe("");
        expect(postureLine("blocked-worker")).not.toBe("");
        expect(postureLine("none")).toBe("");
    });
});

// The peek lists every standing condition, where the creature wears only one. Precedence decides which
// LEADS rather than capping the list at one — the brief's state 3 (recall off AND the vault drifting) is a
// required frame, and today's panel states that pair twice: once as a banner, once as a tile.
describe("conditionsFor — every standing condition, in rank order", () => {
    it("returns nothing to say when no signal is degraded", () => {
        expect(conditionsFor({})).toEqual([]);
        expect(conditionsFor({ decay: { queueDepth: 0, staleNotes: 0 } })).toEqual([]);
    });

    it("lists one entry per degraded signal, ranked, not just the winner", () => {
        expect(conditionsFor({ index: OFF, decay: QUEUE }).map((c) => c.kind)).toEqual(["cannot-see", "drifting"]);
        expect(conditionsFor({ index: OFF, rateLimit: HOT, decay: QUEUE }).map((c) => c.kind)).toEqual([
            "cannot-see",
            "tired",
            "drifting",
        ]);
    });

    it("carries each condition whole, so conditionLine can word it without re-deriving", () => {
        expect(conditionsFor({ rateLimit: HOT, decay: QUEUE })).toEqual([
            { kind: "tired", provider: "claude", pct: 94, resetAt: 1_800_000_000 },
            { kind: "drifting", queueDepth: DRIFT_QUEUE_BAND },
        ]);
    });

    it("never lists at-rest: an empty list is how quiet is spelled", () => {
        expect(conditionsFor({}).some((c) => c.kind === "at-rest")).toBe(false);
    });

    // the crossing rule: the creature wears one face, and the peek's lead line must be that same face.
    // Two derivations of the same precedence would let the corner and the panel disagree.
    it("leads with exactly the expression the creature is wearing", () => {
        for (const signals of [
            { index: OFF, rateLimit: HOT, decay: QUEUE },
            { rateLimit: HOT, decay: QUEUE },
            { decay: QUEUE },
            { index: STALE },
        ]) {
            expect(conditionsFor(signals)[0]).toEqual(expressionFor(signals));
        }
    });
});
