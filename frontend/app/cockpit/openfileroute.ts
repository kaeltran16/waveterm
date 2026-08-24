// frontend/app/cockpit/openfileroute.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure routing for "openfile" events: turn an absolute path into a Code-surface project/file
// selection. Kept free of atoms and RPC so it unit-tests without booting the store.

import { normalizeRepoPath, repoBasename } from "@/util/paths";
import type { CodeProject } from "@/app/view/code/codestore";

export interface OpenFileRoute {
    // project to have selected when this route runs
    project: CodeProject;
    // file to open within the project; null = just browse the project (directory arg)
    rel: string | null;
}

function isUnderRoot(root: string, path: string): boolean {
    const nRoot = normalizeRepoPath(root);
    const nPath = normalizeRepoPath(path);
    // a bare "C:" prefix would swallow every path on the drive; a usable root has a separator
    if (!nRoot.includes("/")) {
        return false;
    }
    return nPath.startsWith(nRoot + "/");
}

// rel is git-style: forward slashes, no leading separator. Comparison is case/separator
// insensitive (via isUnderRoot) but the returned segments keep their original case.
function toRel(root: string, path: string): string {
    const segs = path.split(/[\\/]+/).filter((s) => s !== "");
    const rootSegs = root.split(/[\\/]+/).filter((s) => s !== "");
    return segs.slice(rootSegs.length).join("/");
}

function dirnameOf(path: string): string {
    const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return idx <= 0 ? path : path.slice(0, idx);
}

export function routeOpenFile(absPath: string, isDir: boolean, current: CodeProject | null): OpenFileRoute {
    if (isDir) {
        return { project: { name: repoBasename(absPath), path: absPath }, rel: null };
    }
    if (current != null && current.path !== "" && isUnderRoot(current.path, absPath)) {
        return { project: current, rel: toRel(current.path, absPath) };
    }
    const dir = dirnameOf(absPath);
    return { project: { name: repoBasename(dir), path: dir }, rel: repoBasename(absPath) };
}
