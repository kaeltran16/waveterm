// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure derivations for the Channels surface: the rail's partition and project-path matching.

// The comparison key for a project path. A channel stores what the user registered (backslashes on
// Windows) while the Go side stores it canonPath'd, so two spellings of one project must land on one
// key or the app mints a duplicate channel for a project that already has one. Mirrors Go's canonPath.
export function normProjectPath(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

// resolveTargetChannel finds the channel bound to a project: the first whose project path matches. A
// project path can arrive canonPath'd (forward slashes) while a channel stores it verbatim — so on Windows
// a backslash channel path must be separator-normalized before comparing, mirroring Go's canonPath.
export function resolveTargetChannel(channels: Channel[], projectPath: string | undefined): Channel | undefined {
    if (!projectPath) {
        return undefined;
    }
    const want = normProjectPath(projectPath);
    return channels.find((c) => c.projectpath != null && normProjectPath(c.projectpath) === want);
}

export interface ChannelPartition {
    active: Channel[];
    archived: Channel[];
}

// Split channels into active vs archived by the "archived" meta flag (see wstore.MetaKey_Archived). The
// rail shows active rows and tucks archived ones under a collapsible "Archived · N" disclosure. Order-preserving.
export function partitionChannels(channels: Channel[]): ChannelPartition {
    const active: Channel[] = [];
    const archived: Channel[] = [];
    for (const c of channels) {
        if ((c.meta as Record<string, unknown> | undefined)?.["archived"] === true) {
            archived.push(c);
        } else {
            active.push(c);
        }
    }
    return { active, archived };
}
