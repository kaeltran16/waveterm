// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { Fragment, useState } from "react";
import { groupTimeline, summarizeActions, type AgentActionEntry, type AgentEntry } from "./agentsviewmodel";
import { MarkdownMessage } from "./markdownmessage";

// Reasoning (message) entries render as prose; action entries render as a dim
// monospace verb/target strip. tool_result content is never present here (the
// projection discards it). With accentLatest, the newest message is highlighted.
// Bursts of >= CollapseRunThreshold consecutive actions fold into one summary
// line (via groupTimeline) to keep prose readable; the line expands on click and
// the expand sticks. While `active`, the trailing run stays expanded so the live
// panel shows work as it lands. Entries are append-only and keyed by entry index.

function ActionStrip({ action, large }: { action: AgentActionEntry; large?: boolean }) {
    return (
        <div
            className={cn(
                "my-2.5 border-l-2 border-border pl-3.5 font-mono leading-7 text-muted",
                large ? "text-[13px]" : "text-[12px]"
            )}
        >
            <span className="inline-block min-w-14 pr-2 text-secondary">{action.verb}</span>
            {action.target}
            {action.note ? <span className="text-muted"> ({action.note})</span> : null}
            {action.outcome ? (
                <span className={cn("ml-1 inline-block", action.outcome === "ok" ? "text-accent" : "text-error")}>
                    {action.outcome === "ok" ? "✓" : "✗"}
                </span>
            ) : null}
        </div>
    );
}

export function NarrationTimeline({
    entries,
    accentLatest,
    large,
    active,
    className,
}: {
    entries: AgentEntry[];
    accentLatest?: boolean;
    large?: boolean;
    active?: boolean;
    className?: string;
}) {
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
    const items = groupTimeline(entries);

    let lastMessageIdx = -1;
    if (accentLatest) {
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].kind === "message") {
                lastMessageIdx = i;
                break;
            }
        }
    }

    // expand-only: folding is automatic (settled runs collapse), clicking only opens.
    const expand = (startIndex: number) => setExpanded((prev) => new Set(prev).add(startIndex));

    return (
        <div className={cn("leading-relaxed", className)}>
            {items.map((item, idx) => {
                if (item.kind === "message") {
                    return (
                        <div
                            key={item.index}
                            className={cn(
                                "mt-2.5",
                                large ? "text-[15px]" : "text-[13px]",
                                item.index === lastMessageIdx
                                    ? "border-l-2 border-accent pl-2 text-primary"
                                    : "text-secondary"
                            )}
                        >
                            <MarkdownMessage text={item.text} />
                        </div>
                    );
                }
                if (item.kind === "user") {
                    return (
                        <div
                            key={item.index}
                            className={cn("mt-2.5 flex gap-1.5 text-muted", large ? "text-[13px]" : "text-[12px]")}
                        >
                            <span className="select-none text-muted/70">&gt;</span>
                            <span className="whitespace-pre-wrap">{item.text}</span>
                        </div>
                    );
                }
                if (item.kind === "action") {
                    return <ActionStrip key={item.index} action={item.action} large={large} />;
                }
                const isTrailing = idx === items.length - 1;
                const isOpen = expanded.has(item.startIndex) || (active && isTrailing);
                if (isOpen) {
                    return (
                        <Fragment key={"g" + item.startIndex}>
                            {item.actions.map((action, k) => (
                                <ActionStrip key={item.startIndex + k} action={action} large={large} />
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
                        className={cn(
                            "my-2.5 flex w-full cursor-pointer items-center gap-1.5 rounded-r border-l-2 border-accent/50 bg-accent/[0.06] px-2.5 py-1 font-mono text-muted hover:bg-accent/10",
                            large ? "text-[13px]" : "text-[12px]"
                        )}
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
        </div>
    );
}
