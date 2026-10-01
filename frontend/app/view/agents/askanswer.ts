// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import type { AgentsViewModel } from "./agents";
import { askSentKey, buildAskAnswers, canSubmitAsk } from "./agentsviewmodel";

// The one answer send, shared by the Cockpit's answer bar and the palette's inline answers. Validates the
// answer against the agent's live ask, fires the RPC once, and marks the ask sent so the answer bar locks.
// Returns false when nothing was sent (no such agent, already sent, incomplete answer, no oref).
export function answerAgentAsk(
    model: Pick<AgentsViewModel, "agentsAtom" | "sentIdsAtom">,
    agentId: string,
    selections: Record<number, Set<number>>,
    texts: Record<number, string>
): boolean {
    const agent = globalStore.get(model.agentsAtom).find((a) => a.id === agentId);
    const askKey = agent ? askSentKey(agent) : undefined;
    const sent = globalStore.get(model.sentIdsAtom);
    if (!agent || askKey == null || sent.has(askKey)) {
        return false;
    }
    const qs = agent.ask?.questions ?? [];
    const oref = agent.ask?.oref;
    if (!canSubmitAsk(qs, selections, texts) || !oref) {
        return false;
    }
    const answers = buildAskAnswers(qs, selections, texts, agent.ask?.prose ?? false);
    fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { oref, answers }));
    globalStore.set(model.sentIdsAtom, new Set(sent).add(askKey));
    return true;
}
