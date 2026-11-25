// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Setup surface's Memory tab: one centered page of what waits for the user (a split, a cleanup, a move into
// a repo doc, a failed check), each row opening in place, then what Arc did this week with Undo. All derivation
// is in memorymodel.ts, the atoms, RPCs and key actions in memorystore.ts.

import { barFillClass, cardVariants, errorNudge, morphTransition } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { TickNumber } from "@/app/element/ticknumber";
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { buildMemoryBindings } from "@/app/store/keybindings/bindings";
import { useKeybindings } from "@/app/store/keybindings/store";
import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { RefreshCw } from "lucide-react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode, type Ref } from "react";
import {
    cleanupDetail,
    didLines,
    diffLabel,
    digest,
    emptyText,
    kindLabel,
    kindTone,
    rowButtons,
    splitCounts,
    splitItemChip,
    splitList,
    splitState,
    spotCheck,
    waitingRows,
    waitingStatus,
    type DidLine,
    type KindTone,
    type RowButtons,
    type RowKind,
    type SplitState,
    type WaitingRow,
} from "./memorymodel";
import {
    bringBackMemory,
    checkMemory,
    leaveOutMemory,
    loadMemory,
    memoryApplyingAtom,
    memoryBusyAtom,
    memoryErrorAtom,
    memoryFocusAtom,
    memoryOpenAtom,
    memoryProjectsAtom,
    memoryRefusedAtom,
    memoryRowResultsAtom,
    runRowButton,
    subscribeMemory,
    toggleMemoryOpen,
    undoMemoryBatch,
    undoMemoryLine,
} from "./memorystore";
import type { Tone } from "./setupmodel";

const INTRO =
    "Arc tidies every project’s memory once a week. Trims, deletes, merges and index adds it applies itself; a " +
    "project getting its own memory, memories leaving a shared one, and moves into a repo doc wait for you.";

const SECTION_HEAD = cn(REGION_LABEL, "text-muted");
const BTN_SECONDARY =
    "h-8 flex-none cursor-pointer rounded border border-edge-mid bg-surface-raised px-3 text-[13px] font-semibold text-ink-mid hover:border-edge-strong hover:bg-surface-hover hover:text-primary disabled:cursor-default disabled:text-ink-faint disabled:hover:border-edge-mid disabled:hover:bg-surface-raised";
const BTN_PRIMARY =
    "h-8 flex-none cursor-pointer rounded border-0 bg-accent px-[14px] text-[13px] font-bold text-background shadow-inset-highlight hover:bg-accenthover disabled:cursor-default disabled:opacity-40 disabled:hover:bg-accent";
const BTN_SMALL = cn(BTN_SECONDARY, "h-[26px] px-2.5 text-[12px]");
const BTN_TEXT =
    "h-6 flex-none cursor-pointer rounded-md border-0 bg-transparent px-2 text-[12px] font-semibold hover:bg-surface-hover disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent";
const KIND_CHIP =
    "inline-flex h-[22px] flex-none items-center whitespace-nowrap rounded-md border px-2 text-[11px] font-semibold";
// a removal reads apart from what comes in and from an edit in place
const KIND_TONE: Record<KindTone, string> = {
    remove: "border-error/30 bg-error/10 text-error-soft",
    add: "border-accent/30 bg-accentbg text-accent-soft",
    edit: "border-edge-mid bg-surface-hover text-ink-mid",
};
const ROW_TONE: Record<RowKind, KindTone> = { split: "add", cleanup: "remove", doc: "add", failed: "remove" };
const ITEM_ROW = "flex min-h-8 items-center gap-2 border-b border-edge-faint";
const ITEM_TITLE = "min-w-0 flex-1 truncate text-[12.5px]";
// an opened row's body sits under its title, clear of the chip
const OPENED_BODY = "flex flex-col gap-2.5 pb-3.5 pl-[120px] pr-3 pt-0.5";

const TONE_DOT: Record<Tone, string> = { ok: "bg-success", warn: "bg-warning", none: "bg-ink-faint" };
const TONE_TEXT: Record<Tone, string> = { ok: "text-ink-mid", warn: "text-warning-soft", none: "text-muted" };

const DIFF_LINE: Record<string, string> = {
    "-": "bg-(--diff-removed-tint) text-diff-removed",
    "+": "bg-(--diff-added-tint) text-diff-added",
};

const INSTANT: Transition = { duration: 0 };

function Dot({ tone, className }: { tone: Tone; className?: string }) {
    return <span className={cn("h-1.5 w-1.5 flex-none rounded-full", TONE_DOT[tone], className)} />;
}

function Chip({ tone, children }: { tone: KindTone; children: ReactNode }) {
    return <span className={cn(KIND_CHIP, KIND_TONE[tone])}>{children}</span>;
}

function toTone(s: string): Tone {
    return s === "ok" || s === "warn" ? s : "none";
}

// the lead sentence of a stop or refusal reads in bold, as on the boards
function LeadText({ text, strong }: { text: string; strong: string }) {
    const at = text.indexOf(". ");
    const [lead, rest] = at < 0 ? [text, ""] : [text.slice(0, at + 1), text.slice(at + 1)];
    return (
        <span className="flex-1 text-[12.5px] leading-[1.55] text-secondary">
            <strong className={strong}>{lead}</strong>
            {rest}
        </span>
    );
}

const STOP_TONE = {
    warn: { box: "border-warning/30 bg-warning/10", strong: "text-warning-soft" },
    error: { box: "border-error/30 bg-error/10", strong: "text-error-soft" },
};

// a stop or a refusal (moment 13). Callers mount it under an AnimatePresence initial={false} that is already
// there, so it shakes once when it appears after the user's action and not when its row opens on it.
function StopBox({
    tone,
    text,
    attrs,
    children,
}: {
    tone: keyof typeof STOP_TONE;
    text: string;
    attrs: Record<string, string>;
    children: ReactNode;
}) {
    return (
        <motion.div
            role="status"
            {...attrs}
            variants={errorNudge}
            initial="initial"
            animate="animate"
            className={cn("flex items-center gap-3 rounded border px-3.5 py-2.5", STOP_TONE[tone].box)}
        >
            <LeadText text={text} strong={STOP_TONE[tone].strong} />
            {children}
        </motion.div>
    );
}

export function MemoryHeader() {
    const projects = useAtomValue(memoryProjectsAtom);
    if (projects == null) {
        return null;
    }
    const s = waitingStatus(projects);
    return (
        <div className={cn("flex items-center gap-2 text-[12px]", TONE_TEXT[s.tone])}>
            <Dot tone={s.tone} className="h-[7px] w-[7px]" />
            {s.text}
        </div>
    );
}

// ---- a waiting row's buttons ----

function CheckLabel({ p, label }: { p: MemHygieneProject; label: string }) {
    return (
        <>
            <RefreshCw size={13} className={cn(p.checking && "animate-spin motion-reduce:animate-none")} />
            {p.checking ? "Checking…" : label}
        </>
    );
}

function RowActions({ p, row, b, lead }: { p: MemHygieneProject; row: WaitingRow; b: RowButtons; lead?: ReactNode }) {
    const check = b.primary?.action === "check";
    return (
        <div className="flex items-center justify-end gap-2">
            {lead}
            <span className="flex-1" />
            {b.undo ? (
                <button
                    type="button"
                    data-memory-undo="split"
                    disabled={b.undo.disabled}
                    onClick={() => runRowButton(row, "undo")}
                    className={BTN_SECONDARY}
                >
                    {b.undo.label}
                </button>
            ) : null}
            {b.keep ? (
                <button
                    type="button"
                    data-memory-keep
                    disabled={b.keep.disabled}
                    onClick={() => runRowButton(row, "keep")}
                    className={BTN_SECONDARY}
                >
                    {b.keep.label}
                </button>
            ) : null}
            {b.primary ? (
                <button
                    type="button"
                    data-memory-apply={check ? undefined : true}
                    data-memory-check={check || undefined}
                    disabled={b.primary.disabled}
                    onClick={() => runRowButton(row, "primary")}
                    className={cn(BTN_PRIMARY, check && "inline-flex items-center gap-1.5")}
                >
                    {check ? <CheckLabel p={p} label={b.primary.label} /> : b.primary.label}
                </button>
            ) : null}
        </div>
    );
}

// ---- a split ----

function SplitItem({ p, c }: { p: MemHygieneProject; c: MemChange }) {
    const busy = useAtomValue(memoryBusyAtom);
    const left = c.status === "kept";
    return (
        <div data-memory-item={c.id} className={ITEM_ROW}>
            <Chip tone={left ? "edit" : "add"}>{splitItemChip(c)}</Chip>
            <span title={c.title} className={cn(ITEM_TITLE, left ? "text-muted" : "text-ink-hi")}>
                {c.title}
            </span>
            {/* one already brought over stays: leaving it out is an Undo of the split */}
            {c.status !== "applied" ? (
                <button
                    type="button"
                    data-memory-leaveout
                    disabled={busy}
                    onClick={() =>
                        fireAndForget(() => (left ? bringBackMemory(p.project, c.id) : leaveOutMemory(p.project, c.id)))
                    }
                    className={cn(BTN_TEXT, left ? "text-accent" : "text-muted")}
                >
                    {left ? "Bring back" : "Leave out"}
                </button>
            ) : null}
        </div>
    );
}

function SplitBody({ p, row, st, b }: { p: MemHygieneProject; row: WaitingRow; st: SplitState; b: RowButtons }) {
    const stopped = st.state === "changed" || st.state === "newer" || st.state === "failed";
    return (
        <>
            <AnimatePresence initial={false}>
                {stopped ? (
                    <StopBox
                        key={st.state}
                        tone={st.state === "failed" ? "error" : "warn"}
                        text={st.text}
                        attrs={{ "data-memory-stop": st.state }}
                    >
                        <RowActions p={p} row={row} b={b} />
                    </StopBox>
                ) : null}
            </AnimatePresence>
            {st.state === "applying" ? <SplitProgress p={p} text={st.text} /> : null}
            {st.state === "open" || st.state === "partial" ? <SplitReview p={p} row={row} b={b} /> : null}
        </>
    );
}

// moment 11: the fill grows by what each re-list brought over
function SplitProgress({ p, text }: { p: MemHygieneProject; text: string }) {
    const n = splitCounts(p);
    const pct = n.total === 0 ? 0 : Math.round((100 * n.here) / n.total);
    return (
        <div data-memory-progress className="flex flex-col gap-1.5">
            <span className="text-[12.5px] text-secondary">{text}</span>
            <span className="block h-1 overflow-hidden rounded-full bg-edge-mid">
                <span className={cn("block h-1 bg-accent", barFillClass)} style={{ width: `${pct}%` }} />
            </span>
        </div>
    );
}

function SplitReview({ p, row, b }: { p: MemHygieneProject; row: WaitingRow; b: RowButtons }) {
    const [all, setAll] = useState(false);
    const n = splitCounts(p);
    const showAll = (
        <button
            type="button"
            data-memory-showall
            onClick={() => setAll(!all)}
            className={cn(BTN_TEXT, "px-0 text-accent hover:bg-transparent")}
        >
            {all ? "Show fewer" : `Show all ${(n.comeOver + n.leftOut).toLocaleString("en-US")}`}
        </button>
    );
    return (
        <>
            {all ? (
                <div className="flex max-h-[420px] flex-col overflow-y-auto border-t border-edge-faint">
                    {splitList(p).map((g) => (
                        <div key={g.label} className="flex flex-col">
                            <span className={cn(SECTION_HEAD, "pb-1 pt-2.5")}>
                                {g.label} · {g.count.toLocaleString("en-US")}
                            </span>
                            {g.changes.map((c) => (
                                <SplitItem key={c.id} p={p} c={c} />
                            ))}
                        </div>
                    ))}
                </div>
            ) : (
                <div className="flex flex-col">
                    {spotCheck(p).map((c) => (
                        <SplitItem key={c.id} p={p} c={c} />
                    ))}
                </div>
            )}
            <RowActions p={p} row={row} b={b} lead={showAll} />
        </>
    );
}

// ---- a cleanup, a doc move, a failed check ----

function CleanupBody({ p, row, b }: { p: MemHygieneProject; row: WaitingRow; b: RowButtons }) {
    const projects = useAtomValue(memoryProjectsAtom) ?? [];
    const busy = useAtomValue(memoryBusyAtom);
    const d = cleanupDetail(p, projects);
    return (
        <>
            <p className="m-0 text-[12.5px] leading-[1.5] text-secondary">{d.body}</p>
            <div className="flex flex-col">
                {d.changes.map((c) => (
                    <div key={c.id} data-memory-item={c.id} className={ITEM_ROW}>
                        <Chip tone="remove">Clear</Chip>
                        <span title={c.title} className={cn(ITEM_TITLE, "text-ink-hi")}>
                            {c.title}
                        </span>
                        <button
                            type="button"
                            data-memory-leaveout
                            disabled={busy}
                            onClick={() => fireAndForget(() => leaveOutMemory(p.project, c.id))}
                            className={cn(BTN_TEXT, "text-muted")}
                        >
                            Leave out
                        </button>
                    </div>
                ))}
            </div>
            <RowActions p={p} row={row} b={b} />
        </>
    );
}

function DiffBlock({ p, diff }: { p: MemHygieneProject; diff: MemDiff }) {
    return (
        <div data-memory-diff className="overflow-hidden rounded border border-edge-mid bg-surface-code">
            <div className="flex h-7 items-center gap-2.5 border-b border-edge-faint px-2.5 font-mono text-[11px] text-muted">
                <span title={diff.path} className="min-w-0 truncate">
                    {diffLabel(p, diff.path)}
                </span>
                <span className="flex-1" />
                <span className="flex-none">{diff.note}</span>
            </div>
            {diff.lines?.length ? (
                <div className="py-1.5">
                    {diff.lines.map((ln, i) => (
                        <div
                            key={i}
                            className={cn(
                                "flex gap-2 px-2.5 py-px font-mono text-[11.5px] leading-[18px]",
                                DIFF_LINE[ln.sign] ?? "text-ink-mid"
                            )}
                        >
                            <span className="w-2 flex-none">{ln.sign}</span>
                            <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{ln.text}</span>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function DocBody({ p, row, b }: { p: MemHygieneProject; row: WaitingRow; b: RowButtons }) {
    const c = p.changes.find((x) => x.id === row.changeId);
    if (c == null) {
        return null;
    }
    return (
        <>
            {c.evidence?.map((e, i) => (
                <div
                    key={i}
                    data-memory-evidence
                    className="flex items-start gap-2 text-[12px] leading-[1.5] text-secondary"
                >
                    <Dot tone={toTone(e.tone)} className="mt-1.5" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                        <span>{e.text}</span>
                        {e.code ? (
                            <span className="font-mono text-[11px] text-ink-hi [overflow-wrap:anywhere]">{e.code}</span>
                        ) : null}
                    </span>
                </div>
            ))}
            {(c.diffs ?? []).map((d, i) => (
                <DiffBlock key={i} p={p} diff={d} />
            ))}
            {c.note ? <p className="m-0 text-[11.5px] leading-[1.5] text-muted">{c.note}</p> : null}
            <RowActions p={p} row={row} b={b} />
        </>
    );
}

function FailedBody({ p, row, b }: { p: MemHygieneProject; row: WaitingRow; b: RowButtons }) {
    return (
        <div className="flex items-center gap-3">
            <span className="flex-1 text-[12.5px] leading-[1.5] text-secondary">{p.lasterror}</span>
            <RowActions p={p} row={row} b={b} />
        </div>
    );
}

// ---- rows and lines ----

// a waiting row and the did line its apply leaves are one element changing sections (moment 17), unless both
// show at once (a cleanup batch from an earlier Clear while more removals wait), where one id would name two
function rowMorph(row: WaitingRow): string {
    return row.kind === "doc" ? `doc:${row.changeId}` : `${row.kind}:${row.project}`;
}

function lineMorph(line: DidLine): string {
    return line.batch.kind === "doc" ? `doc:${line.batch.changeids?.[0] ?? ""}` : `${line.batch.kind}:${line.project}`;
}

function morphId(key: string, other: Set<string>): string | undefined {
    return other.has(key) ? undefined : `memory-morph:${key}`;
}

function frame(open: boolean, focused: boolean): string {
    return cn(
        "rounded-[9px]",
        open ? "bg-surface-selected ring-1 ring-accent/70 ring-inset" : focused && "ring-1 ring-edge-strong ring-inset"
    );
}

function WaitingRowView({
    row,
    p,
    open,
    focused,
    layoutId,
    ref,
}: {
    row: WaitingRow;
    p: MemHygieneProject;
    open: boolean;
    focused: boolean;
    layoutId: string | undefined;
    // popLayout measures the leaving row through this ref
    ref?: Ref<HTMLDivElement>;
}) {
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    const applying = useAtomValue(memoryApplyingAtom).includes(row.key);
    const result = useAtomValue(memoryRowResultsAtom)[p.project] ?? null;
    const busy = useAtomValue(memoryBusyAtom);
    const projects = useAtomValue(memoryProjectsAtom) ?? [];
    const b = rowButtons(p, row, { applying, busy, result });
    const st = row.kind === "split" ? splitState(p, applying, result) : null;
    const sub = open && row.kind === "cleanup" ? cleanupDetail(p, projects).opened : row.sub;
    const toggle = () => toggleMemoryOpen(row.key);
    const checkHere = (e: MouseEvent) => {
        e.stopPropagation();
        fireAndForget(() => checkMemory(p.project));
    };
    return (
        <motion.div
            ref={ref}
            data-memory-row={row.key}
            data-open={open || undefined}
            layout="position"
            layoutId={layoutId}
            transition={reduce ? INSTANT : morphTransition}
            variants={cardVariants}
            initial={false}
            animate="animate"
            exit="exit"
            className={frame(open, focused)}
        >
            <div
                onClick={toggle}
                className={cn(
                    "flex min-h-[50px] cursor-pointer items-center gap-3 px-3",
                    !open && "border-b border-edge-faint"
                )}
            >
                <Chip tone={ROW_TONE[row.kind]}>{row.chip}</Chip>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[13px] font-semibold text-primary">{row.title}</span>
                    <span className="text-[12px] text-muted">{sub}</span>
                </span>
                {st?.tag ? (
                    <span
                        className={cn(
                            "flex flex-none items-center gap-1.5 text-[11.5px]",
                            TONE_TEXT[st.state === "applying" ? "none" : "warn"]
                        )}
                    >
                        <Dot tone={st.state === "applying" ? "none" : "warn"} />
                        {st.tag}
                    </span>
                ) : null}
                {open ? null : row.kind === "failed" ? (
                    <button
                        type="button"
                        data-memory-check
                        disabled={busy || p.checking}
                        onClick={checkHere}
                        className={cn(BTN_SMALL, "inline-flex items-center gap-1.5")}
                    >
                        <CheckLabel p={p} label="Check now" />
                    </button>
                ) : (
                    <button type="button" className={BTN_SMALL}>
                        Review
                    </button>
                )}
            </div>
            <PaneReveal open={open}>
                <div className={OPENED_BODY}>
                    {row.kind === "split" && st != null ? <SplitBody p={p} row={row} st={st} b={b} /> : null}
                    {row.kind === "cleanup" ? <CleanupBody p={p} row={row} b={b} /> : null}
                    {row.kind === "doc" ? <DocBody p={p} row={row} b={b} /> : null}
                    {row.kind === "failed" ? <FailedBody p={p} row={row} b={b} /> : null}
                </div>
            </PaneReveal>
        </motion.div>
    );
}

function DigestBody({ line, p }: { line: DidLine; p: MemHygieneProject }) {
    const busy = useAtomValue(memoryBusyAtom);
    const d = digest(line);
    return (
        <div className={cn(OPENED_BODY, "pl-[116px]")}>
            <div className="flex flex-col">
                {d.changes.map((c) => (
                    <div key={c.id} data-memory-item={c.id} className={ITEM_ROW}>
                        <Chip tone={kindTone(c.kind)}>{kindLabel(p, c)}</Chip>
                        <span title={c.title} className={cn(ITEM_TITLE, "text-ink-hi")}>
                            {c.title}
                        </span>
                        {d.undoEach ? (
                            <button
                                type="button"
                                data-memory-undo="change"
                                disabled={busy}
                                onClick={() => fireAndForget(() => undoMemoryBatch(line.project, line.batch.id, c.id))}
                                className={cn(BTN_TEXT, "text-ink-mid")}
                            >
                                Undo
                            </button>
                        ) : null}
                    </div>
                ))}
            </div>
            <div className="flex items-center gap-2">
                <span className="text-[12px] text-muted">{d.index}</span>
                <span className="flex-1" />
                <button
                    type="button"
                    data-memory-undo="all"
                    disabled={busy}
                    onClick={() => undoMemoryLine(line.key)}
                    className={BTN_SECONDARY}
                >
                    {d.undoAll}
                </button>
            </div>
        </div>
    );
}

function Refusal({ line }: { line: DidLine }) {
    const busy = useAtomValue(memoryBusyAtom);
    const block = line.batch.undoblock;
    return (
        <div className={cn(OPENED_BODY, "pl-[116px]")}>
            <StopBox tone="error" text={line.refusal} attrs={{ "data-memory-undo-refused": "" }}>
                {block ? (
                    <button
                        type="button"
                        data-memory-undo="cleanup"
                        disabled={busy}
                        onClick={() => {
                            globalStore.set(memoryRefusedAtom, null);
                            fireAndForget(() => undoMemoryBatch(block.project, block.batchid));
                        }}
                        className={BTN_SECONDARY}
                    >
                        Undo the cleanup
                    </button>
                ) : null}
            </StopBox>
        </div>
    );
}

function DidLineView({
    line,
    p,
    open,
    focused,
    refused,
    layoutId,
    ref,
}: {
    line: DidLine;
    p: MemHygieneProject;
    open: boolean;
    focused: boolean;
    refused: boolean;
    layoutId: string | undefined;
    ref?: Ref<HTMLDivElement>;
}) {
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    const busy = useAtomValue(memoryBusyAtom);
    return (
        <motion.div
            ref={ref}
            data-memory-line={line.key}
            data-open={open || undefined}
            layout="position"
            layoutId={layoutId}
            transition={reduce ? INSTANT : morphTransition}
            variants={cardVariants}
            initial={false}
            animate="animate"
            exit="exit"
            className={frame(open, focused)}
        >
            <div className={cn("flex min-h-[50px] items-center gap-3 px-3", !open && "border-b border-edge-faint")}>
                <span className="flex w-[92px] flex-none items-center gap-1.5 text-[11.5px] text-ink-mid">
                    <Dot tone="ok" />
                    Applied
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[13px] font-semibold text-primary">{line.title}</span>
                    <span className="text-[12px] text-muted">{line.text}</span>
                </span>
                <button
                    type="button"
                    data-memory-see
                    onClick={() => toggleMemoryOpen(line.key)}
                    className={cn(BTN_TEXT, "text-ink-mid")}
                >
                    {open ? `Hide ${line.see}` : `See ${line.see}`}
                </button>
                {open ? null : (
                    <button
                        type="button"
                        data-memory-undo="line"
                        disabled={busy}
                        onClick={() => undoMemoryLine(line.key)}
                        className={BTN_SMALL}
                    >
                        Undo
                    </button>
                )}
            </div>
            <AnimatePresence initial={false}>
                {refused && line.refusal !== "" ? <Refusal key="refusal" line={line} /> : null}
            </AnimatePresence>
            <PaneReveal open={open}>
                <DigestBody line={line} p={p} />
            </PaneReveal>
        </motion.div>
    );
}

// ---- the page ----

function MemoryPage({ projects }: { projects: MemHygieneProject[] }) {
    const open = useAtomValue(memoryOpenAtom);
    const focus = useAtomValue(memoryFocusAtom);
    const refused = useAtomValue(memoryRefusedAtom);
    const rows = waitingRows(projects);
    const lines = didLines(projects, Date.now());
    const byName = new Map(projects.map((p) => [p.project, p]));
    const rowMorphs = new Set(rows.map(rowMorph));
    const lineMorphs = new Set(lines.map(lineMorph));
    // j and k can land on a row or line scrolled out of view
    useEffect(() => {
        if (focus != null) {
            document
                .querySelector(`[data-memory-row="${CSS.escape(focus)}"], [data-memory-line="${CSS.escape(focus)}"]`)
                ?.scrollIntoView({ block: "nearest" });
        }
    }, [focus]);
    return (
        <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto box-border flex w-full max-w-[880px] flex-col gap-[22px] px-5 py-7">
                <div className="flex flex-col gap-1">
                    <h2 className="m-0 text-[18px] font-semibold text-primary">Memory</h2>
                    <span className="text-[12.5px] leading-[1.5] text-muted">{INTRO}</span>
                </div>
                {rows.length === 0 ? (
                    <div data-memory-empty className="px-3 text-[13px] text-secondary">
                        {emptyText(projects)}
                    </div>
                ) : (
                    <section data-memory-waiting aria-label="Waiting for you" className="flex flex-col gap-1.5">
                        <span className={cn(SECTION_HEAD, "px-3 pb-1")}>
                            Waiting for you · <TickNumber value={rows.length} />
                        </span>
                        <div className="relative flex flex-col">
                            {/* popLayout lifts a leaving row out of the flow, so it travels to its did line rather
                                than below a gap that then closes in one frame (moment 2 reflow) */}
                            <AnimatePresence initial={false} mode="popLayout">
                                {rows.map((r) => (
                                    <WaitingRowView
                                        key={r.key}
                                        row={r}
                                        p={byName.get(r.project)!}
                                        open={open === r.key}
                                        focused={focus === r.key}
                                        layoutId={morphId(rowMorph(r), lineMorphs)}
                                    />
                                ))}
                            </AnimatePresence>
                        </div>
                    </section>
                )}
                {lines.length > 0 ? (
                    <section data-memory-did aria-label="Arc did this week" className="flex flex-col gap-1.5">
                        <span className={cn(SECTION_HEAD, "px-3 pb-1")}>Arc did this week</span>
                        <div className="relative flex flex-col">
                            <AnimatePresence initial={false} mode="popLayout">
                                {lines.map((l) => (
                                    <DidLineView
                                        key={l.key}
                                        line={l}
                                        p={byName.get(l.project)!}
                                        open={open === l.key}
                                        focused={focus === l.key}
                                        refused={refused === l.key}
                                        layoutId={morphId(lineMorph(l), rowMorphs)}
                                    />
                                ))}
                            </AnimatePresence>
                        </div>
                    </section>
                ) : null}
            </div>
        </div>
    );
}

export function MemoryTab() {
    const projects = useAtomValue(memoryProjectsAtom);
    const error = useAtomValue(memoryErrorAtom);
    // re-read on every visit, and on every state write while the tab is open. a failure from an earlier
    // visit must not leave its banner over fresh data.
    useEffect(() => {
        globalStore.set(memoryErrorAtom, null);
        fireAndForget(loadMemory);
        return subscribeMemory();
    }, []);
    const bindings = useMemo(() => buildMemoryBindings(), []);
    useKeybindings(bindings);
    const listFailed = projects == null && error != null;
    return (
        <div className="flex min-w-0 flex-1 flex-col">
            {error && !listFailed ? (
                <div
                    role="alert"
                    data-memory-error
                    className="flex-none border-b border-error/30 bg-error/10 px-5 py-2 text-[12.5px] text-error-soft"
                >
                    {error}
                </div>
            ) : null}
            {listFailed ? (
                <div
                    role="alert"
                    data-memory-error
                    className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center text-[13px] text-error-soft"
                >
                    <span>{error}</span>
                    <button
                        type="button"
                        data-memory-retry
                        onClick={() => {
                            globalStore.set(memoryErrorAtom, null);
                            fireAndForget(loadMemory);
                        }}
                        className={BTN_SECONDARY}
                    >
                        Retry
                    </button>
                </div>
            ) : projects == null ? (
                <div className="flex flex-1 items-center justify-center text-[13px] text-muted">Reading…</div>
            ) : (
                <MemoryPage projects={projects} />
            )}
        </div>
    );
}
