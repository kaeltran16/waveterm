// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's record peek. In the three-pane composition a record is a subject on the Stage; the Brief has
// no Stage, so this is where a record oref lands (see openref.ts's task arm).
//
// It shows what is running against the record, what you set it to, and its decision log: the peek is the
// record's only home, so the log is read and added to here.
//
// Everything shown is derived in briefpeek.ts. RecordPeekBody mounts it, loads the two caches it reads, and
// owns the status write on it, including the terminal-status question, which both hosts ask in place; the
// Brief's modal and the avatar popup's record item both render it.

import { Skeleton, SkeletonLine } from "@/app/element/skeleton";
import { ModalShell } from "@/app/modals/modalshell";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { channelMessagesAtom, channelsAtom } from "@/app/view/agents/channelsstore";
import { harnessesAtom } from "@/app/view/agents/harnessstore";
import { fleetCounts } from "@/app/view/agents/jarviscards";
import type { RunStatusTone } from "@/app/view/agents/runmodel";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { Check, ChevronDown, ChevronUp, Waypoints, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
    buildRecordPeek,
    decisionsOpenOnMount,
    statusConfirmCopy,
    type PeekRunRow,
    type PeekStatusRow,
} from "./briefpeek";
import { BODY_LINK, MONO_FAINT, SMALL_BTN } from "./briefstyle";
import { DecisionLog } from "./decisionlog";
import { fleetForRecord } from "./fleetscope";
import { briefGraphRecordAtom, briefPeekRecordAtom, graphPeekOpenAtom } from "./jarvisstore";
import {
    loadRecordDetail,
    loadRecordScope,
    recordDetailAtom,
    recordDetailErrorAtom,
    recordRunsAtom,
} from "./jarvissubjectstore";
import { openAddress, openOrPeekAddress, type OpenGesture } from "./openref";
import { closePeek } from "./peekstore";
import { pendingDecisionAnchorAtom } from "./petstore";
import { setDossierStatus } from "./recordactions";
import { forgetOrigin, passReturn, returnToOrigin } from "./returnsurface";

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
export const RUN_TONE: Record<RunStatusTone, string> = {
    planning: "text-accent-soft",
    review: "text-warning",
    running: "text-success",
    done: "text-success/70",
    blocked: "text-warning",
    failed: "text-error",
    cancelled: "text-muted",
};

const SEGMENT = "rounded-[6px] px-3 py-1 text-[11.5px] font-semibold";

const CONFIRM_BTN = cn(SMALL_BTN, "flex-none px-[9px] text-[11px]");

// DEV-only: ids whose load __recordPeekFor holds (linkingdevhooks.ts), so the skeleton stays up long enough to
// photograph. It lives here rather than in that module because the module is imported only in a dev build.
export const heldRecordLoads = new Set<string>();

// The body's host. The Brief's modal is a destination, so its run links peek on Ctrl+click; the avatar popup is
// itself a peek, and a link inside one is a plain open (depth 1).
type Place = "brief" | "popup";

// The current status is a label, not a control: there is nothing for it to do, and dressing it as a button
// would be the same lie as camouflaging a real one. A terminal pick waiting on its confirm keeps its colour.
function StatusToggle({
    rows,
    pending,
    onPick,
}: {
    rows: PeekStatusRow[];
    pending: string | null;
    onPick: (status: string) => void;
}) {
    const shown = rows.find((r) => r.status === pending) ?? rows.find((r) => r.current);
    return (
        <div className="flex flex-none items-center gap-2 px-[18px] pt-[14px]">
            <div
                role="group"
                aria-label="Record status"
                data-jarvis-peek-status-toggle
                className="flex flex-none gap-0.5 rounded-[8px] border border-border bg-surface p-0.5"
            >
                {rows.map((row) => {
                    const fg = STATUS_FG[row.status] ?? "text-muted";
                    if (row.current) {
                        return (
                            <span
                                key={row.status}
                                data-jarvis-peek-status={row.status}
                                className={cn(SEGMENT, "inline-flex items-center gap-[5px] bg-surface-selected", fg)}
                            >
                                <Check size={11} strokeWidth={2.4} />
                                {row.label}
                            </span>
                        );
                    }
                    const isPending = row.status === pending;
                    return (
                        <button
                            key={row.status}
                            type="button"
                            aria-pressed={false}
                            data-jarvis-peek-status={row.status}
                            data-jarvis-peek-pending={isPending ? row.status : undefined}
                            onClick={() => onPick(row.status)}
                            className={cn(
                                SEGMENT,
                                "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                isPending
                                    ? cn("bg-surface-hover", fg)
                                    : "text-ink-mid hover:bg-surface-hover hover:text-secondary"
                            )}
                        >
                            {row.label}
                        </button>
                    );
                })}
            </div>
            <span className="min-w-0 flex-1 text-[11px] leading-[1.45] text-muted">{shown?.note ?? ""}</span>
        </div>
    );
}

// an open from inside the popup leaves it, the way the hub's own escorts do; a failed one keeps it up behind
// the toast
async function openFromPopup(model: AgentsViewModel, address: string): Promise<void> {
    const result = await openAddress(model, address);
    if (result.ok) {
        closePeek();
    }
}

// The modal sits above both places a run lands (z-70 over the sheet's z-20 and the peek's z-65), so it steps aside
// once the run lands, or the run would sit out of sight behind it; a failed open keeps it up behind the toast.
async function openFromBrief(model: AgentsViewModel, address: string, e: OpenGesture): Promise<void> {
    const peeked = e.ctrlKey;
    const result = await openOrPeekAddress(model, address, e);
    if (!result.ok) {
        return;
    }
    globalStore.set(briefPeekRecordAtom, null);
    if (peeked) {
        forgetOrigin();
    } else {
        passReturn("record", "sheet");
    }
}

function RunRowView({ row, model, place }: { row: PeekRunRow; model: AgentsViewModel; place: Place }) {
    const address = "run:" + row.runId;
    return (
        <button
            type="button"
            data-jarvis-peek-row="run"
            data-jarvis-peek-run={row.runId}
            data-peek={place === "brief" ? true : undefined}
            onClick={(e) =>
                place === "brief"
                    ? fireAndForget(() => openFromBrief(model, address, e))
                    : fireAndForget(() => openFromPopup(model, address))
            }
            className="grid w-full cursor-pointer grid-cols-[74px_minmax(0,1fr)_150px_118px] items-center gap-3 border-b border-edge-faint px-3 py-2 text-left last:border-b-0 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
            <span className="font-mono text-[10.5px] font-semibold text-accent-soft">{row.shortId}</span>
            <span className="min-w-0 truncate text-[12.5px] text-ink-hi">{row.headline}</span>
            <span className={cn("truncate", MONO_FAINT)}>{row.meta}</span>
            <span
                className={cn(
                    "inline-flex items-center justify-end gap-1.5 whitespace-nowrap font-mono text-[10.5px] font-semibold",
                    RUN_TONE[row.tone]
                )}
            >
                <span className="h-1.5 w-1.5 flex-none rounded-full bg-current" />
                {row.state}
            </span>
        </button>
    );
}

// Asked in place in both hosts: inside the popup a second modal would sit under the popup's focus trap, and in the
// Brief a dialog over the modal would stack two modals both claiming Escape.
function InlineConfirm({
    status,
    onConfirm,
    onCancel,
}: {
    status: string;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const copy = statusConfirmCopy(status);
    return (
        <div
            data-jarvis-peek-confirm={status}
            className="mx-[18px] mt-2.5 flex flex-none items-center gap-3 rounded-[8px] border border-edge-mid bg-surface px-3 py-2.5"
        >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[12px] font-semibold text-ink-hi">{copy.title}</span>
                <span className="text-[11.5px] leading-[1.45] text-muted">{copy.body}</span>
            </div>
            <button
                type="button"
                onClick={onConfirm}
                className={cn(CONFIRM_BTN, status === "archived" ? "text-error" : "text-warning")}
            >
                {`Yes, ${status}`}
            </button>
            <button type="button" onClick={onCancel} className={CONFIRM_BTN}>
                Cancel
            </button>
        </div>
    );
}

function CloseButton({ onClose }: { onClose: () => void }) {
    return (
        <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mt-1 flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-[7px] text-muted hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
            <X size={15} strokeWidth={2} />
        </button>
    );
}

// the runs table while the record's scope read is in flight: three rows of varied length, read as rows
const RUN_SKELETON_WIDTHS = ["w-[72%]", "w-[58%]", "w-[66%]"];

// the frame the read is filling in, shaped like what it will become: toggle, objective lines, runs table
function LoadingBody() {
    return (
        <div data-jarvis-peek-loading className="flex flex-col gap-2 px-[18px] pt-[14px] pb-[18px]">
            <Skeleton className="h-7 w-[290px] max-w-full rounded-[8px]" />
            <SkeletonLine className="mt-2 h-2.5 w-full" />
            <SkeletonLine className="h-2.5 w-[92%]" />
            <SkeletonLine className="h-2.5 w-[60%]" />
            <Skeleton className="mt-2.5 h-[110px] rounded-[9px]" />
        </div>
    );
}

export function RecordPeekBody({
    model,
    recordId,
    place,
    onMap,
    onClose,
}: {
    model: AgentsViewModel;
    recordId: string;
    place: Place;
    // the map button's exit; each host leaves its own way
    onMap: () => void;
    // the header's close; the popup draws its own header and passes none
    onClose?: () => void;
}) {
    const details = useAtomValue(recordDetailAtom);
    const readErrors = useAtomValue(recordDetailErrorAtom);
    const runsByRecord = useAtomValue(recordRunsAtom);
    const channels = useAtomValue(channelsAtom);
    const messagesByChannel = useAtomValue(channelMessagesAtom);
    const agents = useAtomValue(model.agentsAtom);
    const harnesses = useAtomValue(harnessesAtom);
    const anchor = useAtomValue(pendingDecisionAnchorAtom);
    const [asking, setAsking] = useState<string | null>(null);
    const [objectiveOpen, setObjectiveOpen] = useState(false);
    const [decisionsOpen, setDecisionsOpen] = useState(false);
    const decisionsRef = useRef<HTMLDivElement | null>(null);

    // both caches, because the peek's two halves come from different reads: the record's own fields, and the
    // runs attributed to it (a dossier has no run list of its own — ResolveSpaceScope answers that).
    useEffect(() => {
        if (heldRecordLoads.has(recordId)) {
            return;
        }
        loadRecordDetail(recordId);
        loadRecordScope(recordId);
    }, [recordId]);

    // the confirm and the expanded objective are per-opening, not per-record: a confirm left open across a
    // close would reopen the peek mid-write, and a second record would open already expanded
    useEffect(() => {
        setAsking(null);
        setObjectiveOpen(false);
        setDecisionsOpen(false);
        // leaving the record drops an anchor on one of its decisions, so it does not flash on the next opening.
        // Only its own: openref sets the next record's anchor before switching to it.
        return () => {
            const leaving = globalStore.get(recordDetailAtom)[recordId]?.decisions ?? [];
            if (decisionsOpenOnMount(globalStore.get(pendingDecisionAnchorAtom), leaving)) {
                globalStore.set(pendingDecisionAnchorAtom, null);
            }
        };
    }, [recordId]);

    const detail = details[recordId];
    const decisions = detail?.decisions;
    // declared after the reset above, so a record opened onto an anchor resets and then opens its log
    useEffect(() => {
        if (decisionsOpenOnMount(anchor, decisions ?? [])) {
            setDecisionsOpen(true);
        }
    }, [anchor, decisions]);

    // the log opens below the runs, so opening it from the footer brings it into sight. Not done for an anchored
    // open: the anchored card scrolls itself into view.
    const toggleDecisions = () => {
        const opening = !decisionsOpen;
        setDecisionsOpen(opening);
        if (opening) {
            requestAnimationFrame(() => decisionsRef.current?.scrollIntoView({ block: "nearest" }));
        }
    };

    const readError = detail == null ? readErrors[recordId] : undefined;
    // undefined until the scope read lands: the peek draws skeleton rows rather than claiming no runs
    const runs = runsByRecord[recordId];
    const fleet = fleetForRecord({
        channels: channels ?? [],
        messagesByChannel,
        agents,
        attributedRuns: runs ?? [],
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
        // completed and archived are terminal enough to confirm — the same guard taskdetail applies, kept
        // here rather than re-decided, so the two entry points cannot disagree about what needs a prompt.
        if (row?.terminal) {
            setAsking(next);
            return;
        }
        setAsking(null);
        setDossierStatus(recordId, next);
    };

    // a record with no objective is titled by its id, and so is one whose read failed: an id, drawn as one
    const titleIsId = peek == null || peek.titleIsId;
    let title = (
        <div className="min-w-0 flex-1 pt-[3px]">
            <SkeletonLine className="h-[14px] w-[300px] max-w-full" />
        </div>
    );
    if (peek != null || readError != null) {
        title = (
            <h2
                data-jarvis-peek-title
                className={cn(
                    "m-0 min-w-0 flex-1 break-words font-semibold leading-[1.4] text-primary",
                    titleIsId ? "font-mono text-[14px]" : "text-[15px]"
                )}
            >
                {peek != null ? peek.title : recordId}
            </h2>
        );
    }

    let body = <LoadingBody />;
    if (peek == null && readError != null) {
        body = (
            <div data-jarvis-peek-error className="px-[18px] py-4 text-[12px] leading-[1.5] text-error">
                {`Could not read this record: ${readError}`}
            </div>
        );
    }
    if (peek != null) {
        body = (
            <>
                <StatusToggle rows={peek.statusRows} pending={asking} onPick={applyStatus} />
                {asking != null ? (
                    <InlineConfirm
                        status={asking}
                        onConfirm={() => {
                            setDossierStatus(recordId, asking);
                            setAsking(null);
                        }}
                        onCancel={() => setAsking(null)}
                    />
                ) : null}
                <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-[18px] pt-4 pb-[18px]">
                    {peek.body != null ? (
                        <div className="flex flex-col gap-1.5">
                            <p
                                data-jarvis-peek-body
                                className={cn(
                                    "m-0 whitespace-pre-line text-[13px] leading-[1.6]",
                                    peek.bodyIsAbsence ? "text-muted" : "text-ink-mid",
                                    peek.bodyMore != null && !objectiveOpen && "line-clamp-4"
                                )}
                            >
                                {peek.body}
                            </p>
                            {peek.bodyMore != null ? (
                                <button
                                    type="button"
                                    data-jarvis-peek-body-toggle
                                    aria-expanded={objectiveOpen}
                                    onClick={() => setObjectiveOpen((v) => !v)}
                                    className={BODY_LINK}
                                >
                                    {objectiveOpen ? "Show less" : peek.bodyMore}
                                    {objectiveOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                    <div className="flex flex-col">
                        <div className="flex items-baseline gap-2.5 px-0.5 pb-2">
                            <span className="text-[12.5px] font-semibold text-secondary">Runs on this record</span>
                            <span className="flex-1" />
                            <span className={cn("flex-none", MONO_FAINT)}>{peek.fleetMeta}</span>
                        </div>
                        <div className="flex flex-col overflow-hidden rounded-[9px] border border-border bg-background">
                            {peek.runsLoading ? (
                                <div data-jarvis-peek-runs-loading className="flex flex-col">
                                    {RUN_SKELETON_WIDTHS.map((w) => (
                                        <div key={w} className="border-b border-edge-faint px-3 py-2.5 last:border-b-0">
                                            <SkeletonLine className={cn("h-2.5", w)} />
                                        </div>
                                    ))}
                                </div>
                            ) : peek.runsAbsent != null ? (
                                <div className="px-3 py-2.5 font-mono text-[11px] text-muted">{peek.runsAbsent}</div>
                            ) : (
                                peek.runs.map((row) => (
                                    <RunRowView key={row.runId} row={row} model={model} place={place} />
                                ))
                            )}
                        </div>
                    </div>
                    {decisionsOpen ? (
                        <div ref={decisionsRef} data-jarvis-peek-decision-log className="flex flex-col">
                            <span className="px-0.5 pb-2 text-[12.5px] font-semibold text-secondary">Decisions</span>
                            <DecisionLog decisions={decisions ?? []} dossierId={recordId} />
                        </div>
                    ) : null}
                </div>
                <div className="flex flex-none items-center gap-2 border-t border-border px-[18px] py-3">
                    <button
                        type="button"
                        data-jarvis-peek-decisions
                        aria-expanded={decisionsOpen}
                        onClick={toggleDecisions}
                        className={BODY_LINK}
                    >
                        {peek.logLine}
                        {decisionsOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                    </button>
                    <span className="flex-1" />
                    <button
                        type="button"
                        data-jarvis-peek-open-graph
                        onClick={onMap}
                        className={cn(SMALL_BTN, "inline-flex items-center gap-1.5")}
                    >
                        <Waypoints size={12} className="text-muted" />
                        Where it sits on the map
                    </button>
                </div>
            </>
        );
    }

    return (
        <div data-jarvis-peek-record={recordId} className="flex min-h-0 flex-col">
            <div className="flex min-w-0 flex-none items-start gap-2.5 border-b border-border py-[15px] pl-[18px] pr-3">
                {title}
                {peek != null ? (
                    <span className={cn("flex-none pt-[3px]", MONO_FAINT)}>{peek.updatedLabel}</span>
                ) : null}
                {onClose != null ? <CloseButton onClose={onClose} /> : null}
            </div>
            {body}
        </div>
    );
}

export function BriefPeek({ model }: { model: AgentsViewModel }) {
    const recordId = useAtomValue(briefPeekRecordAtom);
    const setRecordId = useSetAtom(briefPeekRecordAtom);

    const close = () => {
        setRecordId(null);
        returnToOrigin("record");
    };
    // The peek's one exit. It closes the peek first: the graph peek is an overlay on the surface, and leaving the
    // record modal up over it would stack two modals, both claiming Escape.
    const openMap = () => {
        if (recordId == null) return;
        globalStore.set(briefGraphRecordAtom, recordId);
        forgetOrigin();
        setRecordId(null);
        globalStore.set(graphPeekOpenAtom, true);
    };

    return (
        <ModalShell
            open={recordId != null}
            onClose={close}
            align="center"
            className="flex max-h-[86vh] w-[640px] max-w-full flex-col"
        >
            <div data-jarvis-brief-band="peek" className="flex min-h-0 flex-col">
                {recordId != null ? (
                    <RecordPeekBody model={model} recordId={recordId} place="brief" onMap={openMap} onClose={close} />
                ) : null}
            </div>
        </ModalShell>
    );
}
