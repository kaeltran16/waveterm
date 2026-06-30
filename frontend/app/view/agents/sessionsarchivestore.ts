// frontend/app/view/agents/sessionsarchivestore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Past resumable sessions across runtimes from GetRecentSessions, plus pure client-side
// search/filter helpers. Separate from recentsessionsstore so callers don't share one cache policy.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

const WINDOW_DAYS = 30;
const LIMIT = 100;

// null = not loaded yet; [] = loaded-empty.
export const sessionsArchiveAtom = atom<SessionInfo[] | null>(null) as PrimitiveAtom<SessionInfo[] | null>;

let loading = false;

export async function loadSessionsArchive(): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const rtn = await RpcApi.GetRecentSessionsCommand(TabRpcClient, { windowdays: WINDOW_DAYS, limit: LIMIT });
        globalStore.set(sessionsArchiveAtom, rtn.sessions ?? []);
    } catch {
        globalStore.set(sessionsArchiveAtom, []); // scan failure should not break the surface
    } finally {
        loading = false;
    }
}

export function searchSessions(list: SessionInfo[], query: string): SessionInfo[] {
    const q = query.trim().toLowerCase();
    if (!q) {
        return list;
    }
    return list.filter(
        (s) =>
            s.task.toLowerCase().includes(q) ||
            s.projectname.toLowerCase().includes(q) ||
            s.branch.toLowerCase().includes(q)
    );
}

export interface SessionFilter {
    runtime: string;
    project: string;
}

export function filterSessions(list: SessionInfo[], f: SessionFilter): SessionInfo[] {
    return list.filter(
        (s) => (f.runtime === "all" || s.runtime === f.runtime) && (f.project === "all" || s.projectname === f.project)
    );
}

export function runtimesOf(list: SessionInfo[]): string[] {
    return [...new Set(list.map((s) => s.runtime))].sort();
}

export function projectsOf(list: SessionInfo[]): string[] {
    return [...new Set(list.map((s) => s.projectname))].sort();
}