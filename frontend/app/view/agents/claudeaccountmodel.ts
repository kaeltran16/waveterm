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
// above the server's 10 s validation request, so a slow API reads as its error, not EC-TIME
export const CLAUDE_APIKEY_SAVE_TIMEOUT_MS = 20000;
export const CLAUDE_APIKEY_SWITCHED = "Switched to the API key. New claude sessions use it, billed per token.";

export type ClaudeAccountRow = {
    uuid: string;
    email: string;
    initial: string;
    meta: string;
    active: boolean;
    // the Claude.ai login in .credentials.json, active or under the API key
    live: boolean;
    // an expired live login is still the login, so only another row reads as expired
    expired: boolean;
    switchable: boolean;
    removable: boolean;
};

export type ClaudeApiKeyRow = { label: string; meta: string; active: boolean };

export type ClaudeAccountView = {
    rows: ClaudeAccountRow[];
    // null when no key is saved
    apiKey: ClaudeApiKeyRow | null;
    apiKeyFirst: boolean;
    showHint: boolean;
    showNoLogin: boolean;
};

// null is "not listed yet": no rows, and no note that would claim something about the live login.
export function claudeAccountView(data: ClaudeAccountsRtnData | null, now: number): ClaudeAccountView {
    if (data == null) {
        return { rows: [], apiKey: null, apiKeyFirst: false, showHint: false, showNoLogin: false };
    }
    // active first, so the list reads "what you have, then what you can move to"
    const ordered = [...(data.accounts ?? [])].sort(
        (a, b) => Number(b.active) - Number(a.active) || b.lastusedts - a.lastusedts
    );
    const rows = ordered.map((a) => {
        const live = a.live === true || a.active;
        const expired = a.expired && !live;
        return {
            uuid: a.accountuuid,
            email: a.email,
            initial: (a.email || a.accountuuid || "?").charAt(0).toUpperCase(),
            meta: accountMeta(a, now),
            active: a.active,
            live,
            expired,
            switchable: !a.active && !expired,
            removable: !live,
        };
    });
    const key = data.apikey;
    const apiKey = key?.saved
        ? { label: `API key · ends in …${key.last4}`, meta: "pay per token", active: key.active }
        : null;
    return {
        rows,
        apiKey,
        apiKeyFirst: apiKey?.active === true,
        showHint: rows.length === 1 && apiKey == null,
        showNoLogin: !data.loggedin && apiKey?.active !== true,
    };
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
