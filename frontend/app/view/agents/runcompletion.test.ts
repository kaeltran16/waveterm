// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { fmtBytes, fmtDuration, needsEvidenceSeal, phaseHistory, runShortId, verifCounts, verifTone } from "./runcompletion";

describe("runcompletion derivations", () => {
    it("formats a short id", () => {
        expect(runShortId("a1f9c3de-0000")).toBe("a1f9c3");
    });
    it("formats duration and bytes", () => {
        expect(fmtDuration(848000)).toBe("14m 08s");
        expect(fmtDuration(9000)).toBe("9s");
        expect(fmtBytes(214 * 1024)).toBe("214 KB");
    });
    it("maps verif tone + counts", () => {
        expect(verifTone("pass").icon).toBe("✓");
        expect(verifTone("fail").icon).toBe("✕");
        expect(verifTone("unknown").icon).toBe("?");
        const counts = verifCounts([
            { cmd: "a", result: "pass" }, { cmd: "b", result: "fail" }, { cmd: "c", result: "pass" },
        ] as EvidenceVerif[]);
        expect(counts).toEqual({ pass: 2, fail: 1, unknown: 0 });
    });
    it("builds phase history with a freshctx boundary node and gate tag", () => {
        const run = {
            id: "r", phases: [
                { kind: "brainstorm", skill: "superpowers:brainstorming", state: "done", startedts: 1000, donets: 2000 },
                { kind: "plan", skill: "superpowers:writing-plans", state: "done", gate: true, donets: 3000 },
                { kind: "execute", state: "done", freshctx: true, donets: 4000, artifacts: ["merged"] },
            ],
        } as unknown as Run;
        const nodes = phaseHistory(run);
        // brainstorm, plan(gate), execute(boundary) -> 3 nodes; the execute node is flagged isBoundary
        expect(nodes.map((n) => n.name)).toEqual(["Brainstorm", "Plan", "Execute"]);
        expect(nodes[1].isGate).toBe(true);
        expect(nodes[2].isBoundary).toBe(true);
        expect(nodes[2].notLast).toBe(false);
    });
    it("flags a done run without evidence for backfill", () => {
        expect(needsEvidenceSeal({ status: "done" } as Run)).toBe(true);
        expect(needsEvidenceSeal({ status: "done", evidence: {} } as unknown as Run)).toBe(false);
        expect(needsEvidenceSeal({ status: "executing" } as Run)).toBe(false);
    });
});
