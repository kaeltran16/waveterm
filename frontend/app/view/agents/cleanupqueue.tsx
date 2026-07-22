// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Cleanup queue (Wave "Memory upkeep options" design, option A): saved notes the distiller flagged as
// outdated. A calm maintenance section below the Saved groups — quieter than the amber Pending band.
// superseded (strong) sorts before stale (weak) and reads slightly more prominent. Removal is one
// click but always a human action; "Clear all superseded" confirms first. Hidden when empty.

import { composerReveal } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { confirmPruneAllSuperseded, memPruneAtom, prune } from "./memstore";
import { reasonMeta, typeMeta } from "./memtypes";

const COLLAPSED = 5;

function CleanupRow({ c }: { c: MemoryPruneCandidate }) {
    const t = typeMeta(c.type);
    const r = reasonMeta(c.reason);
    const superseded = c.reason === "superseded";
    return (
        <li
            className={cn(
                "flex items-center gap-[13px] rounded-[11px] border px-[14px] py-[12px] transition-colors duration-150 hover:border-edge-strong",
                superseded ? "border-edge-mid bg-surface-raised" : "border-edge-faint bg-surface/60"
            )}
        >
            <span
                className={cn(
                    "min-w-[82px] flex-none rounded-[5px] px-[8px] py-[3px] text-center font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em]",
                    t.pillClass,
                    t.tintClass
                )}
            >
                {t.label}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-ink-hi">{c.title}</span>
            <span
                className={cn(
                    "flex-none rounded-full px-[8px] py-[2px] font-mono text-[9px] font-semibold uppercase tracking-[0.06em]",
                    r.textClass,
                    r.bgClass
                )}
            >
                {c.reason}
            </span>
            <button
                title="Remove"
                onClick={() => void prune(c.path)}
                className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[8px] border border-edge-mid text-muted hover:border-error/45 hover:bg-error/10 hover:text-error"
            >
                <Trash2 size={14} />
            </button>
        </li>
    );
}

export function CleanupQueue() {
    const candidates = useAtomValue(memPruneAtom);
    const [open, setOpen] = useState(false);
    const [expanded, setExpanded] = useState(false);
    if (candidates.length === 0) return null;
    const shown = expanded ? candidates : candidates.slice(0, COLLAPSED);
    const hidden = candidates.length - shown.length;
    const supersededCount = candidates.filter((c) => c.reason === "superseded").length;
    return (
        <section className="mt-[30px]">
            <div className="mb-[6px] flex items-center gap-[10px]">
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    aria-expanded={open}
                    className="flex items-center gap-[10px] text-left"
                >
                    {open ? (
                        <ChevronDown className="h-3 w-3 flex-none text-muted" />
                    ) : (
                        <ChevronRight className="h-3 w-3 flex-none text-muted" />
                    )}
                    <h2 className="font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-hi">
                        To clean up
                    </h2>
                    <span className="rounded-full bg-ink-mid/12 px-[8px] py-[2px] font-mono text-[11px] font-semibold text-ink-mid">
                        {candidates.length}
                    </span>
                    <span className="text-[11.5px] text-muted">
                        the distiller flags outdated saved notes — you remove them
                    </span>
                </button>
                <div className="flex-1" />
                {supersededCount > 0 && (
                    <button
                        onClick={() => confirmPruneAllSuperseded(supersededCount)}
                        className="flex-none rounded-[7px] border border-edge-strong px-[11px] py-[5px] text-[11px] font-semibold text-ink-mid hover:border-error/40 hover:text-error"
                    >
                        Clear all superseded
                    </button>
                )}
            </div>
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        key="body"
                        variants={composerReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="overflow-hidden"
                    >
                        <div className="mb-[13px] h-px bg-gradient-to-r from-edge-mid to-transparent" />
                        <ul className="flex flex-col gap-[8px]">
                            {shown.map((c) => (
                                <CleanupRow key={c.path} c={c} />
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
                    </motion.div>
                )}
            </AnimatePresence>
        </section>
    );
}
