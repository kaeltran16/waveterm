// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Chunk sidebar's note cards (design L367-397, model L1508-1542). Pure.

import { noteBody, stamp, type FeedEntry } from "./effortfeed";

// a note under this length is read whole; the newest one opens by default (design L1515)
export const NOTE_OPEN_CHARS = 280;

export type NoteCard = {
    key: string;
    entry: FeedEntry;
    who: "agent" | "you" | "";
    // a Jira post's note reads as "In a post to <KEY>" by you, with a way to the comment; others have none
    heading: string;
    by: string;
    link: { label: string; url: string } | null;
    day: string;
    edited: boolean;
    text: string;
    open: boolean;
    chev: string;
    editable: boolean;
    runOid: string;
    sessionTab: string;
};

export function sidebarNotes(
    feed: FeedEntry[],
    label: string,
    now: number,
    expanded: Set<string>,
    ticketKey = ""
): NoteCard[] {
    const entries = feed.filter((f) => f.chunk === label && noteBody(f) !== "");
    return entries.map((f, i) => {
        const key = String(f.seq);
        const text = noteBody(f);
        const newestShort = i === 0 && text.length < NOTE_OPEN_CHARS;
        const open = newestShort || expanded.has(key);
        const post = f.jirapost != null;
        // a post's note is you reporting, not an author's own words: the heading says who and where
        const who = !post && (f.author === "agent" || f.author === "you") ? f.author : "";
        return {
            key,
            entry: f,
            who,
            heading: post ? `In a post to ${ticketKey || "Jira"}` : "",
            by: post ? "you" : "",
            link: post ? { label: "View comment ↗", url: f.jirapost! } : null,
            day: stamp(f.ts, now),
            edited: f.edited === true,
            text,
            open,
            chev: newestShort ? "" : open ? "less" : "more",
            // an agent's note is its record of what it did, a post's is the record of what went to Jira; yours and
            // legacy ones stay editable
            editable: f.noteAt != null && who !== "agent" && !post,
            runOid: (f.run ?? "").replace(/^run:/, ""),
            sessionTab: (f.session ?? "").replace(/^agent:/, ""),
        };
    });
}
