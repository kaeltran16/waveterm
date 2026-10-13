import { describe, expect, it } from "vitest";
import {
    conditionLine,
    conditionsFor,
    EXPRESSION_RANK,
    expressionFor,
    heldLandFrom,
    isWindowConstrained,
    postureFor,
    postureLine,
    type PetSignals,
} from "./petcondition";

const HOT: PetSignals["rateLimit"] = { provider: "claude", pct: 94, resetAt: 1_800_000_000 };
const LINK: PetSignals["link"] = { lostAt: 1_800_000_000_000 };
const HELD: PetSignals["heldLand"] = { runName: "retry budget", reason: "merge conflict in policy.go" };

function attentionItem(kind: string, source: string, reason?: string): AttentionItem {
    return { kind, key: `${kind}:${source}`, source, text: "", reason, action: "Open", phaseidx: 0, waitingsince: 0 };
}

describe("expressionFor — each rank fires in isolation", () => {
    it("rank 1: a lost link carries when it dropped", () => {
        expect(expressionFor({ link: LINK })).toEqual({ kind: "link-lost", lostAt: 1_800_000_000_000 });
    });

    it("rank 2: a held land carries the run and its reason", () => {
        expect(expressionFor({ heldLand: HELD })).toEqual({
            kind: "run-held",
            runName: "retry budget",
            reason: "merge conflict in policy.go",
        });
    });

    it("rank 3: a depleting window is tired, carrying whose reading it is, the reading, and its reset", () => {
        expect(expressionFor({ rateLimit: HOT })).toEqual({
            kind: "tired",
            provider: "claude",
            pct: 94,
            resetAt: 1_800_000_000,
        });
    });
});

describe("expressionFor — strict precedence", () => {
    it("reads a window as constrained only past the cockpit's ok band", () => {
        expect(isWindowConstrained(HOT)).toBe(true);
        expect(isWindowConstrained({ provider: "claude", pct: 60 })).toBe(false);
        expect(isWindowConstrained(undefined)).toBe(false);
    });

    it("ranks the expressions in the design's order", () => {
        expect(EXPRESSION_RANK["link-lost"]).toBeLessThan(EXPRESSION_RANK["run-held"]);
        expect(EXPRESSION_RANK["run-held"]).toBeLessThan(EXPRESSION_RANK.tired);
        expect(EXPRESSION_RANK.tired).toBeLessThan(EXPRESSION_RANK["at-rest"]);
    });

    it("wears link lost over every other fault, and run held over tired", () => {
        expect(expressionFor({ link: LINK, heldLand: HELD, rateLimit: HOT }).kind).toBe("link-lost");
        expect(expressionFor({ heldLand: HELD, rateLimit: HOT }).kind).toBe("run-held");
    });
});

describe("expressionFor — nothing present is at-rest", () => {
    it("yields at-rest for no signals at all", () => {
        expect(expressionFor({})).toEqual({ kind: "at-rest" });
    });

    // an absent field means "no signal", never "signal absent" — which is what lets the ranks with no
    // source yet ship inert instead of firing on undefined.
    it("yields at-rest when a signal is present but says nothing is wrong", () => {
        expect(expressionFor({ rateLimit: { provider: "claude", pct: 12 } }).kind).toBe("at-rest");
        expect(expressionFor({ attention: { reviewGates: 3, escalations: 1, blockedWorkers: 2 } }).kind).toBe(
            "at-rest"
        );
    });

    it("does not treat a zero reading as a constraint", () => {
        expect(expressionFor({ rateLimit: { provider: "claude", pct: 0 } }).kind).toBe("at-rest");
    });
});

describe("heldLandFrom", () => {
    it("takes the first held land, naming its run and its bare reason", () => {
        const items = [
            attentionItem("dag-gate", "gate run"),
            attentionItem("run-land-held", "first held", "conflict"),
            attentionItem("run-land-held", "second held", "other"),
        ];
        expect(heldLandFrom(items)).toEqual({ runName: "first held", reason: "conflict" });
    });

    it("reads a missing reason as empty", () => {
        expect(heldLandFrom([attentionItem("run-land-held", "held run")])).toEqual({ runName: "held run", reason: "" });
    });

    // unverified runs are common enough that the avatar would sit red most of the day
    it("never reads an unverified run as a held land", () => {
        const items = [attentionItem("run-unverified", "unverified run", "no verify")];
        expect(heldLandFrom(items)).toBeUndefined();
        expect(expressionFor({ heldLand: heldLandFrom(items) }).kind).toBe("at-rest");
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
            rateLimit: HOT,
            attention: { reviewGates: 0, escalations: 2, blockedWorkers: 0 },
        };
        expect(expressionFor(signals).kind).toBe("tired");
        expect(postureFor(signals)).toBe("escalation");
    });

    it("composes a waiting gate with a held land", () => {
        const signals: PetSignals = {
            heldLand: heldLandFrom([attentionItem("run-land-held", "held run", "conflict")]),
            attention: { reviewGates: 1, escalations: 0, blockedWorkers: 0 },
        };
        expect(expressionFor(signals).kind).toBe("run-held");
        expect(postureFor(signals)).toBe("review-gate");
    });
});

describe("wording", () => {
    const now = 1_800_000_000 * 1000; // the reset moment itself

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

    it("says when the link dropped, in local 24h time", () => {
        const lostAt = new Date(2026, 9, 13, 9, 5).getTime();
        expect(conditionLine({ kind: "link-lost", lostAt }, lostAt + 60_000)).toBe(
            "I can't reach the backend — nothing here has updated since 09:05."
        );
    });

    it("names the held run and why it is held", () => {
        expect(conditionLine({ kind: "run-held", runName: "retry budget", reason: "merge conflict" }, now)).toBe(
            "retry budget can't land — merge conflict."
        );
    });

    // the reason is the raw hold reason, which can be empty or already a sentence
    it("never prints an empty reason or a doubled period", () => {
        expect(conditionLine({ kind: "run-held", runName: "retry budget", reason: "" }, now)).toBe(
            "retry budget can't land."
        );
        expect(conditionLine({ kind: "run-held", runName: "retry budget", reason: "base moved." }, now)).toBe(
            "retry budget can't land — base moved."
        );
    });

    it("gives every expression and every posture a line", () => {
        expect(conditionLine({ kind: "at-rest" }, now)).not.toBe("");
        expect(postureLine("review-gate")).not.toBe("");
        expect(postureLine("escalation")).not.toBe("");
        expect(postureLine("blocked-worker")).not.toBe("");
        expect(postureLine("none")).toBe("");
    });
});

// The peek lists every standing condition, where the creature wears only one. Precedence decides which
// LEADS rather than capping the list at one — recall off AND a depleting window is a real pair, and the
// old panel stated such a pair twice: once as a banner, once as a tile.
describe("conditionsFor — every standing condition, in rank order", () => {
    it("returns nothing to say when no signal is degraded", () => {
        expect(conditionsFor({})).toEqual([]);
    });

    it("lists every standing fault once, in rank order", () => {
        expect(conditionsFor({ rateLimit: HOT, heldLand: HELD, link: LINK }).map((c) => c.kind)).toEqual([
            "link-lost",
            "run-held",
            "tired",
        ]);
        expect(conditionsFor({ link: LINK, heldLand: HELD }).map((c) => c.kind)).toEqual(["link-lost", "run-held"]);
    });

    it("carries each condition whole, so conditionLine can word it without re-deriving", () => {
        expect(conditionsFor({ rateLimit: HOT })).toEqual([
            { kind: "tired", provider: "claude", pct: 94, resetAt: 1_800_000_000 },
        ]);
    });

    it("never lists at-rest: an empty list is how quiet is spelled", () => {
        expect(conditionsFor({}).some((c) => c.kind === "at-rest")).toBe(false);
    });

    // the crossing rule: the creature wears one face, and the peek's lead line must be that same face.
    // Two derivations of the same precedence would let the corner and the panel disagree.
    it("leads with exactly the expression the creature is wearing", () => {
        for (const signals of [
            { rateLimit: HOT },
            { heldLand: HELD, rateLimit: HOT },
            { link: LINK, heldLand: HELD },
        ]) {
            expect(conditionsFor(signals)[0]).toEqual(expressionFor(signals));
        }
    });
});
