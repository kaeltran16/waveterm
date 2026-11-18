// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The gone card, in the Rendered transcript: why no brainstorm is drawn, and a brainstorm Arc closed is a row. A run has
// no card: its line is the Started run row, and the workspace pane's Brainstorm tab holds its Run step and Close.

import { ViewSwap } from "@/app/element/viewswap";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Lightbulb } from "lucide-react";
import type { JSX } from "react";
import type { AgentVM } from "./agentsviewmodel";
import type { BrainstormState } from "./brainstormstore";
import { DOT } from "./brainstormui";
import { brainstormClosedAtom, goneView } from "./renderedbsrunmodel";

const GONE_CARD = "flex flex-col rounded-[10px] border border-edge-mid bg-surface";

export function GoneCard({
    s,
    why,
    compact,
}: {
    agent: AgentVM;
    s: BrainstormState;
    why: "unreadable" | "removed";
    compact: boolean;
}): JSX.Element | null {
    const closed = useAtomValue(brainstormClosedAtom);
    const v = goneView(why, s, closed);
    const pad = compact ? "gap-1.5 px-[14px] py-3" : "gap-1.5 px-[18px] py-[14px]";
    const body = (text: string) => (
        <span
            className={cn(
                "leading-[1.5] text-secondary [overflow-wrap:anywhere]",
                compact ? "text-[12.5px]" : "text-[13px]"
            )}
        >
            {text}
        </span>
    );
    return (
        <ViewSwap swapKey={v.kind}>
            {v.kind === "closed" ? (
                <div
                    data-rendered-bs-gone="closed"
                    className={cn(
                        "flex min-w-0 items-center justify-center gap-2 py-0.5 text-muted",
                        compact ? "text-[12px]" : "text-[12.5px]"
                    )}
                >
                    <Lightbulb size={13} strokeWidth={2} className="shrink-0" aria-hidden />
                    <span className="min-w-0">{v.text}</span>
                </div>
            ) : v.kind === "unreadable" ? (
                <div data-rendered-bs-gone="unreadable" className={cn(GONE_CARD, pad)}>
                    <span className="flex items-center gap-2 text-[13.5px] font-semibold text-primary">
                        <span className={cn(DOT, "bg-error")} />
                        {v.title}
                    </span>
                    {body(v.error)}
                    <span className="break-all font-mono text-[11.5px] text-muted">{v.path}</span>
                </div>
            ) : (
                <div data-rendered-bs-gone="removed" className={cn(GONE_CARD, pad)}>
                    <span className="text-[13.5px] font-semibold text-primary [overflow-wrap:anywhere]">{v.title}</span>
                    {body(v.text)}
                </div>
            )}
        </ViewSwap>
    );
}
