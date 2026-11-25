// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The focused agent's branch, worktree and changed files, read once for every view that shows them (the details
// rail, the header, the message box's changes row, the Changes tab) into railStateAtom.

import * as WOS from "@/app/store/wos";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue, type Atom } from "jotai";
import { useEffect } from "react";
import { checkoutFacts, railReloadKey, type CheckoutFacts } from "./agentrailmodel";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { cardCwdByIdAtom, sharedCheckoutCount } from "./cardgitstore";
import { leadLandFacts } from "./leadland";
import { loadRailForAgent, railStateAtom, type RailGitState } from "./railstore";
import { leadRunAtom, type LeadRun } from "./runlineagestore";

export const NO_BLOCK: Atom<Block | undefined> = atom(undefined as Block | undefined);
const NO_LEAD: Atom<LeadRun | undefined> = atom(undefined as LeadRun | undefined);

let holders = 0;
let loadedKey = "";
let loadedAgent = "";

// starts a read unless one for this key already serves a holder; the release forgets the key once nobody holds it,
// so the next mount reads again as the rail did on each open. A new agent blanks the list while it loads; the same
// agent's later edits reload under the list it shows.
export function holdRailGit(
    agent: Pick<AgentVM, "id" | "transcriptPath" | "blockId" | "agent" | "runId">,
    key: string
): () => void {
    holders++;
    if (key !== loadedKey) {
        const silent = loadedAgent === agent.id;
        loadedKey = key;
        loadedAgent = agent.id;
        fireAndForget(() => loadRailForAgent(agent, { silent }));
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
    // a lead's list is its run's, so it reloads as a task merges into the run's tree and when the run lands
    const lead = useAtomValue(agent.runId ? leadRunAtom(agent.runId) : NO_LEAD);
    const runKey = lead ? `${lead.merged}|${lead.run.land?.state ?? ""}|${lead.run.land?.commit ?? ""}` : "";
    const key = `${railReloadKey(agent, block?.meta?.["agent:lasteditts"])}|${runKey}`;
    useEffect(() => holdRailGit(agent, key), [key]);
    return useAtomValue(railStateAtom);
}

// what the Rendered view says about the agent's checkout (the header's subline, the message box's changes row); it
// only reads, so a caller that shows it holds useRailGit while it does
export function useCheckoutFacts(model: AgentsViewModel, agent: AgentVM): CheckoutFacts {
    const lineage = useAtomValue(model.lineageAtom);
    const git = useAtomValue(railStateAtom);
    const sharedBy = sharedCheckoutCount(agent.id, useAtomValue(cardCwdByIdAtom));
    const role = lineage.roles[agent.id];
    // a land removes the run's worktree, so a landed lead reads its run's landing, as the rail does
    const landed = role?.kind === "lead" ? leadLandFacts(lineage.runs[role.runId]) : null;
    return checkoutFacts({ git, landed, sharedBy });
}
