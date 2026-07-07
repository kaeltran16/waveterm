// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ContextMenuModel } from "@/app/store/contextmenu";
import { cn } from "@/util/util";
import { AnimatePresence, motion } from "motion/react";
import { MOTION, shouldFadeEntry } from "@/app/element/motiontokens";
import { Fragment, useState } from "react";
import { conversationText, groupTimeline, summarizeActions, type AgentActionEntry, type AgentEntry } from "./agentsviewmodel";
import { MarkdownMessage } from "./markdownmessage";

// Handoff lane feed (Wave-cockpit-live.dc.html:211-247). message -> narration row
// (accent avatar + prose); user -> right-aligned bubble; action -> tool line
// (outcome chip + tool + summary + note). Bursts of >= CollapseRunThreshold
// consecutive actions fold into one summary line (groupTimeline) that expands on
// click; while `active`, the trailing run stays expanded. tool_result content is
// never present. Per-tool timestamps are omitted (not in AgentEntry).

function ToolLine({ action }: { action: AgentActionEntry }) {
    const ok = action.outcome !== "fail";
    return (
        <div className="flex items-center gap-1.5 px-1 py-[3px] opacity-[0.68]">
            <span
                className={cn(
                    "flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[3px] text-[8px]",
                    ok ? "bg-success/15 text-success" : "bg-error/15 text-error"
                )}
            >
                {ok ? "✓" : "✗"}
            </span>
            <span className="shrink-0 font-mono text-[8px] font-semibold uppercase tracking-[0.03em] text-feed-label">
                {action.verb}
            </span>
            <span className="shrink-0 whitespace-nowrap font-mono text-[10.5px] text-feed-summary">{action.target}</span>
            {action.note ? (
                <>
                    <span className="shrink-0 text-[9px] text-edge-strong">→</span>
                    <span
                        className={cn(
                            "min-w-0 truncate font-mono text-[10.5px] opacity-[0.85]",
                            ok ? "text-success" : "text-error"
                        )}
                    >
                        {action.note}
                    </span>
                </>
            ) : null}
        </div>
    );
}

export function NarrationTimeline({
    entries,
    accentLatest,
    active,
    className,
}: {
    entries: AgentEntry[];
    accentLatest?: boolean;
    active?: boolean;
    className?: string;
}) {
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
    const items = groupTimeline(entries);
    const copyMenu = (text: string) => (e: React.MouseEvent) =>
        ContextMenuModel.getInstance().showContextMenu(
            [
                { label: "Copy text", click: () => void navigator.clipboard.writeText(text) },
                { label: "Copy conversation", click: () => void navigator.clipboard.writeText(conversationText(entries)) },
            ],
            e
        );

    let lastMessageIdx = -1;
    if (accentLatest) {
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].kind === "message") {
                lastMessageIdx = i;
                break;
            }
        }
    }

    const expand = (startIndex: number) => setExpanded((prev) => new Set(prev).add(startIndex));

    return (
        <div className={cn("leading-relaxed", className)}>
            <AnimatePresence initial={false}>
            {items.map((item, idx) => {
                if (item.kind === "message") {
                    return (
                        <motion.div
                            key={item.index}
                            className="mt-2 flex gap-2.5"
                            onContextMenu={copyMenu(item.text)}
                            initial={shouldFadeEntry("message") ? { opacity: 0 } : false}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border border-accent/30 bg-accent/[0.13]">
                                <span className="h-[7px] w-[7px] rounded-full bg-accent-soft" />
                            </span>
                            <div
                                className={cn(
                                    "min-w-0 flex-1 text-[13px] leading-[1.55]",
                                    item.index === lastMessageIdx ? "text-primary" : "text-secondary"
                                )}
                            >
                                <MarkdownMessage text={item.text} />
                            </div>
                        </motion.div>
                    );
                }
                if (item.kind === "user") {
                    return (
                        <motion.div
                            key={item.index}
                            className="mt-2 flex justify-end pl-[30px]"
                            onContextMenu={copyMenu(item.text)}
                            initial={shouldFadeEntry("user") ? { opacity: 0 } : false}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <div className="max-w-[90%] rounded-[11px_11px_4px_11px] border border-accent/25 bg-accent/10 px-2.5 py-1.5">
                                <div className="mb-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.08em] text-accent-soft">
                                    You
                                </div>
                                <p className="text-[12.5px] leading-[1.5] text-primary">{item.text}</p>
                            </div>
                        </motion.div>
                    );
                }
                if (item.kind === "action") {
                    return <ToolLine key={item.index} action={item.action} />;
                }
                const isTrailing = idx === items.length - 1;
                const isOpen = expanded.has(item.startIndex) || (active && isTrailing);
                if (isOpen) {
                    return (
                        <Fragment key={"g" + item.startIndex}>
                            {item.actions.map((action, k) => (
                                <ToolLine key={item.startIndex + k} action={action} />
                            ))}
                        </Fragment>
                    );
                }
                const summary = summarizeActions(item.actions);
                return (
                    <button
                        key={"g" + item.startIndex}
                        type="button"
                        onClick={() => expand(item.startIndex)}
                        className="my-1.5 flex w-full cursor-pointer items-center gap-1.5 rounded-r border-l-2 border-accent/50 bg-accent/[0.06] px-2.5 py-1 font-mono text-[12px] text-muted hover:bg-accent/10"
                    >
                        <span className="text-accent">▸</span>
                        <span className="text-secondary">{summary.total} tools</span>
                        {summary.byVerb.map((v) => (
                            <span key={v.verb}>
                                · {v.count} {v.verb}
                            </span>
                        ))}
                        <span className={cn("ml-0.5", summary.outcome === "ok" ? "text-accent" : "text-error")}>
                            {summary.outcome === "ok" ? "✓" : "✗"}
                        </span>
                    </button>
                );
            })}
            </AnimatePresence>
        </div>
    );
}

