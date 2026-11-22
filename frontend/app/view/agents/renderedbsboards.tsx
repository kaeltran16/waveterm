// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The boards a Rendered card names: useQuestionBoards, the question card's option chips (Main), and MockupCard, one
// row for a canvas with no brainstorm (CanvasEdge), drawn on the agent's last canvas reveal (useCanvasReveal) rather
// than pinned after the transcript. The boards themselves draw in the workspace pane's Canvas tab and the canvas
// window; a card only opens them.

import { ViewSwap } from "@/app/element/viewswap";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUpRight, PanelsTopLeft, SquareDashed } from "lucide-react";
import { useEffect, useState, type JSX, type ReactNode } from "react";
import { openPaneTab } from "./agentpanes";
import type { AgentActionEntry, AgentVM } from "./agentsviewmodel";
import type { BrainstormFile } from "./brainstormmodel";
import { brainstormAtom, openBrainstormAt, type BrainstormState } from "./brainstormstore";
import { boardLabel, updatedAgo } from "./canvasmodel";
import { SERVER_DOWN } from "./canvaspane";
import { canvasStateAtom, openCanvasWindow, selectCanvasTab } from "./canvasstore";
import { CardHead, headIconSize } from "./renderedbrainstorm";
import { COMPACT_CARD_PX } from "./renderedbrainstormmodel";
import {
    boardCount,
    boardsUpdatedMs,
    canvasRevealView,
    mockupView,
    questionChips,
    revealBoard,
    revealedCanvas,
    shownOf,
    type CanvasRevealView,
    type MockupView,
} from "./renderedbsboardsmodel";
import type { TranscriptContext } from "./transcriptcontext";

function BoardChip({ board, onOpen }: { board: string; onOpen: (board: string) => void }) {
    const label = boardLabel(board);
    return (
        <button
            type="button"
            title={`Open ${label} in a window`}
            data-rendered-bs-board-chip={board}
            onClick={() => onOpen(board)}
            className="inline-flex cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-[6px] border border-edge-strong bg-transparent px-2 py-[3px] text-[11.5px] text-ink-mid transition-colors hover:text-secondary"
        >
            <PanelsTopLeft size={11} strokeWidth={2} aria-hidden />
            {label}
        </button>
    );
}

// a chip on each option naming a board, which opens the canvas window on that board. Laid out as the pane's question
// (questionChips)
export function useQuestionBoards(
    agent: AgentVM,
    s: BrainstormState,
    f: BrainstormFile,
    judging: boolean
): { chip: (i: number) => ReactNode | null } {
    const rows = questionChips(
        f,
        s.base,
        s.boards.map((b) => b.name),
        judging
    );
    const chip = (i: number) => {
        const boards = rows?.[i] ?? [];
        if (boards.length === 0) {
            return null;
        }
        return (
            <div className="flex flex-wrap items-center gap-1.5">
                {boards.map((b) => (
                    <BoardChip key={b} board={b} onOpen={(board) => openBrainstormAt(agent.id, { board })} />
                ))}
            </div>
        );
    };
    return { chip };
}

const MARK_TITLE = "Mark part of the board: opens it in a window";
// "updated 40s ago" counts in seconds
const AGO_TICK_MS = 1000;

const LINK =
    "inline-flex cursor-pointer items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 text-[12px] text-accent-soft hover:underline";

// the Canvas tab at a board, beside the transcript
function openCanvasTabAt(agentId: string, board: string): void {
    selectCanvasTab(agentId, board);
    openPaneTab(agentId, "canvas", Date.now());
}

function markBoard(agentId: string, board: string): void {
    openCanvasTabAt(agentId, board);
    openCanvasWindow(agentId, { board, mark: true });
}

function useNow(ms: number): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), ms);
        return () => clearInterval(t);
    }, [ms]);
    return now;
}

// "N boards · updated 40s ago": the count, and (with boards served) when they changed
function MockupStatus({ count, updatedMs }: { count: number; updatedMs: number | null }) {
    const now = useNow(AGO_TICK_MS);
    const ago = updatedAgo(now, updatedMs);
    if (count === 0 && !ago) {
        return null;
    }
    return (
        <span data-rendered-mockup-status className="min-w-0 truncate text-[12px] text-muted">
            {count > 0 ? boardCount(count) : null}
            {count > 0 && ago ? " · " : null}
            {ago ? <span data-rendered-mockup-ago>{ago}</span> : null}
        </span>
    );
}

// the card's header row, the boards' shared one: Mockup, its topic, the status, then (with boards to open) Open canvas
// and, for boards served, Mark. Narrow, the actions take a second line
function MockupHead({
    agentId,
    topic,
    count,
    open,
    updatedMs,
    markable,
    compact,
}: {
    agentId: string;
    topic: string;
    count: number;
    open: string | null;
    updatedMs: number | null;
    markable: boolean;
    compact: boolean;
}) {
    const actions = (
        <span data-rendered-mockup-actions className="flex flex-none items-center gap-[10px]">
            {open != null ? (
                <button
                    type="button"
                    data-rendered-mockup-open
                    onClick={() => openCanvasTabAt(agentId, open)}
                    className={LINK}
                >
                    Open canvas
                    <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
                </button>
            ) : null}
            {markable && open != null ? (
                <button
                    type="button"
                    data-rendered-mockup-mark
                    title={MARK_TITLE}
                    onClick={() => markBoard(agentId, open)}
                    className="flex cursor-pointer items-center gap-1.5 rounded-[7px] border border-edge-mid bg-surface-raised px-2.5 py-1 text-[12px] font-semibold text-primary hover:border-edge-strong"
                >
                    <SquareDashed size={13} strokeWidth={2} aria-hidden />
                    Mark
                </button>
            ) : null}
        </span>
    );
    return (
        <div data-rendered-mockup-head>
            <CardHead
                icon={<PanelsTopLeft size={headIconSize(compact)} strokeWidth={2} aria-hidden />}
                kind="Mockup"
                subject={topic}
                mono
                compact={compact}
            >
                <MockupStatus count={count} updatedMs={markable ? updatedMs : null} />
                {compact ? (
                    open != null ? (
                        <div className="flex basis-full items-center">{actions}</div>
                    ) : null
                ) : (
                    <>
                        <span className="flex-1" />
                        {actions}
                    </>
                )}
            </CardHead>
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

// the explanation under the row while there is nothing to open; boards served have only the row
function MockupBody({ view }: { view: MockupView }) {
    switch (view.kind) {
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
        default:
            return null;
    }
}

// the standalone Mockup card, for an agent with a canvas and no brainstorm: one row once boards are served, or why
// they can't show. It measures its own width, since the narrow column it stacks in is the Rendered view's, not a
// card-width host's
export function MockupCard({ agentId, compact }: { agentId: string; compact: boolean }): JSX.Element | null {
    const s = useAtomValue(canvasStateAtom(agentId));
    const [measure, , rect] = useDimensionsWithCallbackRef<HTMLDivElement>();
    if (s == null) {
        return null;
    }
    const narrow = compact || (rect != null && rect.width < COMPACT_CARD_PX);
    const view = mockupView(s);
    const boards = view.kind === "boards" ? view.boards : [];
    const shown = shownOf(boards, s.board);
    const count = view.kind === "boards" ? boards.length : view.kind === "server-down" ? view.count : 0;
    return (
        <div ref={measure} data-rendered-mockup-card data-compact={narrow ? "" : undefined}>
            <ViewSwap swapKey={view.kind}>
                {view.kind === "removed" ? (
                    <RemovedRow topic={s.topic} compact={narrow} />
                ) : (
                    <div
                        data-rendered-mockup={view.kind}
                        className="overflow-hidden rounded-[10px] border border-edge-mid bg-surface"
                    >
                        <MockupHead
                            agentId={agentId}
                            topic={s.topic}
                            count={count}
                            open={shown ?? s.board ?? s.boards[0]?.name ?? null}
                            updatedMs={boardsUpdatedMs(s)}
                            markable={view.kind === "boards"}
                            compact={narrow}
                        />
                        <MockupBody view={view} />
                    </div>
                )}
            </ViewSwap>
        </div>
    );
}

// how a `wsh ui reveal canvas:` row draws (canvasRevealView), and the board an earlier one's Open canvas opens. Hooks
// before the checks, since the row is drawn by every transcript host and only the Rendered view sets canvasReveal
export function useCanvasReveal(
    ctx: TranscriptContext,
    action: AgentActionEntry,
    address: string
): { view: CanvasRevealView; board: string | null } {
    const id = ctx.agentId ?? "";
    const s = useAtomValue(canvasStateAtom(id));
    const bs = useAtomValue(brainstormAtom(id));
    const named = revealedCanvas(address);
    if (ctx.canvasReveal == null || ctx.agentId == null || named == null) {
        return { view: "row", board: null };
    }
    const latest = ctx.canvasReveal === action;
    const view = canvasRevealView({ latest, topic: named.topic, canvas: s, brainstorm: bs != null });
    return { view, board: view === "row-open" && s != null ? revealBoard(s, named.board) : null };
}

// an earlier reveal's way back to the canvas, the Mockup card's Open canvas
export function OpenCanvasLink({ agentId, board }: { agentId: string; board: string | null }) {
    if (board == null) {
        return null;
    }
    return (
        <button
            type="button"
            data-reveal-open-canvas
            title={`Open ${boardLabel(board)} in the Canvas tab`}
            onClick={() => openCanvasTabAt(agentId, board)}
            className={LINK}
        >
            Open canvas
            <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
        </button>
    );
}
