// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What Jarvis has to say right now: at most one utterance per call, chosen from the events past the
// last-seen watermark. Pure, for the same reason as petcondition.ts — the bubble is a renderer.
//
// The rule from the design (§3): push once per event, then wait. One utterance, never a digest.

// Where a knowledge utterance points. `ref` is a frontend navigation address (see openref.ts), which
// may carry a vault node id inside an oref-shaped string — the same thing askAboutRecord already does
// with "task:"+dossierId. `anchor` names a sub-object to highlight within `ref`, which is how a
// decision addresses its parent record's thread: decisionlog.tsx renders it, so it has no route of
// its own.
export interface PetEventSource {
    ref: string;
    anchor?: string;
    title: string;
    sourceType: string; // dossier | decision | memory | run | memhygiene
}

export interface PetEvent {
    id: string; // stable across reloads; the watermark compares against it
    at: number; // epoch ms
    kind:
        | "resume"
        | "bg-agent-done"
        // volunteered knowledge: what Jarvis knows about your work, not what the system did
        | "connection"
        | "loose-end"
        | "ledger"
        | "memory-hygiene"
        // announcement channels: notifications and pending agent questions
        | "notify"
        | "ask";
    text: string;
    // message body / question body — the bubble shows only `text`; the peek renders this dimmed
    detail?: string;
    // a notification's level, which is the only register that names one
    level?: NotifyLevel;
    // address of the thing that raised this event (an ask's or a notice's block oref) — carried for the
    // peek to open, and for a notice's bubble to name its agent
    ref?: string;
    // said once: spoken like any other, but never remembered, and its bubble leaving marks nothing unread
    transient?: boolean;
    // Set on any utterance that has products to open: volunteered knowledge carries the one thing it is
    // about. An utterance with none has nothing to open.
    sources?: PetEventSource[];
}

export type NotifyLevel = "info" | "warn" | "error";

// What register the utterance came from, in the design's own words. One table for the bubble and the peek,
// so the two cannot name the same event differently.
const KIND_LABEL: Record<PetEvent["kind"], string> = {
    resume: "Where we were",
    "bg-agent-done": "While you were out",
    connection: "This just connected",
    "loose-end": "Still open",
    ledger: "Work state",
    "memory-hygiene": "Memory to review",
    notify: "Notice",
    ask: "Asking you",
};

const LEVEL_LABEL: Record<NotifyLevel, string> = {
    info: "Notice",
    warn: "Warning",
    error: "Error",
};

export function eventLabel(event: PetEvent): string {
    return event.kind === "notify" ? LEVEL_LABEL[event.level ?? "info"] : KIND_LABEL[event.kind];
}

// The last event the creature considered, not merely the last one it said. Both fields are needed: `at`
// orders, and `id` breaks a same-millisecond tie so two events in one tick cannot silently collapse.
export interface PetWatermark {
    at: number;
    id: string;
}

export interface PetSpeech {
    // what to say now, or null for silence
    utterance: PetEvent | null;
    // the watermark to store once said, or null when there was nothing new to consider. It is the newest
    // event seen.
    watermark: PetWatermark | null;
    // every new event worth remembering, newest first: one bubble speaks, but the peek reads back all of
    // them, so the rest of a burst is not lost behind the one that was said
    heard: PetEvent[];
}

const SILENCE: PetSpeech = { utterance: null, watermark: null, heard: [] };

function isNewer(a: { at: number; id: string }, b: { at: number; id: string }): boolean {
    return a.at !== b.at ? a.at > b.at : a.id > b.id;
}

export function nextUtterance(events: PetEvent[], seen: PetWatermark | null): PetSpeech {
    const unseen = (events ?? []).filter((e) => e != null && (seen == null || isNewer(e, seen)));
    if (unseen.length === 0) {
        return SILENCE;
    }
    // newest first: a backlog (a relaunch after a long absence) says the latest thing rather than
    // narrating twenty stale ones one bubble at a time. The rest are recoverable from the peek.
    const newestFirst = [...unseen].sort((a, b) => (isNewer(a, b) ? -1 : 1));
    const newest = newestFirst[0];
    return {
        utterance: newest,
        watermark: { at: newest.at, id: newest.id },
        heard: newestFirst.filter((e) => e.transient !== true),
    };
}

// The unread marker stands for what the peek can read back, and a said-once utterance is never there. So
// saying one clears nothing: the marker stays if it was set, and is set for a kept bubble it pushed aside
// unopened or for anything else the same burst remembered. A kept utterance is its own notice.
export function unreadAfterSaying(speech: PetSpeech, showing: PetEvent | null, unread: boolean): boolean {
    if (speech.utterance?.transient !== true) {
        return false;
    }
    return unread || (showing != null && showing.transient !== true) || speech.heard.length > 0;
}

// a bubble that left unopened is unread, unless it was said once: then there is nothing to go and read
export function unreadAfterLeaving(left: PetEvent | null, unread: boolean): boolean {
    return left?.transient === true ? unread : true;
}
