// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The messages waiting on an agent, drawn at the foot of the Rendered transcript: the person's messages the arc mod
// holds (reported through agent:queue), and Claude Code's own queue, read from the transcript's queue-operation
// records. A mod message that left the queue keeps drawing until the transcript holds the record that shows it read.

import type { AgentEntry } from "./agentsviewmodel";
import type { TranscriptRecord } from "./transcriptrecords";

// a prompt waiting in Claude Code's own queue
export type WaitingPrompt = { key: string; text: string; ts?: number };

// a message the mod reported holding; held turns false once it left the queue without being lost
export type ModItem = QueuedPrompt & { held: boolean };

export type FootItem = {
    key: string;
    text: string;
    // still waiting, so it counts toward the Queued line
    queued: boolean;
    // a slash command draws as its command row
    command?: { name: string; args?: string };
};

export type Foot = {
    items: FootItem[];
    queued: number;
    // ids of mod items the transcript now shows read, which the store can forget
    retired: string[];
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

// The mod's items after a report: the reported ones held, in its order; an item gone from it that was not lost stays,
// no longer held; a lost one goes (the box puts it back).
export function nextModItems(prev: readonly ModItem[], data: AgentQueueData): ModItem[] {
    const heldIds = new Set(data.held.map((p) => p.id));
    const lostIds = new Set((data.lost ?? []).map((p) => p.id));
    const left = prev.filter((p) => !heldIds.has(p.id) && !lostIds.has(p.id)).map((p) => ({ ...p, held: false }));
    return [...left, ...data.held.map((p) => ({ ...p, held: true }))].sort((a, b) => a.ts - b.ts);
}

function lines(text: string): string[] {
    return text
        .trim()
        .split("\n")
        .map((l) => l.trimEnd());
}

function containsRun(hay: string[], run: string[]): boolean {
    for (let i = 0; i + run.length <= hay.length; i++) {
        if (run.every((l, k) => hay[i + k] === l)) {
            return true;
        }
    }
    return false;
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

// the transcript shows the item read: a user entry after it holding its lines as a run (a turn-end prompt joins
// several), or for a slash command, a command entry after it naming the same command
function readIn(item: ModItem, entries: readonly AgentEntry[]): boolean {
    const want = lines(item.text);
    const slash = parseSlash(item.text);
    const typed = item.text.trim();
    return entries.some((e) => {
        if (e.kind !== "user" && e.kind !== "command") {
            return false;
        }
        if (e.ts == null || e.ts < item.ts) {
            return false;
        }
        if (e.kind === "user") {
            return containsRun(lines(e.text), want);
        }
        return slash != null && (e.args ? `${e.name} ${e.args}` : e.name) === typed;
    });
}

// The foot list: the mod's items (a left one until the transcript shows it read) and Claude Code's waiting prompts,
// in the order they were sent.
export function footList(
    mod: readonly ModItem[],
    waiting: readonly WaitingPrompt[],
    entries: readonly AgentEntry[]
): Foot {
    const retired: string[] = [];
    const drawn: (FootItem & { ts: number })[] = [];
    for (const m of mod) {
        if (!m.held && readIn(m, entries)) {
            retired.push(m.id);
            continue;
        }
        drawn.push({ key: `mod:${m.id}`, text: m.text, queued: m.held, ts: m.ts, command: parseSlash(m.text) });
    }
    for (const w of waiting) {
        drawn.push({
            key: w.key,
            text: w.text,
            queued: true,
            ts: w.ts ?? Number.MAX_SAFE_INTEGER,
            command: parseSlash(w.text),
        });
    }
    drawn.sort((a, b) => a.ts - b.ts);
    const items = drawn.map(({ ts: _ts, command, ...rest }) => (command != null ? { ...rest, command } : rest));
    return { items, queued: items.filter((i) => i.queued).length, retired };
}
