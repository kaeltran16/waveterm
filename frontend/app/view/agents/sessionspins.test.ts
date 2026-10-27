// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { LiveSession } from "./sessionsarchivestore";
import { isRowPinned, prunePins, rowPinKeys, togglePinnedRow } from "./sessionspins";
import type { Row } from "./sessionssearch";

const sess = (over: Partial<SessionActivity> = {}): SessionActivity =>
    ({ id: "s1", runtime: "claude", ...over }) as SessionActivity;

const soloRow = (id: string, runtime = "claude"): Row => ({
    key: `${runtime}:${id}`,
    live: false,
    lastactivets: 0,
    session: sess({ id, runtime }) as LiveSession,
});

const runRow = (runId: string, members: string[]): Row => ({
    key: `run:${runId}`,
    live: false,
    lastactivets: 0,
    run: {
        group: { runId, sessions: members.map((id) => sess({ id, runid: runId })) },
        view: { runId },
    } as unknown as Row["run"],
});

describe("isRowPinned", () => {
    it("a solo row is pinned only when its key is in the set", () => {
        const row = soloRow("a");
        expect(isRowPinned(row, new Set(["claude:a"]))).toBe(true);
        expect(isRowPinned(row, new Set(["claude:b"]))).toBe(false);
        expect(isRowPinned(row, new Set())).toBe(false);
    });

    it("a run row is pinned by its run key or by a member session's key alone", () => {
        const row = runRow("r1", ["m1", "m2"]);
        expect(isRowPinned(row, new Set(["run:r1"]))).toBe(true);
        expect(isRowPinned(row, new Set(["claude:m2"]))).toBe(true);
        expect(isRowPinned(row, new Set(["claude:other"]))).toBe(false);
    });
});

describe("rowPinKeys", () => {
    it("is the row key for a solo row, and the run key plus member keys for a run", () => {
        expect(rowPinKeys(soloRow("a"))).toEqual(["claude:a"]);
        expect(rowPinKeys(runRow("r1", ["m1"]))).toEqual(["run:r1", "claude:m1"]);
    });
});

describe("togglePinnedRow", () => {
    it("pins a solo row by appending its key, and unpins it again", () => {
        const row = soloRow("a");
        const pinned = togglePinnedRow(["claude:z"], row);
        expect(pinned).toEqual(["claude:z", "claude:a"]);
        expect(togglePinnedRow(pinned, row)).toEqual(["claude:z"]);
    });

    it("toggles an already-pinned row off rather than adding a duplicate", () => {
        expect(togglePinnedRow(["claude:a"], soloRow("a"))).toEqual([]);
    });

    it("unpinning a run row pinned by its run key and a member key clears both, keeping the rest in order", () => {
        const row = runRow("r1", ["m1", "m2"]);
        const pins = ["claude:x", "run:r1", "claude:y", "claude:m1"];
        expect(togglePinnedRow(pins, row)).toEqual(["claude:x", "claude:y"]);
    });

    it("a run pinned only by a member key unpins, and pinning a run adds just its run key", () => {
        const row = runRow("r1", ["m1"]);
        expect(togglePinnedRow(["claude:m1"], row)).toEqual([]);
        expect(togglePinnedRow([], row)).toEqual(["run:r1"]);
    });

    it("does not mutate its input", () => {
        const pins = ["claude:a"];
        togglePinnedRow(pins, soloRow("b"));
        togglePinnedRow(pins, soloRow("a"));
        expect(pins).toEqual(["claude:a"]);
    });
});

describe("prunePins", () => {
    const sessions = [sess({ id: "a" }), sess({ id: "m1", runid: "r1" })];

    it("keeps a solo key present in sessions and a run key whose run id appears on any session", () => {
        expect(prunePins(["claude:a", "run:r1"], sessions)).toEqual(["claude:a", "run:r1"]);
    });

    it("drops a key with no matching session or run", () => {
        expect(prunePins(["claude:a", "claude:gone", "run:r9"], sessions)).toEqual(["claude:a"]);
    });

    it("returns the same array when nothing is dropped", () => {
        const pins = ["claude:a", "run:r1"];
        expect(prunePins(pins, sessions)).toBe(pins);
    });

    it("gives [] for []", () => {
        expect(prunePins([], sessions)).toEqual([]);
        expect(prunePins([], [])).toEqual([]);
    });
});
