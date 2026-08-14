// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Efforts Stage subject: every effort, newest-updated first, one row each. The briefing's
// overflow destination — clicking a row jumps to the briefing with that effort expanded.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn } from "@/util/util";
import { useEffect, useState } from "react";
import { stateRpcTimeoutMs } from "./briefingstore";
import { buildEffortCard } from "./effortmodel";
import { openORef } from "./openref";
import { STAGE_GUTTER, STAGE_SCROLLER } from "./stagemeasure";

export function EffortsListView({ model }: { model: AgentsViewModel }) {
    const [efforts, setEfforts] = useState<EffortSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = (): void => {
        setError(null);
        setEfforts(null);
        RpcApi.EffortListCommand(TabRpcClient, {}, { timeout: stateRpcTimeoutMs })
            .then((rtn) => setEfforts(rtn.efforts ?? []))
            .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    };

    useEffect(load, []);

    return (
        <div className={cn(STAGE_SCROLLER, "min-h-0 flex-1")}>
            <div className={cn(STAGE_GUTTER, "flex flex-col gap-4 py-4")} aria-live="polite">
                {error != null ? (
                    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface px-4 py-3">
                        <span className="text-[13px] font-semibold text-primary">Couldn't load initiatives.</span>
                        <span className="text-[12px] text-secondary">{error}</span>
                        <button
                            type="button"
                            onClick={load}
                            className="mt-1 w-fit cursor-pointer rounded-[7px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-primary"
                        >
                            Retry
                        </button>
                    </div>
                ) : null}
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
                        <div className="flex flex-col gap-1">
                            {efforts.map((e) => {
                                const card = buildEffortCard(e);
                                return (
                                    <button
                                        key={e.oref}
                                        type="button"
                                        data-jarvis-briefing-row
                                        data-row-kind="effort"
                                        aria-label={e.title + ", " + card.countLine}
                                        onClick={() => void openORef(model, e.oref)}
                                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-left transition-colors duration-[140ms] hover:bg-surface-hover"
                                    >
                                        <span className="min-w-0 flex-1 flex-col">
                                            <span className="block min-w-0 truncate text-[12.5px] font-medium text-primary">
                                                {e.title}
                                            </span>
                                            <span className="mt-[2px] block truncate font-mono text-[9.5px] text-muted">
                                                {card.countLine}
                                            </span>
                                        </span>
                                        <span
                                            className={cn(
                                                "flex-none rounded-[4px] px-1.5 py-[2px] font-mono text-[9.5px] font-semibold uppercase",
                                                e.status === "blocked"
                                                    ? "bg-asking/15 text-asking"
                                                    : e.status === "done"
                                                      ? "bg-success/15 text-success"
                                                      : "bg-surface-raised text-secondary"
                                            )}
                                        >
                                            {e.status}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )
                ) : null}
            </div>
        </div>
    );
}
