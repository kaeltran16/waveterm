// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A wsh change call whose family draws no card of its own: what it ran, how long it took, and its raw command and
// output one click away, so the change reads as done and its facts stay visible.

import { modalsModel } from "@/app/store/modalmodel";
import { cn } from "@/util/util";
import { ArrowUpRight, SquareTerminal } from "lucide-react";
import type { AgentActionEntry } from "./agentsviewmodel";
import { formatDuration } from "./tooldetail";
import type { WshCall } from "./wshcall";

// the call's flags back as argv words, so the row shows what was passed
function flagWords(flags: WshCall["flags"]): string[] {
    return Object.entries(flags).map(([k, v]) => (v === true ? `--${k}` : `--${k} ${v}`));
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
        </div>
    );
}
