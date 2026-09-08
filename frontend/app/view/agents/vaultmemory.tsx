// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Vault's memory collection (Wave-vault-tab.dc.html): three independent panes, not one page.
//
// Why three: at real scale the vault holds hundreds of saved notes beside a ten-item triage pass, and
// one page-length scroll cannot serve both — reaching Saved means scrolling past a queue you are
// mid-way through. So the queue is height-capped and scrolls itself, upkeep is a fixed row that
// expands into its own capped pane, and Saved takes whatever height is left and scrolls on its own.

import { MOTION, cardVariants, paneReveal, reflowProps, type ReflowProps } from "@/app/element/motiontokens";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Copy, FolderOpen, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo } from "react";
import { MarkdownMessage } from "./markdownmessage";
import { MemGraph } from "./memgraph";
import {
    confirmDeleteNote,
    confirmPruneAllNotes,
    dismissAllPending,
    dismissPending,
    keepAllPending,
    keepPending,
    memArchivedAtom,
    memNotesAtom,
    memPendingAtom,
    memPruneAtom,
    memSearchAtom,
    memSelectedIdAtom,
    memViewAtom,
    prune,
    restoreArchived,
    selectNote,
    selectPending,
    takePendingMemoryFocus,
} from "./memstore";
import { groupByScope, reasonMeta, relativeAge, typeMeta, type MemNote } from "./memtypes";
import { RollingCount } from "./rollingcount";
import {
    noteTally,
    vaultCursorAtom,
    vaultExpandedAtom,
    vaultFocusAtom,
    vaultQueueOpenAtom,
    vaultReaderAtom,
    vaultScopeAtom,
    vaultStatusAtom,
    vaultTallyAtom,
    vaultUpkeepAtom,
} from "./vaultstore";
import { filterQueue, isLong, scopeChips, scopeLabel, wordCount, type QueueItem } from "./vaulttriage";

// The queue never takes more than this, whatever its length: Saved has to stay reachable without
// scrolling a triage pass out of the way.
const QUEUE_MAX_H = "max-h-[44vh]";
const UPKEEP_MAX_H = "max-h-[30vh]";

function toQueueItem(p: MemoryPendingNote): QueueItem {
    return { path: p.path, scope: p.scope || "shared", source: p.source, title: p.title, body: p.body };
}

function resolveCandidate(path: string, title: string, keep: boolean): void {
    noteTally(keep);
    globalStore.set(vaultStatusAtom, `${keep ? "Kept" : "Dismissed"} ${title}`);
    fireAndForget(() => (keep ? keepPending(path) : dismissPending(path)));
}

// ---- pane 1: review queue ----

function QueueRow({
    p,
    expanded,
    atCursor,
    index,
}: {
    p: MemoryPendingNote;
    expanded: boolean;
    atCursor: boolean;
    index: number;
}) {
    const m = typeMeta(p.type);
    const age = relativeAge(p.capturedat);
    const long = isLong(p.body);
    const toggle = () => {
        globalStore.set(vaultCursorAtom, index);
        globalStore.set(vaultFocusAtom, "queue");
        globalStore.set(vaultExpandedAtom, expanded ? null : p.path);
        selectPending(p.path);
    };
    if (!expanded) {
        return (
            <div
                onClick={toggle}
                data-vault-queue-row={p.path}
                className={cn(
                    "grid h-[34px] cursor-pointer grid-cols-[132px_minmax(0,1fr)_58px_62px] items-center gap-[14px] border-b border-edge-faint px-[24px]",
                    atCursor ? "bg-surface-hover" : "hover:bg-surface/60"
                )}
            >
                <span title={p.scope} className="truncate font-mono text-[10.5px] font-medium text-ink-faint">
                    {scopeLabel(p.scope)}
                </span>
                <span className="truncate text-[12.5px] text-ink-hi">{p.title}</span>
                <span className="text-right font-mono text-[10.5px] text-ink-faint">{age}</span>
                <span className="flex justify-end gap-[6px]">
                    <button
                        title="Keep"
                        aria-label="Keep"
                        onClick={(e) => {
                            e.stopPropagation();
                            resolveCandidate(p.path, p.title, true);
                        }}
                        className="flex h-[20px] w-[24px] items-center justify-center rounded-[5px] border border-success/30 font-mono text-[10px] font-bold text-success hover:bg-success/20"
                    >
                        ↵
                    </button>
                    <button
                        title="Dismiss"
                        aria-label="Dismiss"
                        onClick={(e) => {
                            e.stopPropagation();
                            resolveCandidate(p.path, p.title, false);
                        }}
                        className="flex h-[20px] w-[24px] items-center justify-center rounded-[5px] border border-edge-mid font-mono text-[10px] font-bold text-ink-faint hover:border-error/40 hover:text-error"
                    >
                        ✕
                    </button>
                </span>
            </div>
        );
    }
    return (
        <div
            onClick={toggle}
            data-vault-queue-row={p.path}
            className="cursor-pointer border-b border-edge-faint bg-surface shadow-[inset_2px_0_0_0_var(--color-accent)]"
        >
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                className="flex flex-col gap-[11px] px-[24px] pb-[14px] pt-[12px]"
            >
                <div className="flex items-center gap-[10px]">
                    <span
                        className={cn(
                            "min-w-[66px] rounded-[5px] px-[7px] py-[2px] text-center font-mono text-[9px] font-semibold uppercase tracking-[0.05em]",
                            m.pillClass,
                            m.tintClass
                        )}
                    >
                        {m.label}
                    </span>
                    <span title={p.scope} className="font-mono text-[10.5px] font-medium text-accent-soft">
                        {scopeLabel(p.scope)}
                    </span>
                    <span className="font-mono text-[10.5px] text-ink-faint">
                        {p.source} · {age}
                    </span>
                </div>
                <div className="relative max-h-[150px] overflow-hidden">
                    <div className="max-w-[82ch] text-[14px] leading-[1.6] text-ink-hi">
                        <MarkdownMessage text={p.body} />
                    </div>
                    {long && (
                        <div className="absolute inset-x-0 bottom-0 h-[56px] bg-gradient-to-b from-transparent to-surface" />
                    )}
                </div>
                <div className="flex items-center gap-[9px]">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            resolveCandidate(p.path, p.title, true);
                        }}
                        className="rounded-[7px] bg-accent px-[20px] py-[7px] text-[12.5px] font-semibold text-background hover:bg-accenthover"
                    >
                        Keep <span className="font-mono text-[10px] opacity-75">↵</span>
                    </button>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            resolveCandidate(p.path, p.title, false);
                        }}
                        className="rounded-[7px] border border-edge-mid px-[18px] py-[7px] text-[12.5px] font-semibold text-ink-mid hover:text-primary"
                    >
                        Dismiss <span className="font-mono text-[10px] opacity-75">x</span>
                    </button>
                    {long && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                globalStore.set(vaultReaderAtom, { kind: "pending", path: p.path });
                            }}
                            className="rounded-[7px] border border-accent/40 bg-accent/15 px-[16px] py-[7px] text-[12.5px] font-semibold text-accent-soft hover:bg-accentbg"
                        >
                            Read all · {wordCount(p.body)} words{" "}
                            <span className="font-mono text-[10px] opacity-75">o</span>
                        </button>
                    )}
                    <div className="flex-1" />
                    <span className="font-mono text-[11px] text-ink-faint">j/k move · space collapse</span>
                </div>
            </motion.div>
        </div>
    );
}

function ReviewQueue() {
    const pending = useAtomValue(memPendingAtom);
    const open = useAtomValue(vaultQueueOpenAtom);
    const scope = useAtomValue(vaultScopeAtom);
    const search = useAtomValue(memSearchAtom);
    const cursor = useAtomValue(vaultCursorAtom);
    const expanded = useAtomValue(vaultExpandedAtom);
    const tally = useAtomValue(vaultTallyAtom);
    const tallyLine = `${tally.kept} kept · ${tally.dismissed} dismissed this session`;

    if (pending.length === 0) {
        return (
            <motion.div
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                className="flex flex-none items-center gap-[10px] border-b border-edge-faint bg-success/15 px-[24px] py-[8px]"
            >
                <span className="h-[6px] w-[6px] rounded-full bg-success" />
                <span className="text-[12.5px] font-semibold text-primary">Queue clear</span>
                <span className="text-[11.5px] text-ink-mid">{tallyLine}</span>
            </motion.div>
        );
    }

    const items = pending.map(toQueueItem);
    const visible = filterQueue(items, scope, search);
    const visiblePaths = new Set(visible.map((v) => v.path));
    const rows = pending.filter((p) => visiblePaths.has(p.path));
    const chips = scopeChips(items);

    return (
        <>
            <div className="flex flex-none flex-wrap items-center gap-[10px] border-b border-edge-faint bg-askingbg px-[24px] py-[9px] shadow-[inset_3px_0_0_0_var(--color-asking)]">
                <button
                    onClick={() => globalStore.set(vaultQueueOpenAtom, !open)}
                    aria-expanded={open}
                    className="flex items-center gap-[7px] text-[13px] font-bold text-primary"
                >
                    <span className="font-mono text-[10px] text-asking">{open ? "▾" : "▸"}</span>
                    <RollingCount value={pending.length} /> to review
                </button>
                <span className="text-[11.5px] text-ink-mid">harvested from your agents</span>
                <div className="flex-1" />
                <div className="flex flex-wrap gap-[6px]">
                    {chips.map((c) => (
                        <button
                            key={c.key}
                            onClick={() => {
                                globalStore.set(vaultScopeAtom, c.key);
                                globalStore.set(vaultCursorAtom, 0);
                                globalStore.set(vaultFocusAtom, "queue");
                            }}
                            className={cn(
                                "rounded-full border px-[10px] py-[2px] font-mono text-[10.5px] font-medium",
                                scope === c.key
                                    ? "border-asking bg-asking/15 text-asking"
                                    : "border-asking/32 text-ink-mid hover:text-primary"
                            )}
                        >
                            {c.label} {c.count}
                        </button>
                    ))}
                </div>
                <span className="mx-[4px] h-[16px] w-px bg-edge-mid" />
                <button
                    onClick={() => {
                        noteTally(true, pending.length);
                        globalStore.set(vaultStatusAtom, `Kept ${pending.length} candidates`);
                        fireAndForget(keepAllPending);
                    }}
                    className="rounded-[7px] border border-success/30 bg-success/15 px-[12px] py-[4px] text-[11.5px] font-semibold text-success hover:bg-success/25"
                >
                    Keep all
                </button>
                <button
                    onClick={() => {
                        noteTally(false, pending.length);
                        globalStore.set(vaultStatusAtom, `Dismissed ${pending.length} candidates`);
                        fireAndForget(dismissAllPending);
                    }}
                    className="rounded-[7px] border border-edge-mid px-[12px] py-[4px] text-[11.5px] font-semibold text-ink-mid hover:border-edge-strong hover:text-primary"
                >
                    Dismiss all
                </button>
            </div>
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        key="queue"
                        variants={paneReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="flex flex-none flex-col overflow-hidden"
                    >
                        <div className={cn("flex-none overflow-auto border-b border-edge-faint", QUEUE_MAX_H)}>
                            {/* popLayout so a resolved row leaves the flow immediately and the rest slide up
                                into the gap — the direct child has to be the motion element for that to work */}
                            <AnimatePresence mode="popLayout" initial={false}>
                                {rows.map((p, i) => (
                                    <motion.div
                                        key={p.path}
                                        layout
                                        variants={cardVariants}
                                        initial="initial"
                                        animate="animate"
                                        exit="exit"
                                        transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                                    >
                                        <QueueRow
                                            p={p}
                                            index={i}
                                            expanded={expanded === p.path}
                                            atCursor={i === Math.min(cursor, rows.length - 1)}
                                        />
                                    </motion.div>
                                ))}
                            </AnimatePresence>
                        </div>
                        <div className="flex flex-none items-center gap-[10px] border-b border-edge-faint px-[24px] py-[6px] font-mono text-[11px] text-ink-faint">
                            <span>j/k move · space expand · ↵ keep · x dismiss · o read</span>
                            <div className="flex-1" />
                            <span>{tallyLine}</span>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
}

// ---- pane 2: upkeep ----

function UpkeepToggle({
    kind,
    label,
    count,
    hint,
    countClass,
}: {
    kind: "cleanup" | "archived";
    label: string;
    count: number;
    hint: string;
    countClass: string;
}) {
    const open = useAtomValue(vaultUpkeepAtom);
    return (
        <button
            onClick={() => globalStore.set(vaultUpkeepAtom, open === kind ? null : kind)}
            aria-expanded={open === kind}
            data-vault-upkeep={kind}
            className="flex items-center gap-[9px] bg-background px-[24px] py-[8px] text-left hover:bg-surface"
        >
            <span className="font-mono text-[10px] text-ink-faint">{open === kind ? "▾" : "▸"}</span>
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-mid">{label}</span>
            <span className={cn("rounded-full px-[8px] py-px font-mono text-[10.5px] font-semibold", countClass)}>
                <RollingCount value={count} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">{hint}</span>
        </button>
    );
}

function UpkeepRow({
    reason,
    title,
    age,
    actLabel,
    onAct,
}: {
    reason: string;
    title: string;
    age: string;
    actLabel: string;
    onAct: () => void;
}) {
    const r = reasonMeta(reason);
    return (
        <div className="grid h-[32px] grid-cols-[88px_minmax(0,1fr)_54px_78px] items-center gap-[12px] border-b border-edge-faint px-[24px]">
            <span
                className={cn(
                    "rounded-[5px] px-[6px] py-px text-center font-mono text-[9px] font-semibold uppercase tracking-[0.05em]",
                    r.textClass,
                    r.bgClass
                )}
            >
                {reason}
            </span>
            <span className="truncate font-mono text-[12px] font-medium text-ink-hi">{title}</span>
            <span className="text-right font-mono text-[10.5px] text-ink-faint">{age}</span>
            <button
                onClick={onAct}
                className="rounded-[5px] border border-edge-mid py-[2px] text-[10.5px] font-semibold text-ink-mid hover:border-edge-strong hover:text-primary"
            >
                {actLabel}
            </button>
        </div>
    );
}

function Upkeep() {
    const cleanup = useAtomValue(memPruneAtom);
    const archived = useAtomValue(memArchivedAtom);
    const open = useAtomValue(vaultUpkeepAtom);

    // The creature's vault row escorts here; the panes are collapsed by default, so without this the
    // escort lands on a header the user still has to find and open.
    useEffect(() => {
        if (takePendingMemoryFocus() != null) {
            globalStore.set(vaultUpkeepAtom, "cleanup");
        }
    }, []);

    return (
        <>
            <div className="grid flex-none grid-cols-2 gap-px border-b border-edge-faint bg-edge-faint">
                <UpkeepToggle
                    kind="cleanup"
                    label="To clean up"
                    count={cleanup.length}
                    countClass="bg-error/12 text-error"
                    hint="the distiller flags outdated saved notes — you remove them"
                />
                <UpkeepToggle
                    kind="archived"
                    label="Archived"
                    count={archived.length}
                    countClass="bg-ink-mid/12 text-ink-mid"
                    hint="auto-archived by the gardener — dormant, fully recoverable"
                />
            </div>
            <AnimatePresence mode="wait" initial={false}>
                {open && (
                    <motion.div
                        key={open}
                        variants={paneReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className={cn("flex-none overflow-auto border-b border-edge-faint bg-surface", UPKEEP_MAX_H)}
                    >
                        <div className="flex items-center gap-[10px] border-b border-edge-faint px-[24px] py-[7px]">
                            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                                {open === "cleanup"
                                    ? "Flagged by the distiller"
                                    : "Archived by the gardener — all restorable"}
                            </span>
                            <div className="flex-1" />
                            {open === "cleanup" && cleanup.length > 0 && (
                                <button
                                    onClick={() => confirmPruneAllNotes(cleanup.length)}
                                    className="rounded-[7px] border border-error/45 px-[11px] py-[3px] text-[11px] font-semibold text-error hover:bg-error/10"
                                >
                                    Clean up all
                                </button>
                            )}
                        </div>
                        <AnimatePresence mode="popLayout" initial={false}>
                            {(open === "cleanup"
                                ? cleanup.map((c) => ({
                                      path: c.path,
                                      reason: c.reason,
                                      title: c.title,
                                      age: "",
                                      actLabel: "Remove",
                                      onAct: () => fireAndForget(() => prune(c.path, c.reason)),
                                  }))
                                : archived.map((a) => ({
                                      path: a.path,
                                      reason: a.reason,
                                      title: a.title,
                                      age: relativeAge(a.archivedat),
                                      actLabel: "Restore",
                                      onAct: () => fireAndForget(() => restoreArchived(a.path)),
                                  }))
                            ).map((r) => (
                                <motion.div
                                    key={r.path}
                                    layout
                                    variants={cardVariants}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                    transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                                >
                                    <UpkeepRow
                                        reason={r.reason}
                                        title={r.title}
                                        age={r.age}
                                        actLabel={r.actLabel}
                                        onAct={r.onAct}
                                    />
                                </motion.div>
                            ))}
                        </AnimatePresence>
                        {(open === "cleanup" ? cleanup : archived).length === 0 && (
                            <div className="px-[24px] py-[14px] text-[12px] text-ink-faint">
                                {open === "cleanup" ? "Nothing flagged." : "Nothing archived."}
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
}

// ---- pane 3: saved ----

function SavedRow({ n, selected, rp }: { n: MemNote; selected: boolean; rp: ReflowProps }) {
    const m = typeMeta(n.type);
    return (
        <motion.div
            layout
            variants={cardVariants}
            initial={rp.initial}
            animate="animate"
            exit={rp.exit}
            transition={rp.transition}
            data-vault-saved-row={n.id}
            onClick={() => {
                globalStore.set(vaultFocusAtom, "saved");
                fireAndForget(() => selectNote(n.id));
            }}
            onContextMenu={(ev) =>
                ContextMenuModel.getInstance().showContextMenu(
                    [
                        {
                            label: "Open",
                            icon: <FolderOpen size={15} />,
                            click: () => fireAndForget(() => selectNote(n.id)),
                        },
                        {
                            label: "Copy title",
                            icon: <Copy size={15} />,
                            click: () => void navigator.clipboard.writeText(n.title),
                        },
                        {
                            label: "Copy path",
                            icon: <Copy size={15} />,
                            click: () => void navigator.clipboard.writeText(n.path),
                        },
                        { type: "separator" },
                        {
                            label: "Delete",
                            icon: <Trash2 size={15} />,
                            danger: true,
                            click: () => confirmDeleteNote(n.path, n.title),
                        },
                    ],
                    ev
                )
            }
            className={cn(
                "mx-[24px] grid cursor-pointer grid-cols-[78px_minmax(0,1fr)_46px] items-center gap-[13px] border-l-2 px-[12px] py-[7px]",
                selected ? "border-l-accent bg-surface" : "border-l-transparent hover:bg-surface/60"
            )}
        >
            <span
                className={cn(
                    "rounded-[5px] py-[2px] text-center font-mono text-[9px] font-semibold uppercase tracking-[0.05em]",
                    m.pillClass,
                    m.tintClass
                )}
            >
                {m.label}
            </span>
            <span className="flex min-w-0 items-baseline gap-[10px]">
                <span className="max-w-[46ch] flex-none truncate font-mono text-[12.5px] font-semibold text-primary">
                    {n.title}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-mid">{n.description}</span>
            </span>
            <span className="text-right font-mono text-[10px] text-ink-faint">
                {n.updatedts ? relativeAge(new Date(n.updatedts).toISOString()).replace(" ago", "") : ""}
            </span>
        </motion.div>
    );
}

function SavedList({ notes, rp }: { notes: MemNote[]; rp: ReflowProps }) {
    const selectedId = useAtomValue(memSelectedIdAtom);
    const groups = useMemo(() => groupByScope(notes), [notes]);
    if (notes.length === 0) {
        return <div className="px-[36px] py-[18px] text-[12.5px] text-ink-faint">No saved notes match.</div>;
    }
    return (
        <AnimatePresence mode="popLayout" initial={false}>
            {groups.map((g) => (
                <motion.div key={g.name} layout>
                    <div className="sticky top-0 z-[1] flex items-center gap-[9px] bg-background px-[24px] pb-[6px] pt-[9px]">
                        <span
                            title={g.name}
                            className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-mid"
                        >
                            {scopeLabel(g.name)}
                        </span>
                        <span className="font-mono text-[10.5px] font-semibold text-ink-faint">{g.count}</span>
                        <div className="h-px flex-1 bg-gradient-to-r from-edge-faint to-transparent" />
                    </div>
                    {g.items.map((n) => (
                        <SavedRow key={n.id} n={n} selected={n.id === selectedId} rp={rp} />
                    ))}
                </motion.div>
            ))}
        </AnimatePresence>
    );
}

export function VaultMemory({ reflowAnimated }: { reflowAnimated: boolean }) {
    const notes = useAtomValue(memNotesAtom);
    const pending = useAtomValue(memPendingAtom);
    const search = useAtomValue(memSearchAtom);
    const view = useAtomValue(memViewAtom);
    const selectedId = useAtomValue(memSelectedIdAtom);
    const rp = reflowProps(reflowAnimated);

    const q = search.trim().toLowerCase();
    const filtered = useMemo(
        () => (q ? notes.filter((n) => `${n.title} ${n.description}`.toLowerCase().includes(q)) : notes),
        [q, notes]
    );
    // The graph gets the FULL set plus a match-id filter so search dims non-matches in place: removing
    // them restarts the force simulation on every keystroke.
    const graphFilterIds = useMemo(() => (q ? new Set(filtered.map((n) => n.id)) : null), [q, filtered]);

    return (
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <ReviewQueue />
            <Upkeep />
            <div className="flex flex-none items-center gap-[10px] px-[24px] py-[9px]">
                <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-mid">
                    Saved
                </span>
                <span className="font-mono text-[11px] font-semibold text-ink-faint">
                    {q ? `${filtered.length} of ${notes.length}` : notes.length}
                </span>
                <div className="h-px flex-1 bg-gradient-to-r from-edge-faint to-transparent" />
                {/* the toggle governs Saved only, so it lives on Saved rather than in the page header */}
                <div className="flex rounded-[8px] border border-edge-mid bg-surface p-[2px]">
                    {(["graph", "list"] as const).map((v) => (
                        <button
                            key={v}
                            onClick={() => {
                                globalStore.set(memViewAtom, v);
                                // graph is a whole-library view and needs the height; entering it folds the
                                // queue LIST while leaving its header and count in place
                                globalStore.set(vaultQueueOpenAtom, v === "list");
                            }}
                            className={cn(
                                "rounded-[6px] px-[12px] py-[3px] text-[11.5px] font-semibold capitalize",
                                view === v ? "bg-accentbg text-accent-soft" : "text-ink-mid hover:text-primary"
                            )}
                        >
                            {v}
                        </button>
                    ))}
                </div>
            </div>
            <AnimatePresence mode="wait" initial={false}>
                <motion.div
                    key={view}
                    className="relative min-h-0 flex-1"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                >
                    {view === "list" ? (
                        <div className="absolute inset-0 overflow-auto pb-[14px]">
                            <SavedList notes={filtered} rp={rp} />
                        </div>
                    ) : (
                        <MemGraph
                            notes={notes}
                            pending={pending}
                            filteredIds={graphFilterIds}
                            selectedId={selectedId}
                        />
                    )}
                </motion.div>
            </AnimatePresence>
        </div>
    );
}
