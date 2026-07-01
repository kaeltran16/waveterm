// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure derivations for the Channels surface: a deterministic per-author avatar color, and whether a
// channel currently has a dispatched worker waiting on you (drives the rail's attention dot).

import type { AgentVM } from "./agentsviewmodel";
import type { RosterEntry } from "./channelmessages";

// identity palette tokens (defined in tailwindsetup.css @theme). "you" is pinned to the accent.
const AVATAR_TOKENS = [
    "var(--color-avatar-1)",
    "var(--color-avatar-2)",
    "var(--color-avatar-3)",
    "var(--color-avatar-4)",
    "var(--color-avatar-5)",
    "var(--color-avatar-6)",
];

export function avatarColor(name: string): string {
    if (name.toLowerCase() === "you") {
        return "var(--color-accent)";
    }
    let h = 0;
    for (let i = 0; i < name.length; i++) {
        h = (h * 31 + name.charCodeAt(i)) >>> 0;
    }
    return AVATAR_TOKENS[h % AVATAR_TOKENS.length];
}

// A channel is "waiting on you" when any worker it dispatched (or steered) is currently asking.
// GetChannels returns each channel's messages, so resolve dispatch/directive refORefs ("tab:<id>")
// against the live roster. Presence of any asking agent short-circuits the message scan.
export function channelHasAsk(channel: Channel, agents: AgentVM[]): boolean {
    const askingIds = new Set(agents.filter((a) => a.state === "asking").map((a) => a.id));
    if (askingIds.size === 0) {
        return false;
    }
    for (const m of channel.messages ?? []) {
        if ((m.kind === "dispatch" || m.kind === "directive") && m.reforef?.startsWith("tab:")) {
            if (askingIds.has(m.reforef.slice(4))) {
                return true;
            }
        }
    }
    return false;
}

// --- composer @mentions ------------------------------------------------------
// A single mentionable target for the composer's highlight + suggestion dropdown.
export interface MentionCandidate {
    name: string; // the token inserted after "@" (lower-case runtime id, "jarvis", or a roster name)
    kind: "runtime" | "manager" | "agent";
}

// The chars that make up a mention token after the "@" (mirrors parseMentions).
const MENTION_CHAR = /[\w./-]/;

// Everything a channel can address: dispatch runtimes, the jarvis manager handle, and the live roster
// (for steering). Deduped case-insensitively, first-wins — so a runtime beats a same-named roster row,
// matching planMessage's runtime-before-roster precedence. Order: runtimes, jarvis, then agents.
export function mentionCandidates(installedRuntimes: string[], roster: RosterEntry[]): MentionCandidate[] {
    const out: MentionCandidate[] = [];
    const seen = new Set<string>();
    const add = (name: string, kind: MentionCandidate["kind"]) => {
        const key = name.toLowerCase();
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        out.push({ name, kind });
    };
    for (const r of installedRuntimes) {
        add(r, "runtime");
    }
    add("jarvis", "manager");
    for (const e of roster) {
        add(e.name, "agent");
    }
    return out;
}

// The @mention token the caret is currently inside, if any: the "@" must start the string or follow
// whitespace, and only token chars may sit between it and the caret. Returns the partial query (may be
// empty, right after a bare "@") and the "@"'s index, so an accepted suggestion can splice it out.
export function activeMentionQuery(text: string, caret: number): { query: string; start: number } | null {
    let i = caret - 1;
    while (i >= 0 && MENTION_CHAR.test(text[i])) {
        i--;
    }
    if (i < 0 || text[i] !== "@") {
        return null;
    }
    if (i > 0 && !/\s/.test(text[i - 1])) {
        return null;
    }
    return { query: text.slice(i + 1, caret), start: i };
}

// A highlighted-composer segment: a run of plain text, or a resolved @mention token.
export interface HighlightSegment {
    text: string;
    mention: boolean;
}

const MENTION_TOKEN = /@[\w./-]+/g;

// Split composer text into plain + mention runs for the backdrop overlay. An "@token" is a mention only
// when it starts the string or follows whitespace AND its name (case-insensitively) is a known target —
// so a typo or an email's "@" stays plain, giving the user real "this resolves" feedback.
export function highlightSegments(text: string, known: Set<string>): HighlightSegment[] {
    if (text === "") {
        return [];
    }
    const segs: HighlightSegment[] = [];
    let last = 0;
    MENTION_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MENTION_TOKEN.exec(text)) !== null) {
        const i = m.index;
        const boundary = i === 0 || /\s/.test(text[i - 1]);
        if (boundary && known.has(m[0].slice(1).toLowerCase())) {
            if (i > last) {
                segs.push({ text: text.slice(last, i), mention: false });
            }
            segs.push({ text: m[0], mention: true });
            last = i + m[0].length;
        }
    }
    if (last < text.length) {
        segs.push({ text: text.slice(last), mention: false });
    }
    return segs;
}
