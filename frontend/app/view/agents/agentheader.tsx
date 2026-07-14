// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Identity + controls bar shown above the focused agent's live terminal in the Agent surface.
// Extracted from the former AgentTranscript header (now removed): the real Claude Code TUI has no
// chrome of its own, so this keeps name/status/model/context% + the details-rail toggle visible.

import { useSettle } from "@/app/element/motionhooks";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget, stringToBase64 } from "@/util/util";
import { useAtomValue } from "jotai";
import { Maximize2, Minimize2, Square, X } from "lucide-react";
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
const ICON_BTN =
    "cursor-pointer rounded-[7px] border border-edge-mid bg-surface-raised px-[9px] py-[6px] text-secondary";

export function AgentHeader({ agent }: { agent: AgentVM }) {
    const railVisible = useAtomValue(railVisibleAtom);
    const fullscreen = useAtomValue(terminalFullscreenAtom);
    const project = projectOf(agent);
    const rt = runtimeMeta(agent.agent);
    const blockId = agent.blockId;
    // m4: one-shot settle on the state pill when the focused agent reaches idle
    const settling = useSettle(agent.state === "idle");

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
            items.push({ label: "Close agent", danger: true, click: closeTerminal });
        }
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };

    return (
        <div
            onContextMenu={onContextMenu}
            className="flex shrink-0 items-center gap-[13px] border-b border-border bg-background px-[22px] py-[14px]"
        >
            <StatusDot state={agent.state} pulse={agent.state !== "idle"} className="!h-[9px] !w-[9px]" />
            <div className="min-w-0">
                <div className="flex items-center gap-[9px]">
                    <span className="whitespace-nowrap font-mono text-[15px] font-semibold text-foreground">
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
                        className={cn(
                            "rounded-[5px] border px-[7px] py-[1px] font-mono text-[10.5px] font-medium opacity-85 transition-colors duration-[140ms]",
                            settling && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
                        )}
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
                            <Square size={16} strokeWidth={2} fill="currentColor" />
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
                            {fullscreen ? (
                                <Minimize2 size={16} strokeWidth={1.8} />
                            ) : (
                                <Maximize2 size={16} strokeWidth={1.8} />
                            )}
                        </button>
                        <button
                            type="button"
                            onClick={closeTerminal}
                            title="Close terminal — ends the agent"
                            className={cn(ICON_BTN, "hover:border-error hover:text-error")}
                        >
                            <X size={16} strokeWidth={1.9} />
                        </button>
                    </>
                ) : null}
            </div>
        </div>
    );
}
