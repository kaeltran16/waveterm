// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildRecordPeek, PEEK_ABSENCE_CHIP, statusPickerRows, type RecordPeekInput } from "./briefpeek";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const detail = (over: Partial<DossierDetail> = {}): DossierDetail =>
    ({
        id: "task-a",
        ticket: "",
        objective: "Make attention polling reliable",
        acceptance: [],
        confidence: "",
        status: "active",
        created: NOW - 30 * DAY,
        updated: NOW - 3 * DAY,
        state: "",
        blockers: [],
        refs: [],
        notes: "",
        decisions: [],
        ...over,
    }) as DossierDetail;

const run = (over: Partial<Run> = {}): Run =>
    ({
        id: "r-1234567890",
        goal: "rewrite the poller",
        status: "done",
        createdts: NOW - 2 * DAY,
        phases: [],
        ...over,
    }) as unknown as Run;

const input = (over: Partial<RecordPeekInput> = {}): RecordPeekInput => ({
    detail: detail(),
    runs: [],
    fleet: { workers: [], channelCount: 0 },
    counts: { working: 0, waiting: 0 },
    harnesses: [],
    now: NOW,
    ...over,
});

describe("statusPickerRows", () => {
    it("marks the current status and offers every legal transition from it", () => {
        const rows = statusPickerRows("active");
        expect(rows.map((r) => r.status)).toEqual(["active", "paused", "completed", "archived"]);
        expect(rows.filter((r) => r.current).map((r) => r.status)).toEqual(["active"]);
    });

    // the mockup draws four fixed rows; paused is not reachable from completed, so a fixed four would put a
    // button there that cannot do anything.
    it("omits a status that is not a legal transition rather than rendering a dead control", () => {
        const rows = statusPickerRows("completed");
        expect(rows.map((r) => r.status)).toEqual(["active", "completed", "archived"]);
        expect(rows.find((r) => r.status === "paused")).toBeUndefined();
    });

    it("flags the two transitions that need confirming", () => {
        const rows = statusPickerRows("active");
        expect(rows.filter((r) => r.terminal).map((r) => r.status)).toEqual(["completed", "archived"]);
    });

    it("gives every offered status a note, so no row is a bare word", () => {
        for (const from of ["active", "paused", "completed", "archived"]) {
            for (const row of statusPickerRows(from)) {
                expect(row.note).not.toBe("");
            }
        }
    });

    // a status this build has no note for still yields its legal transitions; it simply has no current row
    it("has no current row for a status it does not recognize", () => {
        const rows = statusPickerRows("mothballed");
        expect(rows.every((r) => !r.current)).toBe(true);
    });
});

describe("buildRecordPeek", () => {
    // the mockup's header prints a freshness word in green; DossierDetail carries no freshness reading at
    // all, so the peek says when it was last updated instead of asserting a check nobody ran.
    it("states when the record was updated rather than a freshness reading", () => {
        expect(buildRecordPeek(input()).updatedLabel).toBe("updated 3d ago");
    });

    it("says so plainly when the record has never been updated", () => {
        expect(buildRecordPeek(input({ detail: detail({ updated: 0 }) })).updatedLabel).toBe("never updated");
    });

    it("titles the peek by its objective and falls back to its id", () => {
        expect(buildRecordPeek(input()).title).toBe("Make attention polling reliable");
        expect(buildRecordPeek(input({ detail: detail({ objective: "  " }) })).title).toBe("task-a");
    });

    it("falls back from a missing objective to the notes, then to a stated absence", () => {
        expect(buildRecordPeek(input({ detail: detail({ objective: "", notes: "scratch" }) })).body).toBe("scratch");
        expect(buildRecordPeek(input({ detail: detail({ objective: "", notes: "" }) })).body).toBe(
            "This record states no objective yet."
        );
    });

    // the rows are runs; the meta line counts workers across channels. They are different numbers on
    // purpose — a record's fleet crosses channels, so counting the rows would understate it.
    it("counts workers and channels in the fleet line, not the run rows beneath it", () => {
        const peek = buildRecordPeek(
            input({
                runs: [run(), run({ id: "r-2" }), run({ id: "r-3" })],
                fleet: { workers: [], channelCount: 2 },
                counts: { working: 4, waiting: 1 },
            })
        );
        expect(peek.fleetMeta).toBe("4 working · 2 channels");
        expect(peek.runs).toHaveLength(3);
    });

    it("says a record has never been worked rather than showing an empty band", () => {
        expect(buildRecordPeek(input()).runsAbsent).toBe("No session has ever been attributed to this record.");
        expect(buildRecordPeek(input()).runs).toEqual([]);
    });

    // runRow suppresses a goal that merely echoes the objective, to stop N identical lines. A suppressed
    // headline still has to leave something readable in the row.
    it("names the run when its goal only echoes the record's objective", () => {
        const peek = buildRecordPeek(
            input({ runs: [run({ goal: "Make attention polling reliable", evidence: undefined })] })
        );
        expect(peek.runs[0].headline).toBe("run r-123456");
    });

    it("carries each run's own status label and tone", () => {
        const peek = buildRecordPeek(input({ runs: [run({ status: "blocked" })] }));
        expect(peek.runs[0].state).toBe("blocked");
        expect(peek.runs[0].tone).toBe("blocked");
    });

    it("derives the decision count and points it at Vault", () => {
        expect(buildRecordPeek(input()).logLine).toBe("no decisions yet");
        expect(
            buildRecordPeek(input({ detail: detail({ decisions: [{}] as unknown as DecisionCard[] }) })).logLine
        ).toBe("1 decision · in Vault");
        expect(
            buildRecordPeek(input({ detail: detail({ decisions: [{}, {}] as unknown as DecisionCard[] }) })).logLine
        ).toBe("2 decisions · in Vault");
    });

    // the structural absence the meta spec asks the peek to state outright
    it("states that a record cannot be messaged", () => {
        expect(buildRecordPeek(input()).absenceChip).toBe(PEEK_ABSENCE_CHIP);
        expect(buildRecordPeek(input()).absenceChip).toContain("cannot message one");
    });

    it("states the read/write split in its footer", () => {
        const footer = buildRecordPeek(input()).footer;
        expect(footer).toContain("Vault");
        expect(footer).toContain("decision log");
    });
});
