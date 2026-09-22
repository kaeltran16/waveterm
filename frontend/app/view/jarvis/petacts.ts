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

// The closed set of executable operations. Closed rather than open so petactrun.ts's dispatch is
// exhaustive and a new operation cannot be added without wiring it.
export type PetOp = { kind: "reconcile-index" };

// Where an escort lands. An oref goes through openAddress; the surface target exists because the Settings
// embeddings section is not addressable as an oref.
export type PetTarget = { kind: "oref"; ref: string; anchor?: string } | { kind: "settings-embeddings" };

// The four arguments askAboutSource already takes, carried as data so this pure module can offer an Ask
// without importing the impure helper.
export interface AskSeed {
    ref: string;
    sourceType: string;
    title: string;
    prompt: string;
}

export type PetAct =
    | { id: string; verb: "do"; label: string; op: PetOp }
    | { id: string; verb: "open"; label: string; target: PetTarget }
    | { id: string; verb: "ask"; label: string; seed: AskSeed };

// An act's transient outcome, keyed by act id in petstore.ts. Transient on purpose: the row's real value
// comes from its own poll, and letting an act's return value become the row's value would drift from the
// backend the moment a poll disagreed with a stale result.
export type PetActStatus = "running" | "done" | "error";

export interface PetActState {
    status: PetActStatus;
    text?: string;
}

export const RECALL_CATCHUP_ACT_ID = "recall:catchup";

// pkg/jarvisembed/status.go's off-reasons split cleanly in two: these two are a flag and a credential,
// which is a text entry in Settings and not something an operation can fix. Every other off-reason is a
// failure, and for a failure the result of retrying IS the diagnostic.
const CONFIG_REASONS = new Set(["disabled", "no-key"]);

export function actsForRecall(status: EmbedIndexStatus | null | undefined): PetAct[] {
    if (status == null || status.state === "ok") {
        return [];
    }
    if (status.state === "stale") {
        // all three stale reasons — drifted content, another model, never built — are what Reconcile does
        return [{ id: RECALL_CATCHUP_ACT_ID, verb: "do", label: "Catch up", op: { kind: "reconcile-index" } }];
    }
    if (status.state !== "off") {
        // a state this build has not been taught: recallLine still reports it, but guessing a verb for it
        // would be worse than offering none
        return [];
    }
    if (CONFIG_REASONS.has(status.reason ?? "")) {
        return [{ id: "recall:setup", verb: "open", label: "Set up", target: { kind: "settings-embeddings" } }];
    }
    return [{ id: "recall:retry", verb: "do", label: "Retry", op: { kind: "reconcile-index" } }];
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

// Open and Ask per product, one pair per source the event carries.
export function actsForEvent(event: { id: string; sources?: PetEventSource[] }): PetAct[] {
    const acts: PetAct[] = [];
    for (const s of event.sources ?? []) {
        acts.push({
            id: `${event.id}:${s.ref}:open`,
            verb: "open",
            label: `Open ${s.title}`,
            target: { kind: "oref", ref: s.ref, anchor: s.anchor },
        });
        acts.push({
            id: `${event.id}:${s.ref}:ask`,
            verb: "ask",
            label: "Ask",
            seed: {
                ref: s.ref,
                sourceType: s.sourceType,
                title: s.title,
                prompt: `Tell me more about "${s.title}".`,
            },
        });
    }
    return acts;
}
