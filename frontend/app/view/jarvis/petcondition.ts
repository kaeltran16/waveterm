// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What Jarvis's condition is: one expression and one posture, from signals the rest of the app already
// computes. Pure — no atoms, no pixels, no React. That separation is what makes petview.tsx a swappable
// renderer rather than the thing that decides (design §5).
//
// The precedence is strict and lives here and nowhere else (design §3):
//   1 link lost — while it holds, every other reading on screen is stale, the other two faults included.
//   2 run held — work you started cannot finish without you.
//   3 tired — the rate-limit window depleting. Cyclical, not your fault, and it fixes itself.
// Nothing present => at-rest.
//
// Every input field is optional, and an absent field is "no signal" — never "signal absent". That
// distinction is load-bearing rather than pedantic: a source that has not answered yet cannot present here
// as a clean bill of health.

import { formatReset, usageLevel } from "@/app/view/agents/agentsviewmodel";
import { providerLabel } from "@/app/view/agents/cockpitrailmodel";

export interface PetSignals {
    // rank 1: present only once wslink.linkLostSince is non-null, so a reconnect blip or a boot that never
    // connected never reaches here. `lostAt` is epoch ms of the drop.
    link?: { lostAt: number };
    // rank 2: the first held land in attention rank order (heldLandFrom)
    heldLand?: { runName: string; reason: string };
    // rank 3: highest 5-hour utilisation across providers (0..100). `resetAt` is epoch SECONDS, matching
    // AgentUsage.fivehourreset and formatReset — the whole cockpit carries this window in seconds.
    // `provider` is required because the reading is per-provider and the highest wins: unnamed, a codex
    // window reads as a claude one, and the countdown belongs to whichever provider won.
    rateLimit?: { provider: string; pct: number; resetAt?: number };
    // posture: kinds only. The creature never renders a count — the nav badge owns that (design §3).
    attention?: { reviewGates: number; escalations: number; blockedWorkers: number };
}

export type PetExpression =
    | { kind: "link-lost"; lostAt: number }
    | { kind: "run-held"; runName: string; reason: string }
    | { kind: "tired"; provider: string; pct: number; resetAt?: number }
    | { kind: "at-rest" };

export type PetPosture = "review-gate" | "escalation" | "blocked-worker" | "none";

// The rank of each expression, exported so the precedence is assertable rather than inferred from the
// order of ifs below.
export const EXPRESSION_RANK: Record<PetExpression["kind"], number> = {
    "link-lost": 1,
    "run-held": 2,
    tired: 3,
    "at-rest": 4,
};

const ATTENTION_LAND_HELD = "run-land-held";

// Held lands only: an unverified run is common enough that the avatar would sit red most of the day, so
// run-unverified stays a peek row and never becomes this fault.
export function heldLandFrom(items: AttentionItem[]): PetSignals["heldLand"] {
    const item = (items ?? []).find((i) => i.kind === ATTENTION_LAND_HELD);
    return item != null ? { runName: item.source, reason: item.reason ?? "" } : undefined;
}

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
    if (signals.link != null) {
        out.push({ kind: "link-lost", lostAt: signals.link.lostAt });
    }
    if (signals.heldLand != null) {
        out.push({ kind: "run-held", runName: signals.heldLand.runName, reason: signals.heldLand.reason });
    }
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
        case "link-lost":
            return `I can't reach the backend — nothing here has updated since ${clockTime(expr.lostAt)}.`;
        case "run-held": {
            // the reason is the raw hold reason: it can be empty, or already a sentence with its own period
            const reason = expr.reason.trim().replace(/\.+$/, "");
            return reason === "" ? `${expr.runName} can't land.` : `${expr.runName} can't land — ${reason}.`;
        }
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

// local 24h HH:MM, the clock the user reads the rest of the cockpit by
function clockTime(epochMs: number): string {
    const d = new Date(epochMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
