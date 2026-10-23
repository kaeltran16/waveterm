// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { briefListNav, cursorAction, resolveBriefCursor, runNavLines } from "./briefnav";
import { lineOpenTarget, type BriefLine, type LineTarget } from "./briefrows";
import type { TrackerRow } from "./inlinetracker";

describe("resolveBriefCursor", () => {
    it("keeps a cursor that still names a row", () => {
        expect(resolveBriefCursor(["a", "b"], "b")).toBe("b");
    });

    it("falls back to the first row when the cursor's row resolved away", () => {
        expect(resolveBriefCursor(["a", "b"], "gone")).toBe("a");
    });

    it("starts at the first row when nothing is selected yet", () => {
        expect(resolveBriefCursor(["a", "b"], undefined)).toBe("a");
    });

    it("has no cursor at all when there are no rows", () => {
        expect(resolveBriefCursor([], "a")).toBeUndefined();
    });
});

const line = (id: string, over: Partial<BriefLine> = {}) => ({ id, target: null, ...over }) as BriefLine;
const lineRow = (l: BriefLine): TrackerRow => ({ kind: "line", id: l.id, line: l, expanded: false });

describe("runNavLines", () => {
    const sessions = [
        line("sessions:a", { runOid: "a" }),
        line("sessions:b", { runOid: "b" }),
        line("sessions:c", { runOid: "c" }),
    ];
    const shipped = [
        line("shipped:x", { target: { oref: "run:x" } }),
        line("shipped:y", { target: { oref: "run:y" } }),
    ];
    const nav = (over: Partial<Parameters<typeof runNavLines>[0]>) =>
        runNavLines({
            sheetOpen: true,
            stageRun: { id: "b", status: "running" },
            runList: ["a", "b"],
            shippedLines: shipped,
            sessionLines: sessions,
            ...over,
        });

    it("walks the published live runs, on the run the sheet shows", () => {
        expect(nav({})).toEqual({ lines: sessions.slice(0, 2), cursorId: "sessions:b" });
    });

    it("walks Shipped when the sheet shows a finished run", () => {
        expect(nav({ stageRun: { id: "y", status: "done" }, runList: ["x", "y"] })).toEqual({
            lines: shipped,
            cursorId: "shipped:y",
        });
    });

    it("stands down with the sheet closed or on a run outside the list", () => {
        expect(nav({ sheetOpen: false })).toBeNull();
        expect(nav({ stageRun: null })).toBeNull();
        expect(nav({ stageRun: { id: "c", status: "running" } })).toBeNull();
    });
});

describe("cursorAction", () => {
    it("selects a chunk", () => {
        const row: TrackerRow = {
            kind: "chunk",
            id: "initiatives:effort:e/chunk:a",
            oref: "effort:e",
            row: { label: "a", status: "pending", stage: "", tone: "pending", trail: [], workrefs: [] },
            notes: 0,
            next: false,
        };
        expect(cursorAction(row)).toEqual({ kind: "select-chunk", id: row.id });
    });

    it("expands an initiative in place instead of opening it", () => {
        const l = line("initiatives:effort:e", { target: { oref: "effort:e" } });
        expect(cursorAction(lineRow(l))).toEqual({ kind: "toggle-initiative", id: l.id });
    });

    it("opens any other row's target, and does nothing for a row with none", () => {
        const target: LineTarget = { oref: "run:r" };
        expect(cursorAction(lineRow(line("sessions:r", { target })))).toEqual({ kind: "open", target });
        expect(cursorAction(lineRow(line("sessions:r")))).toBeNull();
    });

    it("does nothing on a plan's stage or facts row, or with no cursor", () => {
        expect(cursorAction({ kind: "facts", id: "f", oref: "effort:e", count: "1/2" })).toBeNull();
        expect(cursorAction(null)).toBeNull();
    });
});

describe("briefListNav", () => {
    const base = {
        runNav: null,
        navIds: ["a", "b"],
        cursor: "a",
        setCursor: vi.fn(),
        openLine: vi.fn(),
        sheetOpen: false,
        cursorRow: lineRow(line("a")),
        activate: vi.fn(),
        cursorTarget: { oref: "run:a" } as LineTarget,
    };

    it("walks every drawn row, with Enter and Space live while no sheet is open", () => {
        const c = briefListNav(base);
        expect(c.navigableIds).toEqual(["a", "b"]);
        expect(c.cursorId).toBe("a");
        expect(c.activate).toBe(base.activate);
        expect(c.peekTarget?.()).toEqual(lineOpenTarget(base.cursorTarget));
        expect(c.peekTarget?.()).not.toBeNull();
    });

    it("leaves Enter and Space to an open sheet", () => {
        const c = briefListNav({ ...base, sheetOpen: true });
        expect(c.activate).toBeUndefined();
        expect(c.peekTarget).toBeUndefined();
    });

    it("leaves Enter alone with no row under the cursor", () => {
        expect(briefListNav({ ...base, cursorRow: null }).activate).toBeUndefined();
    });

    it("steps an open run sheet through its list, opening each run it lands on", () => {
        const setCursor = vi.fn();
        const openLine = vi.fn();
        const runs = [
            line("sessions:a", { target: { oref: "run:a" } }),
            line("sessions:b", { target: { oref: "run:b" } }),
        ];
        const c = briefListNav({ ...base, setCursor, openLine, runNav: { lines: runs, cursorId: "sessions:a" } });
        expect(c.navigableIds).toEqual(["sessions:a", "sessions:b"]);
        expect(c.cursorId).toBe("sessions:a");
        expect(c.activate).toBeUndefined();
        c.setCursor("sessions:b");
        expect(setCursor).toHaveBeenCalledWith("sessions:b");
        expect(openLine).toHaveBeenCalledWith({ oref: "run:b" });
    });
});
