// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The record band: docked above the thread, never a destination. Its whole job is to make attribution
// legible at a glance — a weak inferred link must not read like a confirmed one — so the collapsed line
// carries each edge's state, confidence and line style.

import type { AmbientTag } from "@/app/view/agents/ambient";
import { cn } from "@/util/util";
import { Lock } from "lucide-react";
import { selectSubject } from "./jarvissubjectstore";
import { edgeLabel, edgeLineStyle, recordBandCase } from "./recordband";
import type { SubjectKind } from "./subjects";
import { TaskDetail } from "./taskdetail";

function MachineGlyph() {
    return (
        <span className="flex-none text-muted" title="machine-maintained">
            <Lock size={10} strokeWidth={2} />
        </span>
    );
}

// shrinkable, not flex-none: a record label is arbitrary length, and an unshrinkable chip is what pushed
// the band's trailing label past the Stage's right edge and over the rail. The line style and the edge
// state stay fixed-width — those are the signal; the label is what can give.
function EdgeChip({ tag }: { tag: AmbientTag }) {
    const line = edgeLineStyle(tag);
    return (
        <span className="flex min-w-0 items-center gap-[7px] rounded-[6px] border border-border px-2 py-[3px]">
            <span
                className="w-4 flex-none"
                style={{ borderTopStyle: line.style, borderTopWidth: line.weightPx, borderTopColor: "currentColor" }}
            />
            <span className="truncate text-[11.5px] font-semibold text-secondary">{tag.label}</span>
            <span className="flex-none font-mono text-[9.5px] text-muted">{edgeLabel(tag)}</span>
        </span>
    );
}

export function RecordBand({
    kind,
    tags,
    mentionedIds,
    detail,
    open,
    onToggle,
}: {
    kind: SubjectKind;
    tags: AmbientTag[];
    mentionedIds: string[];
    detail: DossierDetail | null;
    open: boolean;
    onToggle: () => void;
}) {
    const band = recordBandCase({ kind, tags, mentionedIds });
    // a dossier subject IS the record, so its panel is always open and has no collapse affordance.
    const expandable = band.case === "one" || band.case === "several";
    const showPanel = band.case === "subject" || (expandable && open);

    const rowClass = cn("flex items-center gap-2.5 px-4 py-2.5", expandable && "w-full cursor-pointer text-left");
    // the collapsed row carries no nested interactive element, so the whole row can be the control — the
    // expanded per-record rows below are siblings and stay individually reachable. As a div + onClick it was
    // mouse-only, on a surface whose thesis is keyboard operability.
    const row = (
        <>
            {band.case === "none" ? (
                <>
                    <span className="font-mono text-[11px] text-muted">No record attributed to this run</span>
                    <div className="flex-1" />
                    {/* the attach/create lifecycle (pkg/jarvisattrib) is not exposed over wshrpc, so
                            this states who maintains attribution rather than offering buttons that do
                            nothing. Real controls belong to the cycle that ships the commands. */}
                    <MachineGlyph />
                    <span className="flex-none font-mono text-[11px] text-muted">
                        attribution is machine-maintained
                    </span>
                </>
            ) : band.case === "one" ? (
                <>
                    <MachineGlyph />
                    <span className="flex-none font-mono text-[11px] font-semibold text-accent-soft">
                        {band.edge.taskId}
                    </span>
                    <EdgeChip tag={band.edge} />
                    <div className="flex-1" />
                    <span className="flex-none text-[11px] font-semibold text-muted">
                        {open ? "Collapse" : "Expand the record"}
                    </span>
                </>
            ) : band.case === "several" ? (
                <>
                    <MachineGlyph />
                    {/* only the primary edge plus a count: a chip per attributed record put 826px of
                            content in a 790px box at 1440 and drew the trailing label over the rail. The
                            expanded panel below already lists the others as clickable rows. Deliberately
                            not flex-wrap — a band that changes height on selection pushes the thread. */}
                    <EdgeChip tag={band.primary} />
                    <span className="flex-none font-mono text-[10.5px] text-muted">+{band.others.length} more</span>
                    <div className="flex-1" />
                    <span className="flex-none text-[11px] font-semibold text-muted">
                        {open ? "Collapse" : "Expand"}
                    </span>
                </>
            ) : band.case === "mentions" ? (
                <>
                    <span className="flex-none font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                        Mentioned here
                    </span>
                    {band.ids.map((id) => (
                        <span
                            key={id}
                            className="flex-none rounded-[5px] border border-dashed border-accent/40 px-1.5 py-px font-mono text-[11px] text-accent-soft"
                        >
                            {id}
                        </span>
                    ))}
                    <span className="min-w-0 truncate font-mono text-[11px] text-muted">
                        {band.ids.length === 0
                            ? "this thread has cited no record"
                            : "derived from this thread's citations — a conversation carries no attribution of its own"}
                    </span>
                </>
            ) : (
                <>
                    <MachineGlyph />
                    <span className="flex-none font-mono text-[11px] font-semibold text-accent-soft">
                        {detail?.id ?? ""}
                    </span>
                    <span className="min-w-0 truncate text-[12.5px] font-semibold text-secondary">
                        Selected directly from Records — no run beneath it
                    </span>
                    <div className="flex-1" />
                    <span className="flex-none font-mono text-[11px] text-muted">the subject itself</span>
                </>
            )}
        </>
    );

    return (
        <div className="flex-none border-b border-border bg-surface">
            {expandable ? (
                <button type="button" onClick={onToggle} aria-expanded={open} className={rowClass}>
                    {row}
                </button>
            ) : (
                <div className={rowClass}>{row}</div>
            )}
            {showPanel && detail != null ? (
                <div className="max-h-[420px] overflow-y-auto border-t border-border bg-background">
                    <TaskDetail detail={detail} showDecisions={band.case !== "subject"} />
                </div>
            ) : null}
            {/* the others are one-line rows under the primary — expanding must never produce a tab strip */}
            {expandable && open && band.case === "several" ? (
                <div className="flex flex-col gap-px border-t border-border px-4 py-2">
                    {band.others.map((o) => (
                        <button
                            key={o.taskId}
                            type="button"
                            onClick={() => selectSubject({ kind: "dossier", id: o.taskId })}
                            className="flex cursor-pointer items-center gap-2 rounded-[7px] px-1 py-1 text-left hover:bg-surface-hover"
                        >
                            <EdgeChip tag={o} />
                            <span className="font-mono text-[10.5px] text-muted">open this record</span>
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
