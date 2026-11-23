// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { turnTransition } from "@/app/element/motiontokens";
import { MONO_FAINT } from "@/app/view/jarvis/briefstyle";
import { cn } from "@/util/util";
import { Ban, Check, ChevronDown, ChevronRight, Ellipsis, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ActionDetail, DiffLine } from "./agentsviewmodel";
import { BODY_LINES_MAX, capDiffFiles, capGrepGroups, capGroups, capLines, capText, moreLinesLabel } from "./bodycap";
import { highlightLine } from "./highlight";
import {
    groupGrepMatches,
    isCodePath,
    newFileLines,
    parseLineGutter,
    pathSegmentsDroppable,
    pathTail,
    type GutterLine,
} from "./tooldetailmodel";

// one size for code across the transcript (tool panels, prose code blocks), sized to sit just under the 14px prose
export const CODE_TEXT = "text-[12.5px]";

// inline panels wrap long lines so a narrow card never scrolls sideways, breaking inside a token only when it is wider
// than the line; the modal has room, so it keeps them unwrapped
function lineWrap(variant: "inline" | "modal"): string {
    return variant === "inline" ? "whitespace-pre-wrap break-words" : "whitespace-pre";
}

// a list of paths: a wrapped path hangs right of its first line, so where the next one starts stays plain
const HANGING_INDENT = "pl-[2ch] [text-indent:-2ch]";

export const BODY_BUTTON =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 py-[3px] font-sans text-[12px] text-ink-mid hover:bg-lane hover:text-primary";

// a disclosure chevron that turns as its pane opens: right to down, or with `flip` down to up
export function TurnChevron({
    open,
    size,
    strokeWidth,
    flip,
}: {
    open: boolean;
    size: number;
    strokeWidth: number;
    flip?: boolean;
}) {
    const Icon = flip ? ChevronDown : ChevronRight;
    return (
        <Icon
            size={size}
            strokeWidth={strokeWidth}
            aria-hidden
            style={turnTransition}
            className={cn(
                "transition-transform motion-reduce:transition-none",
                open && (flip ? "rotate-180" : "rotate-90")
            )}
        />
    );
}

// the nearest ancestor that scrolls vertically
function scrollerOf(el: HTMLElement): HTMLElement | null {
    for (let p = el.parentElement; p != null; p = p.parentElement) {
        const overflow = getComputedStyle(p).overflowY;
        if ((overflow === "auto" || overflow === "scroll") && p.scrollHeight > p.clientHeight) {
            return p;
        }
    }
    return null;
}

// what an inline body's line cap left out, as the button that lifts the cap in place; expanded, it puts the cap back.
// A body that fits draws nothing. Collapsing from a long body's end would leave the reader far past it, so the button
// keeps its place in the viewport across the collapse.
export function MoreLines({
    hidden,
    label,
    expanded,
    onToggle,
    className,
}: {
    hidden: number;
    label?: string;
    expanded: boolean;
    onToggle: () => void;
    className?: string;
}) {
    const buttonRef = useRef<HTMLButtonElement>(null);
    // the button's viewport top when Show less was pressed, until the collapse lays out
    const collapseTopRef = useRef<number | null>(null);
    useLayoutEffect(() => {
        const top = collapseTopRef.current;
        const button = buttonRef.current;
        collapseTopRef.current = null;
        const scroller = top != null && button != null ? scrollerOf(button) : null;
        if (scroller != null) {
            scroller.scrollTop += button.getBoundingClientRect().top - top;
        }
    }, [expanded]);
    if (hidden <= 0) {
        return null;
    }
    const toggle = () => {
        if (expanded) {
            collapseTopRef.current = buttonRef.current?.getBoundingClientRect().top ?? null;
        }
        onToggle();
    };
    return (
        <div className={className}>
            <button
                ref={buttonRef}
                type="button"
                data-more-lines
                aria-expanded={expanded}
                onClick={toggle}
                className={cn(BODY_BUTTON, "-ml-1.5")}
            >
                <TurnChevron open={expanded} size={12} strokeWidth={2.2} flip />
                {expanded ? "Show less" : (label ?? moreLinesLabel(hidden))}
            </button>
        </div>
    );
}

// why a call was passed over rather than failed (a hook blocked it, the user declined it, a rule denied it): the Ban
// square and the reason in muted prose, never the error block
export function PassedOverNote({ text, declined, className }: { text: string; declined: boolean; className?: string }) {
    return (
        <div
            data-tool-note
            className={cn(
                "flex items-start gap-2 font-sans text-[12.5px] leading-[1.5] text-muted break-words",
                className
            )}
        >
            <span className="mt-[2px] flex shrink-0">
                <StatusSquare ok={false} blocked declined={declined} />
            </span>
            <span className="min-w-0">{text}</span>
        </div>
    );
}

// pending: the call has no result yet (running, or waiting on a permission prompt), so it claims neither outcome
export function StatusSquare({
    ok,
    blocked,
    declined,
    pending,
}: {
    ok: boolean;
    blocked?: boolean;
    declined?: boolean;
    pending?: boolean;
}) {
    // refused before it ran: grey, passed over rather than failed
    if (blocked) {
        return (
            <span
                role="img"
                aria-label={declined ? "Declined" : "Blocked"}
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
            <div className="min-w-0 flex-1 break-words">
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

// a path cut from the left a whole segment at a time ("…/hypotheses/FindingReport.jsx"), so its file name stays visible
// and the cut never lands mid-word; a file name wider than the box still truncates from its left. bdi keeps the path's
// own order under the rtl direction
function PanelPath({ path, className }: { path: string; className?: string }) {
    const ref = useRef<HTMLSpanElement>(null);
    // width is the box's last measured width: a fresh object on each change, so even a path already whole (drop 0)
    // commits and re-fits
    const [fit, setFit] = useState({ drop: 0, width: 0 });
    const droppable = pathSegmentsDroppable(path);
    useLayoutEffect(() => {
        const el = ref.current;
        if (el && fit.drop < droppable && el.scrollWidth > el.clientWidth) {
            setFit((f) => ({ ...f, drop: f.drop + 1 }));
        }
    }, [fit, droppable, path]);
    // a box that changes width fits the path again from whole
    useEffect(() => {
        const el = ref.current;
        if (!el) {
            return;
        }
        let width = el.clientWidth;
        const ro = new ResizeObserver(() => {
            if (el.clientWidth !== width) {
                width = el.clientWidth;
                setFit({ drop: 0, width });
            }
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return (
        <span ref={ref} data-panel-path dir="rtl" className={cn("min-w-0 flex-1 truncate text-left", className)}>
            <bdi dir="ltr">{pathTail(path, fit.drop)}</bdi>
        </span>
    );
}

// a file's lines with their numbers in a muted gutter of their own, so a wrapped line hangs under its text; plain
// text for a file the tokenizer would misread as code, and a grep line's matches marked. hang: a list of paths
function FileLines({
    lines,
    code,
    wrap,
    hang,
}: {
    lines: (GutterLine & { ranges?: [number, number][] })[];
    code: boolean;
    wrap: string;
    hang?: boolean;
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
                    <span
                        data-line-text
                        className={cn(
                            "min-w-0",
                            wrap,
                            !code && "text-secondary",
                            hang && widest === 0 && HANGING_INDENT
                        )}
                    >
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

// one diff line: the shared diff look (tailwindsetup.css) marks the side, the gutter holds the line's number (the new
// side's, a removed line's old one), or its sign when the diff carries no numbers
export function DiffRow({
    line,
    numbered,
    wrap,
    cited,
}: {
    line: DiffLine;
    numbered: boolean;
    wrap: string;
    // the row of the line a citation names: its number draws bold in accent-soft, the band is the diff's own
    cited?: boolean;
}) {
    const tint = line.sign === "+" ? "diff-line-added" : line.sign === "-" ? "diff-line-removed" : undefined;
    const gutter = numbered ? (line.sign === "-" ? line.oldNo : (line.newNo ?? line.oldNo)) : line.sign;
    return (
        <div
            data-diff-line={line.sign}
            data-diff-cited={cited || undefined}
            className={cn("flex pl-[3px] font-mono leading-[1.6]", CODE_TEXT, tint)}
        >
            <span
                data-diff-no
                className={cn(
                    "shrink-0 select-none text-right",
                    cited ? "font-bold text-accent-soft" : "text-ink-faint",
                    numbered ? "w-[42px] pr-3.5" : "w-[22px] pr-2"
                )}
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

// Shared per-kind detail renderer, inline and in the modal. capped: a transcript body, cut to BODY_LINES_MAX whole lines
// with an "N more lines" button under it that expands it in place (a step's panel, a card); the modal and a host that
// scrolls its own box draw it whole.
// hideCommand: the row's own text is the command, so the body does not repeat it.
// Tokens only — no raw hex. See StepsOpen.dc.html and Main.dc.html.
export function ToolDetailBody({
    detail,
    variant,
    capped,
    hideCommand,
}: {
    detail: ActionDetail;
    variant: "inline" | "modal";
    capped?: boolean;
    hideCommand?: boolean;
}) {
    const modal = variant === "modal";
    const pad = modal ? "px-4 py-3" : "px-3 py-2";
    const wrap = lineWrap(variant);
    const max = capped ? BODY_LINES_MAX : Infinity;
    const [expanded, setExpanded] = useState(false);
    const more = (hidden: number, className: string) => (
        <MoreLines hidden={hidden} expanded={expanded} onToggle={() => setExpanded((v) => !v)} className={className} />
    );
    if (detail.kind === "grep") {
        // one header per file, its lines numbered under it; inline wraps, the modal shows each line whole
        const all = groupGrepMatches(detail.matches, detail.pattern, detail.ignoreCase);
        const cut = capGrepGroups(all, max);
        const groups = expanded ? all : cut.groups;
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
                                hang={!g.file}
                            />
                        </div>
                    </div>
                ))}
                {more(cut.hidden, pad)}
                {detail.more ? <div className={cn(pad, MONO_FAINT)}>{detail.more}</div> : null}
            </div>
        );
    }
    if (detail.kind === "read") {
        // syntax-highlight the file body with the feed's lightweight tokenizer (same one CodeBlock uses).
        // Kept off shiki deliberately — the feed is on the cockpit boot path. No path (a Glob, an older record):
        // highlighted, as before, and a list of paths with no line numbers hangs its wrapped lines.
        const all: GutterLine[] =
            parseLineGutter(detail.snippet) ?? detail.snippet.split("\n").map((text) => ({ text }));
        const cut = capLines(all, max);
        const lines = expanded ? all : cut.lines;
        return (
            <div className={cn(pad, modal && "overflow-x-auto")}>
                <div className={cn("font-mono leading-[1.7]", CODE_TEXT, modal && "min-w-min")}>
                    <FileLines
                        lines={lines}
                        code={detail.path == null || isCodePath(detail.path)}
                        wrap={wrap}
                        hang={detail.path == null}
                    />
                </div>
                {more(cut.hidden, "mt-1")}
            </div>
        );
    }
    if (detail.kind === "bash") {
        // "$ cmd" and its output read as one terminal block, a gap between them
        const command = hideCommand ? "" : detail.command;
        if (!command && !detail.output) {
            return null;
        }
        const cut = capText(detail.output, max);
        const output = expanded ? detail.output : cut.text;
        return (
            <div className={pad}>
                {command ? (
                    <div
                        data-bash-command
                        className={cn(
                            "flex gap-2 whitespace-pre-wrap break-words font-mono leading-[1.7] text-foreground",
                            CODE_TEXT
                        )}
                    >
                        <span className="shrink-0 select-none text-accent">$</span>
                        <span className="min-w-0">{command}</span>
                    </div>
                ) : null}
                {output ? (
                    <pre
                        data-bash-output
                        className={cn(
                            "m-0 font-mono leading-[1.7]",
                            CODE_TEXT,
                            wrap,
                            command && "mt-1.5",
                            modal && "overflow-x-auto",
                            detail.exit ? "text-error" : "text-ink-mid"
                        )}
                    >
                        {output}
                    </pre>
                ) : null}
                {more(cut.hidden, "mt-1")}
            </div>
        );
    }
    if (detail.kind === "skill") {
        // the row and the modal's head already name the skill, so the body is its arguments alone
        const cut = capText(detail.args, max);
        const args = expanded ? detail.args : cut.text;
        return (
            <div className={pad}>
                <pre
                    className={cn(
                        "m-0 overflow-x-auto whitespace-pre-wrap break-words font-mono leading-[1.6] text-secondary",
                        CODE_TEXT
                    )}
                >
                    {args}
                </pre>
                {more(cut.hidden, "mt-1")}
            </div>
        );
    }
    if (detail.kind === "ask") {
        // a question is its group's header line, each option a line
        const cut = capGroups(
            detail.questions,
            (q) => q.options,
            (q, options) => ({ ...q, options }),
            () => true,
            max
        );
        const questions = expanded ? detail.questions : cut.groups;
        return (
            <div className="flex flex-col">
                {questions.map((q, i) => (
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
                {more(cut.hidden, pad)}
            </div>
        );
    }
    // edit: per file, a header (path, "new" for an added file, +a −d) over its lines; an added file is all one green
    // wall as a diff, so it previews as the file itself. A capped diff keeps each file's counts whole.
    const cut = capDiffFiles(detail.files, max);
    const files = expanded ? detail.files : cut.files;
    return (
        <div className="flex flex-col">
            {files.map((f, i) => {
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
                                                    "diff-hunk pl-[13px] pr-3.5 font-mono leading-[1.7]",
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
            {more(cut.hidden, pad)}
        </div>
    );
}
