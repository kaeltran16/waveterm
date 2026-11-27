// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The shell's side of the Cockpit's sessions, kept by the always-mounted AttentionPoller so it holds while the
// Cockpit is unmounted: every channel's runs, each run wait's escalation, the in-memory dismissals and the zoomed
// session. The rule itself is cockpitsessionmodel.ts; the popup and the taskbar flash read outwardAttentionAtomFor,
// so a run's wait reaches them only once it is the user's.

import { isEngineChild } from "@/app/cockpit/palette-data";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import type { OutwardItem } from "./attentionpopup";
import { attentionAtom } from "./attentionstore";
import { asksUser, brainstormAttention } from "./brainstormmodel";
import { brainstormsAtom, brainstormWaitOf } from "./brainstormstore";
import { knownRunVersions, mergeRunChanges } from "./channelruns";
import {
    cockpitView,
    conductorRead,
    escalationReason,
    isCockpitSession,
    observeSessions,
    runWaitOf,
    sessionState,
    stepEscalation,
    waitVerdict,
    type CockpitView,
    type ConductorRead,
    type RunWait,
    type SessionSight,
    type SessionState,
    type WaitTrack,
} from "./cockpitsessionmodel";
import { shellTasksByIdAtom } from "./shelltasksstore";
import { subagentsByIdAtom } from "./subagentsstore";

// Runs by channel, every run the server sent (engine children too, so a refresh sends only changed rows). fetchedAt is
// when the newest completed fetch of a channel began, loadedAt when the newest full refresh began (null before the
// first). A refresh replaces only the channels it fetched, so a channel seeded here and never listed survives it.
export interface CockpitRuns {
    byChannel: Record<string, Run[]>;
    fetchedAt: Record<string, number>;
    loadedAt: number | null;
}

export const cockpitRunsAtom = atom<CockpitRuns>({
    byChannel: {},
    fetchedAt: {},
    loadedAt: null,
}) as PrimitiveAtom<CockpitRuns>;
// keyed by the attention item's key
export const escalationStateAtom = atom<Record<string, WaitTrack>>({}) as PrimitiveAtom<Record<string, WaitTrack>>;
export const sessionSightAtom = atom<Record<string, SessionSight>>({}) as PrimitiveAtom<Record<string, SessionSight>>;
export const cockpitZoomAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
// the model the shell steps, so a per-run read needs no model of its own
const steppedModelAtom = atom<AgentsViewModel | null>(null) as PrimitiveAtom<AgentsViewModel | null>;

interface RunIndex {
    // every loaded run but the engine's children
    runs: Run[];
    // a run by its id, and an engine child's id to the run that leads its dag
    byId: Map<string, Run>;
}

const runIndexAtom: Atom<RunIndex> = atom((get) => {
    const runs: Run[] = [];
    const byId = new Map<string, Run>();
    for (const list of Object.values(get(cockpitRunsAtom).byChannel)) {
        const leads = new Map<string, Run>();
        for (const r of list) {
            if (!isEngineChild(r)) {
                runs.push(r);
                byId.set(r.id, r);
                if (r.dagoref) {
                    leads.set(r.dagoref, r);
                }
            }
        }
        for (const r of list) {
            const lead = r.dagoref ? leads.get(r.dagoref) : undefined;
            if (isEngineChild(r) && lead != null) {
                byId.set(r.id, lead);
            }
        }
    }
    return { runs, byId };
});

function perModel<T>(build: (model: AgentsViewModel) => Atom<T>): (model: AgentsViewModel) => Atom<T> {
    const cache = new WeakMap<AgentsViewModel, Atom<T>>();
    return (model) => {
        let a = cache.get(model);
        if (a == null) {
            a = build(model);
            cache.set(model, a);
        }
        return a;
    };
}

export interface SessionRow {
    agent: AgentVM;
    state: SessionState;
}

// every live session in roster order, dismissed ones included: a dismissed conductor still sees its runs
export const sessionsAtomFor = perModel<SessionRow[]>((model) =>
    atom((get) => {
        const roles = get(model.lineageAtom).roles;
        const tasks = get(shellTasksByIdAtom);
        const subs = get(subagentsByIdAtom);
        return get(model.agentsAtom)
            .filter((a) => isCockpitSession(a, roles[a.id] != null))
            .map((agent) => ({ agent, state: sessionState(agent, tasks[agent.id] ?? [], subs[agent.id] ?? []) }));
    })
);

// a workflow scan names a run but waits on its own agent, not on the run
function isRunWait(item: AttentionItem): boolean {
    return !!item.runid && item.kind !== "workflow-scan";
}

export interface WaitEntry {
    item: AttentionItem;
    runId: string;
    run: Run | undefined;
    read: ConductorRead;
}

export const waitEntriesAtomFor = perModel<WaitEntry[]>((model) =>
    atom((get) => {
        const sessions = get(sessionsAtomFor(model));
        const { byId } = get(runIndexAtom);
        const { fetchedAt, loadedAt } = get(cockpitRunsAtom);
        return get(attentionAtom)
            .filter(isRunWait)
            .map((item) => {
                const run = byId.get(item.runid);
                const checkedAt =
                    loadedAt == null ? null : item.channelid ? (fetchedAt[item.channelid] ?? null) : loadedAt;
                return { item, runId: run?.id ?? item.runid, run, read: conductorRead(run, sessions, checkedAt) };
            });
    })
);

// each run wait with its verdict; wait is null while pending
const waitsAtomFor = perModel<{ item: AttentionItem; wait: RunWait | null }[]>((model) =>
    atom((get) => {
        const tracks = get(escalationStateAtom);
        return get(waitEntriesAtomFor(model)).map((e) => ({
            item: e.item,
            wait: runWaitOf(e.item, e.runId, e.run, tracks[e.item.key], e.read),
        }));
    })
);

export const cockpitViewAtomFor = perModel<CockpitView>((model) =>
    atom((get) =>
        cockpitView({
            sessions: get(sessionsAtomFor(model)),
            runs: get(runIndexAtom).runs,
            sights: get(sessionSightAtom),
            loaded: get(cockpitRunsAtom).loadedAt != null,
            now: get(model.structuralNowAtom),
        })
    )
);

const runWaitAtoms = new Map<string, Atom<RunWait | null>>();

// the run's most urgent open wait: one that is yours before one the conductor has, then the server's rank
export function runWaitAtom(runId: string): Atom<RunWait | null> {
    let a = runWaitAtoms.get(runId);
    if (a == null) {
        a = atom((get) => {
            const model = get(steppedModelAtom);
            if (model == null) {
                return null;
            }
            const waits = get(waitsAtomFor(model))
                .map((w) => w.wait)
                .filter((w) => w?.runId === runId);
            return waits.find((w) => w.owner === "you") ?? waits[0] ?? null;
        });
        runWaitAtoms.set(runId, a);
    }
    return a;
}

// the un-overlaid roster: the overlay already reads an asking brainstorm as "asking", which asksUser would refuse
const brainstormItemsAtomFor = perModel<AttentionItem[]>((model) =>
    atom((get) => {
        const brainstorms = get(brainstormsAtom);
        const items: AttentionItem[] = [];
        for (const agent of get(model.baseRosterAtom)) {
            const b = brainstorms[agent.id];
            const wait = brainstormWaitOf(b, agent);
            if (wait != null && asksUser(wait, agent)) {
                items.push(brainstormAttention({ agentId: agent.id, agentName: agent.name, topic: b.topic }, wait));
            }
        }
        return items;
    })
);

// Server items first, so their rank wins, then brainstorms. A run's wait is in it only once it is the user's, so it
// enters the list, and pops and flashes, exactly once: when it escalates.
export const outwardAttentionAtomFor = perModel<OutwardItem[]>((model) =>
    atom((get) => {
        const yours = new Map<string, RunWait>();
        for (const { item, wait } of get(waitsAtomFor(model))) {
            if (wait?.owner === "you") {
                yours.set(item.key, wait);
            }
        }
        const server = get(attentionAtom).flatMap((i): OutwardItem[] => {
            if (!isRunWait(i)) {
                return [i];
            }
            const wait = yours.get(i.key);
            return wait ? [{ ...i, escalated: escalationReason(wait) }] : [];
        });
        return [...server, ...get(brainstormItemsAtomFor(model))];
    })
);

function setSight(agentId: string, dismissedAt: number | null): void {
    globalStore.set(sessionSightAtom, (prev) => ({
        ...prev,
        [agentId]: { prompted: true, state: null, ...prev[agentId], dismissedAt },
    }));
}

export function dismissSession(agentId: string): void {
    setSight(agentId, Date.now());
}

export function undismissSession(agentId: string): void {
    setSight(agentId, null);
}

const inFlight = new Map<string, Promise<void>>();

// one channel's runs by difference; a failure keeps what the channel had
export function fetchChannelRuns(channelId: string): Promise<void> {
    const running = inFlight.get(channelId);
    if (running != null) {
        return running;
    }
    const load = (async () => {
        const startedAt = Date.now();
        const held = globalStore.get(cockpitRunsAtom).byChannel[channelId] ?? [];
        try {
            const rtn = await RpcApi.GetChannelRunChangesCommand(TabRpcClient, {
                channelid: channelId,
                known: knownRunVersions(held),
            });
            globalStore.set(cockpitRunsAtom, (prev) => ({
                ...prev,
                byChannel: {
                    ...prev.byChannel,
                    [channelId]: mergeRunChanges(prev.byChannel[channelId] ?? [], rtn.runids ?? [], rtn.runs ?? []),
                },
                fetchedAt: { ...prev.fetchedAt, [channelId]: startedAt },
            }));
        } catch (err) {
            console.warn(`cockpit: loading runs failed for channel ${channelId}`, err);
        }
    })().finally(() => inFlight.delete(channelId));
    inFlight.set(channelId, load);
    return load;
}

// every listed channel's runs; a failed channel list changes nothing
export async function refreshCockpitRuns(): Promise<void> {
    const startedAt = Date.now();
    let channels: Channel[];
    try {
        channels = (await RpcApi.GetChannelsCommand(TabRpcClient)).channels ?? [];
    } catch (err) {
        console.warn("cockpit: loading the channel list failed", err);
        return;
    }
    await Promise.all(channels.map((c) => fetchChannelRuns(c.oid)));
    globalStore.set(cockpitRunsAtom, (prev) => ({ ...prev, loadedAt: startedAt }));
}

// One step of the shell: sessions observed (quiet ones dismissed), every open run wait's escalation advanced, and the
// channel of each wait whose run is not loaded fetched at once, so the wait is decided after that fetch.
export function stepCockpit(model: AgentsViewModel, now: number = Date.now()): void {
    if (globalStore.get(steppedModelAtom) !== model) {
        globalStore.set(steppedModelAtom, model);
    }
    const sessions = globalStore.get(sessionsAtomFor(model));
    globalStore.set(sessionSightAtom, (prev) =>
        observeSessions(
            prev,
            sessions.map((s) => s.agent),
            now
        )
    );
    const entries = globalStore.get(waitEntriesAtomFor(model));
    const tracks = stepEscalation(
        globalStore.get(escalationStateAtom),
        Object.fromEntries(entries.map((e) => [e.item.key, e.read])),
        now
    );
    globalStore.set(escalationStateAtom, tracks);
    for (const e of entries) {
        if (e.read.kind === "unknown" && e.item.channelid && waitVerdict(tracks[e.item.key], e.read) == null) {
            void fetchChannelRuns(e.item.channelid);
        }
    }
}
