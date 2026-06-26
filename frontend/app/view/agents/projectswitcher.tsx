// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import type { AgentsViewModel } from "./agents";
import { projectsFromAgents } from "./agentsviewmodel";

// Project scope dropdown bound to projectFilterAtom. "bar" = the app-bar `/ name ▾` trigger;
// "header" = the cockpit-header bordered button. Both share one atom (spec D3).
export function ProjectSwitcher({ model, variant }: { model: AgentsViewModel; variant: "bar" | "header" }) {
    const agents = useAtomValue(model.agentsAtom);
    const filter = useAtomValue(model.projectFilterAtom);
    const [open, setOpen] = useState(false);
    const projects = projectsFromAgents(agents);
    const label = filter === "all" ? "All projects" : filter;
    const select = (v: string) => {
        globalStore.set(model.projectFilterAtom, v);
        setOpen(false);
    };
    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    "flex cursor-pointer items-center gap-1.5",
                    variant === "bar"
                        ? "rounded-[6px] px-[7px] py-1 text-[13px] font-medium text-secondary hover:bg-surface-hover hover:text-primary"
                        : "rounded-[8px] border border-edge-mid bg-surface-raised px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:border-edge-strong"
                )}
            >
                {label}
                <span className="text-[9px] text-muted">▾</span>
            </button>
            {open ? (
                <>
                    <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />
                    <div className="absolute left-0 top-[calc(100%+7px)] z-[60] w-[268px] overflow-hidden rounded-[12px] border border-edge-strong bg-surface-raised shadow-popover">
                        <div className="px-3 pb-1.5 pt-[9px]">
                            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                                Switch project
                            </span>
                        </div>
                        <div className="max-h-[46vh] overflow-y-auto px-1.5 pb-1.5">
                            <button
                                type="button"
                                onClick={() => select("all")}
                                className={cn(
                                    "flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2 py-2 text-left hover:bg-surface-hover",
                                    filter === "all" && "bg-accent/10"
                                )}
                            >
                                <span className="h-2 w-2 shrink-0 rounded-[3px] bg-muted" />
                                <span className="flex-1 truncate text-[13px] font-medium text-secondary">
                                    All projects
                                </span>
                                <span className="font-mono text-[11px] text-muted">{agents.length}</span>
                            </button>
                            {projects.map((p) => (
                                <button
                                    key={p.name}
                                    type="button"
                                    onClick={() => select(p.name)}
                                    className={cn(
                                        "flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2 py-2 text-left hover:bg-surface-hover",
                                        filter === p.name && "bg-accent/10"
                                    )}
                                >
                                    <span
                                        className={cn(
                                            "h-2 w-2 shrink-0 rounded-[3px]",
                                            p.askingCount > 0 ? "bg-warning" : "bg-success"
                                        )}
                                    />
                                    <span className="flex-1 truncate text-[13px] font-medium text-secondary">
                                        {p.name}
                                    </span>
                                    {p.askingCount > 0 ? (
                                        <span className="font-mono text-[10px] font-semibold text-warning">
                                            {p.askingCount}
                                        </span>
                                    ) : null}
                                    <span className="font-mono text-[11px] text-muted">{p.agentCount}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </>
            ) : null}
        </div>
    );
}
