// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Review tray: agent-distilled candidates awaiting a human decision. Corrections auto-commit and
// never appear here; facts/prefs queue until approved. Collapsible; hidden entirely when empty.

import { useAtomValue } from "jotai";
import { useState } from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { acceptPending, memPendingAtom, rejectPending } from "./memstore";
import { typeMeta } from "./memtypes";

export function ReviewTray() {
    const pending = useAtomValue(memPendingAtom);
    const [open, setOpen] = useState(true);
    if (pending.length === 0) return null;
    return (
        <div className="border-b border-edge-faint px-[12px] py-[8px]">
            <button
                className="flex items-center gap-[6px] text-[11px] font-mono uppercase tracking-wide text-ink-mid"
                onClick={() => setOpen((v) => !v)}
            >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {pending.length} pending review
            </button>
            {open && (
                <ul className="mt-[6px] flex flex-col gap-[4px]">
                    {pending.map((p) => (
                        <li key={p.path} className="flex items-start gap-[8px] rounded-[6px] bg-surface/60 px-[8px] py-[6px]">
                            <span className={`mt-[3px] h-[7px] w-[7px] shrink-0 rounded-full ${typeMeta(p.type).dotClass}`} />
                            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-high">{p.body}</span>
                            <button title="Accept" className="text-ink-mid hover:text-ink-high" onClick={() => void acceptPending(p.path)}>
                                <Check size={14} />
                            </button>
                            <button title="Reject" className="text-ink-mid hover:text-ink-high" onClick={() => void rejectPending(p.path)}>
                                <X size={14} />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
