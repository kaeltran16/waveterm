// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { shellRunLines } from "./shellrunmodel";

// A `!` command the human ran in Claude Code's bash mode: the command over its output, styled as the Bash step's
// opened panel (ToolDetailBody's bash body), with stderr in the error colour.

const OUTPUT = "m-0 whitespace-pre-wrap font-mono text-[11.5px] leading-[1.7] [overflow-wrap:anywhere]";

export function ShellRunRow({
    command,
    stdout,
    stderr,
    compact,
}: {
    command: string;
    stdout?: string;
    stderr?: string;
    compact: boolean;
}) {
    const [open, setOpen] = useState(false);
    const running = stdout === undefined && stderr === undefined;
    const shown = shellRunLines(stdout, stderr, open);
    const pad = compact ? "px-2.5 py-1.5" : "px-3 py-2";
    return (
        <div
            data-shell-run
            className={cn(
                "overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code",
                compact ? "my-2" : "my-2.5"
            )}
        >
            <div className={cn("flex items-start gap-2 font-mono text-[11.5px] leading-[1.7]", pad)}>
                <span className="shrink-0 select-none text-accent">!</span>
                <span
                    data-shell-command
                    className="min-w-0 flex-1 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]"
                >
                    {command}
                </span>
                {running ? (
                    <span
                        data-shell-status="running"
                        className="inline-flex shrink-0 items-center gap-1.5 font-sans text-[12px] text-muted"
                    >
                        <LoaderCircle size={12} strokeWidth={2.2} className="animate-spin" aria-hidden />
                        running
                    </span>
                ) : null}
            </div>
            {running ? null : (
                <div className={cn("border-t border-edge-faint", pad)}>
                    {shown.total === 0 ? (
                        <div data-shell-status="empty" className="text-[12px] text-muted">
                            no output
                        </div>
                    ) : null}
                    {shown.stdout.length > 0 ? (
                        <pre data-shell-stdout className={cn(OUTPUT, "text-ink-mid")}>
                            {shown.stdout.join("\n")}
                        </pre>
                    ) : null}
                    {shown.stderr.length > 0 ? (
                        <pre data-shell-stderr className={cn(OUTPUT, "text-error")}>
                            {shown.stderr.join("\n")}
                        </pre>
                    ) : null}
                    {shown.showAll || shown.showLess ? (
                        <button
                            type="button"
                            data-shell-more
                            aria-expanded={open}
                            onClick={() => setOpen((v) => !v)}
                            className="mt-1 cursor-pointer text-[12px] text-accent-soft hover:text-primary"
                        >
                            {shown.showLess ? "Show less" : `Show all ${shown.total} lines`}
                        </button>
                    ) : null}
                </div>
            )}
        </div>
    );
}
