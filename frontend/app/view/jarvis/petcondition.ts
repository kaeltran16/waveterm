// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What Jarvis's condition is: one expression and one posture, from signals the rest of the app already
// computes. Pure — no atoms, no pixels, no React. That separation is what makes petview.tsx a swappable
// renderer rather than the thing that decides (design §5).
//
// The precedence is strict and lives here and nowhere else (design §3):
//   1 cannot-see — semantic recall degraded to keyword matching. Silent degradation is the worst failure
//                  mode: if recall is quietly keyword-only, nothing else the creature reports is
//                  trustworthy, so it outranks everything.
//   2 tired      — the rate-limit window depleting. Cyclical, legible within a day, and not your fault.
//   3 drifting   — the vault's cleanup queue. Degrades slowly and is never urgent, so it ranks last.
// Nothing present => at-rest.
//
// Every input field is optional, and an absent field is "no signal" — never "signal absent". That
// distinction is load-bearing rather than pedantic: petsources.tsx leaves `index` unset until its read lands
// and petview.tsx leaves `decay` unset until the cleanup queue has actually been read, so a backend that has
// not answered yet cannot present here as a clean bill of health.

import { formatReset, usageLevel } from "@/app/view/agents/agentsviewmodel";

export interface PetSignals {
    // rank 1: semantic recall's honesty about itself. Fed from jarvisembed.Status via petjoin.indexSignal.
    index?: { state: "ok" | "off" | "stale" };
    // rank 2: highest 5-hour utilisation across providers (0..100). `resetAt` is epoch SECONDS, matching
    // AgentUsage.fivehourreset and formatReset — the whole cockpit carries this window in seconds.
    rateLimit?: { pct: number; resetAt?: number };
    // rank 3: vault drift. `staleNotes` is the weak-reason subset of `queueDepth`, not a second queue.
    decay?: { queueDepth: number; staleNotes: number };
    // posture: kinds only. The creature never renders a count — the nav badge owns that (design §3).
    attention?: { reviewGates: number; escalations: number; blockedWorkers: number };
}

export type PetExpression =
    | { kind: "cannot-see"; reason: "off" | "stale" }
    | { kind: "tired"; pct: number; resetAt?: number }
    | { kind: "drifting"; queueDepth: number }
    | { kind: "at-rest" };

export type PetPosture = "review-gate" | "escalation" | "blocked-worker" | "none";

// The rank of each expression, exported so the precedence is assertable rather than inferred from the
// order of ifs below.
export const EXPRESSION_RANK: Record<PetExpression["kind"], number> = {
    "cannot-see": 1,
    tired: 2,
    drifting: 3,
    "at-rest": 4,
};

// Tiredness starts where the cockpit's own usage bands stop being "ok" (>60%), so the creature droops at
// the same reading that turns the app-bar gauge amber. A second threshold here would let the two disagree
// about the same number.
function isTired(pct: number): boolean {
    return usageLevel(pct) !== "ok";
}

// A live vault always has a note or two flagged; that is tended, not drifting. The band is where the
// queue stops being something the next Memory visit absorbs in passing.
export const DRIFT_QUEUE_BAND = 5;

export function expressionFor(signals: PetSignals): PetExpression {
    const index = signals.index?.state;
    if (index === "off" || index === "stale") {
        return { kind: "cannot-see", reason: index };
    }
    const rl = signals.rateLimit;
    if (rl != null && isTired(rl.pct)) {
        return { kind: "tired", pct: rl.pct, resetAt: rl.resetAt };
    }
    const decay = signals.decay;
    if (decay != null && decay.queueDepth >= DRIFT_QUEUE_BAND) {
        return { kind: "drifting", queueDepth: decay.queueDepth };
    }
    return { kind: "at-rest" };
}

// Gate before escalation before ask, which is the order pkg/jarvis/attention.go itself sorts by ("a gate
// blocks a whole pipeline, an ask blocks one worker"). Reading it back differently here would make the
// creature and the Needs-you rail disagree about which waiting matters most.
export function postureFor(signals: PetSignals): PetPosture {
    const a = signals.attention;
    if (a == null) {
        return "none";
    }
    if (a.reviewGates > 0) {
        return "review-gate";
    }
    if (a.escalations > 0) {
        return "escalation";
    }
    if (a.blockedWorkers > 0) {
        return "blocked-worker";
    }
    return "none";
}

// First person, because the creature is Jarvis with a face rather than a separate character (design §2).
// Here rather than in the renderer so the bubble and the peek cannot word the same condition differently.
export function conditionLine(expr: PetExpression, nowMs: number): string {
    switch (expr.kind) {
        case "cannot-see":
            return expr.reason === "off"
                ? "I cannot see as well right now — embeddings are off, so recall is keyword-only."
                : "I cannot see as well right now — the index is stale, so recall is keyword-only.";
        case "tired":
            return expr.resetAt != null
                ? `Running low — ${Math.round(expr.pct)}% of the window used, back in ${formatReset(expr.resetAt, nowMs)}.`
                : `Running low — ${Math.round(expr.pct)}% of the window used.`;
        case "drifting":
            return `The vault is drifting — ${expr.queueDepth} notes are queued for cleanup.`;
        case "at-rest":
            return "Nothing needs saying.";
    }
}

const POSTURE_LINE: Record<PetPosture, string> = {
    "review-gate": "A review gate is waiting on you.",
    escalation: "Something escalated to you.",
    "blocked-worker": "A worker is blocked on your reply.",
    none: "",
};

export function postureLine(posture: PetPosture): string {
    return POSTURE_LINE[posture];
}
