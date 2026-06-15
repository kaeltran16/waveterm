// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn, makeIconClass } from "@/util/util";
import type { ReactNode } from "react";
import type { SessionStatus } from "./sessionviewmodel";

// Dot colors mirror the Phase 0 reporter (working/waiting) plus a neutral idle grey.
export const STATUS_COLOR: Record<SessionStatus, string> = {
    working: "#3fb950",
    waiting: "#d29922",
    idle: "#7d8590",
};

interface SessionRowProps {
    label: string;
    status: SessionStatus;
    active: boolean;
    blocked: boolean;
    pinned: boolean;
    detail?: string;
    onSelect: () => void;
    onTogglePin: () => void;
}

export function SessionRow({ label, status, active, blocked, pinned, detail, onSelect, onTogglePin }: SessionRowProps) {
    return (
        <div
            className={cn(
                "session-row group flex min-h-8 w-full cursor-pointer items-center gap-2 border-l-2 border-transparent py-1 pl-2 pr-1.5",
                active && "session-row--active border-l-[#429dff] bg-[rgba(66,157,255,0.08)]",
                blocked && "session-row--blocked border-l-[#d29922] bg-[rgba(210,153,34,0.08)]"
            )}
            onClick={onSelect}
        >
            <i
                className={makeIconClass("circle-small", true) + " text-[10px]"}
                style={{ color: STATUS_COLOR[status] }}
            />
            <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px]" title={label}>
                    {label}
                </span>
                {detail && (
                    <span className="session-row-detail truncate text-[11px] text-secondary" title={detail}>
                        {detail}
                    </span>
                )}
            </div>
            <i
                className={cn(
                    makeIconClass("thumbtack", true) + " text-[10px]",
                    pinned ? "opacity-90" : "opacity-0 group-hover:opacity-60 hover:!opacity-100"
                )}
                onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin();
                }}
            />
        </div>
    );
}

interface SessionGroupProps {
    label: string;
    count: number;
    collapsed: boolean;
    aggregateStatus: SessionStatus;
    onToggle: () => void;
    children?: ReactNode;
}

export function SessionGroup({ label, count, collapsed, aggregateStatus, onToggle, children }: SessionGroupProps) {
    return (
        <div className="flex flex-col">
            <div
                className="flex h-7 w-full cursor-pointer items-center gap-1.5 px-2 text-[11px] uppercase tracking-wide text-secondary"
                onClick={onToggle}
            >
                <i className={makeIconClass(collapsed ? "chevron-right" : "chevron-down", true) + " text-[9px]"} />
                <span className="flex-1 truncate" title={label}>
                    {label}
                </span>
                {collapsed && (
                    <i
                        className={makeIconClass("circle-small", true) + " text-[10px]"}
                        style={{ color: STATUS_COLOR[aggregateStatus] }}
                    />
                )}
                <span className="ml-1 tabular-nums opacity-70">{count}</span>
            </div>
            {!collapsed && <div className="flex flex-col">{children}</div>}
        </div>
    );
}

export type { ReactNode };
