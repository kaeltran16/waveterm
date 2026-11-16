// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    bareEffortId,
    buildInitiativeCard,
    effortListModel,
    effortListRequest,
    effortShowModel,
    LIST_ROWS_SHOWN,
    SHOW_CHUNKS_SHOWN,
} from "./initiativecards";
import { firstWshCall, type WshCall } from "./wshcall";

const callOf = (command: string): WshCall => firstWshCall(command)!.call;

const chunk = (label: string, status = "pending", notes = 0): EffortChunk => ({
    label,
    status,
    notes: Array.from({ length: notes }, (_, i) => ({ ts: i + 1, text: `n${i}` })),
    updatedts: 1,
});

const effort = (chunks: EffortChunk[], extra: Partial<Effort> = {}): Effort =>
    ({
        otype: "effort",
        oid: "e1",
        version: 1,
        title: "Retry rework",
        project: "waveterm",
        status: "active",
        chunks,
        createdts: 1,
        updatedts: 1,
        ...extra,
    }) as Effort;

const THREE = effort([chunk("Fix the wait", "done"), chunk("Add jitter", "active", 2), chunk("Ship it")]);

describe("bareEffortId", () => {
    it("strips the effort: prefix and leaves a bare id alone", () => {
        expect(bareEffortId("effort:f283ad11")).toBe("f283ad11");
        expect(bareEffortId("f283ad11")).toBe("f283ad11");
    });
});

describe("chunk-status cards", () => {
    it("done, from argv alone: the chunk number and the note, no progress", () => {
        const m = buildInitiativeCard(
            "chunk-status",
            callOf('wsh effort chunk status e1 2 done --note "fixed it"'),
            {}
        );
        expect(m).toMatchObject({ kind: "chunk-done", effortId: "e1", chunk: { number: 2 }, note: "fixed it" });
        expect(m).not.toHaveProperty("progress");
    });

    it("done, with the record: the label, the progress and the title", () => {
        const m = buildInitiativeCard("chunk-status", callOf("wsh effort chunk status effort:e1 1 done"), {
            effort: THREE,
        });
        expect(m).toMatchObject({
            kind: "chunk-done",
            effortId: "e1",
            chunk: { number: 1, label: "Fix the wait" },
            progress: { done: 1, total: 3 },
            title: "Retry rework",
        });
    });

    it("a chunk named by label resolves its number from the record", () => {
        const m = buildInitiativeCard("chunk-status", callOf('wsh effort chunk status e1 "Add jitter" done'), {
            effort: THREE,
        });
        expect(m).toMatchObject({ kind: "chunk-done", chunk: { number: 2, label: "Add jitter" } });
    });

    it("blocked: needs is the note", () => {
        const m = buildInitiativeCard(
            "chunk-status",
            callOf('wsh effort chunk status e1 3 blocked --note "an example"'),
            {
                effort: THREE,
            }
        );
        expect(m).toMatchObject({ kind: "chunk-blocked", chunk: { number: 3, label: "Ship it" }, needs: "an example" });
    });

    it.each(["active", "deferred", "skipped", "pending"])("%s is a one-line status row", (status) => {
        const m = buildInitiativeCard("chunk-status", callOf(`wsh effort chunk status e1 2 ${status}`), {});
        expect(m).toMatchObject({ kind: "chunk-status", chunk: { number: 2 }, status });
    });

    it("a note flag without a value is no note", () => {
        const m = buildInitiativeCard("chunk-status", callOf("wsh effort chunk status e1 2 done --note"), {});
        expect(m).not.toHaveProperty("note");
    });
});

describe("effort-advance cards", () => {
    const advance = callOf('wsh effort advance e1 --note "wait fixed"');

    it("resolves its chunk from the record's chunk-done event nearest the call", () => {
        const e = effort([chunk("A", "done"), chunk("B", "done"), chunk("C", "active")], {
            events: [
                { ts: 1_000, kind: "chunk-done", label: "A" },
                { ts: 50_000, kind: "chunk-done", label: "B", text: "wait fixed" },
            ],
        });
        const m = buildInitiativeCard("effort-advance", advance, { effort: e, ts: 49_000 });
        expect(m).toMatchObject({
            kind: "chunk-done",
            chunk: { number: 2, label: "B" },
            note: "wait fixed",
            progress: { done: 2, total: 3 },
        });
    });

    it("without a call time it takes the latest chunk-done event", () => {
        const e = effort([chunk("A", "done"), chunk("B", "done")], {
            events: [
                { ts: 1_000, kind: "chunk-done", label: "A" },
                { ts: 50_000, kind: "chunk-done", label: "B" },
            ],
        });
        expect(buildInitiativeCard("effort-advance", advance, { effort: e })).toMatchObject({ chunk: { number: 2 } });
    });

    it("from argv alone it is a Chunk done card with no chunk", () => {
        const m = buildInitiativeCard("effort-advance", advance, {});
        expect(m).toMatchObject({ kind: "chunk-done", effortId: "e1", note: "wait fixed" });
        expect(m).toMatchObject({ chunk: {} });
    });
});

describe("chunk-add and chunk-note cards", () => {
    it("added: the label from argv, its number and the initiative from the record", () => {
        const e = effort([chunk("A"), chunk("Decide the tone")]);
        const m = buildInitiativeCard("chunk-add", callOf('wsh effort chunk add e1 "Decide the tone"'), { effort: e });
        expect(m).toMatchObject({
            kind: "chunk-added",
            chunk: { number: 2, label: "Decide the tone" },
            initiative: "Retry rework",
        });
    });

    it("added with --at takes that position as its number", () => {
        const m = buildInitiativeCard("chunk-add", callOf('wsh effort chunk add e1 "X" --at 4'), {});
        expect(m).toMatchObject({ kind: "chunk-added", chunk: { number: 4, label: "X" } });
    });

    it("noted: the chunk and the note text", () => {
        const m = buildInitiativeCard("chunk-note", callOf('wsh effort chunk note e1 2 --note "see the fork commit"'), {
            effort: THREE,
        });
        expect(m).toMatchObject({
            kind: "chunk-noted",
            chunk: { number: 2, label: "Add jitter" },
            note: "see the fork commit",
        });
    });
});

describe("effort-create cards", () => {
    const summary = (title: string, updatedts: number, extra: Partial<EffortSummary> = {}): EffortSummary => ({
        oref: `effort:${title}-${updatedts}`,
        title,
        status: "active",
        done: 0,
        total: 2,
        updatedts,
        chunks: [
            { label: "One", status: "pending" },
            { label: "Two", status: "pending" },
        ],
        ...extra,
    });

    it("from argv alone: title and ticket, no chunks", () => {
        const m = buildInitiativeCard(
            "effort-create",
            callOf('wsh effort create "Chatbot" --ticket SIEM-1 --chunk a --chunk b'),
            {}
        );
        expect(m).toMatchObject({ kind: "initiative-created", title: "Chatbot", ticket: "SIEM-1", chunks: [] });
    });

    it("with the list: the newest effort of that title supplies its chunks and progress", () => {
        const efforts = [
            summary("Chatbot", 10),
            summary("Chatbot", 30, { project: "cyber_assistant" }),
            summary("Other", 40),
        ];
        const m = buildInitiativeCard("effort-create", callOf('wsh effort create "Chatbot"'), { efforts });
        expect(m).toMatchObject({
            kind: "initiative-created",
            effortId: "Chatbot-30",
            project: "cyber_assistant",
            chunks: [
                { number: 1, label: "One" },
                { number: 2, label: "Two" },
            ],
            progress: { done: 0, total: 2 },
        });
    });

    it("a ticket in argv must match the record's", () => {
        const efforts = [summary("Chatbot", 10, { ticket: "SIEM-2" }), summary("Chatbot", 5, { ticket: "SIEM-1" })];
        const m = buildInitiativeCard("effort-create", callOf('wsh effort create "Chatbot" --ticket SIEM-1'), {
            efforts,
        });
        expect(m).toMatchObject({ effortId: "Chatbot-5" });
    });
});

describe("a missing effort", () => {
    it("yields the argv-only model carrying the error", () => {
        const m = buildInitiativeCard("chunk-status", callOf("wsh effort chunk status nope 3 done"), {
            error: "EC-NOT-FOUND: effort nope",
        });
        expect(m).toMatchObject({
            kind: "chunk-done",
            effortId: "nope",
            chunk: { number: 3 },
            error: "EC-NOT-FOUND: effort nope",
        });
        expect(m).not.toHaveProperty("progress");
    });

    it("drops the error once a record is there", () => {
        const m = buildInitiativeCard("chunk-status", callOf("wsh effort chunk status e1 1 done"), {
            effort: THREE,
            error: "stale refetch failed",
        });
        expect(m).not.toHaveProperty("error");
    });
});

describe("effortShowModel", () => {
    const many = effort(
        Array.from({ length: 18 }, (_, i) => chunk(`C${i + 1}`, i === 0 ? "done" : "pending", i === 1 ? 3 : 0))
    );

    it("header facts, the first chunks numbered from 1, and the rest counted", () => {
        const m = effortShowModel(many);
        expect(m).toMatchObject({ title: "Retry rework", project: "waveterm", status: "active", done: 1, total: 18 });
        expect(m.rows).toHaveLength(18);
        expect(m.rows[0]).toMatchObject({ number: 1, label: "C1", tone: "done", notes: 0 });
        expect(m.rows[1]).toMatchObject({ number: 2, notes: 3 });
        expect(m.shown).toBe(SHOW_CHUNKS_SHOWN);
        expect(m.rows.length - m.shown).toBe(13);
    });

    it("fewer chunks than the cap show all, with none left over", () => {
        expect(effortShowModel(THREE).shown).toBe(3);
    });
});

describe("effortListModel", () => {
    const sum = (i: number, extra: Partial<EffortSummary> = {}): EffortSummary => ({
        oref: `effort:e${i}`,
        title: `T${i}`,
        status: "active",
        done: i,
        total: 10,
        updatedts: i,
        activechunk: `chunk ${i}`,
        ...extra,
    });

    it("rows carry title, ticket, counts, fraction and the current chunk; the rest is counted", () => {
        const all = Array.from({ length: 20 }, (_, i) => sum(i + 1, i === 0 ? { ticket: "SIEM-9" } : {}));
        const m = effortListModel(all);
        expect(m.rows).toHaveLength(20);
        expect(m.shown).toBe(LIST_ROWS_SHOWN);
        expect(m.rows[0]).toMatchObject({
            id: "e1",
            title: "T1",
            ticket: "SIEM-9",
            done: 1,
            total: 10,
            current: "chunk 1",
        });
        expect(m.rows[0].fraction).toBeCloseTo(0.1);
        expect(m.rows.length - m.shown).toBe(13);
    });

    it("an effort with no chunks has fraction 0, not NaN", () => {
        expect(effortListModel([sum(1, { done: 0, total: 0 })]).rows[0].fraction).toBe(0);
    });
});

describe("effortListRequest", () => {
    it("a plain list shares the one key; flags make their own", () => {
        expect(effortListRequest(callOf("wsh effort list"))).toEqual({ key: "efforts", includearchived: false });
        expect(effortListRequest(callOf("wsh effort list --archived --project waveterm"))).toEqual({
            key: "efforts:archived:waveterm",
            includearchived: true,
            project: "waveterm",
        });
    });
});
