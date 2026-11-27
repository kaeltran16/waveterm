// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure decisions behind the Cockpit's sessions: which roster agents are sessions, the state each is in, the runs a
// conductor lists, and whether a run's wait is still its conductor's or has come to the user. The shell store
// (cockpitsessionstore.ts) feeds these from the roster, the runs it loads and the attention list.

import type { AgentEntry, AgentState, AgentVM } from "./agentsviewmodel";
import { samePath } from "./projectoverviewmodel";
import { fmtClock } from "./runcompletion";
import { isTerminal } from "./runmodel";
import type { SubagentVM } from "./session-models/sessionviewmodel";
import { isStandingBy, type ShellTask } from "./shelltasks";

export type SessionState = "asks" | "turn" | "watching" | "working";
export type WaitOwner = "you" | "conductor";
export type WaitWhy = "turn" | "timer" | "exit" | "none";

export interface RunWait {
    runId: string;
    key: string;
    short: string;
    label: string;
    owner: WaitOwner;
    why: WaitWhy | null;
    minutesLeft: number | null;
    conductorName: string | null;
}

export interface CockpitSession {
    agent: AgentVM;
    state: SessionState;
    conductor: boolean;
    runs: Run[];
}

export interface CockpitView {
    sessions: CockpitSession[];
    idle: CockpitSession[];
    orphans: Run[];
    turnCount: number;
    loaded: boolean;
}

// a watching conductor's grace before its run's wait comes to the user
export const WAIT_TIMER_MIN = 5;
export const WAIT_TIMER_MS = WAIT_TIMER_MIN * 60_000;

const MINUTE_MS = 60_000;

// how long a conductor must read gone, without a live read between, before its wait is yours: one poll tick, so a
// conductor whose status has not arrived yet at app start is not taken for exited
export const CONDUCTOR_GONE_GRACE_MS = 10_000;

export function isCockpitSession(agent: AgentVM, hasLineageRole: boolean): boolean {
    return (agent.kind ?? "agent") === "agent" && !agent.runId && !hasLineageRole && !agent.parentTabId;
}

export function sessionState(agent: AgentVM, tasks: ShellTask[], subagents: SubagentVM[]): SessionState {
    if (agent.state === "asking") {
        return "asks";
    }
    if (agent.state === "working" || agent.booting) {
        return "working";
    }
    return isStandingBy(agent.state, tasks, subagents) ? "watching" : "turn";
}

const onYou = (state: SessionState) => state === "asks" || state === "turn";

function startOfDay(now: number): number {
    return new Date(now).setHours(0, 0, 0, 0);
}

// a held land still waits on someone, so it counts as live with a landing in flight
export function isLiveRun(run: Run): boolean {
    if (!isTerminal(run.status)) {
        return true;
    }
    return run.land?.state === "pending" || (run.land?.state === "held" && !run.land.dismissed);
}

function inWindow(run: Run, midnight: number): boolean {
    return isLiveRun(run) || (run.completedts || run.createdts) >= midnight;
}

const newestFirst = (a: Run, b: Run) => b.createdts - a.createdts;

// in memory only: when a session was dismissed (or found quiet), whether it has been prompted since it was first
// seen booting, and the state it was last seen in
export interface SessionSight {
    dismissedAt: number | null;
    prompted: boolean;
    state: AgentState | null;
}

// a session with no sight yet is judged by the first-sight rule, so it does not flash into the grid before the store
// has observed it
export function inIdleLine(agent: AgentVM, sight: SessionSight | undefined): boolean {
    if (sight == null) {
        return agent.state === "idle";
    }
    if (sight.dismissedAt == null) {
        return false;
    }
    return !(agent.state === "idle" && (agent.idleSince ?? 0) > sight.dismissedAt);
}

// A session idle at first sight is quiet, and so is one first seen booting that goes idle before it ever worked:
// both start dismissed. An ask counts as a finished turn, so a session that starts asking leaves the Idle line.
// Returns prev itself when nothing moved, so an unchanged roster does not re-render the view.
export function observeSessions(
    prev: Record<string, SessionSight>,
    agents: AgentVM[],
    now: number
): Record<string, SessionSight> {
    const next = { ...prev };
    let changed = false;
    const put = (id: string, s: SessionSight) => {
        const old = prev[id];
        if (old == null || old.dismissedAt !== s.dismissedAt || old.prompted !== s.prompted || old.state !== s.state) {
            next[id] = s;
            changed = true;
        }
    };
    for (const a of agents) {
        const seen = prev[a.id];
        if (seen == null) {
            put(a.id, { dismissedAt: a.state === "idle" ? now : null, prompted: !a.booting, state: a.state });
            continue;
        }
        const s: SessionSight = { ...seen, state: a.state };
        if (!seen.prompted && a.state === "idle") {
            s.dismissedAt = now;
            s.prompted = true;
        } else if (!seen.prompted && !a.booting) {
            s.prompted = true;
        }
        if (a.state === "asking" && seen.state != null && seen.state !== "asking") {
            s.dismissedAt = null;
        }
        put(a.id, s);
    }
    return changed ? next : prev;
}

export interface CockpitViewInput {
    sessions: { agent: AgentVM; state: SessionState }[];
    // every loaded run, engine children already dropped
    runs: Run[];
    sights: Record<string, SessionSight>;
    loaded: boolean;
    now: number;
}

export function cockpitView(input: CockpitViewInput): CockpitView {
    const midnight = startOfDay(input.now);
    const claimed = new Set<string>();
    const sessions: CockpitSession[] = [];
    const idle: CockpitSession[] = [];
    for (const { agent, state } of input.sessions) {
        const own = input.runs.filter((r) => samePath(agent.transcriptPath, r.origintranscript));
        own.forEach((r) => claimed.add(r.id));
        const session: CockpitSession = {
            agent,
            state,
            conductor: own.length > 0,
            runs: own.filter((r) => inWindow(r, midnight)).sort(newestFirst),
        };
        (inIdleLine(agent, input.sights[agent.id]) ? idle : sessions).push(session);
    }
    const orphans = input.runs.filter((r) => !claimed.has(r.id) && inWindow(r, midnight)).sort(newestFirst);
    return {
        sessions,
        idle,
        orphans,
        turnCount: sessions.filter((s) => onYou(s.state)).length,
        loaded: input.loaded,
    };
}

// what the shell knows of a wait's conductor. unknown: the run is not loaded; checkedAt is when the store last
// started a fetch that would have found it (null before the store has loaded at all). Only a fetch begun strictly
// after the wait opened can say the run has no conductor: one begun the same moment may predate the run.
export type ConductorRead =
    | { kind: "unknown"; checkedAt: number | null }
    | { kind: "none" }
    | { kind: "gone" }
    | { kind: "live"; name: string; state: SessionState };

export function conductorRead(
    run: Run | undefined,
    sessions: { agent: AgentVM; state: SessionState }[],
    checkedAt: number | null
): ConductorRead {
    if (run == null) {
        return { kind: "unknown", checkedAt };
    }
    if (!run.origintranscript) {
        return { kind: "none" };
    }
    const c = sessions.find((s) => samePath(s.agent.transcriptPath, run.origintranscript));
    return c ? { kind: "live", name: c.agent.name, state: c.state } : { kind: "gone" };
}

// One wait's escalation. Watching time accumulates over the spans the conductor was Watching at their start,
// pauses while it works and never resets. Once yours, a wait stays yours.
export interface WaitTrack {
    openedAt: number;
    watchedMs: number;
    lastTs: number;
    yours: boolean;
    why: WaitWhy | null;
    state: SessionState | null;
    conductorName: string | null;
    // when the conductor started reading gone, unbroken since; null while it reads anything else
    goneSince: number | null;
}

// null while pending: the wait is neither the conductor's nor yours yet
export function waitVerdict(
    track: WaitTrack | undefined,
    read: ConductorRead
): { owner: WaitOwner; why: WaitWhy | null; minutesLeft: number | null } | null {
    if (track == null) {
        return null;
    }
    const yours = (why: WaitWhy) => ({ owner: "you" as const, why, minutesLeft: null });
    if (track.yours) {
        return yours(track.why);
    }
    switch (read.kind) {
        case "unknown":
            return read.checkedAt != null && read.checkedAt > track.openedAt ? yours("none") : null;
        case "none":
            return yours("none");
        case "gone":
            return track.goneSince != null && track.lastTs - track.goneSince >= CONDUCTOR_GONE_GRACE_MS
                ? yours("exit")
                : null;
    }
    if (onYou(read.state)) {
        return yours("turn");
    }
    if (read.state !== "watching") {
        return { owner: "conductor", why: null, minutesLeft: null };
    }
    if (track.watchedMs >= WAIT_TIMER_MS) {
        return yours("timer");
    }
    return { owner: "conductor", why: null, minutesLeft: Math.ceil((WAIT_TIMER_MS - track.watchedMs) / MINUTE_MS) };
}

export function stepWait(prev: WaitTrack | undefined, read: ConductorRead, now: number): WaitTrack {
    const t: WaitTrack = prev
        ? { ...prev }
        : {
              openedAt: now,
              watchedMs: 0,
              lastTs: now,
              yours: false,
              why: null,
              state: null,
              conductorName: null,
              goneSince: null,
          };
    if (prev?.state === "watching") {
        t.watchedMs += Math.max(0, now - prev.lastTs);
    }
    t.lastTs = now;
    t.goneSince = read.kind === "gone" ? (prev?.goneSince ?? now) : null;
    t.state = read.kind === "live" ? read.state : null;
    if (read.kind === "live") {
        t.conductorName = read.name;
    }
    const v = waitVerdict(t, read);
    if (!t.yours && v?.owner === "you") {
        t.yours = true;
        t.why = v.why;
    }
    return t;
}

// steps every open wait; a wait no longer open drops out
export function stepEscalation(
    prev: Record<string, WaitTrack>,
    reads: Record<string, ConductorRead>,
    now: number
): Record<string, WaitTrack> {
    const next: Record<string, WaitTrack> = {};
    for (const [key, read] of Object.entries(reads)) {
        next[key] = stepWait(prev[key], read, now);
    }
    return next;
}

const FINAL_FAILED_TEXT = /final stage/i;

export function waitShort(item: AttentionItem, run: Run | undefined): string {
    if (run?.status === "awaiting-review") {
        return "Plan to approve";
    }
    switch (item.kind) {
        case "ask":
        case "escalation":
            return "Asks";
        case "dag-blocked":
            return FINAL_FAILED_TEXT.test(item.text) ? "Final failed" : "Blocked";
        case "run-land-held":
            return "Landing held";
        case "run-unverified":
            return "Unverified";
    }
    return item.action;
}

export function waitLabel(item: AttentionItem): string {
    return item.kind === "ask" || item.kind === "escalation" ? `Asks: ${item.text}` : item.text;
}

export function runWaitOf(
    item: AttentionItem,
    runId: string,
    run: Run | undefined,
    track: WaitTrack | undefined,
    read: ConductorRead
): RunWait | null {
    const v = waitVerdict(track, read);
    if (v == null) {
        return null;
    }
    return {
        runId,
        key: item.key,
        short: waitShort(item, run),
        label: waitLabel(item),
        owner: v.owner,
        why: v.why,
        minutesLeft: v.minutesLeft,
        conductorName: read.kind === "live" ? read.name : (track?.conductorName ?? null),
    };
}

// the popup's second line: why the wait came to you
export function escalationReason(wait: RunWait): string {
    const name = wait.conductorName;
    switch (wait.why) {
        case "timer":
            return `${name} is Watching but didn't pick it up within ${WAIT_TIMER_MIN} min.`;
        case "exit":
            return name
                ? `Its conductor ${name} exited, so it comes to you.`
                : "Its conductor exited, so it comes to you.";
        case "turn":
            return `${name} ended its turn with this still open.`;
    }
    return "This run has no conductor.";
}

// the pane's waiting row: who has the wait and, while the conductor watches, how long until it comes to you
export function waitNote(wait: RunWait): string {
    const name = wait.conductorName ?? "";
    if (wait.owner === "conductor" && wait.minutesLeft != null) {
        return `${name} has it: it is Watching. This comes to you in ${wait.minutesLeft} min if it doesn't act.`;
    }
    if (wait.owner === "conductor") {
        return `${name} has it while it works. No timer runs while it is Working.`;
    }
    switch (wait.why) {
        case "timer":
            return `Waits on you: ${name} didn't pick it up within ${WAIT_TIMER_MIN} min.`;
        case "exit":
            return name ? `Waits on you: its conductor ${name} exited.` : "Waits on you: its conductor exited.";
        case "none":
            return "Waits on you: this run has no conductor.";
    }
    return `Waits on you: ${name} is on your turn, so it can't see this.`;
}

function when(ts: number, now: number): string {
    if (ts >= startOfDay(now)) {
        return fmtClock(ts);
    }
    return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function ended(word: string, run: Run, now: number): string {
    return run.completedts ? `${word} ${when(run.completedts, now)}` : word;
}

// the run line's stage, from the run and, for a dag run, its digest
export function runStage(run: Run, digest: DagStatusDigest | undefined, now: number): string {
    const land = run.land;
    if (land?.state === "held" && !land.dismissed) {
        return "Landing held";
    }
    if (land?.state === "pending") {
        return "Landing";
    }
    switch (run.status) {
        case "done":
            return ended(land?.state === "landed" || land == null ? "Landed" : "Done", run, now);
        case "failed":
            return ended("Failed", run, now);
        case "cancelled":
            return ended("Cancelled", run, now);
        case "planning":
            return "Planning";
        case "awaiting-review":
            return "Plan review passed";
        case "plan-review":
            return "Reviewing plan";
        case "blocked":
            return "Blocked";
    }
    const final = digest?.final;
    if (final?.state === "failed") {
        return final.step ? `Final failed · ${final.step}` : "Final failed";
    }
    if (final != null && final.state !== "passed" && final.state !== "unverified") {
        return final.step ? `Final · ${final.step}` : "Final";
    }
    const counts = digest?.counts;
    if (counts != null && counts.total > 0) {
        return `Task ${Math.min(counts.done + 1, counts.total)} of ${counts.total}`;
    }
    return "Running";
}

export type RunLineTone = "yours" | "conductor" | "live" | "failed" | "done";

export function runLineFace(run: Run, stage: string, wait: RunWait | null): { text: string; tone: RunLineTone } {
    if (wait?.owner === "you") {
        return { text: `${wait.short} · waits on you`, tone: "yours" };
    }
    if (wait?.owner === "conductor") {
        return { text: `${wait.short} · conductor has it`, tone: "conductor" };
    }
    if (run.status === "failed") {
        return { text: stage, tone: "failed" };
    }
    return { text: stage, tone: isLiveRun(run) ? "live" : "done" };
}

const isPrompt = (e: AgentEntry) => e.kind === "user" && !e.queued;

// the thumbnail's cut: from the last user prompt on, at most the newest max rows
export function lastTurnEntries(entries: AgentEntry[], max: number): AgentEntry[] {
    let start = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        if (isPrompt(entries[i])) {
            start = i;
            break;
        }
    }
    const turn = entries.slice(start);
    return turn.slice(Math.max(0, turn.length - max));
}

// the filmstrip's one line: the newest message, action or prompt in the thumbnail's cut
export function lastLine(entries: AgentEntry[]): string {
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.kind === "message" || e.kind === "user") {
            return e.text;
        }
        if (e.kind === "action") {
            return `${e.verb} · ${e.target}`;
        }
    }
    return "";
}
