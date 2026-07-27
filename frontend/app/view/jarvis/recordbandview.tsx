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

function EdgeChip({ tag }: { tag: AmbientTag }) {
    const line = edgeLineStyle(tag);
    return (
        <span className="flex flex-none items-center gap-[7px] rounded-[6px] border border-border px-2 py-[3px]">
            <span
                className="w-4 flex-none"
                style={{ borderTopStyle: line.style, borderTopWidth: line.weightPx, borderTopColor: "currentColor" }}
            />
            <span className="text-[11.5px] font-semibold text-secondary">{tag.label}</span>
            <span className="font-mono text-[9.5px] text-muted">{edgeLabel(tag)}</span>
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

    return (
        <div className="flex-none border-b border-border bg-surface">
            <div
                className={cn("flex items-center gap-2.5 px-4 py-2.5", expandable && "cursor-pointer")}
                onClick={expandable ? onToggle : undefined}
            >
                {band.case === "none" ? (
                    <>
                        <span className="font-mono text-[11px] text-muted">No record attributed to this run</span>
                        <div className="flex-1" />
                        <span className="text-[11px] font-semibold text-accent-soft">Attach a record</span>
                        <span className="text-[11px] font-semibold text-muted">Create one from this run</span>
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
                        <EdgeChip tag={band.primary} />
                        {band.others.map((o) => (
                            <EdgeChip key={o.taskId} tag={o} />
                        ))}
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
            </div>
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
