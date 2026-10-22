// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's toolbar: the filter field, the autonomy ladder, the profile and new-initiative controls, and
// the facts beside the title.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { RollingCount } from "@/app/view/agents/rollingcount";
import { SurfaceToolbar, ToolbarFact } from "@/app/view/agents/surfacescaffold";
import { cn } from "@/util/util";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { AutonomyLadder } from "./autonomyladderview";
import { NewInitiativeControl } from "./newinitiativecontrol";

export function BriefToolbar({
    model,
    query,
    onQuery,
    hits,
    profileOpen,
    onOpenProfile,
    projectCount,
    waiting,
    fleetLine,
}: {
    model: AgentsViewModel;
    query: string;
    onQuery: (q: string) => void;
    // the rows the filter left drawn
    hits: number;
    profileOpen: boolean;
    onOpenProfile: () => void;
    projectCount: number;
    // null until a snapshot lands: "all clear" over a load that has not landed is a lie
    waiting: number | null;
    fleetLine: string;
}) {
    const filtering = query.trim() !== "";
    return (
        <SurfaceToolbar
            title="Jarvis"
            actions={
                <>
                    <label
                        className={cn(
                            "flex h-[28px] w-[220px] flex-none items-center gap-2 rounded-[8px] border bg-surface-raised pl-2.5 focus-within:border-accent/60",
                            filtering ? "border-accent/60 pr-1" : "border-edge-mid pr-1.5"
                        )}
                    >
                        <Search
                            aria-hidden
                            size={13}
                            strokeWidth={2}
                            className={cn("flex-none", filtering ? "text-accent-soft" : "text-muted")}
                        />
                        <input
                            data-jarvis-brief-filter
                            aria-label="Filter the Brief"
                            placeholder="Filter"
                            value={query}
                            onChange={(e) => onQuery(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                    onQuery("");
                                    e.currentTarget.blur();
                                }
                            }}
                            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink-hi outline-none placeholder:text-muted"
                        />
                        {filtering ? (
                            <>
                                <span className="flex-none whitespace-nowrap font-mono text-[10.5px] text-muted">
                                    {hits} {hits === 1 ? "hit" : "hits"}
                                </span>
                                <button
                                    type="button"
                                    aria-label="Clear filter"
                                    onClick={() => onQuery("")}
                                    className="flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded-[5px] text-ink-mid hover:bg-surface-hover hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                >
                                    <X aria-hidden size={11} strokeWidth={2.2} />
                                </button>
                            </>
                        ) : (
                            <kbd className="flex-none rounded-[4px] border border-edge-strong px-[5px] font-mono text-[10.5px] leading-4 text-ink-mid">
                                /
                            </kbd>
                        )}
                    </label>
                    <AutonomyLadder />
                    {/* A real control with the control recipe's border: invariant 4 forbids camouflaging it among
                the status chips beside the title, which are borderless labels. */}
                    <button
                        type="button"
                        data-jarvis-brief-profile
                        aria-haspopup="dialog"
                        aria-expanded={profileOpen}
                        aria-label="Profile — run defaults"
                        title="Profile — run defaults"
                        onClick={onOpenProfile}
                        className="flex h-[28px] w-[28px] flex-none cursor-pointer items-center justify-center rounded-[8px] border border-edge-mid bg-surface-raised text-ink-mid hover:border-edge-strong hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                        <SlidersHorizontal aria-hidden size={14} strokeWidth={1.8} />
                    </button>
                    <NewInitiativeControl model={model} />
                </>
            }
        >
            {projectCount > 0 ? (
                <ToolbarFact>
                    all work · {projectCount} {projectCount === 1 ? "project" : "projects"}
                </ToolbarFact>
            ) : null}
            {/* the chip needs a snapshot: "all clear" over a load that has not landed is a lie */}
            {waiting != null ? (
                <span
                    data-jarvis-brief-band="waiting"
                    className={cn(
                        "flex flex-none items-center gap-[7px] rounded-[6px] px-2 py-[3px] font-mono text-[11px] font-bold transition-colors duration-[140ms]",
                        waiting === 0 ? "bg-success/15 text-success" : "bg-asking/15 text-asking"
                    )}
                >
                    <span
                        className={cn(
                            "h-[5px] w-[5px] flex-none rounded-full transition-colors duration-[140ms]",
                            waiting === 0 ? "bg-success" : "pulse-dot-slow bg-asking"
                        )}
                    />
                    {waiting === 0 ? (
                        "all clear"
                    ) : (
                        <span className="flex items-center gap-1">
                            <RollingCount value={waiting} /> waiting
                        </span>
                    )}
                </span>
            ) : null}
            <ToolbarFact>
                <span data-jarvis-brief-band="fleet">{fleetLine}</span>
            </ToolbarFact>
        </SurfaceToolbar>
    );
}
