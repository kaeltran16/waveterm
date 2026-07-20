// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Archived view: notes the gardener auto-archived (decay / drift). Recoverable with one click — this
// is the reversibility surface for the gardener's automatic actions. Hidden when empty.

import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight, Undo2 } from "lucide-react";
import { useState } from "react";
import { memArchivedAtom, restoreArchived } from "./memstore";
import { relativeAge } from "./memtypes";

export function ArchivedView() {
    const archived = useAtomValue(memArchivedAtom);
    const [open, setOpen] = useState(false);
    if (archived.length === 0) return null;
    return (
        <div className="border-b border-edge-faint px-[12px] py-[8px]">
            <button
                className="flex items-center gap-[6px] text-[11px] font-mono uppercase tracking-wide text-ink-mid"
                onClick={() => setOpen((v) => !v)}
            >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {archived.length} archived
            </button>
            {open && (
                <ul className="mt-[6px] flex flex-col gap-[4px]">
                    {archived.map((a) => (
                        <li
                            key={a.path}
                            className="flex items-center gap-[8px] rounded-sm bg-surface/60 px-[8px] py-[6px]"
                        >
                            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-high">{a.title || a.id}</span>
                            <span className="shrink-0 text-[10px] font-mono uppercase text-ink-mid">{a.reason}</span>
                            <span className="shrink-0 text-[10px] text-ink-faint">{relativeAge(a.archivedat)}</span>
                            <button
                                title="Restore"
                                className="text-ink-mid hover:text-accent"
                                onClick={() => fireAndForget(() => restoreArchived(a.path))}
                            >
                                <Undo2 size={14} />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
