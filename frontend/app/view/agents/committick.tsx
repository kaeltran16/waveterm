// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as WOS from "@/app/store/wos";
import { atom, useAtomValue, type Atom } from "jotai";
import { Check, GitBranch } from "lucide-react";
import { commitMark, type CommitMark } from "./commitmark";

const NO_BLOCK: Atom<Block | undefined> = atom(undefined as Block | undefined);

/** The agent's commit mark when it is done and its latest work is committed (see commitmark.ts). */
export function useCommitMark(blockId: string | undefined, done: boolean): CommitMark | null {
    const block = useAtomValue(blockId ? WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)) : NO_BLOCK);
    return commitMark(block?.meta, done);
}

/** The mark that stands in for a done agent's status dot: its quick run done, or its latest work committed,
 * as a branch icon when the commit sits on a worktree branch (not landed yet) and the tick otherwise. */
export function CommitTick({ runDone, commit }: { runDone?: boolean; commit?: CommitMark | null }) {
    if (!runDone && commit?.kind === "branch") {
        const title = `Done, committed on ${commit.branch}`;
        return (
            <span title={title} className="flex shrink-0 items-center">
                <GitBranch size={12} strokeWidth={2.4} aria-label={title} className="text-accent" />
            </span>
        );
    }
    const title = runDone ? "Done, its run finished" : "Done, latest work committed";
    return (
        <span title={title} className="flex shrink-0 items-center">
            <Check size={12} strokeWidth={2.4} aria-label={title} className="text-success" />
        </span>
    );
}
