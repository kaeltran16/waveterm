// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Every way into the Diff surface from elsewhere in the cockpit. One helper rather than a sequence
// each caller assembles, because the file link and the change-list load have to name the scope with
// the same string: a link built from a different one is silently never claimed, and the surface opens
// on its first file instead of the one that was clicked.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { landOn } from "@/app/view/jarvis/returnsurface";
import type { AgentsViewModel } from "./agents";
import { defaultRangeFor, scopeKey, type DiffOrigin, type DiffScope } from "./diffscope";
import { requestFileLink } from "./filesstore";
import { runTree } from "./runmodel";

export function agentDiffScope(agentId: string, label: string): DiffScope {
    const origin: DiffOrigin = { kind: "agent", id: agentId };
    return { repo: { origin, label }, range: defaultRangeFor(origin) };
}

// baseCommit is optional because a run may have none: it degrades to "" — the live HEAD diff — which
// is what the change-list loader treats as "no anchor". Defaulting here rather than at each call site
// keeps that guarantee in one tested place.
export function runDiffScope(runId: string, cwd: string, baseCommit?: string): DiffScope {
    const origin: DiffOrigin = { kind: "run", runId, cwd, baseCommit: baseCommit ?? "" };
    return { repo: { origin, label: `run ${runId.slice(0, 8)}` }, range: defaultRangeFor(origin) };
}

// a run's changes live where its lanes landed: its own branch tree when it has one, else the checkout
export function diffScopeOfRun(run: Pick<Run, "id" | "projectpath" | "landpath" | "land" | "basecommit">): DiffScope {
    return runDiffScope(run.id, runTree(run), run.basecommit);
}

// The checkout's repo root, which git lists as the main worktree. A project can be a subfolder of its repo, and the
// readers diff --relative to their cwd, so reading a landed run from the project would drop what it changed elsewhere.
async function checkoutRoot(projectPath: string): Promise<string | undefined> {
    try {
        const res = await RpcApi.GitListWorktreesCommand(TabRpcClient, { cwd: projectPath });
        return res?.worktrees?.find((wt) => wt.ismain)?.path;
    } catch (e) {
        console.warn("reading the repo root of", projectPath, e);
        return undefined;
    }
}

// A landed run's tree is removed, and its commits are merged into the checkout. Its tree was a worktree of the whole
// repo, so the checkout is read from its repo root.
export async function openRunDiff(model: AgentsViewModel, run: Run, file?: string): Promise<void> {
    let scope = diffScopeOfRun(run);
    if (run.land?.state === "landed") {
        const root = await checkoutRoot(run.projectpath);
        if (root) {
            scope = runDiffScope(run.id, root, run.basecommit);
        }
    }
    openDiff(model, scope, file);
}

export function projectDiffScope(name: string, path: string): DiffScope {
    const origin: DiffOrigin = { kind: "project", name, path };
    return { repo: { origin, label: name }, range: defaultRangeFor(origin) };
}

// The file link is requested before the surface switch because the surface's mount triggers the load
// that consumes it.
export function openDiff(model: AgentsViewModel, scope: DiffScope, file?: string): void {
    if (file) {
        requestFileLink(scopeKey(scope), file);
    }
    globalStore.set(model.diffScopeAtom, scope);
    landOn(model.surfaceAtom, "files");
}
