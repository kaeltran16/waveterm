// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Setup surface's Memory tab: a list of what waits for the user (a split, a cleanup, a move into a repo doc,
// a failed check) and what Arc did this week, beside a detail pane showing the selected one with its actions.
// All derivation is in memorymodel.ts, the atoms, RPCs and key actions in memorystore.ts.

import { barFillClass, cardVariants, errorNudge, morphTransition } from "@/app/element/motiontokens";
import { TickNumber } from "@/app/element/ticknumber";
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { buildMemoryBindings } from "@/app/store/keybindings/bindings";
import { useKeybindings } from "@/app/store/keybindings/store";
import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Check, Eraser, FileText, GitFork, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion, type Transition } from "motion/react";
import { useEffect, useMemo, type ReactNode, type Ref } from "react";
import {
    cleanupDetail,
    didLines,
    diffLabel,
    digest,
    emptyText,
    kindLabel,
    kindTone,
    lineMorphKey,
    resolveSelection,
    rowButtons,
    rowMorphKey,
    splitCounts,
    splitList,
    splitState,
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
    leaveOutMemory,
    loadMemory,
    memoryApplyingAtom,
    memoryBusyAtom,
    memoryErrorAtom,
    memoryProjectsAtom,
    memoryRefusedAtom,
    memoryRowResultsAtom,
    memorySelectedAtom,
    runRowButton,
    selectMemory,
    subscribeMemory,
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
// the list rows as on the Instructions tab
const ROW = "flex w-full items-start gap-2.5 rounded border-0 px-2.5 py-[9px] text-left";
const ROW_SELECTED = "bg-surface-selected text-primary ring-1 ring-edge-strong ring-inset";
const ROW_IDLE = "cursor-pointer bg-transparent text-secondary hover:bg-surface-hover";
const ICON_TINT = {
    accent: "bg-accentbg text-accent-soft",
    error: "bg-error/10 text-error-soft",
    success: "bg-success/12 text-success",
};
const ROW_ICON: Record<RowKind, { icon: LucideIcon; tint: string }> = {
    split: { icon: GitFork, tint: ICON_TINT.accent },
    cleanup: { icon: Eraser, tint: ICON_TINT.error },
    doc: { icon: FileText, tint: ICON_TINT.accent },
    failed: { icon: TriangleAlert, tint: ICON_TINT.error },
};
// a bordered box of items, which scrolls itself where it fills the detail's body
const ITEM_BOX = "flex flex-col overflow-y-auto rounded border border-edge-mid bg-surface";
const ITEM_ROW = "flex min-h-8 flex-none items-center gap-2 border-b border-edge-faint pl-3 pr-1.5 last:border-b-0";
const ITEM_TITLE = "min-w-0 flex-1 truncate text-[12.5px]";
const BAND =
    "flex h-[26px] flex-none items-center gap-2 border-b border-edge-faint bg-background px-3 font-mono text-[10.5px] font-bold uppercase tracking-[.1em] text-muted";

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

// a stop or a refusal (moment 13). Callers mount it under an AnimatePresence initial={false} inside the detail,
// which is keyed by the shown item, so it shakes once when it appears after the user's action and not when
// its item is selected.
function StopBox({
    tone,
    text,
    attrs,
    children,
}: {
    tone: keyof typeof STOP_TONE;
    text: string;
    attrs: Record<string, string>;
    children?: ReactNode;
}) {
    return (
        <motion.div
            role="status"
            {...attrs}
            variants={errorNudge}
            initial="initial"
            animate="animate"
            className={cn("flex flex-none items-center gap-3 rounded border px-3.5 py-2.5", STOP_TONE[tone].box)}
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

// ---- a waiting row's state and buttons ----

interface RowView {
    p: MemHygieneProject;
    row: WaitingRow;
    b: RowButtons;
    st: SplitState | null;
}

function useRowView(row: WaitingRow, p: MemHygieneProject): RowView {
    const applying = useAtomValue(memoryApplyingAtom).includes(row.key);
    const result = useAtomValue(memoryRowResultsAtom)[p.project] ?? null;
    const busy = useAtomValue(memoryBusyAtom);
    return {
        p,
        row,
        b: rowButtons(p, row, { applying, busy, result }),
        st: row.kind === "split" ? splitState(p, applying, result) : null,
    };
}

// a split's "N of M here" or "Applying", on its list row and in the detail header
function SplitTag({ st }: { st: SplitState | null }) {
    if (!st?.tag) {
        return null;
    }
    const tone = st.state === "applying" ? "none" : "warn";
    return (
        <span data-memory-tag className={cn("flex flex-none items-center gap-1.5 text-[11.5px]", TONE_TEXT[tone])}>
            <Dot tone={tone} />
            {st.tag}
        </span>
    );
}

function CheckLabel({ p, label }: { p: MemHygieneProject; label: string }) {
    return (
        <>
            <RefreshCw size={13} className={cn(p.checking && "animate-spin motion-reduce:animate-none")} />
            {p.checking ? "Checking…" : label}
        </>
    );
}

function RowActions({ v }: { v: RowView }) {
    const { p, row, b } = v;
    const check = b.primary?.action === "check";
    return (
        <>
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
        </>
    );
}

// ---- a split ----

function SplitItem({ p, c }: { p: MemHygieneProject; c: MemChange }) {
    const busy = useAtomValue(memoryBusyAtom);
    const left = c.status === "kept";
    return (
        <div role="listitem" data-memory-item={c.id} className={ITEM_ROW}>
            <span title={c.title} className={cn(ITEM_TITLE, left ? "text-muted" : "text-ink-hi")}>
                {c.title}
            </span>
            {left ? <span className="flex-none text-[11.5px] text-muted">Left out</span> : null}
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

function SplitBody({ v }: { v: RowView }) {
    const { p, st } = v;
    if (st == null) {
        return null;
    }
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
                    />
                ) : null}
            </AnimatePresence>
            {st.state === "applying" ? <SplitProgress p={p} text={st.text} /> : null}
            {st.state === "open" || st.state === "partial" ? <SplitReview p={p} /> : null}
        </>
    );
}

// moment 11: the fill grows by what each re-list brought over
function SplitProgress({ p, text }: { p: MemHygieneProject; text: string }) {
    const n = splitCounts(p);
    const pct = n.total === 0 ? 0 : Math.round((100 * n.here) / n.total);
    return (
        <div data-memory-progress className="flex flex-none flex-col gap-1.5">
            <span className="text-[12.5px] text-secondary">{text}</span>
            <span className="block h-1 overflow-hidden rounded-full bg-edge-mid">
                <span className={cn("block h-1 bg-accent", barFillClass)} style={{ width: `${pct}%` }} />
            </span>
        </div>
    );
}

function SplitReview({ p }: { p: MemHygieneProject }) {
    return (
        <div role="list" data-memory-split className={cn(ITEM_BOX, "min-h-0 flex-1")}>
            {splitList(p).map((g) => (
                <div key={g.label} data-memory-group className="flex flex-col">
                    <div className={BAND}>
                        {g.label}
                        <span className="font-medium normal-case tracking-normal">
                            · {g.count.toLocaleString("en-US")}
                        </span>
                    </div>
                    {g.changes.map((c) => (
                        <SplitItem key={c.id} p={p} c={c} />
                    ))}
                </div>
            ))}
        </div>
    );
}

// ---- a cleanup, a doc move, a failed check ----

function CleanupBody({ p }: { p: MemHygieneProject }) {
    const projects = useAtomValue(memoryProjectsAtom) ?? [];
    const busy = useAtomValue(memoryBusyAtom);
    const d = cleanupDetail(p, projects);
    return (
        <>
            <p data-memory-body className="m-0 flex-none text-[12.5px] leading-[1.5] text-secondary">
                {d.body}
            </p>
            <div className={cn(ITEM_BOX, "min-h-0 flex-initial")}>
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
        </>
    );
}

function DiffBlock({ p, diff }: { p: MemHygieneProject; diff: MemDiff }) {
    return (
        <div data-memory-diff className="flex-none overflow-hidden rounded border border-edge-mid bg-surface-code">
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

function DocBody({ p, row }: { p: MemHygieneProject; row: WaitingRow }) {
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
                    className="flex flex-none items-start gap-2 text-[12px] leading-[1.5] text-secondary"
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
            {c.note ? <p className="m-0 flex-none text-[11.5px] leading-[1.5] text-muted">{c.note}</p> : null}
        </>
    );
}

// ---- the detail ----

function DetailHeader({
    title,
    sub,
    tag,
    actions,
}: {
    title: string;
    sub: string;
    tag?: ReactNode;
    actions: ReactNode;
}) {
    return (
        <div className="flex flex-none items-center gap-3.5">
            <div className="flex min-w-0 flex-col gap-[3px]">
                <div data-memory-title className="text-[15px] font-semibold text-primary [overflow-wrap:anywhere]">
                    {title}
                </div>
                <div data-memory-sub className="text-[12px] text-muted">
                    {sub}
                </div>
            </div>
            {tag}
            <span className="flex-1" />
            {actions}
        </div>
    );
}

// the body scrolls, and a box that fills it (the split's list) scrolls itself
function DetailBody({ children }: { children: ReactNode }) {
    return <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">{children}</div>;
}

function RowDetail({ row, p }: { row: WaitingRow; p: MemHygieneProject }) {
    const projects = useAtomValue(memoryProjectsAtom) ?? [];
    const v = useRowView(row, p);
    const sub = row.kind === "cleanup" ? cleanupDetail(p, projects).opened : row.sub;
    return (
        <>
            <DetailHeader title={row.title} sub={sub} tag={<SplitTag st={v.st} />} actions={<RowActions v={v} />} />
            <DetailBody>
                {row.kind === "split" ? <SplitBody v={v} /> : null}
                {row.kind === "cleanup" ? <CleanupBody p={p} /> : null}
                {row.kind === "doc" ? <DocBody p={p} row={row} /> : null}
                {row.kind === "failed" ? (
                    <p className="m-0 flex-none text-[12.5px] leading-[1.5] text-secondary">{p.lasterror}</p>
                ) : null}
            </DetailBody>
        </>
    );
}

function LineDetail({ line, p }: { line: DidLine; p: MemHygieneProject }) {
    const busy = useAtomValue(memoryBusyAtom);
    const refused = useAtomValue(memoryRefusedAtom) === line.key && line.refusal !== "";
    const block = line.batch.undoblock;
    const d = digest(line);
    return (
        <>
            <DetailHeader
                title={line.title}
                sub={line.text}
                actions={
                    <button
                        type="button"
                        data-memory-undo="all"
                        disabled={busy}
                        onClick={() => undoMemoryLine(line.key)}
                        className={BTN_SECONDARY}
                    >
                        {d.undoAll}
                    </button>
                }
            />
            <DetailBody>
                <AnimatePresence initial={false}>
                    {refused ? (
                        <StopBox
                            key="refused"
                            tone="error"
                            text={line.refusal}
                            attrs={{ "data-memory-undo-refused": "" }}
                        >
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
                    ) : null}
                </AnimatePresence>
                <div className={cn(ITEM_BOX, "min-h-0 flex-initial")}>
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
                                    onClick={() =>
                                        fireAndForget(() => undoMemoryBatch(line.project, line.batch.id, c.id))
                                    }
                                    className={cn(BTN_TEXT, "text-ink-mid")}
                                >
                                    Undo
                                </button>
                            ) : null}
                        </div>
                    ))}
                </div>
                {d.index ? (
                    <span data-memory-index className="flex-none text-[12px] text-muted">
                        {d.index}
                    </span>
                ) : null}
            </DetailBody>
        </>
    );
}

function Intro() {
    return (
        <div data-memory-intro className="flex flex-none items-start gap-2.5 border-t border-edge-faint pt-2.5">
            <span className={cn(SECTION_HEAD, "flex-none pt-0.5")}>How it works</span>
            <span className="text-[12px] leading-[1.5] text-secondary">{INTRO}</span>
        </div>
    );
}

// ---- the list ----

function IconBox({ icon: Icon, tint, strokeWidth = 2 }: { icon: LucideIcon; tint: string; strokeWidth?: number }) {
    return (
        <span className={cn("flex h-5 w-5 flex-none items-center justify-center rounded-[5px]", tint)}>
            <Icon size={13} strokeWidth={strokeWidth} />
        </span>
    );
}

// a waiting row and the did line its apply leaves are one element changing sections (moment 17), unless both
// show at once (a cleanup batch from an earlier Clear while more removals wait), where one id would name two
function morphId(key: string, other: Set<string>): string | undefined {
    return other.has(key) ? undefined : `memory-morph:${key}`;
}

function ListRow({
    attrs,
    icon,
    title,
    sub,
    tag,
    selected,
    layoutId,
    onSelect,
    ref,
}: {
    attrs: Record<string, string>;
    icon: ReactNode;
    title: string;
    sub: string;
    tag?: ReactNode;
    selected: boolean;
    layoutId: string | undefined;
    onSelect: () => void;
    // popLayout measures the leaving row through this ref
    ref?: Ref<HTMLButtonElement>;
}) {
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    return (
        <motion.button
            ref={ref}
            type="button"
            {...attrs}
            aria-current={selected ? "true" : undefined}
            onClick={onSelect}
            layout="position"
            layoutId={layoutId}
            transition={reduce ? INSTANT : morphTransition}
            variants={cardVariants}
            initial={false}
            animate="animate"
            exit="exit"
            className={cn(ROW, selected ? ROW_SELECTED : ROW_IDLE)}
        >
            {icon}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span data-memory-title className="text-[13px] font-semibold [overflow-wrap:anywhere]">
                    {title}
                </span>
                <span data-memory-sub className="text-[11.5px] leading-[1.4] text-muted">
                    {sub}
                </span>
                {tag}
            </span>
        </motion.button>
    );
}

function WaitingListRow({
    row,
    p,
    selected,
    layoutId,
    ref,
}: {
    row: WaitingRow;
    p: MemHygieneProject;
    selected: boolean;
    layoutId: string | undefined;
    ref?: Ref<HTMLButtonElement>;
}) {
    const v = useRowView(row, p);
    const { icon, tint } = ROW_ICON[row.kind];
    return (
        <ListRow
            ref={ref}
            attrs={{ "data-memory-row": row.key }}
            icon={<IconBox icon={icon} tint={tint} />}
            title={row.title}
            sub={`${row.chip} · ${row.sub}`}
            tag={
                v.st?.tag ? (
                    <span className="mt-[3px] flex">
                        <SplitTag st={v.st} />
                    </span>
                ) : null
            }
            selected={selected}
            layoutId={layoutId}
            onSelect={() => selectMemory(row.key)}
        />
    );
}

function DidListRow({
    line,
    selected,
    layoutId,
    ref,
}: {
    line: DidLine;
    selected: boolean;
    layoutId: string | undefined;
    ref?: Ref<HTMLButtonElement>;
}) {
    return (
        <ListRow
            ref={ref}
            attrs={{ "data-memory-line": line.key }}
            icon={<IconBox icon={Check} tint={ICON_TINT.success} strokeWidth={2.4} />}
            title={line.title}
            sub={`Applied · ${line.text}`}
            selected={selected}
            layoutId={layoutId}
            onSelect={() => selectMemory(line.key)}
        />
    );
}

// ---- the page ----

function MemoryPage({ projects }: { projects: MemHygieneProject[] }) {
    const selected = useAtomValue(memorySelectedAtom);
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    const now = Date.now();
    const rows = waitingRows(projects);
    const lines = didLines(projects, now);
    const shown = resolveSelection(projects, now, selected);
    const byName = new Map(projects.map((p) => [p.project, p]));
    const rowMorphs = new Set(rows.map(rowMorphKey));
    const lineMorphs = new Set(lines.map(lineMorphKey));
    const shownRow = rows.find((r) => r.key === shown);
    const shownLine = shownRow == null ? lines.find((l) => l.key === shown) : undefined;
    // j and k can land on a row or line scrolled out of view
    useEffect(() => {
        if (shown != null) {
            document
                .querySelector(`[data-memory-row="${CSS.escape(shown)}"], [data-memory-line="${CSS.escape(shown)}"]`)
                ?.scrollIntoView({ block: "nearest" });
        }
    }, [shown]);
    return (
        <div className="flex min-h-0 flex-1">
            <nav
                data-memory-list
                aria-label="Memory decisions"
                className="flex w-[320px] flex-none flex-col gap-1 overflow-y-auto border-r border-border bg-surface px-2.5 py-3.5"
            >
                {/* one group, so a re-render of any row (busy, applying) also measures the did section and every line */}
                <LayoutGroup>
                    {rows.length === 0 ? (
                        <div data-memory-empty className="px-2 pb-1.5 text-[12.5px] leading-[1.5] text-secondary">
                            {emptyText(projects)}
                        </div>
                    ) : (
                        <section data-memory-waiting aria-label="Waiting for you" className="flex flex-col gap-1">
                            <span className={cn(SECTION_HEAD, "px-2 pb-1.5")}>
                                Waiting for you · <TickNumber value={rows.length} />
                            </span>
                            <div className="relative flex flex-col gap-1">
                                {/* popLayout lifts a leaving row out of the flow, so it travels to its did line rather
                                than below a gap that then closes in one frame (moment 2 reflow) */}
                                <AnimatePresence initial={false} mode="popLayout">
                                    {rows.map((r) => (
                                        <WaitingListRow
                                            key={r.key}
                                            row={r}
                                            p={byName.get(r.project)!}
                                            selected={shown === r.key}
                                            layoutId={morphId(rowMorphKey(r), lineMorphs)}
                                        />
                                    ))}
                                </AnimatePresence>
                            </div>
                        </section>
                    )}
                    {lines.length > 0 ? (
                        // moves with the rows above it (moment 17 with 2): a section that snapped to its new place
                        // would sit under rows still travelling to theirs
                        <motion.section
                            data-memory-did
                            aria-label="Arc did this week"
                            layout="position"
                            transition={reduce ? INSTANT : morphTransition}
                            className="flex flex-col gap-1"
                        >
                            <span className={cn(SECTION_HEAD, "px-2 pb-1.5 pt-3.5")}>Arc did this week</span>
                            <div className="relative flex flex-col gap-1">
                                <AnimatePresence initial={false} mode="popLayout">
                                    {lines.map((l) => (
                                        <DidListRow
                                            key={l.key}
                                            line={l}
                                            selected={shown === l.key}
                                            layoutId={morphId(lineMorphKey(l), rowMorphs)}
                                        />
                                    ))}
                                </AnimatePresence>
                            </div>
                        </motion.section>
                    ) : null}
                </LayoutGroup>
            </nav>
            {/* keyed by the shown item: a selection swaps the detail at once, and its stop boxes mount still */}
            <main
                key={shown ?? ""}
                data-memory-detail={shown ?? ""}
                className="box-border flex min-w-0 flex-1 flex-col gap-3 px-5 pb-5 pt-4"
            >
                {shownRow != null ? <RowDetail row={shownRow} p={byName.get(shownRow.project)!} /> : null}
                {shownLine != null ? <LineDetail line={shownLine} p={byName.get(shownLine.project)!} /> : null}
                {shown == null ? <div className="flex-1" /> : null}
                <Intro />
            </main>
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
