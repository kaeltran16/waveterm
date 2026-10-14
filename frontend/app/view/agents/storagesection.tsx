// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Settings > Storage: a thin render of storagemodel.ts over the report in storagestore.ts. Layout and copy
// follow the storage-report canvas (Page.dc.html). The header's actions (Rescan, Clear and Clear's confirm) are
// their own component because the Settings surface draws the section header.

import { ConfirmDialog } from "@/app/modals/confirmdialog";
import { openTarget } from "@/app/view/jarvis/openref";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Trash } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import {
    clearButton,
    clearPlan,
    deletePlan,
    EMPTY_LEFT_TEXT,
    NOT_COUNTED_TEXT,
    rescanEnabled,
    resultNotice,
    scanErrorText,
    scannedLabel,
    shouldAutoScan,
    storageSections,
    storageStats,
    type StorageRowVM,
    type StorageSectionVM,
} from "./storagemodel";
import {
    isStorageFixture,
    recordStorageAction,
    startClear,
    startDelete,
    startScan,
    storageReportAtom,
} from "./storagestore";

// what the header and stats read before the first report lands
const NO_REPORT: StorageReportData = { scants: 0, items: [] };

const GRID = "grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_130px_44px_minmax(0,1.2fr)] gap-x-4";
const MONO_META = "font-mono text-[10.5px] text-muted";
const HEADER_BUTTON = "flex-none rounded border px-[13px] py-[7px] text-[12px] font-semibold transition-colors";

const GROUP_DOT: Record<string, string> = { left: "bg-warning", inuse: "bg-success", kept: "bg-ink-faint" };
const GROUP_BAR: Record<string, string> = { left: "bg-warning", inuse: "bg-success", kept: "bg-edge-strong" };
const TAG_TONE: Record<string, string> = {
    muted: "bg-white/5 text-ink-mid",
    success: "bg-success/12 text-success",
    accent: "bg-accent/12 text-accent",
    error: "bg-error/12 text-error",
};
const SKELETON = [
    { a: "70%", b: "85%", c: "40%" },
    { a: "60%", b: "70%", c: "30%" },
    { a: "75%", b: "60%", c: "50%" },
    { a: "55%", b: "80%", c: "35%" },
];

function useReport(): StorageReportData {
    return useAtomValue(storageReportAtom) ?? NO_REPORT;
}

export function StorageHeaderActions() {
    const report = useReport();
    const [confirming, setConfirming] = useState(false);
    const clear = clearButton(report);
    const rescan = rescanEnabled(report);
    const plan = confirming ? clearPlan(report) : null;
    return (
        <div className="flex flex-none items-center gap-3">
            <span className="font-mono text-[11px] text-muted">{scannedLabel(report, Date.now())}</span>
            <button
                type="button"
                data-storage-rescan
                disabled={!rescan}
                onClick={() => fireAndForget(startScan)}
                className={cn(
                    HEADER_BUTTON,
                    rescan
                        ? "cursor-pointer border-edge-mid text-secondary hover:border-edge-strong hover:text-primary"
                        : "cursor-not-allowed border-edge-faint text-ink-faint"
                )}
            >
                Rescan
            </button>
            {clear.show ? (
                <button
                    type="button"
                    data-storage-clear
                    disabled={!clear.enabled}
                    onClick={() => setConfirming(true)}
                    className={cn(
                        HEADER_BUTTON,
                        "border-accent bg-accent font-bold text-background",
                        clear.enabled ? "cursor-pointer hover:border-accent-300 hover:bg-accent-300" : "opacity-60"
                    )}
                >
                    {clear.label}
                </button>
            ) : null}
            {plan != null ? (
                <ConfirmDialog
                    testId="storage-confirm"
                    tone="warning"
                    icon={<Trash size={15} aria-hidden />}
                    title={plan.title}
                    body={
                        <>
                            <p>{plan.lead}</p>
                            <ul className="mt-2 flex list-disc flex-col gap-[3px] pl-[18px]">
                                {plan.lines.map((line) => (
                                    <li key={line}>{line}</li>
                                ))}
                            </ul>
                            <p className="mt-2.5">
                                {plan.skipped.map((s) => (
                                    <span key={s.path}>
                                        Skips <span className="text-secondary">{s.path}</span>: {s.reason}{" "}
                                    </span>
                                ))}
                                {plan.tail}
                            </p>
                        </>
                    }
                    confirmLabel="Clear left over"
                    cancelLabel="Cancel"
                    onConfirm={() => {
                        setConfirming(false);
                        fireAndForget(() => startClear(plan.ids));
                    }}
                    onClose={() => setConfirming(false)}
                />
            ) : null}
        </div>
    );
}

export function StorageSection({ model }: { model: AgentsViewModel }) {
    const report = useAtomValue(storageReportAtom);
    const r = report ?? NO_REPORT;
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const autoScanned = useRef(false);

    // opening the section scans only when there is no result yet; once per opening
    useEffect(() => {
        if (!autoScanned.current && shouldAutoScan(report)) {
            autoScanned.current = true;
            fireAndForget(startScan);
        }
    }, [report]);

    const now = Date.now();
    const sections = storageSections(r, now);
    const notice = resultNotice(r);
    const loading = !r.scants && (report == null || !!r.scanning);
    const deleting = deletingId == null ? null : (r.items ?? []).find((it) => it.id === deletingId);

    const openRun = (runId: string) => {
        if (isStorageFixture()) {
            recordStorageAction({ kind: "open", runId });
        }
        fireAndForget(() => openTarget(model, { kind: "run", runId }));
    };

    return (
        <div className="flex min-w-0 flex-col gap-[22px] pt-2.5">
            {(r.errors ?? []).map((e) => (
                <div
                    key={e.projectpath || e.projectname}
                    data-storage-error
                    role="alert"
                    className="flex items-center gap-3 rounded-[10px] border border-error/40 bg-error/10 px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-error"
                >
                    <span className="flex-1">{scanErrorText(e)}</span>
                </div>
            ))}
            {notice != null ? (
                <div
                    data-storage-result
                    role="status"
                    className="flex items-center gap-2.5 rounded-[10px] border border-border bg-surface-raised px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-secondary"
                >
                    <span className="h-[7px] w-[7px] flex-none rounded-full bg-success" />
                    <span className="flex-1">
                        {notice.text}
                        {notice.failure != null ? (
                            <>
                                {" "}
                                <span className="text-error">{notice.failure}</span>: {notice.failureWhy}
                            </>
                        ) : null}
                    </span>
                </div>
            ) : null}
            <div className="grid grid-cols-3 gap-3">
                {storageStats(r).map((t) => (
                    <div
                        key={t.group}
                        data-storage-stat={t.group}
                        className="flex flex-col gap-1.5 rounded-[11px] border border-border bg-surface-raised px-[15px] py-[13px] font-mono"
                    >
                        <span className="flex items-center gap-[7px] text-[10.5px] text-ink-mid">
                            <span className={cn("h-[7px] w-[7px] rounded-full", GROUP_DOT[t.group])} />
                            {t.label}
                        </span>
                        <span className="text-[21px] font-bold text-primary">{t.value}</span>
                        <span className="text-[10.5px] text-muted">{t.sub}</span>
                    </div>
                ))}
            </div>
            {loading ? <Skeleton /> : null}
            {sections.map((s) => (
                <Section key={s.group} section={s} onOpenRun={openRun} onDelete={setDeletingId} />
            ))}
            {r.scants ? <p className={MONO_META}>{NOT_COUNTED_TEXT}</p> : null}
            {deleting != null ? (
                <DeleteDialog
                    item={deleting}
                    onConfirm={() => {
                        setDeletingId(null);
                        fireAndForget(() => startDelete(deleting.id, deleting.branchtip ?? ""));
                    }}
                    onClose={() => setDeletingId(null)}
                />
            ) : null}
        </div>
    );
}

function SectionHead({ dot, title, meta }: { dot?: string; title: string; meta: string }) {
    return (
        <div className="mb-2 flex items-center gap-2.5">
            {dot ? <span className={cn("h-[7px] w-[7px] rounded-full", dot)} /> : null}
            <h3
                className={cn(
                    "m-0 font-mono text-[10.5px] font-bold uppercase tracking-[0.1em]",
                    dot ? "text-ink-mid" : "text-muted"
                )}
            >
                {title}
            </h3>
            <span className="h-px flex-1 bg-edge-faint" />
            <span className={MONO_META}>{meta}</span>
        </div>
    );
}

function Skeleton() {
    const bar = "h-2.5 rounded-[4px] bg-surface-raised";
    return (
        <section data-storage-skeleton className="flex flex-col">
            <SectionHead title="Left over" meta="reading folders and their runs" />
            {SKELETON.map((k, i) => (
                <div key={i} className={cn(GRID, "items-center border-t border-edge-faint py-3")}>
                    <span className={bar} style={{ width: k.a }} />
                    <span className={bar} style={{ width: k.b }} />
                    <span className="h-1.5 rounded-[3px] bg-surface-raised" />
                    <span className={bar} />
                    <span className={bar} style={{ width: k.c }} />
                </div>
            ))}
        </section>
    );
}

function Section({
    section,
    onOpenRun,
    onDelete,
}: {
    section: StorageSectionVM;
    onOpenRun: (runId: string) => void;
    onDelete: (id: string) => void;
}) {
    const empty = section.rows.length === 0;
    return (
        <section data-storage-group={section.group} className="flex flex-col">
            <SectionHead dot={GROUP_DOT[section.group]} title={section.title} meta={section.meta} />
            {empty && section.group === "left" ? (
                <p
                    data-storage-empty
                    className="m-0 rounded-[11px] border border-border bg-surface px-4 py-3 text-[12.5px] leading-[1.55] text-ink-mid"
                >
                    {EMPTY_LEFT_TEXT}
                </p>
            ) : null}
            {!empty ? (
                <>
                    <div className={cn(GRID, "pb-1.5", MONO_META)}>
                        <span>folder</span>
                        <span>left by</span>
                        <span className="text-right">size</span>
                        <span className="text-right">idle</span>
                        <span>clearing it loses</span>
                    </div>
                    {section.rows.map((row) => (
                        <Row
                            key={row.id}
                            row={row}
                            bar={GROUP_BAR[section.group]}
                            onOpenRun={onOpenRun}
                            onDelete={onDelete}
                        />
                    ))}
                </>
            ) : null}
        </section>
    );
}

function Row({
    row,
    bar,
    onOpenRun,
    onDelete,
}: {
    row: StorageRowVM;
    bar: string;
    onOpenRun: (runId: string) => void;
    onDelete: (id: string) => void;
}) {
    const owner = "truncate text-[12.5px] font-medium";
    const runId = row.run?.kind === "run" ? row.run.runId : null;
    return (
        <div data-storage-row={row.id} className={cn(GRID, "items-center border-t border-edge-faint py-2")}>
            <span className="flex min-w-0 flex-col gap-[3px]">
                <span className="truncate font-mono text-[11.5px] text-secondary" title={row.full}>
                    {row.path}
                </span>
                <span className="truncate text-[11.5px] text-muted">{row.kind}</span>
            </span>
            <span className="flex min-w-0 flex-col items-start gap-[3px]">
                {runId != null ? (
                    <button
                        type="button"
                        data-storage-run={runId}
                        title={row.owner}
                        onClick={() => onOpenRun(runId)}
                        className={cn(
                            owner,
                            "max-w-full cursor-pointer text-left text-accent-soft hover:text-primary hover:underline"
                        )}
                    >
                        {row.owner}
                    </button>
                ) : (
                    <span className={cn(owner, "max-w-full text-secondary")}>{row.owner}</span>
                )}
                <span className={cn("max-w-full truncate", MONO_META)}>{row.ownerMeta}</span>
            </span>
            <span className="flex items-center gap-2.5">
                <span className="h-1.5 flex-1 rounded-[3px] bg-surface-raised">
                    <span className={cn("block h-1.5 rounded-[3px]", bar)} style={{ width: `${row.barPct}%` }} />
                </span>
                <span className="w-[52px] text-right font-mono text-[11.5px] text-secondary">{row.size}</span>
            </span>
            <span className="text-right font-mono text-[11px] text-muted">{row.idle}</span>
            <span className="flex min-w-0 flex-col items-start gap-1">
                <span className={cn("text-[12px] leading-[1.45]", row.losesMuted ? "text-muted" : "text-secondary")}>
                    {row.loses}
                </span>
                {row.tag != null || row.canDelete ? (
                    <span className="flex items-center gap-2">
                        {row.tag != null ? (
                            <span
                                className={cn(
                                    "rounded-[6px] px-1.5 py-0.5 font-mono text-[10.5px] font-bold",
                                    TAG_TONE[row.tag.tone]
                                )}
                            >
                                {row.tag.text}
                            </span>
                        ) : null}
                        {row.canDelete ? (
                            <button
                                type="button"
                                data-storage-delete={row.id}
                                onClick={() => onDelete(row.id)}
                                className="cursor-pointer rounded-[6px] border border-error/40 px-2 py-0.5 text-[11.5px] font-semibold text-error-soft transition-colors hover:border-error hover:bg-error/10"
                            >
                                Delete anyway…
                            </button>
                        ) : null}
                    </span>
                ) : null}
            </span>
        </div>
    );
}

function DeleteDialog({ item, onConfirm, onClose }: { item: StorageItem; onConfirm: () => void; onClose: () => void }) {
    const plan = deletePlan(item);
    return (
        <ConfirmDialog
            testId="storage-delete-confirm"
            tone="danger"
            title={plan.title}
            body={
                <>
                    <p>
                        {plan.lead.map((seg, i) =>
                            seg.strong ? (
                                <span key={i} className="text-secondary">
                                    {seg.text}
                                </span>
                            ) : (
                                <span key={i}>{seg.text}</span>
                            )
                        )}
                    </p>
                    {plan.commits.length > 0 ? (
                        <ul className="mt-2 flex list-disc flex-col gap-[3px] pl-[18px] font-mono text-[11.5px] text-secondary">
                            {plan.commits.map((c) => (
                                <li key={c.sha}>
                                    {c.sha} {c.subject}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    {plan.dirtyLine != null ? <p className="mt-2.5">{plan.dirtyLine}</p> : null}
                </>
            }
            confirmLabel={plan.cta}
            cancelLabel="Cancel"
            onConfirm={onConfirm}
            onClose={onClose}
        />
    );
}
