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
    | { id: string; verb: "ack"; label: string; channelId: string; runId: string };

// pkg/jarvis/attention.go AttentionRunUnverified
const RUN_UNVERIFIED_KIND = "run-unverified";

// An act's transient outcome, keyed by act id in petstore.ts. Transient on purpose: the row's real value
// comes from its own poll, and letting an act's return value become the row's value would drift from the
// backend the moment a poll disagreed with a stale result.
export type PetActStatus = "running" | "done" | "error";

export interface PetActState {
    status: PetActStatus;
    text?: string;
}

// An unverified run is the one kind a button settles: acknowledging it is the whole resolution, the same
// in-place Acknowledge the Brief's queue offers, with the Open escort after it for reading the run first.
// Everything else needs a written answer or a picked option, neither of which is a button, so the escort
// alone covers it.
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
