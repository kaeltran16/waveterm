// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The project Overview's Activity region: tokens per day over the last 53 weeks, from the usage scan
// (projectactivitymodel.ts).

import { skeletonClass } from "@/app/element/skeleton";
import { MONO_FAINT } from "@/app/view/jarvis/briefstyle";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatTokens } from "./agentsviewmodel";
import { RegionAlert, RegionHead, type OverviewRegionProps } from "./overviewregion";
import {
    ACTIVITY_WEEKS,
    ACTIVITY_WINDOW_DAYS,
    calendar,
    lastWeek,
    lastWeekLine,
    moveFocus,
    projectDays,
    tooltipLines,
    type DayCell,
    type DayLevel,
} from "./projectactivitymodel";
import { projectListAtom } from "./projectsstore";
import { fetchUsage } from "./usagestore";

// the board's geometry: 14px cells 4px apart (h-3.5 / gap-1), after a 28px day-label column and its 6px gap
const CELL = 14;
const CELL_STEP = CELL + 4;
const LABELS_WIDTH = 28 + 6;
const MONTH_ROW = 16;
const TIP_GAP = 6;
// the tooltip's top sits this far above its cell's, so its title lines up with the cell
const TIP_RAISE = 8;
// from this week on the tooltip opens to the cell's left, so it stays inside the region
const TIP_FLIP_WEEK = 41;
const GRID_RIGHT = LABELS_WIDTH + (ACTIVITY_WEEKS - 1) * CELL_STEP + CELL;

const LEVEL_BG: Record<DayLevel, string> = {
    0: "bg-edge-mid",
    1: "bg-accent-700",
    2: "bg-accent-500",
    3: "bg-accent-300",
    4: "bg-accent-100",
};
const SWATCH = "h-[11px] w-[11px] flex-none rounded-[3px]";
const DAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];

type Load =
    | { state: "loading" }
    | { state: "error"; reason: string }
    | { state: "ok"; reply: CommandGetUsageStatsRtnData };
type Pos = { week: number; row: number };

const startOfDayMs = (day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
};

function useActivity(path: string, attempt: number): Load {
    const [load, setLoad] = useState<Load>({ state: "loading" });
    useEffect(() => {
        setLoad({ state: "loading" });
        let live = true;
        fetchUsage(ACTIVITY_WINDOW_DAYS)
            .then((reply) => live && setLoad({ state: "ok", reply }))
            .catch((e) => {
                console.warn(`project overview: usage read failed for ${path}:`, e);
                const reason = (e instanceof Error ? e.message : String(e)).replace(/\.$/, "");
                if (live) setLoad({ state: "error", reason });
            });
        return () => {
            live = false;
        };
    }, [path, attempt]);
    return load;
}

export function ProjectActivity({ project, path }: OverviewRegionProps) {
    const [attempt, setAttempt] = useState(0);
    const load = useActivity(path, attempt);
    const channel = useAtomValue(projectListAtom).find((r) => r.name === project)?.channel;
    const view = useMemo(() => {
        if (load.state !== "ok") return null;
        const now = Date.now();
        const target = { path, channelId: channel?.oid };
        const days = projectDays(load.reply, target);
        // tracked since the earlier of the channel's creation and the first day with usage (decision 3)
        const firstDay = [...days.keys()].sort()[0];
        const since: number[] = [];
        if (channel?.createdts) since.push(channel.createdts);
        if (firstDay) since.push(startOfDayMs(firstDay));
        const trackedSinceMs = since.length > 0 ? Math.min(...since) : undefined;
        return { cal: calendar(days, { now, trackedSinceMs }), week: lastWeek(load.reply, target, now) };
    }, [load, path, channel?.oid, channel?.createdts]);

    return (
        <section aria-label="Activity" className="flex flex-col gap-2.5">
            <RegionHead
                label="Activity"
                count={view != null ? `${formatTokens(view.cal.total)} tokens` : undefined}
                aside={<span className={MONO_FAINT}>tokens per day · last 53 weeks</span>}
            />
            {load.state === "loading" ? <ActivitySkeleton /> : null}
            {load.state === "error" ? (
                <RegionAlert onRetry={() => setAttempt((n) => n + 1)}>
                    Could not read activity: {load.reason}.
                </RegionAlert>
            ) : null}
            {view != null ? (
                <>
                    <DayGrid weeks={view.cal.weeks} months={view.cal.months} />
                    <ActivityFooter>
                        <span data-activity-lastweek>
                            last 7 days <span className="text-secondary">{lastWeekLine(view.week)}</span>
                        </span>
                    </ActivityFooter>
                </>
            ) : null}
        </section>
    );
}

// the loaded calendar's own geometry with every day blank, so nothing below it moves when the read lands. One pulse
// for the grid rather than one per cell.
function ActivitySkeleton() {
    return (
        <>
            <div
                aria-hidden="true"
                className="self-start animate-pulse motion-reduce:animate-none"
                style={{ paddingTop: MONTH_ROW }}
            >
                <div className="flex gap-1.5">
                    <DayLabels />
                    <div className="flex gap-1">
                        {Array.from({ length: ACTIVITY_WEEKS }, (_, w) => (
                            <div key={w} className="flex flex-col gap-1">
                                {DAY_LABELS.map((_, r) => (
                                    <div key={r} className="h-3.5 w-3.5 rounded-[3px] bg-edge-strong" />
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
            <ActivityFooter>
                <span aria-hidden="true" className={skeletonClass("h-3 w-[220px]")} />
            </ActivityFooter>
        </>
    );
}

function ActivityFooter({ children }: { children: ReactNode }) {
    return (
        <div className={cn("flex items-center gap-3.5", MONO_FAINT)}>
            {children}
            <span className="flex-1" />
            <Legend />
        </div>
    );
}

function DayLabels() {
    return (
        <div className="flex w-7 flex-col gap-1 font-mono text-[10.5px] text-ink-faint">
            {DAY_LABELS.map((l, i) => (
                <span key={i} className="h-3.5 leading-[14px]">
                    {l}
                </span>
            ))}
        </div>
    );
}

function Legend() {
    return (
        <span data-activity-legend className="flex items-center gap-1 text-ink-faint">
            less
            {([0, 1, 2, 3, 4] as const).map((l) => (
                <span key={l} className={cn(SWATCH, LEVEL_BG[l])} />
            ))}
            more
            <span className={cn(SWATCH, "ml-2.5 border border-dashed border-edge-strong")} />
            before Arc tracked it
        </span>
    );
}

function DayGrid({ weeks, months }: { weeks: DayCell[][]; months: { label: string; week: number }[] }) {
    const last = weeks[weeks.length - 1];
    const todayRow = last.findIndex((c) => c.today);
    const [focus, setFocus] = useState<Pos>({ week: weeks.length - 1, row: todayRow });
    const [focused, setFocused] = useState(false);
    const [hover, setHover] = useState<Pos | null>(null);
    const gridRef = useRef<HTMLDivElement>(null);
    const tip = hover ?? (focused ? focus : null);

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const next = moveFocus(focus.week, focus.row, e.key, todayRow);
        if (next.week === focus.week && next.row === focus.row) return;
        e.preventDefault();
        setFocus(next);
        gridRef.current
            ?.querySelector<HTMLElement>(`[data-activity-pos="${next.week}:${next.row}"]`)
            ?.focus({ preventScroll: true });
    };

    return (
        <div className="relative self-start" style={{ paddingTop: MONTH_ROW }}>
            {months.map((m) => (
                <span
                    key={m.week}
                    className={cn("absolute top-0", MONO_FAINT)}
                    style={{ left: LABELS_WIDTH + m.week * CELL_STEP }}
                >
                    {m.label}
                </span>
            ))}
            <div className="flex gap-1.5">
                <DayLabels />
                <div
                    ref={gridRef}
                    role="group"
                    aria-label="Tokens per day, arrow keys move between days"
                    className="flex gap-1"
                    onKeyDown={onKeyDown}
                    onMouseLeave={() => setHover(null)}
                >
                    {weeks.map((week, w) => (
                        <div key={week[0].day} className="flex flex-col gap-1">
                            {week.map((cell, r) => (
                                <DaySquare
                                    key={cell.day}
                                    cell={cell}
                                    pos={`${w}:${r}`}
                                    active={tip?.week === w && tip?.row === r}
                                    tabStop={focus.week === w && focus.row === r}
                                    onEnter={() => setHover({ week: w, row: r })}
                                    onFocus={() => {
                                        setFocus({ week: w, row: r });
                                        setFocused(true);
                                    }}
                                    onBlur={() => setFocused(false)}
                                />
                            ))}
                        </div>
                    ))}
                </div>
            </div>
            {tip != null ? <DayTip cell={weeks[tip.week][tip.row]} pos={tip} /> : null}
        </div>
    );
}

function DaySquare(props: {
    cell: DayCell;
    pos: string;
    active: boolean;
    tabStop: boolean;
    onEnter: () => void;
    onFocus: () => void;
    onBlur: () => void;
}) {
    const { cell, active } = props;
    if (cell.state === "future") {
        return <div data-activity-day={cell.day} data-state="future" className="h-3.5 w-3.5" />;
    }
    return (
        <div
            data-activity-day={cell.day}
            data-activity-pos={props.pos}
            data-state={cell.state}
            data-level={cell.level}
            tabIndex={props.tabStop ? 0 : -1}
            onMouseEnter={props.onEnter}
            onFocus={props.onFocus}
            onBlur={props.onBlur}
            className={cn(
                "box-border h-3.5 w-3.5 rounded-[3px] outline-none",
                cell.state === "before" ? "border border-dashed border-edge-strong" : LEVEL_BG[cell.level],
                active ? "ring-[1.5px] ring-primary" : cell.today ? "ring-1 ring-muted" : null
            )}
        />
    );
}

function DayTip({ cell, pos }: { cell: DayCell; pos: Pos }) {
    const { title, line } = tooltipLines(cell);
    const cellLeft = LABELS_WIDTH + pos.week * CELL_STEP;
    const side =
        pos.week >= TIP_FLIP_WEEK ? { right: GRID_RIGHT - cellLeft + TIP_GAP } : { left: cellLeft + CELL + TIP_GAP };
    return (
        <div
            role="tooltip"
            data-activity-tooltip
            className="pointer-events-none absolute z-10 flex flex-col gap-0.5 whitespace-nowrap rounded-[8px] border border-edge-strong bg-surface-hover px-2.5 py-[7px] shadow-popover-sm"
            style={{ top: MONTH_ROW + pos.row * CELL_STEP - TIP_RAISE, ...side }}
        >
            <span className="text-[12px] font-semibold text-primary">{title}</span>
            <span className="font-mono text-[11px] text-secondary">{line}</span>
        </div>
    );
}
