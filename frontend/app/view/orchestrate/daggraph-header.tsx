import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { confirmCancelRun } from "../agents/runactions";
import { runFinished } from "../agents/runlineage";
import { useRunUsage } from "../agents/runtokenstore";
import { modelsText, summarizeUsage, usageText } from "../agents/runusage";
import { chipGroups, liveSessions, pickNext, progressText, type ChipGroup } from "./dagcanvas";
import { selectedTaskIdAtom } from "./dagstore";
import { DAG_META } from "./dagtext";
import { dagStatusPill, reviewersChip, workersChip, type DagStatusPill } from "./taskroute";

// a chip's dot: filled for the groups that are doing or done something, an open ring for those that are not
const CHIP_DOT = new Map<ChipGroup["key"], string>([
    ["attention", "border-warning bg-warning"],
    ["live", "border-accent bg-accent"],
    ["done", "border-success bg-success"],
    ["waiting", "border-ink-faint"],
    ["inert", "border-muted"],
]);

// the summary chips: how many tasks are in each group, and a click steps the selection through that group
function SummaryChips({ tasks, ended }: { tasks: TaskNode[]; ended: boolean }) {
    const selected = useAtomValue(selectedTaskIdAtom);
    return (
        <div className="flex flex-none items-center gap-1.5">
            {chipGroups(tasks, ended).map((g) => (
                <button
                    key={g.key}
                    type="button"
                    title={`Select the next task that is ${g.label}`}
                    onClick={() => {
                        const next = pickNext(tasks, g.kinds, selected);
                        if (next != null) globalStore.set(selectedTaskIdAtom, next);
                    }}
                    className="flex cursor-pointer items-center gap-1.5 rounded-[6px] border border-edge-mid bg-surface-raised px-2 py-[3px] text-[12px] text-secondary hover:border-edge-strong"
                >
                    <span className={`h-[7px] w-[7px] rounded-full border-[1.5px] ${CHIP_DOT.get(g.key)}`} />
                    {`${g.count} ${g.label}`}
                </button>
            ))}
        </div>
    );
}

const ROUTE_CHIP = `flex-none rounded-[5px] border border-edge-mid px-[7px] py-0.5 ${DAG_META}`;

const PILL_TONE: Record<DagStatusPill["tone"], string> = {
    done: "border-success/50 bg-success/10 text-success",
    waiting: "border-warning/60 bg-warning/10 text-warning",
    muted: "border-edge-mid bg-surface-raised text-ink-mid",
    active: "border-accent/50 bg-accent/10 text-accent-soft",
};

// graph header: the owning run's goal, the summary chips, the workers and reviewers routes, the derived status
// pill, cancel. No back button: the modal header above it already closes, and a second close one row down read
// as two different exits.
// No dag id either: the modal subtitle names the run, and the dag's uuid identified it to nobody.
export function DagGraphHeader({ group, owner }: { group: TaskGroup; owner: Run }) {
    const pill = dagStatusPill(group);
    const tone = PILL_TONE[pill.tone];
    const label = pill.label;
    const ended = runFinished({ dag: group, status: group.status });
    const [cancelError, setCancelError] = useState("");
    const usage = useRunUsage(group.channelid, group.runid);
    const spent = summarizeUsage(usage?.rows);
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-background px-4 py-2.5">
            <div className="min-w-48 flex-1">
                <div className="truncate text-[14px] font-bold tracking-[-0.01em] text-primary">
                    {group.title || "orchestration dag"}
                </div>
                <div className={DAG_META}>
                    parallelism {group.parallelism} · <span data-dag-progress>{progressText(group.tasks)}</span>
                    {spent ? ` · ${usageText(spent, usage.sealed)}` : ""}
                </div>
                {spent ? <div className={`truncate ${DAG_META}`}>{modelsText(spent)}</div> : null}
            </div>
            <SummaryChips tasks={group.tasks} ended={ended} />
            <span className={ROUTE_CHIP}>{workersChip(group, owner)}</span>
            <span className={ROUTE_CHIP}>{reviewersChip(group, owner)}</span>
            <span
                className={`rounded-[5px] border px-2 py-0.5 font-mono text-[11.5px] uppercase tracking-wide ${tone}`}
            >
                {label}
            </span>
            {/* awaiting-plan is cancellable too: abandoning a run at its gate is a normal answer, and the
                alternative would be approving work you do not want in order to be allowed to stop it */}
            {group.status === "running" ||
            group.status === "awaiting-plan" ||
            group.status === "plan-review" ||
            group.status === "finalizing" ? (
                <>
                    {cancelError ? (
                        <span data-dag-cancel-error className="text-[12px] text-warning">
                            {cancelError}
                        </span>
                    ) : null}
                    <button
                        type="button"
                        data-dag-cancel
                        onClick={() => {
                            setCancelError("");
                            confirmCancelRun(group.channelid, group.runid, liveSessions(group), setCancelError);
                        }}
                        className="rounded border border-edge-mid px-2.5 py-1 text-[12px] font-semibold text-secondary hover:border-warning/60 hover:text-warning"
                    >
                        Cancel
                    </button>
                </>
            ) : null}
        </div>
    );
}
