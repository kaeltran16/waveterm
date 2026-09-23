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

export type PetAct = { id: string; verb: "open"; label: string; target: PetTarget };

// An act's transient outcome, keyed by act id in petstore.ts. Transient on purpose: the row's real value
// comes from its own poll, and letting an act's return value become the row's value would drift from the
// backend the moment a poll disagreed with a stale result.
export type PetActStatus = "running" | "done" | "error";

export interface PetActState {
    status: PetActStatus;
    text?: string;
}

// No attention kind carries a resolving verb any more. An escalation needs a written answer and an ask
// needs a picked option, neither of which is a button; slice 5c deleted the review gate, which was the one
// kind a button could settle. The Open escort covers all of them.
export function actsForAttention(item: AttentionItem): PetAct[] {
    if (!item?.runid) {
        return []; // nothing addressable: an item with no run cannot be opened or resolved
    }
    return [
        {
            id: `${item.key}:open`,
            verb: "open",
            label: "Open",
            target: { kind: "oref", ref: `run:${item.runid}` },
        },
    ];
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
