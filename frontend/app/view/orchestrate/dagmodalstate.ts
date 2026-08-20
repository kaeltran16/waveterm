// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { DagDraftRequest } from "@/app/view/agents/composercommand";
import type { DagDraft } from "./draftmodel";
import { selectedTaskIdAtom } from "./dagstore";
import { atom, type PrimitiveAtom } from "jotai";

export type DagModalState =
    | { kind: "decomposing"; request: DagDraftRequest; error: string }
    | { kind: "draft"; request: DagDraftRequest; draft: DagDraft; error: string }
    | { kind: "launching"; request: DagDraftRequest; draft: DagDraft; error: string }
    | { kind: "live"; channelId: string; runId: string; dagOref: string; error: string };

export type DagModalAction =
    | { type: "open-draft"; request: DagDraftRequest }
    | { type: "open-live"; channelId: string; runId: string; dagOref: string }
    | { type: "close" };

export const dagModalStateAtom = atom<DagModalState | null>(null) as PrimitiveAtom<DagModalState | null>;

export function reduceDagModalState(state: DagModalState | null, action: DagModalAction): DagModalState | null {
    switch (action.type) {
        case "open-draft":
            return { kind: "decomposing", request: action.request, error: "" };
        case "open-live":
            return {
                kind: "live",
                channelId: action.channelId,
                runId: action.runId,
                dagOref: action.dagOref,
                error: "",
            };
        case "close":
            return state != null && !canDismissDagModal(state) ? state : null;
    }
}

function dispatch(action: DagModalAction): void {
    globalStore.set(dagModalStateAtom, reduceDagModalState(globalStore.get(dagModalStateAtom), action));
}

function resetSelection(): void {
    globalStore.set(selectedTaskIdAtom, null);
}

export function openDagDraft(request: DagDraftRequest): void {
    resetSelection();
    dispatch({ type: "open-draft", request });
}

export function openDagLive(channelId: string, runId: string, dagOref: string): void {
    resetSelection();
    dispatch({ type: "open-live", channelId, runId, dagOref });
}

export function canDismissDagModal(state: DagModalState | null): boolean {
    return state?.kind !== "launching";
}

export function closeDagModal(): void {
    if (!canDismissDagModal(globalStore.get(dagModalStateAtom))) {
        return;
    }
    resetSelection();
    dispatch({ type: "close" });
}

if (import.meta.env.DEV && typeof window !== "undefined") {
    window.__waveDagModalFixture = {
        setState: (state: DagModalState | null) => {
            resetSelection();
            globalStore.set(dagModalStateAtom, state);
        },
    };
}

declare global {
    interface Window {
        __waveDagModalFixture?: {
            setState: (state: DagModalState | null) => void;
        };
    }
}
