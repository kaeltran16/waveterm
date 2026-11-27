// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Every way into the Diff surface from elsewhere in the cockpit. One helper rather than a sequence
// each caller assembles, because the file link and the change-list load have to name the scope with
// the same string: a link built from a different one is silently never claimed, and the surface opens
// on its first file instead of the one that was clicked.

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { landOn } from "@/app/view/jarvis/returnsurface";
import { fireAndForget } from "@/util/util";
import type { AgentsViewModel } from "./agents";
import { defaultRangeFor, scopeKey, type DiffOrigin, type DiffScope } from "./diffscope";
import { requestFileLink } from "./filesstore";
import { finalStageRunId, isFinalStageId } from "./finalstage";
import { HISTORY_RPC_TIMEOUT_MS } from "./historyquery";
import { endedRowRunId, endedVerifierId, endedWorkerId } from "./runlineage";
import { leadRunAtom, runDigestsAtom } from "./runlineagestore";
import { runTree } from "./runmodel";

// runtime is the AgentVM's `agent` field; it decides whether the scope opens on the agent's edits
export function agentDiffScope(agentId: string, label: string, runtime?: string): DiffScope {
    const origin: DiffOrigin = { kind: "agent", id: agentId, runtime };
    return { repo: { origin, label }, range: defaultRangeFor(origin) };
}

// baseCommit is optional because a run may have none: it degrades to "" — the live HEAD diff — which
// is what the change-list loader treats as "no anchor". Defaulting here rather than at each call site
// keeps that guarantee in one tested place. headCommit bounds a landed run at its own tip; absent or ""
// reads up to HEAD, under the unbounded key its review marks were saved with.
export function runDiffScope(runId: string, cwd: string, baseCommit?: string, headCommit?: string): DiffScope {
    const origin: DiffOrigin = headCommit
        ? { kind: "run", runId, cwd, baseCommit: baseCommit ?? "", headCommit }
        : { kind: "run", runId, cwd, baseCommit: baseCommit ?? "" };
    return { repo: { origin, label: `run ${runId.slice(0, 8)}` }, range: defaultRangeFor(origin) };
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

// A land is a --no-ff merge, so its second parent is the run branch's tip; one parent means the land commit is the
// tip itself (a fast-forward, or a hand-merge mergedCommit recorded as the tip). "" = unbounded.
export function landedRunTip(
    landCommit: string | undefined,
    parents: string[] | undefined,
    endCommit: string | undefined
): string {
    if (landCommit && parents?.length >= 2) {
        return parents[1];
    }
    if (landCommit && parents?.length === 1) {
        return landCommit;
    }
    return endCommit ?? "";
}

// A commit that no longer resolves (gc'd, shallow clone) falls back rather than failing the diff.
async function commitParents(cwd: string, commit: string | undefined): Promise<string[] | undefined> {
    if (!commit) {
        return undefined;
    }
    try {
        const h = await RpcApi.GitHistoryCommand(
            TabRpcClient,
            { cwd, ref: commit, limit: 1 },
            { timeout: HISTORY_RPC_TIMEOUT_MS }
        );
        if (h.failure) {
            console.warn("reading the parents of commit", commit, h.failure);
            return undefined;
        }
        return h.commits?.[0]?.parents;
    } catch (e) {
        console.warn("reading the parents of commit", commit, e);
        return undefined;
    }
}

// Where a run's changes are read: its tree from its base while it runs. A landed run's tree is removed, and its
// commits are merged into the checkout. Its tree was a worktree of the whole repo, so the checkout is read from its
// repo root, bounded at the run's own tip so later commits are not counted. end "" reads up to the working tree.
export async function runChangesRange(run: Run): Promise<{ cwd: string; base: string; end: string }> {
    const base = run.basecommit ?? "";
    if (run.land?.state !== "landed") {
        return { cwd: runTree(run), base, end: "" };
    }
    const root = (await checkoutRoot(run.projectpath)) ?? runTree(run);
    const parents = await commitParents(root, run.land.commit);
    return { cwd: root, base, end: landedRunTip(run.land.commit, parents, run.endcommit) };
}

export async function openRunDiff(model: AgentsViewModel, run: Run, file?: string): Promise<void> {
    const { cwd, end } = await runChangesRange(run);
    openDiff(model, runDiffScope(run.id, cwd, run.basecommit, end), file);
}

// a done worker's merge: the commit its work landed as, its own sealed files, and the other tasks that commit landed
export interface MergeFacts {
    commit: string;
    own: string[];
    also: { id: string; label: string }[];
}

// Where a finished row's changes are read. range: base..end at cwd, a done worker's merge commit or the commit the
// run's Final verified. sealed: the merge commit is gone or was never recorded, so only the files the worker's run
// sealed are known. run: Final has no commit yet, so the lead's run is read as its lead reads it.
export type FinishedRange =
    | {
          kind: "range";
          runId: string;
          cwd: string;
          base: string;
          end: string;
          merge?: MergeFacts;
          verified?: { commit: string; round: number };
      }
    | { kind: "sealed"; merge: MergeFacts; files: EvidenceFile[] }
    | { kind: "run"; run: Run };

// a load that fails reads as missing, so the row falls back to the read any agent gets
async function loadObject<T extends WaveObj>(otype: string, oid: string | undefined): Promise<T | undefined> {
    if (!oid) {
        return undefined;
    }
    try {
        return (await WOS.loadAndPinWaveObject<T>(WOS.makeORef(otype, oid))) ?? undefined;
    } catch (e) {
        console.warn("loading", otype, oid, "for a finished row's changes", e);
        return undefined;
    }
}

// The commit a task's work merged as. A lane lands as one squash, which the engine records on its tip's run only
// (pkg/orchestrate persistMergedTask), so a merged task reads its lane tip's, the last task not skipped.
function mergeCommitOf(
    task: TaskNode,
    byId: Map<string, TaskNode>,
    lanes: string[][] | undefined,
    children: Map<string, Run>
): string {
    const own = children.get(task.runid ?? "")?.endcommit ?? "";
    const lane = lanes?.find((l) => l.includes(task.id)) ?? [];
    const tip = lane
        .map((id) => byId.get(id))
        .filter((t) => t != null && t.state !== "skipped")
        .at(-1);
    if (!task.merged || tip == null || !tip.merged) {
        return own;
    }
    return children.get(tip.runid ?? "")?.endcommit || own;
}

async function mergeRange(runId: string, root: string, dag: TaskGroup, task: TaskNode): Promise<FinishedRange> {
    const tasks = dag.tasks ?? [];
    const loaded = await Promise.all(tasks.map((t) => loadObject<Run>("run", t.runid)));
    const children = new Map(loaded.filter((r) => r != null).map((r) => [r.id, r]));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const lanes = globalStore.get(runDigestsAtom)[runId]?.lanes;
    const commit = mergeCommitOf(task, byId, lanes, children);
    const files = children.get(task.runid ?? "")?.evidence?.files ?? [];
    const own = files.map((f) => f.path);
    const parents = await commitParents(root, commit);
    if (!parents?.[0]) {
        return { kind: "sealed", merge: { commit, own, also: [] }, files };
    }
    const also = tasks
        .filter((t) => t.id !== task.id && mergeCommitOf(t, byId, lanes, children) === commit)
        .map((t) => ({ id: t.id, label: t.label ?? "" }));
    return { kind: "range", runId, cwd: root, base: parents[0], end: commit, merge: { commit, own, also } };
}

// finishedRowRange is how a done worker's row, the Final stage's row and an ended verifier read their changes, all
// at the lead run's checkout root; undefined for any other id, which reads as any agent does
export async function finishedRowRange(id: string): Promise<FinishedRange | undefined> {
    const runId = endedRowRunId(id) ?? finalStageRunId(id);
    if (!runId) {
        return undefined;
    }
    const run = await loadObject<Run>("run", runId);
    const dag = await loadObject<TaskGroup>("dag", run?.dagoref);
    if (run == null || dag == null) {
        return undefined;
    }
    const finalRow = isFinalStageId(id) || id.startsWith(endedVerifierId(runId, ""));
    const task = finalRow ? undefined : dag.tasks?.find((t) => endedWorkerId(runId, t.id) === id);
    if (!finalRow && task == null) {
        return undefined;
    }
    const commit = dag.final?.commit;
    if (finalRow && !commit) {
        return { kind: "run", run };
    }
    const root = (await checkoutRoot(run.projectpath)) ?? runTree(run);
    if (task != null) {
        return mergeRange(runId, root, dag, task);
    }
    const verified = { commit, round: dag.final.round };
    return { kind: "range", runId, cwd: root, base: run.basecommit ?? "", end: commit, verified };
}

async function openFinishedRowDiff(
    model: AgentsViewModel,
    agent: { id: string; name: string; agent?: string },
    file?: string
): Promise<void> {
    const range = await finishedRowRange(agent.id);
    if (range?.kind === "run") {
        return openRunDiff(model, range.run, file);
    }
    if (range?.kind === "range") {
        openDiff(model, runDiffScope(range.runId, range.cwd, range.base, range.end), file);
        return;
    }
    // a sealed list has no range to open; any other row is a plain agent
    if (range == null) {
        openDiff(model, agentDiffScope(agent.id, agent.name, agent.agent), file);
    }
}

// an agent's changes in the Diff surface: a lead's are its run's, which its workers made; a finished row's the range
// its Changes tab lists; any other agent's its own
export function openAgentDiff(
    model: AgentsViewModel,
    agent: { id: string; name: string; agent?: string; runId?: string },
    file?: string
): void {
    if (endedRowRunId(agent.id) ?? finalStageRunId(agent.id)) {
        fireAndForget(() => openFinishedRowDiff(model, agent, file));
        return;
    }
    const lead = agent.runId ? globalStore.get(leadRunAtom(agent.runId)) : undefined;
    if (lead) {
        fireAndForget(() => openRunDiff(model, lead.run, file));
        return;
    }
    openDiff(model, agentDiffScope(agent.id, agent.name, agent.agent), file);
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
