// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { noteStamp } from "./initiativework";
import { normalizeKey, parseJiraError, seenLabel, seenTitle, STATUS_CHIP, statusTone, ticketUrl } from "./jiraticket";

describe("normalizeKey", () => {
    it("trims and uppercases a typed key", () => {
        expect(normalizeKey(" pay-318 ")).toBe("PAY-318");
        expect(normalizeKey("PAY-318 ")).toBe("PAY-318");
        expect(normalizeKey("a2-1")).toBe("A2-1");
    });

    it("returns empty for anything not key-shaped", () => {
        for (const s of ["pay", "", "PAY-", "-318", "P-318", "2PAY-318", "PAY-31a", "PAY 318"]) {
            expect(normalizeKey(s)).toBe("");
        }
    });
});

describe("ticketUrl", () => {
    it("joins the site and key, dropping a trailing slash", () => {
        expect(ticketUrl("https://acme.atlassian.net/", "PAY-318")).toBe("https://acme.atlassian.net/browse/PAY-318");
        expect(ticketUrl("https://acme.atlassian.net", "PAY-318")).toBe("https://acme.atlassian.net/browse/PAY-318");
    });

    it("is null without a site", () => {
        expect(ticketUrl(undefined, "PAY-318")).toBeNull();
        expect(ticketUrl("", "PAY-318")).toBeNull();
    });
});

describe("parseJiraError", () => {
    it("reads a refusal's status and Jira's message", () => {
        expect(parseJiraError(new Error("EC-JIRA-HTTP 401: Client must be authenticated"))).toEqual({
            kind: "refused",
            status: 401,
            message: "Client must be authenticated",
        });
    });

    it("reads not-configured as off", () => {
        expect(
            parseJiraError(
                new Error("EC-JIRA-NOTCONFIGURED: Jira isn't set up: add your API token in Settings > Jira.")
            )
        ).toEqual({ kind: "off", message: "Jira isn't set up: add your API token in Settings > Jira." });
    });

    it("strips the unreachable code", () => {
        expect(parseJiraError(new Error("EC-JIRA-UNREACHABLE: dial tcp: no such host"))).toEqual({
            kind: "other",
            message: "dial tcp: no such host",
        });
    });

    it("finds the code inside a wrapped message", () => {
        expect(parseJiraError(new Error("rpc error: EC-JIRA-HTTP 404: Issue does not exist"))).toEqual({
            kind: "refused",
            status: 404,
            message: "Issue does not exist",
        });
    });

    it("keeps an uncoded message, a string, and a non-error", () => {
        expect(parseJiraError(new Error("timeout"))).toEqual({ kind: "other", message: "timeout" });
        expect(parseJiraError("EC-JIRA-HTTP 500: boom")).toEqual({ kind: "refused", status: 500, message: "boom" });
        expect(parseJiraError(undefined)).toEqual({ kind: "other", message: "undefined" });
    });
});

describe("statusTone", () => {
    it("maps Jira status categories", () => {
        expect(statusTone("new")).toBe("todo");
        expect(statusTone("indeterminate")).toBe("progress");
        expect(statusTone("done")).toBe("done");
        expect(statusTone("")).toBe("todo");
        expect(statusTone("undefined")).toBe("todo");
    });

    it("has a chip for every tone", () => {
        for (const tone of ["todo", "progress", "done"] as const) {
            expect(STATUS_CHIP[tone]).toMatch(/\S/);
        }
    });
});

describe("seenLabel", () => {
    it("says how long ago Arc saw the ticket", () => {
        const now = 1_000_000_000_000;
        expect(seenLabel(now - 2 * 3_600_000, now)).toBe("seen 2h ago");
        expect(seenLabel(now - 5 * 60_000, now)).toBe("seen 5m ago");
        expect(seenLabel(now - 3 * 86_400_000, now)).toBe("seen 3d ago");
        expect(seenLabel(now - 10_000, now)).toBe("seen <1m ago");
    });
});

describe("seenTitle", () => {
    const ts = new Date(2026, 10, 3, 14, 2).getTime();
    it("names when and how Arc saw it", () => {
        expect(seenTitle(ts, "post")).toBe("Arc last saw this ticket 11-03 14:02, when you posted progress");
        expect(seenTitle(ts, "check")).toBe(`Arc last saw this ticket ${noteStamp(ts)}, on Check Jira`);
        expect(seenTitle(ts, "show")).toContain("when an agent ran wsh jira show");
        expect(seenTitle(ts, "refresh")).toContain("when you refreshed it");
        expect(seenTitle(ts, "lookup")).toContain("when you looked it up in initiative details");
        expect(seenTitle(ts, "make")).toContain("when the initiative was made from it");
    });

    it("drops the how for an unknown via", () => {
        expect(seenTitle(ts, "")).toBe("Arc last saw this ticket 11-03 14:02");
    });
});
