// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Boards surface's list (boards F8, N1, D2, E1): New board, the project's boards newest-drawn first, and the
// open board unfolded into its tree: the follows on top, a row per source, then Your shapes. Thin render: the
// rows come from boardmodel.ts and every action is the surface's.

import { KIND_ICONS } from "@/app/cockpit/palette-rows";
import { DrawCheck } from "@/app/element/drawcheck";
import { useChangeFlash } from "@/app/element/motionhooks";
import { cardVariants, changeFlashClass, composerReveal, errorNudge, paneReveal } from "@/app/element/motiontokens";
import { atoms } from "@/app/store/global";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { ChevronRight, Pencil, Play } from "lucide-react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { useRef, useState, type KeyboardEvent } from "react";
import { boardTime, type BoardSourceRow } from "./boardmodel";
import type { BoardFollower } from "./boardstore";

const SMALL_BTN =
    "cursor-pointer rounded-md border border-edge-mid bg-surface-raised px-[9px] py-[3px] text-[12px] font-semibold text-secondary hover:border-edge-strong hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const PRIMARY_BTN =
    "cursor-pointer rounded-md border-0 bg-accent px-[11px] py-1 text-[12px] font-semibold text-background hover:bg-accenthover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const ERROR_BTN =
    "cursor-pointer rounded-md border border-error/40 bg-transparent px-2.5 py-[3px] text-[12px] font-semibold text-error-soft hover:bg-error/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

// reducedMotion="user" leaves layout animations running, so reduced motion snaps them itself
const SNAP: Transition = { duration: 0 };

// an entering or leaving row (moments 1 and 2); the caller adds `layout` so the rows around it reflow
const CARD = { variants: cardVariants, initial: "initial", animate: "animate", exit: "exit" } as const;
// a block revealing under its row (moment 6)
const REVEAL = { variants: composerReveal, initial: "initial", animate: "animate", exit: "exit" } as const;

function useLayoutTransition(): Transition | undefined {
    return useAtomValue(atoms.prefersReducedMotionAtom) ? SNAP : undefined;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// a status said with a dot and a word, never colour alone
function Mark({ tone, label, pulse }: { tone: "working" | "error"; label: string; pulse?: boolean }) {
    return (
        <span
            data-board-mark={label}
            className={cn(
                "flex shrink-0 items-center gap-[5px] text-[11.5px] font-semibold",
                tone === "working" ? "text-working" : "text-error"
            )}
        >
            <span
                className={cn(
                    "h-[7px] w-[7px] shrink-0 rounded-full",
                    tone === "working" ? "bg-working" : "bg-error",
                    pulse && "pulse-dot"
                )}
            />
            {label}
        </span>
    );
}

// what a board's row says beside its name: why it can't be used, else what the scribe is doing, else what's new
function BoardMarks({ board, now }: { board: BoardInfo; now: number }) {
    if (board.loaderror) {
        return <Mark tone="error" label="won't open" />;
    }
    if (board.state === "drawing") {
        return <Mark tone="working" label="drawing" pulse />;
    }
    if (board.state === "failed") {
        return <Mark tone="error" label="failed" />;
    }
    return (
        <>
            {board.newcount ? (
                <span className="flex items-center gap-[5px] text-[11.5px] font-semibold text-accent-soft">
                    <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                    {board.newcount} new
                </span>
            ) : null}
            <span className="text-[11.5px] text-muted">{boardTime(board.lastdrawnts || board.createdts, now)}</span>
        </>
    );
}

export interface NewBoardFieldProps {
    project: string;
    onCreate: (name: string) => Promise<void>;
    onCancel: () => void;
}

// a board's name before it exists (N1): Enter or Create makes it, Esc or Cancel drops it, empty stays open
function NewBoardField({ project, onCreate, onCancel }: NewBoardFieldProps) {
    const [name, setName] = useState("");
    // counts the refused tries, so each one nudges again
    const [refused, setRefused] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const create = async () => {
        if (busy) {
            return;
        }
        if (name.trim() === "") {
            setRefused((n) => n + 1);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await onCreate(name.trim());
        } catch (e) {
            setError(`Couldn't make the board: ${e instanceof Error ? e.message : String(e)}`);
            setRefused((n) => n + 1);
        } finally {
            setBusy(false);
        }
    };
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            void create();
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
        }
    };
    const hint = error ?? (refused > 0 && name.trim() === "" ? "Type a name first" : null);
    return (
        <motion.div
            data-new-board
            variants={composerReveal}
            initial="initial"
            animate="animate"
            exit="exit"
            className="overflow-hidden"
        >
            <div className="flex flex-col gap-1.5 rounded-lg border border-edge-mid bg-surface-raised p-2">
                <label htmlFor="new-board-name" className="text-[11.5px] font-semibold text-ink-mid">
                    New board in {project}
                </label>
                <input
                    id="new-board-name"
                    type="text"
                    autoFocus
                    autoComplete="off"
                    value={name}
                    placeholder="Name this board"
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={onKeyDown}
                    className="w-full rounded-[5px] border border-accent bg-surface px-[7px] py-[5px] text-[13px] font-medium text-primary outline-none placeholder:text-muted"
                />
                <AnimatePresence initial={false} mode="wait">
                    {hint != null ? (
                        <motion.span
                            key={`refused-${refused}`}
                            data-new-board-error
                            variants={errorNudge}
                            initial="initial"
                            animate="animate"
                            className="text-[11.5px] text-error"
                        >
                            {hint}
                        </motion.span>
                    ) : (
                        <span key="hint" className="text-[11.5px] text-muted">
                            Enter creates it · Esc cancels
                        </span>
                    )}
                </AnimatePresence>
                <span className="flex justify-end gap-1.5">
                    <button type="button" onClick={onCancel} className={SMALL_BTN}>
                        Cancel
                    </button>
                    <button type="button" onClick={() => void create()} disabled={busy} className={PRIMARY_BTN}>
                        Create
                    </button>
                </span>
            </div>
        </motion.div>
    );
}

export interface BoardTreeProps {
    rows: BoardSourceRow[];
    // each drawn source's drawn time, for the failed and pending lines
    drawnTs: Record<string, number>;
    follows: BoardFollower[];
    yourShapes: string | null; // null until the canvas has the scene
    empty: boolean;
    selectedKey: string | null;
    now: number;
    onPick: (key: string) => void;
    onKeep: (key: string) => void;
    onDrop: (key: string) => void;
    onRetry: (key: string) => void;
    onStop: (tabId: string) => void;
}

function queuedLine(n: number): string {
    return n === 1
        ? "1 more turn end came in; it joins the next pass."
        : `${n} more turn ends came in; they join the next pass.`;
}

function SourceRow({
    row,
    drawnTs,
    selected,
    now,
    onPick,
    onKeep,
    onDrop,
    onRetry,
}: {
    row: BoardSourceRow;
    drawnTs: number | undefined;
    selected: boolean;
    now: number;
    onPick: () => void;
    onKeep: () => void;
    onDrop: () => void;
    onRetry: () => void;
}) {
    // a redraw that lands under the user washes its row (moment 14); mounting never does
    const flash = useChangeFlash(drawnTs ?? 0);
    const Icon = KIND_ICONS[row.kindIcon as keyof typeof KIND_ICONS] ?? Play;
    const st = row.status;
    const drawing = row.state === "drawing";
    const subline = drawing && st?.reading ? `Reading ${st.reading}` : row.subline;
    // a pass seen drawing while mounted, then ending not failed, landed (moment 16); a row mounted drawn never did
    const wasDrawing = useRef(drawing);
    const landed = useRef(false);
    if (drawing) {
        landed.current = false;
    } else if (wasDrawing.current && row.state !== "failed") {
        landed.current = true;
    }
    wasDrawing.current = drawing;
    return (
        <div
            role="treeitem"
            aria-selected={selected}
            data-board-source={row.key}
            className={cn("flex flex-col rounded-md", selected && "bg-surface-selected", flash && changeFlashClass)}
        >
            <button
                type="button"
                onClick={onPick}
                className="flex cursor-pointer items-start gap-2 border-0 bg-transparent px-1.5 py-[7px] text-left text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
                <Icon
                    size={14}
                    strokeWidth={1.8}
                    aria-hidden
                    className={cn("mt-0.5 shrink-0", selected ? "text-accent-soft" : "text-ink-mid")}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-semibold">{row.title}</span>
                        <AnimatePresence initial={false}>
                            {row.isNew && !drawing ? (
                                <motion.span
                                    key="new"
                                    {...CARD}
                                    className="shrink-0 rounded-full bg-accentbg px-[7px] py-px text-[10.5px] font-semibold text-accent-soft"
                                >
                                    New
                                </motion.span>
                            ) : null}
                        </AnimatePresence>
                        {drawing ? <Mark tone="working" label="drawing" pulse /> : null}
                        {/* mounted with the row and driven by done, so it draws when the draw lands */}
                        <DrawCheck done={landed.current && row.isNew && !drawing} className="shrink-0 text-success" />
                        {row.state === "failed" ? <Mark tone="error" label="failed" /> : null}
                    </span>
                    <span className="text-[11.5px] text-muted">{subline}</span>
                </span>
            </button>
            {/* each block reveals under its row (moment 6); the margins sit inside so the height tween includes them */}
            <AnimatePresence initial={false}>
                {drawing ? (
                    <motion.div key="drawing" {...REVEAL} className="overflow-hidden">
                        <div className="mx-1.5 mb-2 ml-7 text-[11.5px] leading-[1.45] text-ink-mid">
                            {drawnTs != null ? "The group stays as drawn until the redraw lands." : null}
                            {st?.queued ? `${drawnTs != null ? " " : ""}${queuedLine(st.queued)}` : null}
                        </div>
                    </motion.div>
                ) : null}
                {row.state === "failed" && st != null ? (
                    <motion.div key="failed" {...REVEAL} className="overflow-hidden">
                        <div className="mx-1.5 mb-2 ml-7 flex flex-col gap-2 rounded-md border border-error/40 bg-error/10 px-[9px] py-2">
                            <span className="text-[12px] leading-[1.4] text-error-soft">
                                {drawnTs != null
                                    ? `The ${boardTime(st.ts, now)} redraw failed: ${st.reason || "no reason given"}. The group keeps its ${boardTime(drawnTs, now)} version.`
                                    : `The ${boardTime(st.ts, now)} draw failed: ${st.reason || "no reason given"}.`}
                            </span>
                            <span className="flex justify-end">
                                <button type="button" onClick={onRetry} className={ERROR_BTN}>
                                    Retry
                                </button>
                            </span>
                        </div>
                    </motion.div>
                ) : null}
                {row.state === "pending" && row.pending != null ? (
                    <motion.div key="pending" {...REVEAL} className="overflow-hidden">
                        <div className="mx-1.5 mb-2 ml-7 flex flex-col gap-2 rounded-md border border-edge-strong bg-surface-raised px-[9px] py-2">
                            <span className="text-[12px] leading-[1.4] text-secondary">
                                You edited it at {boardTime(row.pending.editedTs, now)}, so the{" "}
                                {boardTime(row.pending.drawnTs, now)} redraw waits beside it.
                            </span>
                            <span className="flex justify-end gap-1.5">
                                <button type="button" onClick={onDrop} className={SMALL_BTN}>
                                    Drop
                                </button>
                                <button type="button" onClick={onKeep} className={PRIMARY_BTN}>
                                    Keep
                                </button>
                            </span>
                        </div>
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
}

function BoardTree(props: BoardTreeProps) {
    const { rows, follows, yourShapes, empty, selectedKey, now } = props;
    const reflow = useLayoutTransition();
    // the rows come with the canvas's scene, after the tree mounts: their presence mounts with them, so the rows
    // there on open land settled and only a source drawn later enters
    const loaded = yourShapes != null;
    return (
        // relative: a leaving row pops out (popLayout) against this box
        <div
            role="group"
            className="relative mb-2 ml-[13px] mt-1.5 flex flex-col gap-0.5 border-l border-edge-mid pl-2"
        >
            <AnimatePresence initial={false} mode="popLayout">
                {follows.map((f) => (
                    <motion.div
                        key={f.tabId}
                        layout
                        transition={reflow}
                        {...CARD}
                        data-board-follow={f.tabId}
                        className="flex items-center gap-2 py-1.5 pl-1.5 pr-1 pb-2"
                    >
                        <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-working" />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="truncate text-[12px] font-semibold text-primary">
                                Following {f.agentName}
                            </span>
                            <span className="text-[11.5px] text-muted">redraws at each turn end</span>
                        </span>
                        <button type="button" onClick={() => props.onStop(f.tabId)} className={SMALL_BTN}>
                            Stop
                        </button>
                    </motion.div>
                ))}
            </AnimatePresence>
            {loaded ? (
                <AnimatePresence initial={false} mode="popLayout">
                    {empty ? (
                        <motion.span key="empty" {...CARD} className="py-1.5 pl-1.5 text-[12px] text-muted">
                            Nothing drawn yet
                        </motion.span>
                    ) : null}
                    {/* position only: a row's own height changes as its blocks reveal, and a scaled row smears */}
                    {empty
                        ? null
                        : rows.map((row) => (
                              <motion.div key={row.key} layout="position" transition={reflow} {...CARD}>
                                  <SourceRow
                                      row={row}
                                      drawnTs={props.drawnTs[row.key]}
                                      selected={selectedKey === row.key}
                                      now={now}
                                      onPick={() => props.onPick(row.key)}
                                      onKeep={() => props.onKeep(row.key)}
                                      onDrop={() => props.onDrop(row.key)}
                                      onRetry={() => props.onRetry(row.key)}
                                  />
                              </motion.div>
                          ))}
                    {empty ? null : (
                        <motion.div
                            key="yours"
                            layout="position"
                            transition={reflow}
                            {...CARD}
                            role="treeitem"
                            aria-selected={false}
                            data-board-yours
                            className="flex items-start gap-2 px-1.5 py-[7px]"
                        >
                            <Pencil size={14} strokeWidth={1.8} aria-hidden className="mt-0.5 shrink-0 text-ink-mid" />
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="text-[12.5px] font-semibold text-primary">Your shapes</span>
                                <span className="text-[11.5px] text-muted">
                                    {yourShapes} · the scribe never changes them
                                </span>
                            </span>
                        </motion.div>
                    )}
                </AnimatePresence>
            ) : null}
        </div>
    );
}

export interface BoardsListProps {
    project: string;
    boards: BoardInfo[];
    openId: string | null;
    folded: boolean;
    naming: boolean;
    tree: BoardTreeProps;
    now: number;
    onPickBoard: (boardId: string) => void;
    onNewBoard: () => void;
    onCreate: (name: string) => Promise<void>;
    onCancelNaming: () => void;
}

export function BoardsList(props: BoardsListProps) {
    const { project, boards, openId, folded, naming, now } = props;
    const reflow = useLayoutTransition();
    return (
        <aside
            aria-label={`Boards in ${project}`}
            className="flex w-[264px] shrink-0 flex-col gap-2.5 overflow-auto border-r border-border bg-surface px-2.5 py-3"
        >
            <button
                type="button"
                data-new-board-button
                onClick={props.onNewBoard}
                className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-edge-mid bg-surface-raised px-2.5 py-[7px] text-[12.5px] font-semibold text-primary hover:border-edge-strong hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
                <span className="text-[15px] leading-none">+</span>New board
            </button>
            <div className="px-1.5 pt-0.5 text-[11.5px] text-muted">
                {plural(boards.length, "board")} in {project}
            </div>
            <div role="tree" aria-label="Boards" className="flex flex-col gap-0.5">
                <AnimatePresence initial={false}>
                    {naming ? (
                        <NewBoardField
                            key="new-board"
                            project={project}
                            onCreate={props.onCreate}
                            onCancel={props.onCancelNaming}
                        />
                    ) : null}
                </AnimatePresence>
                {/* the list reorders as boards are drawn on, and a board made or gone enters or leaves (moments 1, 2) */}
                <AnimatePresence mode="popLayout" initial={false}>
                    {boards.map((b) => {
                        const isOpen = b.id === openId;
                        return (
                            <motion.div
                                key={b.id}
                                layout
                                transition={reflow}
                                {...CARD}
                                role="treeitem"
                                aria-expanded={isOpen ? !folded : false}
                                aria-selected={isOpen}
                                data-board-row={b.id}
                                className="flex flex-col"
                            >
                                <button
                                    type="button"
                                    onClick={() => props.onPickBoard(b.id)}
                                    className={cn(
                                        "flex cursor-pointer items-center gap-[7px] rounded-lg border-0 p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                        isOpen
                                            ? "bg-surface-selected text-primary"
                                            : "bg-transparent text-secondary hover:bg-surface-hover"
                                    )}
                                >
                                    <ChevronRight
                                        size={12}
                                        strokeWidth={2}
                                        aria-hidden
                                        className={cn(
                                            "shrink-0 transition-transform",
                                            isOpen ? "text-ink-mid" : "text-muted",
                                            isOpen && !folded && "rotate-90"
                                        )}
                                    />
                                    <span
                                        className={cn(
                                            "min-w-0 flex-1 truncate text-[13px]",
                                            isOpen ? "font-semibold" : "font-medium"
                                        )}
                                    >
                                        {b.name}
                                    </span>
                                    <BoardMarks board={b} now={now} />
                                </button>
                                <AnimatePresence initial={false}>
                                    {isOpen && !folded && !b.loaderror ? (
                                        <motion.div
                                            key="tree"
                                            variants={paneReveal}
                                            initial="initial"
                                            animate="animate"
                                            exit="exit"
                                            className="overflow-hidden"
                                        >
                                            <BoardTree {...props.tree} />
                                        </motion.div>
                                    ) : null}
                                </AnimatePresence>
                            </motion.div>
                        );
                    })}
                </AnimatePresence>
            </div>
        </aside>
    );
}
