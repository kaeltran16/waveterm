// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Run tab's Activity view: the DAG modal's lifecycle timeline, composed from timelinerail.tsx's pieces without
// its header and Relaunch lead. A row's task pill narrows the view to that task, a filter local to the view and not
// the Graph's selection; a row opens to its events.

import { useAtomValue } from "jotai";
import { AnimatePresence } from "motion/react";
import { useMemo, useState } from "react";
import type { TimelineFilter } from "../orchestrate/timelinefilter";
import { axisEnd, BURST_MS, filterGroups, groupEvents, needsDate, railRows } from "../orchestrate/timelinegroups";
import {
    ActivityStrip,
    EmptyRows,
    GapRow,
    GroupRow,
    NowMarker,
    TimelineFilterBar,
    TimelineSpine,
    useGroupEntrances,
} from "../orchestrate/timelinerail";
import { useRunEventsState } from "./runeventstore";
import { runFinished } from "./runlineage";
import type { RunViewProps } from "./workspaceruntab";

const MINUTE_MS = 60_000;
// the pane marks any silence longer than one burst, as its canvas marks the plan review's 3m wait; the modal's rail
// keeps its longer QUIET_MS
const QUIET_MS = BURST_MS;

export function ActivityView({ model, run }: RunViewProps) {
    const { events, status } = useRunEventsState(run.runId, run.channelId);
    const nowMs = useAtomValue(model.nowAtom);
    const ended = runFinished(run);
    const [filter, setFilter] = useState<TimelineFilter>("all");
    const [taskId, setTaskId] = useState<string | null>(null);
    const [openGroupId, setOpenGroupId] = useState<string | null>(null);

    const groups = useMemo(() => groupEvents(events), [events]);
    const entering = useGroupEntrances(groups, run.runId, status);
    const shown = filterGroups(groups, filter, taskId);
    const rows = railRows(shown, QUIET_MS);
    const showNow = !ended && (filter !== "task" || shown.length > 0);
    const withDate = needsDate(events, nowMs);
    const pickTask = (id: string) => {
        setTaskId(id);
        setFilter("task");
    };

    return (
        <div data-workspace-run-activity className="flex flex-col">
            <ActivityStrip
                events={events}
                endMs={axisEnd(events, ended, nowMs)}
                ended={ended}
                withDate={withDate}
                focusTaskId={filter === "task" ? taskId : null}
                className="border-t px-[18px]"
            />
            {/* Task is picked by a row's pill, so the button alone has nothing to narrow to */}
            <TimelineFilterBar
                groups={groups}
                filter={filter}
                taskId={taskId}
                onPick={(f) => (f !== "task" || taskId != null) && setFilter(f)}
                className="px-3"
            />
            {/* the extra left padding moves the rail's rows onto the pane's 18px gutter */}
            <div className="relative pt-1.5 pb-3 pl-1.5">
                {rows.length > 0 && <TimelineSpine className="left-[27px]" />}
                {showNow && <NowMarker nowMs={nowMs} withDate={withDate} />}
                {rows.length === 0 ? (
                    <EmptyRows filter={filter} status={status} hasTask={taskId != null} />
                ) : (
                    <AnimatePresence initial={false}>
                        {rows.map((row, i) =>
                            row.kind === "gap" ? (
                                <GapRow key={`gap:${i}`} ms={row.minutes * MINUTE_MS} />
                            ) : (
                                <GroupRow
                                    key={row.group.id}
                                    group={row.group}
                                    enter={entering.has(row.group.id)}
                                    withDate={withDate}
                                    open={row.group.id === openGroupId}
                                    selected={taskId != null && row.group.taskId === taskId}
                                    onClick={(expandable) => {
                                        if (expandable) {
                                            setOpenGroupId((id) => (id === row.group.id ? null : row.group.id));
                                        }
                                    }}
                                    onPickTask={pickTask}
                                />
                            )
                        )}
                    </AnimatePresence>
                )}
            </div>
        </div>
    );
}
