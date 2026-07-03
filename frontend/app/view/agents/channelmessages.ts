// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Runtime } from "./launch";

const RUNTIMES: Runtime[] = ["claude", "codex", "antigravity", "terminal"];

export type DispatchMode = "report" | "manage" | "fanout";

export interface ParsedMentions {
    mentions: string[];
    body: string;
}

export function parseMentions(text: string): ParsedMentions {
    const mentions: string[] = [];
    let rest = text.trimStart();
    const re = /^@([\w./-]+)\s+/;
    let m = re.exec(rest);
    while (m) {
        mentions.push(m[1].toLowerCase());
        rest = rest.slice(m[0].length);
        m = re.exec(rest);
    }
    return { mentions, body: rest };
}

export interface RosterEntry {
    id: string;
    name: string;
    blockId?: string;
}

export type MessagePlan =
    | { kind: "dispatch"; runtime: Runtime; text: string }
    | { kind: "steer"; targetId: string; blockId?: string; text: string }
    | { kind: "consult"; runtimes: Runtime[]; text: string }
    | { kind: "jarvis"; text: string; mode?: DispatchMode }
    | { kind: "post"; text: string };

export function planMessage(text: string, roster: RosterEntry[]): MessagePlan {
    const trimmed = text.trimStart();
    // @jarvis (reserved manager handle): observe-only fleet summary. Matched with a dedicated regex so a
    // bare "@jarvis" is caught (parseMentions requires a trailing space) and so it always beats a roster
    // worker that happens to be named "jarvis".
    const jarvisMatch = /^@jarvis(?::(report|manage|fanout))?\b\s*([\s\S]*)$/i.exec(trimmed);
    if (jarvisMatch) {
        const mode = jarvisMatch[1] ? (jarvisMatch[1].toLowerCase() as DispatchMode) : undefined;
        return { kind: "jarvis", text: jarvisMatch[2].trim(), mode };
    }
    const askMatch = /^ask\s+/i.exec(trimmed);
    if (askMatch) {
        const { mentions, body } = parseMentions(trimmed.slice(askMatch[0].length));
        const runtimes = mentions.filter((m): m is Runtime => (RUNTIMES as string[]).includes(m));
        if (runtimes.length > 0) {
            return { kind: "consult", runtimes, text: body };
        }
        // "ask" with no known runtime -> not a consult; fall through to a plain post of the original text
    }
    const { mentions, body } = parseMentions(text);
    const first = mentions[0];
    if (first && (RUNTIMES as string[]).includes(first)) {
        return { kind: "dispatch", runtime: first as Runtime, text: body };
    }
    if (first) {
        const target = roster.find((r) => r.name.toLowerCase() === first);
        if (target) {
            return { kind: "steer", targetId: target.id, blockId: target.blockId, text: body };
        }
    }
    return { kind: "post", text };
}

export type JarvisTier = "concierge" | "gatekeeper" | "delegator";

// tierFromMeta reads the nested autonomy tier from a channel's meta booleans (delegator ⇒ gatekeeper).
export function tierFromMeta(meta: Record<string, unknown> | undefined): JarvisTier {
    if (meta?.["delegator:enabled"]) {
        return "delegator";
    }
    if (meta?.["gatekeeper:enabled"]) {
        return "gatekeeper";
    }
    return "concierge";
}

export type DelegatePlan = { action: "summary" } | { action: "dispatch"; task: string; mode: DispatchMode };

// planDelegate decides whether an @jarvis message in this channel is an observe-only summary or a
// worker dispatch. Only a delegator-tier channel with a non-empty goal dispatches. Report launches the
// plain goal (one bounded pass); Manage/Fan-out wrap it in /goal (loop to completion). Fan-out has no
// decompose backend yet (v1), so it degrades to a single /goal dispatch.
export function planDelegate(args: {
    tier: JarvisTier;
    defaultMode: DispatchMode;
    override?: DispatchMode;
    goal: string;
}): DelegatePlan {
    const goal = args.goal.trim();
    if (args.tier !== "delegator" || goal === "") {
        return { action: "summary" };
    }
    const mode = args.override ?? args.defaultMode;
    const task = mode === "report" ? goal : `/goal ${goal}`;
    return { action: "dispatch", task, mode };
}

export interface PlanChip {
    label: string;
    tone: "warn" | "neutral";
}

// describePlan renders a MessagePlan as a pre-send chip so the composer can show what Send will do
// before it does it. warn marks the side-effectful verbs (spawning a worker); plain posts get no chip.
// Pure composition of planMessage's output + planDelegate — no routing logic is duplicated here.
export function describePlan(
    plan: MessagePlan,
    ctx: { tier: JarvisTier; projectName: string; roster: RosterEntry[]; delegatorMode: DispatchMode }
): PlanChip | null {
    switch (plan.kind) {
        case "dispatch":
            return { label: `→ spawns a worker in ${ctx.projectName}`, tone: "warn" };
        case "consult":
            return { label: `→ one-shot review · ${plan.runtimes.join(", ")}`, tone: "neutral" };
        case "steer": {
            const name = ctx.roster.find((r) => r.id === plan.targetId)?.name ?? "worker";
            return { label: `→ steers ${name}`, tone: "neutral" };
        }
        case "jarvis": {
            const del = planDelegate({
                tier: ctx.tier,
                defaultMode: ctx.delegatorMode,
                override: plan.mode,
                goal: plan.text,
            });
            return del.action === "dispatch"
                ? { label: "→ Jarvis dispatches a worker", tone: "warn" }
                : { label: "→ asks Jarvis", tone: "neutral" };
        }
        default:
            return null;
    }
}