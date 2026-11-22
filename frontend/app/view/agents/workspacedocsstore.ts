// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The agent's Docs list (the Markdown files its transcripts wrote, read by AgentDocsCommand) per agent, and the
// routing of a file opened beside the transcript: a listed doc to the Docs tab, anything else to the File tab.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { sameRepoPath } from "@/util/paths";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import { useEffect } from "react";
import { resolvePeekPath } from "../code/codepeekmodel";
import { resolveCwd } from "./agentcwdresolve";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import type { WorkspaceTab } from "./workspacemodel";
import { openBeside, rendersNow } from "./workspacestore";

// loaded: a read has landed; failure: the last read's error, cleared by the next good one
export type DocsRead = { loaded: boolean; cwd: string | null; failure: string | null };

const NOT_READ: DocsRead = { loaded: false, cwd: null, failure: null };

function perAgent<T>(init: T): (agentId: string) => PrimitiveAtom<T> {
    const atoms = new Map<string, PrimitiveAtom<T>>();
    return (agentId) => {
        let a = atoms.get(agentId);
        if (a == null) {
            a = atom(init) as PrimitiveAtom<T>;
            atoms.set(agentId, a);
        }
        return a;
    };
}

// the last list read, kept through a failed re-read
export const agentDocsAtom = perAgent<AgentDoc[]>([]);
export const agentDocsReadAtom = perAgent<DocsRead>(NOT_READ);

// per agent, so an older read landing late never overwrites a newer one
const readSeq = new Map<string, number>();

export async function loadAgentDocs(agent: AgentVM): Promise<void> {
    const seq = (readSeq.get(agent.id) ?? 0) + 1;
    readSeq.set(agent.id, seq);
    const current = () => readSeq.get(agent.id) === seq;
    const readAtom = agentDocsReadAtom(agent.id);
    try {
        const [cwd, rtn] = await Promise.all([
            resolveCwd(agent.transcriptPath, agent.blockId),
            RpcApi.AgentDocsCommand(TabRpcClient, {
                blockid: agent.blockId,
                transcriptpath: agent.transcriptPath,
            }),
        ]);
        if (current()) {
            globalStore.set(agentDocsAtom(agent.id), rtn?.docs ?? []);
            globalStore.set(readAtom, { loaded: true, cwd, failure: null });
        }
    } catch (e) {
        if (current()) {
            const failure = (e instanceof Error ? e.message : String(e ?? "")) || "The read failed with no message.";
            globalStore.set(readAtom, { ...globalStore.get(readAtom), loaded: true, failure });
        }
    }
}

// reads the list when a view showing it mounts and at each of the agent's turn ends
export function useAgentDocsRefresh(agent: AgentVM): void {
    const idle = agent.state === "idle";
    useEffect(() => {
        fireAndForget(() => loadAgentDocs(agent));
    }, [agent.id, agent.transcriptPath, agent.blockId, idle]);
}

// the list is re-read at the click (cached server-side), so a doc written since the last read routes to Docs
export async function besideTabFor(agent: AgentVM, file: { path: string; line: number | null }): Promise<WorkspaceTab> {
    await loadAgentDocs(agent);
    const { cwd } = globalStore.get(agentDocsReadAtom(agent.id));
    const abs = resolvePeekPath(file.path, cwd, "");
    const doc = abs == null ? null : globalStore.get(agentDocsAtom(agent.id)).find((d) => sameRepoPath(d.path, abs));
    return doc != null ? { kind: "docs", selected: doc.path } : { kind: "file", path: file.path, line: file.line };
}

// openBeside's guard, decided at the click so the caller knows whether to fall back; the tab opens once the list is
// read, and openBeside's second check drops it if the user has left the agent meanwhile
export function openFileBeside(
    model: AgentsViewModel,
    agentId: string,
    file: { path: string; line: number | null },
    event?: { ctrlKey: boolean }
): boolean {
    if (event?.ctrlKey || globalStore.get(model.surfaceAtom) !== "agent" || !rendersNow(model, agentId)) {
        return false;
    }
    const agent = globalStore.get(model.agentsAtom).find((a) => a.id === agentId);
    if (agent == null) {
        return false;
    }
    fireAndForget(async () => {
        openBeside(model, agentId, await besideTabFor(agent, file));
    });
    return true;
}
