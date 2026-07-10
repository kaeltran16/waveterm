// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Cleanup queue: outdated notes the distiller flagged — superseded (strong) sorted before stale
// (weak). Removal is one click but always a human action; hidden when empty.

import { useAtomValue } from "jotai";
import { useState } from "react";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { memPruneAtom, prune } from "./memstore";

export function CleanupQueue() {
    const candidates = useAtomValue(memPruneAtom);
    const [open, setOpen] = useState(false);
    if (candidates.length === 0) return null;
    return (
        <div className="border-b border-edge-faint px-[12px] py-[8px]">
            <button
                className="flex items-center gap-[6px] text-[11px] font-mono uppercase tracking-wide text-ink-mid"
                onClick={() => setOpen((v) => !v)}
            >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {candidates.length} to clean up
            </button>
            {open && (
                <ul className="mt-[6px] flex flex-col gap-[4px]">
                    {candidates.map((c) => (
                        <li key={c.path} className="flex items-center gap-[8px] rounded-[6px] bg-surface/60 px-[8px] py-[6px]">
                            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-high">{c.title}</span>
                            <span className="shrink-0 text-[10px] font-mono uppercase text-ink-mid">{c.reason}</span>
                            <button title="Remove" className="text-ink-mid hover:text-error" onClick={() => void prune(c.path)}>
                                <Trash2 size={14} />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
