// frontend/app/view/agents/diffcontentstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The diff pane's content: two full file texts, loaded from whichever pair of refs the current
// selection names. Module-level like every other store on this surface, because the surface
// unmounts on a nav switch. One loader for all three states — the selection decides the refs
// (diffcontent.ts) and nothing here knows which state it is serving.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { pairRefsFor, type DiffPairRefs, type DiffSelection, type DiffSide } from "./diffcontent";

// Monaco is comfortable well past this; the cap exists so one accidental click on a vendored bundle
// or a lockfile does not freeze the surface. Same number the patch readers cap at server-side, so a
// file this pane will refuse is a file the patch path refuses too.
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export interface DiffPair {
    path: string;
    original: string;
    modified: string;
    // set when either side is a blob git has no text for
    binary: boolean;
    // set when either side exceeds MAX_DIFF_BYTES; size is the larger side, for the message
    tooLarge: boolean;
    size: number;
    // set when the file does not exist on that side: two empty texts then read as an added or deleted
    // empty file rather than a rename. Optional so hand-built pairs (tests, fixtures) need not say.
    originalMissing?: boolean;
    modifiedMissing?: boolean;
    // the refs this pair was read from: a comment made on it is anchored to them
    refs: DiffPairRefs;
}

interface SideResult {
    text: string;
    binary: boolean;
    tooLarge: boolean;
    missing: boolean;
    size: number;
}

async function readSide(cwd: string, path: string, side: DiffSide): Promise<SideResult> {
    // the working-tree side reads the file on disk through the same reader as a ref, so it gets the
    // same size cap and binary check instead of an uncapped plain file read
    const r = await RpcApi.GitFileAtRefCommand(
        TabRpcClient,
        side.kind === "worktree"
            ? { cwd, path, ref: "", worktree: true, maxbytes: MAX_DIFF_BYTES }
            : { cwd, ref: side.ref, path: side.path ?? path, maxbytes: MAX_DIFF_BYTES }
    );
    // missing is not a failure: the file was added on one side or deleted on the other
    return {
        text: r.content ?? "",
        binary: !!r.binary,
        tooLarge: !!r.toolarge,
        missing: !!r.missing,
        size: r.size ?? 0,
    };
}

function failureMessage(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    return msg || "The read failed with no message.";
}

// One pair and its loader. The Diff surface's is the module's exports below; the workspace pane's Changes tab makes its
// own, so the tab's file never shows on the Diff surface and neither loader's in-flight read drops the other's.
export interface DiffPairSource {
    pairAtom: PrimitiveAtom<DiffPair | null>;
    // why the open file's pair could not be read; the pane shows it with a Retry in place of the skeleton
    failureAtom: PrimitiveAtom<string | null>;
    // from: the file's rename source, read on the left side in place of path
    load: (cwd: string, path: string, sel: DiffSelection, from?: string) => Promise<void>;
    // re-runs the last load, for the pane's Retry after a failed read
    retry: () => Promise<void>;
    clear: () => void;
}

export function makeDiffPairSource(): DiffPairSource {
    const pairAtom = atom<DiffPair | null>(null) as PrimitiveAtom<DiffPair | null>;
    const failureAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
    const current: { token: string; args: Parameters<DiffPairSource["load"]> | null } = { token: "", args: null };

    const clear = () => {
        current.token = "";
        current.args = null;
        globalStore.set(pairAtom, null);
        globalStore.set(failureAtom, null);
    };

    const load = async (cwd: string, path: string, sel: DiffSelection, from?: string): Promise<void> => {
        const refs = pairRefsFor(sel, from);
        const token = `${cwd}|${path}|${JSON.stringify(refs)}`;
        // Re-reading what is already on screen is a refresh, not a navigation: the change poll replaces
        // the working-tree state every few seconds and the surface re-reads with it, so blanking here
        // would flash the skeleton on every tick. A different file or range still blanks — showing the
        // previous file's text under the new one's header is worse than showing nothing.
        const refresh = current.token === token;
        current.token = token;
        current.args = [cwd, path, sel, from];
        if (!refresh) {
            globalStore.set(pairAtom, null);
            globalStore.set(failureAtom, null);
        }
        try {
            const [original, modified] = await Promise.all([
                readSide(cwd, path, refs.original),
                readSide(cwd, path, refs.modified),
            ]);
            if (current.token !== token) {
                return; // selection moved on
            }
            globalStore.set(pairAtom, {
                path,
                original: original.text,
                modified: modified.text,
                binary: original.binary || modified.binary,
                tooLarge: original.tooLarge || modified.tooLarge,
                size: Math.max(original.size, modified.size),
                originalMissing: original.missing,
                modifiedMissing: modified.missing,
                refs,
            });
            globalStore.set(failureAtom, null);
        } catch (e) {
            if (current.token === token) {
                globalStore.set(pairAtom, null);
                globalStore.set(failureAtom, failureMessage(e));
            }
        }
    };

    const retry = () => (current.args == null ? Promise.resolve() : load(...current.args));
    return { pairAtom, failureAtom, load, retry, clear };
}

// the Diff surface's pair
export const diffSurfacePair = makeDiffPairSource();
export const diffPairAtom = diffSurfacePair.pairAtom;
export const diffPairFailureAtom = diffSurfacePair.failureAtom;
export const loadDiffPair = diffSurfacePair.load;
export const retryDiffPair = diffSurfacePair.retry;
export const clearDiffPair = diffSurfacePair.clear;
