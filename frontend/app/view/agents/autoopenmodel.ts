// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what the Rendered view opens beside the transcript by itself once the agent's turn ends. A turn can bring
// several things at once (a question, a mockup, a run, a diff), so one opens, by priority, and the rest join the pane
// behind it marked unseen; a pane that already shows something keeps showing it.

import type { AgentActionEntry, AgentEntry } from "./agentsviewmodel";
import { revealedCanvas } from "./renderedbsboardsmodel";
import { actionCommand, finishedStatus, lastCanvasReveal } from "./transcriptlayout";
import { addTab, openTab, tabKey, type WorkspaceState, type WorkspaceTab } from "./workspacemodel";
import { firstWshCall, wshJsonOutput, type WshKey } from "./wshcall";

export type AutoOpenKind = "brainstorm" | "canvas" | "run" | "changes";

// the question blocks the agent, the mockup is what it made for you to look at, the run lasts, and the diff is
// always one click away in the message box
export const AUTO_OPEN_PRIORITY: readonly AutoOpenKind[] = ["brainstorm", "canvas", "run", "changes"];

// id tells one arrival of a kind from the next: the wait or the brainstorm's run, the topic, the run, the agent's last
// edit
export type Arrival = { kind: AutoOpenKind; id: string; tab: WorkspaceTab };

// per agent, for the session: the last id each kind arrived with, the tabs auto-open put in the pane, and the kinds
// the user turned down by closing such a tab
export type AutoOpenMemory = {
    handled: Partial<Record<AutoOpenKind, string>>;
    opened: string[];
    dismissed: AutoOpenKind[];
};

export const EMPTY_MEMORY: AutoOpenMemory = { handled: {}, opened: [], dismissed: [] };

// what the agent has to show now; since is the session's start, so what an agent did before Arc started is history
export type OfferInput = {
    since: number;
    entries: AgentEntry[];
    // the brainstorm's wait key while it asks the user, and the run it started, with its file's path and last write
    brainstorm: { path: string; modifiedMs: number | null; wait: string | null; run: string | null } | null;
    // the canvas attached to the agent, a brainstorm agent's too: its Canvas tab joins the Rendered pane
    canvas: { topic: string; removed: boolean } | null;
    // the agent's last file edit (agent:lasteditts) and whether its checkout has changes
    lastEditMs: number | null;
    hasChanges: boolean;
    // the run the agent leads: its own, so it counts from the lead's first turn, whenever the run started
    leadRun: string | null;
};

export function offers(input: OfferInput): Arrival[] {
    const out: Arrival[] = [];
    const bs = input.brainstorm;
    // the Brainstorm tab shows both: the question, and once the user built it, the run's step
    const bsAt = bs?.wait != null ? `#${bs.wait}` : bs?.run != null ? `#run:${bs.run}` : null;
    if (bsAt != null && (bs.modifiedMs ?? 0) > input.since) {
        out.push({ kind: "brainstorm", id: `${bs.path}${bsAt}`, tab: { kind: "brainstorm" } });
    }
    const reveal = lastCanvasReveal(input.entries);
    const topic = reveal != null && (reveal.ts ?? 0) > input.since ? revealedCanvas(callArg(reveal))?.topic : null;
    if (topic != null && input.canvas != null && !input.canvas.removed && input.canvas.topic === topic) {
        out.push({ kind: "canvas", id: topic, tab: { kind: "canvas" } });
    }
    const start = lastCall(input.entries, "runs-start");
    const started = start != null && (start.ts ?? 0) > input.since ? startedRun(start) : null;
    // a quick run's agent has its own row in the tree and its transcript is the run, so it opens no Run tab here
    const runId = input.leadRun ?? (started != null && started.mode !== QUICK_MODE ? started.id : null);
    if (runId != null) {
        out.push({ kind: "run", id: runId, tab: { kind: "run", runId, view: "tasks" } });
    }
    // a lead's checkout is its run's tree, so its diff is the workers' work, which the run tab already shows
    const ownDiff = input.leadRun == null;
    if (ownDiff && input.hasChanges && input.lastEditMs != null && input.lastEditMs > input.since) {
        out.push({ kind: "changes", id: `${input.lastEditMs}`, tab: { kind: "changes", selected: null } });
    }
    return out;
}

// the offers not yet handled nor turned down, highest priority first
export function arrivals(offered: Arrival[], memory: AutoOpenMemory): Arrival[] {
    return offered
        .filter((a) => memory.handled[a.kind] !== a.id && !memory.dismissed.includes(a.kind))
        .sort((a, b) => AUTO_OPEN_PRIORITY.indexOf(a.kind) - AUTO_OPEN_PRIORITY.indexOf(b.kind));
}

// the winner opens a pane that has no tabs, else joins behind; a losing Changes adds no tab, since the message box's
// files row already carries the diff
export function applyArrivals(ws: WorkspaceState, arrived: Arrival[]): WorkspaceState {
    if (arrived.length === 0) {
        return ws;
    }
    const [winner, ...rest] = arrived;
    let s = ws.tabs.length === 0 ? openTab(ws, winner.tab) : addTab(ws, winner.tab);
    for (const a of rest) {
        if (a.kind !== "changes") {
            s = addTab(s, a.tab);
        }
    }
    return s;
}

// every arrival is handled, the losers included, so none comes back on the next turn
export function remember(memory: AutoOpenMemory, arrived: Arrival[], ws: WorkspaceState): AutoOpenMemory {
    const handled = { ...memory.handled };
    for (const a of arrived) {
        handled[a.kind] = a.id;
    }
    const keys = arrived.map((a) => tabKey(a.tab)).filter((k) => ws.tabs.some((t) => tabKey(t) === k));
    return { ...memory, handled, opened: [...new Set([...memory.opened, ...keys])] };
}

// closing a tab auto-open put there turns that kind down for the session; any other close changes nothing
export function dismissed(memory: AutoOpenMemory, tab: WorkspaceTab): AutoOpenMemory {
    const kind = autoOpenKind(tab);
    if (kind == null || !memory.opened.includes(tabKey(tab)) || memory.dismissed.includes(kind)) {
        return memory;
    }
    return { ...memory, dismissed: [...memory.dismissed, kind] };
}

function autoOpenKind(tab: WorkspaceTab): AutoOpenKind | null {
    return tab.kind === "file" ||
        tab.kind === "board" ||
        tab.kind === "docs" ||
        tab.kind === "initiative" ||
        tab.kind === "task" ||
        tab.kind === "final"
        ? null
        : tab.kind;
}

// mirrors jarvis.RunMode_Quick
const QUICK_MODE = "quick";

// the run a `wsh runs start` created and its mode: its --json, else its "started run <id> (<mode>, <status>) ..."
// line. The mode is the one the server resolved, so an unset --mode reads as the quick run it became.
export function startedRun(a: AgentActionEntry): { id: string; mode?: string } | null {
    const output = a.detail?.kind === "bash" ? a.detail.output : undefined;
    const exit = a.detail?.kind === "bash" ? a.detail.exit : undefined;
    const json = wshJsonOutput<{ id?: string; mode?: string }>(actionCommand(a), output, exit);
    if (json?.id) {
        return { id: json.id, mode: json.mode };
    }
    const line = /^started run (\S+)(?: \(([^,)]+))?/m.exec(output ?? "");
    return line ? { id: line[1], mode: line[2] } : null;
}

function callArg(a: AgentActionEntry): string | undefined {
    return firstWshCall(actionCommand(a))?.call.args[0];
}

function lastCall(entries: AgentEntry[], key: WshKey): AgentActionEntry | null {
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.kind === "action" && !e.pending && finishedStatus(e) === "ok") {
            if (firstWshCall(actionCommand(e))?.key === key) {
                return e;
            }
        }
    }
    return null;
}
