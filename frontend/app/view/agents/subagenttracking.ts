// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Load each agent's disk-backed subagents into subagentsByIdAtom, and its background shell tasks into
// shellTasksByIdAtom: refresh on enter, debounce on parent transcript activity, drop on leave.
// Extracted from agenttree so the cockpit grid and the Runs surface populate the stores the same way
// instead of each copying the effect. Safe to mount on more than one surface at once: the refreshes
// are seq-guarded and the drops only clear ids this caller tracked.

import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
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

type Trackable = { id: string; transcriptPath?: string };

export function useSubagentTracking(agents: Trackable[]): void {
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const shellTasks = useAtomValue(shellTasksByIdAtom);
    const trackedRef = useRef<Set<string>>(new Set());
    const agentsRef = useRef(agents);
    agentsRef.current = agents;
    const idsKey = agents.map((a) => a.id).join(",");
    const pollKey = shellTaskPollIds(
        agents.map((a) => a.id),
        shellTasks
    ).join(",");
    useEffect(() => {
        const now = new Set(agents.map((a) => a.id));
        for (const a of agents) {
            if (!trackedRef.current.has(a.id)) {
                void refreshSubagents(a.id, a.transcriptPath);
                void refreshShellTasks(a.id, a.transcriptPath);
            }
        }
        for (const id of trackedRef.current) {
            if (!now.has(id)) {
                dropSubagents(id);
                dropShellTasks(id);
            }
        }
        trackedRef.current = now;
    }, [idsKey]);
    useEffect(() => {
        for (const a of agents) {
            if (lastActivity[a.id]) {
                scheduleSubagents(a.id, a.transcriptPath);
                scheduleShellTasks(a.id, a.transcriptPath);
            }
        }
    }, [lastActivity]);
    // an idle agent's transcript is not streamed, so a running task's finish arrives only by re-reading
    useEffect(() => {
        if (pollKey === "") {
            return;
        }
        const ids = new Set(pollKey.split(","));
        const timer = setInterval(() => {
            for (const a of agentsRef.current) {
                if (ids.has(a.id)) {
                    void refreshShellTasks(a.id, a.transcriptPath);
                }
            }
        }, SHELL_POLL_MS);
        return () => clearInterval(timer);
    }, [pollKey]);
}
