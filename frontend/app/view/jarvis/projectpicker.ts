// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The pure half of the New run window's project picker (ProjectPicker.dc.html variant 1). A registry of
// many projects cannot be chips, so the field opens a searchable list; the "where" beside each name is what
// tells two same-named checkouts apart.

import { resolveTargetChannel } from "@/app/view/agents/channelderive";
import { rankProjects } from "./newrun";

const DEFAULT_RECENT = 3;

// The home folder from a FileInfoCommand stat of "~". The server expands "~" to stat it but hands the
// path back re-collapsed (ReplaceHomeDir turns home itself into "~"), so home is rebuilt from the
// expanded parent `dir` plus `name`. Anything else is "unknown", which makes projectWhere show full paths.
export function homeFromInfo(info: FileInfo | null | undefined): string {
    if (info == null || info.notfound) {
        return "";
    }
    const path = info.path ?? "";
    if (path !== "" && !path.startsWith("~")) {
        return path;
    }
    if (path === "~" && info.dir && info.name) {
        return info.dir.replace(/[\\/]+$/, "") + "/" + info.name;
    }
    return "";
}

function splitPath(p: string): { lead: string; segs: string[]; sep: string } {
    const lead = /^[\\/]*/.exec(p)[0];
    return {
        lead,
        segs: p
            .slice(lead.length)
            .split(/[\\/]+/)
            .filter((s) => s !== ""),
        sep: p.includes("\\") ? "\\" : "/",
    };
}

// Windows paths compare case-insensitively, which is also what makes `c:\` and `C:\` one drive.
function sameSegs(a: string[], b: string[], fold: boolean): boolean {
    return a.length === b.length && a.every((s, i) => (fold ? s.toLowerCase() === b[i].toLowerCase() : s === b[i]));
}

// The parent folder of a project: relative to home when inside it, else the full parent path. A project
// directly in home says "~", because a blank there would read as "unknown" rather than "home".
export function projectWhere(path: string, home: string): string {
    const p = splitPath(path);
    const parent = p.segs.slice(0, -1);
    if (home !== "") {
        const h = splitPath(home);
        const fold = /^[a-z]:$/i.test(h.segs[0] ?? "");
        if (sameSegs(p.segs, h.segs, fold)) {
            return "";
        }
        if (parent.length >= h.segs.length && sameSegs(parent.slice(0, h.segs.length), h.segs, fold)) {
            const rel = parent.slice(h.segs.length);
            return rel.length === 0 ? "~" : rel.join(p.sep);
        }
    }
    const full = p.lead + parent.join(p.sep);
    // a bare drive is not a folder until it has its separator back
    return /^[a-z]:$/i.test(full) ? full + p.sep : full;
}

// Up to `limit` projects whose channels ran most recently, newest first. The channel is found the way a
// launch finds it (resolveTargetChannel), so "recent" names the channel the run would actually land on.
export function recentProjects(
    projects: { name: string; path: string }[],
    channels: Channel[],
    limit = DEFAULT_RECENT
): string[] {
    return projects
        .map((p) => {
            const runs = resolveTargetChannel(channels, p.path)?.runs ?? [];
            return { name: p.name, newest: runs.length === 0 ? null : Math.max(...runs.map((r) => r.createdts)) };
        })
        .filter((row) => row.newest != null)
        .sort((a, b) => b.newest - a.newest)
        .slice(0, limit)
        .map((row) => row.name);
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

// A search drops Recent: results are one ranked list, not two that repeat each other. The where is matched
// as a plain substring, since a fuzzy subsequence over a long path matches nearly anything.
export function pickerSections(
    names: string[],
    recent: string[],
    query: string,
    whereOf: (name: string) => string
): { recent: string[]; rest: string[]; restLabel: "All projects" | "Matches" } {
    const q = query.trim();
    if (q === "") {
        const rest = names.filter((n) => !recent.includes(n)).sort(byName);
        return { recent, rest, restLabel: "All projects" };
    }
    const byNameMatch = rankProjects(names, q);
    const needle = q.toLowerCase();
    const byWhere = names
        .filter((n) => !byNameMatch.includes(n) && whereOf(n).toLowerCase().includes(needle))
        .sort(byName);
    return { recent: [], rest: [...byNameMatch, ...byWhere], restLabel: "Matches" };
}
