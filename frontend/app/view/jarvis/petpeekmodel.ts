// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What the peek's body shows: one row per waiting item the creature can act on, and the spoken updates that
// are not already one of those rows. Pure, like petcondition.ts — petpeek.tsx is a renderer, not the thing
// that decides.

import { actsForAttention, type PetAct } from "./petacts";
import { conditionsFor, type PetExpression, type PetSignals } from "./petcondition";
import type { PetEvent } from "./petvoice";

export interface PeekRow {
    key: string;
    kind: string;
    source: string;
    // null when the kind's text is a constant the verb already implies — see DETAIL_KINDS.
    detail: string | null;
    waitingsince: number;
    // the escort, relabelled with the item's own verb. null when nothing is addressable behind the item.
    // It is the only act a row can carry: slice 5c deleted the review gate, the one attention kind a
    // button could settle, so nothing is left to show behind a disclosure.
    primary: PetAct | null;
}

// pkg/jarvis/attention.go writes Text per kind, and only these two put anything in it that the row's own
// verb does not already say. A gate's "Approve before Jarvis proceeds.", a dag-gate's near-twin and an
// ask's "Waiting on your reply" are constants repeated on every row of that kind, so they are dropped and
// the width goes to the source — the part that differs. (The tidier fix is for Go to stop sending a
// sentence that Action already encodes; brief §7 rules backend changes out of this pass.)
const DETAIL_KINDS = new Set(["escalation", "dag-blocked"]);

// Radar triage is the one attention kind the creature has no business holding. It names no channel and no
// run, so it arrives with no act behind it (petacts.actsForAttention) and renders as a project name, an age
// and nothing to press; the avatar's own signals never counted it either (petview.usePetSignals reads
// gates, escalations and asks). It is addressed through its ORef by the Radar rail's badge and the Brief's
// queue, which is the same routing splitAttention already does to keep it off Cockpit.
const PEEK_EXCLUDED_KIND = "radar-triage";

export function queueRows(items: AttentionItem[]): PeekRow[] {
    return (items ?? [])
        .filter((item) => item.kind !== PEEK_EXCLUDED_KIND)
        .map((item) => {
            // actsForAttention returns [] with no runid and [Open] otherwise: no attention kind carries a
            // resolving verb, so the escort is the only act and `more` is always empty.
            const [escort] = actsForAttention(item);
            return {
                key: item.key,
                kind: item.kind,
                source: item.source,
                detail: DETAIL_KINDS.has(item.kind) ? item.text : null,
                waitingsince: item.waitingsince,
                // "Review" / "Decide" / "Answer" is the same navigation as "Open", named by what it is for.
                primary: escort != null ? ({ ...escort, label: item.action } as PetAct) : null,
            };
        });
}

// An ask waiting on the user is both an AttentionItem keyed "ask:<block oref>" and a PetEvent carrying that
// oref in `ref`. The queue row is the actionable one, so the utterance yields to it — the pet design's
// crossing rule, applied to the only pair that can currently collide.
export function dedupeUpdates(events: PetEvent[], items: AttentionItem[]): PetEvent[] {
    const queued = new Set((items ?? []).filter((item) => item.kind === "ask").map((item) => item.key));
    return (events ?? []).filter(
        (event) => !(event.kind === "ask" && event.ref != null && queued.has(`ask:${event.ref}`))
    );
}

export type PeekKeyCommand = "next" | "previous" | "open" | "conditions" | "composer" | "close";

export function peekKeyCommand(key: string): PeekKeyCommand | null {
    switch (key) {
        case "j":
        case "ArrowDown":
            return "next";
        case "k":
        case "ArrowUp":
            return "previous";
        case "Enter":
            return "open";
        case "c":
            return "conditions";
        case "/":
            return "composer";
        case "Escape":
            return "close";
        default:
            return null;
    }
}

export function peekActForCommand(row: PeekRow | undefined, command: PeekKeyCommand): PetAct | null {
    if (row == null) {
        return null;
    }
    return command === "open" ? row.primary : null;
}

export interface PeekCondition {
    expr: PetExpression;
    // true only where the KIND has no remedy to offer
    readout: boolean;
}

// The rate-limit countdown is the one condition with genuinely nothing to do (petacts.ts header). Naming it
// here rather than inferring it keeps "no remedy" and "no remedy yet" distinguishable.
const READOUT_KINDS = new Set<PetExpression["kind"]>(["tired"]);

// Every standing condition in rank order, each marked readout or not.
export function peekConditions(signals: PetSignals): PeekCondition[] {
    return conditionsFor(signals).map((expr) => ({
        expr,
        readout: READOUT_KINDS.has(expr.kind),
    }));
}
