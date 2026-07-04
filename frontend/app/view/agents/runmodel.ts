// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure derivations for the Channels Runs view: map a Run/RunPhase (backend types, mirrored via WOS)
// to the view's status pills, phase-node states, the current/gated phase, and the per-channel default
// view + run selection. No React, no jotai — unit-tested in runmodel.test.ts.

import type { AgentVM } from "./agentsviewmodel";

export type RunStatusTone = "planning" | "review" | "running" | "blocked" | "done" | "failed" | "cancelled";

export function runStatusView(status: string): { label: string; tone: RunStatusTone } {
    switch (status) {
        case "planning":
            return { label: "planning", tone: "planning" };
        case "awaiting-review":
            return { label: "awaiting review", tone: "review" };
        case "executing":
            return { label: "executing", tone: "running" };
        case "blocked":
            return { label: "blocked", tone: "blocked" };
        case "done":
            return { label: "done", tone: "done" };
        case "failed":
            return { label: "failed", tone: "failed" };
        case "cancelled":
            return { label: "cancelled", tone: "cancelled" };
        default:
            return { label: status, tone: "planning" };
    }
}

export type PhaseTone = "pending" | "running" | "blocked" | "done" | "failed" | "skipped";

export function phaseStateView(state: string): { icon: string; label: string; tone: PhaseTone } {
    switch (state) {
        case "running":
            return { icon: "●", label: "running", tone: "running" };
        case "done":
            return { icon: "✓", label: "done", tone: "done" };
        case "blocked":
            return { icon: "!", label: "blocked", tone: "blocked" };
        case "failed":
            return { icon: "✕", label: "failed", tone: "failed" };
        case "skipped":
            return { icon: "–", label: "skipped", tone: "skipped" };
        default:
            return { icon: "○", label: "pending", tone: "pending" };
    }
}

// The gated phase awaiting approval — non-null only when the run is paused at a review gate. The engine
// halts after a gated phase completes (that phase is `done`, its successor still `pending`).
export function reviewGate(run: Run): { phaseIdx: number } | null {
    if (run.status !== "awaiting-review") {
        return null;
    }
    const phases = run.phases ?? [];
    // orchestrator: a held running phase resumes in place
    for (let i = 0; i < phases.length; i++) {
        if (phases[i].state === "running" && phases[i].held) {
            return { phaseIdx: i };
        }
    }
    // pipeline: a completed gate whose successor is still pending (or absent)
    for (let i = 0; i < phases.length; i++) {
        if (phases[i].gate && phases[i].state === "done") {
            const next = phases[i + 1];
            if (!next || next.state === "pending") {
                return { phaseIdx: i };
            }
        }
    }
    return null;
}

export function isOrchestrator(run: Run): boolean {
    return run.mode === "orchestrator";
}

// One-line summary of what "Start run" will do, shown under the composer.
export function composerSummary(mode: string, planGate: boolean): string {
    if (mode === "orchestrator") {
        return planGate ? "orchestrator · plan gate on" : "orchestrator · hands-off";
    }
    return "pipeline · Superpowers default";
}

// The phase the view focuses: the first running/blocked phase, else the gated phase awaiting review,
// else the last non-skipped phase.
export function currentPhaseIndex(run: Run): number {
    const phases = run.phases ?? [];
    const active = phases.findIndex((p) => p.state === "running" || p.state === "blocked");
    if (active >= 0) {
        return active;
    }
    const gate = reviewGate(run);
    if (gate) {
        return gate.phaseIdx;
    }
    for (let i = phases.length - 1; i >= 0; i--) {
        if (phases[i].state !== "skipped") {
            return i;
        }
    }
    return Math.max(0, phases.length - 1);
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

export function isTerminal(status: string): boolean {
    return TERMINAL.has(status);
}

export function defaultView(channel: Channel | null): "runs" | "chat" {
    return (channel?.runs?.length ?? 0) > 0 ? "runs" : "chat";
}

// Most-recent non-terminal run (so the user lands on live work), else the most-recent run.
export function defaultRunId(runs: Run[] | undefined): string | undefined {
    const list = runs ?? [];
    if (list.length === 0) {
        return undefined;
    }
    const sorted = [...list].sort((a, b) => b.createdts - a.createdts);
    const active = sorted.find((r) => !isTerminal(r.status));
    return (active ?? sorted[0]).id;
}

export function phaseWorkers(phase: RunPhase, agents: AgentVM[]): AgentVM[] {
    const out: AgentVM[] = [];
    for (const oref of phase.workerorefs ?? []) {
        if (!oref.startsWith("tab:")) {
            continue;
        }
        const found = agents.find((a) => a.id === oref.slice(4));
        if (found) {
            out.push(found);
        }
    }
    return out;
}

export interface PhaseThread {
    showAsk: boolean;
    askKind: "clarify" | "fork" | null;
    askAgent?: AgentVM;
    showBoundary: boolean;
    showWorkers: boolean;
    showGate: boolean;
    showStarting: boolean;
    showBlocked: boolean;
    showShip: boolean;
}

// The recorded worker tab ids for a phase (the "tab:" orefs, unprefixed).
function recordedWorkerTabs(phase: RunPhase): string[] {
    return (phase.workerorefs ?? []).filter((o) => o.startsWith("tab:")).map((o) => o.slice(4));
}

// Which threaded elements a phase renders. Ask (live worker awaiting the human) is a clarify on a
// brainstorm phase, a fork otherwise, and it suppresses the plain worker rows. A recorded worker with no
// status-bearing roster row is either *starting* (its tab still exists — spawned, not yet reported) or
// *gone* (its tab no longer exists → the "worker exited" blocked card). liveTabIds is the set of tab ids
// that currently exist as sessions (roster + plain terminals); pass it to make that distinction — without
// it, a recorded-but-unreported worker reads as gone. Ship = the last phase done on a finished run.
export function phaseThread(run: Run, idx: number, agents: AgentVM[], liveTabIds?: Set<string>): PhaseThread {
    const phases = run.phases ?? [];
    const phase = phases[idx];
    const workers = phaseWorkers(phase, agents);
    const asker = workers.find((w) => w.state === "asking");
    const startedFresh = phase.state !== "pending" && phase.state !== "skipped";
    const recorded = recordedWorkerTabs(phase);
    const unreported = recorded.length > 0 && workers.length === 0;
    const starting = unreported && liveTabIds != null && recorded.some((id) => liveTabIds.has(id));
    const recordedButGone = unreported && !starting;
    return {
        showAsk: !!asker,
        askKind: asker ? (phase.kind === "brainstorm" ? "clarify" : "fork") : null,
        askAgent: asker,
        showBoundary: !!phase.freshctx && startedFresh,
        showWorkers: phase.state === "running" && workers.length > 0 && !asker,
        showGate: reviewGate(run)?.phaseIdx === idx,
        showStarting: phase.state === "running" && starting,
        showBlocked: phase.state === "blocked" || (phase.state === "running" && recordedButGone),
        showShip: idx === phases.length - 1 && phase.state === "done" && run.status === "done",
    };
}
