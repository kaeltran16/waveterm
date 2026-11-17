// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The messages waiting on an agent, drawn at the foot of the Rendered transcript: Claude Code's own queue, read from
// the transcript's queue-operation records. A box message sent mid-turn is typed into the terminal, so it waits there.

import type { TranscriptRecord } from "./transcriptrecords";

// a prompt waiting in Claude Code's own queue
export type WaitingPrompt = { key: string; text: string; ts?: number };

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
// oldest (it names none), popAll takes all. Enqueues with no content or a task notification hold a place but draw
// nothing.
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
    return queue.filter((q) => drawable(q.content)).map((q) => ({ key: q.key, text: q.content!, ts: q.ts }));
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

// The foot list: Claude Code's waiting prompts, in the order they were sent.
export function footList(waiting: readonly WaitingPrompt[]): FootItem[] {
    return waiting.map((w) => {
        const command = parseSlash(w.text);
        return command != null ? { key: w.key, text: w.text, command } : { key: w.key, text: w.text };
    });
}
