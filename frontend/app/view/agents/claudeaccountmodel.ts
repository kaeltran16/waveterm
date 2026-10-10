// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Settings > Claude account as data: the saved logins ClaudeAccountsCommand returns, turned into the rows
// and notes settingssurface.tsx draws. See docs/superpowers/specs/2026-10-10-claude-account-switch-design.md.

import { formatAgo } from "./agentsviewmodel";

export const CLAUDE_ACCOUNT_EXPIRED_LINE = "Sign-in expired. Run /login with this account to save it again.";
export const CLAUDE_ACCOUNT_HINT = "No other accounts yet. Add one below.";
export const CLAUDE_ACCOUNT_NO_LOGIN =
    "No Claude.ai login is active. Switch to a saved account, or run /login in a claude session.";
export const CLAUDE_ACCOUNT_NO_NEW = "No new login found";

export type ClaudeAccountRow = {
    uuid: string;
    email: string;
    initial: string;
    meta: string;
    active: boolean;
    // an expired active account is still the live login, so only another row reads as expired
    expired: boolean;
    switchable: boolean;
};

export type ClaudeAccountView = {
    rows: ClaudeAccountRow[];
    showHint: boolean;
    showNoLogin: boolean;
};

// null is "not listed yet": no rows, and no note that would claim something about the live login.
export function claudeAccountView(data: ClaudeAccountsRtnData | null, now: number): ClaudeAccountView {
    if (data == null) {
        return { rows: [], showHint: false, showNoLogin: false };
    }
    // active first, so the list reads "what you have, then what you can move to"
    const ordered = [...(data.accounts ?? [])].sort(
        (a, b) => Number(b.active) - Number(a.active) || b.lastusedts - a.lastusedts
    );
    const rows = ordered.map((a) => {
        const expired = a.expired && !a.active;
        return {
            uuid: a.accountuuid,
            email: a.email,
            initial: (a.email || a.accountuuid || "?").charAt(0).toUpperCase(),
            meta: accountMeta(a, now),
            active: a.active,
            expired,
            switchable: !a.active && !expired,
        };
    });
    return { rows, showHint: rows.length === 1, showNoLogin: !data.loggedin };
}

function accountMeta(a: ClaudeAccountInfo, now: number): string {
    const parts = [a.orgname, a.plan].filter((p) => p);
    if (!a.active && a.lastusedts > 0) {
        parts.push(`last used ${formatAgo(now - a.lastusedts)}`);
    }
    return parts.join(" · ");
}

// Check now re-lists; a login made since the last list shows up as one more account.
export function noNewLogin(countBefore: number, after: ClaudeAccountsRtnData): boolean {
    return (after.accounts?.length ?? 0) <= countBefore;
}

export function switchedStatusLine(email: string): string {
    return `Switched to ${email}. New claude sessions use it; running ones pick it up at their next token check.`;
}
