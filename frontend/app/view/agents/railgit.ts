// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The focused agent's branch, worktree and changed files, read once for every view that shows them (the details
// rail, the header, the Changes tab) into railStateAtom.

import * as WOS from "@/app/store/wos";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue, type Atom } from "jotai";
import { useEffect } from "react";
import { railReloadKey } from "./agentrailmodel";
import type { AgentVM } from "./agentsviewmodel";
import { loadRailForAgent, railStateAtom, type RailGitState } from "./railstore";

const NO_BLOCK: Atom<Block | undefined> = atom(undefined as Block | undefined);

let holders = 0;
let loadedKey = "";
let loadedAgent = "";

// starts a read unless one for this key already serves a holder; the release forgets the key once nobody holds it,
// so the next mount reads again as the rail did on each open. A new agent blanks the list while it loads; the same
// agent's later edits reload under the list it shows.
export function holdRailGit(agent: Pick<AgentVM, "id" | "transcriptPath" | "blockId">, key: string): () => void {
    holders++;
    if (key !== loadedKey) {
        const silent = loadedAgent === agent.id;
        loadedKey = key;
        loadedAgent = agent.id;
        fireAndForget(() => loadRailForAgent(agent.transcriptPath, agent.blockId, { silent }));
    }
    return () => {
        holders--;
        if (holders === 0) {
            loadedKey = "";
        }
    };
}

export function useRailGit(agent: AgentVM): RailGitState | null {
    const block = useAtomValue(
        agent.blockId ? WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", agent.blockId)) : NO_BLOCK
    );
    const key = railReloadKey(agent, block?.meta?.["agent:lasteditts"]);
    useEffect(() => holdRailGit(agent, key), [key]);
    return useAtomValue(railStateAtom);
}
