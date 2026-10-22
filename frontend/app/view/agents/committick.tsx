// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as WOS from "@/app/store/wos";
import { atom, useAtomValue, type Atom } from "jotai";
import { Check } from "lucide-react";
import { hasCommittedWork } from "./commitmark";

const NO_BLOCK: Atom<Block | undefined> = atom(undefined as Block | undefined);

/** Whether the agent is done and its latest work is committed (see commitmark.ts). */
export function useCommitDone(blockId: string | undefined, done: boolean): boolean {
    const block = useAtomValue(blockId ? WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)) : NO_BLOCK);
    return hasCommittedWork(block?.meta, done);
}

/** The tick that stands in for a done agent's status dot: its latest work committed, or its quick run done. */
export function CommitTick({ runDone }: { runDone?: boolean }) {
    const title = runDone ? "Done, its run finished" : "Done, latest work committed";
    return (
        <span title={title} className="flex shrink-0 items-center">
            <Check size={12} strokeWidth={2.4} aria-label={title} className="text-success" />
        </span>
    );
}
