// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn, makeIconClass } from "@/util/util";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { motion } from "motion/react";
import { modelLabel, type SessionStatus, type SubagentState } from "./sessionviewmodel";

// Dot colors mirror the Phase 0 reporter (working/waiting) plus a neutral idle grey.
export const STATUS_COLOR: Record<SessionStatus, string> = {
    working: "#3fb950",
    waiting: "#d29922",
    idle: "#7d8590",
};

// Hollow/check/cross markers — a different glyph shape than the session's filled dot, so a
// subagent never reads as a peer process (spec §6).
export const SUBAGENT_MARKER: Record<SubagentState, string> = {
    working: "◦",
    success: "✓",
    failure: "✗",
};
export const SUBAGENT_MARKER_COLOR: Record<SubagentState, string> = {
    working: "#7d8590",
    success: "#3fb950",
    failure: "#f85149",
};

interface SessionRowProps {
    label: string;
    status: SessionStatus;
    active: boolean;
    blocked: boolean;
    pinned: boolean;
    detail?: string;
    model?: string;
    subagentCount?: number;
    expanded?: boolean;
    editValue?: string;
    onToggleExpand?: () => void;
    onRename?: (newName: string) => void;
    onSelect: () => void;
    onTogglePin: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    renameRef?: RefObject<(() => void) | null>;
    onDuplicate?: () => void;
    onDragStart?: (e: React.DragEvent) => void;
    onDragOver?: (e: React.DragEvent) => void;
    onDrop?: (e: React.DragEvent) => void;
    onDragEnd?: () => void;
    dropIndicator?: "top" | "bottom";
}

export function SessionRow({
    label,
    status,
    active,
    blocked,
    pinned,
    detail,
    model,
    subagentCount = 0,
    expanded = false,
    editValue,
    onToggleExpand,
    onRename,
    onSelect,
    onTogglePin,
    onContextMenu,
    renameRef,
    onDuplicate,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    dropIndicator,
}: SessionRowProps) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const cancelledRef = useRef(false);
    const startEdit = () => {
        setDraft(editValue ?? "");
        setEditing(true);
    };
    if (renameRef) {
        renameRef.current = startEdit;
    }
    return (
        <div
            className={cn(
                "session-row group flex min-h-8 w-full cursor-pointer items-center gap-2 border-l-2 border-transparent py-1 pl-2 pr-1.5 transition-colors",
                !active && !blocked && "hover:bg-[rgba(255,255,255,0.08)]",
                active && "session-row--active border-l-[#429dff] bg-[rgba(66,157,255,0.08)] hover:bg-[rgba(66,157,255,0.14)]",
                blocked && "session-row--blocked border-l-[#d29922] bg-[rgba(210,153,34,0.08)] hover:bg-[rgba(210,153,34,0.14)]",
                dropIndicator === "top" && "shadow-[inset_0_2px_0_0_#429dff]",
                dropIndicator === "bottom" && "shadow-[inset_0_-2px_0_0_#429dff]"
            )}
            draggable={!editing}
            onClick={onSelect}
            onContextMenu={onContextMenu}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
        >
            {subagentCount > 0 ? (
                <i
                    className={makeIconClass(expanded ? "chevron-down" : "chevron-right", true) + " w-[9px] cursor-pointer text-[9px] text-secondary"}
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggleExpand?.();
                    }}
                />
            ) : (
                <span className="w-[9px]" />
            )}
            <motion.span
                className="size-[9px] shrink-0 rounded-full transition-[background-color] duration-300"
                style={{ backgroundColor: STATUS_COLOR[status] }}
                animate={
                    status === "working"
                        ? { scale: [1, 1.25, 1] }
                        : status === "waiting"
                          ? { opacity: [1, 0.45, 1] }
                          : { scale: 1, opacity: 1 }
                }
                transition={
                    status === "idle"
                        ? { duration: 0 }
                        : { duration: status === "working" ? 1.6 : 1.2, repeat: Infinity, ease: "easeInOut" }
                }
            />
            <div className="flex min-w-0 flex-1 flex-col">
                {editing ? (
                    <input
                        autoFocus
                        className="w-full bg-transparent text-[13px] text-primary outline-none"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.currentTarget.blur();
                            } else if (e.key === "Escape") {
                                cancelledRef.current = true;
                                e.currentTarget.blur();
                            }
                        }}
                        onBlur={() => {
                            setEditing(false);
                            if (cancelledRef.current) {
                                cancelledRef.current = false;
                                return;
                            }
                            onRename?.(draft);
                        }}
                    />
                ) : (
                    <span
                        className="truncate text-[13px]"
                        title={label}
                        onDoubleClick={(e) => {
                            if (!onRename) {
                                return;
                            }
                            e.stopPropagation();
                            startEdit();
                        }}
                    >
                        {label}
                    </span>
                )}
                {detail && (
                    <span className="session-row-detail truncate text-[11px] text-secondary" title={detail}>
                        {detail}
                    </span>
                )}
            </div>
            {model && (
                <span
                    className="shrink-0 rounded bg-[rgba(255,255,255,0.06)] px-1 text-[10px] text-secondary opacity-80"
                    title={model}
                >
                    {modelLabel(model)}
                </span>
            )}
            {subagentCount > 0 && (
                <span className="rounded bg-[rgba(255,255,255,0.08)] px-1 text-[10px] tabular-nums text-secondary">
                    {subagentCount}
                </span>
            )}
            {onDuplicate && (
                <i
                    className={
                        makeIconClass("clone", true) +
                        " cursor-pointer text-[10px] opacity-0 group-hover:opacity-60 hover:!opacity-100"
                    }
                    title="Duplicate session"
                    onClick={(e) => {
                        e.stopPropagation();
                        onDuplicate();
                    }}
                />
            )}
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

interface SubagentRowProps {
    type: string;
    state: SubagentState;
    last: boolean;
    model?: string;
    parentModel?: string;
}

export function SubagentRow({ type, state, last, model, parentModel }: SubagentRowProps) {
    return (
        <div className="flex min-h-6 w-full items-center gap-1.5 py-0.5 pl-6 pr-1.5 text-[13px] text-secondary">
            <span className="select-none font-mono text-[11px] opacity-50">{last ? "└─" : "├─"}</span>
            <span className="font-mono text-[11px] leading-none" style={{ color: SUBAGENT_MARKER_COLOR[state] }}>
                {SUBAGENT_MARKER[state]}
            </span>
            <span className="min-w-0 flex-1 truncate" title={type}>
                {type}
            </span>
            {model && model !== parentModel && (
                <span
                    className="ml-auto shrink-0 rounded bg-[rgba(255,255,255,0.06)] px-1 text-[10px] opacity-80"
                    title={model}
                >
                    {modelLabel(model)}
                </span>
            )}
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
                className="flex h-7 w-full cursor-pointer items-center gap-1.5 px-2 text-[11px] text-[#8b949e]"
                onClick={onToggle}
            >
                <i className={makeIconClass(collapsed ? "chevron-right" : "chevron-down", true) + " text-[9px]"} />
                <span className="min-w-0 truncate text-[12px] font-semibold text-[#adbac7]" title={label}>
                    {label}
                </span>
                <span
                    className="size-[9px] shrink-0 rounded-full transition-[background-color] duration-300"
                    style={{ backgroundColor: STATUS_COLOR[aggregateStatus] }}
                />
                <span className="ml-auto shrink-0 tabular-nums opacity-70">{count}</span>
            </div>
            {!collapsed && <div className="flex flex-col">{children}</div>}
        </div>
    );
}

export type { ReactNode };
