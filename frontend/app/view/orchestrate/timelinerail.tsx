// Copyright 2026, Command Line Inc.
//
// The lifecycle timeline rail: one chronological, filterable view of a run's RunEvent log, shared by
// the DAG modal (persistent rail) and narrow layouts (drawer). All filtering and click routing lives
// in timelinefilter.ts; the event projection (title, tone, detail parsing) is reused from the run
// body's runtimeline.ts, so the two timelines cannot describe the same row differently.

import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { retryRunEvents, useRunEventsState } from "../agents/runeventstore";
import { detailOf, eventTitle, toneFor, tsLabel } from "../agents/runtimeline";
import { setActiveRunId } from "../jarvis/jarvissubjectstore";
import { selectedTaskIdAtom } from "./dagstore";
import { eventClickTarget, filterEvents, type TimelineFilter, type TimelineTarget } from "./timelinefilter";

const FILTERS: { id: TimelineFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "task", label: "Task" },
    { id: "attention", label: "Attention" },
];

export type TimelineRailProps = {
    channelId: string;
    runId: string;
    layout: "rail" | "drawer";
};

export function TimelineRail({ channelId, runId, layout }: TimelineRailProps) {
    const { events, status } = useRunEventsState(runId, channelId);
    const selectedTaskId = useAtomValue(selectedTaskIdAtom);
    const [filter, setFilter] = useState<TimelineFilter>("all");
    const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);
    // the rail layout is always expanded: its collapse control only exists in the drawer, so a
    // narrow->wide resize must not leave the panel stuck shut with nothing to reopen it.
    const open = layout === "rail" || drawerOpen;

    const rows = filterEvents(events, filter, selectedTaskId ?? undefined);
    const selectedEvent = rows.find((e) => e.id === selectedEventId);

    return (
        <div
            data-timeline-rail={layout}
            className={
                layout === "rail"
                    ? "flex h-full w-[300px] flex-none flex-col border-l border-border bg-surface"
                    : "flex max-h-[45%] flex-none flex-col border-t border-border bg-surface"
            }
        >
            <RailHeader
                count={events.length}
                status={status}
                layout={layout}
                open={open}
                onToggle={() => setDrawerOpen((o) => !o)}
                onRetry={() => fireAndForget(() => retryRunEvents(runId, channelId))}
            />
            {open && (
                <>
                    <div className="flex flex-none gap-1 border-b border-border px-2 py-1.5">
                        {FILTERS.map((f) => (
                            <button
                                key={f.id}
                                type="button"
                                onClick={() => setFilter(f.id)}
                                aria-pressed={filter === f.id}
                                className={
                                    "cursor-pointer rounded px-2 py-0.5 font-mono text-xxxs uppercase tracking-[0.08em] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent " +
                                    (filter === f.id
                                        ? "bg-accent-soft/20 text-accent"
                                        : "text-muted hover:text-secondary")
                                }
                            >
                                {f.id === "task" && selectedTaskId ? `Task · ${selectedTaskId}` : f.label}
                            </button>
                        ))}
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
                        {rows.length === 0 ? (
                            <EmptyRows filter={filter} status={status} hasTask={selectedTaskId != null} />
                        ) : (
                            rows.map((e) => (
                                <EventRow
                                    key={e.id}
                                    event={e}
                                    selected={e.id === selectedEventId}
                                    inSelectedTask={
                                        selectedTaskId != null &&
                                        detailOf<{ taskid?: string }>(e)?.taskid === selectedTaskId
                                    }
                                    onSelect={() => {
                                        setSelectedEventId(e.id);
                                        applyTarget(eventClickTarget(e), channelId);
                                    }}
                                />
                            ))
                        )}
                    </div>
                    {selectedEvent && <EventDetail event={selectedEvent} />}
                </>
            )}
        </div>
    );
}

function RailHeader({
    count,
    status,
    layout,
    open,
    onToggle,
    onRetry,
}: {
    count: number;
    status: "loading" | "live" | "error";
    layout: "rail" | "drawer";
    open: boolean;
    onToggle: () => void;
    onRetry: () => void;
}) {
    return (
        <div className="flex flex-none items-center gap-2 border-b border-border px-3 py-2">
            {layout === "drawer" && (
                <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={open}
                    className="cursor-pointer font-mono text-xxxs text-edge-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                >
                    {open ? "▼" : "▶"}
                </button>
            )}
            <span className="font-mono text-xxxs font-bold uppercase tracking-[0.08em] text-muted">Lifecycle</span>
            <span className="text-[11px] text-secondary">{count} events</span>
            <StatusPill status={status} onRetry={onRetry} />
        </div>
    );
}

// StatusPill always carries text, never color alone (spec 6.4), and never claims "live" for a load
// that has not returned.
function StatusPill({ status, onRetry }: { status: "loading" | "live" | "error"; onRetry: () => void }) {
    if (status === "error") {
        return (
            <button
                type="button"
                onClick={onRetry}
                className="ml-auto cursor-pointer text-[9px] text-warning underline decoration-dotted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
                load failed · retry
            </button>
        );
    }
    return (
        <span className={"ml-auto text-[9px] " + (status === "live" ? "text-success" : "text-muted")}>
            {status === "live" ? "● live" : "loading…"}
        </span>
    );
}

function EmptyRows({
    filter,
    status,
    hasTask,
}: {
    filter: TimelineFilter;
    status: "loading" | "live" | "error";
    hasTask: boolean;
}) {
    let text = "No lifecycle events yet";
    if (status === "loading") {
        text = "Loading history…";
    } else if (status === "error") {
        text = "History unavailable";
    } else if (filter === "task") {
        text = hasTask ? "No events for this task" : "Select a task to filter";
    } else if (filter === "attention") {
        text = "Nothing needs attention";
    }
    return <div className="px-1 py-3 text-[11px] text-muted">{text}</div>;
}

function EventRow({
    event,
    selected,
    inSelectedTask,
    onSelect,
}: {
    event: RunEvent;
    selected: boolean;
    inSelectedTask: boolean;
    onSelect: () => void;
}) {
    const taskId = detailOf<{ taskid?: string }>(event)?.taskid;
    return (
        <button
            type="button"
            onClick={onSelect}
            aria-current={selected ? "true" : undefined}
            className={
                "flex w-full cursor-pointer items-center gap-2 rounded border-l-2 px-1 py-0.5 text-left font-mono text-[11px] text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent " +
                (selected ? "bg-surface-hover " : "") +
                (inSelectedTask ? "border-accent" : "border-transparent")
            }
        >
            <span className="shrink-0 text-xxxs text-edge-strong">{tsLabel(event.ts)}</span>
            <span className={"shrink-0 text-[10px] " + toneFor(event.kind)}>●</span>
            <span className="truncate">{eventTitle(event)}</span>
            {taskId && <span className="ml-auto shrink-0 text-xxxs text-edge-strong">{taskId}</span>}
        </button>
    );
}

function EventDetail({ event }: { event: RunEvent }) {
    const detail = detailOf<Record<string, unknown>>(event);
    const entries = detail ? Object.entries(detail) : [];
    return (
        <div className="flex-none border-t border-border px-3 py-2">
            <div className="font-mono text-xxxs font-bold uppercase tracking-[0.08em] text-muted">
                {eventTitle(event)}
            </div>
            {entries.length === 0 ? (
                <div className="text-[11px] text-muted">No detail recorded</div>
            ) : (
                entries.map(([k, v]) => (
                    <div key={k} className="flex gap-2 font-mono text-[11px]">
                        <span className="shrink-0 text-edge-strong">{k}</span>
                        <span className="min-w-0 break-all text-secondary">{String(v)}</span>
                    </div>
                ))
            )}
        </div>
    );
}

// applyTarget routes a selected row. Task-scoped targets go through selectedTaskIdAtom — the single
// DAG selection source (spec 6.3) — so the graph, the worker rail and the timeline stay in step. A
// worker row selects its task rather than jumping: selection surfaces the graph rail's existing
// "Open in Agent" action, and a second navigation path is exactly what spec 6.2 forbids.
function applyTarget(target: TimelineTarget, channelId: string): void {
    switch (target.kind) {
        case "worker":
        case "dag-task":
        case "gate":
        case "merge":
            globalStore.set(selectedTaskIdAtom, target.taskId);
            return;
        case "child-run":
            setActiveRunId(channelId, target.runId);
            return;
        case "evidence":
            document.querySelector("[data-evidence-block]")?.scrollIntoView({ behavior: "smooth", block: "start" });
            return;
        default:
            return;
    }
}
