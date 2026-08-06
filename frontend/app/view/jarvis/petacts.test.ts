// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { actsForAttention, actsForRecall, actsForVault } from "./petacts";

function cand(id: string, reason: string): MemoryPruneCandidate {
    return { id, title: id, type: "learning", reason, path: `/vault/${id}.md` } as MemoryPruneCandidate;
}

describe("actsForVault", () => {
    it("offers nothing for an empty queue", () => {
        expect(actsForVault([])).toEqual([]);
        expect(actsForVault(null)).toEqual([]);
    });

    it("escorts to the queue, carrying its size in the label", () => {
        const acts = actsForVault([cand("a", "stale"), cand("b", "drift")]);
        expect(acts).toEqual([
            { id: "vault:review", verb: "open", label: "Review 2", target: { kind: "memory-upkeep" } },
        ]);
    });

    it("adds a bounded clear for the superseded subset only", () => {
        const acts = actsForVault([cand("a", "stale"), cand("b", "superseded"), cand("c", "superseded")]);
        expect(acts.map((a) => a.label)).toEqual(["Review 3", "Clear 2 superseded"]);
        expect(acts[1]).toMatchObject({ verb: "do", op: { kind: "clear-superseded", count: 2 } });
    });

    it("offers no clear when nothing is superseded", () => {
        expect(actsForVault([cand("a", "stale")]).map((a) => a.label)).toEqual(["Review 1"]);
    });
});

function status(state: string, reason?: string): EmbedIndexStatus {
    return {
        state,
        reason,
        enabled: true,
        haskey: true,
        indexednodes: 0,
        vaultnodes: 0,
        stalenodes: 0,
    } as EmbedIndexStatus;
}

describe("actsForRecall", () => {
    it("offers nothing when there is no reading or recall is fine", () => {
        expect(actsForRecall(null)).toEqual([]);
        expect(actsForRecall(status("ok"))).toEqual([]);
    });

    it("offers a catch-up for every stale reason, because reconcile is what fixes all three", () => {
        for (const reason of ["content-drift", "model-mismatch", "not-built"]) {
            expect(actsForRecall(status("stale", reason))).toEqual([
                { id: "recall:catchup", verb: "do", label: "Catch up", op: { kind: "reconcile-index" } },
            ]);
        }
    });

    it("escorts to settings when the cause is configuration, which no operation can fix", () => {
        for (const reason of ["disabled", "no-key"]) {
            expect(actsForRecall(status("off", reason))).toEqual([
                { id: "recall:setup", verb: "open", label: "Set up", target: { kind: "settings-embeddings" } },
            ]);
        }
    });

    it("offers a retry for a transient failure, where the result line is the diagnostic", () => {
        for (const reason of ["provider-error", "index-error", "vault-error"]) {
            expect(actsForRecall(status("off", reason))).toEqual([
                { id: "recall:retry", verb: "do", label: "Retry", op: { kind: "reconcile-index" } },
            ]);
        }
    });

    it("offers nothing for a state it has not been taught, rather than guessing a verb", () => {
        expect(actsForRecall(status("rebuilding"))).toEqual([]);
    });
});

function gate(): AttentionItem {
    return {
        kind: "gate",
        key: "gate:run1",
        channelid: "ch1",
        channelname: "wave",
        runid: "run1",
        phaseidx: 1,
        source: "refactor the parser",
        text: "Approve before Jarvis proceeds.",
        action: "Review",
        waitingsince: 1000,
    } as AttentionItem;
}

describe("actsForAttention", () => {
    it("always escorts to the waiting thing, whatever the tier", () => {
        expect(actsForAttention(gate(), "concierge").map((a) => a.label)).toEqual(["Open"]);
    });

    it("adds the resolving verbs only where the target channel granted that authority", () => {
        expect(actsForAttention(gate(), "delegator").map((a) => a.label)).toEqual(["Open", "Approve", "Send back"]);
        expect(actsForAttention(gate(), "gatekeeper").map((a) => a.label)).toEqual(["Open"]);
    });

    it("addresses the run through the phase the server named", () => {
        const acts = actsForAttention(gate(), "delegator");
        expect(acts[1]).toMatchObject({
            verb: "do",
            op: { kind: "gate", channelId: "ch1", runId: "run1", phaseIdx: 1, action: "approve" },
        });
    });

    it("offers only an escort for a kind that has no resolving verb", () => {
        const esc = { ...gate(), kind: "escalation", key: "esc:m1" } as AttentionItem;
        expect(actsForAttention(esc, "delegator").map((a) => a.label)).toEqual(["Open"]);
    });

    it("offers nothing at all for an item with no run to address", () => {
        const orphan = { ...gate(), runid: "" } as AttentionItem;
        expect(actsForAttention(orphan, "delegator")).toEqual([]);
    });
});
