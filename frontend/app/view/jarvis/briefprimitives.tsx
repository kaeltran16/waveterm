// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's region primitives: the head, the filter, the frame with its written absence, the overflow
// control, the queue summary, the initiative context menu and the live Runs row. briefsurface.tsx and its
// region components compose these; nothing here reads the briefing itself.

import { contextMenuAtom, ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { jumpToAgent } from "@/app/view/agents/channelsprimitives";
import { runAtom } from "@/app/view/agents/channelsstore";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { confirmCancelRun } from "@/app/view/agents/runactions";
import { leadAsker, leadWorker, liveWorkers } from "@/app/view/agents/runmodel";
import { cn } from "@/util/util";
import { atom, useAtomValue, type Atom } from "jotai";
import {
    Archive,
    ArchiveRestore,
    ArrowUpRight,
    ChevronDown,
    Copy,
    Pause,
    Pencil,
    Play,
    SlidersHorizontal,
    Trash2,
} from "lucide-react";
import { useRef, type ReactNode } from "react";
import { type QueueSummary } from "./briefingmodel";
import type { EffortOps } from "./briefmutations";
import {
    filterAsMenu,
    projectName,
    RUN_KIND_FILTERS,
    runRowFace,
    type BriefLine,
    type RunKindFilter,
} from "./briefrows";
import { RunRowView } from "./briefrowviews";
import { LINK_BTN, MONO_FAINT, REGION_LABEL } from "./briefstyle";
import { briefUndo } from "./briefundo";
import { briefEffortIndexAtom } from "./jarvisstore";

export const REGIONS = {
    waiting: {
        label: "Waiting on you",
        absent: "Nothing is waiting on you. The next gate or ask arrives here.",
        ok: true,
    },
    initiatives: { label: "Initiatives", absent: "No initiative is active.", ok: false },
    sessions: { label: "Runs", absent: "Nothing is running on its own.", ok: false },
    behind: { label: "Behind you", absent: "Nothing has landed since you last looked.", ok: false },
} as const;
export type RegionId = keyof typeof REGIONS;

// A heading is also how one region is read alone: pressing it hides the other regions, pressing it again
// brings them back. The count is a plain label inside it, because a bordered pill inside a button would
// read as a second control.
function RegionHead({
    id,
    label,
    meta,
    count,
    alert,
    only,
    onOnly,
}: {
    id: RegionId;
    label: string;
    meta: string;
    count?: number;
    alert?: boolean;
    only: boolean;
    onOnly: () => void;
}) {
    return (
        <button
            type="button"
            aria-pressed={only}
            title={only ? "Show every region" : "Show only this region"}
            onClick={onOnly}
            className="flex w-full cursor-pointer items-center gap-[9px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
            {alert ? <span className="h-1.5 w-1.5 flex-none pulse-soft rounded-full bg-asking" /> : null}
            <span
                className={cn(
                    REGION_LABEL,
                    alert ? "text-asking" : id === "waiting" ? "text-feed-label" : "text-ink-mid"
                )}
            >
                {label}
            </span>
            {count != null ? (
                <span className="flex-none font-mono text-[10.5px] font-medium tabular-nums text-ink-mid">{count}</span>
            ) : null}
            <span className="h-px min-w-3 flex-1 bg-edge-faint" />
            <span className={cn("flex-none", MONO_FAINT)}>{only ? "showing only this · press to show all" : meta}</span>
        </button>
    );
}

// A region's filter: which kind of run Runs or Shipped show, which project Initiatives does. The first
// option is always all.
type FilterSpec<T> = {
    label: string;
    // what the menu's face calls the choice: "project", "kind"
    noun: string;
    // the data attribute a CDP scenario finds the filter by
    tag: string;
    options: { value: T; label: string; count?: number }[];
    value: T;
    onChange: (v: T) => void;
};

// A few choices sit as a line of chips under the head, where they never squeeze it; past FILTER_LINE_MAX
// they become one menu in the head, which a long project list cannot wrap.
export type FilterSlot = { menu: boolean; node: ReactNode };

export function filterSlot<T>(spec: FilterSpec<T>): FilterSlot {
    const menu = filterAsMenu(spec.options.length);
    return { menu, node: menu ? <FilterMenu {...spec} /> : <FilterLine {...spec} /> };
}

function FilterLine<T>({ label, tag, options, value, onChange }: FilterSpec<T>) {
    return (
        <div role="group" aria-label={label} {...{ [tag]: "" }} className="flex flex-wrap items-center gap-1">
            {options.map((o) => (
                <button
                    key={o.label}
                    type="button"
                    aria-pressed={value === o.value}
                    data-filter-option={o.label}
                    onClick={() => onChange(o.value)}
                    className={cn(
                        "flex cursor-pointer items-baseline gap-1.5 rounded-[5px] border px-1.5 py-px font-mono text-[10.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                        value === o.value
                            ? "border-edge-strong text-ink-hi"
                            : "border-transparent text-muted hover:text-ink-hi"
                    )}
                >
                    {o.label}
                    {o.count != null ? (
                        <span className={cn("tabular-nums", value === o.value ? "text-ink-mid" : "text-muted")}>
                            {o.count}
                        </span>
                    ) : null}
                </button>
            ))}
        </div>
    );
}

function FilterMenu<T>({ label, noun, tag, options, value, onChange }: FilterSpec<T>) {
    // the one context menu may be a row's, so open means it holds this filter's items
    const shown = useRef<ContextMenuItem[] | null>(null);
    const open = useAtomValue(contextMenuAtom)?.items === shown.current && shown.current != null;
    const picked = options.find((o) => o.value === value) ?? options[0];
    // opened at the face rather than the pointer, so Enter on the face drops it in the same place
    const show = (e: React.MouseEvent<HTMLButtonElement>) => {
        const r = e.currentTarget.getBoundingClientRect();
        shown.current = [
            { type: "header", label },
            ...options.map(
                (o): ContextMenuItem => ({
                    type: "radio",
                    label: o.label,
                    checked: o.value === value,
                    sublabel: o.count != null ? String(o.count) : undefined,
                    click: () => onChange(o.value),
                })
            ),
        ];
        globalStore.set(contextMenuAtom, { x: r.left, y: r.bottom, items: shown.current });
    };
    return (
        <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={label}
            {...{ [tag]: "" }}
            onClick={show}
            className="flex flex-none cursor-pointer items-center gap-1.5 rounded-[5px] border border-edge-strong px-[7px] py-px font-mono text-[10.5px] text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
            <span className="text-muted">{noun}</span>
            {picked.label}
            <ChevronDown size={10} aria-hidden className="text-muted" />
        </button>
    );
}

export function runKindFilter(
    value: RunKindFilter,
    onChange: (v: RunKindFilter) => void,
    counts: Record<RunKindFilter, number>
): FilterSlot {
    return filterSlot({
        label: "Show runs of kind",
        noun: "kind",
        tag: "data-jarvis-run-kind",
        options: RUN_KIND_FILTERS.map((k) => ({ value: k, label: k, count: counts[k] })),
        value,
        onChange,
    });
}

export function Region({
    id,
    meta,
    count,
    alert,
    empty,
    absent,
    gap,
    only,
    onOnly,
    tools,
    filter,
    children,
}: {
    id: RegionId;
    meta: string;
    count?: number;
    alert?: boolean;
    empty: boolean;
    absent?: string;
    gap: string;
    only: boolean;
    onOnly: () => void;
    tools?: ReactNode;
    filter?: FilterSlot;
    children: ReactNode;
}) {
    const region = REGIONS[id];
    const head = (
        <RegionHead id={id} label={region.label} meta={meta} count={count} alert={alert} only={only} onOnly={onOnly} />
    );
    return (
        <section data-jarvis-brief-region={id} className={cn("flex flex-col", gap)}>
            {tools != null || filter?.menu ? (
                // a control cannot nest inside the head, which is itself a button
                <div className="flex items-center gap-2.5">
                    {head}
                    {tools}
                    {filter?.menu ? filter.node : null}
                </div>
            ) : (
                head
            )}
            {filter != null && !filter.menu ? filter.node : null}
            {empty ? (
                <div className="flex items-center gap-[11px] rounded-[10px] border border-dashed border-edge-strong bg-surface px-4 py-3">
                    {region.ok ? (
                        <span aria-hidden className="flex-none font-mono text-[12px] font-bold text-success">
                            ✓
                        </span>
                    ) : null}
                    <span className="text-[13px] text-secondary">{absent ?? region.absent}</span>
                </div>
            ) : (
                children
            )}
        </section>
    );
}

// What the region's window hid, and the way past it. There is no all-initiatives or all-events surface
// to send this anywhere — the three-pane composition's rail was the old destination and B5 deleted it —
// so the overflow opens in place. Bordered because it is a control: invariant 4 forbids the borderless
// link-coloured span this used to be, which named a number and did nothing.
export function MoreControl({ n, expanded, onToggle }: { n: number; expanded: boolean; onToggle: () => void }) {
    if (n <= 0 && !expanded) {
        return null;
    }
    return (
        <button
            type="button"
            data-jarvis-brief-more={expanded ? "less" : "more"}
            onClick={onToggle}
            className={cn(LINK_BTN, "mt-0.5")}
        >
            {expanded ? "Show less" : `+${n} more`}
        </button>
    );
}

export function QueueSummaryView({
    summary,
    count,
    expanded,
    error,
    onToggle,
}: {
    summary: QueueSummary;
    count: number;
    expanded: boolean;
    error: boolean;
    onToggle: () => void;
}) {
    return (
        <div className="grid w-full grid-cols-[3px_minmax(0,1fr)_auto] items-center gap-3 rounded-[10px] border border-border bg-surface py-[9px] pl-3 pr-[11px]">
            <span className={cn("self-stretch rounded-[2px]", error ? "bg-error" : "bg-asking")} />
            <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-ink-hi">{summary.title}</span>
                <span className="mt-0.5 block truncate font-mono text-[10.5px] text-ink-mid">{summary.detail}</span>
            </span>
            <button
                type="button"
                aria-expanded={expanded}
                aria-controls="jarvis-attention-details"
                onClick={onToggle}
                data-jarvis-brief-attention-summary
                className="flex-none cursor-pointer rounded-[7px] border border-edge-mid bg-surface-raised px-2.5 py-1 font-mono text-[10.5px] font-semibold text-ink-mid hover:border-edge-strong hover:bg-surface-hover hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
                {expanded ? "Hide" : `Review ${count}`}
            </button>
        </div>
    );
}

// the key the fresh and entrance sets are built with: a line's id minus its region prefix
export const keyOf = (line: BriefLine) => line.id.slice(line.id.indexOf(":") + 1);

// a filter that matched nothing in a region leaves a sentence, not a heading over an empty frame
export function NoMatch() {
    return (
        <span className="px-[11px] py-1 font-mono text-[10.5px] text-ink-faint">Nothing here matches the filter.</span>
    );
}

// An initiative's name and its id are the two things you carry out of the Brief — into a prompt, a
// `wsh effort` call, a message to someone. The row is a button, so neither could be dragged out of it:
// a mousedown inside a button starts a click, not a text selection. The expanded detail's id line
// (inlinetrackerview) copies the bare id for the same reason.
// A left click expands the row, so the activity sheet is opened from here instead. The rest are the
// plan footer's actions, reachable without expanding the row first.
export type InitiativeMenuActs = {
    openActivity: (oref: string) => void;
    work?: () => void;
    rename: () => void;
    details: () => void;
    // absent when the row's card is not in the snapshot, so its status is unknown
    status?: { value: string; ops: EffortOps };
};

export function showInitiativeMenu(line: BriefLine, ev: React.MouseEvent, acts: InitiativeMenuActs): void {
    const target = line.target;
    const oid = target != null && "oref" in target ? target.oref.replace(/^effort:/, "") : "";
    const items: ContextMenuItem[] = [];
    if (oid !== "") {
        if (acts.work != null) {
            items.push({ label: "Work on", icon: <Play size={15} />, click: acts.work });
        }
        items.push(
            {
                label: "Open activity",
                icon: <ArrowUpRight size={15} />,
                click: () => acts.openActivity("effort:" + oid),
            },
            { type: "separator" },
            { label: "Rename", icon: <Pencil size={15} />, click: acts.rename },
            { label: "Details", icon: <SlidersHorizontal size={15} />, click: acts.details }
        );
        const st = acts.status;
        if (st != null && st.value === "archived") {
            items.push({ label: "Unarchive", icon: <ArchiveRestore size={15} />, click: st.ops.unarchive });
        } else if (st != null) {
            items.push(
                st.value === "paused"
                    ? { label: "Resume", icon: <Play size={15} />, click: st.ops.togglePause }
                    : { label: "Pause", icon: <Pause size={15} />, click: st.ops.togglePause },
                { label: "Archive", icon: <Archive size={15} />, click: st.ops.archive }
            );
        }
        items.push({ type: "separator" });
    }
    items.push({
        label: "Copy name",
        icon: <Copy size={15} />,
        click: () => void navigator.clipboard.writeText(line.title),
    });
    if (oid !== "") {
        items.push({
            label: "Copy handle",
            icon: <Copy size={15} />,
            click: () => void navigator.clipboard.writeText("wsh effort show " + oid),
        });
        // no confirm here: the delete waits out the undo toast before it reaches the server
        if (acts.status != null) {
            items.push(
                { type: "separator" },
                { label: "Delete", icon: <Trash2 size={15} />, danger: true, click: acts.status.ops.remove }
            );
        }
    }
    ContextMenuModel.getInstance().showContextMenu(items, ev);
}

// A Runs row reads its live run and the roster, and hooks cannot run inside the region's map, so the row
// is its own component.
const NO_RUN = atom<Run | undefined>(undefined);
export function BriefRunRow({
    model,
    line,
    focused,
    selected,
    onOpenSheet,
    onOpenChunk,
}: {
    model: AgentsViewModel;
    line: BriefLine;
    focused: boolean;
    selected: boolean;
    onOpenSheet?: (e?: React.MouseEvent) => void; // the answer button opens the sheet with no gesture
    onOpenChunk: (effortOref: string, chunk: string) => void;
}) {
    const run = useAtomValue((line.runOid ? runAtom(line.runOid) : NO_RUN) as Atom<Run | undefined>);
    const agents = useAtomValue(model.agentsAtom);
    const projects = useAtomValue(projectsAtom);
    const index = useAtomValue(briefEffortIndexAtom);
    const asking = run != null ? leadAsker(run, agents) != null : line.state === "asking";
    const face = runRowFace({
        line,
        run,
        asking,
        project: projectName(run?.projectpath ?? "", projects),
        effort: run?.effortref != null ? index.get(run.effortref.effortoid) : undefined,
    });
    return (
        <RunRowView
            line={line}
            face={face}
            focused={focused}
            selected={selected}
            onOpenSheet={onOpenSheet}
            onOpenChunk={() => onOpenChunk(face.effortOref, face.chunk)}
            onAnswer={() => onOpenSheet?.()}
            onOpenAgent={() => {
                const worker = run != null ? leadWorker(run, agents) : undefined;
                const id = worker?.id ?? line.agentId;
                if (id == null) {
                    briefUndo.notify("No live session to open.");
                    return;
                }
                jumpToAgent(model, id);
            }}
            onStop={() =>
                run != null && confirmCancelRun(run.channeloid ?? "", run.id, liveWorkers(run, agents).length)
            }
        />
    );
}
