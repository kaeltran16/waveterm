// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useChangeFlash } from "@/app/element/motionhooks";
import { cardVariants, changeFlashClass, composerReveal } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import type { ChunkTone } from "@/app/view/jarvis/effortmodel";
import { effortDetailAtom, loadEffortDetail } from "@/app/view/jarvis/effortstore";
import { openTarget } from "@/app/view/jarvis/openref";
import { ChunkSegments, SEGMENT_FILL } from "@/app/view/jarvis/peek/chunksegments";
import { ALWAYS_REFETCH } from "@/app/view/jarvis/peek/peekeffort";
import { effortPeekModel } from "@/app/view/jarvis/peek/peekeffortmodel";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { initiativeChunkRows, openChunk, type InitiativeChunkRow } from "./workspaceinitiativemodel";
import { tabKey, type WorkspaceTab } from "./workspacemodel";
import { closeWorkspaceTab, updateWorkspaceTab } from "./workspacestore";

// the row's label and status word by tone: the active chunk reads brightest, a parked one in warning
const LABEL_INK: Partial<Record<ChunkTone, string>> = { active: "text-ink-hi" };
const STATUS_INK: Partial<Record<ChunkTone, string>> = {
    active: "text-accent-soft",
    blocked: "text-warning-soft",
    deferred: "text-warning-soft",
};

// The workspace pane's Initiative tab: the agent's initiative plan, read-only. The effort:update sync mounted in the
// shell keeps the cached detail current and drops a deleted one; this tab only loads it once, past any cache.
export function InitiativeTab({
    model,
    agent,
    tab,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "initiative" }>;
}) {
    const oref = "effort:" + tab.effortId;
    const effort = useAtomValue(effortDetailAtom).get(oref);
    const [failed, setFailed] = useState(false);
    // the sync drops a deleted initiative's entry, so an entry gone after the tab drew it is a deletion, not a load
    const shown = useRef(false);
    if (effort != null) {
        shown.current = true;
    }

    useEffect(() => {
        setFailed(false);
        loadEffortDetail(oref, ALWAYS_REFETCH).catch(() => setFailed(true));
    }, [oref]);

    const rows = useMemo(() => (effort != null ? initiativeChunkRows(effort) : []), [effort]);
    const key = tabKey(tab);
    if (failed || (effort == null && shown.current)) {
        return (
            <div data-workspace-initiative={tab.effortId} className="flex min-h-0 flex-1 flex-col">
                {/* the S1-States board's quiet notice, entering as an item does (moment 1) */}
                <motion.div
                    data-workspace-initiative-gone
                    variants={cardVariants}
                    initial="initial"
                    animate="animate"
                    className="flex flex-1 flex-col items-center justify-center gap-2 p-5 text-center"
                >
                    <span className="text-[13.5px] font-semibold text-secondary">This initiative is gone</span>
                    <span className="text-[12.5px] text-ink-mid">It was deleted after the agent linked it.</span>
                    <button
                        type="button"
                        data-workspace-initiative-close
                        onClick={() => closeWorkspaceTab(agent.id, key)}
                        className="mt-1 cursor-pointer rounded-[6px] border border-edge-mid bg-surface-raised px-[10px] py-1 text-[12px] font-semibold text-ink-mid hover:bg-surface-hover hover:text-ink-hi"
                    >
                        Close tab
                    </button>
                </motion.div>
            </div>
        );
    }
    if (effort == null) {
        return <div data-workspace-initiative={tab.effortId} className="flex min-h-0 flex-1 flex-col" />;
    }
    const m = effortPeekModel(effort);
    const open = openChunk(rows, tab.open);
    const toggle = (n: number) => updateWorkspaceTab(agent.id, key, { open: open === n ? null : n });
    return (
        <div
            data-workspace-initiative={tab.effortId}
            className="@container flex min-h-0 flex-1 flex-col gap-[14px] px-[18px] py-[16px]"
        >
            <div className="flex flex-none items-center gap-[10px]">
                <span className="min-w-0 flex-1 truncate text-[15.5px] font-semibold text-ink-hi">{m.title}</span>
                <span className="flex-none rounded-[6px] border border-border bg-surface-raised px-2 py-[2px] font-mono text-[10.5px] font-semibold text-accent-soft">
                    {m.status}
                </span>
            </div>
            <div className="flex flex-none flex-col gap-[7px]">
                <div className="flex items-baseline gap-2">
                    <span data-workspace-initiative-progress className="text-[12.5px] font-semibold text-secondary">
                        {m.progress}
                    </span>
                    <span className="flex-1" />
                    {m.project ? <span className="font-mono text-[10.5px] text-muted">{m.project}</span> : null}
                </div>
                <ChunkSegments segments={m.segments} />
            </div>
            <div
                role="list"
                aria-label="Chunks"
                className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[9px] border border-border bg-surface-code"
            >
                {rows.map((r) => (
                    <ChunkRow key={r.n} row={r} open={open === r.n} onToggle={() => toggle(r.n)} />
                ))}
            </div>
            <div className="flex flex-none items-center gap-2">
                <span className="text-[11.5px] text-muted">Read-only. Ask the agent to change it.</span>
                <span className="flex-1" />
                <button
                    type="button"
                    data-workspace-initiative-hub
                    onClick={() => fireAndForget(() => openTarget(model, { kind: "effort", effortId: tab.effortId }))}
                    className="cursor-pointer text-[12px] font-semibold text-accent-soft hover:text-foreground"
                >
                    Open in Hub
                </button>
            </div>
        </div>
    );
}

function ChunkRow({ row, open, onToggle }: { row: InitiativeChunkRow; open: boolean; onToggle: () => void }) {
    // a status moved by the agent mid-session washes the word that changed
    const flashing = useChangeFlash(row.status);
    const cells = (
        <>
            <span className="font-mono text-[10.5px] text-muted">{row.n}</span>
            <span aria-hidden className={cn("h-[8px] w-[8px] rounded-full", SEGMENT_FILL[row.tone])} />
            <span className={cn("truncate text-[12.5px]", LABEL_INK[row.tone] ?? "text-ink-mid")}>{row.label}</span>
            <span
                data-workspace-initiative-status
                className={cn(
                    "rounded-[4px] font-mono text-[10.5px] @max-[420px]:hidden",
                    STATUS_INK[row.tone] ?? "text-muted",
                    flashing && changeFlashClass
                )}
            >
                {row.status}
            </span>
        </>
    );
    const grid =
        "grid w-full grid-cols-[22px_16px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-[7px] text-left @max-[420px]:grid-cols-[22px_16px_minmax(0,1fr)]";
    return (
        <div
            role="listitem"
            data-workspace-initiative-chunk={row.n}
            className="flex flex-none flex-col border-t border-border first:border-t-0"
        >
            {row.openable ? (
                <button
                    type="button"
                    aria-expanded={open}
                    onClick={onToggle}
                    className={cn(
                        grid,
                        "cursor-pointer hover:bg-surface-hover",
                        open && "bg-surface-selected hover:bg-surface-selected"
                    )}
                >
                    {cells}
                </button>
            ) : (
                <div className={grid}>{cells}</div>
            )}
            <PaneReveal open={open} variants={composerReveal}>
                <div data-workspace-initiative-notes className="flex flex-col gap-2 pb-3 pl-[58px] pr-3 pt-1">
                    {row.notes.map((n, i) => (
                        <div key={i} className="flex gap-[10px] text-[12.5px] leading-[1.55]">
                            <span className="flex-none pt-px font-mono text-[11px] text-muted">{n.at}</span>
                            <span className="min-w-0 break-words text-secondary">{n.text}</span>
                        </div>
                    ))}
                    {row.older > 0 ? (
                        <span data-workspace-initiative-older className="text-[11.5px] text-muted">
                            {row.older} older {row.older === 1 ? "note" : "notes"} in Hub
                        </span>
                    ) : null}
                </div>
            </PaneReveal>
        </div>
    );
}
