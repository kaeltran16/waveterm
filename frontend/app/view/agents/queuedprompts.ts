// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The messages waiting on an agent, drawn at the foot of the Rendered transcript: Claude Code's own queue, read from
// the transcript's queue-operation records. A box message sent mid-turn is typed into the terminal, so it waits there.

import type { TranscriptRecord } from "./transcriptrecords";

// a prompt waiting in Claude Code's own queue; no text when claude recorded none (one typed during a compaction)
export type WaitingPrompt = { key: string; text?: string; ts?: number };

// a message the person sent from the box, by when it was sent
export type SentPrompt = { text: string; ts: number };

// how far a content-less enqueue may sit from the box send it stands for; a send is typed into the terminal at once
export const SEND_TO_ENQUEUE_MS = 5000;

export type FootItem = {
    key: string;
    text: string;
    // a slash command draws as its command row
    command?: { name: string; args?: string };
};

const NOTIFICATION_PREFIX = "<task-notification>";

type Queued = { key: string; content?: string; ts?: number };

function drawable(content: unknown): content is string {
    return typeof content === "string" && content.trim() !== "" && !content.trimStart().startsWith(NOTIFICATION_PREFIX);
}

// Claude Code's queue as its records leave it: enqueue adds, remove takes the message it names, dequeue takes the
// oldest (it names none), popAll takes all. An enqueue with no content waits with no text; a task notification or a
// blank one holds a place but draws nothing.
export function waitingPrompts(records: readonly TranscriptRecord[]): WaitingPrompt[] {
    let queue: Queued[] = [];
    // a key that survives the retained window sliding: the enqueue's time, and how many came at that time before it
    const atTime = new Map<string, number>();
    for (const r of records) {
        const rec = r as { type?: unknown; operation?: unknown; content?: unknown; timestamp?: unknown } | null;
        if (rec?.type !== "queue-operation") {
            continue;
        }
        const content = typeof rec.content === "string" ? rec.content : undefined;
        switch (rec.operation) {
            case "enqueue": {
                const stamp = String(rec.timestamp);
                const n = atTime.get(stamp) ?? 0;
                atTime.set(stamp, n + 1);
                const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
                queue.push({ key: `cc:${stamp}:${n}`, content, ...(Number.isFinite(ts) ? { ts } : {}) });
                continue;
            }
            case "remove": {
                const at = queue.findIndex((q) => q.content === content);
                if (at >= 0) {
                    queue.splice(at, 1);
                }
                continue;
            }
            case "dequeue":
                queue.shift();
                continue;
            case "popAll":
                queue = [];
                continue;
        }
    }
    return queue
        .filter((q) => q.content === undefined || drawable(q.content))
        .map((q) => ({
            key: q.key,
            ...(q.content === undefined ? {} : { text: q.content }),
            ...(q.ts == null ? {} : { ts: q.ts }),
        }));
}

function parseSlash(text: string): { name: string; args?: string } | undefined {
    const t = text.trim();
    if (!t.startsWith("/")) {
        return undefined;
    }
    const space = t.search(/\s/);
    if (space < 0) {
        return { name: t };
    }
    return { name: t.slice(0, space), args: t.slice(space).trim() };
}

// The box send each content-less enqueue stands for: the latest one not yet taken sent in the window before it. Matched
// from the newest enqueue back, since a send that runs at once (the /compact a compaction started with) is never queued
// and so must lose to the later send that was.
function sentTexts(waiting: readonly WaitingPrompt[], sent: readonly SentPrompt[]): Map<string, string> {
    const taken = new Set<SentPrompt>();
    const texts = new Map<string, string>();
    const newestFirst = [...sent].reverse();
    for (const w of [...waiting].reverse()) {
        if (w.text != null || w.ts == null) {
            continue;
        }
        const hit = newestFirst.find((s) => !taken.has(s) && s.ts <= w.ts! && w.ts! - s.ts <= SEND_TO_ENQUEUE_MS);
        if (hit != null) {
            taken.add(hit);
            texts.set(w.key, hit.text);
        }
    }
    return texts;
}

// The foot list: Claude Code's waiting prompts, in the order they were sent. One claude recorded no text for takes the
// text of the box send it stands for, and draws nothing when no send explains it.
export function footList(waiting: readonly WaitingPrompt[], sent: readonly SentPrompt[] = []): FootItem[] {
    const filled = sentTexts(waiting, sent);
    const items: FootItem[] = [];
    for (const w of waiting) {
        const text = w.text ?? filled.get(w.key);
        if (text == null) {
            continue;
        }
        const command = parseSlash(text);
        items.push(command != null ? { key: w.key, text, command } : { key: w.key, text });
    }
    return items;
}
