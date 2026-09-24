// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The universal search's rows and groups. Presentational only: command-palette.tsx builds the rows and
// owns selection. One column, no preview pane — what a preview earned (an asking agent's question) is
// that row's second line, and the footer spells out what Enter does.

import { formatChord } from "@/util/keysym";
import { cn } from "@/util/util";
import {
    Contrast,
    CornerDownRight,
    Crosshair,
    File,
    FileText,
    Flag,
    GitFork,
    Hash,
    History,
    MessageCircleQuestionMark,
    PanelLeft,
    Play,
    Search,
    SquareTerminal,
    Zap,
    type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";
import type { CappedGroup, GroupKind } from "./palette-groups";
import type { LaunchIcon } from "./palette-launch";
import { fuzzyMatch, highlightRuns } from "./palette-match";

export type StatusTone = "asking" | "working" | "muted";

export interface PaletteItem {
    key: string;
    kind: GroupKind;
    search: string; // matched text (title + keywords); "" for rows that are never ranked
    title: string;
    hl?: string; // what to highlight in the title when it differs from the query (files: the path part)
    sub?: string; // second line: an asking agent's question
    status?: { label: string; tone: StatusTone };
    meta?: string;
    chord?: string; // keybinding descriptor for formatChord
    swatch?: string[]; // theme rows: the theme's own colors
    archived?: boolean;
    desc?: string; // launch rows: mono subtitle
    launchIcon?: LaunchIcon; // launch rows
    verb: string; // what Enter does, shown on the selected row
    echo: string; // the whole action, shown in the footer
    run: () => void;
}

// a play glyph for commands, matching their Run verb: '›' means "opens a sub-list", and ⌘ is a Mac key
const KIND_ICONS: Partial<Record<GroupKind, LucideIcon>> = {
    surface: PanelLeft,
    agent: SquareTerminal,
    run: GitFork,
    session: History,
    record: FileText,
    effort: Flag,
    channel: Hash,
    command: Play,
    file: File,
    theme: Contrast,
    "focus-task": Crosshair,
    "as-goal": Zap,
    widen: Search,
    line: CornerDownRight,
};

const LAUNCH_ICONS: Record<LaunchIcon, LucideIcon> = {
    quick: Zap,
    orchestrate: GitFork,
    ask: MessageCircleQuestionMark,
};

const TONE_TEXT: Record<StatusTone, string> = { asking: "text-asking", working: "text-working", muted: "text-muted" };
const TONE_DOT: Record<StatusTone, string> = { asking: "bg-asking", working: "bg-working", muted: "bg-muted" };

// Positions index the string that was matched, and item.search is not what a row displays — for an
// agent it is name + task + project while the title is "name — task". So the row re-matches against
// its own title; a query that hit only keywords renders unhighlighted, which beats bolding the wrong
// characters.
function Highlighted({ text, query }: { text: string; query: string }) {
    const runs = useMemo(() => {
        if (query.trim() === "") {
            return null;
        }
        const m = fuzzyMatch(query, text);
        return m == null || m.positions.length === 0 ? null : highlightRuns(text, m.positions);
    }, [text, query]);
    if (runs == null) {
        return <>{text}</>;
    }
    return (
        <>
            {runs.map((r, i) =>
                r.hit ? (
                    <span key={i} className="font-semibold text-primary">
                        {r.text}
                    </span>
                ) : (
                    <span key={i}>{r.text}</span>
                )
            )}
        </>
    );
}

function VerbHint({ verb }: { verb: string }) {
    return <span className="shrink-0 font-mono text-[10.5px] text-accent-soft">{verb} ⏎</span>;
}

interface RowProps {
    it: PaletteItem;
    idx: number;
    active: boolean;
    query: string;
    onHover: (idx: number) => void;
    onFire: (it: PaletteItem) => void;
}

function RichRow({ it, idx, active, onHover, onFire }: RowProps) {
    const Icon = LAUNCH_ICONS[it.launchIcon ?? "quick"];
    return (
        <button
            type="button"
            role="option"
            aria-selected={active}
            data-idx={idx}
            onMouseMove={() => onHover(idx)}
            onClick={() => onFire(it)}
            className={cn(
                "flex h-[38px] w-full cursor-pointer items-center gap-[11px] rounded-lg px-2 text-left transition-colors duration-[140ms]",
                active ? "bg-accentbg" : "hover:bg-surface-hover"
            )}
        >
            <span
                className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border",
                    active ? "border-accent-700 text-accent-soft" : "border-edge-mid text-ink-mid"
                )}
            >
                <Icon size={13} strokeWidth={2} />
            </span>
            <span className={cn("shrink-0 text-[13px] font-medium", active ? "text-primary" : "text-secondary")}>
                {it.title}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted">{it.desc}</span>
            {active ? <VerbHint verb={it.verb} /> : null}
        </button>
    );
}

function PlainRow({ it, idx, active, query, onHover, onFire }: RowProps) {
    const Icon = KIND_ICONS[it.kind] ?? Play;
    const plainTitle = it.kind === "as-goal" || it.kind === "widen" || it.kind === "line";
    return (
        <button
            type="button"
            role="option"
            aria-selected={active}
            data-idx={idx}
            onMouseMove={() => onHover(idx)}
            onClick={() => onFire(it)}
            className={cn(
                "flex w-full cursor-pointer gap-2.5 rounded-lg px-2.5 text-left transition-colors duration-[140ms]",
                it.sub ? "h-[50px] items-start pt-[9px]" : "h-8 items-center",
                active ? "bg-accentbg" : "hover:bg-surface-hover"
            )}
        >
            <Icon
                size={14}
                strokeWidth={1.8}
                className={cn("shrink-0", it.sub && "mt-px", active ? "text-accent-soft" : "text-ink-mid")}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span
                    className={cn(
                        "truncate text-[13px]",
                        active ? "text-primary" : it.archived ? "text-muted" : "text-secondary"
                    )}
                >
                    {plainTitle ? it.title : <Highlighted text={it.title} query={it.hl ?? query} />}
                </span>
                {it.sub ? <span className="truncate text-[12px] text-ink-mid">{it.sub}</span> : null}
            </span>
            {it.status ? (
                <span
                    className={cn(
                        "flex shrink-0 items-center gap-[5px] font-mono text-[10.5px]",
                        TONE_TEXT[it.status.tone]
                    )}
                >
                    <span className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[it.status.tone])} />
                    {it.status.label}
                </span>
            ) : null}
            {it.swatch ? (
                <span className="flex shrink-0 gap-[3px]">
                    {it.swatch.map((c, i) => (
                        // the theme's own colors are the data this row shows, not a style choice
                        <span
                            key={i}
                            className="h-2.5 w-2.5 rounded-[3px] border border-edge-strong"
                            style={{ backgroundColor: c }}
                        />
                    ))}
                </span>
            ) : null}
            {it.archived ? (
                <span className="shrink-0 rounded-[5px] border border-edge-mid px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                    archived
                </span>
            ) : null}
            {it.meta ? (
                <span className="max-w-[190px] shrink-0 truncate font-mono text-[10.5px] text-muted">{it.meta}</span>
            ) : null}
            {it.chord ? (
                <span className="flex shrink-0 gap-[3px]">
                    {formatChord(it.chord).map((k, i) => (
                        <span
                            key={i}
                            className="rounded-[5px] border border-edge-mid px-1.5 py-px font-mono text-[10.5px] text-muted"
                        >
                            {k}
                        </span>
                    ))}
                </span>
            ) : null}
            {active ? <VerbHint verb={it.verb} /> : null}
        </button>
    );
}

export interface GroupViewProps {
    group: CappedGroup<PaletteItem>;
    indexOf: Map<string, number>;
    selected: number;
    query: string;
    onHover: (idx: number) => void;
    onFire: (it: PaletteItem) => void;
}

export function PaletteGroupView({ group, indexOf, selected, query, onHover, onFire }: GroupViewProps) {
    const rows = group.items.map((it) => {
        const idx = indexOf.get(it.key)!;
        const props = { it, idx, active: idx === selected, query, onHover, onFire };
        return group.rich ? <RichRow key={it.key} {...props} /> : <PlainRow key={it.key} {...props} />;
    });
    if (group.rich) {
        // the one block that acts on your typed goal, so it is the one tinted with the accent
        return (
            <div className="my-1.5 rounded-[10px] bg-accent/5 px-1 pb-1 pt-0.5">
                <div className="px-2 pb-[5px] pt-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-accent-soft">
                    {group.label}
                </div>
                {rows}
            </div>
        );
    }
    return (
        <div>
            <div className="px-2.5 pb-1 pt-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                {group.label}
            </div>
            {group.emptyText ? (
                <div className="px-2.5 pb-3.5 pt-6 text-center text-[13px] text-muted">{group.emptyText}</div>
            ) : null}
            {rows}
            {group.overflow > 0 ? (
                <div className="py-0.5 pl-[34px] pr-2.5 font-mono text-[10.5px] text-muted">
                    +{group.overflow} more, keep typing
                </div>
            ) : null}
        </div>
    );
}
