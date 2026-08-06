// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { actsForVault } from "./petacts";

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
