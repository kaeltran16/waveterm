// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { fmtBytes, fmtDuration, fmtGB, needsEvidenceSeal, verifCounts } from "./runcompletion";

describe("runcompletion derivations", () => {
    it("fmtGB one decimal", () => {
        expect(fmtGB(3.5 * 1024 ** 3)).toBe("3.5 GB");
        expect(fmtGB(2.14 * 1024 ** 3)).toBe("2.1 GB");
        expect(fmtGB(512 * 1024 ** 2)).toBe("0.5 GB");
        expect(fmtGB(0)).toBe("0.0 GB");
    });
    it("formats duration and bytes", () => {
        expect(fmtDuration(848000)).toBe("14m 08s");
        expect(fmtDuration(9000)).toBe("9s");
        expect(fmtBytes(214 * 1024)).toBe("214 KB");
    });
    it("reads a sub-second duration as <1s, not a rounded 1s", () => {
        expect(fmtDuration(211)).toBe("<1s");
        expect(fmtDuration(999)).toBe("<1s");
        expect(fmtDuration(1500)).toBe("2s");
        expect(fmtDuration(0)).toBe("0s");
    });
    it("reads an hour or more in hours, and a day or more in days", () => {
        const MIN = 60_000;
        const HOUR = 60 * MIN;
        expect(fmtDuration(59 * MIN)).toBe("59m 00s");
        expect(fmtDuration(HOUR)).toBe("1h 00m");
        expect(fmtDuration(2 * HOUR + 5 * MIN)).toBe("2h 05m");
        expect(fmtDuration(25 * HOUR)).toBe("1d 1h");
        expect(fmtDuration(76 * HOUR)).toBe("3d 4h");
        // specimen 137's "58867m 57s"
        expect(fmtDuration(58867 * MIN + 57_000)).toBe("40d 21h");
    });
    it("counts verifications by result", () => {
        const counts = verifCounts([
            { cmd: "a", result: "pass" },
            { cmd: "b", result: "fail" },
            { cmd: "c", result: "pass" },
        ] as EvidenceVerif[]);
        expect(counts).toEqual({ pass: 2, fail: 1, unknown: 0 });
    });
    it("flags a done run without evidence for backfill", () => {
        expect(needsEvidenceSeal({ status: "done" } as Run)).toBe(true);
        expect(needsEvidenceSeal({ status: "done", evidence: {} } as unknown as Run)).toBe(false);
        expect(needsEvidenceSeal({ status: "executing" } as Run)).toBe(false);
    });
});
