// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Load each agent's disk-backed subagents into subagentsByIdAtom, and its background shell tasks into
// shellTasksByIdAtom: refresh on enter and when its transcript path changes, debounce on parent transcript
// activity, drop on leave. Shell tasks are also read at once when an agent turns idle: its finish is held
// until that read lands. The shell (cockpitshell AgentStreams) runs it over the roster on every surface.
// Safe to mount in more than one place at once: the refreshes are seq-guarded and the drops only clear ids
// this caller tracked.

import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import type { AgentState } from "./agentsviewmodel";
import { lastActivityByIdAtom } from "./livetranscript";
import {
    dropShellTasks,
    refreshShellTasks,
    scheduleShellTasks,
    SHELL_POLL_MS,
    shellTaskPollIds,
    shellTasksByIdAtom,
} from "./shelltasksstore";
import { dropSubagents, refreshSubagents, scheduleSubagents } from "./subagentsstore";

type Trackable = { id: string; transcriptPath?: string; state?: AgentState; idleSince?: number };

// an idle episode is keyed by its idleSince, so each Stop is read once
const idleEpisode = (a: Trackable): string => (a.state === "idle" ? `idle:${a.idleSince ?? ""}` : "");

// pure: the ids to read on entering tracking: new ids, and tracked ids whose transcript path changed (a launch
// whose path arrives after it entered)
export function enterRefreshes(tracked: Map<string, string | undefined>, agents: Trackable[]): string[] {
    return agents.filter((a) => !tracked.has(a.id) || tracked.get(a.id) !== a.transcriptPath).map((a) => a.id);
}

// pure: the ids whose activity stamp moved since last seen (a first-seen stamp counts), and the stamps to remember
// for the tracked ids. Only these re-arm their debounce: scheduling every stamped id let one agent's chunks
// reset every other agent's 4 s debounce, so no other agent's chips refreshed while any agent kept chunking.
export function advancedActivity(
    seen: ReadonlyMap<string, number>,
    activity: Record<string, number>,
    ids: string[]
): { advanced: string[]; seen: Map<string, number> } {
    const advanced: string[] = [];
    const next = new Map<string, number>();
    for (const id of ids) {
        const ts = activity[id];
        if (ts == null) {
            continue;
        }
        if (seen.get(id) !== ts) {
            advanced.push(id);
        }
        next.set(id, ts);
    }
    return { advanced, seen: next };
}

export function useSubagentTracking(agents: Trackable[]): void {
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const shellTasks = useAtomValue(shellTasksByIdAtom);
    const trackedRef = useRef<Map<string, string | undefined>>(new Map());
    const agentsRef = useRef(agents);
    agentsRef.current = agents;
    const idleRef = useRef<Map<string, string>>(new Map());
    const seenActivityRef = useRef<Map<string, number>>(new Map());
    // read at write time, not at schedule time: a debounced read lands up to 4 s after it was armed
    const currentAgent = (id: string) => agentsRef.current.find((a) => a.id === id);
    const enterKey = agents.map((a) => `${a.id}=${a.transcriptPath ?? ""}`).join(",");
    const idleKey = agents.map((a) => `${a.id}=${idleEpisode(a)}`).join(",");
    const pollKey = shellTaskPollIds(
        agents.map((a) => a.id),
        shellTasks
    ).join(",");
    useEffect(() => {
        const byId = new Map(agents.map((a) => [a.id, a]));
        for (const id of enterRefreshes(trackedRef.current, agents)) {
            const a = byId.get(id)!;
            void refreshSubagents(a.id, a.transcriptPath);
            void refreshShellTasks(a.id, a.transcriptPath, currentAgent);
        }
        for (const id of trackedRef.current.keys()) {
            if (!byId.has(id)) {
                dropSubagents(id);
                dropShellTasks(id);
            }
        }
        trackedRef.current = new Map(agents.map((a) => [a.id, a.transcriptPath]));
    }, [enterKey]);
    useEffect(() => {
        const { advanced, seen } = advancedActivity(
            seenActivityRef.current,
            lastActivity,
            agents.map((a) => a.id)
        );
        seenActivityRef.current = seen;
        const byId = new Map(agents.map((a) => [a.id, a]));
        for (const id of advanced) {
            const a = byId.get(id)!;
            scheduleSubagents(a.id, a.transcriptPath);
            scheduleShellTasks(a.id, a.transcriptPath, currentAgent);
        }
    }, [lastActivity]);
    useEffect(() => {
        const next = new Map<string, string>();
        for (const a of agents) {
            const episode = idleEpisode(a);
            next.set(a.id, episode);
            const was = idleRef.current.get(a.id);
            // a newly tracked agent is read by the enter refresh
            if (was != null && episode !== "" && episode !== was) {
                void refreshShellTasks(a.id, a.transcriptPath, currentAgent);
            }
        }
        idleRef.current = next;
    }, [idleKey]);
    // an idle agent's transcript is not streamed, so a running task's finish arrives only by re-reading
    useEffect(() => {
        if (pollKey === "") {
            return;
        }
        const ids = new Set(pollKey.split(","));
        const timer = setInterval(() => {
            for (const a of agentsRef.current) {
                if (ids.has(a.id)) {
                    void refreshShellTasks(a.id, a.transcriptPath, currentAgent);
                }
            }
        }, SHELL_POLL_MS);
        return () => clearInterval(timer);
    }, [pollKey]);
}
