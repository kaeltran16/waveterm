// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Discover recent agent session transcript files for the Activity surface. Claude lives under
// ~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl (project = dir name, free); Codex under
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (project resolved later from the file's session_meta).
// Agent identity = source root. ~ is expanded by the file backend (FileListCommand). Zero new Go.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { projectNameFromTranscriptPath } from "./projectname";

const CLAUDE_ROOT = "~/.claude/projects";
const CODEX_ROOT = "~/.codex/sessions";
const CODEX_WALK_FILE_BUDGET = 400; // bound the date-tree walk

export interface SessionDescriptor {
    path: string;
    agent: string; // "claude" | "codex"
    project: string; // claude: from path; codex: "" (resolved by the extractor)
    name: string;
    modtime: number; // sort key only; unit-agnostic (monotonic)
}

async function listDir(path: string): Promise<FileInfo[]> {
    try {
        return await RpcApi.FileListCommand(TabRpcClient, { path, opts: { all: true } });
    } catch {
        return [];
    }
}

function isJsonl(fi: FileInfo): boolean {
    return !fi.isdir && (fi.name ?? "").endsWith(".jsonl");
}

function byNameDesc(a: FileInfo, b: FileInfo): number {
    return (b.name ?? "").localeCompare(a.name ?? "");
}

async function discoverClaude(): Promise<SessionDescriptor[]> {
    const out: SessionDescriptor[] = [];
    for (const proj of (await listDir(CLAUDE_ROOT)).filter((d) => d.isdir)) {
        for (const f of (await listDir(proj.path)).filter(isJsonl)) {
            const project = projectNameFromTranscriptPath(f.path);
            out.push({ path: f.path, agent: "claude", project, name: project, modtime: f.modtime ?? 0 });
        }
    }
    return out;
}

async function discoverCodex(): Promise<SessionDescriptor[]> {
    const out: SessionDescriptor[] = [];
    for (const y of (await listDir(CODEX_ROOT)).filter((d) => d.isdir).sort(byNameDesc)) {
        for (const m of (await listDir(y.path)).filter((d) => d.isdir).sort(byNameDesc)) {
            for (const d of (await listDir(m.path)).filter((dd) => dd.isdir).sort(byNameDesc)) {
                for (const f of (await listDir(d.path)).filter((fi) => isJsonl(fi) && (fi.name ?? "").startsWith("rollout-"))) {
                    out.push({ path: f.path, agent: "codex", project: "", name: "codex", modtime: f.modtime ?? 0 });
                }
                if (out.length >= CODEX_WALK_FILE_BUDGET) {
                    return out;
                }
            }
        }
    }
    return out;
}

export async function discoverSessions(): Promise<SessionDescriptor[]> {
    const [claude, codex] = await Promise.all([discoverClaude(), discoverCodex()]);
    return [...claude, ...codex].sort((a, b) => b.modtime - a.modtime);
}
