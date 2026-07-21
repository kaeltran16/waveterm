// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Archived view (Wave "Memory upkeep options" design, option A): notes the gardener auto-archived
// (decay / drift). The quietest, most dormant upkeep section — sits at the bottom, dimmer than the
// cleanup queue. This is the reversibility surface for the gardener's automatic actions: Restore is
// one click. Hidden when empty.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Undo2 } from "lucide-react";
import { useState } from "react";
import { memArchivedAtom, restoreArchived } from "./memstore";
import { reasonMeta, relativeAge, typeMeta } from "./memtypes";

const COLLAPSED = 4;

function ArchivedRow({ a }: { a: MemoryArchivedNote }) {
    const t = typeMeta(a.type);
    const r = reasonMeta(a.reason);
    return (
        <li className="flex items-center gap-[12px] rounded-[10px] border border-edge-faint bg-surface/40 px-[13px] py-[10px] opacity-85 transition-all duration-150 hover:border-edge-mid hover:opacity-100">
            <span
                className={cn(
                    "min-w-[78px] flex-none rounded-[5px] px-[7px] py-[2px] text-center font-mono text-[9px] font-semibold uppercase tracking-[0.05em]",
                    t.pillClass,
                    t.tintClass
                )}
            >
                {t.label}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-mid">{a.title || a.id}</span>
            <span
                className={cn(
                    "flex-none rounded-full px-[8px] py-[2px] font-mono text-[9px] font-semibold uppercase tracking-[0.06em]",
                    r.textClass,
                    r.bgClass
                )}
            >
                {a.reason}
            </span>
            <span className="flex-none font-mono text-[10.5px] text-muted">{relativeAge(a.archivedat)}</span>
            <button
                title="Restore"
                onClick={() => fireAndForget(() => restoreArchived(a.path))}
                className="flex h-[28px] w-[28px] flex-none items-center justify-center rounded-[8px] border border-edge-mid text-muted hover:border-accent hover:bg-accent/10 hover:text-accent-soft"
            >
                <Undo2 size={14} />
            </button>
        </li>
    );
}

export function ArchivedView() {
    const archived = useAtomValue(memArchivedAtom);
    const [expanded, setExpanded] = useState(false);
    if (archived.length === 0) return null;
    const shown = expanded ? archived : archived.slice(0, COLLAPSED);
    const hidden = archived.length - shown.length;
    return (
        <section className="mt-[30px]">
            <div className="mb-[6px] flex items-center gap-[10px]">
                <h2 className="font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-mid">
                    Archived
                </h2>
                <span className="rounded-full bg-ink-mid/8 px-[8px] py-[2px] font-mono text-[11px] font-semibold text-muted">
                    {archived.length}
                </span>
                <span className="text-[11.5px] text-muted">
                    auto-archived by the gardener — dormant, fully recoverable
                </span>
                <div className="flex-1" />
            </div>
            <div className="mb-[13px] h-px bg-gradient-to-r from-edge-faint to-transparent" />
            <ul className="flex flex-col gap-[7px]">
                {shown.map((a) => (
                    <ArchivedRow key={a.path} a={a} />
                ))}
            </ul>
            {hidden > 0 && (
                <button
                    onClick={() => setExpanded(true)}
                    className="mt-[2px] px-[2px] py-[4px] font-mono text-[11.5px] font-semibold text-muted hover:text-ink-mid"
                >
                    show {hidden} more ↓
                </button>
            )}
        </section>
    );
}
