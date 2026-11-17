// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// what a Bash step printed, as recorded in the transcript: the raw view of a card, and what a wsh card or view falls
// back to when its fetch fails.

import { cn } from "@/util/util";
import type { AgentActionEntry } from "./agentsviewmodel";
import { stripAnsi } from "./testoutput";

export function RecordedOutput({ output, compact }: { output: string; compact?: boolean }) {
    return (
        <pre
            data-recorded-output
            className={cn(
                "m-0 whitespace-pre-wrap font-mono text-ink-mid [overflow-wrap:anywhere]",
                compact
                    ? "px-[9px] py-[7px] text-[11px] leading-[1.6]"
                    : "px-[11px] py-[9px] text-[11.5px] leading-[1.7]"
            )}
        >
            {stripAnsi(output).replace(/\n+$/, "")}
        </pre>
    );
}

function recordedOf(action: AgentActionEntry | undefined): string {
    return action?.detail?.kind === "bash" ? action.detail.output : "";
}

// a fetch that failed: one muted line naming the error over the step's recorded output, so the card or view still
// shows what the call printed
export function LoadFailure({
    message,
    action,
    compact,
    className,
}: {
    message: string;
    action?: AgentActionEntry; // a card drawn outside a step (a wake's Final card) has no recorded output
    compact?: boolean;
    className?: string;
}) {
    const output = recordedOf(action);
    return (
        <div data-wsh-load-failure className={cn("min-w-0", className)}>
            <div
                data-wsh-load-error
                title={message}
                className={cn("truncate text-muted", compact ? "text-[11.5px]" : "text-[12px]")}
            >
                {message}
            </div>
            {output.trim() ? (
                <div className="mt-1.5 overflow-hidden rounded-[6px] border border-edge-faint bg-surface">
                    <RecordedOutput output={output} compact={compact} />
                </div>
            ) : null}
        </div>
    );
}
