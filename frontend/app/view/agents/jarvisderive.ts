// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure derivations for Jarvis (the observe-only manager). buildFleetSnapshot resolves the workers a
// channel dispatched into their current roster state; buildJarvisPrompt turns that snapshot + recent
// timeline into the prompt handed to a headless `claude -p`. No React, no Wave runtime imports.

import type { AgentVM } from "./agentsviewmodel";
import { answeredAskORefs } from "./jarviscards";

export interface WorkerState {
    oref: string; // "tab:<id>"
    name: string; // live roster name (an AI paraphrase), else the dispatch runtime
    state: "working" | "asking" | "idle" | "gone";
    task?: string; // live task (async-filled, may be empty), else the dispatch text
    dispatchTask?: string; // the literal task typed into this channel's dispatch message (ground truth)
    askText?: string; // first pending question, when asking
    askORef?: string; // the worker's current ask oref (when asking), used to drop Jarvis-answered asks
}

const OREF_PREFIX = "tab:";
const MAX_TIMELINE = 12;

// Resolve every worker this channel dispatched/steered to its current state. A dispatched oref with no
// live roster row is "gone" (its terminal exited) and falls back to the dispatch message's runtime +
// task. Dedup by oref (a channel steers the same worker repeatedly).
export function buildFleetSnapshot(channel: Channel, agents: AgentVM[]): WorkerState[] {
    const orefs: string[] = [];
    const dispatchInfo = new Map<string, { name: string; task?: string }>();
    const activeTs = new Map<string, number>(); // latest dispatch/directive ts per oref
    const dismissTs = new Map<string, number>(); // latest dismiss ts per oref
    for (const m of channel.messages ?? []) {
        if (!m.reforef?.startsWith(OREF_PREFIX)) {
            continue;
        }
        if (m.kind === "dispatch" && !dispatchInfo.has(m.reforef)) {
            dispatchInfo.set(m.reforef, { name: m.author, task: m.text || undefined });
        }
        if (m.kind === "dispatch" || m.kind === "directive") {
            if (!orefs.includes(m.reforef)) {
                orefs.push(m.reforef);
            }
            activeTs.set(m.reforef, Math.max(activeTs.get(m.reforef) ?? 0, m.ts ?? 0));
        }
        if (m.kind === "dismiss") {
            dismissTs.set(m.reforef, Math.max(dismissTs.get(m.reforef) ?? 0, m.ts ?? 0));
        }
    }
    return orefs
        .map((oref): WorkerState => {
            const id = oref.slice(OREF_PREFIX.length);
            const dispatchTask = dispatchInfo.get(oref)?.task;
            const live = agents.find((a) => a.id === id);
            if (live) {
                return {
                    oref,
                    name: live.name,
                    state: live.state,
                    task: live.task || undefined,
                    dispatchTask,
                    askText: live.state === "asking" ? live.ask?.questions?.[0]?.question : undefined,
                    askORef: live.state === "asking" ? live.ask?.oref : undefined,
                };
            }
            const info = dispatchInfo.get(oref);
            return { oref, name: info?.name ?? "worker", state: "gone" as const, task: info?.task, dispatchTask };
        })
        // a gone worker dismissed after its last dispatch/directive drops out; a later re-dispatch
        // (newer activeTs) brings it back. live workers are never hidden.
        .filter((w) => w.state !== "gone" || (dismissTs.get(w.oref) ?? 0) <= (activeTs.get(w.oref) ?? 0));
}

// Compose the fleet snapshot + a capped recent timeline into the prompt for `claude -p`. focus is the
// user's optional "@jarvis <focus>" text; empty focus => a general fleet summary.
export function buildJarvisPrompt(snapshot: WorkerState[], channel: Channel, focus: string): string {
    const fleetLines = snapshot.length
        ? snapshot
              .map((w) => {
                  const bits = [`- ${w.name} [${w.state}]`];
                  if (w.task) {
                      bits.push(`task: ${w.task}`);
                  }
                  if (w.askText) {
                      bits.push(`asking: ${w.askText}`);
                  }
                  return bits.join(" — ");
              })
              .join("\n")
        : "(no workers dispatched in this channel)";
    const timeline = (channel.messages ?? [])
        .slice(-MAX_TIMELINE)
        .map((m) => `${m.author}: ${m.text}`)
        .join("\n");
    const task = focus.trim() || "Summarize the current state of this channel's workers.";
    return [
        `You are Jarvis, a concise engineering assistant watching a fleet of coding agents in the "${channel.name}" channel.`,
        `Task: ${task}`,
        `Answer in 2-4 short lines: which workers are up, which are blocked (and on what), which are done. Be specific and terse. Do not invent workers not listed.`,
        ``,
        `Fleet:`,
        fleetLines,
        ``,
        `Recent channel messages:`,
        timeline || "(none)",
    ].join("\n");
}

// the set of ask orefs Jarvis has auto-answered across all channels (drives every "needs you" surface).
export function answeredAskORefsAcross(channels: Channel[]): Set<string> {
    const answered = new Set<string>();
    for (const ch of channels) {
        for (const o of answeredAskORefs(ch.messages ?? [])) {
            answered.add(o);
        }
    }
    return answered;
}

// whether a worker is genuinely blocked on the human: asking, and not already answered by Jarvis.
export function needsHuman(a: AgentVM, answered: Set<string>): boolean {
    return a.state === "asking" && !(a.ask?.oref && answered.has(a.ask.oref));
}

// Fleet-wide count of workers genuinely blocked on the human, deduped against Jarvis-answered asks across
// ALL channels. Single source of truth for the nav-rail badge and the Cockpit "need you" counters.
export function pendingAskCount(channels: Channel[], agents: AgentVM[]): number {
    const answered = answeredAskORefsAcross(channels);
    return agents.filter((a) => needsHuman(a, answered)).length;
}
