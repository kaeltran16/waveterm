// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { resolveTargetChannel } from "./channelderive";
import { channelsAtom, primeChannels } from "./channelsstore";

// The registered projects (name -> {path}), surfaced live from the full config.
export const projectsAtom = atom((get) => get(atoms.fullConfigAtom)?.projects ?? {});

// One row per registered project that has a path: the single project list every picker shows. The registry
// is the source; a folder an agent happens to run in, or a leftover channel, is not a project until it is
// registered. wavesrv gives every registered project a channel (SyncProjectChannels), so `channel` is
// absent only until the channel snapshot catches up with a project registered moments ago.
export interface ProjectRow {
    name: string;
    path: string;
    channel?: Channel;
}

export function buildProjectList(
    registry: Record<string, ProjectKeywords> | null | undefined,
    channels: Channel[] | null | undefined
): ProjectRow[] {
    return Object.entries(registry ?? {})
        .filter(([, v]) => v?.path)
        .map(([name, v]) => ({ name, path: v.path, channel: resolveTargetChannel(channels ?? [], v.path) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export const projectListAtom = atom((get) => buildProjectList(get(projectsAtom), get(channelsAtom)));

// The rows whose channel has loaded, for the surfaces that act on a project's channel.
export function rowsWithChannel(rows: ProjectRow[]): (ProjectRow & { channel: Channel })[] {
    return rows.filter((r): r is ProjectRow & { channel: Channel } => r.channel != null);
}

export interface SwitcherProject {
    name: string;
    askingCount: number;
    agentCount: number;
}

// The switcher's rows: every project, with the live roster's counts laid over it.
export function switcherProjects(
    rows: ProjectRow[],
    live: { name: string; askingCount: number; agentCount: number }[]
): SwitcherProject[] {
    const counts = new Map(live.map((p) => [p.name, p]));
    return rows.map((r) => ({
        name: r.name,
        askingCount: counts.get(r.name)?.askingCount ?? 0,
        agentCount: counts.get(r.name)?.agentCount ?? 0,
    }));
}

// A registration happened here, and wavesrv made the project's channel before answering; refresh the
// channel snapshot so the new row arrives with it.
export async function registerProject(name: string, path: string): Promise<void> {
    await RpcApi.CreateProjectCommand(TabRpcClient, { name, path });
    await primeChannels();
}

// Deregisters from projects.json; the registry atom refreshes and the row drops out. If the removed
// project was the active scope, fall back to "all".
export async function removeProject(model: { projectFilterAtom: PrimitiveAtom<string> }, name: string): Promise<void> {
    try {
        await RpcApi.DeleteProjectCommand(TabRpcClient, { name });
        if (globalStore.get(model.projectFilterAtom) === name) {
            globalStore.set(model.projectFilterAtom, "all");
        }
    } catch (e) {
        console.error("failed to remove project", e);
    }
}

// removeProject behind a confirm, for callers without the switcher's inline Remove? prompt (the palette)
export function confirmRemoveProject(model: { projectFilterAtom: PrimitiveAtom<string> }, name: string): void {
    modalsModel.pushModal("ConfirmModal", {
        title: "Remove project",
        message: `Remove "${name}" from your projects? Its files and runs are not touched.`,
        confirmLabel: "Remove",
        destructive: true,
        onConfirm: () => void removeProject(model, name),
    });
}

// bounds the list so projects removed long ago don't pile up in storage
export const RECENT_PROJECTS_CAP = 20;

// Projects most recently launched into or run in, newest first: the one meaning of "recent" every picker
// orders by. The key predates the New Run window sharing it, when only the agent launcher kept it.
export const recentProjectsAtom = atomWithStorage<string[]>("agent.launch.recentprojects", []);

export function noteRecentProject(name: string): void {
    globalStore.set(recentProjectsAtom, pushRecentProject(globalStore.get(recentProjectsAtom), name));
}

export function pushRecentProject(recent: string[], name: string): string[] {
    return [name, ...(recent ?? []).filter((n) => n !== name)].slice(0, RECENT_PROJECTS_CAP);
}

// Orders by recent use, so the head is a picker's default; never-used projects keep their order after.
export function recentFirst<T extends { name: string }>(candidates: T[], recent: string[]): T[] {
    const rank = (name: string) => {
        const i = (recent ?? []).indexOf(name);
        return i < 0 ? Infinity : i;
    };
    // two never-used ranks subtract to NaN; || 0 keeps them tied so the stable sort holds their order
    return [...candidates].sort((a, b) => rank(a.name) - rank(b.name) || 0);
}
