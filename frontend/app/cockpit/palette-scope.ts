// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure parser for the command palette's leading sigil. Turns the raw query into a scope
// decision so command-palette.tsx can render one narrowed group per scope. The sigil only
// triggers at position 0, so a launch goal like "fix #123" stays in the default scope.

import { fuzzyScore } from "./palette-match";

export type Scope = "default" | "command" | "agent" | "session" | "channel";

export interface ChannelLaunch {
    token: string; // channel selector (first whitespace token after '#')
    goal: string; // trimmed goal text after the token
}

export interface ParsedScope {
    scope: Scope;
    sub: string; // filter text within the scope ("" for default)
    channelLaunch: ChannelLaunch | null; // non-null only for a '#<token> <goal>' launch
}

const SIGILS: Record<string, Scope> = { ">": "command", "@": "agent", "/": "session", "#": "channel" };

export function parseScope(query: string): ParsedScope {
    const scope = SIGILS[query[0]];
    if (!scope) {
        return { scope: "default", sub: "", channelLaunch: null };
    }
    const rest = query.slice(1);
    if (scope !== "channel") {
        return { scope, sub: rest, channelLaunch: null };
    }
    // channel: picker unless a whitespace gap after the first token is followed by a real goal.
    const trimmed = rest.replace(/^\s+/, "");
    const m = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
    if (m && m[2].trim() !== "") {
        return { scope, sub: trimmed, channelLaunch: { token: m[1], goal: m[2].trim() } };
    }
    return { scope, sub: trimmed, channelLaunch: null };
}

// Resolve a channel selector token to a channel: exact (case-insensitive) name first,
// else the best fuzzy match, else undefined.
export function resolveChannelToken<T extends { name: string }>(token: string, channels: T[]): T | undefined {
    const t = token.toLowerCase();
    const exact = channels.find((c) => c.name.toLowerCase() === t);
    if (exact) {
        return exact;
    }
    let best: T | undefined;
    let bestScore = -Infinity;
    for (const c of channels) {
        const s = fuzzyScore(token, c.name);
        if (s != null && s > bestScore) {
            bestScore = s;
            best = c;
        }
    }
    return best;
}
