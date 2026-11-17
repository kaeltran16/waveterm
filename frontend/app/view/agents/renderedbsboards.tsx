// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The boards a Rendered card draws: LiveBoards, the live-board block a question's card and the standalone Mockup card
// share, and MockupCard, for a canvas with no brainstorm (CanvasEdge). The block draws the canvas the agent's canvas
// state serves; a board shown here counts as on screen for the poller, so it reloads when its file changes.

import { microFade } from "@/app/element/motiontokens";
import { ViewSwap } from "@/app/element/viewswap";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUpRight, PanelsTopLeft, SquareDashed } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type JSX, type ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import type { BrainstormFile } from "./brainstormmodel";
import { getBrainstorm, openBrainstormAt, type BrainstormState } from "./brainstormstore";
import {
    boardLabel,
    boardUnseen,
    boardUrl,
    canvasDir,
    DEFAULT_BOARD_H,
    DEFAULT_BOARD_W,
    fitScale,
    updatedAgo,
} from "./canvasmodel";
import { BoardIframe, SERVER_DOWN } from "./canvaspane";
import {
    attachCanvas,
    canvasStateAtom,
    getCanvas,
    markFromTranscript,
    selectCanvasTab,
    setCanvasMode,
    setMarking,
    showInlineBoard,
} from "./canvasstore";
import { boardCount, mockupView, shownOf, type MockupView } from "./renderedbsboardsmodel";

const NO_BOARDS: { block: ReactNode | null; chip: (i: number) => ReactNode | null } = { block: null, chip: () => null };

export function useQuestionBoards(
    _agent: AgentVM,
    _s: BrainstormState,
    _f: BrainstormFile,
    _judging: boolean,
    _compact: boolean
): { block: ReactNode | null; chip: (i: number) => ReactNode | null } {
    return NO_BOARDS;
}

const MOCKUP_WHAT = "the agent's mockup";
const MARK_TITLE = "Mark part of the board: opens the canvas";
// "updated 40s ago" counts in seconds
const AGO_TICK_MS = 1000;

const LINK =
    "inline-flex cursor-pointer items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 text-[12px] text-accent-soft hover:underline disabled:cursor-default disabled:opacity-50 disabled:no-underline";

// the pane at a board: a brainstorm's board view, or the agent's canvas. A mark started here returns to Rendered once
// sent (canvassend)
function openBoard(agentId: string, board: string, mark: boolean): void {
    if (getBrainstorm(agentId) != null) {
        openBrainstormAt(agentId, { board, mark });
    } else {
        selectCanvasTab(agentId, board);
        setCanvasMode(agentId, "canvas", Date.now());
        setMarking(agentId, mark);
    }
    if (mark) {
        markFromTranscript(agentId);
    }
}

function useNow(ms: number): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), ms);
        return () => clearInterval(t);
    }, [ms]);
    return now;
}

function UpdatedAgo({ ms }: { ms: number | null }) {
    const now = useNow(AGO_TICK_MS);
    const ago = updatedAgo(now, ms);
    return ago ? <span data-live-boards-ago>{` · ${ago}`}</span> : null;
}

function BoardTabs(p: {
    boards: string[];
    shown: string;
    unseen: (board: string) => boolean;
    onShow: (board: string) => void;
}) {
    return (
        <div
            role="tablist"
            aria-label="Boards"
            className="flex flex-none rounded-[7px] border border-edge-mid bg-surface-raised p-[2px]"
        >
            {p.boards.map((b) => {
                const selected = b === p.shown;
                return (
                    <button
                        key={b}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        data-live-board-tab={b}
                        onClick={() => p.onShow(b)}
                        className={cn(
                            "inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] border-0 px-2.5 py-[3px] text-[12px]",
                            selected
                                ? "bg-surface-selected font-semibold text-primary"
                                : "bg-transparent text-ink-mid hover:text-secondary"
                        )}
                    >
                        {boardLabel(b)}
                        <AnimatePresence initial={false}>
                            {!selected && p.unseen(b) ? (
                                <motion.span
                                    key="unseen"
                                    data-live-board-unseen
                                    aria-label="updated since you last looked"
                                    variants={microFade}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                    className="h-1.5 w-1.5 rounded-full bg-accent"
                                />
                            ) : null}
                        </AnimatePresence>
                    </button>
                );
            })}
        </div>
    );
}

// the live board: tabs for the boards given, the shown one scaled to the card's width, and Mark and Open canvas.
// disabled is the title the actions wear while they can't act (the brainstorm's working tooltip), or null
export function LiveBoards(p: {
    agent: AgentVM;
    canvas: string;
    cwd: string;
    boards: string[];
    shown: string;
    onShow: (board: string) => void;
    what: string;
    disabled: string | null;
    compact: boolean;
}): JSX.Element {
    const id = p.agent.id;
    const s = useAtomValue(canvasStateAtom(id));
    const [measure, , rect] = useDimensionsWithCallbackRef<HTMLDivElement>();
    const topic = s?.topic;
    // a card can name a canvas the agent has not attached (a brainstorm's): attaching it is what serves it
    useEffect(() => {
        if (getCanvas(id)?.topic !== p.canvas) {
            attachCanvas(id, { topic: p.canvas, dir: canvasDir(p.cwd, p.canvas), projectDir: p.cwd }, Date.now());
        }
    }, [id, p.canvas, p.cwd]);
    useEffect(() => {
        if (topic === p.canvas) {
            showInlineBoard(id, p.shown, Date.now());
        }
    }, [id, p.shown, p.canvas, topic]);
    useEffect(() => () => showInlineBoard(id, null, Date.now()), [id]);

    const ours = s != null && s.topic === p.canvas ? s : null;
    const board = ours?.boards.find((b) => b.name === p.shown);
    const w = board?.w ?? DEFAULT_BOARD_W;
    const h = board?.h ?? DEFAULT_BOARD_H;
    const scale = fitScale(rect?.width ?? 0, w);
    const src = ours?.status === "ready" && ours.base != null ? boardUrl(ours.base, ours.topic, p.shown) : null;
    // 0 is a board served with no Last-Modified, which has no age to give
    const modified = ours?.boardModifiedMs?.[p.shown] || null;
    const label = boardLabel(p.shown);
    const off = p.disabled != null;
    return (
        <div data-live-boards className="overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code">
            <div
                data-live-boards-bar
                className={cn(
                    "flex border-b border-edge-faint py-1.5 pl-2.5 pr-2",
                    p.compact ? "flex-col items-start gap-2" : "items-center gap-[10px]"
                )}
            >
                {p.boards.length > 1 ? (
                    <BoardTabs
                        boards={p.boards}
                        shown={p.shown}
                        unseen={(b) => ours != null && boardUnseen(ours, b)}
                        onShow={p.onShow}
                    />
                ) : null}
                <span className={cn("min-w-0 text-muted", p.compact ? "text-[11.5px]" : "text-[12px]")}>
                    {p.what} · <span className="font-mono text-[11.5px] text-ink-mid">{p.canvas}</span>
                    <UpdatedAgo ms={modified} />
                </span>
                {p.compact ? null : <span className="flex-1" />}
                <div data-live-boards-actions className="flex flex-none items-center gap-[10px]">
                    <button
                        type="button"
                        data-live-boards-mark
                        disabled={off}
                        title={p.disabled ?? MARK_TITLE}
                        onClick={() => openBoard(id, p.shown, true)}
                        className="flex cursor-pointer items-center gap-1.5 rounded-[7px] border border-edge-mid bg-surface-raised px-2.5 py-1 text-[12px] font-semibold text-primary hover:border-edge-strong disabled:cursor-default disabled:opacity-50"
                    >
                        <SquareDashed size={13} strokeWidth={2} aria-hidden />
                        Mark
                    </button>
                    <button
                        type="button"
                        data-live-boards-open
                        disabled={off}
                        title={p.disabled ?? undefined}
                        onClick={() => openBoard(id, p.shown, false)}
                        className={cn(LINK, "px-1")}
                    >
                        Open canvas
                        <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
                    </button>
                </div>
            </div>
            <div ref={measure} className="flex flex-col gap-2 px-3 pb-2.5 pt-3">
                <ViewSwap swapKey={p.shown}>
                    <button
                        type="button"
                        data-live-board={p.shown}
                        aria-label={`Open ${label} in the canvas`}
                        disabled={off}
                        title={p.disabled ?? undefined}
                        onClick={() => openBoard(id, p.shown, false)}
                        className="relative block w-full cursor-zoom-in overflow-hidden rounded-[6px] border border-edge-mid bg-background p-0 disabled:cursor-default"
                        style={{ height: h * scale }}
                    >
                        {src != null && rect != null ? (
                            <BoardIframe
                                key={`${ours?.reloadKey ?? 0}:${p.shown}`}
                                src={src}
                                title={p.shown}
                                style={{
                                    width: w,
                                    height: h,
                                    transform: `scale(${scale})`,
                                    transformOrigin: "0 0",
                                    pointerEvents: "none",
                                }}
                            />
                        ) : null}
                    </button>
                </ViewSwap>
                <div className="flex items-baseline gap-2 text-[12px] text-ink-mid">
                    <span className="min-w-0 truncate">{board?.title ?? label}</span>
                    <span className="flex-1" />
                    <span className="font-mono text-[10.5px] text-muted">{`${Math.round(scale * 100)}%`}</span>
                </div>
            </div>
        </div>
    );
}

function MockupHead({
    agentId,
    topic,
    count,
    open,
    compact,
}: {
    agentId: string;
    topic: string;
    count: number;
    open: string | null;
    compact: boolean;
}) {
    return (
        <div
            data-rendered-mockup-head
            className={cn(
                "flex px-[14px] py-[11px]",
                compact ? "flex-col items-start gap-1.5" : "items-center gap-[10px]"
            )}
        >
            <span className="flex min-w-0 items-center gap-[10px]">
                <PanelsTopLeft size={15} strokeWidth={2} className="flex-none text-ink-mid" aria-hidden />
                <span className={cn("text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}>Mockup</span>
                <span className="min-w-0 truncate font-mono text-[12.5px] font-semibold text-foreground">{topic}</span>
                {count > 0 ? (
                    <span className="whitespace-nowrap text-[12px] text-muted">{boardCount(count)}</span>
                ) : null}
            </span>
            {compact ? null : <span className="flex-1" />}
            {open != null ? (
                <button
                    type="button"
                    data-rendered-mockup-open
                    onClick={() => openBoard(agentId, open, false)}
                    className={LINK}
                >
                    Open canvas
                    <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
                </button>
            ) : null}
        </div>
    );
}

function EdgeBody({ children }: { children: ReactNode }) {
    return (
        <div className="flex flex-col items-center gap-1.5 border-t border-edge-faint bg-surface-code px-[14px] py-[22px] text-center">
            {children}
        </div>
    );
}

function RemovedRow({ topic, compact }: { topic: string; compact: boolean }) {
    return (
        <div
            data-rendered-mockup="removed"
            className={cn(
                "flex px-0.5 py-0.5 text-ink-mid",
                compact ? "flex-col items-start gap-1 text-[12.5px]" : "items-center gap-[10px] text-[13.5px]"
            )}
        >
            <span className="flex min-w-0 items-center gap-[10px]">
                <PanelsTopLeft size={15} strokeWidth={2} className="flex-none" aria-hidden />
                <span className="whitespace-nowrap">Opened in Arc</span>
                <span className="min-w-0 truncate font-mono text-[12px] text-foreground">{`canvas:${topic}`}</span>
            </span>
            {compact ? null : <span className="flex-1" />}
            <span className="text-[12px] text-muted">removed, usually because the feature shipped</span>
        </div>
    );
}

function MockupBody(p: {
    agent: AgentVM;
    view: MockupView;
    projectDir: string;
    topic: string;
    shown: string | null;
    onShow: (board: string) => void;
    compact: boolean;
}) {
    switch (p.view.kind) {
        case "empty":
            return (
                <EdgeBody>
                    <span className="text-[13px] text-muted">
                        No boards yet. They show here as the agent writes them.
                    </span>
                </EdgeBody>
            );
        case "server-down":
            return (
                <EdgeBody>
                    <span className="flex items-center gap-2 text-[13.5px] font-semibold text-primary">
                        <span className="h-[7px] w-[7px] flex-none rounded-full bg-error" />
                        {SERVER_DOWN.title}
                    </span>
                    <span className="max-w-[440px] text-[13px] leading-[1.5] text-secondary">
                        {SERVER_DOWN.explainer}
                    </span>
                </EdgeBody>
            );
        case "boards":
            return p.shown != null ? (
                <div className="border-t border-edge-faint p-3">
                    <LiveBoards
                        agent={p.agent}
                        canvas={p.topic}
                        cwd={p.projectDir}
                        boards={p.view.boards}
                        shown={p.shown}
                        onShow={p.onShow}
                        what={MOCKUP_WHAT}
                        disabled={null}
                        compact={p.compact}
                    />
                </div>
            ) : null;
        default:
            return null;
    }
}

// the standalone Mockup card, for an agent with a canvas and no brainstorm: the boards as they are written, or why
// they can't show. The agent has no brainstorm, so no working state holds its actions
export function MockupCard({
    agent,
    compact,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    compact: boolean;
}): JSX.Element | null {
    const s = useAtomValue(canvasStateAtom(agent.id));
    const [want, setWant] = useState<string | null>(null);
    if (s == null) {
        return null;
    }
    const view = mockupView(s);
    const boards = view.kind === "boards" ? view.boards : [];
    const shown = shownOf(boards, want ?? s.board);
    const count = view.kind === "boards" ? boards.length : view.kind === "server-down" ? view.count : 0;
    return (
        <div data-rendered-mockup-card className="mt-1 pb-2">
            <ViewSwap swapKey={view.kind}>
                {view.kind === "removed" ? (
                    <RemovedRow topic={s.topic} compact={compact} />
                ) : (
                    <div
                        data-rendered-mockup={view.kind}
                        className="overflow-hidden rounded-[10px] border border-edge-mid bg-surface"
                    >
                        <MockupHead
                            agentId={agent.id}
                            topic={s.topic}
                            count={count}
                            open={shown ?? s.board ?? s.boards[0]?.name ?? null}
                            compact={compact}
                        />
                        <MockupBody
                            agent={agent}
                            view={view}
                            projectDir={s.projectDir}
                            topic={s.topic}
                            shown={shown}
                            onShow={setWant}
                            compact={compact}
                        />
                    </div>
                )}
            </ViewSwap>
        </div>
    );
}
