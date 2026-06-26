// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Activity surface (handoff parity: Wave-cockpit-live.dc.html:543-575). Recent cross-project event
// feed, type-filterable, grouped by project. Loads on mount via loadActivity. Jump is live-only:
// ended sessions render no Jump button (deferred to the Sessions surface).

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import type { ActivityEvent, ActivityType } from "./activityevents";
import { activityEventsAtom, applyFilter, groupByProject, loadActivity } from "./activitystore";
import type { AgentsViewModel } from "./agents";
import { formatAge } from "./agentsviewmodel";

const TYPE_META: Record<ActivityType, { label: string; color: string }> = {
    started: { label: "Started", color: "var(--color-success)" },
    asked: { label: "Asked", color: "var(--color-asking)" },
    committed: { label: "Committed", color: "var(--color-accent)" },
    errored: { label: "Errored", color: "var(--color-error)" },
    finished: { label: "Finished", color: "var(--color-muted)" },
};

const CHIPS: { key: ActivityType | "all"; label: string }[] = [
    { key: "all", label: "All events" },
    { key: "asked", label: "Asked" },
    { key: "errored", label: "Errored" },
    { key: "committed", label: "Committed" },
    { key: "started", label: "Started" },
    { key: "finished", label: "Finished" },
];

function ago(now: number, ts: number): string {
    return now - ts < 60_000 ? "just now" : `${formatAge(now - ts)} ago`;
}

function jump(model: AgentsViewModel, e: ActivityEvent): void {
    if (!e.live || !e.liveId) {
        return;
    }
    globalStore.set(model.focusIdAtom, e.liveId);
    globalStore.set(model.terminalTargetAtom, undefined);
    globalStore.set(model.surfaceAtom, "agent");
}

export function ActivitySurface({ model }: { model: AgentsViewModel }) {
    const events = useAtomValue(activityEventsAtom);
    const filter = useAtomValue(model.activityFilterAtom);
    const now = useAtomValue(model.nowAtom);
    useEffect(() => {
        void loadActivity(model);
    }, [model]);
    const groups = groupByProject(applyFilter(events, filter));
    return (
        <div className="absolute inset-0 overflow-y-auto bg-background">
            <div className="mx-auto max-w-[820px] px-[30px] pb-[70px] pt-[30px]">
                <div className="mb-5">
                    <h1 className="text-[25px] font-bold tracking-[-0.02em] text-primary">Activity</h1>
                    <p className="text-[13.5px] text-secondary">Every agent event, grouped by project.</p>
                </div>
                <div className="mb-7 flex flex-wrap gap-2">
                    {CHIPS.map((c) => {
                        const active = filter === c.key;
                        const dot = c.key !== "all" ? TYPE_META[c.key].color : undefined;
                        return (
                            <button
                                key={c.key}
                                type="button"
                                onClick={() => globalStore.set(model.activityFilterAtom, c.key)}
                                className={cn(
                                    "cursor-pointer rounded-[8px] border px-[13px] py-[6px] text-[12px] font-medium",
                                    active
                                        ? "border-accent bg-accentbg text-accent-soft"
                                        : "border-border bg-surface text-ink-mid hover:border-edge-strong"
                                )}
                            >
                                {dot ? (
                                    <span className="mr-1.5" style={{ color: dot }}>
                                        ●
                                    </span>
                                ) : null}
                                {c.label}
                            </button>
                        );
                    })}
                </div>
                {groups.length === 0 ? (
                    <div className="mt-10 text-center text-[13px] text-muted">No recent activity.</div>
                ) : (
                    groups.map((g) => (
                        <div key={g.project} className="mb-[30px]">
                            <div className="mb-1.5 flex items-center gap-2.5">
                                <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-accent-soft">
                                    {g.project}
                                </span>
                                <div className="h-px flex-1 bg-border" />
                                {g.attn > 0 ? (
                                    <span className="rounded-[5px] bg-accentbg px-1.5 font-mono text-[9.5px] font-semibold text-asking">
                                        {g.attn} need you
                                    </span>
                                ) : null}
                                <span className="font-mono text-[10.5px] font-semibold text-muted">{g.count}</span>
                            </div>
                            {g.events.map((e) => (
                                <div key={e.id} className="flex gap-4 border-b border-edge-faint px-1 py-3.5 hover:bg-surface">
                                    <span className="w-[42px] shrink-0 pt-0.5 text-right font-mono text-[11.5px] text-muted">
                                        {now - e.ts < 60_000 ? "now" : formatAge(now - e.ts)}
                                    </span>
                                    <span
                                        className="mt-1 h-[9px] w-[9px] shrink-0 rounded-full"
                                        style={{ backgroundColor: TYPE_META[e.type].color }}
                                    />
                                    <div className="min-w-0 flex-1">
                                        <div className="text-[13.5px] leading-[1.5] text-secondary">
                                            <span className="font-mono text-[13px] font-semibold text-primary">{e.agentName}</span> {e.text}
                                        </div>
                                        <div className="mt-[5px] flex items-center gap-2">
                                            <span
                                                className="font-mono text-[10px] font-medium uppercase tracking-[0.06em]"
                                                style={{ color: TYPE_META[e.type].color }}
                                            >
                                                {TYPE_META[e.type].label}
                                            </span>
                                            <span className="font-mono text-[10.5px] text-muted">{ago(now, e.ts)}</span>
                                        </div>
                                    </div>
                                    {e.live ? (
                                        <button
                                            type="button"
                                            onClick={() => jump(model, e)}
                                            className="shrink-0 cursor-pointer self-center rounded-[7px] border border-border px-[11px] py-[5px] text-[11.5px] font-medium text-ink-mid hover:border-accent hover:text-accent-soft"
                                        >
                                            Jump →
                                        </button>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
