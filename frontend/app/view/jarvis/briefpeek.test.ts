// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    buildRecordPeek,
    decisionsOpenOnMount,
    objectiveParts,
    statusConfirmCopy,
    statusPickerRows,
    type RecordPeekInput,
} from "./briefpeek";

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

    it("labels each row in sentence case and keeps the stored status lowercase", () => {
        const rows = statusPickerRows("active");
        expect(rows.map((r) => r.label)).toEqual(["Active", "Paused", "Completed", "Archived"]);
        expect(rows.map((r) => r.status)).toEqual(["active", "paused", "completed", "archived"]);
    });

    // the archived board: reactivating is the only move offered
    it("offers only Active from archived, beside the current Archived", () => {
        const rows = statusPickerRows("archived");
        expect(rows.map((r) => [r.label, r.current])).toEqual([
            ["Active", false],
            ["Archived", true],
        ]);
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

    it("titles the peek by its objective's first sentence and falls back to its id", () => {
        expect(buildRecordPeek(input()).title).toBe("Make attention polling reliable");
        expect(buildRecordPeek(input({ detail: detail({ objective: "Ship it. Then tidy up." }) })).title).toBe(
            "Ship it."
        );
        expect(buildRecordPeek(input({ detail: detail({ objective: "  " }) })).title).toBe("task-a");
    });

    // 126 of the user's 163 records are one sentence: printing it as the title and again as the body said it twice
    it("shows no body when the objective is its own headline", () => {
        const peek = buildRecordPeek(input());
        expect(peek.body).toBeNull();
        expect(peek.bodyMore).toBeNull();
    });

    // the title already says the first sentence, so the body starts after it rather than saying it twice
    it("shows the rest of the objective, paragraphs kept, when it says more than its headline", () => {
        const objective = "Ship it.\n\nThen tidy up the rest.\n\nAnd more.";
        const peek = buildRecordPeek(input({ detail: detail({ objective }) }));
        expect(peek.title).toBe("Ship it.");
        expect(peek.body).toBe("Then tidy up the rest.\n\nAnd more.");
        expect(peek.bodyMore).toBeNull();
    });

    it("shows the whole objective when the headline had to cut it", () => {
        const objective = "word ".repeat(60).trim();
        const peek = buildRecordPeek(input({ detail: detail({ objective }) }));
        expect(peek.title.endsWith("…")).toBe(true);
        expect(peek.body).toBe(objective);
    });

    it("offers the full objective only past 400 characters of body, counted in kilo", () => {
        const at = (n: number) => "First sentence. " + "y".repeat(n);
        expect(buildRecordPeek(input({ detail: detail({ objective: at(400) }) })).bodyMore).toBeNull();
        expect(buildRecordPeek(input({ detail: detail({ objective: at(401) }) })).bodyMore).toBe(
            "Show the full objective · 401"
        );
        expect(buildRecordPeek(input({ detail: detail({ objective: at(1216) }) })).bodyMore).toBe(
            "Show the full objective · 1.2k"
        );
    });

    it("falls back from a missing objective to the notes, then to a stated absence, never clamped", () => {
        const notes = buildRecordPeek(input({ detail: detail({ objective: "", notes: "scratch" }) }));
        expect(notes.body).toBe("scratch");
        expect(notes.bodyMore).toBeNull();
        expect(buildRecordPeek(input({ detail: detail({ objective: "", notes: "" }) })).body).toBe(
            "This record states no objective yet."
        );
    });

    it("flags a title that fell back to the record id", () => {
        expect(buildRecordPeek(input({ detail: detail({ objective: "" }) })).titleIsId).toBe(true);
        expect(buildRecordPeek(input({ detail: detail({ objective: "  " }) })).titleIsId).toBe(true);
        expect(buildRecordPeek(input()).titleIsId).toBe(false);
    });

    // only the stated absence reads muted; notes and an objective are content
    it("flags the body only when it is the stated absence", () => {
        expect(buildRecordPeek(input({ detail: detail({ objective: "", notes: "" }) })).bodyIsAbsence).toBe(true);
        expect(buildRecordPeek(input({ detail: detail({ objective: "", notes: "scratch" }) })).bodyIsAbsence).toBe(
            false
        );
        expect(
            buildRecordPeek(input({ detail: detail({ objective: "Ship it.\n\nThen tidy up the rest." }) }))
                .bodyIsAbsence
        ).toBe(false);
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
        expect(buildRecordPeek(input()).runsLoading).toBe(false);
    });

    // runs not read yet are not runs absent: claiming "never attributed" before the read lands is false
    it("reads unloaded runs as loading, with no absence sentence", () => {
        const peek = buildRecordPeek(input({ runs: undefined }));
        expect(peek.runsLoading).toBe(true);
        expect(peek.runsAbsent == null).toBe(true);
        expect(peek.runs).toEqual([]);
    });

    it("states no absence when the record has runs", () => {
        const peek = buildRecordPeek(input({ runs: [run()] }));
        expect(peek.runsLoading).toBe(false);
        expect(peek.runsAbsent).toBeNull();
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

    // the line is the toggle for the peek's own log, so it no longer points somewhere else
    it("labels the decisions toggle with the count", () => {
        const withN = (n: number) =>
            buildRecordPeek(input({ detail: detail({ decisions: Array(n).fill({}) as unknown as DecisionCard[] }) }))
                .logLine;
        expect(withN(0)).toBe("No decisions yet");
        expect(withN(1)).toBe("1 decision");
        expect(withN(3)).toBe("3 decisions");
    });
});

describe("decisionsOpenOnMount", () => {
    const decisions = [{ id: "dec-1" }, { id: "dec-2" }] as unknown as DecisionCard[];

    it("opens the log when the anchor names one of the record's decisions", () => {
        expect(decisionsOpenOnMount("dec-2", decisions)).toBe(true);
    });

    it("stays closed for an anchor on another record, or none", () => {
        expect(decisionsOpenOnMount("dec-9", decisions)).toBe(false);
        expect(decisionsOpenOnMount(null, decisions)).toBe(false);
        expect(decisionsOpenOnMount("dec-1", [])).toBe(false);
    });
});

describe("statusConfirmCopy", () => {
    it("asks about the record and says how to undo it", () => {
        expect(statusConfirmCopy("completed")).toEqual({
            title: "Mark this record completed?",
            body: `This sets the record's status to "completed". You can reactivate it later.`,
        });
    });
});

describe("objectiveParts", () => {
    it("has no body when the objective is one sentence", () => {
        expect(objectiveParts("Make attention polling reliable.")).toEqual({
            headline: "Make attention polling reliable.",
            body: null,
            bodyMore: null,
        });
    });

    it("starts the body after the headline sentence", () => {
        const parts = objectiveParts("Fix the band. It repeats the ticket.\n\nMore detail.");
        expect(parts.headline).toBe("Fix the band.");
        expect(parts.body?.startsWith("It repeats the ticket.")).toBe(true);
        expect(parts.body).not.toContain("Fix the band.");
        expect(parts.bodyMore).toBeNull();
    });

    // a cut headline says only part of its sentence, so the body has to carry the whole of it
    it("keeps the whole objective as the body when the headline had to cut it", () => {
        const objective = "word ".repeat(60).trim() + ". Second sentence.";
        const parts = objectiveParts(objective);
        expect(parts.headline.endsWith("…")).toBe(true);
        expect(parts.body).toBe(objective);
    });

    it("measures the show-more link on the body", () => {
        expect(objectiveParts("Head. " + "y".repeat(401)).bodyMore).toBe("Show the full objective · 401");
        expect(objectiveParts("Head. " + "y".repeat(400)).bodyMore).toBeNull();
    });
});
