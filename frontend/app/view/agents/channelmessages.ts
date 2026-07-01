// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Runtime } from "./launch";

const RUNTIMES: Runtime[] = ["claude", "codex", "antigravity", "terminal"];

export interface ParsedMentions {
    mentions: string[];
    body: string;
}

export function parseMentions(text: string): ParsedMentions {
    const mentions: string[] = [];
    let rest = text.trimStart();
    const re = /^@([\w./-]+)\s+/;
    let m = re.exec(rest);
    while (m) {
        mentions.push(m[1].toLowerCase());
        rest = rest.slice(m[0].length);
        m = re.exec(rest);
    }
    return { mentions, body: rest };
}

export interface RosterEntry {
    id: string;
    name: string;
    blockId?: string;
}

export type MessagePlan =
    | { kind: "dispatch"; runtime: Runtime; text: string }
    | { kind: "steer"; targetId: string; blockId?: string; text: string }
    | { kind: "post"; text: string };

export function planMessage(text: string, roster: RosterEntry[]): MessagePlan {
    const { mentions, body } = parseMentions(text);
    const first = mentions[0];
    if (first && (RUNTIMES as string[]).includes(first)) {
        return { kind: "dispatch", runtime: first as Runtime, text: body };
    }
    if (first) {
        const target = roster.find((r) => r.name.toLowerCase() === first);
        if (target) {
            return { kind: "steer", targetId: target.id, blockId: target.blockId, text: body };
        }
    }
    return { kind: "post", text };
}