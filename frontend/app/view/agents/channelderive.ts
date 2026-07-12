// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure derivations for the Channels surface: a deterministic per-author avatar color, and whether a
// channel currently has a dispatched worker waiting on you (drives the rail's attention dot).

import type { AgentVM } from "./agentsviewmodel";
import { parseMentions, type RosterEntry } from "./channelmessages";
import { pendingAsks } from "./jarviscards";
import { buildFleetSnapshot } from "./jarvisderive";

// identity palette tokens (defined in tailwindsetup.css @theme). "you" is pinned to the accent.
const AVATAR_TOKENS = [
    "var(--color-avatar-1)",
    "var(--color-avatar-2)",
    "var(--color-avatar-3)",
    "var(--color-avatar-4)",
    "var(--color-avatar-5)",
    "var(--color-avatar-6)",
];

// Case-insensitive substring filter over channel names for the rail search box. A blank query returns
// the list unchanged.
export function filterChannels(channels: Channel[], query: string): Channel[] {
    const q = query.trim().toLowerCase();
    return q ? channels.filter((c) => c.name.toLowerCase().includes(q)) : channels;
}

// Turn a consult reply into a dispatch line: re-pose the consult question as an @runtime task. The
// caller feeds this straight to sendChannelMessage, which routes it through the normal dispatch verb.
export function promoteConsultText(runtime: string, question: string): string {
    return `@${runtime} ${question.trim()}`;
}

// resolveTargetChannel finds the channel a Radar finding should hand off to: the first whose bound
// project path matches. Paths come from the same project registry, so an exact (trailing-slash-
// insensitive) compare is sufficient — no fuzzy matching.
export function resolveTargetChannel(channels: Channel[], projectPath: string | undefined): Channel | undefined {
    if (!projectPath) {
        return undefined;
    }
    const norm = (p: string) => p.replace(/[/\\]+$/, "");
    const want = norm(projectPath);
    return channels.find((c) => c.projectpath != null && norm(c.projectpath) === want);
}

export interface ChannelPartition {
    active: Channel[];
    archived: Channel[];
}

// Split channels into active vs archived by the "archived" meta flag (see wstore.MetaKey_Archived). The
// rail shows active rows and tucks archived ones under a collapsible "Archived · N" disclosure. Order-preserving.
export function partitionChannels(channels: Channel[]): ChannelPartition {
    const active: Channel[] = [];
    const archived: Channel[] = [];
    for (const c of channels) {
        if ((c.meta as Record<string, unknown> | undefined)?.["archived"] === true) {
            archived.push(c);
        } else {
            active.push(c);
        }
    }
    return { active, archived };
}

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

// A channel is "waiting on you" when any worker it dispatched (or steered) is asking AND Jarvis has not
// already auto-answered that ask. Shares pendingAsks with the fleet panel so the rail dot and the
// "NEEDS YOU" count never disagree.
export function channelHasAsk(channel: Channel, agents: AgentVM[]): boolean {
    if (!agents.some((a) => a.state === "asking")) {
        return false;
    }
    return pendingAsks(buildFleetSnapshot(channel, agents), channel.messages ?? []).length > 0;
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

// A highlighted-composer segment: a run of plain text, a resolved @mention token, or a command keyword
// (currently the leading "ask" of a consult).
export type SegmentKind = "text" | "mention" | "command";

export interface HighlightSegment {
    text: string;
    kind: SegmentKind;
}

const MENTION_TOKEN = /@[\w./-]+/g;
// The leading "ask" consult keyword: "ask" at the start (after optional whitespace) followed by a space.
const ASK_COMMAND = /^(\s*)(ask)(\s)/i;

// Whether the text after "ask " routes as a consult: a known runtime is named among its leading mentions.
// Mirrors planMessage exactly (parseMentions requires a trailing space, so a bare "ask @claude" is a post).
function isConsultTail(tail: string, runtimes: Set<string>): boolean {
    return parseMentions(tail).mentions.some((m) => runtimes.has(m));
}

// Split composer text into plain / mention / command runs for the backdrop overlay. An "@token" is a
// mention only when it starts the string or follows whitespace AND its name (case-insensitively) is a
// known target — so a typo or an email's "@" stays plain, giving the user real "this resolves" feedback.
// A leading "ask" is a command only when it forms a real consult (a known runtime follows), so highlight
// tracks routing, not just the literal word.
export function highlightSegments(text: string, known: Set<string>, runtimes: Set<string>): HighlightSegment[] {
    if (text === "") {
        return [];
    }
    const segs: HighlightSegment[] = [];
    let last = 0;

    const askM = ASK_COMMAND.exec(text);
    if (askM && isConsultTail(text.slice(askM[0].length), runtimes)) {
        const askStart = askM[1].length; // after any leading whitespace
        if (askStart > 0) {
            segs.push({ text: text.slice(0, askStart), kind: "text" });
        }
        segs.push({ text: askM[2], kind: "command" });
        last = askStart + askM[2].length; // leave the trailing space for the mention/plain pass
    }

    MENTION_TOKEN.lastIndex = last;
    let m: RegExpExecArray | null;
    while ((m = MENTION_TOKEN.exec(text)) !== null) {
        const i = m.index;
        const boundary = i === 0 || /\s/.test(text[i - 1]);
        if (boundary && known.has(m[0].slice(1).toLowerCase())) {
            if (i > last) {
                segs.push({ text: text.slice(last, i), kind: "text" });
            }
            segs.push({ text: m[0], kind: "mention" });
            last = i + m[0].length;
        }
    }
    if (last < text.length) {
        segs.push({ text: text.slice(last), kind: "text" });
    }
    return segs;
}
