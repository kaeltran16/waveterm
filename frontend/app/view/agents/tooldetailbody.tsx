// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { MONO_FAINT } from "@/app/view/jarvis/briefstyle";
import { cn } from "@/util/util";
import { Ban, Check, Ellipsis, X } from "lucide-react";
import type { ActionDetail, DiffLine } from "./agentsviewmodel";
import { highlightLine } from "./highlight";

// inline panels wrap long lines so a narrow card never scrolls sideways; the modal has room, so it keeps them unwrapped
function lineWrap(variant: "inline" | "modal"): string {
    return variant === "inline" ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre";
}

// a failure's code only: exit 0 is the normal case, and null means the command never ran
function ExitChip({ exit }: { exit: number | null }) {
    if (!exit) {
        return null;
    }
    return <span className="rounded-[4px] bg-error/15 px-1.5 py-px font-mono text-[11px] text-error">exit {exit}</span>;
}

// pending: the call has no result yet (running, or waiting on a permission prompt), so it claims neither outcome
export function StatusSquare({ ok, blocked, pending }: { ok: boolean; blocked?: boolean; pending?: boolean }) {
    // refused before it ran: grey, passed over rather than failed
    if (blocked) {
        return (
            <span
                role="img"
                aria-label="Blocked"
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-surface-hover text-muted"
            >
                <Ban size={10} strokeWidth={2.6} aria-hidden />
            </span>
        );
    }
    if (pending) {
        return (
            <span
                role="img"
                aria-label="No result yet"
                data-status-pending
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-surface-raised text-muted"
            >
                <Ellipsis size={10} strokeWidth={3} aria-hidden />
            </span>
        );
    }
    return (
        <span
            role="img"
            aria-label={ok ? "Succeeded" : "Failed"}
            className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px]",
                ok ? "bg-success/15 text-success" : "bg-error/15 text-error"
            )}
        >
            {ok ? <Check size={10} strokeWidth={3} aria-hidden /> : <X size={10} strokeWidth={3} aria-hidden />}
        </span>
    );
}

// One option of an asked question. The check and the weight mark a picked one, so colour is not the only signal.
function AskOptionLine({
    label,
    description,
    picked,
    note,
}: {
    label: string;
    description?: string;
    picked: boolean;
    note?: string;
}) {
    return (
        <div className="flex items-start gap-2">
            <span
                className={cn(
                    "mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px]",
                    picked && "bg-accent/[0.12] text-accent-soft"
                )}
            >
                {picked ? <Check size={10} strokeWidth={3} aria-hidden /> : null}
            </span>
            <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <div className={cn("text-[12.5px]", picked ? "font-semibold text-primary" : "text-ink-mid")}>{label}</div>
                {description ? (
                    <div className={cn("text-[12px] leading-[1.5]", picked ? "text-ink-mid" : "text-muted")}>
                        {description}
                    </div>
                ) : null}
            </div>
            {note ? <span className={cn("shrink-0", MONO_FAINT)}>{note}</span> : null}
        </div>
    );
}

function HighlightedCode({ text }: { text: string }) {
    return (
        <>
            {highlightLine(text).map((tk, k) => (
                <span key={k} className={tk.cls}>
                    {tk.t}
                </span>
            ))}
        </>
    );
}

// one diff line: a 3px edge and a tint mark the side, the gutter holds the line's number (the new side's, a removed
// line's old one), or its sign when the diff carries no numbers
function DiffRow({ line, numbered, wrap }: { line: DiffLine; numbered: boolean; wrap: string }) {
    const tint =
        line.sign === "+"
            ? "border-l-diff-added bg-diff-added/10"
            : line.sign === "-"
              ? "border-l-diff-removed bg-diff-removed/10"
              : "border-l-transparent";
    const gutter = numbered ? (line.sign === "-" ? line.oldNo : (line.newNo ?? line.oldNo)) : line.sign;
    return (
        <div data-diff-line={line.sign} className={cn("flex border-l-[3px] font-mono text-[12px] leading-[1.6]", tint)}>
            <span
                data-diff-no
                className={cn("shrink-0 select-none text-right text-ink-faint", numbered ? "w-[42px] pr-3.5" : "w-[22px] pr-2")}
            >
                {gutter}
            </span>
            {/* the gutter stays put, so a wrapped line hangs under its own text */}
            <span className={cn("min-w-0 pr-3.5", wrap)}>
                <HighlightedCode text={line.text} />
            </span>
        </div>
    );
}

// Shared per-kind detail renderer. Used inline (capped by max-height) and by the modal (uncapped).
// Tokens only — no raw hex. See StepsOpen.dc.html and Main.dc.html.
export function ToolDetailBody({ detail, variant }: { detail: ActionDetail; variant: "inline" | "modal" }) {
    const modal = variant === "modal";
    const pad = modal ? "px-4 py-3" : "px-3 py-2";
    const wrap = lineWrap(variant);
    if (detail.kind === "grep") {
        return (
            <div className={pad}>
                {detail.matches.map((g, i) => (
                    <div key={i} className="flex gap-3 whitespace-pre font-mono text-[11.5px] leading-[1.7]">
                        <span className="shrink-0 text-muted">{g.loc}</span>
                        <span className="min-w-0 flex-1 truncate text-secondary">{g.code}</span>
                    </div>
                ))}
                {detail.more ? <div className={cn("pt-1.5", MONO_FAINT)}>{detail.more}</div> : null}
            </div>
        );
    }
    if (detail.kind === "read") {
        // syntax-highlight the file body with the feed's lightweight tokenizer (same one CodeBlock uses).
        // Kept off shiki deliberately — the feed is on the cockpit boot path.
        return (
            <div className={cn(pad, modal && "overflow-x-auto")}>
                <div className={cn("font-mono text-[11.5px] leading-[1.7]", modal && "min-w-min")}>
                    {detail.snippet.split("\n").map((ln, i) => (
                        <div key={i} className={wrap}>
                            <HighlightedCode text={ln} />
                        </div>
                    ))}
                </div>
            </div>
        );
    }
    if (detail.kind === "bash") {
        // "$ cmd" and its output read as one terminal block
        return (
            <div className={pad}>
                {detail.command ? (
                    <div className="flex gap-2 whitespace-pre-wrap font-mono text-[11.5px] leading-[1.7] text-foreground [overflow-wrap:anywhere]">
                        <span className="shrink-0 select-none text-accent">$</span>
                        <span>{detail.command}</span>
                    </div>
                ) : null}
                {detail.output ? (
                    <pre
                        className={cn(
                            "m-0 font-mono text-[11.5px] leading-[1.7]",
                            wrap,
                            modal && "overflow-x-auto",
                            detail.exit ? "text-error" : "text-ink-mid"
                        )}
                    >
                        {detail.output}
                    </pre>
                ) : null}
                {/* inline, the step row's own exit chip already names a failure */}
                {modal && detail.exit ? (
                    <div className="mt-2 flex items-center gap-2">
                        <ExitChip exit={detail.exit} />
                    </div>
                ) : null}
            </div>
        );
    }
    if (detail.kind === "skill") {
        return (
            <div className={pad}>
                <div className="flex items-center gap-2 font-mono text-[11.5px]">
                    <span className="text-syntax-keyword">skill</span>
                    <span className="text-primary">{detail.name}</span>
                </div>
                {detail.args ? (
                    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.6] text-secondary">
                        {detail.args}
                    </pre>
                ) : null}
            </div>
        );
    }
    if (detail.kind === "ask") {
        return (
            <div className="flex flex-col">
                {detail.questions.map((q, i) => (
                    <div key={i} className={cn("flex flex-col gap-[5px] border-b border-edge-faint last:border-b-0", pad)}>
                        {q.header ? <span className={MONO_FAINT}>{q.header}</span> : null}
                        <div className="text-[12.5px] leading-[1.5] text-secondary">{q.question}</div>
                        {q.options.map((o, k) => (
                            <AskOptionLine
                                key={k}
                                label={o.label}
                                description={o.description}
                                picked={q.picked.includes(o.label)}
                            />
                        ))}
                        {q.typed ? <AskOptionLine label={q.typed} picked note="typed" /> : null}
                    </div>
                ))}
            </div>
        );
    }
    // edit: per file, a header (path, "new" for an added file, +a −d) over its lines
    return (
        <div className="flex flex-col">
            {detail.files.map((f, i) => {
                const numbered = f.lines.some((l) => l.oldNo != null || l.newNo != null);
                return (
                    <div key={i} data-diff-file className="border-b border-edge-faint last:border-b-0">
                        <div className="flex items-center gap-2 border-b border-edge-faint px-3 py-1.5 font-mono text-[11.5px]">
                            <span className="min-w-0 flex-1 truncate text-ink-mid">{f.path}</span>
                            {f.badge === "A" ? <span className="shrink-0 text-success">new</span> : null}
                            <span className={cn("shrink-0", f.adds > 0 ? "text-diff-added" : "text-muted")}>+{f.adds}</span>
                            <span className={cn("shrink-0", f.dels > 0 ? "text-diff-removed" : "text-muted")}>−{f.dels}</span>
                        </div>
                        <div className={cn("py-2", modal && "overflow-x-auto")}>
                            <div className={modal ? "min-w-min" : undefined}>
                                {f.lines.map((l, k) =>
                                    l.hunk ? (
                                        <div
                                            key={k}
                                            data-diff-hunk
                                            className={cn(
                                                "bg-accent/[0.06] pl-[13px] pr-3.5 font-mono text-[11.5px] leading-[1.7] text-muted",
                                                wrap,
                                                k > 0 && "mt-1"
                                            )}
                                        >
                                            {l.text}
                                        </div>
                                    ) : (
                                        <DiffRow key={k} line={l} numbered={numbered} wrap={wrap} />
                                    )
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
