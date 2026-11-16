// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Tagging another live agent from the rendered composer with @: the token at the caret, the agents it can
// name, the rows the picker lists and the block a sent prompt carries. Only rows picked from the list
// resolve, so a typed @path stays claude's own file mention. Pure: no React, no Wave runtime imports.

import { projectOf, type AgentVM } from "./agentsviewmodel";

// the harnesses `wsh agents send` reaches
const TAGGABLE_HARNESSES = ["claude", "pi"];
// the short tab id `wsh agents list` prints
const ID8_LEN = 8;
const NON_SLUG_RE = /[^a-z0-9_]+/g;
// not after a word character or @, so an email or a diff's @@ never opens the picker
const TOKEN_RE = /(?<![\w@])@([A-Za-z0-9_-]*)$/;

export interface MentionToken {
    start: number; // index of the @
    query: string;
}

export interface MentionRow {
    tabId: string;
    tag: string; // without the @
    state: AgentVM["state"];
    harness: string;
    id8: string;
    title: string;
}

const id8 = (a: AgentVM) => a.id.slice(0, ID8_LEN).toLowerCase();
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function slugOf(a: AgentVM): string {
    const slug = a.name
        .toLowerCase()
        .replace(NON_SLUG_RE, "-")
        .replace(/^-+|-+$/g, "");
    return slug || id8(a);
}

export function mentionToken(text: string, caret: number): MentionToken | null {
    const m = TOKEN_RE.exec(text.slice(0, caret));
    return m ? { start: m.index, query: m[1] } : null;
}

// this project's other live agents a message can reach
export function mentionTargets(roster: readonly AgentVM[], self: AgentVM): AgentVM[] {
    const project = projectOf(self);
    return roster.filter(
        (a) =>
            a.id !== self.id &&
            (a.kind == null || a.kind === "agent") &&
            TAGGABLE_HARNESSES.includes(a.agent ?? "") &&
            projectOf(a) === project
    );
}

// tab names are often the project's, so a shared slug gets the short id to tell rows apart
function tagOf(a: AgentVM, all: readonly AgentVM[]): string {
    const slug = slugOf(a);
    const shared = all.some((o) => o.id !== a.id && slugOf(o) === slug);
    return shared ? `${slug}-${id8(a)}` : slug;
}

// the title is what tells same-named tabs apart, so the query matches it as well as the tag and id
export function mentionRows(targets: readonly AgentVM[], query: string): MentionRow[] {
    const q = query.toLowerCase();
    return targets.flatMap((a) => {
        const tag = tagOf(a, targets);
        const title = oneLine(a.task ?? "");
        const hit = [tag, a.id, title].some((s) => s.toLowerCase().includes(q));
        return hit ? [{ tabId: a.id, tag, state: a.state, harness: a.agent ?? "", id8: id8(a), title }] : [];
    });
}

// replaces the token with the tag and a space, and returns where the caret goes
export function insertMention(
    text: string,
    token: MentionToken,
    caret: number,
    tag: string
): { text: string; caret: number } {
    const insert = `@${tag} `;
    const rest = text.slice(caret).replace(/^ /, "");
    return { text: text.slice(0, token.start) + insert + rest, caret: token.start + insert.length };
}

// the picks whose tag is still in the text, once each: a tag edited away since its pick names no one
export function keptMentions(text: string, picks: readonly MentionRow[]): MentionRow[] {
    const seen = new Set<string>();
    return picks.filter((p) => {
        const inText = new RegExp(`(?<![\\w@])@${p.tag}(?![\\w-])`).test(text);
        if (!inText || seen.has(p.tag)) {
            return false;
        }
        seen.add(p.tag);
        return true;
    });
}

function reachLine(p: MentionRow): string {
    const what = `${p.harness}, ${p.state}${p.title ? `, working on: ${p.title}` : ""}`;
    return `- @${p.tag} is the live agent tab ${p.tabId} (${what}).`;
}

// a trailing block, as attachments add theirs: the agent typed to does the talking, the user's text goes to
// no one else
export function appendMentions(text: string, picks: readonly MentionRow[]): string {
    const kept = keptMentions(text, picks);
    if (kept.length === 0) {
        return text;
    }
    const block = [
        "Tagged agents (you message them; my text is not sent to them):",
        ...kept.map(reachLine),
        `Message one with \`wsh agents send <tab> "<message>"\`; add --wait when you need its answer back. ` +
            "Write the message yourself and keep it to what I asked.",
    ].join("\n");
    return `${text}\n\n${block}`;
}
