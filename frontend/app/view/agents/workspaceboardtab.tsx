// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The workspace pane's Board tab (W1, W2): a board tied to this agent, beside its transcript. The header line names
// the board, its agent and its facts, with the drawer's working state; the canvas fills the tab. Beside the transcript
// the last turns show as one line each above the ask box; expanded over the center, the full turns column takes the
// left with the copied replies, and Back to the transcript un-expands the pane. The board's state and actions are
// boardview.tsx's, shared with the Boards surface.

import { useChangeFlash } from "@/app/element/motionhooks";
import { cardVariants, changeFlashClass } from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { BoardAgentChip } from "../boards/boardagentpicker";
import { boardFormAtom } from "../boards/boardformrequest";
import { selectBoard } from "../boards/boardstore";
import { AskBox, BoardTalk, RerouteButton, SMALL_BTN, TEXT_BTN } from "../boards/boardtalk";
import {
    aboutTitle,
    agentChip,
    agentChoices,
    askBox,
    besideLines,
    boardFacts,
    drawerWorking,
    talkItems,
    type BesideLine,
} from "../boards/boardtalkmodel";
import {
    briefingForm,
    Facts,
    LazyBoardCanvas,
    openBoardAgent,
    startBoardAgent,
    useBoardInfo,
    useBoardView,
    type BoardView,
} from "../boards/boardview";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { SurfaceError } from "./surfacescaffold";
import type { WorkspaceTab } from "./workspacemodel";
import { setWorkspaceExpanded } from "./workspacestore";

export function WorkspaceBoardTab({
    model,
    agent,
    tab,
    expanded,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "board" }>;
    expanded: boolean;
}) {
    const { channelId, boardId } = tab;
    const view = useBoardView(channelId, boardId);
    const { board, project } = useBoardInfo(channelId, boardId);
    const agents = useAtomValue(model.agentsAtom);
    const { talk, now } = view;
    const name = board?.name ?? "";
    const loadError = board?.loaderror || view.canvasError;
    const choices = agentChoices(agents, project, talk?.agent?.tabid);
    const ask = askBox(talk, view.selection.label, view.asking, !!loadError);

    // New board from this goes to the Boards surface, where the form is; Keep it here stays
    const onChoice = (turnId: string, choice: "keep" | "new") => {
        if (choice === "keep") {
            view.onKeep(turnId);
            return;
        }
        selectBoard(channelId, boardId);
        globalStore.set(boardFormAtom, briefingForm(channelId, boardId, talk, turnId));
        globalStore.set(model.surfaceAtom, "boards");
    };

    return (
        <div data-board-tab={expanded ? "expanded" : "beside"} className="flex min-h-0 flex-1 flex-col">
            <Header view={view} board={board} name={name} loadError={!!loadError}>
                {talk != null ? (
                    <BoardAgentChip
                        chip={agentChip(talk.agent)}
                        choices={choices}
                        project={project}
                        onPick={view.onSetAgent}
                    />
                ) : null}
            </Header>
            {/* the canvas keeps its place in the tree, so expanding does not remount it */}
            <div className="flex min-h-0 flex-1">
                {expanded && talk != null ? (
                    <BoardTalk
                        about={aboutTitle(talk.about, project)}
                        items={talkItems(talk, now, "expanded")}
                        ask={ask}
                        shownTurnId={view.shownTurnId}
                        onAsk={view.onAsk}
                        onShow={view.onShow}
                        onStop={view.onStop}
                        onRetry={view.onRetry}
                        onChoice={onChoice}
                        onReroute={view.onReroute}
                        onOpenAgent={(tabId) => openBoardAgent(model, tabId)}
                        onBack={() => setWorkspaceExpanded(agent.id, false)}
                        agentChoices={choices}
                        project={project}
                        onPickAgent={view.onSetAgent}
                        onStartAgent={() => startBoardAgent(model, project)}
                    />
                ) : null}
                <div className="flex min-w-0 flex-1 flex-col">
                    <section
                        aria-label={`Board: ${name}`}
                        className="relative min-h-0 flex-1 overflow-hidden bg-background"
                    >
                        {loadError ? (
                            <div data-board-load-error className="pt-3">
                                <SurfaceError
                                    message={`Couldn't open ${name || "this board"}: ${loadError}`}
                                    onRetry={view.retryCanvas}
                                />
                            </div>
                        ) : (
                            <LazyBoardCanvas
                                key={`${boardId}:${view.attempt}`}
                                channelId={channelId}
                                boardId={boardId}
                                controlRef={view.controlRef}
                                onLoaded={view.onScene}
                                onScene={view.onScene}
                                onError={view.onCanvasError}
                                onSelection={view.onSelection}
                            />
                        )}
                    </section>
                    {!expanded ? (
                        <div className="flex-none border-t border-border">
                            {talk != null ? (
                                <Lines
                                    lines={besideLines(talkItems(talk, now, "beside"))}
                                    view={view}
                                    onChoice={onChoice}
                                />
                            ) : null}
                            <AskBox ask={ask} onAsk={view.onAsk} onStop={view.onStop} />
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

// name, the agent chip (children), "N drawings · M shapes · drawn HH:MM", and the drawer at work
function Header({
    view,
    board,
    name,
    loadError,
    children,
}: {
    view: BoardView;
    board: BoardInfo | null;
    name: string;
    loadError: boolean;
    children: ReactNode;
}) {
    const working = drawerWorking(view.talk, view.now);
    return (
        <div
            data-board-tab-header
            className="flex h-[44px] flex-none items-center gap-[10px] whitespace-nowrap border-b border-edge-faint px-[14px]"
        >
            <span data-board-tab-name className="min-w-0 truncate text-[13px] font-semibold text-primary">
                {name}
            </span>
            {children}
            {/* name and facts shrink together, so neither loses its end to the other */}
            <span data-board-facts className="min-w-0 truncate font-mono text-[11px] text-muted">
                {loadError ? (
                    "won't open"
                ) : board != null && view.shapes != null ? (
                    <Facts text={boardFacts(board, view.shapes, view.now)} />
                ) : null}
            </span>
            <span className="flex-1" />
            {working != null ? (
                <span
                    role="status"
                    data-board-drawing
                    className="flex flex-none items-center gap-1.5 text-[11.5px] text-working"
                >
                    {/* the drawer at work pulses (moment 7) */}
                    <span className="pulse-dot h-[6px] w-[6px] rounded-full bg-working" aria-hidden />
                    {working.slow ? "Still drawing" : "Drawing"} · {working.elapsed}
                </span>
            ) : null}
        </div>
    );
}

// the last turns, one line each: one joining enters (moment 1), the oldest leaves and the list reflows (moment 2)
function Lines({
    lines,
    view,
    onChoice,
}: {
    lines: BesideLine[];
    view: BoardView;
    onChoice: (turnId: string, choice: "keep" | "new") => void;
}) {
    if (lines.length === 0) {
        return null;
    }
    return (
        <div data-board-lines className="relative flex flex-col gap-1.5 px-[14px] pt-2.5 text-[12.5px]">
            <AnimatePresence initial={false} mode="popLayout">
                {lines.map((line) => (
                    <motion.div
                        key={line.turnId}
                        layout="position"
                        variants={cardVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        data-board-line={line.turnId}
                        data-board-forward={line.forward}
                        className="flex"
                    >
                        <Line line={line} view={view} onChoice={onChoice} />
                    </motion.div>
                ))}
            </AnimatePresence>
        </div>
    );
}

function Line({
    line,
    view,
    onChoice,
}: {
    line: BesideLine;
    view: BoardView;
    onChoice: (turnId: string, choice: "keep" | "new") => void;
}) {
    // a forward's line changing under you (waiting to sent, sent to answered) washes once (moment 14)
    const flash = useChangeFlash(line.detail);
    const needs = line.forward === "needsagent" || line.asks;
    const shown = view.shownTurnId === line.turnId;
    return (
        <div
            className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-md",
                // a question waiting on an agent, or a request waiting on your choice, breathes (moment 3)
                needs && "pulse-glow border border-warning/40 bg-surface px-2 py-1"
            )}
        >
            <span className="min-w-0 flex-1 truncate text-secondary">
                {line.agent ? <span className="text-muted">the agent asked </span> : null}"{line.text}"{" "}
                <span
                    data-board-line-detail
                    className={cn(
                        "rounded",
                        needs ? "font-semibold text-warning" : "text-muted",
                        flash && changeFlashClass
                    )}
                >
                    {line.detail}
                </span>
            </span>
            {line.shapeIds != null && line.shapeIds.length > 0 ? (
                <button
                    type="button"
                    data-board-show={line.turnId}
                    aria-pressed={shown}
                    onClick={() => view.onShow(line.turnId, line.shapeIds)}
                    className={cn(SMALL_BTN, "flex-none bg-surface", shown && "border-accent text-accent-soft")}
                >
                    Show
                </button>
            ) : null}
            {line.failed ? (
                <button
                    type="button"
                    data-board-retry={line.turnId}
                    onClick={() => view.onRetry(line.turnId)}
                    className={cn(TEXT_BTN, "flex-none text-error-soft hover:text-error")}
                >
                    Retry
                </button>
            ) : null}
            {line.asks ? (
                <span className="flex flex-none gap-3">
                    <button
                        type="button"
                        data-board-choice="new"
                        onClick={() => onChoice(line.turnId, "new")}
                        className={cn(TEXT_BTN, "text-accent-soft hover:text-primary")}
                    >
                        New board from this
                    </button>
                    <button
                        type="button"
                        data-board-choice="keep"
                        onClick={() => onChoice(line.turnId, "keep")}
                        className={cn(TEXT_BTN, "text-muted hover:text-secondary")}
                    >
                        Keep it here
                    </button>
                </span>
            ) : null}
            {line.reroute != null ? (
                <span className="flex-none">
                    <RerouteButton
                        turnId={line.turnId}
                        to={line.reroute}
                        onReroute={() => view.onReroute(line.turnId)}
                    />
                </span>
            ) : null}
        </div>
    );
}
