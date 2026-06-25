// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import type { TabModel } from "@/app/store/tab-model";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { buildAskAnswers, canSubmitAsk, type AgentVM } from "./agentsviewmodel";
import { CockpitSurface } from "./cockpitsurface";
import { liveAgentsAtom } from "./liveagents";
import { mockAgentsAtom, USE_MOCK_AGENTS } from "./mockagents";

export type SurfaceKey =
    | "cockpit"
    | "agent"
    | "activity"
    | "channels"
    | "sessions"
    | "files"
    | "memory"
    | "usage";

export class AgentsViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    viewIcon = atom<string>("robot");
    viewName = atom<string>("Agents");
    noPadding = atom(true);
    agentsAtom: Atom<AgentVM[]>;
    // the term blockId the Agent surface renders; undefined = no terminal open
    terminalTargetAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;

    // orchestration state lifted off the surface's useStates (spec §4); surfaces read/write via globalStore
    surfaceAtom = atom<SurfaceKey>("cockpit");
    nowAtom = atom(Date.now());
    cursorIdAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;
    cockpitSelIdAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;
    orderAtom = atom<string[]>([]) as PrimitiveAtom<string[]>;
    backgroundedIdsAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;
    dismissedAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;
    answerSelAtom = atom<Record<string, Record<number, Set<number>>>>({}) as PrimitiveAtom<
        Record<string, Record<number, Set<number>>>
    >;
    answerTabAtom = atom<Record<string, number>>({}) as PrimitiveAtom<Record<string, number>>;
    sentIdsAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;
    focusIdAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;
    focusReplyAtom = atom(false);

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.viewType = "agents";
        // DEV-only: swap in the throwaway mock roster (see mockagents.ts). Never active in a prod build.
        this.agentsAtom = USE_MOCK_AGENTS && getApi().getIsDev() ? mockAgentsAtom : liveAgentsAtom;
    }

    // openTerminal routes to the interim Agent surface (spec §6): set the target block, clear any focused
    // transcript, switch surface. The Agent surface renders CockpitFocusPane; the controller starts on render.
    openTerminal(agentId: string) {
        const agent = globalStore.get(this.agentsAtom).find((a) => a.id === agentId);
        globalStore.set(this.terminalTargetAtom, agent?.blockId);
        globalStore.set(this.focusIdAtom, undefined);
        globalStore.set(this.surfaceAtom, "agent");
    }

    // Shared by the cockpit grid and the Agent surface. Validates against the model atoms, fires the RPC
    // once, and marks the ask sent so the answer bar locks.
    submitAnswer(agentId: string) {
        const agent = globalStore.get(this.agentsAtom).find((a) => a.id === agentId);
        const sent = globalStore.get(this.sentIdsAtom);
        if (!agent || sent.has(agentId)) {
            return;
        }
        const qs = agent.ask?.questions ?? [];
        const sel = globalStore.get(this.answerSelAtom)[agentId] ?? {};
        const oref = agent.ask?.oref;
        if (!canSubmitAsk(qs, sel) || !oref) {
            return;
        }
        fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { oref, answers: buildAskAnswers(qs, sel) }));
        globalStore.set(this.sentIdsAtom, new Set(sent).add(agentId));
    }

    get viewComponent(): ViewComponent {
        return CockpitSurface;
    }
}
