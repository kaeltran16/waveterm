// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The attention/action card family — the ask and cancel pieces. The pipeline
// rail and run body that first shared them were removed. Presentational + action-dispatch only; all
// derivations come from runmodel.ts.

import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { CircleAlert } from "lucide-react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { AttentionBanner, AttentionCard } from "./attentioncard";
import { AskRow, jumpToAgent } from "./channelsprimitives";
import { cancellingRunIdsAtom, confirmCancelRun, stopRunWorker, stoppingWorkerIdsAtom } from "./runactions";
import { cancelSurvivors, runLiveWorkers } from "./runmodel";

export function AskCard({ model, agent, kind }: { model: AgentsViewModel; agent: AgentVM; kind: "clarify" | "fork" }) {
    return (
        <AttentionCard className="mt-3 max-w-[760px]" glow>
            <AttentionBanner
                glyph="diamond"
                label={kind === "clarify" ? "Clarifying question" : "Escalated to you — a decision Jarvis can't make"}
            />
            <div className="px-3.5 py-3">
                <AskRow model={model} agent={agent} />
            </div>
        </AttentionCard>
    );
}

// The run's Cancel control: confirms before stopping live workers, and shows a transient "Cancelling…"
// (disabled) while the synchronous CancelRunCommand waits out each worker. `className` carries each call
// site's own styling; the disabled affordance is shared.
export function CancelRunButton({
    channelId,
    run,
    agents,
    model,
    className,
}: {
    channelId: string;
    run: Run;
    agents: AgentVM[];
    model: AgentsViewModel;
    className: string;
}) {
    const cancelling = useAtomValue(cancellingRunIdsAtom).has(run.id);
    const lineage = useAtomValue(model.lineageAtom);
    return (
        <button
            type="button"
            disabled={cancelling}
            onClick={() => confirmCancelRun(channelId, run.id, runLiveWorkers(run, agents, lineage).length)}
            className={`${className} disabled:opacity-60`}
        >
            {cancelling ? "Cancelling…" : "Cancel run"}
        </button>
    );
}

// Partial-failure surface: on a *cancelled* run whose owned workers are still alive (the bulk kill missed
// one, or a resync revived it), the run must not read as a clean cancel. Renders nothing unless there are
// survivors; otherwise an error-toned card listing each survivor with Take control + a per-worker Stop.
// Derived from the live roster (cancelSurvivors), so a survivor that exits or is stopped drops out.
export function CancelSurvivorsCard({
    model,
    channelId,
    run,
    agents,
}: {
    model: AgentsViewModel;
    channelId: string;
    run: Run;
    agents: AgentVM[];
}) {
    const stopping = useAtomValue(stoppingWorkerIdsAtom);
    const survivors = cancelSurvivors(run, agents);
    if (survivors.length === 0) {
        return null;
    }
    const n = survivors.length === 1 ? "1 worker" : `${survivors.length} workers`;
    return (
        <div className="relative mt-3 max-w-[760px] overflow-hidden rounded-lg border border-error/40 bg-error/10 px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
                <CircleAlert size={13} aria-hidden className="flex-none text-error" />
                <span className={cn(REGION_LABEL, "text-error")}>Cancelled · {n} still running</span>
            </div>
            <p className="mb-3 text-[12.5px] leading-[1.5] text-secondary">
                These workers didn't stop when the run was cancelled. Stop each to finish cancelling, or take control to
                inspect it.
            </p>
            <div className="flex flex-col gap-2">
                {survivors.map((w) => {
                    const busy = stopping.has(w.id);
                    return (
                        <div key={w.id} className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-secondary">
                                {w.name}
                            </span>
                            <button
                                type="button"
                                onClick={() => jumpToAgent(model, w.id)}
                                className="flex-none rounded border border-edge-mid px-3 py-1.5 text-[11.5px] font-semibold text-secondary hover:border-edge-strong"
                            >
                                Take control
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => fireAndForget(() => stopRunWorker(channelId, run.id, `tab:${w.id}`))}
                                className="flex-none rounded border border-error/50 px-3 py-1.5 text-[11.5px] font-semibold text-error hover:bg-error/10 disabled:opacity-60"
                            >
                                {busy ? "Stopping…" : "Stop"}
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
