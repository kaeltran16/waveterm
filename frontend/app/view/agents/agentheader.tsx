// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Identity + controls bar shown above the focused agent's live terminal in the Agent surface.
// Extracted from the former AgentTranscript header (now removed): the real Claude Code TUI has no
// chrome of its own, so this keeps name/status/model/context% + the details-rail toggle visible.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget, stringToBase64 } from "@/util/util";
import { useAtomValue } from "jotai";
import { confirmCloseAgent } from "./agentactions";
import { projectOf, usageLevel, type AgentVM } from "./agentsviewmodel";
import { railVisibleAtom, terminalFullscreenAtom } from "./railstore";
import { runtimeMeta } from "./runtimemeta";
import { StatusDot } from "./statusdot";

const STATE_COLOR: Record<AgentVM["state"], string> = {
    asking: "var(--color-warning)",
    working: "var(--color-accent)",
    idle: "var(--color-muted)",
};
const STATE_LABEL: Record<AgentVM["state"], string> = { asking: "asking", working: "working", idle: "idle" };

// header context% chip color by occupancy band (mirrors the rail gauge, as text not fill)
const CTX_TEXT: Record<"ok" | "warn" | "hot", string> = {
    ok: "text-accent",
    warn: "text-warning",
    hot: "text-error",
};

// shared compact icon-button (matches the rail-toggle's resting style)
const ICON_BTN = "cursor-pointer rounded-[7px] border border-edge-mid bg-surface-raised px-[9px] py-[6px] text-[#aeb6bf]";

export function AgentHeader({ agent }: { agent: AgentVM }) {
    const railVisible = useAtomValue(railVisibleAtom);
    const fullscreen = useAtomValue(terminalFullscreenAtom);
    const project = projectOf(agent);
    const rt = runtimeMeta(agent.agent);
    const blockId = agent.blockId;

    // Esc cancels the current Claude turn — same PTY-write path as the composer (ControllerInputCommand).
    const interrupt = () => {
        if (blockId == null) {
            return;
        }
        fireAndForget(() =>
            RpcApi.ControllerInputCommand(TabRpcClient, { blockid: blockId, inputdata64: stringToBase64("\x1b") })
        );
    };

    // Close the whole agent session (a tab, per launchAgent) — shared with the double-Ctrl+C handler.
    const closeTerminal = () => confirmCloseAgent(agent.id, agent.name);

    // Right-click the header for the same controls as the button row (plus the details toggle).
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const items: ContextMenuItem[] = [];
        if (blockId != null) {
            items.push({ label: "Interrupt turn", click: interrupt });
            items.push({
                label: fullscreen ? "Exit fullscreen" : "Fullscreen terminal",
                click: () => globalStore.set(terminalFullscreenAtom, !fullscreen),
            });
        }
        items.push({
            label: railVisible ? "Hide details" : "Show details",
            click: () => globalStore.set(railVisibleAtom, !railVisible),
        });
        if (blockId != null) {
            items.push({ type: "separator" });
            items.push({ label: "Close agent", click: closeTerminal });
        }
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };

    return (
        <div
            onContextMenu={onContextMenu}
            className="flex shrink-0 items-center gap-[13px] border-b border-[#1a1f26] bg-background px-[22px] py-[14px]"
        >
            <StatusDot state={agent.state} className="!h-[9px] !w-[9px]" />
            <div className="min-w-0">
                <div className="flex items-center gap-[9px]">
                    <span className="whitespace-nowrap font-mono text-[15px] font-semibold text-[#eef1f4]">
                        {agent.name}
                    </span>
                    <span
                        className={cn(
                            "inline-flex items-center gap-[5px] whitespace-nowrap rounded-[5px] border px-[8px] py-[2px] font-mono text-[10.5px] font-semibold",
                            rt.text,
                            rt.softBg,
                            rt.line
                        )}
                    >
                        <span className="text-[11px] leading-none">{rt.glyph}</span>
                        {rt.label}
                    </span>
                    <span
                        className="rounded-[5px] border px-[7px] py-[1px] font-mono text-[10.5px] font-medium opacity-85"
                        style={{ color: STATE_COLOR[agent.state], borderColor: STATE_COLOR[agent.state] }}
                    >
                        {STATE_LABEL[agent.state]}
                    </span>
                    {agent.model ? (
                        <span className="rounded-[5px] border border-edge-mid px-[7px] py-[1px] font-mono text-[10.5px] font-medium text-muted">
                            {agent.model}
                        </span>
                    ) : null}
                    {agent.usage?.contextpct != null ? (
                        <span
                            className={cn(
                                "font-mono text-[10.5px] font-semibold",
                                CTX_TEXT[usageLevel(agent.usage.contextpct)]
                            )}
                        >
                            {Math.round(agent.usage.contextpct)}%
                        </span>
                    ) : null}
                </div>
                <div className="mt-[2px] font-mono text-[11px] font-medium text-muted">{project || "—"}</div>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-[7px]">
                {blockId != null ? (
                    <>
                        <button
                            type="button"
                            onClick={interrupt}
                            title="Interrupt the current turn (Esc)"
                            className={cn(ICON_BTN, "hover:border-edge-strong")}
                        >
                            <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                                <rect x="6" y="6" width="8" height="8" rx="1.5" />
                            </svg>
                        </button>
                        <button
                            type="button"
                            onClick={() => globalStore.set(terminalFullscreenAtom, !fullscreen)}
                            title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen terminal"}
                            aria-pressed={fullscreen}
                            className={cn(
                                "cursor-pointer rounded-[7px] border px-[9px] py-[6px]",
                                fullscreen
                                    ? "border-accent bg-accentbg text-accent"
                                    : cn(ICON_BTN, "hover:border-edge-strong")
                            )}
                        >
                            <svg
                                width="16"
                                height="16"
                                viewBox="0 0 20 20"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M4 8V4h4 M16 8V4h-4 M4 12v4h4 M16 12v4h-4" />
                            </svg>
                        </button>
                        <button
                            type="button"
                            onClick={closeTerminal}
                            title="Close terminal — ends the agent"
                            className={cn(ICON_BTN, "hover:border-error hover:text-error")}
                        >
                            <svg
                                width="16"
                                height="16"
                                viewBox="0 0 20 20"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.7"
                                strokeLinecap="round"
                            >
                                <line x1="5" y1="5" x2="15" y2="15" />
                                <line x1="15" y1="5" x2="5" y2="15" />
                            </svg>
                        </button>
                    </>
                ) : null}
                <button
                    type="button"
                    onClick={() => globalStore.set(railVisibleAtom, !railVisible)}
                    title={railVisible ? "Hide details (d)" : "Show details (d)"}
                    aria-pressed={railVisible}
                    className={cn(
                        "cursor-pointer rounded-[7px] border px-[9px] py-[6px]",
                        railVisible
                            ? "border-accent bg-accentbg text-accent"
                            : cn(ICON_BTN, "hover:border-edge-strong")
                    )}
                >
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <rect x="3" y="4" width="14" height="12" rx="2" />
                        <line x1="13" y1="4" x2="13" y2="16" />
                    </svg>
                </button>
            </div>
        </div>
    );
}
