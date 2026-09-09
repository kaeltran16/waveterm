// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The plan gate: a published DAG waiting on the human before any worker spawns. It sits in the run
// transcript, where the lead's own account of what it is proposing is directly above it — the graph
// answers "what is happening now" and there is nothing happening yet.
//
// Not an AttentionCard: warning tone is for something that went wrong, and a lead publishing a plan
// is the flow working. The one thing it borrows from the attention treatment is being unmissable.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useState } from "react";
import { useDagGroup } from "./dagstore";
import { leadRouteText, planGateView, workerRouteText } from "./plangate";

// planGateGroup is the group a gate should be drawn for, or null. Keyed on the persisted gate fields
// rather than the status string: status is derived from task state on every mutation, and a card that
// keyed off it would blink out on any recompute that ran before the reader answered.
function gated(group: TaskGroup | undefined): boolean {
    return group != null && !!group.plangate && !group.planapprovedts;
}

// dagOref is a required prop rather than derived from the run: useDagGroup resolves it into a fetched
// wave object, so a run with no dag must not reach this component at all.
export function PlanGateCard({ channelId, run, dagOref }: { channelId: string; run: Run; dagOref: string }) {
    const [group] = useDagGroup(dagOref);
    const [sendingBack, setSendingBack] = useState(false);
    const [notes, setNotes] = useState("");
    const [busy, setBusy] = useState(false);

    if (!gated(group)) {
        return null;
    }
    const view = planGateView(group!);
    const act = (action: string, extra?: { notes: string }) => {
        setBusy(true);
        fireAndForget(async () => {
            try {
                await RpcApi.DagActionCommand(TabRpcClient, {
                    channelid: channelId,
                    runid: run.id,
                    taskid: "",
                    action,
                    ...extra,
                });
            } finally {
                setBusy(false);
            }
        });
    };

    return (
        <div className="mt-3 max-w-[760px] overflow-hidden rounded-[11px] border border-edge-strong bg-surface">
            <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-2.5">
                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.11em] text-accent-soft">
                    Plan gate
                </span>
                <span className="text-[13px] font-semibold text-primary">{view.shape}</span>
                <span className="font-mono text-[10.5px] text-muted">{view.width}</span>
                <div className="flex-1" />
                <span className="font-mono text-[10.5px] text-muted">{leadRouteText(run)}</span>
            </div>

            <div className="flex flex-col gap-1 px-4 py-2.5">
                {view.rows.map((row) => (
                    <div key={row.id} className="flex min-w-0 items-center gap-2.5 py-0.5">
                        <span className="w-4 shrink-0 font-mono text-[10px] text-muted">{row.n}</span>
                        <span className="w-[112px] shrink-0 truncate font-mono text-[11px] font-medium text-accent-soft">
                            {row.id}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-secondary" title={row.label}>
                            {row.label}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-muted">{row.deps}</span>
                    </div>
                ))}
            </div>

            {sendingBack ? (
                <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
                    <label
                        htmlFor="plan-gate-notes"
                        className="font-mono text-[9px] font-bold uppercase tracking-[.12em] text-muted"
                    >
                        What should change
                    </label>
                    {/* the lead is discarding this draft and writing another one; notes are what stop it
                        redrafting the same plan. Optional, because "no, think again" is a real answer. */}
                    <textarea
                        id="plan-gate-notes"
                        autoFocus
                        rows={3}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Optional — the lead reads this before its next draft"
                        className="w-full resize-none rounded-[7px] border border-edge-mid bg-background px-3 py-2 text-[12.5px] text-primary placeholder:text-muted focus-visible:border-accent focus-visible:outline-none"
                    />
                    <div className="flex items-center gap-2">
                        <span className="font-mono text-[10.5px] text-muted">
                            This plan is discarded; the lead drafts a new one.
                        </span>
                        <div className="flex-1" />
                        <button
                            type="button"
                            onClick={() => setSendingBack(false)}
                            className="cursor-pointer rounded-[6px] border border-edge-mid px-3 py-1.5 text-[12px] font-semibold text-secondary hover:border-edge-strong hover:text-primary"
                        >
                            Keep reviewing
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => act("sendback-plan", { notes })}
                            className="cursor-pointer rounded-[6px] border border-warning/60 px-3 py-1.5 text-[12px] font-semibold text-warning hover:border-warning disabled:opacity-60"
                        >
                            Send back
                        </button>
                    </div>
                </div>
            ) : (
                <div className="flex items-center gap-2.5 border-t border-border px-4 py-3">
                    <span className="font-mono text-[11px] text-secondary">{workerRouteText(run, group!)}</span>
                    <div className="flex-1" />
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => setSendingBack(true)}
                        className="cursor-pointer rounded-[6px] border border-edge-mid px-3 py-1.5 text-[12px] font-semibold text-secondary hover:border-edge-strong hover:text-primary disabled:opacity-60"
                    >
                        Send back
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => act("approve-plan")}
                        className="cursor-pointer rounded-[6px] bg-accent px-4 py-1.5 text-[12.5px] font-semibold text-background hover:bg-accenthover disabled:opacity-60"
                    >
                        Approve · start workers
                    </button>
                </div>
            )}
        </div>
    );
}
