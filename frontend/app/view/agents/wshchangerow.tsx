// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A wsh change call whose family draws no card of its own: what it ran, how long it took, and its raw command and
// output one click away, so the change reads as done and its facts stay visible. Also the flat verb row every card
// family draws a one-line event with.

import { modalsModel } from "@/app/store/modalmodel";
import { cn } from "@/util/util";
import { ArrowUpRight, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentActionEntry } from "./agentsviewmodel";
import { formatDuration } from "./tooldetail";
import type { WshCall } from "./wshcall";

// the call's flags back as argv words, so the row shows what was passed
function flagWords(flags: WshCall["flags"]): string[] {
    return Object.entries(flags).map(([k, v]) => (v === true ? `--${k}` : `--${k} ${v}`));
}

// every wsh card keeps the call's facts: how long it took, and its raw command and output one click away
export function CallFacts({ action, compact }: { action: AgentActionEntry; compact: boolean }) {
    return (
        <>
            {action.durationMs ? (
                <span className={cn("shrink-0 font-mono text-ink-faint", compact ? "text-[10.5px]" : "text-[11px]")}>
                    {formatDuration(action.durationMs)}
                </span>
            ) : null}
            <button
                type="button"
                aria-label="Show the command"
                onClick={() => modalsModel.pushModal("AgentToolDetailModal", { action })}
                className="flex shrink-0 cursor-pointer rounded-[5px] p-0.5 text-muted hover:bg-surface-hover hover:text-primary"
            >
                <ArrowUpRight size={13} strokeWidth={2.2} aria-hidden />
            </button>
        </>
    );
}

// a successful one-line wsh event with no body to show: an icon, what happened, what it happened to, and the call's
// facts, borderless; every such event draws through this one row so Retried, Run complete and Saved a note match
export function WshVerbRow({
    icon,
    verb,
    children,
    right,
    action,
    compact,
    attrs,
}: {
    icon: ReactNode;
    verb: string;
    children?: ReactNode; // the subject, after the verb; it must truncate (min-w-0), the verb never does
    right?: ReactNode; // before the call's facts
    action: AgentActionEntry;
    compact: boolean;
    attrs?: Record<`data-${string}`, string>;
}) {
    return (
        <div
            data-wsh-row
            {...attrs}
            className={cn(
                "flex min-w-0 items-center font-sans text-ink-mid",
                compact ? "gap-[7px] py-0.5 text-[12.5px]" : "gap-2.5 px-0.5 py-1 text-[13.5px]"
            )}
        >
            {icon}
            <span data-wsh-verb className="shrink-0">
                {verb}
            </span>
            {children}
            <span className="flex-1" />
            {right}
            <CallFacts action={action} compact={compact} />
        </div>
    );
}

export function WshChangeRow({ call, action, compact }: { call: WshCall; action: AgentActionEntry; compact: boolean }) {
    const args = [...call.args, ...flagWords(call.flags)].join(" ");
    return (
        <div
            data-wsh-change={call.path.join(" ")}
            className={cn(
                "flex items-center border border-edge-mid bg-surface-raised font-sans text-ink-mid",
                compact
                    ? "gap-2 rounded-[8px] px-2.5 py-[7px] text-[12.5px]"
                    : "gap-2.5 rounded-[10px] px-3.5 py-2.5 text-[13.5px]"
            )}
        >
            <SquareTerminal
                size={compact ? 13 : 14}
                strokeWidth={2}
                className="shrink-0 text-accent-soft"
                aria-hidden
            />
            <span className={cn("shrink-0 font-mono text-ink-hi", compact ? "text-[11px]" : "text-[12px]")}>
                wsh {call.path.join(" ")}
            </span>
            {args ? (
                <span
                    className={cn("min-w-0 truncate font-mono text-ink-faint", compact ? "text-[11px]" : "text-[12px]")}
                >
                    {args}
                </span>
            ) : null}
            <span className="flex-1" />
            <CallFacts action={action} compact={compact} />
        </div>
    );
}
