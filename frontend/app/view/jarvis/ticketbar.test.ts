// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { seenLabel, seenTitle } from "./jiraticket";
import { ticketBarModel } from "./ticketbar";

const NOW = Date.UTC(2026, 10, 3, 16, 0);
const HOUR = 3_600_000;
const SITE = "https://acme.atlassian.net/";

const effort = (over: Partial<Effort> = {}): Effort =>
    ({
        oid: "e1",
        otype: "effort",
        version: 1,
        title: "Retry webhook delivery",
        status: "active",
        chunks: [],
        createdts: NOW,
        updatedts: NOW,
        ...over,
    }) as Effort;

const copy = (over: Partial<EffortJira> = {}): EffortJira => ({
    summary: "Retry webhook delivery when the partner returns 429",
    type: "Story",
    status: "To Do",
    statuscategory: "new",
    description: "\n  \nWhen a partner answers 429 we drop it.\nPartners lose events.",
    acceptance: ["429 responses are retried", "gives up after 6 attempts"],
    seents: NOW - 2 * HOUR,
    seenvia: "post",
    ...over,
});

describe("ticketBarModel", () => {
    it("is null for an initiative with no ticket", () => {
        expect(ticketBarModel(effort(), SITE, NOW)).toBeNull();
        expect(ticketBarModel(effort({ ticket: "  " }), SITE, NOW)).toBeNull();
    });

    it("draws the key and link with empty fields before Arc has seen the ticket", () => {
        expect(ticketBarModel(effort({ ticket: "PAY-318" }), SITE, NOW)).toEqual({
            key: "PAY-318",
            url: "https://acme.atlassian.net/browse/PAY-318",
            type: "",
            status: "",
            tone: "todo",
            firstLine: "",
            description: "",
            acceptance: [],
            seen: "not seen yet",
            seenTitle: "",
        });
    });

    it("reads the last-seen copy: status tone, first non-empty line, criteria and the seen stamp", () => {
        const jira = copy({ status: "In Progress", statuscategory: "indeterminate" });
        const m = ticketBarModel(effort({ ticket: "PAY-318", jira }), SITE, NOW);
        expect(m).toMatchObject({
            key: "PAY-318",
            type: "Story",
            status: "In Progress",
            tone: "progress",
            firstLine: "When a partner answers 429 we drop it.",
            description: jira.description,
            acceptance: jira.acceptance,
            seen: seenLabel(jira.seents, NOW),
            seenTitle: seenTitle(jira.seents, "post"),
        });
        expect(m!.seen).toBe("seen 2h ago");
    });

    it("has no url without a site, and no criteria when the copy has none", () => {
        const m = ticketBarModel(
            effort({ ticket: "PAY-318", jira: copy({ description: undefined, acceptance: undefined }) }),
            undefined,
            NOW
        );
        expect(m).toMatchObject({ url: null, firstLine: "", description: "", acceptance: [] });
    });
});
