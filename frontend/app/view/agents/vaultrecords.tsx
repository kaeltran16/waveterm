// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Vault's records collection (docs/prototype/jarvis-vault-records.html): a status-grouped index of
// every dossier beside the selected record, so archived work stays browsable while a decision is written.
//
// Deliberately NOT a second record reader. It reuses the dossier list/detail reads and renders the same
// TaskDetail the Stage does, read-only: the Brief peek stays the only surface that writes a status, and a
// second writer here is how two views of one record start disagreeing. The projection, selection and
// timeline labels are pure and live in vaultrecordsmodel.ts with their tests.
//
// Wide windows render both panes. Narrow ones render one at a time (Back returns to the index) rather than
// compressing both below a readable measure; the threshold is the app's existing narrow-window width
// (navrailwidth.ts). Both panes stay mounted at every width — this is a CSS decision, not a JS one, so
// nothing here needs a resize listener.

import { SkeletonLine } from "@/app/element/skeleton";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo } from "react";
import {
    loadRecordDetail,
    recordDetailAtom,
    recordDetailErrorAtom,
    reloadRecordDetail,
} from "../jarvis/jarvissubjectstore";
import { TaskDetail } from "../jarvis/taskdetail";
import { loadTaskList, taskListAtom, tasksErrorAtom } from "../jarvis/tasksstore";
import { memSearchAtom } from "./memstore";
import { buildVaultRecordGroups, resolveVaultRecordId } from "./vaultrecordsmodel";
import { vaultRecordIdAtom, vaultRecordPaneAtom } from "./vaultstore";

// Same vocabulary and tones as the Stage's status chip (taskdetail.tsx STATUS_TONE), because these are the
// same four states of the same field. The dot only ever *accompanies* the group heading, never replaces it:
// a colour alone would leave archived and completed indistinguishable.
const STATUS_DOT: Record<string, string> = {
    active: "bg-success",
    paused: "bg-warning",
    completed: "bg-accent",
    archived: "bg-muted",
};

export function VaultRecords() {
    const records = useAtomValue(taskListAtom);
    const listError = useAtomValue(tasksErrorAtom);
    const search = useAtomValue(memSearchAtom);
    const [selectedId, setSelectedId] = useAtom(vaultRecordIdAtom);
    const [pane, setPane] = useAtom(vaultRecordPaneAtom);
    const details = useAtomValue(recordDetailAtom);
    const detailErrors = useAtomValue(recordDetailErrorAtom);

    const groups = useMemo(() => buildVaultRecordGroups(records ?? [], search), [records, search]);
    // the effective selection, not the stored one: filtering the selected row away must fall back to a row
    // that is actually on screen, and the detail pane follows what the index is showing
    const activeId = resolveVaultRecordId(groups, selectedId);
    const visibleIds = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.id)), [groups]);
    const detail = activeId != null ? details[activeId] : undefined;
    const detailError = activeId != null ? detailErrors[activeId] : undefined;

    // warm the cache on every selection change; loadRecordDetail is cache-guarded, so re-selecting a record
    // already read costs nothing
    useEffect(() => {
        if (activeId != null) {
            loadRecordDetail(activeId);
        }
    }, [activeId]);

    const listNav = useMemo<ListNavController>(
        () => ({
            surface: "vault",
            navigableIds: visibleIds,
            cursorId: activeId,
            setCursor: (id) => setSelectedId(id),
            // Enter is the list's primary action, and on a narrow window the detail is a separate view
            activate: () => setPane("detail"),
        }),
        [visibleIds, activeId, setSelectedId, setPane]
    );
    useSurfaceListNav(listNav);

    const openRecord = (id: string) => {
        setSelectedId(id);
        setPane("detail");
    };

    return (
        <div className="flex min-h-0 flex-1">
            <div
                data-vault-record-list
                className={cn(
                    "flex w-[38%] min-w-[240px] flex-none flex-col overflow-y-auto border-r border-edge-faint py-[10px]",
                    // on a narrow window the index gives way to the record the user opened
                    pane === "detail" && "max-[900px]:hidden"
                )}
            >
                {records === null ? (
                    <div className="space-y-[7px] px-[10px]">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <SkeletonLine key={i} className="h-[34px] w-full rounded-[8px]" />
                        ))}
                    </div>
                ) : (
                    <>
                        {listError ? (
                            <ErrorBanner
                                // tasksErrorAtom carries both a failed list read and a failed decision write (the
                                // Stage's failed append reports there too), so the frame names the outcome rather
                                // than a cause it cannot know, and the raw reason is shown verbatim
                                message="Records are not up to date."
                                detail={listError}
                                onRetry={() => loadTaskList()}
                                className="mx-[10px] mb-[8px]"
                            />
                        ) : null}
                        {groups.length === 0 ? (
                            <div className="px-[12px] py-[8px] text-[12px] text-ink-faint">
                                {(records?.length ?? 0) === 0
                                    ? "No records in the vault yet."
                                    : "No record matches this search."}
                            </div>
                        ) : (
                            groups.map((group) => (
                                <div key={group.status} className="mb-[8px]">
                                    <div
                                        data-vault-record-group={group.status}
                                        className="px-[12px] py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[0.12em] text-feed-label"
                                    >
                                        {group.label} · {group.rows.length}
                                    </div>
                                    {group.rows.map((row) => {
                                        const active = row.id === activeId;
                                        return (
                                            <button
                                                key={row.id}
                                                type="button"
                                                data-vault-record-row={row.id}
                                                aria-current={active}
                                                onClick={() => openRecord(row.id)}
                                                className={cn(
                                                    "mb-[2px] flex w-full flex-col gap-[2px] rounded-[7px] px-[10px] py-[7px] text-left",
                                                    active
                                                        ? "bg-surface-selected shadow-[inset_2px_0_var(--color-accent)]"
                                                        : "hover:bg-surface-hover"
                                                )}
                                            >
                                                <span className="flex min-w-0 items-center gap-[6px] text-[12.5px] font-semibold text-secondary">
                                                    <span
                                                        className={cn(
                                                            "h-[5px] w-[5px] flex-none rounded-full",
                                                            STATUS_DOT[row.status] ?? "bg-ink-faint"
                                                        )}
                                                    />
                                                    <span className="truncate">{row.objective}</span>
                                                </span>
                                                <span className="flex gap-[7px] pl-[11px] font-mono text-[10px] text-ink-faint">
                                                    <span data-vault-record-status={row.status}>{row.status}</span>
                                                    {row.ticket ? <span>{row.ticket}</span> : null}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            ))
                        )}
                    </>
                )}
            </div>
            <div
                data-vault-record-pane={pane}
                className={cn(
                    "relative min-w-0 flex-1 overflow-y-auto",
                    // the mirror of the index: narrow + index means the record is not the active view
                    pane === "list" && "max-[900px]:hidden"
                )}
            >
                {pane === "detail" ? (
                    <button
                        type="button"
                        data-vault-record-back
                        onClick={() => setPane("list")}
                        className="ml-[14px] mt-[12px] hidden items-center gap-[5px] rounded-[7px] border border-border px-[10px] py-[4px] text-[11.5px] font-semibold text-ink-mid hover:border-edge-strong hover:text-primary max-[900px]:flex"
                    >
                        <ArrowLeft size={12} strokeWidth={2} />
                        Records
                    </button>
                ) : null}
                {detailError ? (
                    <ErrorBanner
                        message="Couldn’t read this record."
                        detail={detailError}
                        onRetry={() => {
                            if (activeId != null) fireAndForget(() => reloadRecordDetail(activeId));
                        }}
                        className="mx-6 mt-4"
                    />
                ) : null}
                {records === null || (activeId != null && detail == null) ? (
                    <div className="space-y-[9px] px-6 py-6">
                        <SkeletonLine className="h-[22px] w-[300px]" />
                        <SkeletonLine className="h-[13px] w-[180px]" />
                        <SkeletonLine className="h-[90px] w-full rounded-[12px]" />
                    </div>
                ) : activeId == null ? (
                    // "nothing to select" is a claim about the vault, so it waits for the list rather than
                    // standing in for a load in progress
                    <div className="px-6 py-6 text-[12.5px] text-ink-faint">Select a record to read it.</div>
                ) : (
                    <TaskDetail detail={detail} statusWritable={false} showTimeline />
                )}
            </div>
        </div>
    );
}

// Retry keeps whatever the pane is already showing — a stale record with its error beside it beats an empty
// pane that hides the record the user was reading.
function ErrorBanner({
    message,
    detail,
    onRetry,
    className,
}: {
    message: string;
    detail?: string;
    onRetry: () => void;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "flex flex-none items-center gap-[10px] rounded-[8px] border border-error/30 bg-error/10 px-[11px] py-[7px] text-[12px] text-error",
                className
            )}
        >
            <span className="min-w-0 truncate">
                {message}
                {detail ? <span className="ml-[7px] font-mono text-[11px] opacity-80">{detail}</span> : null}
            </span>
            <div className="flex-1" />
            <button
                type="button"
                onClick={onRetry}
                className="flex-none rounded-[6px] border border-error/40 px-[9px] py-[2px] font-mono text-[11px] font-semibold hover:bg-error/10"
            >
                Retry
            </button>
        </div>
    );
}
