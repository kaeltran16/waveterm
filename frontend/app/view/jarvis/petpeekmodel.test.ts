import { describe, expect, it } from "vitest";
import { dedupeUpdates, peekConditions, queueRows } from "./petpeekmodel";
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

function channels(meta: Record<string, unknown>): Channel[] {
    return [{ otype: "channel", oid: CH, version: 1, name: "wave-core", meta }] as Channel[];
}

const CONCIERGE = channels({});
const DELEGATOR = channels({ "delegator:enabled": true });

describe("queueRows — detail earns its line, it is not given one", () => {
    // The row's scarcest resource is horizontal space, and four of the five kinds spend it on a constant
    // string that the verb button already implies. Only a question is worth the width.
    it("drops the detail of kinds whose text is boilerplate", () => {
        const rows = queueRows([GATE, DAG_GATE, ASK], CONCIERGE);
        expect(rows.map((r) => r.detail)).toEqual([null, null, null]);
    });

    it("keeps the detail of kinds whose text is the payload", () => {
        const rows = queueRows([ESCALATION, DAG_BLOCKED], CONCIERGE);
        expect(rows[0].detail).toBe("Phase 3 wants to rewrite peterrandmodel.ts — the tier only covers reads. Allow?");
        expect(rows[1].detail).toBe("3 consecutive failures — decide retry/skip.");
    });

    // the row's left bar is toned by kind, and the renderer must not have to re-look-up the item to know
    // which — a second lookup is how the bar and the verb get to disagree about what a row is.
    it("carries the kind through, so the row can be toned without a second lookup", () => {
        expect(queueRows([GATE, ESCALATION, ASK], CONCIERGE).map((r) => r.kind)).toEqual(["gate", "escalation", "ask"]);
    });

    it("still carries the source of every row, boilerplate or not", () => {
        expect(queueRows([GATE, ASK], CONCIERGE).map((r) => r.source)).toEqual([
            "Ship autonomy ladder tier gating",
            "phase-2 worker",
        ]);
    });
});

describe("queueRows — the button says what the item needs, not how to get there", () => {
    // actsForAttention returns exactly one act for everything but a delegator-tier gate, and it is
    // labelled "Open". "Review" / "Decide" / "Answer" is the same navigation named by its purpose.
    it("labels the primary act from the item's own action verb", () => {
        expect(queueRows([GATE], CONCIERGE)[0].primary?.label).toBe("Review");
        expect(queueRows([ESCALATION], CONCIERGE)[0].primary?.label).toBe("Decide");
        expect(queueRows([ASK], CONCIERGE)[0].primary?.label).toBe("Answer");
    });

    it("keeps the relabelled act pointed at the run it came from", () => {
        const primary = queueRows([GATE], CONCIERGE)[0].primary;
        if (primary?.verb !== "open") {
            throw new Error(`expected an open escort, got ${primary?.verb}`);
        }
        expect(primary.target).toEqual({ kind: "oref", ref: `run:${RUN}` });
    });

    it("offers no button at all for an item with nothing addressable behind it", () => {
        const orphan = item({ kind: "ask", key: "ask:block:b9", runid: undefined, action: "Answer" });
        const row = queueRows([orphan], CONCIERGE)[0];
        expect(row.primary).toBeNull();
        expect(row.more).toEqual([]);
        expect(row.source).toBe("a source");
    });
});

describe("queueRows — secondary acts stay behind the row's own disclosure", () => {
    it("puts a delegator gate's resolving verbs in more, leaving the primary the escort", () => {
        const row = queueRows([GATE], DELEGATOR)[0];
        expect(row.primary?.label).toBe("Review");
        expect(row.more.map((a) => a.label)).toEqual(["Approve", "Send back"]);
    });

    it("has nothing to disclose for the same gate at a lower tier", () => {
        expect(queueRows([GATE], CONCIERGE)[0].more).toEqual([]);
    });

    it("has nothing to disclose for a non-gate even at delegator tier", () => {
        expect(queueRows([ESCALATION], DELEGATOR)[0].more).toEqual([]);
    });
});

describe("queueRows — the server's ranking is authoritative", () => {
    // BuildAttention already sorts gates, then escalations, then asks, oldest first within a kind.
    // Re-sorting here would make the peek and the nav badge disagree about which waiting matters most.
    it("preserves the order it is given", () => {
        const rows = queueRows([GATE, ESCALATION, ASK], CONCIERGE);
        expect(rows.map((r) => r.key)).toEqual([GATE.key, ESCALATION.key, ASK.key]);
    });

    it("survives a channel list that has not loaded yet, at the lowest tier", () => {
        const rows = queueRows([GATE], null);
        expect(rows[0].primary?.label).toBe("Review");
        expect(rows[0].more).toEqual([]);
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

describe("peekConditions — a remedy on the row, or an honest readout", () => {
    const OFF = { state: "off", reason: "disabled" } as EmbedIndexStatus;
    const HOT = { provider: "claude", pct: 94, resetAt: 1_800_000_000 };
    const DRIFT = { queueDepth: 9, staleNotes: 4 };
    const CANDIDATES = [{ reason: "superseded" }, { reason: "weak" }] as MemoryPruneCandidate[];
    const none = { index: null, prune: null };

    it("hands each condition the acts that resolve it", () => {
        const [recall] = peekConditions({ index: { state: "off" } }, { index: OFF, prune: null });
        expect(recall.acts.map((a) => a.label)).toEqual(["Set up"]);

        const [vault] = peekConditions({ decay: DRIFT }, { index: null, prune: CANDIDATES });
        expect(vault.acts.map((a) => a.label)).toEqual(["Review 2", "Clear 1 superseded"]);
    });

    // documented in petacts.ts: the countdown is the one row with genuinely nothing to do, and it is
    // honest rather than an omission. It must not read as a row whose button failed to load.
    it("marks a depleting window a readout, with no acts", () => {
        const [tired] = peekConditions({ rateLimit: HOT }, none);
        expect(tired.expr.kind).toBe("tired");
        expect(tired.acts).toEqual([]);
        expect(tired.readout).toBe(true);
    });

    // an empty act list is not the same fact as having no remedy: memPruneAtom is not read until the
    // Memory surface is visited, so treating "no acts yet" as a readout would lie about a vault that
    // does have a cleanup queue.
    it("does not call a condition a readout merely because its acts have not loaded", () => {
        const [vault] = peekConditions({ decay: DRIFT }, none);
        expect(vault.acts).toEqual([]);
        expect(vault.readout).toBe(false);
    });

    it("keeps the ranked order and stays empty when nothing is degraded", () => {
        const all = peekConditions({ index: { state: "off" }, rateLimit: HOT, decay: DRIFT }, none);
        expect(all.map((c) => c.expr.kind)).toEqual(["cannot-see", "tired", "drifting"]);
        expect(peekConditions({}, none)).toEqual([]);
    });
});
