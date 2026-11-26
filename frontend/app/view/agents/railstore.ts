// frontend/app/view/agents/railstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Cockpit rail state: the agent details-rail toggle + the channels context-rail toggle (both
// global, persisted) plus a thin git load for the agent rail (branch + changed-file list, no
// per-file diff). Mirrors filesstore.ts but lighter — the rail shows the list, not the diff.
// cwd resolution is shared via agentcwdresolve.ts.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { readAgentChanges, type AgentChanges } from "./agentchanges";
import { resolveCwd } from "./agentcwdresolve";
import { runChangesRange } from "./agentdiffnav";
import { linkedWorktree } from "./agentrailmodel";
import { ensureSessionStart } from "./agentsessionstore";
import { parseGitChanges, type GitChanges } from "./gitstatus";
import { leadRunAtom } from "./runlineagestore";

export interface RailGitState {
    cwd: string | null;
    branch: string;
    isRepo: boolean;
    changes: GitChanges | null;
    // the linked worktree the agent works in, as linkedWorktree names it; unset in the main checkout
    worktree?: string;
    // the base the list was read against (the session-start commit, or "" for HEAD) and the sha HEAD pointed at,
    // so a file's diff reads the same range the list counts
    ref?: string;
    head?: string;
    // set when the list is the agent's own edits: ref..end, end "" while it has none
    edits?: boolean;
    // set when the list is a lead's run's changes, which its workers made: ref is the run's base
    run?: boolean;
    end?: string;
    // why the git read failed; changes is then null and isRepo false
    failure?: string;
}

// First persisted FE pref in frontend/app: rail is global + off by default (localStorage key
// "agent.rail.visible"). Keep persisted prefs to this one atom for now.
export const DEFAULT_RAIL_VISIBLE = false;

export const railVisibleAtom = atomWithStorage("agent.rail.visible", DEFAULT_RAIL_VISIBLE);

// Terminal-fullscreen toggle for the Agent surface: when on, the AgentTree (and the rail) are
// hidden so the focused agent's live terminal fills the surface. Session-scoped UI, not persisted.
export const terminalFullscreenAtom = atom(false);

// whether the rail's Token usage section shows its per-class and per-model breakdown. Session-scoped, not
// persisted; global so it holds while the surface unmounts.
export const usageBreakdownAtom = atom(false);

export const railStateAtom = atom<RailGitState | null>(null) as PrimitiveAtom<RailGitState | null>;

// guards against an older load overwriting a newer one: another agent's after a focus change, or the same agent's
// when two edits start overlapping loads, so a sequence rather than the id
let loadSeq = 0;

const EMPTY: RailGitState = { cwd: null, branch: "", isRepo: false, changes: null };

// a lead's run's changes: its tree from the run's base, or once landed what the run landed
async function readRunChanges(run: Run): Promise<{ cwd: string; read: () => Promise<AgentChanges> }> {
    const { cwd, base, end } = await runChangesRange(run);
    const read = async () => {
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd, ref: base, end: end || undefined });
        return { ch, edits: false, end, cwd };
    };
    return { cwd, read };
}

async function readOwnChanges(agent: {
    transcriptPath?: string;
    blockId?: string;
    agent?: string;
}): Promise<{ cwd: string | null; read: () => Promise<AgentChanges> }> {
    const { transcriptPath, blockId } = agent;
    const [cwd, startTs] = await Promise.all([resolveCwd(transcriptPath, blockId), ensureSessionStart(transcriptPath)]);
    return { cwd, read: () => readAgentChanges(cwd, { transcriptPath, runtime: agent.agent }, startTs) };
}

// silent keeps the shown state until the new read lands, so a reload for the same agent never blanks the list. A
// lead's list is its run's changes, which its workers made, rather than the lead's own edits.
export async function loadRailForAgent(
    agent: { transcriptPath?: string; blockId?: string; agent?: string; runId?: string },
    opts?: { silent?: boolean }
): Promise<void> {
    const seq = ++loadSeq;
    if (!opts?.silent) {
        globalStore.set(railStateAtom, null);
    }

    const lead = agent.runId ? globalStore.get(leadRunAtom(agent.runId)) : undefined;
    const { cwd, read } = lead ? await readRunChanges(lead.run) : await readOwnChanges(agent);
    if (seq !== loadSeq) {
        return;
    }
    if (!cwd) {
        globalStore.set(railStateAtom, EMPTY);
        return;
    }
    try {
        // the worktree list only names the worktree, so a failure there leaves the line out rather than the rail
        const listWorktrees = (dir: string) =>
            RpcApi.GitListWorktreesCommand(TabRpcClient, { cwd: dir }).catch(() => null);
        const [{ ch, edits, end, cwd: at }, cwdWts] = await Promise.all([read(), listWorktrees(cwd)]);
        // edits in another checkout name that checkout's worktree, so its list is read again there
        const wts = at === cwd ? cwdWts : await listWorktrees(at);
        if (seq !== loadSeq) {
            return;
        }
        const changes = ch.isrepo ? parseGitChanges(ch.statusz, ch.numstat, ch.numstaterror) : null;
        const worktree = ch.isrepo ? linkedWorktree(at, wts?.worktrees ?? []) : undefined;
        globalStore.set(railStateAtom, {
            cwd: at,
            branch: ch.branch,
            isRepo: ch.isrepo,
            changes,
            worktree,
            ref: ch.ref ?? "",
            head: ch.head ?? "",
            edits,
            run: lead != null,
            end,
        });
    } catch (e) {
        if (seq === loadSeq) {
            globalStore.set(railStateAtom, {
                ...EMPTY,
                cwd,
                failure: (e instanceof Error ? e.message : String(e ?? "")) || "The read failed with no message.",
            });
        }
    }
}
