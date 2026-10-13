// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as WOS from "@/app/store/wos";
import { atom, useAtomValue, type Atom } from "jotai";
import { Check } from "lucide-react";
import { hasCommittedWork } from "./commitmark";

const NO_BLOCK: Atom<Block | undefined> = atom(undefined as Block | undefined);

/** A tick when the agent's latest work is committed (see commitmark.ts); nothing otherwise. */
export function CommitTick({ blockId }: { blockId: string | undefined }) {
    const block = useAtomValue(blockId ? WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)) : NO_BLOCK);
    if (!hasCommittedWork(block?.meta)) {
        return null;
    }
    return (
        <span title="Latest work committed" className="flex shrink-0 items-center">
            <Check size={12} strokeWidth={2.4} aria-label="Latest work committed" className="text-success" />
        </span>
    );
}
