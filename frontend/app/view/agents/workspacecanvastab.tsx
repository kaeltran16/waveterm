// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The workspace pane's Canvas tab: every board of the agent's canvas stacked at the pane's width, as previews. A
// preview opens the canvas window (canvaswindow.tsx) on its board, where marking happens. Its own data attributes,
// not CanvasPane's: sendCanvasMark's capture queries [data-canvas-board] and [data-canvas-scroll], which have to stay
// the window's.

import { ViewSwap } from "@/app/element/viewswap";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { getApi } from "@/app/store/global";
import { formatChordString } from "@/util/keysym";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUpRight, Maximize2, SquareDashed } from "lucide-react";
import { useEffect, useRef } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { boardLabel, boardUrl, paneState, shownBoard, updatedAgo } from "./canvasmodel";
import { BoardIframe, CANVAS_BTN, openBuildRun, Removed, ServerDown } from "./canvaspane";
import { canvasStateAtom, openCanvasWindow, selectCanvasBoard } from "./canvasstore";
import { boardCount } from "./renderedbsboardsmodel";
import { canvasListLayout, LIST_LABEL_H, type ListFrame, type ListLayout } from "./workspacecanvastabmodel";

// the list's top padding, which a board brought into view keeps above its label
const LIST_TOP_PAD = 14;

export function WorkspaceCanvasTab({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const s = useAtomValue(canvasStateAtom(agent.id));
    const now = useAtomValue(model.nowAtom);
    const [measureRef, scrollRef, rect] = useDimensionsWithCallbackRef<HTMLDivElement>();
    const measured = rect != null && rect.width > 0;
    const selected = s != null ? shownBoard(s).name : null;
    const layoutRef = useRef<ListLayout | null>(null);
    // [ and ] can pick a board below the fold: its label row comes to the top, read from the layout, not the DOM
    useEffect(() => {
        const pane = scrollRef.current;
        const frame = layoutRef.current?.frames.find((f) => f.board.name === selected);
        if (!measured || pane == null || frame == null) {
            return;
        }
        const top = LIST_TOP_PAD + frame.labelTop - pane.scrollTop;
        const bottom = LIST_TOP_PAD + frame.top + frame.height - pane.scrollTop;
        if (top < 0 || bottom > pane.clientHeight) {
            pane.scrollTop = frame.labelTop;
        }
    }, [selected, measured]);
    if (s == null) {
        return null;
    }
    const pane = paneState(s);
    const layout = canvasListLayout(s.boards, rect?.width ?? 0);
    layoutRef.current = layout;
    const selectedFrame = layout.frames.find((f) => f.board.name === selected);
    const meta = [
        updatedAgo(now, s.lastModifiedMs),
        selectedFrame != null ? `${Math.round(selectedFrame.scale * 100)}%` : "",
    ].filter(Boolean);

    return (
        <div data-canvas-tab className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-[8px] whitespace-nowrap border-b border-edge-faint px-[18px] py-[8px]">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
                    <span className="text-secondary">{boardCount(s.boards.length)}</span>
                    {meta.map((m) => ` · ${m}`).join("")}
                </span>
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
            </div>
            <ViewSwap swapKey={pane} className="flex min-h-0 flex-1 flex-col bg-surface-code">
                {pane === "server-down" ? (
                    <ServerDown />
                ) : pane === "removed" ? (
                    <Removed agent={agent} topic={s.topic} />
                ) : (
                    // the gutter is reserved so the scrollbar appearing can't narrow the list and rescale it
                    <div
                        ref={measureRef}
                        data-canvas-tab-scroll
                        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-[24px] pb-[24px] [scrollbar-gutter:stable]"
                        style={{ paddingTop: LIST_TOP_PAD }}
                    >
                        {measured ? (
                            <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
                                {layout.frames.map((f) => (
                                    <Preview
                                        key={f.board.name}
                                        frame={f}
                                        selected={f.board.name === selected}
                                        single={layout.frames.length === 1}
                                        src={
                                            pane === "board" && s.base != null
                                                ? boardUrl(s.base, s.topic, f.board.name)
                                                : null
                                        }
                                        reloadKey={s.reloadKey}
                                        onSelect={() => selectCanvasBoard(agent.id, f.board.name)}
                                        onOpen={() => openCanvasWindow(agent.id, { board: f.board.name })}
                                    />
                                ))}
                            </div>
                        ) : null}
                    </div>
                )}
            </ViewSwap>
        </div>
    );
}

// the iframe takes no pointer: the preview is one button that opens the window, and the label beside it only selects
function Preview({
    frame,
    selected,
    single,
    src,
    reloadKey,
    onSelect,
    onOpen,
}: {
    frame: ListFrame;
    selected: boolean;
    single: boolean;
    src: string | null;
    reloadKey: number;
    onSelect: () => void;
    onOpen: () => void;
}) {
    const { board } = frame;
    const label = boardLabel(board.name);
    return (
        <>
            <button
                type="button"
                onClick={onSelect}
                title={board.title ?? label}
                className={cn(
                    "absolute flex cursor-pointer items-baseline gap-[8px] truncate text-left font-mono text-[11px]",
                    selected ? "text-accent-soft" : "text-muted hover:text-secondary"
                )}
                style={{ left: frame.left, top: frame.labelTop, maxWidth: frame.width, height: LIST_LABEL_H }}
            >
                <span className="flex-none font-semibold">{label}</span>
                {board.title != null ? <span className="truncate">{board.title}</span> : null}
            </button>
            <div
                data-canvas-tab-preview={board.name}
                data-selected={selected ? "" : undefined}
                className={cn(
                    "group absolute overflow-hidden rounded-[8px] border bg-background transition-colors",
                    selected && !single ? "border-accent" : "border-edge-mid hover:border-edge-strong"
                )}
                style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
            >
                {src != null ? (
                    <BoardIframe
                        key={`${reloadKey}:${board.name}`}
                        src={src}
                        title={board.name}
                        style={{
                            width: board.w,
                            height: board.h,
                            transform: `scale(${frame.scale})`,
                            transformOrigin: "0 0",
                            pointerEvents: "none",
                        }}
                    />
                ) : null}
                <button
                    type="button"
                    aria-label={`Open ${label} in a window`}
                    onClick={onOpen}
                    className="absolute inset-0 cursor-zoom-in"
                />
                <span
                    data-canvas-tab-open
                    aria-hidden
                    className="pointer-events-none absolute left-1/2 top-1/2 z-[1] inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-[6px] whitespace-nowrap rounded-full border border-edge-strong bg-surface-raised px-[12px] py-[6px] text-[12.5px] font-semibold text-primary opacity-0 shadow-popover-md transition-opacity duration-[120ms] group-hover:opacity-100"
                >
                    <Maximize2 size={13} strokeWidth={2} aria-hidden />
                    Open in a window
                </span>
            </div>
        </>
    );
}
