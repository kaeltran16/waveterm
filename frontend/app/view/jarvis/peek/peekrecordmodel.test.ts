// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { recordPeekFacts } from "./peekrecordmodel";

const summary = (status: string): SpaceSummary => ({
    id: "d1",
    objective: "Ship the vault sync",
    ticket: "",
    status,
    updated: 1,
});

describe("recordPeekFacts", () => {
    it("is gone once the list no longer has the record", () => {
        expect(recordPeekFacts(undefined)).toEqual({ gone: true, focus: null });
    });

    it("has nothing to focus on for a status the focus list leaves out", () => {
        expect(recordPeekFacts(summary("completed"))).toEqual({ gone: false, focus: null });
        expect(recordPeekFacts(summary("archived"))).toEqual({ gone: false, focus: null });
    });

    it("focuses a live record as a task, leaving the project alone", () => {
        expect(recordPeekFacts(summary("active"))).toEqual({
            gone: false,
            focus: { ref: { kind: "task", id: "d1" }, label: "Ship the vault sync", project: "" },
        });
    });
});
