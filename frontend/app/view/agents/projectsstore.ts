// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms } from "@/app/store/global";
import { atom } from "jotai";

// The registered projects (name -> {path}), surfaced live from the full config.
export const projectsAtom = atom((get) => get(atoms.fullConfigAtom)?.projects ?? {});

export interface SwitcherProject {
    name: string;
    askingCount: number;
    agentCount: number;
}

// Switcher list = live-derived projects (with counts) ∪ registry-only projects (count 0).
export function mergeSwitcherProjects(
    live: SwitcherProject[],
    registry: Record<string, ProjectKeywords>
): SwitcherProject[] {
    const liveNames = new Set(live.map((p) => p.name));
    const extra = Object.keys(registry ?? {})
        .filter((n) => !liveNames.has(n))
        .map((n) => ({ name: n, askingCount: 0, agentCount: 0 }));
    return [...live, ...extra];
}

export interface LaunchableProject {
    name: string;
    path: string;
}

// New Agent launch targets: registry entries that have a real path.
export function launchableProjects(registry: Record<string, ProjectKeywords>): LaunchableProject[] {
    return Object.entries(registry ?? {})
        .filter(([, v]) => !!v?.path)
        .map(([name, v]) => ({ name, path: v.path }));
}
