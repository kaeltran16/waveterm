// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What Jarvis's condition is: one expression and one posture, from signals the rest of the app already
// computes. Pure — no atoms, no pixels, no React. That separation is what makes petview.tsx a swappable
// renderer rather than the thing that decides (design §5).
//
// The precedence is strict and lives here and nowhere else (design §3):
//   1 cannot-see — semantic recall degraded to keyword matching. No signal feeds it since the embedding
//                  index was retired; the register is kept so the avatar's rendering of it survives.
//   2 tired      — the rate-limit window depleting. Cyclical, legible within a day, and not your fault.
// Nothing present => at-rest.
//
// Every input field is optional, and an absent field is "no signal" — never "signal absent". That
// distinction is load-bearing rather than pedantic: a source that has not answered yet cannot present here
// as a clean bill of health.

import { formatReset, usageLevel } from "@/app/view/agents/agentsviewmodel";
import { providerLabel } from "@/app/view/agents/cockpitrailmodel";

export interface PetSignals {
    // rank 2: highest 5-hour utilisation across providers (0..100). `resetAt` is epoch SECONDS, matching
    // AgentUsage.fivehourreset and formatReset — the whole cockpit carries this window in seconds.
    // `provider` is required because the reading is per-provider and the highest wins: unnamed, a codex
    // window reads as a claude one, and the countdown belongs to whichever provider won.
    rateLimit?: { provider: string; pct: number; resetAt?: number };
    // posture: kinds only. The creature never renders a count — the nav badge owns that (design §3).
    attention?: { reviewGates: number; escalations: number; blockedWorkers: number };
}

export type PetExpression =
    | { kind: "cannot-see"; reason: "off" | "stale" }
    | { kind: "tired"; provider: string; pct: number; resetAt?: number }
    | { kind: "at-rest" };

export type PetPosture = "review-gate" | "escalation" | "blocked-worker" | "none";

// The rank of each expression, exported so the precedence is assertable rather than inferred from the
// order of ifs below.
export const EXPRESSION_RANK: Record<PetExpression["kind"], number> = {
    "cannot-see": 1,
    tired: 2,
    "at-rest": 3,
};

// tiredness starts where the cockpit's own usage bands stop being "ok" (>60%), so every consumer reports
// the same window honestly even when a higher-priority expression owns the creature.
export function isWindowConstrained(rateLimit: PetSignals["rateLimit"]): boolean {
    return rateLimit != null && usageLevel(rateLimit.pct) !== "ok";
}

// Every standing condition, ranked. The creature wears one face, but the peek lists them all — stating only
// the winner is what made the old panel print the loser a second time as a tile. at-rest is never a member:
// an empty list is how quiet is spelled.
export function conditionsFor(signals: PetSignals): PetExpression[] {
    const out: PetExpression[] = [];
    const rl = signals.rateLimit;
    if (rl != null && isWindowConstrained(rl)) {
        out.push({ kind: "tired", provider: rl.provider, pct: rl.pct, resetAt: rl.resetAt });
    }
    return out;
}

// The face the creature wears: the highest-ranked condition, or at-rest. Delegating rather than repeating
// the predicates is what keeps the corner and the panel from disagreeing — the peek's lead line IS this.
export function expressionFor(signals: PetSignals): PetExpression {
    return conditionsFor(signals)[0] ?? { kind: "at-rest" };
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
            // Only the "off" case is really keyword-only. A behind index still answers semantically — the
            // index reconciles itself inside the next query — so that line reports the fact rather than a
            // degradation that is not happening.
            //
            // Prose that names an action was the original defect: the panel said "ask me anything and I
            // will catch it up" and offered nowhere to do it. Both lines now state the fact; petacts.ts
            // supplies the verb (design §4.1).
            return expr.reason === "off"
                ? "I cannot see as well right now — embeddings are off, so recall is keyword-only."
                : "My index is behind on some notes.";
        case "tired": {
            const pct = Math.round(expr.pct);
            const who = providerLabel(expr.provider);
            const back = expr.resetAt != null ? formatReset(expr.resetAt, nowMs) : null;
            // a window at 100 is not running low, it is gone. Reading the same at 86% and at 100%
            // understates the one state where there is nothing left to spend.
            if (pct >= 100) {
                return back != null ? `${who}'s window is spent — back in ${back}.` : `${who}'s window is spent.`;
            }
            return back != null
                ? `Running low on ${who} — ${pct}% of the window used, back in ${back}.`
                : `Running low on ${who} — ${pct}% of the window used.`;
        }
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
