// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pick a record to attribute a run to. Mirrors the composer's channel picker: a filtered list rendered in
// place rather than a modal, because the choice only means anything beside the row that raised it.

import { SkeletonLine } from "@/app/element/skeleton";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { recordPickerMatches } from "./recordband";
import { loadTaskList, taskListAtom } from "./tasksstore";

const MAX_ROWS = 8;

// one ticket look for every place a record is named: the picker, the band's chips and its detached rows
export function TicketChip({ ticket }: { ticket?: string }) {
    if (!ticket) {
        return null;
    }
    return (
        <span
            data-jarvis-ticket-chip
            className="flex-none rounded bg-surface-hover px-1.5 py-px font-mono text-[10.5px] text-ink-mid"
        >
            {ticket}
        </span>
    );
}

export function RecordPicker({ onPick, onCancel }: { onPick: (dossierId: string) => void; onCancel: () => void }) {
    const records = useAtomValue(taskListAtom);
    const [q, setQ] = useState("");
    useEffect(() => {
        loadTaskList();
    }, []);
    const matches = useMemo(() => recordPickerMatches(records ?? [], q, MAX_ROWS), [records, q]);
    // stopped here because ModalShell listens on window: the run sheet around the picker would otherwise
    // close with its Escape
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
        } else if (e.key === "Enter" && matches.length > 0) {
            e.preventDefault();
            onPick(matches[0].id);
        }
    };
    return (
        <div data-jarvis-record-picker className="flex min-w-0 flex-1 flex-col gap-1.5">
            <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Attach to which record?"
                aria-label="Attach to which record"
                className="rounded-[7px] border border-edge-mid bg-background px-2.5 py-1 text-[12px] text-primary placeholder:text-muted focus:border-accent focus:outline-none"
            />
            {records == null ? (
                <div aria-hidden="true" className="flex flex-col gap-1.5">
                    {["w-[70%]", "w-[55%]", "w-[65%]"].map((w, i) => (
                        <SkeletonLine key={i} className={cn("h-[20px] rounded-[6px]", w)} />
                    ))}
                </div>
            ) : matches.length === 0 ? (
                <span className="font-mono text-[11px] text-muted">No record matches</span>
            ) : (
                matches.map((r) => (
                    <button
                        key={r.id}
                        type="button"
                        data-jarvis-record-picker-row
                        title={r.id}
                        onClick={() => onPick(r.id)}
                        className="flex cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1 text-left transition-colors duration-[140ms] hover:bg-surface-hover"
                    >
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-secondary">{r.objective}</span>
                        <TicketChip ticket={r.ticket} />
                    </button>
                ))
            )}
        </div>
    );
}
