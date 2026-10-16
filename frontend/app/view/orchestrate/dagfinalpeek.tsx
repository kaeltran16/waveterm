// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The final stage's peek, in the shell beside its node: the verifier, each step with its command, the running
// output or how the stage ended, and the End final stage form.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import type { AgentVM } from "../agents/agentsviewmodel";
import { jumpToAgent } from "../agents/channelsprimitives";
import { finalRowFocusId, isFinalStageId, type FinalStageView } from "../agents/finalstage";
import { dagModalAgentsContextAtom } from "./dagmodalstate";
import { finalGlyph } from "./dagnodes";
import { DagPeekCard, type PeekPlace } from "./dagpeekcard";

export function DagFinalPeek({
    group,
    owner,
    view,
    place,
}: {
    group: TaskGroup;
    owner: Run;
    view: FinalStageView;
    place: PeekPlace;
}) {
    const agentsCtx = useAtomValue(dagModalAgentsContextAtom);
    const hasVerifier = verifierTabId(group, owner, agentsCtx?.agents) != null;
    return (
        <DagPeekCard
            place={place}
            attrs={{ "data-dag-final-peek": "" }}
            label="Final verification details"
            closeLabel="Close final stage details"
            glyph={finalGlyph(view.tone)}
            title="Final verification"
            meta={<span>final · round {view.round}</span>}
            hint={hasVerifier ? "double-click opens the verifier · Esc closes" : "Esc closes"}
        >
            {null}
        </DagPeekCard>
    );
}

// the current round's verifier session, when its tab is in the roster
export function verifierTabId(group: TaskGroup, owner: Run, agents: AgentVM[] | undefined): string | undefined {
    if (agents == null) return undefined;
    const id = finalRowFocusId({ runId: owner.id, dag: group }, agents);
    return isFinalStageId(id) ? undefined : id;
}

// openFinalFromGraph opens the verifier in Agent, from the peek's link, a double-click or Enter. With no
// verifier session in the roster there is nothing to open.
export function openFinalFromGraph(group: TaskGroup, owner: Run): void {
    const ctx = globalStore.get(dagModalAgentsContextAtom);
    const tabId = verifierTabId(group, owner, ctx?.agents);
    if (ctx != null && tabId != null) jumpToAgent(ctx.model, tabId);
}
