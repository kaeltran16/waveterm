// frontend/app/view/code/codereviewstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Review comments, module-scoped so they survive the surface unmounting (not a restart). Keyed by the
// Code project's path rather than its name: a worktree browsed outside the registry has no name of its
// own, and two checkouts of one repository hold different files.

import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { stringToBase64 } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import {
    addComment,
    clearProject,
    projectComments,
    reanchor,
    removeComment,
    reviewHandoffLine,
    reviewMarkdown,
    selectionLines,
    type ReviewComment,
    type Reviews,
} from "./codereview";
import { codeDraftsAtom, codeFileAtom, codeProjectAtom, draftKey } from "./codestore";

export interface CommentDraft {
    path: string;
    startLine: number;
    endLine: number;
    anchor: string;
}

export const codeReviewsAtom = atom<Reviews>(new Map()) as PrimitiveAtom<Reviews>;
export const codeCommentDraftAtom = atom<CommentDraft | null>(null) as PrimitiveAtom<CommentDraft | null>;
export const codeReviewSendOpenAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

// The viewer lends the store the editor's selection, or the caret as an empty one, the way codestore's
// caret readers work: the store never touches Monaco.
type EditorSelection = { startLine: number; endLine: number; endColumn: number };
let readSelection: () => EditorSelection | null = () => null;
export function setCommentSelectionReader(read: () => EditorSelection | null): void {
    readSelection = read;
}

export function reviewKey(): string | null {
    return globalStore.get(codeProjectAtom)?.path ?? null;
}

// The open file's lines as the buffer holds them, unsaved edits included; null without a text file.
export function openFileLines(): { path: string; lines: string[] } | null {
    const project = globalStore.get(codeProjectAtom);
    const file = globalStore.get(codeFileAtom);
    if (project == null || file.kind !== "text") {
        return null;
    }
    const text = globalStore.get(codeDraftsAtom).get(draftKey(project, file.path))?.text ?? file.text;
    return { path: file.path, lines: text.split(/\r?\n/) };
}

export function startComment(): void {
    const open = openFileLines();
    const sel = readSelection();
    if (open == null || sel == null) {
        return;
    }
    const { startLine, endLine } = selectionLines(sel);
    globalStore.set(codeCommentDraftAtom, {
        path: open.path,
        startLine,
        endLine,
        anchor: open.lines[startLine - 1] ?? "",
    });
}

export function cancelComment(): void {
    globalStore.set(codeCommentDraftAtom, null);
}

export function saveComment(note: string): void {
    const draft = globalStore.get(codeCommentDraftAtom);
    const key = reviewKey();
    globalStore.set(codeCommentDraftAtom, null);
    const trimmed = note.trim();
    if (draft == null || key == null || trimmed === "") {
        return;
    }
    globalStore.set(codeReviewsAtom, (r) => addComment(r, key, { id: crypto.randomUUID(), ...draft, note: trimmed }));
}

// an agent may have shifted the open file since the comments were made; other files are sent as stored
function reanchored(comments: readonly ReviewComment[]): ReviewComment[] {
    const open = openFileLines();
    return comments.map((c) => (open != null && c.path === open.path ? { ...c, ...reanchor(c, open.lines) } : c));
}

export async function sendReview(
    target: AgentVM | null,
    projectName: string
): Promise<{ ok: true } | { ok: false; message: string }> {
    const key = reviewKey();
    const comments = key == null ? [] : projectComments(globalStore.get(codeReviewsAtom), key);
    if (key == null || comments.length === 0) {
        return { ok: false, message: "There are no comments to send." };
    }
    const markdown = reviewMarkdown(projectName, reanchored(comments));
    try {
        if (target != null) {
            const { path } = await RpcApi.CodeReviewWriteCommand(TabRpcClient, { project: projectName, markdown });
            await RpcApi.ControllerInputCommand(TabRpcClient, {
                blockid: target.blockId!,
                inputdata64: stringToBase64(reviewHandoffLine(path) + "\r"),
            });
        } else {
            if (navigator.clipboard == null) {
                throw new Error("the clipboard is unavailable");
            }
            await navigator.clipboard.writeText(markdown);
        }
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return { ok: false, message: `${target != null ? "Could not send" : "Could not copy"} the review: ${reason}` };
    }
    // only what was sent: a comment added while the send was in flight stays
    globalStore.set(codeReviewsAtom, (r) => comments.reduce((acc, c) => removeComment(acc, key, c.id), r));
    return { ok: true };
}

export function confirmClearReview(): void {
    const project = globalStore.get(codeProjectAtom);
    const count = project == null ? 0 : projectComments(globalStore.get(codeReviewsAtom), project.path).length;
    if (project == null || count === 0) {
        return;
    }
    modalsModel.pushModal("ConfirmModal", {
        title: "Clear review",
        message: `Discard ${count === 1 ? "the 1 comment" : `all ${count} comments`} in ${project.name}? This cannot be undone.`,
        confirmLabel: "Clear",
        destructive: true,
        onConfirm: () => globalStore.set(codeReviewsAtom, (r) => clearProject(r, project.path)),
    });
}
