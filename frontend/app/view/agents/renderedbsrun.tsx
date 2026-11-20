// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The gone card, in the Rendered transcript: why no brainstorm is drawn, and a brainstorm Arc closed is a row. A run has
// no card: its line is the Started run row, and the workspace pane's Brainstorm tab holds its Run step and Close.

import { ViewSwap } from "@/app/element/viewswap";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Lightbulb } from "lucide-react";
import type { JSX, ReactNode } from "react";
import type { AgentVM } from "./agentsviewmodel";
import type { BrainstormState } from "./brainstormstore";
import { CardFrame, headIconSize } from "./renderedbrainstorm";
import { brainstormClosedAtom, goneView } from "./renderedbsrunmodel";

const MONO_PATH = "break-all font-mono text-[11.5px] text-muted";

export function GoneCard({
    agent,
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
    // no status and no link on the full card: the file is gone. the folded row CardFrame draws while the
    // Brainstorm tab shows keeps Open brainstorm
    const frame = (children: ReactNode, title: string, error: boolean) => (
        <CardFrame
            agent={agent}
            s={s}
            f={null}
            asking={false}
            tone={error ? "error" : undefined}
            icon={
                error ? (
                    <Lightbulb size={headIconSize(compact)} strokeWidth={2} className="text-error" aria-hidden />
                ) : undefined
            }
            subject={title}
            status=""
            link={null}
            title={title}
            compact={compact}
            attr="data-rendered-bs-gone-card"
        >
            {children}
        </CardFrame>
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
                <div data-rendered-bs-gone="unreadable">
                    {frame(
                        <>
                            {body(v.error)}
                            <span className={MONO_PATH}>{v.path}</span>
                        </>,
                        v.title,
                        true
                    )}
                </div>
            ) : (
                <div data-rendered-bs-gone="removed">
                    {frame(
                        <>
                            {body(v.text)}
                            {v.path != null ? <span className={MONO_PATH}>{v.path}</span> : null}
                        </>,
                        v.title,
                        false
                    )}
                </div>
            )}
        </ViewSwap>
    );
}
