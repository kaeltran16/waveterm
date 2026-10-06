// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What the creature offers to DO about each thing it reports. Pure — no atoms, no rpc, no pixels — for the
// same reason petcondition.ts is (design §3): this module decides WHAT is offered, and passing thunks in
// here would drag the rpc client into the one layer whose whole value is being assertable without one.
//
// The law it implements (design §2): nothing appears on the creature unless it carries the thing that
// resolves it. A row with genuinely nothing to do returns [] and stays a readout — the rate-limit countdown
// is that row, and it is honest rather than an omission.

// type-only, so the purity above holds: petvoice.ts is itself pure, so PetEventSource adds no impure
// dependency either
import type { PetEventSource } from "./petvoice";

// Where an escort lands; every landing is an address that goes through openAddress.
export type PetTarget = { kind: "oref"; ref: string; anchor?: string };

export type PetAct =
    | { id: string; verb: "open"; label: string; target: PetTarget }
    // land: true dismisses the run's held land instead of acknowledging its unverified outcome
    | { id: string; verb: "ack"; label: string; channelId: string; runId: string; land?: boolean }
    | { id: string; verb: "land"; label: string; channelId: string; runId: string };

// pkg/jarvis/attention.go AttentionRunUnverified, AttentionRunLandHeld
const RUN_UNVERIFIED_KIND = "run-unverified";
const RUN_LAND_HELD_KIND = "run-land-held";

// An act's transient outcome, keyed by act id in petstore.ts. Transient on purpose: the row's real value
// comes from its own poll, and letting an act's return value become the row's value would drift from the
// backend the moment a poll disagreed with a stale result.
export type PetActStatus = "running" | "done" | "error";

export interface PetActState {
    status: PetActStatus;
    text?: string;
}

// Two kinds a button settles. An unverified run: acknowledging it is the whole resolution, the same in-place
// Acknowledge the Brief's queue offers, with the Open escort after it for reading the run first. A held land:
// retrying it is the resolution once its reason is cleared (a branch merged by hand lands at once), and
// Dismiss is the way out for a branch that will never land. Everything else needs a written answer or a
// picked option, neither of which is a button, so the escort alone covers it.
export function actsForAttention(item: AttentionItem): PetAct[] {
    if (!item?.runid) {
        return []; // nothing addressable: an item with no run cannot be opened or resolved
    }
    const escort: PetAct = {
        id: `${item.key}:open`,
        verb: "open",
        label: "Open",
        target: { kind: "oref", ref: `run:${item.runid}` },
    };
    if (item.kind === RUN_UNVERIFIED_KIND && item.channelid) {
        return [
            { id: `${item.key}:ack`, verb: "ack", label: "Acknowledge", channelId: item.channelid, runId: item.runid },
            escort,
        ];
    }
    if (item.kind === RUN_LAND_HELD_KIND && item.channelid) {
        const run = { channelId: item.channelid, runId: item.runid };
        return [
            { id: `${item.key}:land`, verb: "land", label: "Retry land", ...run },
            { id: `${item.key}:dismiss`, verb: "ack", label: "Dismiss", land: true, ...run },
            escort,
        ];
    }
    return [escort];
}

// One Open per source the event carries.
export function actsForEvent(event: { id: string; sources?: PetEventSource[] }): PetAct[] {
    const acts: PetAct[] = [];
    for (const s of event.sources ?? []) {
        acts.push({
            id: `${event.id}:${s.ref}:open`,
            verb: "open",
            label: `Open ${s.title}`,
            target: { kind: "oref", ref: s.ref, anchor: s.anchor },
        });
    }
    return acts;
}
