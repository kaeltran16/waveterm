// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { actsForAttention, actsForEvent, actsForRecall } from "./petacts";

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
    it("escorts to the waiting thing", () => {
        expect(actsForAttention(gate()).map((a) => a.label)).toEqual(["Open"]);
        expect(actsForAttention(gate())[0]).toMatchObject({ verb: "open", target: { kind: "oref", ref: "run:run1" } });
    });

    // Slice 5c deleted the review gate, the one attention kind a button could settle. Nothing is left that
    // a click resolves in place, so no kind may offer a second act.
    it("offers an escort and nothing else, whatever the kind", () => {
        for (const kind of ["gate", "escalation", "ask", "dag-blocked"]) {
            const it = { ...gate(), kind, key: `${kind}:m1` } as AttentionItem;
            expect(actsForAttention(it).map((a) => a.label)).toEqual(["Open"]);
        }
    });

    it("offers nothing at all for an item with no run to address", () => {
        const orphan = { ...gate(), runid: "" } as AttentionItem;
        expect(actsForAttention(orphan)).toEqual([]);
    });
});

describe("actsForEvent", () => {
    const ev = {
        id: "a1",
        sources: [
            { ref: "task:task-a", title: "a task", sourceType: "dossier" },
            { ref: "run:run-b", title: "a run", sourceType: "run" },
        ],
    };

    it("offers Open and Ask for each source", () => {
        expect(actsForEvent(ev).map((a) => a.label)).toEqual(["Open a task", "Ask", "Open a run", "Ask"]);
    });

    it("addresses each Open at the source's own ref, and seeds the Ask from it", () => {
        const [open, ask] = actsForEvent(ev);
        expect(open).toMatchObject({ verb: "open", target: { kind: "oref", ref: "task:task-a" } });
        expect(ask).toMatchObject({ verb: "ask", seed: { ref: "task:task-a", sourceType: "dossier" } });
    });

    it("offers nothing for an utterance with no sources", () => {
        expect(actsForEvent({ id: "x" })).toEqual([]);
    });
});
