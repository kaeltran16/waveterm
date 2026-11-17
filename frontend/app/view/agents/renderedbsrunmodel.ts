// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: what the Rendered transcript's run card and gone card say. The run card reads the pane's own runStepView, so
// the card and the Run step never disagree on where the run stands; the gone card says why the brainstorm is not
// drawn, and a brainstorm the user closed is a row rather than a gone card. The close record lives here because both
// places close the brainstorm (closeBrainstorm) and both read it back.

import { globalStore } from "@/app/store/jotaiStore";
import type { PrimitiveAtom } from "jotai";
import { atom } from "jotai";
import { brainstormGoneText } from "./brainstormmodel";
import { runStepView, shortRunId, type RunStepView } from "./brainstormrunmodel";
import type { RunInfo } from "./runlineage";

// what closing deleted, for the row a removed brainstorm with a record draws
export type CloseRecord = { topic: string; canvas?: string };

// keyed by the brainstorm file's path, like the answer records: in memory, so after a restart a removed brainstorm
// reads as removed and claims no close
export const brainstormClosedAtom = atom<Record<string, CloseRecord>>({}) as PrimitiveAtom<Record<string, CloseRecord>>;

export function recordClose(path: string, rec: CloseRecord): void {
    globalStore.set(brainstormClosedAtom, { ...globalStore.get(brainstormClosedAtom), [path]: rec });
}

// what a merged run with its final check passed tells before Close: the pane's words, one source
export function closeDetail(topic: string, canvas: string | undefined): string {
    const deletes = `.superpowers/brainstorm/${topic}${canvas ? ` and the ${canvas} canvas` : ""}`;
    return `The final check passed. The spec stays in docs/. The brainstorm file and its mockups were scaffolding for the design: closing deletes ${deletes}.`;
}

export type RunCardView = {
    view: RunStepView;
    // the head's right-hand words, before Open run
    status: string;
    headline: string;
    detail: string;
    canClose: boolean;
    // a run Arc cannot find has nothing to open
    showOpen: boolean;
};

// the pane's Run step as one card: a merged run says what Close deletes, or why the brainstorm stays
export function runCardView(
    runId: string,
    run: RunInfo | undefined,
    loaded: boolean,
    topic: string,
    canvas: string | undefined
): RunCardView {
    const view = runStepView(runId, run, loaded);
    return {
        view,
        status: `Run ${shortRunId(runId)}`,
        headline: view.headline,
        detail: view.canClose ? closeDetail(topic, canvas) : (view.closeOff ?? view.detail),
        canClose: view.canClose,
        showOpen: view.state !== "missing",
    };
}

export function closedRowText(rec: CloseRecord): string {
    const gone = rec.canvas ? `its file and the ${rec.canvas} canvas were deleted` : "its file was deleted";
    return `You closed the brainstorm · ${gone}`;
}

export type GoneView =
    | { kind: "unreadable"; title: string; error: string; path: string }
    | { kind: "removed"; title: string; text: string }
    | { kind: "closed"; text: string };

// closed is brainstormClosedAtom's value: a removed brainstorm Arc closed itself is a row, one that is simply gone
// (a run's worktree removed, the file deleted by hand) is the card
export function goneView(
    why: "unreadable" | "removed",
    s: { topic: string; path: string; error: string | null },
    closed: Record<string, CloseRecord>
): GoneView {
    if (why === "unreadable") {
        return {
            kind: "unreadable",
            title: "Arc could not read this brainstorm",
            error: s.error ?? "",
            path: s.path,
        };
    }
    const rec = closed[s.path];
    if (rec != null) {
        return { kind: "closed", text: closedRowText(rec) };
    }
    return {
        kind: "removed",
        title: `${s.topic}'s brainstorm file is gone`,
        text: `${brainstormGoneText(s.path)} The answers above stay in the transcript.`,
    };
}
