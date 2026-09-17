// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The run's dag child questions and the human's answers to them. Children's own session cards are
// invisible to the human, so the parent-run surfaces show the questions: the Brief's run card and the
// Agent surface's details rail. The engine publishes dag:child-ask (scoped to the dag + owning run) when
// the queue changes, and this store refreshes every bound run's list from the asks RPC on that event, on
// the surfaces' run rows, and on mount.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom } from "jotai";
import { buildAskAnswers, canSubmitAsk, toAskQuestions, toggleSelection } from "./agentsviewmodel";
import { childAskKey } from "./childaskmodel";

// keyed by the owning run: two surfaces can show two runs' questions at once
export const childAsksAtom = atom<Record<string, DagAskItem[]>>({});

// per-entry picks, typed answers, send times and send errors, keyed by childAskKey. In the store, not
// the card: the AnswerBar submits in the same click that records a single-select's last pick, before
// the card re-renders.
export const childAskSelAtom = atom<Record<string, Record<number, Set<number>>>>({});
export const childAskTextAtom = atom<Record<string, Record<number, string>>>({});
export const childAskSentAtom = atom<Record<string, number>>({});
export const childAskErrorAtom = atom<Record<string, string>>({});

// runId -> channelId of every run a surface has shown
const boundRuns = new Map<string, string>();

let subscribed = false;
export function setupChildAskSubscription() {
    if (subscribed) {
        return;
    }
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "dag:child-ask",
        // any queue change may concern a shown run, and a card showing nothing must still pick up a
        // question just handed to the human; the refresh is cheap
        handler: () => boundRuns.forEach((channelId, runId) => refreshChildAsks(channelId, runId)),
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
            globalStore.set(childAsksAtom, (prev) => ({ ...prev, [runId]: rtn?.asks ?? [] }));
        } catch {
            // dag may be gone; keep the current list
        }
    });
}

// bindChildAsks remembers a run a surface shows and loads its asks once.
export function bindChildAsks(channelId: string, runId: string) {
    if (!channelId || !runId) {
        return;
    }
    const loaded = boundRuns.get(runId) === channelId && globalStore.get(childAsksAtom)[runId] != null;
    boundRuns.set(runId, channelId);
    if (!loaded) {
        refreshChildAsks(channelId, runId);
    }
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

// takeOverChildAsk moves a question the lead holds to the human. The lead is not woken; a failure (the
// lead answered first) is recorded on the entry like a failed send.
export function takeOverChildAsk(channelId: string, runId: string, ask: DagAskItem) {
    const key = childAskKey(ask);
    globalStore.set(childAskErrorAtom, withoutKey(globalStore.get(childAskErrorAtom), key));
    fireAndForget(async () => {
        try {
            await RpcApi.DagActionCommand(TabRpcClient, {
                channelid: channelId,
                runid: runId,
                taskid: ask.taskid,
                action: "takeover",
            });
        } catch (err) {
            globalStore.set(childAskErrorAtom, { ...globalStore.get(childAskErrorAtom), [key]: String(err) });
        }
        refreshChildAsks(channelId, runId);
    });
}
