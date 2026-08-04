// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What Jarvis has to say right now: at most one utterance per call, chosen from the events past the
// last-seen watermark. Pure, for the same reason as petcondition.ts — the bubble is a renderer.
//
// Two rules from the design (§3):
//   - Push once per event, then wait. One utterance, never a digest.
//   - Report each thing once. An event whose `reportedAsCondition` is true is already visible in the
//     condition level, so it is skipped here — but it still advances the watermark, because it *was*
//     reported. Speaking it too would count the gardener's sweep twice.

export interface PetEvent {
    id: string; // stable across reloads; the watermark compares against it
    at: number; // epoch ms
    kind: "resume" | "sweep" | "distill-batch" | "notes-written" | "bg-agent-done";
    text: string;
    reportedAsCondition?: boolean;
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
    // event seen — not the one spoken — so a skipped condition-reported event is never re-offered.
    watermark: PetWatermark | null;
}

const SILENCE: PetSpeech = { utterance: null, watermark: null };

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
        utterance: newestFirst.find((e) => e.reportedAsCondition !== true) ?? null,
        watermark: { at: newest.at, id: newest.id },
    };
}
