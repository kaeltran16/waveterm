// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Readable project label for display: the Projects-registry name if the cwd matches a registered
// path, else the leaf folder of the cwd. Never surfaces Claude's encoded hash dir name. Pure.

import { normProjectPath } from "./channelderive";

function leaf(cwd: string): string {
    const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] ?? "";
}

function normPath(p: string): string {
    return p
        .replace(/[\\/]+$/, "")
        .replace(/\\/g, "/")
        .toLowerCase();
}

// The registered project whose path is, or contains, cwd; "" if none. The most specific path wins, so a
// worktree registered in its own right beats the repo it lives in, while an unregistered worktree nested
// in a repo (orchestrator task dirs, .claude/worktrees) resolves to that repo.
export function registeredProjectFor(cwd: string, projects: Record<string, { path?: string }>): string {
    if (!cwd) return "";
    const want = normPath(cwd);
    let best = "";
    let bestLen = -1;
    for (const [name, pk] of Object.entries(projects ?? {})) {
        if (!pk?.path) continue;
        const p = normPath(pk.path);
        if ((want === p || want.startsWith(p + "/")) && p.length > bestLen) {
            best = name;
            bestLen = p.length;
        }
    }
    return best;
}

export function projectLabel(cwd: string, projects: Record<string, { path?: string }>): string {
    if (!cwd) return "";
    return registeredProjectFor(cwd, projects) || leaf(cwd);
}

// The one name a channel is allowed to show. A channel is storage for "work in this project", so what a
// user reads is the project registered at its path — never the channel's own `name`, which is free text a
// pre-collapse channel could have set to anything. The fallbacks are for channels the registry cannot
// explain: an unregistered or since-removed project keeps rendering as *something* rather than blank.
// Separate from projectLabel above because a channel's miss falls back to its own name, not to a leaf
// folder — a legacy thread's name is a better answer than the last segment of a path nobody registered.
export function channelProjectLabel(
    channel: Channel | null | undefined,
    projects: Record<string, ProjectKeywords>
): string {
    if (channel == null) {
        return "";
    }
    const path = channel.projectpath ?? "";
    if (path !== "") {
        const want = normProjectPath(path);
        for (const [name, p] of Object.entries(projects ?? {})) {
            if (p?.path != null && normProjectPath(p.path) === want) {
                return name;
            }
        }
    }
    return channel.name || channel.oid;
}

// One row per project for any list a user picks from. CreateChannelCommand is idempotent per path from
// Task 7 on, but channels created before that are still out there, and two rows carrying one project's
// name is exactly the confusion this work removes. First wins, which is newest: GetChannels sorts by
// CreatedTs descending and channelsAtom preserves that order, so this agrees with resolveTargetChannel
// and with the server's own ChannelAtPath rather than quietly picking a different duplicate.
export function dedupeByProject(channels: Channel[]): Channel[] {
    const seen = new Set<string>();
    const out: Channel[] = [];
    for (const c of channels) {
        const path = c.projectpath ?? "";
        if (path === "") {
            // nothing to collapse onto: a pathless channel is not "a project", so it keeps its own row
            out.push(c);
            continue;
        }
        const key = normProjectPath(path);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(c);
    }
    return out;
}
