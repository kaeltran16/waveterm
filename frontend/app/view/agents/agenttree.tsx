// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useSettle } from "@/app/element/motionhooks";
import { cardVariants, composerReveal, computeEntrances, initialEntranceState } from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useRef } from "react";
import { confirmCloseAgent } from "./agentactions";
import type { AgentsViewModel } from "./agents";
import { buildAgentTree } from "./agenttreemodel";
import { duplicateSession } from "./session-models/sessionsidebarmodel";
import type { AgentVM } from "./agentsviewmodel";
import {
    getSubagentExpandAtom,
    toggleSubagentExpand,
} from "./session-models/agentstatusstore";
import { subagentExpanded, visibleSubagents, type SubagentState } from "./session-models/sessionviewmodel";
import { StatusDot } from "./statusdot";
import { focusSubagentAtom, subagentsByIdAtom } from "./subagentsstore";
import { useSubagentTracking } from "./subagenttracking";

const STATE_COLOR: Record<AgentVM["state"], string> = {
    asking: "var(--color-warning)",
    working: "var(--color-accent)",
    idle: "var(--color-muted)",
};
const STATE_LABEL: Record<AgentVM["state"], string> = { asking: "asking", working: "working", idle: "idle" };
const SUB_COLOR: Record<SubagentState, string> = {
    working: "var(--color-accent)",
    success: "var(--color-success)",
    failure: "var(--color-error)",
    done: "var(--color-muted)",
};

function ParentRow({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const focusId = useAtomValue(model.focusIdAtom);
    const oref = `block:${agent.blockId}`;
    // drop children that finished (success/done) so a completed fan-out doesn't linger in the tree
    const subs = visibleSubagents(useAtomValue(subagentsByIdAtom)[agent.id] ?? []);
    const expandOverride = useAtomValue(getSubagentExpandAtom(oref));
    const expanded = subagentExpanded(subs, expandOverride);
    const selected = focusId === agent.id;
    const asking = agent.state === "asking";
    // m4: one-shot settle when this agent reaches idle (working/asking -> idle)
    const settling = useSettle(agent.state === "idle");

    const select = () => {
        globalStore.set(model.focusIdAtom, agent.id);
        globalStore.set(model.focusReplyAtom, false);
    };
    const onContextMenu = (e: React.MouseEvent) => {
        const items: ContextMenuItem[] = [
            { label: "Duplicate", click: () => duplicateSession(model, agent.id) },
            { label: "Copy name", click: () => void navigator.clipboard.writeText(agent.name) },
            { type: "separator" },
            { label: "Close agent", danger: true, click: () => confirmCloseAgent(agent.id, agent.name) },
        ];
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };

    // The animating motion.div wrapper lives in AgentTree (direct AnimatePresence child, required for
    // popLayout to pop an exiting row out of flow). This is just the row body + subagent reveal.
    return (
        <>
            <div
                onClick={select}
                onContextMenu={onContextMenu}
                className={cn(
                    "relative flex cursor-pointer items-center gap-[9px] rounded-[9px] px-[11px] py-[10px] transition-colors duration-[140ms]",
                    // m3 attention: a static amber tint marks an asking row (the pulse lives in the dot, not the row);
                    // selection wins the background so the focused row still reads as focused.
                    selected ? "bg-accentbg" : asking ? "bg-warning/[0.06]" : "hover:bg-surface-hover",
                    settling && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
                )}
            >
                <StatusDot state={agent.state} pulse={agent.state !== "idle"} className="!h-[7px] !w-[7px]" />
                <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12px] font-semibold text-ink-hi">{agent.name}</div>
                    {/* PLACEHOLDER (1b): git branch has no data source — see spec §8 */}
                    <div className="truncate text-[10.5px] text-muted">main</div>
                </div>
                {subs.length > 0 ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleSubagentExpand(oref, expanded);
                        }}
                        title="Toggle subagents"
                        className="flex items-center gap-[3px] rounded-sm border border-edge-mid bg-surface-hover px-[6px] py-[2px] font-mono text-[9.5px] font-semibold text-muted hover:border-accent hover:text-accent-soft"
                    >
                        <span className="text-[8px] leading-none">{expanded ? "▾" : "▸"}</span>
                        {subs.length}
                    </button>
                ) : null}
                <span className="font-mono text-[10px] font-medium transition-colors duration-[140ms]" style={{ color: STATE_COLOR[agent.state] }}>
                    {STATE_LABEL[agent.state]}
                </span>
            </div>
            {/* subagent reveal: the children block expands/collapses via composerReveal (height+opacity).
                It is not a layout node itself, so its height animation and the row-list reflow don't fight. */}
            <AnimatePresence initial={false}>
                {expanded ? (
                    <motion.div key="subs" variants={composerReveal} initial="initial" animate="animate" exit="exit" className="overflow-hidden">
                        {subs.map((s) => (
                            <div
                                key={s.id}
                                onClick={() => {
                                    if (!s.transcriptPath) {
                                        return;
                                    }
                                    globalStore.set(model.focusIdAtom, agent.id);
                                    globalStore.set(focusSubagentAtom, {
                                        parentId: agent.id,
                                        agentId: s.id,
                                        transcriptPath: s.transcriptPath,
                                        label: s.type || "subagent",
                                    });
                                }}
                                className={cn(
                                    "relative flex items-center gap-[8px] rounded-[9px] py-[7px] pl-[28px] pr-[10px] hover:bg-surface-hover",
                                    s.transcriptPath && "cursor-pointer"
                                )}
                            >
                                <span className="absolute left-[13px] top-1/2 -translate-y-1/2 font-mono text-[11px] font-semibold text-ink-faint">
                                    ↳
                                </span>
                                <span
                                    className="h-[5px] w-[5px] shrink-0 rounded-full"
                                    style={{ background: SUB_COLOR[s.state] }}
                                />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate font-mono text-[11px] font-semibold text-muted-foreground">
                                        {s.type || "subagent"}
                                    </div>
                                    <div className="truncate text-[9.5px] text-muted">{s.model ?? ""}</div>
                                </div>
                                <span
                                    className="whitespace-nowrap font-mono text-[9.5px] font-medium"
                                    style={{ color: SUB_COLOR[s.state] }}
                                >
                                    {s.state}
                                </span>
                            </div>
                        ))}
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </>
    );
}

// A background terminal row: no agent chrome (no status dot / model / subagents) — just a glyph +
// name that focuses the terminal's block in the surface's focus pane.
function TerminalRow({ model, terminal }: { model: AgentsViewModel; terminal: AgentVM }) {
    const focusId = useAtomValue(model.focusIdAtom);
    const selected = focusId === terminal.id;
    const select = () => {
        globalStore.set(model.focusIdAtom, terminal.id);
        globalStore.set(model.focusReplyAtom, false);
    };
    return (
        <div
            onClick={select}
            className={cn(
                "relative flex cursor-pointer items-center gap-[9px] rounded-[9px] px-[11px] py-[10px] transition-colors duration-[140ms]",
                selected ? "bg-accentbg" : "hover:bg-surface-hover"
            )}
        >
            <span className="w-[7px] shrink-0 text-center font-mono text-[11px] leading-none text-muted">›_</span>
            <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12px] font-semibold text-ink-hi">{terminal.name}</div>
            </div>
            <span className="font-mono text-[10px] font-medium text-muted">terminal</span>
        </div>
    );
}

export function AgentTree({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const terminals = useAtomValue(model.terminalsAtom);
    const order = useAtomValue(model.orderAtom);
    const rows = buildAgentTree(agents, order);

    useSubagentTracking(agents);

    // no-cascade guard (single constant key — the surface has one roster): mounting or switching to the
    // surface seeds silently, so only agents/terminals that arrive after mount fade in. See motiontokens.ts.
    const rowIds = [...agents.map((a) => a.id), ...terminals.map((t) => t.id)];
    const entranceRef = useRef(initialEntranceState());
    const { animate: entranceIds } = computeEntrances(entranceRef.current, "agents", rowIds);
    const idsKey = rowIds.join(",");
    useLayoutEffect(() => {
        entranceRef.current = computeEntrances(entranceRef.current, "agents", rowIds).state;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [idsKey]);

    return (
        <div className="flex w-[248px] shrink-0 flex-col border-r border-border bg-surface">
            <div className="border-b border-edge-faint px-[16px] pb-[12px] pt-[16px]">
                <div className="flex items-center justify-between">
                    <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[.1em] text-ink-mid">Agents</h3>
                    <span className="font-mono text-[11px] font-semibold text-muted">{agents.length}</span>
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-[8px]">
                <AnimatePresence mode="popLayout" initial={false}>
                    {rows.map((r) =>
                        r.kind === "group" ? (
                            <motion.div
                                key={`g-${r.project}`}
                                layout="position"
                                className="flex items-center gap-[8px] px-[11px] pb-[6px] pt-[14px]"
                            >
                                <span className="truncate font-mono text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
                                    {r.project}
                                </span>
                                <div className="h-px flex-1 bg-edge-faint" />
                                {r.attn > 0 ? (
                                    <span className="rounded-[5px] bg-warning/10 px-[6px] py-[1px] font-mono text-[9.5px] font-semibold text-warning">
                                        {r.attn}
                                    </span>
                                ) : null}
                                <span className="font-mono text-[10px] font-semibold text-feed-time">{r.count}</span>
                            </motion.div>
                        ) : (
                            // layout="position" so a subagent expand doesn't scale-distort the row — only its
                            // position animates on reflow. Must be the direct AnimatePresence child: popLayout
                            // measures it via ref to pop an exiting row out of flow (else its space lingers).
                            <motion.div
                                key={r.agent.id}
                                layout="position"
                                variants={cardVariants}
                                initial={entranceIds.has(r.agent.id) ? "initial" : false}
                                animate="animate"
                                exit="exit"
                            >
                                <ParentRow model={model} agent={r.agent} />
                            </motion.div>
                        )
                    )}
                    {terminals.length > 0 ? (
                        <motion.div
                            key="terminals-header"
                            layout="position"
                            className="flex items-center gap-[8px] px-[11px] pb-[6px] pt-[14px]"
                        >
                            <span className="truncate font-mono text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
                                Terminals
                            </span>
                            <div className="h-px flex-1 bg-edge-faint" />
                            <span className="font-mono text-[10px] font-semibold text-feed-time">{terminals.length}</span>
                        </motion.div>
                    ) : null}
                    {terminals.map((t) => (
                        <motion.div
                            key={t.id}
                            layout="position"
                            variants={cardVariants}
                            initial={entranceIds.has(t.id) ? "initial" : false}
                            animate="animate"
                            exit="exit"
                        >
                            <TerminalRow model={model} terminal={t} />
                        </motion.div>
                    ))}
                </AnimatePresence>
            </div>
        </div>
    );
}
