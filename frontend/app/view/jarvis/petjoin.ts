// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The join between the backend reads and the creature's pure modules: three adapters, one per source.
// Pure and separate from petsources.tsx for the same reason petcondition.ts is separate from petview.tsx
// (design §5) — the wire shapes are the part most likely to change, and an adapter is testable without a
// websocket.
//
// Every adapter is total: a shape it does not recognise yields undefined/null rather than a guess. That is
// the no-guessing property (design §2) applied at the boundary where it is easiest to lose.

import type { PetSignals } from "./petcondition";
import type { PetEvent } from "./petvoice";

const INDEX_STATES = ["ok", "off", "stale"] as const;
type IndexState = (typeof INDEX_STATES)[number];

// EmbedIndexStatus.state crosses the wire as a bare string (generated from a Go string field), so it is
// narrowed here. An unrecognised state yields undefined — "no signal" — never "ok": reading an unknown
// state as healthy is exactly the silent degradation the rank-1 condition exists to expose.
export function indexSignal(status: EmbedIndexStatus | null | undefined): PetSignals["index"] | undefined {
    const state = status?.state;
    if (state == null || !(INDEX_STATES as readonly string[]).includes(state)) {
        return undefined;
    }
    return { state: state as IndexState };
}

// Why recall is degraded, in words. This is the diagnostic half of the rank-1 condition: "embeddings are
// off" explains a whole class of "why is Jarvis useless" without a bug report (design §3, Integrity).
// An unrecognised reason falls through to the raw string rather than being swallowed — a reason the UI has
// not been taught is still more useful than silence.
const RECALL_REASON: Record<string, string> = {
    disabled: "embeddings are turned off",
    "no-key": "no API key configured",
    "provider-error": "the embedding provider failed",
    "index-error": "the index could not be opened",
    "vault-error": "the vault could not be read",
    "model-mismatch": "indexed with a different model",
    "not-built": "the index has not been built",
    "content-drift": "notes have changed since indexing",
};

export function recallLine(status: EmbedIndexStatus | null | undefined): { text: string; dim: boolean } {
    if (status == null) {
        return { text: "not read yet", dim: true };
    }
    const why = status.reason != null ? (RECALL_REASON[status.reason] ?? status.reason) : null;
    if (status.state === "ok") {
        return { text: status.indexednodes > 0 ? `ok · ${status.indexednodes} indexed` : "ok", dim: false };
    }
    const drift = status.state === "stale" && status.stalenodes > 0 ? ` (${status.stalenodes})` : "";
    return { text: why != null ? `${status.state} — ${why}${drift}` : status.state, dim: false };
}

const ACTIVITY_KINDS = ["sweep", "distill-batch", "notes-written"] as const;
type ActivityKind = (typeof ACTIVITY_KINDS)[number];

function notes(n: number): string {
    return n === 1 ? "1 note" : `${n} notes`;
}

// First person, matching conditionLine in petcondition.ts — the creature is Jarvis with a face, not a
// separate character (design §2), and one voice means one register everywhere.
function activityText(kind: ActivityKind, d: MemoryActivityData): string {
    switch (kind) {
        case "sweep":
            return `I tidied the vault — ${notes(d.archived ?? 0)} archived.`;
        case "distill-batch":
            return d.sessions != null && d.sessions > 0
                ? `I went back over ${d.sessions === 1 ? "1 session" : `${d.sessions} sessions`} while you were out.`
                : "I went back over your recent sessions while you were out.";
        case "notes-written":
            return `Here is what I wrote down about you — ${notes(d.committed ?? 0)} into the vault.`;
    }
}

// A memory:activity event becomes at most one utterance. `reportedAsCondition` is deliberately left unset
// on all three kinds: the design's report-once rule splits these registers rather than suppressing one
// (§3, "the event is the transition, the condition is the level"). A sweep that archived twelve notes and a
// vault that is no longer drifting are two different facts, so both may be reported.
export function eventFromActivity(d: MemoryActivityData | null | undefined): PetEvent | null {
    const kind = d?.kind;
    if (d == null || kind == null || !(ACTIVITY_KINDS as readonly string[]).includes(kind)) {
        return null;
    }
    if (!d.id || !d.ts) {
        return null; // no stable id or no timestamp means the watermark cannot order it
    }
    return {
        id: d.id,
        at: d.ts,
        kind: kind as ActivityKind,
        text: activityText(kind as ActivityKind, d),
    };
}

// The launch narrative. The id has to be stable across relaunches or the creature re-says "where we were"
// on every start; keying it to the run plus the narrative's own timestamp makes it stable until a NEW
// narrative is written, which is exactly when it should speak again.
//
// `card.updated` is epoch milliseconds (pkg/jarvisdossier/parse.go stamps it with UnixMilli), the same unit
// as MemoryActivityData.ts — so the watermark orders the two sources against each other correctly.
export function eventFromResume(rtn: CommandGetLatestResumeRtnData | null | undefined): PetEvent | null {
    const card = rtn?.card;
    const summary = card?.summary?.trim();
    if (card == null || !summary) {
        return null;
    }
    const at = card.updated > 0 ? card.updated : 0;
    if (at === 0) {
        return null; // undatable: the watermark could never advance past it, so it would re-speak forever
    }
    return {
        id: `resume:${rtn?.runoref ?? card.taskId}:${at}`,
        at,
        kind: "resume",
        text: `Where we were — ${summary}`,
    };
}
