// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { noteStamp } from "./initiativework";
import {
    checkFailure,
    checkSubtitle,
    emptyDetail,
    footerLine,
    headerWhen,
    siteHost,
    ticketMeta,
    visibleRows,
    type CheckState,
} from "./jiracheck";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const ticket = (key: string, over: Partial<JiraTicketRow> = {}): JiraTicketRow => ({
    key,
    summary: `summary of ${key}`,
    type: "Story",
    status: "To Do",
    statuscategory: "new",
    url: `https://acme.atlassian.net/browse/${key}`,
    sure: true,
    ...over,
});

const data = (keys: string[], covered = 0): CommandJiraCheckRtnData => ({
    site: "https://acme.atlassian.net",
    checkedts: NOW,
    tickets: keys.map((k) => ticket(k)),
    covered,
});

describe("checkSubtitle", () => {
    it("counts the tickets without an initiative", () => {
        expect(checkSubtitle({ kind: "list", data: data(["PAY-318", "PAY-311", "OPS-77", "GROW-12"]) })).toBe(
            "4 assigned to you without an initiative"
        );
    });

    it("counts the rows still drawn when given", () => {
        expect(checkSubtitle({ kind: "list", data: data(["PAY-318", "PAY-311"]) }, 1)).toBe(
            "1 assigned to you without an initiative"
        );
    });

    it("reads 0 when nothing is new", () => {
        expect(checkSubtitle({ kind: "list", data: data([], 6) })).toBe("0 assigned to you without an initiative");
    });

    it("says it is checking while loading", () => {
        expect(checkSubtitle({ kind: "loading" })).toBe("Checking your open tickets");
    });

    it("says Jira isn't set up when off", () => {
        expect(checkSubtitle({ kind: "off", message: "Jira isn't set up: add your token in Settings > Jira." })).toBe(
            "Jira isn't set up"
        );
    });

    it("gives the last good check when Jira refused, and nothing without one", () => {
        const refused: CheckState = { kind: "refused", status: 401, message: "m", site: "s", lastChecked: NOW - HOUR };
        expect(checkSubtitle(refused)).toBe(`Last checked ${noteStamp(NOW - HOUR)}`);
        expect(checkSubtitle({ ...refused, lastChecked: undefined })).toBe("");
    });

    it("says Jira couldn't be reached otherwise", () => {
        expect(checkSubtitle({ kind: "other", message: "dial tcp: refused" })).toBe("Couldn't reach Jira");
    });
});

describe("headerWhen", () => {
    const site = "https://acme.atlassian.net";

    it("gives the site and the check's age", () => {
        expect(headerWhen({ kind: "list", data: data([]) }, undefined, NOW + 5000)).toBe(
            "acme.atlassian.net · just now"
        );
        expect(headerWhen({ kind: "list", data: data([]) }, undefined, NOW + 2 * HOUR)).toBe(
            "acme.atlassian.net · 2h ago"
        );
    });

    it("gives the site alone while loading, from the last check or the settings", () => {
        expect(headerWhen({ kind: "loading" }, site, NOW)).toBe("acme.atlassian.net");
        expect(headerWhen({ kind: "loading", prev: data([]) }, undefined, NOW)).toBe("acme.atlassian.net");
    });

    it("is empty when Jira isn't set up", () => {
        expect(headerWhen({ kind: "off", message: "" }, site, NOW)).toBe("");
    });
});

describe("siteHost", () => {
    it("drops the scheme and trailing slashes", () => {
        expect(siteHost("https://acme.atlassian.net/")).toBe("acme.atlassian.net");
        expect(siteHost("http://127.0.0.1:5123")).toBe("127.0.0.1:5123");
        expect(siteHost(undefined)).toBe("");
    });
});

describe("checkFailure", () => {
    it("keeps Jira's status and message with the site and last good check", () => {
        expect(checkFailure({ kind: "refused", status: 401, message: "nope" }, "s", NOW)).toEqual({
            kind: "refused",
            status: 401,
            message: "nope",
            site: "s",
            lastChecked: NOW,
        });
    });

    it("leaves the last good check out when there was none", () => {
        expect(checkFailure({ kind: "refused", status: 401, message: "nope" }, "s", 0)).not.toHaveProperty(
            "lastChecked"
        );
    });

    it("passes off and other through", () => {
        expect(checkFailure({ kind: "off", message: "m" }, "s", 0)).toEqual({ kind: "off", message: "m" });
        expect(checkFailure({ kind: "other", message: "m" }, "s", 0)).toEqual({ kind: "other", message: "m" });
    });
});

describe("visibleRows", () => {
    it("drops a key that is now on an initiative, case-insensitively", () => {
        const d = data(["PAY-318", "PAY-311", "OPS-77"]);
        expect(visibleRows(d, new Set(["pay-311 "])).map((t) => t.key)).toEqual(["PAY-318", "OPS-77"]);
    });

    it("keeps every row when no key is taken", () => {
        expect(visibleRows(data(["PAY-318"]), new Set(["", "OPS-1"])).map((t) => t.key)).toEqual(["PAY-318"]);
    });
});

describe("footerLine", () => {
    it("is empty with none covered", () => {
        expect(footerLine(0, 3)).toBe("");
    });

    it("says more only beside listed rows", () => {
        expect(footerLine(2, 3)).toBe("2 more assigned tickets already have an initiative.");
        expect(footerLine(1, 1)).toBe("1 more assigned ticket already has an initiative.");
    });

    it("drops more with nothing listed (F12)", () => {
        expect(footerLine(2, 0)).toBe("2 assigned tickets already have an initiative.");
        expect(footerLine(1, 0)).toBe("1 assigned ticket already has an initiative.");
    });
});

describe("emptyDetail", () => {
    it("counts the tickets checked", () => {
        expect(emptyDetail(6)).toBe("6 open tickets checked. New assignments show here the next time you check.");
        expect(emptyDetail(1)).toBe("1 open ticket checked. New assignments show here the next time you check.");
    });
});

describe("ticketMeta", () => {
    it("reads type · status · updated <age>", () => {
        expect(ticketMeta(ticket("PAY-318", { updatedts: NOW - 2 * HOUR }), NOW)).toBe(
            "Story · To Do · updated 2h ago"
        );
        expect(
            ticketMeta(ticket("PAY-311", { type: "Bug", status: "In Progress", updatedts: NOW - 24 * HOUR }), NOW)
        ).toBe("Bug · In Progress · updated 1d ago");
    });

    it("leaves the age out without an update time", () => {
        expect(ticketMeta(ticket("OPS-77"), NOW)).toBe("Story · To Do");
    });
});
