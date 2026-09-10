// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's record peek. In the three-pane composition a record is a subject on the Stage; the Brief has
// no Stage, so this is where a record oref lands (see openref.ts's task arm).
//
// It is deliberately the smaller half of the meta spec's §2 line: what is running against the record and
// what you set it to, and nothing else. Its full history, decision log and past corrections are Vault's,
// and the footer says so rather than leaving the reader to wonder what is missing.
//
// Everything shown is derived in briefpeek.ts. This file mounts it, loads the two caches it reads, and
// owns the one write on it.

import { ConfirmDialog } from "@/app/modals/confirmdialog";
import { ModalShell } from "@/app/modals/modalshell";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { channelsAtom } from "@/app/view/agents/channelsstore";
import { harnessesAtom } from "@/app/view/agents/harnessstore";
import { fleetCounts } from "@/app/view/agents/jarviscards";
import type { RunStatusTone } from "@/app/view/agents/runmodel";
import { cn } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { buildRecordPeek, type PeekRunRow, type PeekStatusRow } from "./briefpeek";
import { fleetForRecord } from "./fleetscope";
import { briefGraphRecordAtom, briefPeekRecordAtom, graphPeekOpenAtom } from "./jarvisstore";
import {
    loadRecordDetail,
    loadRecordScope,
    recordDetailAtom,
    recordRunsAtom,
    recordScopeAtom,
} from "./jarvissubjectstore";
import { openORef, openRecordInVault } from "./openref";
import { setDossierStatus } from "./recordactions";

// Same vocabulary and same tones as taskdetail.tsx's chip, on purpose: the status is the one field scanned
// before anything else is read, and a record that reads "paused" in one place and grey in another is the
// kind of drift that makes a colour meaningless.
const STATUS_FG: Record<string, string> = {
    active: "text-success",
    paused: "text-warning",
    completed: "text-accent-soft",
    archived: "text-muted",
};

// The run's outcome column is scanned as colour rather than read as more grey text. Mirrors recordthread's
// mapping — the same runs, described the same way.
const RUN_TONE: Record<RunStatusTone, string> = {
    planning: "text-accent-soft",
    review: "text-warning",
    running: "text-success",
    done: "text-success/70",
    blocked: "text-warning",
    failed: "text-error",
    cancelled: "text-muted",
};

const MONO_LABEL = "flex-none font-mono text-[9px] font-bold uppercase tracking-[.12em] text-ink-faint";

function StatusRow({ row, onPick }: { row: PeekStatusRow; onPick: (status: string) => void }) {
    const fg = STATUS_FG[row.status] ?? "text-muted";
    const body = (
        <>
            <span className={cn("w-2 flex-none font-mono text-[9px] font-bold", fg)}>{row.current ? "•" : ""}</span>
            <span className={cn("w-[58px] flex-none font-mono text-[11px] font-semibold", fg)}>{row.label}</span>
            <span className="min-w-0 flex-1 text-[11.5px] leading-[1.45] text-muted">{row.note}</span>
        </>
    );
    // the row naming the status the record is already in is a label, not a control: there is nothing for it
    // to do, and dressing it as a button would be the same lie as camouflaging a real one.
    if (row.current) {
        return (
            <div
                data-jarvis-peek-status={row.status}
                className="flex items-baseline gap-2.5 rounded-[6px] px-2.5 py-1.5"
            >
                {body}
            </div>
        );
    }
    return (
        <button
            type="button"
            data-jarvis-peek-status={row.status}
            onClick={() => onPick(row.status)}
            className="flex cursor-pointer items-baseline gap-2.5 rounded-[6px] px-2.5 py-1.5 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
            {body}
        </button>
    );
}

function RunRowView({ row, model }: { row: PeekRunRow; model: AgentsViewModel }) {
    return (
        <button
            type="button"
            data-jarvis-peek-row="run"
            onClick={() => void openORef(model, "run:" + row.runId)}
            className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 px-3 py-[7px] text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
            <span className="flex-none font-mono text-[10px] font-semibold text-accent-soft">{row.shortId}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-mid">{row.headline}</span>
            <span className="flex-none whitespace-nowrap font-mono text-[9.5px] text-ink-faint">{row.meta}</span>
            <span
                className={cn("flex-none whitespace-nowrap font-mono text-[9.5px] font-semibold", RUN_TONE[row.tone])}
            >
                {row.state}
            </span>
        </button>
    );
}

export function BriefPeek({ model }: { model: AgentsViewModel }) {
    const recordId = useAtomValue(briefPeekRecordAtom);
    const setRecordId = useSetAtom(briefPeekRecordAtom);
    const details = useAtomValue(recordDetailAtom);
    const runsByRecord = useAtomValue(recordRunsAtom);
    const scopes = useAtomValue(recordScopeAtom);
    const channels = useAtomValue(channelsAtom);
    const agents = useAtomValue(model.agentsAtom);
    const harnesses = useAtomValue(harnessesAtom);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [pendingStatus, setPendingStatus] = useState<string | null>(null);

    // both caches, because the peek's two halves come from different reads: the record's own fields, and the
    // runs attributed to it (a dossier has no run list of its own — ResolveSpaceScope answers that).
    useEffect(() => {
        if (recordId == null) {
            return;
        }
        loadRecordDetail(recordId);
        loadRecordScope(recordId);
    }, [recordId]);

    // the picker is per-opening, not per-record: leaving it open across a close would reopen the peek mid-write
    useEffect(() => {
        setPickerOpen(false);
        setPendingStatus(null);
    }, [recordId]);

    const close = () => setRecordId(null);
    const detail = recordId != null ? details[recordId] : undefined;
    const runs = recordId != null ? (runsByRecord[recordId] ?? []) : [];
    const fleet = fleetForRecord({
        channels: channels ?? [],
        agents,
        attributedRunORefs: recordId != null ? (scopes[recordId]?.runorefs ?? []) : [],
    });
    const peek =
        detail != null
            ? buildRecordPeek({
                  detail,
                  runs,
                  fleet,
                  counts: fleetCounts(fleet.workers),
                  harnesses,
                  now: Date.now(),
              })
            : null;

    const applyStatus = (next: string) => {
        const row = peek?.statusRows.find((r) => r.status === next);
        setPickerOpen(false);
        // completed and archived are terminal enough to confirm — the same guard taskdetail applies, kept
        // here rather than re-decided, so the two entry points cannot disagree about what needs a prompt.
        if (row?.terminal) {
            setPendingStatus(next);
            return;
        }
        if (recordId != null) {
            setDossierStatus(recordId, next);
        }
    };

    return (
        <>
            {/* the peek yields while a confirm is up rather than stacking under it: ConfirmDialog is itself a
                ModalShell, and two of them mounted together both claim Escape and both call takeModalFocus,
                so Escape would dismiss the confirm and the peek behind it in one press. Cancel brings it
                back, and the confirm's own scrim covers the same area either way. */}
            <ModalShell
                open={recordId != null && pendingStatus == null}
                onClose={close}
                align="center"
                className="w-[640px] max-w-full"
            >
                <div data-jarvis-brief-band="peek" className="flex min-h-0 flex-col">
                    <div className="flex min-w-0 flex-none items-center gap-2.5 border-b border-border px-[17px] py-3">
                        <span className={MONO_LABEL}>record</span>
                        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink-hi">
                            {peek?.title ?? "Loading…"}
                        </span>
                        {peek != null ? (
                            <>
                                <span className="flex-none font-mono text-[9.5px] text-ink-faint">
                                    {peek.updatedLabel}
                                </span>
                                <button
                                    type="button"
                                    data-jarvis-peek-status-toggle
                                    aria-label="Change what this record does"
                                    onClick={() => setPickerOpen((v) => !v)}
                                    className={cn(
                                        "flex-none cursor-pointer rounded-[6px] border border-border bg-surface-raised px-2 py-0.5 font-mono text-[10px] font-semibold hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                        STATUS_FG[peek.statusLabel] ?? "text-muted"
                                    )}
                                >
                                    {peek.statusLabel}
                                </button>
                            </>
                        ) : null}
                    </div>
                    {pickerOpen && peek != null ? (
                        <div className="flex flex-none flex-col gap-px border-b border-border bg-surface-raised px-2 py-1.5">
                            {peek.statusRows.map((row) => (
                                <StatusRow key={row.status} row={row} onPick={applyStatus} />
                            ))}
                        </div>
                    ) : null}
                    {peek != null ? (
                        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-[17px] py-4">
                            <p className="text-[13px] leading-[1.6] text-ink-mid">{peek.body}</p>
                            <div className="flex flex-col overflow-hidden rounded-[9px] border border-border bg-background">
                                <div className="flex items-center gap-2.5 border-b border-edge-faint px-3 py-2">
                                    <span className={MONO_LABEL}>Fleet · on this record</span>
                                    <span className="h-px flex-1 bg-edge-faint" />
                                    <span className="flex-none font-mono text-[9.5px] text-muted">
                                        {peek.fleetMeta}
                                    </span>
                                </div>
                                {peek.runs.length === 0 ? (
                                    <div className="px-3 py-2.5 font-mono text-[11px] text-ink-faint">
                                        {peek.runsAbsent}
                                    </div>
                                ) : (
                                    peek.runs.map((row) => <RunRowView key={row.runId} row={row} model={model} />)
                                )}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                {/* a label, not a button: appending a decision is Vault's half of the line, so
                                    this states the count and stops there. */}
                                <span className="rounded-[6px] border border-edge-faint px-2.5 py-1 font-mono text-[11px] text-ink-mid">
                                    {peek.logLine}
                                </span>
                                <span className="self-start rounded-[6px] border border-dashed border-edge-strong px-2.5 py-1 font-mono text-[9.5px] text-ink-faint">
                                    {peek.absenceChip}
                                </span>
                            </div>
                            {/* The peek's two exits. The map button closes the peek first: the graph peek is an
                                overlay on the surface, and leaving the record modal up over it would stack two
                                modals, both claiming Escape. */}
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    data-jarvis-peek-open-vault
                                    onClick={() => recordId != null && openRecordInVault(model, recordId)}
                                    className="cursor-pointer rounded-[6px] border border-border bg-surface-raised px-2.5 py-1 font-mono text-[10.5px] font-semibold text-ink-mid hover:border-accent/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                >
                                    Open in Vault
                                </button>
                                <button
                                    type="button"
                                    data-jarvis-peek-open-graph
                                    onClick={() => {
                                        if (recordId == null) return;
                                        globalStore.set(briefGraphRecordAtom, recordId);
                                        setRecordId(null);
                                        globalStore.set(graphPeekOpenAtom, true);
                                    }}
                                    className="cursor-pointer rounded-[6px] border border-border bg-surface-raised px-2.5 py-1 font-mono text-[10.5px] font-semibold text-ink-mid hover:border-accent/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                >
                                    Where it sits on the map
                                </button>
                            </div>
                            <span className="font-mono text-[11px] leading-[1.5] text-ink-faint">{peek.footer}</span>
                        </div>
                    ) : null}
                </div>
            </ModalShell>
            {pendingStatus != null && recordId != null ? (
                <ConfirmDialog
                    tone={pendingStatus === "archived" ? "danger" : "warning"}
                    title={`Mark this record ${pendingStatus}?`}
                    body={`This sets the record's status to "${pendingStatus}". You can reactivate it later.`}
                    confirmLabel={`Yes, ${pendingStatus}`}
                    cancelLabel="Cancel"
                    onConfirm={() => {
                        setDossierStatus(recordId, pendingStatus);
                        setPendingStatus(null);
                    }}
                    onClose={() => setPendingStatus(null)}
                />
            ) : null}
        </>
    );
}
