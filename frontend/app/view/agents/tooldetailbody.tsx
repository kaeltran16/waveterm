// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { MONO_FAINT } from "@/app/view/jarvis/briefstyle";
import { cn } from "@/util/util";
import { Ban, Check, Ellipsis, X } from "lucide-react";
import type { ActionDetail, DiffLine } from "./agentsviewmodel";
import { highlightLine } from "./highlight";
import { groupGrepMatches, isCodePath, newFileLines, parseLineGutter, type GutterLine } from "./tooldetailmodel";

// one size for code across the transcript (tool panels, prose code blocks), sized to sit just under the 14px prose
export const CODE_TEXT = "text-[12.5px]";

// inline panels wrap long lines so a narrow card never scrolls sideways; the modal has room, so it keeps them unwrapped
function lineWrap(variant: "inline" | "modal"): string {
    return variant === "inline" ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre";
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

// a path cut from the left, so its file name stays visible; bdi keeps the path's own order under the rtl direction
function PanelPath({ path, className }: { path: string; className?: string }) {
    return (
        <span data-panel-path dir="rtl" className={cn("min-w-0 flex-1 truncate text-left", className)}>
            <bdi dir="ltr">{path}</bdi>
        </span>
    );
}

// a file's lines with their numbers in a muted gutter of their own, so a wrapped line hangs under its text; plain
// text for a file the tokenizer would misread as code, and a grep line's matches marked
function FileLines({
    lines,
    code,
    wrap,
}: {
    lines: (GutterLine & { ranges?: [number, number][] })[];
    code: boolean;
    wrap: string;
}) {
    const widest = lines.reduce((n, l) => Math.max(n, String(l.no ?? "").length), 0);
    return (
        <>
            {lines.map((l, i) => (
                <div key={i} data-file-line className="flex gap-3">
                    {widest > 0 ? (
                        <span
                            data-line-no
                            className="shrink-0 select-none text-right text-ink-faint"
                            style={{ minWidth: `${widest}ch` }}
                        >
                            {l.no}
                        </span>
                    ) : null}
                    <span data-line-text className={cn("min-w-0", wrap, !code && "text-secondary")}>
                        {l.ranges ? (
                            <MarkedLine code={l.text} ranges={l.ranges} />
                        ) : code ? (
                            <HighlightedCode text={l.text} />
                        ) : (
                            l.text || " "
                        )}
                    </span>
                </div>
            ))}
        </>
    );
}

// a grep line with its matches marked
function MarkedLine({ code, ranges }: { code: string; ranges: [number, number][] }) {
    const parts: React.ReactNode[] = [];
    let at = 0;
    ranges.forEach(([start, end], k) => {
        parts.push(code.slice(at, start));
        parts.push(
            <mark key={k} data-grep-hit className="rounded-[3px] bg-accent/20 text-primary">
                {code.slice(start, end)}
            </mark>
        );
        at = end;
    });
    parts.push(code.slice(at));
    return <>{parts}</>;
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
        <div data-diff-line={line.sign} className={cn("flex border-l-[3px] font-mono leading-[1.6]", CODE_TEXT, tint)}>
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
        // one header per file, its lines numbered under it; inline wraps, the modal shows each line whole
        const groups = groupGrepMatches(detail.matches, detail.pattern, detail.ignoreCase);
        return (
            <div className={cn("flex flex-col", modal && "overflow-x-auto")}>
                {groups.map((g, i) => (
                    <div
                        key={i}
                        data-grep-group
                        className={cn("border-b border-edge-faint last:border-b-0", modal && "min-w-min")}
                    >
                        {g.file ? (
                            <div
                                data-grep-file
                                className={cn(
                                    "flex border-b border-edge-faint px-3 py-1.5 font-mono text-ink-mid",
                                    CODE_TEXT
                                )}
                            >
                                <PanelPath path={g.file} />
                            </div>
                        ) : null}
                        <div className={cn(pad, "font-mono leading-[1.7]", CODE_TEXT)}>
                            <FileLines
                                lines={g.lines.map((l) => ({ no: l.line, text: l.code, ranges: l.ranges }))}
                                code={false}
                                wrap={wrap}
                            />
                        </div>
                    </div>
                ))}
                {detail.more ? <div className={cn(pad, MONO_FAINT)}>{detail.more}</div> : null}
            </div>
        );
    }
    if (detail.kind === "read") {
        // syntax-highlight the file body with the feed's lightweight tokenizer (same one CodeBlock uses).
        // Kept off shiki deliberately — the feed is on the cockpit boot path. No path (a Glob, an older record):
        // highlighted, as before.
        const lines = parseLineGutter(detail.snippet) ?? detail.snippet.split("\n").map((text) => ({ text }));
        return (
            <div className={cn(pad, modal && "overflow-x-auto")}>
                <div className={cn("font-mono leading-[1.7]", CODE_TEXT, modal && "min-w-min")}>
                    <FileLines lines={lines} code={detail.path == null || isCodePath(detail.path)} wrap={wrap} />
                </div>
            </div>
        );
    }
    if (detail.kind === "bash") {
        // "$ cmd" and its output read as one terminal block
        return (
            <div className={pad}>
                {detail.command ? (
                    <div
                        className={cn(
                            "flex gap-2 whitespace-pre-wrap font-mono leading-[1.7] text-foreground [overflow-wrap:anywhere]",
                            CODE_TEXT
                        )}
                    >
                        <span className="shrink-0 select-none text-accent">$</span>
                        <span>{detail.command}</span>
                    </div>
                ) : null}
                {detail.output ? (
                    <pre
                        className={cn(
                            "m-0 font-mono leading-[1.7]",
                            CODE_TEXT,
                            wrap,
                            modal && "overflow-x-auto",
                            detail.exit ? "text-error" : "text-ink-mid"
                        )}
                    >
                        {detail.output}
                    </pre>
                ) : null}
            </div>
        );
    }
    if (detail.kind === "skill") {
        return (
            <div className={pad}>
                <div className={cn("flex items-center gap-2 font-mono", CODE_TEXT)}>
                    <span className="text-syntax-keyword">skill</span>
                    <span className="text-primary">{detail.name}</span>
                </div>
                {detail.args ? (
                    <pre
                        className={cn(
                            "mt-1.5 overflow-x-auto whitespace-pre-wrap break-words font-mono leading-[1.6] text-secondary",
                            CODE_TEXT
                        )}
                    >
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
    // edit: per file, a header (path, "new" for an added file, +a −d) over its lines; an added file is all one green
    // wall as a diff, so it previews as the file itself
    return (
        <div className="flex flex-col">
            {detail.files.map((f, i) => {
                const numbered = f.lines.some((l) => l.oldNo != null || l.newNo != null);
                const added = f.badge === "A";
                return (
                    <div key={i} data-diff-file className="border-b border-edge-faint last:border-b-0">
                        <div
                            className={cn(
                                "flex items-center gap-2 border-b border-edge-faint px-3 py-1.5 font-mono",
                                CODE_TEXT
                            )}
                        >
                            <PanelPath path={f.path} className="text-ink-mid" />
                            {added ? <span className="shrink-0 text-success">new</span> : null}
                            <span className={cn("shrink-0", f.adds > 0 ? "text-diff-added" : "text-muted")}>+{f.adds}</span>
                            <span className={cn("shrink-0", f.dels > 0 ? "text-diff-removed" : "text-muted")}>−{f.dels}</span>
                        </div>
                        {added ? (
                            <div data-file-preview className={cn("px-3 py-2", modal && "overflow-x-auto")}>
                                <div className={cn("font-mono leading-[1.7]", CODE_TEXT, modal && "min-w-min")}>
                                    <FileLines lines={newFileLines(f)} code={isCodePath(f.path)} wrap={wrap} />
                                </div>
                            </div>
                        ) : (
                            <div className={cn("py-2", modal && "overflow-x-auto")}>
                                <div className={modal ? "min-w-min" : undefined}>
                                    {f.lines.map((l, k) =>
                                        l.hunk ? (
                                            <div
                                                key={k}
                                                data-diff-hunk
                                                className={cn(
                                                    "bg-accent/[0.06] pl-[13px] pr-3.5 font-mono leading-[1.7] text-muted",
                                                    CODE_TEXT,
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
                        )}
                    </div>
                );
            })}
        </div>
    );
}
