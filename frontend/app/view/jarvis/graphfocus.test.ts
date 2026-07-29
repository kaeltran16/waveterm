// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AmbientTag } from "@/app/view/agents/ambient";
import { describe, expect, it } from "vitest";
import { peekFocus, type PeekFocusInput } from "./graphfocus";

const tag = (taskId: string, bucket: string, state: string): AmbientTag => ({ label: taskId, taskId, bucket, state });

// attribution: a run oref -> the records it is attributed to (what ambient.tagsFor answers).
const attribution =
    (map: Record<string, AmbientTag[]>) =>
    (oref: string): AmbientTag[] =>
        map[oref] ?? [];

const BASE: PeekFocusInput = {
    subject: null,
    runORef: null,
    attachedORefs: [],
    mentionedDossierIds: [],
    tagsFor: () => [],
};

describe("peekFocus", () => {
    it("has nothing to focus with no subject", () => {
        expect(peekFocus(BASE)).toEqual({ dossierId: null, runORef: null });
    });

    it("focuses a record subject on itself", () => {
        expect(peekFocus({ ...BASE, subject: { kind: "dossier", id: "task-418" } })).toEqual({
            dossierId: "task-418",
            runORef: null,
        });
    });

    // the defect: from a channel the peek opened on the whole vault (432 nodes) with nothing selected.
    // A run node exists only inside its record's bloom, so focusing one means naming both.
    it("focuses a channel on its run's record and on the run node", () => {
        expect(
            peekFocus({
                ...BASE,
                subject: { kind: "channel", id: "c1" },
                runORef: "run:r1",
                tagsFor: attribution({ "run:r1": [tag("task-418", "strong", "confirmed")] }),
            })
        ).toEqual({ dossierId: "task-418", runORef: "run:r1" });
    });

    // the record band ranks confirmed first, then strong > medium > weak, and calls the winner the
    // primary. The peek has to land on that same record or the two disagree about the same run.
    it("focuses the same record the band calls primary", () => {
        const focus = peekFocus({
            ...BASE,
            subject: { kind: "channel", id: "c1" },
            runORef: "run:r1",
            tagsFor: attribution({
                "run:r1": [tag("task-402", "weak", "informing"), tag("task-418", "strong", "confirmed")],
            }),
        });
        expect(focus.dossierId).toBe("task-418");
    });

    it("focuses nothing when the channel's run has no attributed record", () => {
        expect(peekFocus({ ...BASE, subject: { kind: "channel", id: "c1" }, runORef: "run:r1" })).toEqual({
            dossierId: null,
            runORef: null,
        });
    });

    it("focuses nothing on a channel with no run selected", () => {
        expect(peekFocus({ ...BASE, subject: { kind: "channel", id: "c1" } })).toEqual({
            dossierId: null,
            runORef: null,
        });
    });

    it("focuses a thread on the run it was opened from", () => {
        expect(
            peekFocus({
                ...BASE,
                subject: { kind: "conversation", id: "v1" },
                attachedORefs: ["run:r7"],
                tagsFor: attribution({ "run:r7": [tag("task-418", "medium", "informing")] }),
            })
        ).toEqual({ dossierId: "task-418", runORef: "run:r7" });
    });

    it("focuses a thread on the record it was opened from", () => {
        expect(
            peekFocus({ ...BASE, subject: { kind: "conversation", id: "v1" }, attachedORefs: ["task:task-402"] })
        ).toEqual({ dossierId: "task-402", runORef: null });
    });

    it("falls back to a record the thread cited when nothing is attached", () => {
        expect(
            peekFocus({ ...BASE, subject: { kind: "conversation", id: "v1" }, mentionedDossierIds: ["task-511"] })
        ).toEqual({ dossierId: "task-511", runORef: null });
    });

    // a radar finding and a memory note have no node the peek can name: radar is not a vault collection,
    // and a note's graph id is its vault path, not the oref. Say so by focusing nothing — the overlay's
    // filter is the way in — rather than guessing at an id and selecting the wrong node.
    it("focuses nothing for an attachment with no graph node", () => {
        expect(
            peekFocus({ ...BASE, subject: { kind: "conversation", id: "v1" }, attachedORefs: ["radar:f1"] })
        ).toEqual({ dossierId: null, runORef: null });
    });
});
