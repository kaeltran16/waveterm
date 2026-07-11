// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pending-review band (Wave-memory.dc.html): agent-harvested candidates shown inline at the top of
// the Memory list. Amber-accented cards with per-card Keep/Dismiss + Keep-all/Dismiss-all; selecting
// a card opens it in the detail rail's pending mode. Replaces the old collapsed ReviewTray.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Check, X } from "lucide-react";
import { keepAllPending, dismissAllPending, keepPending, dismissPending, memPendingAtom, memSelectedPendingPathAtom, selectPending } from "./memstore";
import { relativeAge, typeMeta } from "./memtypes";

export function PendingBand() {
    const pending = useAtomValue(memPendingAtom);
    const selectedPath = useAtomValue(memSelectedPendingPathAtom);
    if (pending.length === 0) return null;
    return (
        <section className="mb-[28px] mt-[8px]">
            <div className="mb-[13px] flex items-center gap-[10px] px-px">
                <div className="h-[8px] w-[8px] animate-[pulseDot_2s_infinite] rounded-full bg-asking" />
                <h2 className="font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-asking">
                    Pending review
                </h2>
                <span className="rounded-[20px] bg-asking/12 px-[8px] py-[2px] font-mono text-[11px] font-semibold text-asking">
                    {pending.length}
                </span>
                <span className="text-[11.5px] text-ink-faint">harvested from your agents — keep what's worth remembering</span>
                <div className="flex-1" />
                <button
                    onClick={() => fireAndForget(keepAllPending)}
                    className="rounded-[7px] border border-success/28 bg-success/10 px-[11px] py-[5px] font-mono text-[11.5px] font-semibold text-success hover:bg-success/18"
                >
                    Keep all
                </button>
                <button
                    onClick={() => fireAndForget(dismissAllPending)}
                    className="rounded-[7px] border border-edge-mid px-[11px] py-[5px] text-[11.5px] font-semibold text-ink-mid hover:border-edge-strong hover:text-ink-hi"
                >
                    Dismiss all
                </button>
            </div>
            <div className="flex flex-col gap-[9px]">
                {pending.map((p) => {
                    const m = typeMeta(p.type);
                    const on = p.path === selectedPath;
                    const age = relativeAge(p.capturedat);
                    return (
                        <div
                            key={p.path}
                            onClick={() => selectPending(p.path)}
                            className={cn(
                                "flex cursor-pointer gap-[12px] rounded-[11px] border border-l-[3px] bg-background px-[13px] py-[12px] hover:border-edge-strong",
                                "border-l-asking",
                                on ? "border-edge-strong" : "border-edge-faint"
                            )}
                        >
                            <div className="min-w-0 flex-1">
                                <div className="mb-[5px] flex items-center gap-[8px]">
                                    <span className={cn("flex-none rounded-[5px] px-[7px] py-[2px] font-mono text-[9px] font-semibold uppercase tracking-[0.05em]", m.pillClass)} style={{ background: "rgba(255,255,255,0.05)" }}>
                                        {m.label}
                                    </span>
                                    <span className="truncate font-mono text-[11px] font-medium text-ink-faint">
                                        {p.source} → {p.scope || "shared"}
                                    </span>
                                    <div className="flex-1" />
                                    {age && <span className="flex-none font-mono text-[10.5px] text-ink-faint">{age}</span>}
                                </div>
                                <div className="mb-[3px] line-clamp-1 text-[14px] font-semibold tracking-[-0.005em] text-ink-hi">{p.title}</div>
                                <div className="line-clamp-2 text-[12.5px] leading-[1.5] text-ink-mid">{p.body}</div>
                            </div>
                            <div className="flex flex-none flex-col gap-[6px] self-center">
                                <button
                                    title="Keep"
                                    onClick={(e) => { e.stopPropagation(); fireAndForget(() => keepPending(p.path)); }}
                                    className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border border-success/30 bg-success/10 text-success hover:bg-success/20"
                                >
                                    <Check size={14} strokeWidth={3} />
                                </button>
                                <button
                                    title="Dismiss"
                                    onClick={(e) => { e.stopPropagation(); fireAndForget(() => dismissPending(p.path)); }}
                                    className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border border-edge-mid text-ink-mid hover:border-error/40 hover:bg-error/8 hover:text-error"
                                >
                                    <X size={13} strokeWidth={2.6} />
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
