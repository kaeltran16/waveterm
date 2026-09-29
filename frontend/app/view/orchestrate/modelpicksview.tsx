// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useWaveObjectValue } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { useState } from "react";
import { shortModel } from "../agents/modelname";
import { dagActionError, useDagGroup } from "./dagstore";
import { leadModelsPayload, pickRows, picksBanner, setModelPayload, type PickModel, type PickRow } from "./modelpicks";
import { workersRoute } from "./taskroute";
import type { TimelineLayout } from "./timelinefilter";

const MONO_META = "font-mono text-[10.5px] text-muted";

function usePicksSource(dagOref: string, runId: string): { group: TaskGroup; owner: Run } | null {
    const [group] = useDagGroup(dagOref);
    const [owner] = useWaveObjectValue<Run>(`run:${runId}`);
    return group != null && owner != null ? { group, owner } : null;
}

// the "lead" choice clears the task's pin, which lands it on the workers route: the lead's own model on a
// Reviewer picks run, since choosing Reviewer picks clears the workers route
function leadShort(group: TaskGroup, owner: Run): string {
    return shortModel(workersRoute(group, owner).model);
}

export function ModelPicksBanner({ dagOref, runId }: { dagOref: string; runId: string }) {
    const src = usePicksSource(dagOref, runId);
    const banner = src ? picksBanner(src.group, src.owner) : null;
    if (banner == null) return null;
    return (
        <div
            data-model-picks-banner
            className="flex flex-none items-center gap-2.5 border-b border-border bg-surface-raised px-4 py-2"
        >
            <span className="size-[7px] flex-none rounded-full bg-success" />
            <span className="text-[12.5px] text-ink-hi">
                Plan review passed and put{" "}
                <b className="font-semibold">
                    {banner.onLight} of {banner.total} tasks
                </b>{" "}
                on sonnet. They run as picked unless you change them.
            </span>
            <span className="flex-1" />
            <span className={MONO_META}>no need to act</span>
        </div>
    );
}

export function ModelPicksPanel({
    dagOref,
    runId,
    layout,
}: {
    dagOref: string;
    runId: string;
    layout: TimelineLayout;
}) {
    const src = usePicksSource(dagOref, runId);
    const [rowError, setRowError] = useState<{ taskId: string; text: string } | null>(null);
    const [bulkError, setBulkError] = useState<string | null>(null);
    const rows = src ? pickRows(src.group, src.owner) : [];
    if (src == null || !rows.some((r) => r.waiting)) return null;
    const { group } = src;
    const lead = leadShort(group, src.owner);

    // a refusal (the task started meanwhile, or this machine cannot run the model) stays on the row it came from
    const setModel = (taskId: string, model: PickModel) => {
        setRowError(null);
        RpcApi.DagActionCommand(TabRpcClient, setModelPayload(group, taskId, model)).catch((e) => {
            setRowError({ taskId, text: dagActionError("setmodel", taskId, e) });
        });
    };
    const allToLead = () => {
        setBulkError(null);
        RpcApi.DagActionCommand(TabRpcClient, leadModelsPayload(group)).catch((e) => {
            setBulkError(e instanceof Error ? e.message : String(e));
        });
    };

    return (
        <div
            data-model-picks
            className={cn(
                "flex max-h-[45%] flex-none flex-col border-b border-border bg-surface",
                layout === "rail" ? "border-l" : "border-t"
            )}
        >
            <div className="flex flex-none items-baseline gap-2.5 px-4 pt-3 pb-2">
                <span className="text-[13px] font-semibold text-ink-hi">Model picks</span>
                <span className={MONO_META}>from the plan reviewer</span>
                <span className="flex-1" />
                <button
                    type="button"
                    onClick={allToLead}
                    className="cursor-pointer rounded-md border border-edge-mid px-2.5 py-0.5 text-[11px] font-semibold text-secondary hover:border-edge-strong hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                >
                    Put waiting tasks back on {lead}
                </button>
            </div>
            {bulkError && <div className="px-4 pb-1.5 text-[11px] text-error">{bulkError}</div>}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
                {rows.map((row, i) => (
                    <PickRowView
                        key={row.id}
                        row={row}
                        lead={lead}
                        first={i === 0}
                        error={rowError?.taskId === row.id ? rowError.text : null}
                        onSet={(model) => setModel(row.id, model)}
                    />
                ))}
            </div>
            <div className="flex-none border-t border-border px-4 py-2.5 text-[11px] leading-[1.45] text-muted">
                A task that already started keeps its model. If it fails, retry it on {lead} from its card.
            </div>
        </div>
    );
}

function PickRowView({
    row,
    lead,
    first,
    error,
    onSet,
}: {
    row: PickRow;
    lead: string;
    first: boolean;
    error: string | null;
    onSet: (model: PickModel) => void;
}) {
    const note = !row.waiting ? "" : row.changed ? "you changed it" : "waiting";
    return (
        <div
            data-model-pick={row.id}
            className={cn("flex flex-col gap-1.5 px-2 py-2", !first && "border-t border-edge-faint")}
        >
            <div className="flex items-center gap-2">
                <span className={cn(MONO_META, "w-[34px] flex-none")}>{row.id}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-hi" title={row.title}>
                    {row.title}
                </span>
                {row.waiting ? (
                    <div
                        role="group"
                        aria-label={`${row.id} model`}
                        className="flex flex-none gap-0.5 rounded-[7px] border border-border bg-surface-raised p-0.5"
                    >
                        <ToggleButton on={row.model === "sonnet"} label="sonnet" onClick={() => onSet("sonnet")} />
                        <ToggleButton on={row.model === "lead"} label={lead} onClick={() => onSet("lead")} />
                    </div>
                ) : (
                    <span className="flex flex-none items-center gap-1.5 font-mono text-[10.5px] text-success">
                        <span className="size-[7px] rounded-full bg-success animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none" />
                        running on {row.runningModel}
                    </span>
                )}
            </div>
            <div className="flex gap-2 pl-[42px]">
                <span className="flex-1 text-[11.5px] leading-[1.4] text-ink-mid">{row.reason}</span>
                <span className={cn("font-mono text-[10.5px]", row.changed ? "text-accent-soft" : "text-muted")}>
                    {note}
                </span>
            </div>
            {error && <div className="pl-[42px] text-[11px] text-error">{error}</div>}
        </div>
    );
}

function ToggleButton({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            aria-pressed={on}
            onClick={on ? undefined : onClick}
            className={cn(
                "cursor-pointer rounded-[5px] px-2 py-0.5 font-mono text-[10.5px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                on ? "bg-accentbg text-accent-soft" : "text-ink-mid hover:text-ink-hi"
            )}
        >
            {label}
        </button>
    );
}
