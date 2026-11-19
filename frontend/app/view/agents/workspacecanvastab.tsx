// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The workspace pane's Canvas tab: one row per board of the agent's canvas, a small preview of the whole board beside
// its name, size and title. A row opens the canvas window (canvaswindow.tsx) on its board, where marking happens. Its
// own data attributes, not CanvasPane's: sendCanvasMark's capture queries [data-canvas-board] and
// [data-canvas-scroll], which have to stay the window's.

import { cardVariants, morphTransition } from "@/app/element/motiontokens";
import { TickNumber } from "@/app/element/ticknumber";
import { ViewSwap } from "@/app/element/viewswap";
import { atoms, getApi } from "@/app/store/global";
import { formatChordString } from "@/util/keysym";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUpRight, Maximize2, SquareDashed } from "lucide-react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { useEffect, useRef } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { boardUrl, paneState, shownBoard, updatedAgo } from "./canvasmodel";
import { BoardIframe, CANVAS_BTN, EdgeState, EXPLAINER, openBuildRun, Removed, ServerDown } from "./canvaspane";
import { canvasStateAtom, openCanvasWindow } from "./canvasstore";
import { boardCount } from "./renderedbsboardsmodel";
import { previewFit, tabRows, tabView, type TabRow } from "./workspacecanvastabmodel";

// MotionConfig's reducedMotion drops transforms but not a layoutId's travel
const INSTANT: Transition = { duration: 0 };

export function WorkspaceCanvasTab({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const s = useAtomValue(canvasStateAtom(agent.id));
    const now = useAtomValue(model.nowAtom);
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    const scrollRef = useRef<HTMLDivElement>(null);
    const view = s != null ? tabView(s) : null;
    const selected = s != null && s.boards.length > 0 ? shownBoard(s).name : null;
    // [ and ] can pick a row below the fold. Only the list's scroller moves: scrollIntoView would also scroll the
    // workspace pane and the surface around it
    useEffect(() => {
        const scroller = scrollRef.current;
        const row =
            selected != null ? scroller?.querySelector(`[data-canvas-tab-preview="${CSS.escape(selected)}"]`) : null;
        if (scroller == null || row == null) {
            return;
        }
        const sv = scroller.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        if (r.top < sv.top) {
            scroller.scrollTop += r.top - sv.top;
        } else if (r.bottom > sv.bottom) {
            scroller.scrollTop += r.bottom - sv.bottom;
        }
    }, [selected, view]);
    if (s == null) {
        return null;
    }
    const pane = paneState(s);
    const ago = updatedAgo(now, s.lastModifiedMs);
    const tint = reduce ? INSTANT : morphTransition;

    return (
        <div data-canvas-tab className="flex min-h-0 flex-1 flex-col">
            {/* the height a row of CANVAS_BTN buttons gave it (py 8px), fixed so the empty head of the removed view does not
                move the body when the view swaps */}
            <div className="flex h-[50px] flex-none items-center gap-[8px] whitespace-nowrap border-b border-edge-faint px-[18px]">
                {view === "removed" ? null : (
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
                        <span className="text-secondary">
                            {view === "no-boards" ? (
                                "No boards"
                            ) : (
                                <TickNumber value={s.boards.length} format={boardCount} />
                            )}
                        </span>
                        {ago ? ` · ${ago}` : ""}
                    </span>
                )}
                {view === "boards" || view === "server-down" ? (
                    <>
                        {s.base != null && selected != null ? (
                            <button
                                type="button"
                                aria-label="Open in browser"
                                title="Open in browser"
                                onClick={() => getApi().openExternal(boardUrl(s.base!, s.topic, selected))}
                                className="flex size-[28px] flex-none cursor-pointer items-center justify-center rounded-[7px] text-muted hover:bg-surface-hover hover:text-secondary"
                            >
                                <ArrowUpRight size={15} strokeWidth={2} aria-hidden />
                            </button>
                        ) : null}
                        <button
                            type="button"
                            title={`Mark part of the board (${formatChordString("m")}): opens the board in a window`}
                            disabled={pane !== "board" || selected == null}
                            onClick={() => openCanvasWindow(agent.id, { board: selected!, mark: true })}
                            className={cn(CANVAS_BTN, "disabled:cursor-default disabled:opacity-50")}
                        >
                            <SquareDashed size={15} strokeWidth={1.8} aria-hidden />
                            Mark
                        </button>
                        {s.boards.length > 0 ? (
                            <button
                                type="button"
                                onClick={() => void openBuildRun(model, agent, s, s.boards)}
                                className={CANVAS_BTN}
                            >
                                Build this…
                            </button>
                        ) : null}
                    </>
                ) : null}
            </div>
            <ViewSwap swapKey={view} className="flex min-h-0 flex-1 flex-col bg-surface-code">
                {view === "server-down" ? (
                    <ServerDown />
                ) : view === "removed" ? (
                    <Removed agent={agent} topic={s.topic} inTab />
                ) : view === "no-boards" ? (
                    <EdgeState>
                        <span className="text-[14px] font-semibold text-primary">No boards yet</span>
                        <span className={EXPLAINER}>
                            canvas.json lists no boards. They show here as the agent writes them.
                        </span>
                    </EdgeState>
                ) : (
                    <div
                        ref={scrollRef}
                        data-canvas-tab-scroll
                        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-[10px] pb-[24px] pt-[8px] [scrollbar-gutter:stable]"
                    >
                        <div className="relative flex flex-col gap-[2px]">
                            <AnimatePresence initial={false} mode="popLayout">
                                {tabRows(s).map((row) => (
                                    <motion.div
                                        key={row.board.name}
                                        layout
                                        variants={cardVariants}
                                        initial="initial"
                                        animate="animate"
                                        exit="exit"
                                    >
                                        <BoardRow
                                            row={row}
                                            tintId={`canvas-tab-tint:${agent.id}`}
                                            tint={tint}
                                            src={
                                                pane === "board" && s.base != null
                                                    ? boardUrl(s.base, s.topic, row.board.name)
                                                    : null
                                            }
                                            reloadKey={s.reloadKey}
                                            onOpen={() => openCanvasWindow(agent.id, { board: row.board.name })}
                                        />
                                    </motion.div>
                                ))}
                            </AnimatePresence>
                        </div>
                    </div>
                )}
            </ViewSwap>
        </div>
    );
}

// the whole row is one button; the iframe takes no pointer. The selected row's tint is one element that moves
// between rows (layoutId), and it keeps its tint under the pointer
function BoardRow({
    row,
    tintId,
    tint,
    src,
    reloadKey,
    onOpen,
}: {
    row: TabRow;
    tintId: string;
    tint: Transition;
    src: string | null;
    reloadKey: number;
    onOpen: () => void;
}) {
    const { board, label, size, selected } = row;
    const fit = previewFit(board.w, board.h);
    const open = `Open ${label} in a window`;
    return (
        <button
            type="button"
            data-canvas-tab-preview={board.name}
            data-selected={selected ? "" : undefined}
            aria-label={open}
            title={open}
            onClick={onOpen}
            className={cn(
                "group relative flex w-full cursor-pointer items-center gap-[12px] rounded-[8px] py-[7px] pl-[8px] pr-[10px] text-left transition-colors",
                !selected && "hover:bg-surface-hover"
            )}
        >
            {selected ? (
                <motion.span
                    layoutId={tintId}
                    transition={tint}
                    aria-hidden
                    className="absolute inset-0 rounded-[8px] bg-accentbg"
                />
            ) : null}
            <span
                data-canvas-tab-box
                className="relative h-[70px] w-[112px] flex-none overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code transition-colors group-hover:border-edge-strong"
            >
                <span className="absolute inset-[2px] overflow-hidden">
                    {src != null ? (
                        <BoardIframe
                            key={`${reloadKey}:${board.name}`}
                            src={src}
                            title={board.name}
                            style={{
                                left: fit.left,
                                top: fit.top,
                                width: board.w,
                                height: board.h,
                                transform: `scale(${fit.scale})`,
                                transformOrigin: "0 0",
                                pointerEvents: "none",
                            }}
                        />
                    ) : null}
                </span>
            </span>
            <span className="relative flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="flex items-baseline gap-[10px] font-mono">
                    <span
                        data-canvas-tab-name
                        className={cn(
                            "min-w-0 flex-1 truncate text-[11.5px] font-semibold",
                            selected ? "text-accent-soft" : "text-primary"
                        )}
                    >
                        {label}
                    </span>
                    <span className="flex-none text-[10.5px] text-ink-faint">{size}</span>
                </span>
                {board.title != null ? (
                    <span
                        data-canvas-tab-title
                        title={board.title}
                        className={cn(
                            "line-clamp-2 text-[12.5px] leading-[1.4]",
                            selected ? "text-secondary" : "text-ink-mid"
                        )}
                    >
                        {board.title}
                    </span>
                ) : null}
            </span>
            <span
                data-canvas-tab-open
                aria-hidden
                className="relative flex w-[24px] flex-none justify-center text-secondary opacity-0 transition-opacity group-hover:opacity-100"
            >
                <Maximize2 size={13} strokeWidth={2} aria-hidden />
            </span>
        </button>
    );
}
