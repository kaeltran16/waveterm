import { INITIAL_LINK } from "@/app/store/wslink";
import { describe, expect, it } from "vitest";
import { postureFor } from "./petcondition";
import { petSignalsFrom } from "./petsignals";

const NOW = 1_800_000_000_000;

function item(kind: string, source: string, reason?: string): AttentionItem {
    return { kind, key: `${kind}:${source}`, source, text: "", reason, action: "Open", phaseidx: 0, waitingsince: 0 };
}

function signals(attention: AttentionItem[]) {
    return petSignalsFrom({ agents: [], savedRateLimits: {}, now: NOW, attention, link: INITIAL_LINK });
}

describe("petSignalsFrom", () => {
    it("an escalation in attention gives the escalation posture, and a blocked dag none", () => {
        expect(postureFor(signals([item("escalation", "run a")]))).toBe("escalation");
        expect(postureFor(signals([item("dag-blocked", "run a")]))).toBe("none");
    });

    it("a run-land-held item gives heldLand with the run and its reason", () => {
        expect(signals([item("run-land-held", "retry budget", "merge conflict")]).heldLand).toEqual({
            runName: "retry budget",
            reason: "merge conflict",
        });
    });

    it("an ask alone gives the blocked-worker posture", () => {
        expect(postureFor(signals([item("ask", "worker")]))).toBe("blocked-worker");
    });

    it("a link down past the grace becomes the link signal, a boot that never connected does not", () => {
        const down = { connected: false, everConnected: true, lostAt: NOW - 5000 };
        const lost = petSignalsFrom({ agents: [], savedRateLimits: {}, now: NOW, attention: [], link: down });
        expect(lost.link).toEqual({ lostAt: NOW - 5000 });
        expect(signals([]).link).toBeUndefined();
    });
});
