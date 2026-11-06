// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { selectedTaskIdAtom } from "./dagstore";
import { atom, type PrimitiveAtom } from "jotai";
import type { AgentsViewModel } from "../agents/agents";
import type { AgentVM } from "../agents/agentsviewmodel";
import { returnToOrigin } from "../jarvis/returnsurface";

// the dag alone: the modal reads its owner run and channel off the loaded TaskGroup, so no opener can name a
// run that disagrees with the dag (a worker run's sheet once did, and the modal showed it as the owner)
export type DagModalState = {
    kind: "live";
    dagOref: string;
    error: string;
};

// the DAG modal's id on the modal stack (modalstack.ts): on top, it takes Escape from the run sheet below it
export const DAG_MODAL_ID = "dag-modal";

// dagModalAgentsContextAtom carries the agents view model + live roster into the modal so its worker
// rail can resolve and navigate workers without a second navigation mechanism. Read-only for the
// modal; set by the Stage whenever the modal is open. Selection stays selectedTaskIdAtom.
export const dagModalAgentsContextAtom = atom<{ model: AgentsViewModel; agents: AgentVM[] } | null>(
    null
) as PrimitiveAtom<{ model: AgentsViewModel; agents: AgentVM[] } | null>;

export function setDagModalAgentsContext(model: AgentsViewModel, agents: AgentVM[]): void {
    globalStore.set(dagModalAgentsContextAtom, { model, agents });
}

export type DagModalAction = { type: "open-live"; dagOref: string } | { type: "escape" } | { type: "close" };

export const dagModalStateAtom = atom<DagModalState | null>(null) as PrimitiveAtom<DagModalState | null>;

export function reduceDagModalState(state: DagModalState | null, action: DagModalAction): DagModalState | null {
    switch (action.type) {
        case "open-live":
            return { kind: "live", dagOref: action.dagOref, error: "" };
        case "escape":
        case "close":
            return null;
        default:
            return state;
    }
}

export function dispatchDagModal(action: DagModalAction): void {
    globalStore.set(dagModalStateAtom, reduceDagModalState(globalStore.get(dagModalStateAtom), action));
}

function resetSelection(): void {
    globalStore.set(selectedTaskIdAtom, null);
}

export function openDagLive(dagOref: string): void {
    resetSelection();
    dispatchDagModal({ type: "open-live", dagOref });
}

// openDagTask opens the live DAG with one task already selected — the attention queue's "take me to
// it". Selection is set after the open because opening resets it.
export function openDagTask(dagOref: string, taskId: string): void {
    openDagLive(dagOref);
    globalStore.set(selectedTaskIdAtom, taskId);
}

// openRunSheetDag is a run sheet's way into its dag. A worker run's sheet lands on the worker's own task, since
// the dag belongs to the lead run and an unfocused graph would not say which task this sheet was about.
export function openRunSheetDag(run: Pick<Run, "dagoref" | "taskid">, taskId?: string): void {
    const dagOref = "dag:" + run.dagoref;
    const task = taskId || run.taskid;
    if (task) {
        openDagTask(dagOref, task);
    } else {
        openDagLive(dagOref);
    }
}

// dismissDagModal shuts the modal without going back: leaving Jarvis by any route takes the modal with it,
// so a later visit never finds it still open
export function dismissDagModal(): void {
    resetSelection();
    dispatchDagModal({ type: "close" });
}

export function closeDagModal(): void {
    dismissDagModal();
    returnToOrigin("dag");
}

// escapeDagModal is Esc inside the modal: a selection is the nearer thing to dismiss, so it goes first
export function escapeDagModal(): void {
    if (globalStore.get(selectedTaskIdAtom) != null) {
        resetSelection();
        return;
    }
    closeDagModal();
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
