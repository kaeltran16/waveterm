// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The run's dag child questions and the human's answers to them. Children's own session cards are
// invisible to the human, so the parent-run surface shows the questions that are the human's to answer.
// The engine publishes dag:child-ask (scoped to the dag + owning run) when the queue changes, and this
// store refreshes the list from the asks RPC on that event, on the card's run rows, and on mount.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom } from "jotai";
import { buildAskAnswers, canSubmitAsk, toAskQuestions, toggleSelection } from "./agentsviewmodel";
import { childAskKey } from "./childaskmodel";

export const childAsksAtom = atom<DagAskItem[]>([]);

// per-entry picks, typed answers, send times and send errors, keyed by childAskKey. In the store, not
// the card: the AnswerBar submits in the same click that records a single-select's last pick, before
// the card re-renders.
export const childAskSelAtom = atom<Record<string, Record<number, Set<number>>>>({});
export const childAskTextAtom = atom<Record<string, Record<number, string>>>({});
export const childAskSentAtom = atom<Record<string, number>>({});
export const childAskErrorAtom = atom<Record<string, string>>({});

let subscribed = false;
export function setupChildAskSubscription() {
    if (subscribed) {
        return;
    }
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "dag:child-ask",
        // any queue change may concern the visible run, and a card showing nothing must still pick up a
        // question just handed to the human; the refresh is cheap
        handler: () => refreshChildAsksFromAtom(),
    });
}

// refreshChildAsks reloads the pending asks for the run's dag. Errors (dag gone, server restart) leave
// the current list — the next event or mount refreshes it again.
export function refreshChildAsks(channelId: string, runId: string) {
    if (!channelId || !runId) {
        return;
    }
    fireAndForget(async () => {
        try {
            const rtn = await RpcApi.DagAsksCommand(TabRpcClient, { channelid: channelId, runid: runId });
            globalStore.set(childAsksAtom, rtn?.asks ?? []);
        } catch {
            // dag may be gone; keep the current list
        }
    });
}

// refreshChildAsksFromAtom re-queries using the last run ids seen (stored alongside the list).
let lastCtx: { channelId: string; runId: string } | null = null;
export function refreshChildAsksFromAtom() {
    if (lastCtx) {
        refreshChildAsks(lastCtx.channelId, lastCtx.runId);
    }
}

// bindChildAsks remembers the run whose asks the surface shows and loads them once.
export function bindChildAsks(channelId: string, runId: string) {
    if (lastCtx?.channelId === channelId && lastCtx?.runId === runId && globalStore.get(childAsksAtom).length > 0) {
        return;
    }
    lastCtx = { channelId, runId };
    refreshChildAsks(channelId, runId);
}

export function toggleChildAnswer(ask: DagAskItem, qi: number, oi: number) {
    const key = childAskKey(ask);
    const all = globalStore.get(childAskSelAtom);
    const multiSelect = ask.questions[qi]?.multiselect ?? false;
    globalStore.set(childAskSelAtom, { ...all, [key]: toggleSelection(all[key] ?? {}, qi, oi, multiSelect) });
}

export function setChildAnswerText(ask: DagAskItem, qi: number, value: string) {
    const key = childAskKey(ask);
    const all = globalStore.get(childAskTextAtom);
    globalStore.set(childAskTextAtom, { ...all, [key]: { ...(all[key] ?? {}), [qi]: value } });
}

function withoutKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
    const next = { ...rec };
    delete next[key];
    return next;
}

// submitChildAnswer sends the entry's answers once every question has one. A failed send drops the sent
// mark and records the error, so the entry is answerable again and says why.
export function submitChildAnswer(channelId: string, runId: string, ask: DagAskItem) {
    const key = childAskKey(ask);
    const questions = toAskQuestions(ask.questions);
    const selections = globalStore.get(childAskSelAtom)[key] ?? {};
    const texts = globalStore.get(childAskTextAtom)[key] ?? {};
    if (!canSubmitAsk(questions, selections, texts)) {
        return;
    }
    const answers = buildAskAnswers(questions, selections, texts);
    globalStore.set(childAskSentAtom, { ...globalStore.get(childAskSentAtom), [key]: Date.now() });
    globalStore.set(childAskErrorAtom, withoutKey(globalStore.get(childAskErrorAtom), key));
    fireAndForget(async () => {
        try {
            await RpcApi.DagAnswerCommand(TabRpcClient, {
                channelid: channelId,
                runid: runId,
                taskid: ask.taskid,
                answers,
            });
        } catch (err) {
            globalStore.set(childAskSentAtom, withoutKey(globalStore.get(childAskSentAtom), key));
            globalStore.set(childAskErrorAtom, { ...globalStore.get(childAskErrorAtom), [key]: String(err) });
        }
        refreshChildAsks(channelId, runId);
    });
}
