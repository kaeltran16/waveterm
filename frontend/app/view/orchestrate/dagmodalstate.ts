// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { DagDraftRequest } from "@/app/view/agents/composercommand";
import type { DagDraft } from "./draftmodel";
import { selectedTaskIdAtom } from "./dagstore";
import { atom, type PrimitiveAtom } from "jotai";

export type DagDraftView = "summary" | "graph";

export type DagDraftState = {
    kind: "draft";
    request: DagDraftRequest;
    draft: DagDraft;
    fallback: boolean;
    warnings: string[];
    view: DagDraftView;
    selectedTaskId: string | null;
    dirty: boolean;
    error: string;
};

export type DagLaunchingState = { kind: "launching" } & Omit<DagDraftState, "kind">;

export type DagModalState =
    | { kind: "decomposing"; requestId: number; request: DagDraftRequest; error: string }
    | DagDraftState
    | DagLaunchingState
    | { kind: "live"; channelId: string; runId: string; dagOref: string; error: string };

export type DagModalAction =
    | { type: "open-draft"; requestId: number; request: DagDraftRequest }
    | { type: "open-live"; channelId: string; runId: string; dagOref: string }
    | { type: "plan-succeeded"; requestId: number; draft: DagDraft; fallback: boolean; warnings: string[] }
    | { type: "plan-failed"; requestId: number; error: string }
    | { type: "retry-plan"; requestId: number }
    | { type: "set-view"; view: DagDraftView }
    | { type: "select-task"; taskId: string | null }
    | { type: "close-drawer" }
    | { type: "apply-draft"; draft: DagDraft }
    | { type: "begin-launch" }
    | { type: "launch-failed"; error: string }
    | { type: "launch-succeeded"; channelId: string; runId: string; dagOref: string }
    | { type: "escape" }
    | { type: "close" };

export const dagModalStateAtom = atom<DagModalState | null>(null) as PrimitiveAtom<DagModalState | null>;

let nextDagPlanRequestId = 0;

export function allocateDagPlanRequestId(): number {
    nextDagPlanRequestId += 1;
    return nextDagPlanRequestId;
}

export function reduceDagModalState(state: DagModalState | null, action: DagModalAction): DagModalState | null {
    switch (action.type) {
        case "open-draft":
            return { kind: "decomposing", requestId: action.requestId, request: action.request, error: "" };
        case "open-live":
            return {
                kind: "live",
                channelId: action.channelId,
                runId: action.runId,
                dagOref: action.dagOref,
                error: "",
            };
        case "plan-succeeded":
            if (state?.kind !== "decomposing" || state.requestId !== action.requestId) return state;
            return {
                kind: "draft",
                request: state.request,
                draft: action.draft,
                fallback: action.fallback,
                warnings: [...action.warnings],
                view: "summary",
                selectedTaskId: null,
                dirty: false,
                error: "",
            };
        case "plan-failed":
            if (state?.kind !== "decomposing" || state.requestId !== action.requestId) return state;
            return { ...state, error: action.error };
        case "retry-plan":
            if (state?.kind !== "draft" && state?.kind !== "decomposing") return state;
            return { kind: "decomposing", requestId: action.requestId, request: state.request, error: "" };
        case "set-view":
            if (state?.kind !== "draft" || state.view === action.view) return state;
            return { ...state, view: action.view };
        case "select-task":
            if (state?.kind !== "draft" || state.selectedTaskId === action.taskId) return state;
            return { ...state, selectedTaskId: action.taskId };
        case "close-drawer":
            if (state?.kind !== "draft" || state.selectedTaskId == null) return state;
            return { ...state, selectedTaskId: null };
        case "apply-draft":
            if (state?.kind !== "draft" || state.draft === action.draft) return state;
            return { ...state, draft: action.draft, dirty: true };
        case "begin-launch":
            if (state?.kind !== "draft") return state;
            return { ...state, kind: "launching" } as DagLaunchingState;
        case "launch-failed":
            if (state?.kind !== "launching") return state;
            return { ...state, kind: "draft", error: action.error } as DagDraftState;
        case "launch-succeeded":
            if (state?.kind !== "launching") return state;
            return {
                kind: "live",
                channelId: action.channelId,
                runId: action.runId,
                dagOref: action.dagOref,
                error: "",
            };
        case "escape":
            if (state == null || state.kind === "launching") return state;
            if (state.kind === "draft" && state.selectedTaskId != null) return { ...state, selectedTaskId: null };
            return null;
        case "close":
            return state != null && !canDismissDagModal(state) ? state : null;
    }
}

export function dispatchDagModal(action: DagModalAction): void {
    globalStore.set(dagModalStateAtom, reduceDagModalState(globalStore.get(dagModalStateAtom), action));
}

function resetSelection(): void {
    globalStore.set(selectedTaskIdAtom, null);
}

export function openDagDraft(request: DagDraftRequest): void {
    resetSelection();
    dispatchDagModal({ type: "open-draft", requestId: allocateDagPlanRequestId(), request });
}

export function openDagLive(channelId: string, runId: string, dagOref: string): void {
    resetSelection();
    dispatchDagModal({ type: "open-live", channelId, runId, dagOref });
}

export function canDismissDagModal(state: DagModalState | null): boolean {
    return state?.kind !== "launching";
}

export function requiresRetryConfirmation(state: DagModalState | null): boolean {
    return state?.kind === "draft" && state.fallback && state.dirty;
}

export function closeDagModal(): void {
    if (!canDismissDagModal(globalStore.get(dagModalStateAtom))) {
        return;
    }
    resetSelection();
    dispatchDagModal({ type: "close" });
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
