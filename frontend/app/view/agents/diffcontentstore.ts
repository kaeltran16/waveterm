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
import { joinRepoPath } from "@/util/paths";
import { base64ToString } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import { pairRefsFor, type DiffSelection, type DiffSide } from "./diffcontent";

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
}

export const diffPairAtom = atom<DiffPair | null>(null) as PrimitiveAtom<DiffPair | null>;

const current = { token: "" };

export function clearDiffPair(): void {
    current.token = "";
    globalStore.set(diffPairAtom, null);
}

interface SideResult {
    text: string;
    binary: boolean;
    tooLarge: boolean;
    size: number;
}

const EMPTY_SIDE: SideResult = { text: "", binary: false, tooLarge: false, size: 0 };

async function readSide(cwd: string, path: string, side: DiffSide): Promise<SideResult> {
    if (side.kind === "worktree") {
        try {
            const data = await RpcApi.FileReadCommand(TabRpcClient, { info: { path: joinRepoPath(cwd, path) } });
            return { ...EMPTY_SIDE, text: base64ToString(data?.data64 ?? "") };
        } catch {
            // deleted from the working tree: an empty right side is exactly how that reads
            return EMPTY_SIDE;
        }
    }
    const r = await RpcApi.GitFileAtRefCommand(TabRpcClient, {
        cwd,
        ref: side.ref,
        path,
        maxbytes: MAX_DIFF_BYTES,
    });
    // missing is not a failure: the file was added on one side or deleted on the other
    return { text: r.content ?? "", binary: !!r.binary, tooLarge: !!r.toolarge, size: r.size ?? 0 };
}

export async function loadDiffPair(cwd: string, path: string, sel: DiffSelection): Promise<void> {
    const refs = pairRefsFor(sel);
    const token = `${cwd}|${path}|${JSON.stringify(refs)}`;
    // Re-reading what is already on screen is a refresh, not a navigation: the change poll replaces
    // the working-tree state every few seconds and the surface re-reads with it, so blanking here
    // would flash the skeleton on every tick. A different file or range still blanks — showing the
    // previous file's text under the new one's header is worse than showing nothing.
    const refresh = current.token === token;
    current.token = token;
    if (!refresh) {
        globalStore.set(diffPairAtom, null);
    }
    try {
        const [original, modified] = await Promise.all([
            readSide(cwd, path, refs.original),
            readSide(cwd, path, refs.modified),
        ]);
        if (current.token !== token) {
            return; // selection moved on
        }
        globalStore.set(diffPairAtom, {
            path,
            original: original.text,
            modified: modified.text,
            binary: original.binary || modified.binary,
            tooLarge: original.tooLarge || modified.tooLarge,
            size: Math.max(original.size, modified.size),
        });
    } catch {
        if (current.token === token) {
            globalStore.set(diffPairAtom, null);
        }
    }
}
