// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The peek is a compact global hub anchored to the creature. Its three jobs are ranked rather than peers
// (2026-09-04 brief §3): what needs doing leads and carries its actions inline, what happened is a drawer,
// and asking is a pinned composer. Everything actionable is a row carrying its own remedy; everything else
// is one line of text. Nothing renders to announce that nothing is wrong — which is what the previous
// three-card composition spent 693px doing, two of its four tiles reporting absence.
//
// The derivations live in petpeekmodel.ts and petcondition.ts. This file is a renderer.

import { PopoverReveal } from "@/app/element/popoverreveal";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { attentionAtom } from "@/app/view/agents/attentionstore";
import { activeChannelAtom, channelsAtom } from "@/app/view/agents/channelsstore";
import { memLoadedAtom, memNotesAtom, memPruneAtom } from "@/app/view/agents/memstore";
import { cn, fireAndForget } from "@/util/util";
import { FloatingFocusManager, autoUpdate, offset, shift, useFloating, type Placement } from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { runAct } from "./petactrun";
import { actsForEvent, type PetAct } from "./petacts";
import { conditionLine, type PetExpression, type PetSignals } from "./petcondition";
import { PetErrand } from "./peterrand";
import { resolveDestination } from "./peterrandmodel";
import { dedupeUpdates, peekConditions, queueRows, type PeekRow } from "./petpeekmodel";
import {
    petActStateAtom,
    petIndexAtom,
    petLastPassAtom,
    petPeekDestAtom,
    petPeekOpenAtom,
    petSaidAtom,
    type PetCorner,
} from "./petstore";
import type { PetEvent } from "./petvoice";
import { ageLabel } from "./recallderive";

const PLACEMENT: Record<PetCorner, Placement> = {
    "bottom-right": "top-end",
    "bottom-left": "top-start",
};

const ORIGIN: Record<PetCorner, string> = {
    "bottom-right": "bottom right",
    "bottom-left": "bottom left",
};

// A standing condition's dot. Tone is never the only carrier — the line states the fact in words, and an
// unremedied condition ends in "no action" rather than in nothing.
const CONDITION_DOT: Record<PetExpression["kind"], string> = {
    "cannot-see": "bg-error",
    tired: "bg-warning",
    drifting: "bg-warning",
    "at-rest": "bg-success",
};

// A waiting item's left bar, by kind. Paired with the row's verb ("Review" / "Decide" / "Answer"), which is
// what keeps the kind legible without relying on colour.
const ROW_BAR: Record<string, string> = {
    gate: "bg-warning",
    "dag-gate": "bg-warning",
    escalation: "bg-error",
    "dag-blocked": "bg-error",
    ask: "bg-accent",
};

function actLeavesPeek(act: PetAct): boolean {
    return act.verb !== "do" || act.op.kind === "clear-superseded";
}

function ActButton({
    model,
    act,
    tone,
    onLeave,
}: {
    model: AgentsViewModel;
    act: PetAct;
    tone: "primary" | "quiet";
    onLeave: () => void;
}) {
    const state = useAtomValue(petActStateAtom);
    const running = state[act.id]?.status === "running";
    return (
        <button
            type="button"
            data-pet-act={act.id}
            disabled={running}
            onClick={() => {
                if (actLeavesPeek(act)) {
                    onLeave();
                }
                fireAndForget(() => runAct(model, act));
            }}
            className={cn(
                "flex-none whitespace-nowrap rounded-md px-2.5 text-[10.5px] font-semibold",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                "disabled:cursor-default disabled:bg-surface-hover disabled:text-muted",
                tone === "primary"
                    ? "h-6 bg-accent font-bold text-background hover:bg-accenthover"
                    : "h-[22px] border border-edge-mid bg-transparent text-accent-soft hover:border-accent hover:bg-surface-hover"
            )}
        >
            {/* an act mid-flight becomes its own progress in place: same box, same width, so the row does
                not move and nothing below it shifts */}
            {act.label}
            {running ? <span className="ml-1 font-mono">▍</span> : null}
        </button>
    );
}

// Outcome text for a set of acts. Rendered on its own full-width line so a two-line error wraps downward
// instead of pushing the buttons around.
function ActOutcome({ acts, className }: { acts: PetAct[]; className?: string }) {
    const state = useAtomValue(petActStateAtom);
    const done = acts.map((act) => state[act.id]).find((entry) => entry?.text != null && entry.status !== "running");
    if (done?.text == null) {
        return null;
    }
    return (
        <p
            className={cn(
                "font-mono text-[10.5px] leading-[1.45]",
                done.status === "error" ? "text-error" : "text-muted",
                className
            )}
        >
            {done.text}
        </p>
    );
}

function QueueRow({
    model,
    row,
    now,
    onLeave,
}: {
    model: AgentsViewModel;
    row: PeekRow;
    now: number;
    onLeave: () => void;
}) {
    const [open, setOpen] = useState(false);
    const acts = row.primary != null ? [row.primary, ...row.more] : row.more;
    return (
        <div data-pet-row={row.key} className="border-b border-border last:border-b-0">
            <div className="grid grid-cols-[3px_minmax(0,1fr)] items-start gap-2.5 py-1.5 pl-[11px] pr-2 hover:bg-surface-hover">
                <div className={cn("my-0.5 h-full min-h-[18px] rounded-sm", ROW_BAR[row.kind] ?? "bg-edge-strong")} />
                <div className="min-w-0">
                    <div className="flex min-h-6 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-primary">
                            {row.source}
                        </span>
                        <span className="flex-none font-mono text-[9.5px] text-ink-faint">
                            {ageLabel(Math.max(0, now - row.waitingsince))}
                        </span>
                        {row.primary != null ? (
                            <ActButton model={model} act={row.primary} tone="primary" onLeave={onLeave} />
                        ) : null}
                        {row.more.length > 0 ? (
                            <button
                                type="button"
                                aria-expanded={open}
                                aria-label={`More on ${row.source}`}
                                onClick={() => setOpen((prior) => !prior)}
                                className="flex h-6 w-6 flex-none items-center justify-center rounded-md border border-border font-mono text-[11px] font-bold text-muted hover:border-edge-mid hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                            >
                                {open ? "−" : "›"}
                            </button>
                        ) : null}
                    </div>
                    {/* only kinds whose text is the payload get a detail line — see DETAIL_KINDS. It wraps
                        rather than truncating: an escalation IS its question, and hiding it behind the
                        disclosure would make every escalation cost a click to read. */}
                    {row.detail != null ? (
                        <p className="pb-0.5 pr-1 text-[11px] leading-[1.45] text-ink-mid">{row.detail}</p>
                    ) : null}
                    {open ? (
                        <div className="flex flex-wrap gap-1.5 pb-1.5 pt-1">
                            {row.more.map((act) => (
                                <ActButton key={act.id} model={model} act={act} tone="quiet" onLeave={onLeave} />
                            ))}
                        </div>
                    ) : null}
                    <ActOutcome acts={acts} className="pb-1.5 pr-1" />
                </div>
            </div>
        </div>
    );
}

function UpdateRow({
    model,
    event,
    now,
    noteExists,
    onLeave,
}: {
    model: AgentsViewModel;
    event: PetEvent;
    now: number;
    noteExists: (id: string) => boolean | undefined;
    onLeave: () => void;
}) {
    const acts = actsForEvent(event, noteExists);
    return (
        <div className="border-b border-border px-3 pb-2.5 pt-2 last:border-b-0">
            <p className="text-[11.5px] leading-[1.45] text-secondary">{event.text}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2.5">
                <span className="flex-none font-mono text-[9.5px] text-ink-faint">
                    {event.kind} · {ageLabel(Math.max(0, now - event.at))}
                </span>
                {acts.map((act) => (
                    <button
                        key={act.id}
                        type="button"
                        data-pet-act={act.id}
                        onClick={() => {
                            if (actLeavesPeek(act)) {
                                onLeave();
                            }
                            fireAndForget(() => runAct(model, act));
                        }}
                        className="whitespace-nowrap text-[10.5px] font-semibold text-accent-soft hover:text-accenthover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                        {act.label}
                    </button>
                ))}
            </div>
            <ActOutcome acts={acts} className="mt-1" />
        </div>
    );
}

export function PetPeek({
    model,
    anchor,
    corner,
    signals,
}: {
    model: AgentsViewModel;
    anchor: HTMLElement | null;
    corner: PetCorner;
    signals: PetSignals;
}) {
    const open = useAtomValue(petPeekOpenAtom);
    const said = useAtomValue(petSaidAtom);
    const pruneCandidates = useAtomValue(memPruneAtom);
    const memNotes = useAtomValue(memNotesAtom);
    const memLoaded = useAtomValue(memLoadedAtom);
    const lastPass = useAtomValue(petLastPassAtom);
    const items = useAtomValue(attentionAtom);
    const channels = useAtomValue(channelsAtom);
    const activeChannel = useAtomValue(activeChannelAtom);
    const picked = useAtomValue(petPeekDestAtom);
    const indexStatus = useAtomValue(petIndexAtom);
    const now = useAtomValue(model.nowAtom);
    const titleId = useId();
    const panelRef = useRef<HTMLDivElement | null>(null);
    const returnFocusRef = useRef<HTMLElement | null>(anchor);
    const [returnFocusEnabled, setReturnFocusEnabled] = useState(true);
    const [drawerOpen, setDrawerOpen] = useState(false);

    const close = useCallback(() => {
        returnFocusRef.current = anchor;
        setReturnFocusEnabled(true);
        globalStore.set(petPeekOpenAtom, false);
    }, [anchor]);
    const leavePeek = () => {
        setReturnFocusEnabled(false);
    };

    const { refs, floatingStyles, context } = useFloating({
        open,
        placement: PLACEMENT[corner],
        strategy: "fixed",
        middleware: [offset(12), shift({ padding: 8, crossAxis: true })],
        whileElementsMounted: autoUpdate,
    });

    useEffect(() => {
        refs.setPositionReference(anchor);
    }, [anchor, refs]);

    useEffect(() => {
        if (open) {
            returnFocusRef.current = anchor;
            setReturnFocusEnabled(true);
        }
    }, [anchor, open]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                close();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [close, open]);

    useEffect(() => {
        if (!open) {
            return;
        }
        // FloatingFocusManager's return-focus cleanup can fire while the peek is still
        // open (its effect re-runs on floating-ui-internal state) and yank focus back
        // to the anchor; while open, the dialog must hold focus, so steal it back.
        const onFocusIn = (event: FocusEvent) => {
            if (event.target === anchor && panelRef.current != null) {
                panelRef.current.focus();
            }
        };
        document.addEventListener("focusin", onFocusIn);
        return () => document.removeEventListener("focusin", onFocusIn);
    }, [open, anchor]);

    const noteExists = (id: string): boolean | undefined =>
        memLoaded ? memNotes.some((note) => note.id === id) : undefined;

    const conditions = peekConditions(signals, { index: indexStatus, prune: pruneCandidates });
    const rows = queueRows(items, channels);
    const updates = dedupeUpdates(said, items);
    const dest = resolveDestination({ picked, active: activeChannel?.oid ?? null, channels });
    // the panel's only evidence that Jarvis is running at all. The full reading (sessions covered, notes
    // written) is a Jarvis-surface fact; here it just needs to say "recently".
    const passText = lastPass == null ? "no pass yet" : `pass ${ageLabel(Math.max(0, now - lastPass.at))} ago`;
    // An empty queue is stated, not left blank. It is the answer to the panel's first question, and without
    // it "nothing is waiting" and "the queue has not loaded" look identical — the body simply collapses to
    // 0px and the composer butts against the conditions. Reporting absence is what the old panel's four
    // tiles did; answering the question the panel exists to answer is not the same thing.
    const nothingWaiting = rows.length === 0;

    const openJarvis = () => {
        leavePeek();
        globalStore.set(model.surfaceAtom, "jarvis");
        globalStore.set(petPeekOpenAtom, false);
    };

    return (
        <>
            {open ? <div data-pet-peek-backdrop className="fixed inset-0 z-[64]" onClick={close} /> : null}
            <div ref={refs.setFloating} style={floatingStyles} className="z-[65]">
                <FloatingFocusManager
                    context={context}
                    disabled={!open}
                    initialFocus={panelRef}
                    returnFocus={returnFocusEnabled ? returnFocusRef : false}
                    modal
                >
                    <PopoverReveal
                        open={open}
                        origin={ORIGIN[corner]}
                        className="flex max-h-[calc(100vh-16px)] w-[calc(100vw-16px)] max-w-[420px] flex-col overflow-hidden rounded-[12px] border border-border bg-surface-raised shadow-popover"
                    >
                        {/* mark the dialog as the focus-managed element: without it FloatingFocusManager
                            resolves its focus element to the harness picker's always-mounted
                            data-floating-ui-focusable wrapper inside this tree, and the tab trap
                            silently empties (tabbable() of an empty 0x0 div is []) */}
                        <div
                            ref={panelRef}
                            data-pet-peek="1"
                            data-floating-ui-focusable
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby={titleId}
                            tabIndex={-1}
                            className="flex min-h-0 flex-1 flex-col focus:outline-none"
                        >
                            <div data-pet-peek-header className="flex-none border-b border-border">
                                <div className="flex min-h-[44px] items-center gap-2 pl-3.5 pr-2">
                                    <h2 id={titleId} className="flex-none text-[14px] font-bold text-primary">
                                        Jarvis
                                    </h2>
                                    <span className="flex-none whitespace-nowrap font-mono text-[9.5px] text-ink-faint">
                                        · {passText}
                                    </span>
                                    <div className="flex-1" />
                                    <button
                                        type="button"
                                        aria-label="Open full Jarvis view"
                                        onClick={openJarvis}
                                        className="h-7 flex-none whitespace-nowrap rounded-[7px] px-2 text-[11px] font-medium text-muted hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                    >
                                        <span className="min-[380px]:hidden">Open</span>
                                        <span className="hidden min-[380px]:inline">Open full view</span>
                                    </button>
                                    <button
                                        type="button"
                                        aria-label="Close Jarvis panel"
                                        onClick={close}
                                        className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] border border-border text-muted hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                    >
                                        <X aria-hidden="true" size={14} strokeWidth={2} />
                                    </button>
                                </div>

                                {/* conditions are header chrome, not list items: a standing level is a
                                    different kind of thing from a discrete waiting item, and giving them
                                    the same shape is what made the old panel read as telemetry */}
                                {conditions.length > 0 ? (
                                    <div data-pet-conditions className="flex flex-col gap-2 px-3 pb-2.5 pt-0.5">
                                        {conditions.map((condition, index) => (
                                            <div key={condition.expr.kind}>
                                                <div className="flex min-h-6 items-center gap-2">
                                                    <span
                                                        className={cn(
                                                            "h-1.5 w-1.5 flex-none rounded-full",
                                                            CONDITION_DOT[condition.expr.kind]
                                                        )}
                                                    />
                                                    <span
                                                        className={cn(
                                                            "min-w-0 flex-1 leading-[1.4]",
                                                            index === 0
                                                                ? "text-[11.5px] font-medium text-secondary"
                                                                : "text-[11px] text-muted"
                                                        )}
                                                    >
                                                        {conditionLine(condition.expr, now)}
                                                    </span>
                                                    {condition.acts.map((act) => (
                                                        <ActButton
                                                            key={act.id}
                                                            model={model}
                                                            act={act}
                                                            tone="quiet"
                                                            onLeave={leavePeek}
                                                        />
                                                    ))}
                                                    {/* a condition with no remedy ends where a button
                                                        would sit, so it reads finished rather than broken */}
                                                    {condition.readout ? (
                                                        <span
                                                            title="this condition has no remedy — it is a readout"
                                                            className="flex-none font-mono text-[9.5px] text-ink-faint"
                                                        >
                                                            no action
                                                        </span>
                                                    ) : null}
                                                </div>
                                                <ActOutcome acts={condition.acts} className="pl-3.5" />
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                            </div>

                            <div
                                data-pet-peek-body
                                data-pet-queue
                                className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
                            >
                                {nothingWaiting ? (
                                    <p
                                        data-pet-quiet
                                        className="px-3.5 py-3 text-[11.5px] font-medium leading-[1.4] text-ink-mid"
                                    >
                                        Nothing waiting on you.
                                    </p>
                                ) : null}
                                {rows.map((row) => (
                                    <QueueRow key={row.key} model={model} row={row} now={now} onLeave={leavePeek} />
                                ))}
                            </div>

                            {updates.length > 0 ? (
                                <div data-pet-updates className="flex-none border-t border-border">
                                    <button
                                        type="button"
                                        aria-expanded={drawerOpen}
                                        onClick={() => setDrawerOpen((prior) => !prior)}
                                        className="flex min-h-[30px] w-full items-center gap-2 px-3 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
                                    >
                                        <span className="flex-none font-mono text-[9.5px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
                                            Since you looked
                                        </span>
                                        {/* the newest update stands in for the drawer while it is shut. Open,
                                            it would be the very next line — the same fact twice, which is
                                            the one rule this panel exists to keep. */}
                                        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
                                            {drawerOpen ? "" : updates[0].text}
                                        </span>
                                        <span className="flex-none font-mono text-[10px] font-bold text-muted">
                                            {drawerOpen ? "−" : "›"}
                                        </span>
                                    </button>
                                    {drawerOpen ? (
                                        <div className="max-h-[170px] overflow-y-auto border-t border-border">
                                            {updates.map((event) => (
                                                <UpdateRow
                                                    key={event.id}
                                                    model={model}
                                                    event={event}
                                                    now={now}
                                                    noteExists={noteExists}
                                                    onLeave={leavePeek}
                                                />
                                            ))}
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}

                            <PetErrand
                                dest={dest}
                                channels={channels}
                                onPick={(oid) => globalStore.set(petPeekDestAtom, oid)}
                            />
                        </div>
                    </PopoverReveal>
                </FloatingFocusManager>
            </div>
        </>
    );
}
