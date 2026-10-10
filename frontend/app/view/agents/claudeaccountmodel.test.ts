// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { claudeAccountView, noNewLogin, switchedStatusLine } from "./claudeaccountmodel";

const now = 1_800_000_000_000;
const HOUR = 3600_000;

function acct(over: Partial<ClaudeAccountInfo>): ClaudeAccountInfo {
    return {
        accountuuid: "u",
        email: "a@example.com",
        orgname: "Org",
        plan: "pro",
        active: false,
        expired: false,
        lastusedts: now - HOUR,
        ...over,
    };
}

describe("claudeAccountView rows", () => {
    it("puts the active account first, then the rest by last use, newest first", () => {
        const view = claudeAccountView(
            {
                loggedin: true,
                accounts: [
                    acct({ accountuuid: "old", lastusedts: now - 5 * HOUR }),
                    acct({ accountuuid: "new", lastusedts: now - HOUR }),
                    acct({ accountuuid: "live", active: true, lastusedts: now - 9 * HOUR }),
                ],
            },
            now
        );
        expect(view.rows.map((r) => r.uuid)).toEqual(["live", "new", "old"]);
    });

    it("gives the active row org and plan only, and every other row its last use", () => {
        const view = claudeAccountView(
            {
                loggedin: true,
                accounts: [
                    acct({ accountuuid: "live", active: true, orgname: "Mozox", plan: "team" }),
                    acct({ accountuuid: "other", orgname: "Acme", plan: "max", lastusedts: now - 2 * HOUR }),
                ],
            },
            now
        );
        expect(view.rows[0].meta).toBe("Mozox · team");
        expect(view.rows[1].meta).toBe("Acme · max · last used 2h ago");
    });

    it("leaves an empty org or plan out of the meta line", () => {
        const view = claudeAccountView(
            { loggedin: true, accounts: [acct({ active: true, orgname: "", plan: "pro" })] },
            now
        );
        expect(view.rows[0].meta).toBe("pro");
    });

    it("flags the active row as not switchable, an expired row as expired and not switchable", () => {
        const view = claudeAccountView(
            {
                loggedin: true,
                accounts: [
                    acct({ accountuuid: "live", active: true }),
                    acct({ accountuuid: "ok" }),
                    acct({ accountuuid: "gone", expired: true, lastusedts: now - 9 * HOUR }),
                ],
            },
            now
        );
        const flags = view.rows.map((r) => [r.uuid, r.active, r.switchable, r.expired]);
        expect(flags).toEqual([
            ["live", true, false, false],
            ["ok", false, true, false],
            ["gone", false, false, true],
        ]);
    });

    it("does not mark the active account expired: it is the live login", () => {
        const view = claudeAccountView({ loggedin: true, accounts: [acct({ active: true, expired: true })] }, now);
        expect(view.rows[0].expired).toBe(false);
        expect(view.rows[0].switchable).toBe(false);
    });

    it("draws the email's initial, upper-cased", () => {
        const view = claudeAccountView({ loggedin: true, accounts: [acct({ email: "khang@example.com" })] }, now);
        expect(view.rows[0].initial).toBe("K");
    });
});

describe("claudeAccountView notes", () => {
    it("shows the one-account hint only when exactly one account is saved", () => {
        const one = claudeAccountView({ loggedin: true, accounts: [acct({ active: true })] }, now);
        const two = claudeAccountView(
            { loggedin: true, accounts: [acct({ accountuuid: "a", active: true }), acct({ accountuuid: "b" })] },
            now
        );
        expect(one.showHint).toBe(true);
        expect(two.showHint).toBe(false);
    });

    it("shows the no-login note when no live Claude.ai login exists", () => {
        expect(claudeAccountView({ loggedin: false, accounts: [acct({})] }, now).showNoLogin).toBe(true);
        expect(claudeAccountView({ loggedin: true, accounts: [acct({ active: true })] }, now).showNoLogin).toBe(false);
    });

    it("claims nothing before the first list returns", () => {
        expect(claudeAccountView(null, now)).toEqual({ rows: [], showHint: false, showNoLogin: false });
    });
});

describe("noNewLogin", () => {
    it("is true when the list did not grow", () => {
        expect(noNewLogin(2, { loggedin: true, accounts: [acct({}), acct({})] })).toBe(true);
        expect(noNewLogin(2, { loggedin: true, accounts: [acct({})] })).toBe(true);
    });

    it("is false when a new login appeared", () => {
        expect(noNewLogin(1, { loggedin: true, accounts: [acct({}), acct({})] })).toBe(false);
    });
});

describe("switchedStatusLine", () => {
    it("names the account and what it reaches", () => {
        expect(switchedStatusLine("b@example.com")).toBe(
            "Switched to b@example.com. New claude sessions use it; running ones pick it up at their next token check."
        );
    });
});
