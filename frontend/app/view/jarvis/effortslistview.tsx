// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Efforts Stage subject: every effort, newest-updated first, one row each. The briefing's
// overflow destination — clicking a row jumps to the briefing with that effort expanded. Also the
// home for finished work: "show archived" reveals the archived group, the only place unarchive and
// delete are offered (delete is gated on archived, mirroring the CLI's EC-NOT-ARCHIVED refusal).

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn } from "@/util/util";
import { useEffect, useState } from "react";
import { stateRpcTimeoutMs } from "./briefingstore";
import { partitionEfforts, type EffortCardModel } from "./effortmodel";
import { deleteEffort, setEffortStatus } from "./effortstore";
import { openORef } from "./openref";
import { STAGE_GUTTER, STAGE_SCROLLER } from "./stagemeasure";

function StatusPill({ status }: { status: string }) {
    return (
        <span
            className={cn(
                "flex-none rounded-[4px] px-1.5 py-[2px] font-mono text-[9.5px] font-semibold uppercase",
                status === "blocked"
                    ? "bg-asking/15 text-asking"
                    : status === "done"
                      ? "bg-success/15 text-success"
                      : "bg-surface-raised text-secondary"
            )}
        >
            {status}
        </span>
    );
}

function RowAction({
    children,
    onClick,
    danger,
}: {
    children: React.ReactNode;
    onClick: () => void;
    danger?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "flex-none cursor-pointer rounded-[6px] border px-2 py-[3px] font-mono text-[9.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                danger
                    ? "border-error/40 bg-error/15 text-error-soft"
                    : "border-border text-muted hover:border-edge-strong hover:text-primary"
            )}
        >
            {children}
        </button>
    );
}

function EffortRow({
    card,
    onOpen,
    children,
}: {
    card: EffortCardModel;
    onOpen: () => void;
    children?: React.ReactNode;
}) {
    return (
        <div className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-[7px] transition-colors duration-[140ms] hover:bg-surface-hover">
            <button
                type="button"
                data-jarvis-briefing-row
                data-row-kind="effort"
                aria-label={card.title + ", " + card.countLine}
                onClick={onOpen}
                className="flex min-w-0 flex-1 cursor-pointer flex-col text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
                <span className="block min-w-0 truncate text-[12.5px] font-medium text-primary">{card.title}</span>
                <span className="mt-[2px] block truncate font-mono text-[9.5px] text-muted">{card.countLine}</span>
            </button>
            {children}
            <StatusPill status={card.status} />
        </div>
    );
}

export function EffortsListView({ model }: { model: AgentsViewModel }) {
    const [efforts, setEfforts] = useState<EffortSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [showArchived, setShowArchived] = useState(false);
    // the oref awaiting a second click; any other action clears it so a stale confirm never fires.
    const [pendingDelete, setPendingDelete] = useState<string | null>(null);

    const load = (includeArchived: boolean): void => {
        setError(null);
        setEfforts(null);
        setPendingDelete(null);
        RpcApi.EffortListCommand(TabRpcClient, { includearchived: includeArchived }, { timeout: stateRpcTimeoutMs })
            .then((rtn) => setEfforts(rtn.efforts ?? []))
            .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    };

    useEffect(() => load(showArchived), [showArchived]);

    const runAction = (fn: () => Promise<void>): void => {
        setActionError(null);
        setPendingDelete(null);
        fn()
            .then(() => load(showArchived))
            .catch((e) => setActionError(e instanceof Error ? e.message : String(e)));
    };

    const { active, archived } = partitionEfforts(efforts ?? []);
    const openRow = (oref: string) => void openORef(model, oref);

    return (
        <div className={cn(STAGE_SCROLLER, "min-h-0 flex-1")}>
            <div className={cn(STAGE_GUTTER, "flex flex-col gap-4 py-4")} aria-live="polite">
                <div className="flex items-center justify-end">
                    <button
                        type="button"
                        aria-pressed={showArchived}
                        onClick={() => setShowArchived((v) => !v)}
                        className={cn(
                            "cursor-pointer rounded-[6px] border px-2.5 py-1 font-mono text-[9.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                            showArchived
                                ? "border-accent/40 bg-surface-raised text-accent-soft"
                                : "border-border text-muted hover:border-edge-strong hover:text-primary"
                        )}
                    >
                        Show archived
                    </button>
                </div>
                {error != null ? (
                    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface px-4 py-3">
                        <span className="text-[13px] font-semibold text-primary">Couldn't load initiatives.</span>
                        <span className="text-[12px] text-secondary">{error}</span>
                        <button
                            type="button"
                            onClick={() => load(showArchived)}
                            className="mt-1 w-fit cursor-pointer rounded-[7px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-primary"
                        >
                            Retry
                        </button>
                    </div>
                ) : null}
                {actionError != null ? <span className="text-[11px] text-error">{actionError}</span> : null}
                {efforts == null && error == null ? (
                    <div className="flex flex-col gap-4">
                        {[0, 1, 2].map((i) => (
                            <div
                                key={i}
                                className="h-12 animate-pulse motion-reduce:animate-none rounded-[10px] bg-surface"
                            />
                        ))}
                    </div>
                ) : null}
                {efforts != null ? (
                    efforts.length === 0 ? (
                        <div className="rounded-[10px] border border-dashed border-edge-strong px-4 py-4 text-center text-[12px] text-muted">
                            <span className="font-medium text-secondary">No initiatives yet.</span> Create one from the
                            briefing's + Initiative button, or with <span className="font-mono">wsh effort create</span>
                            .
                        </div>
                    ) : (
                        <>
                            <div className="flex flex-col gap-1">
                                {active.map((card) => (
                                    <EffortRow key={card.oref} card={card} onOpen={() => openRow(card.oref)} />
                                ))}
                            </div>
                            {showArchived && archived.length > 0 ? (
                                <div className="flex flex-col gap-1">
                                    <span className="px-2.5 font-mono text-[9.5px] font-semibold uppercase text-ink-faint">
                                        Archived
                                    </span>
                                    {archived.map((card) => (
                                        <EffortRow key={card.oref} card={card} onOpen={() => openRow(card.oref)}>
                                            <RowAction
                                                onClick={() => runAction(() => setEffortStatus(card.oref, "active"))}
                                            >
                                                unarchive
                                            </RowAction>
                                            {pendingDelete === card.oref ? (
                                                <RowAction
                                                    danger
                                                    onClick={() => runAction(() => deleteEffort(card.oref))}
                                                >
                                                    confirm delete
                                                </RowAction>
                                            ) : (
                                                <RowAction onClick={() => setPendingDelete(card.oref)}>
                                                    delete
                                                </RowAction>
                                            )}
                                        </EffortRow>
                                    ))}
                                </div>
                            ) : null}
                        </>
                    )
                ) : null}
            </div>
        </div>
    );
}
