// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { planReviewPicks } from "./runtimeline";

describe("planReviewPicks", () => {
    it("reads the picks off a passed plan review", () => {
        const detail = {
            state: "passed",
            round: 1,
            findings: "ok",
            picks: [
                { taskid: "t-2", model: "sonnet", reason: "mechanical" },
                { taskid: "t-3", model: "lead", reason: "needs judgment" },
            ],
        };
        expect(planReviewPicks(detail)).toEqual([
            { taskid: "t-2", model: "sonnet", reason: "mechanical" },
            { taskid: "t-3", model: "lead", reason: "needs judgment" },
        ]);
    });

    it("parses a detail stored as a JSON string", () => {
        const detail = JSON.stringify({ picks: [{ taskid: "t-1", model: "sonnet", reason: "copy" }] });
        expect(planReviewPicks(detail)).toEqual([{ taskid: "t-1", model: "sonnet", reason: "copy" }]);
    });

    it("is empty for a review without picks", () => {
        expect(planReviewPicks({ state: "passed", round: 1, findings: "ok" })).toEqual([]);
    });

    it("is empty for malformed detail", () => {
        expect(planReviewPicks(undefined)).toEqual([]);
        expect(planReviewPicks("not json")).toEqual([]);
        expect(planReviewPicks({ picks: "t-1 sonnet" })).toEqual([]);
        expect(planReviewPicks({ picks: [null, 3, { taskid: 2, model: "sonnet" }, { model: "sonnet" }] })).toEqual([]);
    });
});
