// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Channels left rail: search box (visual for now), the channel list with active highlight and an
// attention dot when a channel has a worker waiting on you, and a "+ New channel" action that opens the
// project picker. Replaces the old top-bar channel pills.

import { cn } from "@/util/util";
import type { AgentVM } from "./agentsviewmodel";
import { channelHasAsk } from "./channelderive";
import { tierFromMeta } from "./channelmessages";
import { READ_TS_META, tierChip, unreadCount } from "./jarviscards";

export function ChannelRail({
    channels,
    activeId,
    agents,
    projects,
    picking,
    onSelect,
    onToggleNew,
    onPickProject,
}: {
    channels: Channel[] | null;
    activeId: string | undefined;
    agents: AgentVM[];
    projects: Record<string, { path?: string }>;
    picking: boolean;
    onSelect: (id: string) => void;
    onToggleNew: () => void;
    onPickProject: (name: string, path: string) => void;
}) {
    return (
        <div className="flex w-[244px] flex-none flex-col border-r border-border bg-surface">
            <div className="border-b border-edge-faint px-3.5 py-3">
                <div className="flex items-center gap-2 rounded-[8px] border border-edge-mid bg-surface-raised px-2.5 py-1.5 text-muted">
                    <span className="h-[11px] w-[11px] rounded-full border-[1.4px] border-current" />
                    <span className="text-[12.5px]">Search channels</span>
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2.5">
                <div className="flex items-center justify-between px-2 pt-1.5 pb-1">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
                        Channels
                    </span>
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[.06em] text-muted">
                        autonomy
                    </span>
                </div>
                {(channels ?? []).map((c) => {
                    const active = c.oid === activeId;
                    const tier = tierFromMeta(c.meta as Record<string, unknown> | undefined);
                    const chip = tierChip(tier);
                    const unread = unreadCount(c.messages, c.meta?.[READ_TS_META] as number | undefined);
                    return (
                        <button
                            key={c.oid}
                            type="button"
                            onClick={() => onSelect(c.oid)}
                            className={cn(
                                "flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left",
                                active ? "bg-accentbg" : "hover:bg-surface-hover"
                            )}
                        >
                            <span
                                className={cn(
                                    "font-mono text-[13px] font-semibold",
                                    active ? "text-accent" : "text-muted"
                                )}
                            >
                                #
                            </span>
                            <span
                                className={cn(
                                    "flex-1 truncate text-[13px]",
                                    active ? "font-semibold text-primary" : "font-medium text-ink-mid"
                                )}
                            >
                                {c.name}
                            </span>
                            {unread > 0 ? (
                                <span className="flex-none rounded-full bg-asking px-1.5 py-px font-mono text-[9px] font-semibold text-background">
                                    {unread}
                                </span>
                            ) : null}
                            {channelHasAsk(c, agents) ? (
                                <span
                                    title="an agent here needs you"
                                    className="h-2 w-2 flex-none rounded-full bg-asking"
                                />
                            ) : null}
                            <span
                                title={`autonomy: ${tier}`}
                                className="flex h-4 w-4 flex-none items-center justify-center rounded-[5px] border border-edge-mid bg-surface-raised font-mono text-[9px] font-bold text-ink-mid"
                            >
                                {chip}
                            </span>
                        </button>
                    );
                })}
                <button
                    type="button"
                    onClick={onToggleNew}
                    className="mt-2 flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-ink-mid hover:bg-surface-hover"
                >
                    <span className="font-mono text-[13px] font-semibold text-muted">+</span>
                    <span className="flex-1 text-[13px] font-medium">New channel</span>
                </button>
                {picking ? (
                    <div className="mt-1 flex flex-col gap-1 px-1.5">
                        {Object.entries(projects).map(([name, p]) => (
                            <button
                                key={name}
                                type="button"
                                onClick={() => onPickProject(name, p?.path ?? "")}
                                className="cursor-pointer truncate rounded-[7px] border border-border bg-surface-raised px-2.5 py-1.5 text-left text-[12px] font-medium text-ink-mid hover:border-accent"
                            >
                                {name}
                            </button>
                        ))}
                        {Object.keys(projects).length === 0 ? (
                            <span className="px-1 text-[11px] text-muted">
                                No projects — add one from the Cockpit “+ New project”.
                            </span>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
