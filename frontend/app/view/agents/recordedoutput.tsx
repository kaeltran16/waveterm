// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// what a Bash step printed, as recorded in the transcript: the raw view of a card, and what a wsh card or view falls
// back to when its fetch fails.

import { cn } from "@/util/util";
import { useState } from "react";
import type { AgentActionEntry } from "./agentsviewmodel";
import { capText } from "./bodycap";
import { stripAnsi } from "./testoutput";
import { MoreLines } from "./tooldetailbody";

// inline, so capped to the body's line count; its button expands the rest in place
export function RecordedOutput({ output, compact }: { output: string; compact?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const all = stripAnsi(output).replace(/\n+$/, "");
    const cut = capText(all);
    const pad = compact ? "px-[9px]" : "px-[11px]";
    return (
        <>
            <pre
                data-recorded-output
                className={cn(
                    "m-0 whitespace-pre-wrap break-words font-mono text-ink-mid",
                    pad,
                    compact ? "py-[7px] text-[11px] leading-[1.6]" : "py-[9px] text-[11.5px] leading-[1.7]"
                )}
            >
                {expanded ? all : cut.text}
            </pre>
            <MoreLines
                hidden={cut.hidden}
                expanded={expanded}
                onToggle={() => setExpanded((v) => !v)}
                className={cn("-mt-1 pb-[7px]", pad)}
            />
        </>
    );
}

function recordedOf(action: AgentActionEntry | undefined): string {
    return action?.detail?.kind === "bash" ? action.detail.output : "";
}

// a fetch that failed: one muted line naming the error over the step's recorded output, boxed and capped like any
// inline body, so the card or view still shows what the call printed
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
                <div
                    data-wsh-load-output
                    className="mt-1.5 overflow-hidden rounded-[6px] border border-edge-faint bg-surface"
                >
                    <RecordedOutput output={output} compact={compact} />
                </div>
            ) : null}
        </div>
    );
}
