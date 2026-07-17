// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The right-rail "Recent activity" list, extracted as a self-subscribing leaf so a live stream
// chunk (liveEntriesByIdAtom / lastActivityByIdAtom) or the 1s nowAtom tick re-renders ONLY this
// component — not CockpitSurface and not the agent grid. Takes only stable inputs (the agent roster
// + the model); reads the whole-map transcript atoms and nowAtom internally.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import type { AgentsViewModel } from "./agents";
import { formatAge, type AgentVM } from "./agentsviewmodel";
import { InlineMarkdown } from "./inlinemarkdown";
import { lastActivityByIdAtom, liveEntriesByIdAtom } from "./livetranscript";
import { buildRecentActivity, RECENT_ACTIVITY_LIMIT } from "./recentactivity";

// recent-activity dot color by agent state (matches the in-view StatusDot palette)
const RECENT_DOT: Record<string, string> = {
    asking: "var(--color-warning)",
    working: "var(--color-accent)",
    idle: "var(--color-muted)",
};

// Renders null when there's no recent activity, so CockpitRail's section stays visually empty
// exactly as before (the section header/list only appears when there is something to show).
export function RecentActivityRail({
    agents,
    model,
    onSelectAgent,
}: {
    agents: AgentVM[];
    model: AgentsViewModel;
    onSelectAgent: (id: string) => void;
}) {
    const now = useAtomValue(model.nowAtom);
    const entriesById = useAtomValue(liveEntriesByIdAtom);
    const lastActivityById = useAtomValue(lastActivityByIdAtom);
    const recent = buildRecentActivity(agents, entriesById, lastActivityById, RECENT_ACTIVITY_LIMIT, now);
    if (recent.length === 0) {
        return null;
    }
    return (
        <div>
            <div className="mb-3 flex items-center justify-between">
                <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                    Recent activity
                </h3>
                <button
                    type="button"
                    onClick={() => globalStore.set(model.surfaceAtom, "sessions")}
                    className="cursor-pointer border-0 bg-transparent text-[11.5px] text-accent"
                >
                    View all →
                </button>
            </div>
            <div className="flex flex-col">
                {recent.map((e) => (
                    <button
                        key={e.id}
                        type="button"
                        onClick={() => onSelectAgent(e.id)}
                        className="flex w-full gap-[11px] border-b border-border py-[9px] text-left hover:bg-white/[0.03]"
                    >
                        <span
                            className="mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full"
                            style={{ backgroundColor: RECENT_DOT[e.state] }}
                        />
                        <div className="min-w-0 flex-1">
                            <div className="text-[12px] leading-[1.4] text-secondary">
                                <span className="font-mono font-semibold text-primary">{e.agent}</span>{" "}
                                <InlineMarkdown text={e.text} />
                            </div>
                            <div className="mt-[3px] font-mono text-[10px] text-muted">
                                {e.typeLabel} ·{" "}
                                {now - e.ts < 60_000 ? "just now" : `${formatAge(now - e.ts)} ago`}
                            </div>
                        </div>
                    </button>
                ))}
            </div>
        </div>
    );
}
