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
    registered?: boolean; // present in projects.json (so removable)
}

// Switcher list = live-derived projects (with counts) ∪ registry-only projects (count 0).
// `registered` marks rows backed by projects.json; only those get a remove control.
export function mergeSwitcherProjects(
    live: SwitcherProject[],
    registry: Record<string, ProjectKeywords>
): SwitcherProject[] {
    const registryNames = new Set(Object.keys(registry ?? {}));
    const merged = live.map((p) => ({ ...p, registered: registryNames.has(p.name) }));
    const liveNames = new Set(live.map((p) => p.name));
    const extra = [...registryNames]
        .filter((n) => !liveNames.has(n))
        .map((n) => ({ name: n, askingCount: 0, agentCount: 0, registered: true }));
    return [...merged, ...extra];
}

export interface LaunchCandidate {
    name: string;
    path: string; // registry path; "" for a live project until its cwd is resolved
    transcriptPath?: string; // present for live projects (used to resolve the cwd)
    registered: boolean;
}

// New Agent launch targets = registry projects (stored path) ∪ live-derived projects (path resolved
// lazily from a transcript cwd). Registry wins on a name collision; name-sorted. Mirrors the
// switcher's merged list so the launcher shows the same projects.
export function launchCandidates(
    registry: Record<string, ProjectKeywords>,
    live: { name: string; transcriptPath?: string }[]
): LaunchCandidate[] {
    const out: LaunchCandidate[] = [];
    const seen = new Set<string>();
    for (const [name, v] of Object.entries(registry ?? {})) {
        if (!v?.path) {
            continue;
        }
        out.push({ name, path: v.path, registered: true });
        seen.add(name);
    }
    for (const p of live ?? []) {
        if (seen.has(p.name)) {
            continue;
        }
        seen.add(p.name);
        out.push({ name: p.name, path: "", transcriptPath: p.transcriptPath, registered: false });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}
