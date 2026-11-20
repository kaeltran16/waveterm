// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: what the Rendered transcript's gone card says: why the brainstorm is not drawn, and a brainstorm the user closed
// is a row rather than a gone card. The close record lives here because the pane's Run step closes the brainstorm
// (closeBrainstorm) and the transcript reads it back.

import { globalStore } from "@/app/store/jotaiStore";
import type { PrimitiveAtom } from "jotai";
import { atom } from "jotai";
import { brainstormGoneText } from "./brainstormmodel";

// what closing deleted, for the row a removed brainstorm with a record draws
export type CloseRecord = { topic: string; canvas?: string };

// keyed by the brainstorm file's path, like the answer records: in memory, so after a restart a removed brainstorm
// reads as removed and claims no close
export const brainstormClosedAtom = atom<Record<string, CloseRecord>>({}) as PrimitiveAtom<Record<string, CloseRecord>>;

export function recordClose(path: string, rec: CloseRecord): void {
    globalStore.set(brainstormClosedAtom, { ...globalStore.get(brainstormClosedAtom), [path]: rec });
}

// what a merged run with its final check passed tells before Close
export function closeDetail(topic: string, canvas: string | undefined): string {
    const deletes = `.superpowers/brainstorm/${topic}${canvas ? ` and the ${canvas} canvas` : ""}`;
    return `The final check passed. The spec stays in docs/. The brainstorm file and its mockups were scaffolding for the design: closing deletes ${deletes}.`;
}

export function closedRowText(rec: CloseRecord): string {
    const gone = rec.canvas ? `its file and the ${rec.canvas} canvas were deleted` : "its file was deleted";
    return `You closed the brainstorm · ${gone}`;
}

export type GoneView =
    | { kind: "unreadable"; title: string; error: string; path: string }
    // path is set only when text does not already name it (a run worktree's line names the folder instead)
    | { kind: "removed"; title: string; text: string; path: string | null }
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
    const line = brainstormGoneText(s.path);
    return {
        kind: "removed",
        title: `${s.topic}'s brainstorm file is gone`,
        text: `${line} The answers above stay in the transcript.`,
        path: line.includes(s.path) ? null : s.path,
    };
}
