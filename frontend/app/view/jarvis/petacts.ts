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

// type-only, so the purity above holds: JarvisTier lives beside the tierFromMeta that produces it, and
// petvoice.ts is itself pure so PetEventSource adds no impure dependency either
import type { JarvisTier } from "@/app/view/agents/channelmessages";
import type { PetEventSource } from "./petvoice";

// The closed set of executable operations. Closed rather than open so petactrun.ts's dispatch is
// exhaustive and a new operation cannot be added without wiring it.
export type PetOp =
    | { kind: "reconcile-index" }
    | { kind: "clear-superseded"; count: number }
    | { kind: "gate"; channelId: string; runId: string; phaseIdx: number; action: "approve" | "sendback" };

// Where an escort lands. An oref goes through the existing openORef; the two surface targets exist because
// the Memory cleanup queue and the Settings embeddings section are not addressable as orefs.
export type PetTarget =
    | { kind: "oref"; ref: string; anchor?: string }
    | { kind: "memory-upkeep" }
    | { kind: "settings-embeddings" };

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

// pkg/memvault/prune.go's one mechanical reason: a note explicitly replaced by another. Every other reason
// is a judgement about whether the note is still worth keeping, and pruning deletes the file irreversibly.
const SUPERSEDED = "superseded";

export function actsForVault(candidates: MemoryPruneCandidate[] | null | undefined): PetAct[] {
    const list = candidates ?? [];
    if (list.length === 0) {
        return [];
    }
    const acts: PetAct[] = [
        { id: "vault:review", verb: "open", label: `Review ${list.length}`, target: { kind: "memory-upkeep" } },
    ];
    const superseded = list.filter((c) => c.reason === SUPERSEDED).length;
    if (superseded > 0) {
        acts.push({
            id: "vault:clear-superseded",
            verb: "do",
            label: `Clear ${superseded} superseded`,
            op: { kind: "clear-superseded", count: superseded },
        });
    }
    return acts;
}

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
        return [{ id: "recall:catchup", verb: "do", label: "Catch up", op: { kind: "reconcile-index" } }];
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

// pkg/jarvis/attention.go's kind for a run parked at a review gate. Only this kind has a resolving verb:
// an escalation needs a written answer and an ask needs a picked option, neither of which is a button.
const ATTENTION_GATE = "gate";

// The creature holds no tier of its own — there is no client-level or global tier anywhere in the app — so
// authority is a property of the creature-and-target pair (pet design §6). `tier` is the TARGET channel's,
// read through tierFromMeta by the caller. Carrying, holding and escorting need no trust model at all,
// which is why Open is unconditional.
export function actsForAttention(item: AttentionItem, tier: JarvisTier): PetAct[] {
    if (!item?.runid) {
        return []; // nothing addressable: an item with no run cannot be opened or resolved
    }
    const acts: PetAct[] = [
        {
            id: `${item.key}:open`,
            verb: "open",
            label: "Open",
            target: { kind: "oref", ref: `run:${item.runid}` },
        },
    ];
    if (item.kind !== ATTENTION_GATE || tier !== "delegator") {
        return acts;
    }
    const base = { channelId: item.channelid ?? "", runId: item.runid, phaseIdx: item.phaseidx ?? 0 };
    acts.push({
        id: `${item.key}:approve`,
        verb: "do",
        label: "Approve",
        op: { kind: "gate", ...base, action: "approve" },
    });
    acts.push({
        id: `${item.key}:sendback`,
        verb: "do",
        label: "Send back",
        op: { kind: "gate", ...base, action: "sendback" },
    });
    // Triage is deliberately absent: it needs a verdict and a one-line reason, which is a form and not a
    // button. The Open escort covers it.
    return acts;
}

const MEMNOTE_PREFIX = "memnote:";

// Open and Ask per product. `noteExists` is three-state and passed in rather than read: undefined means
// "not scanned yet", which must not suppress the button — the memory scan only runs when that surface is
// visited, so treating unknown as absent would hide almost every Open there is (design §9).
export function actsForEvent(
    event: { id: string; sources?: PetEventSource[] },
    noteExists: (id: string) => boolean | undefined
): PetAct[] {
    const acts: PetAct[] = [];
    for (const s of event.sources ?? []) {
        const noteId = s.ref.startsWith(MEMNOTE_PREFIX) ? s.ref.slice(MEMNOTE_PREFIX.length) : null;
        if (noteId != null && noteExists(noteId) === false) {
            continue; // known absent: openORef would no-op, and a dead click target is worse than none
        }
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
