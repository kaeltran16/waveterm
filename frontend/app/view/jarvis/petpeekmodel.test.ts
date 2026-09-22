import { describe, expect, it } from "vitest";
import { dedupeUpdates, peekActForCommand, peekConditions, peekKeyCommand, queueRows } from "./petpeekmodel";
import type { PetEvent } from "./petvoice";

const RUN = "run-1";
const CH = "chan-1";

function item(over: Partial<AttentionItem> & Pick<AttentionItem, "kind" | "key">): AttentionItem {
    return {
        source: "a source",
        text: "some text",
        action: "Review",
        phaseidx: 0,
        waitingsince: 1_000,
        channelid: CH,
        runid: RUN,
        ...over,
    } as AttentionItem;
}

// pkg/jarvis/attention.go fills Text per kind: a gate's is the constant "Approve before Jarvis proceeds.",
// an ask's the constant "Waiting on your reply", while an escalation's is the worker's actual question.
const GATE = item({ kind: "gate", key: "gate:" + RUN, source: "Ship autonomy ladder tier gating", text: "Approve before Jarvis proceeds." }); // prettier-ignore
const DAG_GATE = item({ kind: "dag-gate", key: "dag-gate:g1", text: "Approve the gate before the DAG proceeds." }); // prettier-ignore
const ESCALATION = item({ kind: "escalation", key: "esc:m1", source: "gatekeeper", action: "Decide", text: "Phase 3 wants to rewrite peterrandmodel.ts — the tier only covers reads. Allow?" }); // prettier-ignore
const DAG_BLOCKED = item({ kind: "dag-blocked", key: "dag-blocked:g2", text: "3 consecutive failures — decide retry/skip." }); // prettier-ignore
const ASK = item({ kind: "ask", key: "ask:block:b1", source: "phase-2 worker", action: "Answer", text: "Waiting on your reply" }); // prettier-ignore

const RADAR = item({ kind: "radar-triage", key: "radar:rep-1", source: "waveterm", action: "Triage", text: "4 findings need triage.", channelid: "", runid: "", oref: "radarreport:rep-1" } as Partial<AttentionItem> & Pick<AttentionItem, "kind" | "key">); // prettier-ignore

describe("queueRows — the creature only holds what it can resolve", () => {
    // Radar triage names no channel and no run, so actsForAttention has nothing to offer it and the row
    // rendered as a project name, an age, and nothing to press. The Radar rail's badge and the Brief's
    // queue both address it through its ORef; the peek cannot, so it must not claim it is waiting here.
    it("drops radar triage, whose destination the peek cannot reach", () => {
        expect(queueRows([RADAR])).toEqual([]);
    });

    it("keeps every other waiting kind in wire order", () => {
        expect(queueRows([GATE, RADAR, ESCALATION]).map((r) => r.kind)).toEqual(["gate", "escalation"]);
    });
});

describe("queueRows — detail earns its line, it is not given one", () => {
    // The row's scarcest resource is horizontal space, and four of the five kinds spend it on a constant
    // string that the verb button already implies. Only a question is worth the width.
    it("drops the detail of kinds whose text is boilerplate", () => {
        const rows = queueRows([GATE, DAG_GATE, ASK]);
        expect(rows.map((r) => r.detail)).toEqual([null, null, null]);
    });

    it("keeps the detail of kinds whose text is the payload", () => {
        const rows = queueRows([ESCALATION, DAG_BLOCKED]);
        expect(rows[0].detail).toBe("Phase 3 wants to rewrite peterrandmodel.ts — the tier only covers reads. Allow?");
        expect(rows[1].detail).toBe("3 consecutive failures — decide retry/skip.");
    });

    // the row's left bar is toned by kind, and the renderer must not have to re-look-up the item to know
    // which — a second lookup is how the bar and the verb get to disagree about what a row is.
    it("carries the kind through, so the row can be toned without a second lookup", () => {
        expect(queueRows([GATE, ESCALATION, ASK]).map((r) => r.kind)).toEqual(["gate", "escalation", "ask"]);
    });

    it("still carries the source of every row, boilerplate or not", () => {
        expect(queueRows([GATE, ASK]).map((r) => r.source)).toEqual([
            "Ship autonomy ladder tier gating",
            "phase-2 worker",
        ]);
    });
});

describe("queueRows — the button says what the item needs, not how to get there", () => {
    // actsForAttention returns exactly one act for everything but a delegator-tier gate, and it is
    // labelled "Open". "Review" / "Decide" / "Answer" is the same navigation named by its purpose.
    it("labels the primary act from the item's own action verb", () => {
        expect(queueRows([GATE])[0].primary?.label).toBe("Review");
        expect(queueRows([ESCALATION])[0].primary?.label).toBe("Decide");
        expect(queueRows([ASK])[0].primary?.label).toBe("Answer");
    });

    it("keeps the relabelled act pointed at the run it came from", () => {
        const primary = queueRows([GATE])[0].primary;
        if (primary?.verb !== "open") {
            throw new Error(`expected an open escort, got ${primary?.verb}`);
        }
        expect(primary.target).toEqual({ kind: "oref", ref: `run:${RUN}` });
    });

    it("offers no button at all for an item with nothing addressable behind it", () => {
        const orphan = item({ kind: "ask", key: "ask:block:b9", runid: undefined, action: "Answer" });
        const row = queueRows([orphan])[0];
        expect(row.primary).toBeNull();
        expect(row.source).toBe("a source");
    });
});

describe("queueRows — the server's ranking is authoritative", () => {
    // BuildAttention already sorts gates, then escalations, then asks, oldest first within a kind.
    // Re-sorting here would make the peek and the nav badge disagree about which waiting matters most.
    it("preserves the order it is given", () => {
        const rows = queueRows([GATE, ESCALATION, ASK]);
        expect(rows.map((r) => r.key)).toEqual([GATE.key, ESCALATION.key, ASK.key]);
    });

    it("gives every waiting row its escort, relabelled by what the item needs", () => {
        const rows = queueRows([GATE]);
        expect(rows[0].primary?.label).toBe("Review");
    });
});

describe("dedupeUpdates — report each thing once", () => {
    const askEvent: PetEvent = { id: "ask:a1", at: 5, kind: "ask", text: "phase-2 worker is waiting", ref: "block:b1" };
    const sweep: PetEvent = { id: "sweep:1", at: 4, kind: "sweep", text: "Swept the vault while you were out." };

    it("drops a spoken ask that is already a row in the queue", () => {
        expect(dedupeUpdates([askEvent, sweep], [ASK]).map((e) => e.id)).toEqual(["sweep:1"]);
    });

    it("keeps a spoken ask that no queue row covers", () => {
        expect(dedupeUpdates([askEvent, sweep], [GATE]).map((e) => e.id)).toEqual(["ask:a1", "sweep:1"]);
        expect(dedupeUpdates([askEvent], []).map((e) => e.id)).toEqual(["ask:a1"]);
    });

    it("matches on the ask's block oref, not on the event id", () => {
        // the queue keys an ask "ask:<block oref>" while the event ids itself by ask id — only `ref` joins them
        expect(askEvent.id).not.toBe(ASK.key);
        expect(dedupeUpdates([askEvent], [ASK])).toEqual([]);
    });

    it("leaves every other kind of update alone", () => {
        const events: PetEvent[] = [sweep, { id: "recall:1", at: 3, kind: "recall", text: "You argued this before." }];
        expect(dedupeUpdates(events, [ASK, GATE])).toEqual(events);
    });
});

describe("peekKeyCommand", () => {
    it("maps navigation keys", () => {
        expect(peekKeyCommand("j")).toBe("next");
        expect(peekKeyCommand("ArrowDown")).toBe("next");
        expect(peekKeyCommand("k")).toBe("previous");
        expect(peekKeyCommand("ArrowUp")).toBe("previous");
        expect(peekKeyCommand("Enter")).toBe("open");
    });

    it("maps panel controls", () => {
        expect(peekKeyCommand("c")).toBe("conditions");
        expect(peekKeyCommand("/")).toBe("composer");
        expect(peekKeyCommand("Escape")).toBe("close");
    });

    // a/s were the gate's approve and send back; slice 5c deleted both, so the keys are free again and must
    // not silently keep firing something
    it("ignores unrelated and uppercase keys", () => {
        expect(peekKeyCommand("a")).toBeNull();
        expect(peekKeyCommand("s")).toBeNull();
        expect(peekKeyCommand("x")).toBeNull();
        expect(peekKeyCommand("A")).toBeNull();
    });
});

describe("peekActForCommand", () => {
    it("opens the focused row through its primary act", () => {
        const row = queueRows([ASK])[0];
        expect(peekActForCommand(row, "open")).toBe(row.primary);
    });

    // open is the only command that resolves to an act: no attention kind carries a verb a key could fire.
    it("returns no act for every other command", () => {
        const row = queueRows([GATE])[0];
        for (const command of ["next", "previous", "conditions", "composer", "close"] as const) {
            expect(peekActForCommand(row, command)).toBeNull();
        }
    });

    it("returns no act without a focused row", () => {
        expect(peekActForCommand(undefined, "open")).toBeNull();
    });
});

describe("peekConditions — a remedy on the row, or an honest readout", () => {
    const OFF = { state: "off", reason: "disabled" } as EmbedIndexStatus;
    const HOT = { provider: "claude", pct: 94, resetAt: 1_800_000_000 };
    const none = { index: null };

    it("hands each condition the acts that resolve it", () => {
        const [recall] = peekConditions({ index: { state: "off" } }, { index: OFF });
        expect(recall.acts.map((a) => a.label)).toEqual(["Set up"]);
    });

    // documented in petacts.ts: the countdown is the one row with genuinely nothing to do, and it is
    // honest rather than an omission. It must not read as a row whose button failed to load.
    it("marks a depleting window a readout, with no acts", () => {
        const [tired] = peekConditions({ rateLimit: HOT }, none);
        expect(tired.expr.kind).toBe("tired");
        expect(tired.acts).toEqual([]);
        expect(tired.readout).toBe(true);
    });

    // an empty act list is not the same fact as having no remedy: the index status is null until its read
    // lands, so treating "no acts yet" as a readout would lie about a condition that does have a remedy.
    it("does not call a condition a readout merely because its acts have not loaded", () => {
        const [recall] = peekConditions({ index: { state: "off" } }, none);
        expect(recall.acts).toEqual([]);
        expect(recall.readout).toBe(false);
    });

    it("keeps the ranked order and stays empty when nothing is degraded", () => {
        const all = peekConditions({ index: { state: "off" }, rateLimit: HOT }, none);
        expect(all.map((c) => c.expr.kind)).toEqual(["cannot-see", "tired"]);
        expect(peekConditions({}, none)).toEqual([]);
    });
});
