// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Ambient attribution provider seam. The real edges come from attribution engine D (v2); this cycle ships
// a deterministic FIXTURE keyed off the oref hash so dev/CDP shows believable placeholder task tags and
// "relevant past decision" cards on real Run/Radar/Memory rows. PLACEHOLDER data — see docs/deferred.md.
// The durable part is the AmbientProvider interface: D replaces fixtureAmbientProvider behind it.

export interface AmbientTag {
    label: string;
    taskId: string;
}
export interface AmbientDecision {
    title: string;
    oref: string;
    ageMs: number;
}
export interface AmbientProvider {
    tagsFor(oref: string): AmbientTag[];
    decisionsFor(oref: string): AmbientDecision[];
}

const TASKS = ["channel-scaling", "radar-loop", "tauri-migration", "recall-engine"];
const DECISIONS = [
    { title: "Decision: drop-oldest on overflow", oref: "decision:placeholder-1", ageMs: 2 * 24 * 60 * 60 * 1000 },
    { title: "Decision: shared working tree", oref: "decision:placeholder-2", ageMs: 5 * 24 * 60 * 60 * 1000 },
];

// Inlined from recallderive.ageLabel so ambient stays jarvis-free (agents must not import the jarvis view).
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export function ageLabel(ageMs: number): string {
    if (ageMs < MIN) return "just now";
    if (ageMs < HOUR) return `${Math.floor(ageMs / MIN)}m ago`;
    if (ageMs < DAY) return `${Math.floor(ageMs / HOUR)}h ago`;
    return `${Math.floor(ageMs / DAY)}d ago`;
}

function hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

export const fixtureAmbientProvider: AmbientProvider = {
    tagsFor(oref) {
        if (!oref) {
            return [];
        }
        const label = TASKS[hash(oref) % TASKS.length];
        return [{ label, taskId: label }];
    },
    decisionsFor(oref) {
        if (!oref || hash(oref) % 2 === 0) {
            return []; // ~half of objects surface a related decision
        }
        return [DECISIONS[hash(oref) % DECISIONS.length]];
    },
};
