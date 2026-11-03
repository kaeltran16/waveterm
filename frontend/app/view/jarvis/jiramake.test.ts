// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { makePrompt, makeTarget } from "./jiramake";

const row = (over: Partial<JiraTicketRow> = {}): JiraTicketRow => ({
    key: "PAY-311",
    summary: "Settlement report drops refunds issued after cutoff",
    type: "Bug",
    status: "In Progress",
    statuscategory: "indeterminate",
    url: "https://acme.atlassian.net/browse/PAY-311",
    project: "payments-api",
    evidence: "4 initiatives, 23 tagged commits",
    sure: true,
    ...over,
});

const unsure = row({ key: "GROW-12", project: "", evidence: "No history for GROW", sure: false });

describe("makePrompt", () => {
    it("names the project when it is sure", () => {
        const p = makePrompt(row());
        expect(p).toContain("project payments-api");
        expect(p).toContain("--project payments-api");
        expect(p).not.toMatch(/ask me/);
    });

    it("says to ask before creating anything when it is unsure", () => {
        const p = makePrompt(unsure);
        expect(p).toContain("ask me to confirm it before creating anything");
        expect(p).toContain("No history for GROW");
    });

    it.each([
        ["sure", row()],
        ["unsure", unsure],
    ])("reads the ticket, sets the ticket and leaves the Made from note (%s)", (_, r) => {
        const p = makePrompt(r);
        expect(p).toContain(`wsh jira show ${r.key}`);
        expect(p).toContain(`--ticket ${r.key}`);
        expect(p).toContain(`Made from ${r.key}`);
    });
});

describe("makeTarget", () => {
    const registry = { "payments-api": { path: "C:/src/payments-api" }, infra: {} };

    it("starts in the project's folder when it is sure", () => {
        expect(makeTarget(row(), registry)).toEqual({
            projectPath: "C:/src/payments-api",
            projectName: "payments-api",
        });
    });

    it("has no project when it is unsure", () => {
        expect(makeTarget(row({ sure: false }), registry)).toEqual({ projectPath: "", projectName: "" });
    });

    it("has no project when the sure project is not registered or has no folder", () => {
        expect(makeTarget(row({ project: "billing" }), registry)).toEqual({ projectPath: "", projectName: "" });
        expect(makeTarget(row({ project: "infra" }), registry)).toEqual({ projectPath: "", projectName: "" });
    });
});
