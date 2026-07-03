// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Channels left rail: search box (visual for now), the channel list with active highlight and an
// attention dot when a channel has a worker waiting on you, and a "+ New channel" action that opens the
// project picker. Replaces the old top-bar channel pills.

import { cn } from "@/util/util";
import { useState } from "react";
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
    onDeleteChannel,
}: {
    channels: Channel[] | null;
    activeId: string | undefined;
    agents: AgentVM[];
    projects: Record<string, { path?: string }>;
    picking: boolean;
    onSelect: (id: string) => void;
    onToggleNew: () => void;
    onPickProject: (name: string, path: string) => void;
    onDeleteChannel: (id: string) => void;
}) {
    // oid of the channel awaiting a delete confirmation (two-click, no blocking dialog)
    const [confirmId, setConfirmId] = useState<string | undefined>(undefined);
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
                    const confirming = confirmId === c.oid;
                    return (
                        <div key={c.oid} className="group relative">
                            <button
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
                                    className={cn(
                                        "flex h-4 w-4 flex-none items-center justify-center rounded-[5px] border border-edge-mid bg-surface-raised font-mono text-[9px] font-bold text-ink-mid transition-opacity",
                                        confirming ? "opacity-0" : "group-hover:opacity-0"
                                    )}
                                >
                                    {chip}
                                </span>
                            </button>
                            {/* delete affordance, overlaid where the autonomy chip sits; cross-fades in on hover */}
                            <div
                                className={cn(
                                    "absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 transition-opacity",
                                    confirming ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                                )}
                            >
                                {confirming ? (
                                    <>
                                        <button
                                            type="button"
                                            title="Delete this channel"
                                            onClick={() => {
                                                setConfirmId(undefined);
                                                onDeleteChannel(c.oid);
                                            }}
                                            className="cursor-pointer rounded-[5px] border border-error/40 bg-error/15 px-1.5 py-0.5 font-mono text-[9px] font-bold text-error hover:bg-error/25"
                                        >
                                            Delete
                                        </button>
                                        <button
                                            type="button"
                                            title="Cancel"
                                            onClick={() => setConfirmId(undefined)}
                                            className="flex h-4 w-4 cursor-pointer items-center justify-center rounded-[5px] border border-edge-mid bg-surface-raised text-muted hover:text-primary"
                                        >
                                            <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                                <path d="M5 5l10 10M15 5L5 15" />
                                            </svg>
                                        </button>
                                    </>
                                ) : (
                                    <button
                                        type="button"
                                        title="Delete channel"
                                        onClick={() => setConfirmId(c.oid)}
                                        className="flex h-4 w-4 cursor-pointer items-center justify-center rounded-[5px] border border-edge-mid bg-surface-raised text-muted hover:border-error hover:text-error"
                                    >
                                        <svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M4 6h12" />
                                            <path d="M8 6V4.6A1.4 1.4 0 0 1 9.4 3.2h1.2A1.4 1.4 0 0 1 12 4.6V6" />
                                            <path d="M6.2 6l.6 9.2A1.5 1.5 0 0 0 8.3 16.7h3.4a1.5 1.5 0 0 0 1.5-1.5L13.8 6" />
                                        </svg>
                                    </button>
                                )}
                            </div>
                        </div>
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
