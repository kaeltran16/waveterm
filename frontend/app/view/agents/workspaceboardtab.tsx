// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The workspace pane's Board tab (W1, W2): a board tied to this agent, beside its transcript. The tab strip names the
// board; the canvas fills the tab, with one ask bar under it (the board's agent, the input, the board's facts). Beside
// the transcript one line above the bar shows the newest turn while it draws, needs you or failed; expanded over the
// center, the full turns column takes the left with the copied replies, and Back to the transcript un-expands the
// pane. The board's state and actions are boardview.tsx's, shared with the Boards surface.

import { useChangeFlash, useLastShown } from "@/app/element/motionhooks";
import { cardVariants, changeFlashClass, composerReveal } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { CircleAlert, Square } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { BoardAgentChip } from "../boards/boardagentpicker";
import { boardFormAtom } from "../boards/boardformrequest";
import { selectBoard } from "../boards/boardstore";
import { BoardTalk, RerouteButton, TEXT_BTN } from "../boards/boardtalk";
import {
    aboutTitle,
    agentChip,
    agentChoices,
    askBox,
    askInput,
    barLine,
    boardFacts,
    talkItems,
    type AskState,
    type BarLine,
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

type OnChoice = (turnId: string, choice: "keep" | "new") => void;

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

    // New board from this goes to the Boards surface, where the form is; Keep it here stays
    const onChoice: OnChoice = (turnId, choice) => {
        if (choice === "keep") {
            view.onKeep(turnId);
            return;
        }
        selectBoard(channelId, boardId);
        globalStore.set(boardFormAtom, briefingForm(channelId, boardId, talk, turnId));
        globalStore.set(model.surfaceAtom, "boards");
    };

    return (
        <div data-board-tab={expanded ? "expanded" : "beside"} className="flex min-h-0 flex-1">
            {/* the canvas keeps its place in the tree, so expanding does not remount it */}
            {expanded && talk != null ? (
                <BoardTalk
                    about={aboutTitle(talk.about, project)}
                    items={talkItems(talk, now, "expanded")}
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
                <div className="flex-none border-t border-border">
                    {/* the turns column shows every turn when expanded, so the line is the beside layout's */}
                    {!expanded ? <TurnLine line={barLine(talk, now)} view={view} onChoice={onChoice} /> : null}
                    <AskBar
                        ask={askBox(talk, view.selection.label, view.asking, !!loadError)}
                        view={view}
                        chip={
                            talk != null ? (
                                <BoardAgentChip
                                    bare
                                    chip={agentChip(talk.agent)}
                                    choices={choices}
                                    project={project}
                                    onPick={view.onSetAgent}
                                />
                            ) : null
                        }
                        facts={
                            loadError ? (
                                "won't open"
                            ) : board != null && view.shapes != null ? (
                                <Facts text={boardFacts(board, view.shapes, now)} />
                            ) : null
                        }
                    />
                </div>
            </div>
        </div>
    );
}

// the newest turn while it is unresolved: it reveals and collapses (moment 6), keeping its last words while it goes
function TurnLine({ line, view, onChoice }: { line: BarLine | null; view: BoardView; onChoice: OnChoice }) {
    const shown = useLastShown(line);
    return (
        <PaneReveal open={line != null} variants={composerReveal}>
            {shown != null ? <TurnLineRow line={shown} view={view} onChoice={onChoice} /> : null}
        </PaneReveal>
    );
}

const DETAIL_TONE: Record<BarLine["state"], string> = {
    drawing: "font-semibold text-working",
    asks: "font-semibold text-warning",
    failed: "font-semibold text-error",
    forward: "text-muted",
};

function TurnLineRow({ line, view, onChoice }: { line: BarLine; view: BoardView; onChoice: OnChoice }) {
    // a line changing state in place washes once (moment 14); keyed on the state, as the seconds tick every second
    const flash = useChangeFlash(line.state);
    const running = line.state === "drawing" && line.elapsed != null;
    return (
        <div className="px-3 pt-2 text-[12.5px]">
            <div
                data-board-bar-line={line.turnId}
                data-board-bar-line-state={line.state}
                className={cn(
                    "flex min-w-0 items-center gap-2 rounded-md",
                    // a request waiting on your choice, or a question waiting on an agent, breathes (moment 3)
                    line.needs && "pulse-glow border border-warning/40 bg-surface px-2 py-1"
                )}
            >
                {line.state === "drawing" ? (
                    // the drawer at work pulses (moment 7); a turn still queued holds a quiet dot
                    <span
                        aria-hidden
                        className={cn(
                            "h-[6px] w-[6px] flex-none rounded-full",
                            running ? "pulse-dot bg-working" : "bg-ink-faint"
                        )}
                    />
                ) : null}
                {line.state === "failed" ? (
                    <CircleAlert size={14} strokeWidth={1.6} aria-label="Error" className="flex-none text-error" />
                ) : null}
                <span role="status" className="min-w-0 flex-1 truncate text-secondary">
                    {line.text ? `"${line.text}" ` : null}
                    <span
                        data-board-bar-line-detail
                        className={cn(
                            "rounded",
                            line.needs ? DETAIL_TONE.asks : DETAIL_TONE[line.state],
                            flash && changeFlashClass
                        )}
                    >
                        {line.detail}
                    </span>
                    {line.elapsed != null ? <span className="text-muted"> · {line.elapsed}</span> : null}
                </span>
                <LineActions line={line} view={view} onChoice={onChoice} />
            </div>
        </div>
    );
}

function LineActions({ line, view, onChoice }: { line: BarLine; view: BoardView; onChoice: OnChoice }) {
    switch (line.state) {
        case "failed":
            return (
                <button
                    type="button"
                    data-board-retry={line.turnId}
                    onClick={() => view.onRetry(line.turnId)}
                    className={cn(TEXT_BTN, "flex-none text-error-soft hover:text-error")}
                >
                    Retry
                </button>
            );
        case "asks":
            return (
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
            );
        case "forward":
            return (
                <span className="flex-none">
                    <RerouteButton turnId={line.turnId} to="draw" onReroute={() => view.onReroute(line.turnId)} />
                </span>
            );
        default:
            return null;
    }
}

// Ask and the Stop that takes its place share a size, so the group doesn't shift between them
const SEND_BTN =
    "inline-flex min-w-16 flex-none items-center justify-center gap-1.5 rounded-lg border-0 px-3 py-[5px] text-[12.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

// the board's agent, one input (the selection chip, the line, Ask or Stop), and the board's facts, which ellipsize first
function AskBar({ ask, view, chip, facts }: { ask: AskState; view: BoardView; chip: ReactNode; facts: ReactNode }) {
    const [text, setText] = useState("");
    const id = useId();
    const input = askInput(ask);
    const empty = text.trim() === "";
    const send = () => {
        if (input.disabled || empty) {
            return;
        }
        view.onAsk(text.trim());
        setText("");
    };
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== "Enter" || e.nativeEvent.isComposing) {
            return;
        }
        e.preventDefault();
        send();
    };
    return (
        <div data-board-ask-bar className="flex items-center gap-[10px] py-2 pl-2.5 pr-3">
            {/* the chip never shrinks with the row, so its label truncates only at the cap, once the group is at its
                200px floor (220px is that floor plus the bar's two gaps); any shared shrink ellipsizes it by a sliver */}
            {chip != null ? <div className="flex min-w-0 max-w-[calc(100%-220px)] shrink-0">{chip}</div> : null}
            <div
                data-board-ask-box
                aria-disabled={input.disabled}
                className={cn(
                    "flex min-w-[200px] flex-[1_1_320px] items-center gap-2 rounded-[10px] border border-edge-mid bg-surface-raised py-[3px] pr-[3px]",
                    input.chip != null ? "pl-2" : "pl-2.5"
                )}
            >
                {/* the selection enters and leaves (moment 1) */}
                <AnimatePresence initial={false}>
                    {input.chip != null ? (
                        <motion.span
                            key="selection"
                            data-board-ask-selection
                            variants={cardVariants}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            className="inline-flex min-w-0 max-w-[60%] flex-none items-center gap-1.5 rounded-md bg-accentbg px-2 py-[3px] text-[12px] text-accent-soft"
                        >
                            <span>Selected</span>
                            <span className="truncate font-mono">{input.chip}</span>
                        </motion.span>
                    ) : null}
                </AnimatePresence>
                <label htmlFor={id} className="sr-only">
                    {ask.placeholder}
                </label>
                <input
                    id={id}
                    type="text"
                    value={text}
                    disabled={input.disabled}
                    placeholder={input.placeholder}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onKeyDown}
                    className="min-w-0 flex-1 truncate border-0 bg-transparent py-1 text-[13.5px] text-primary outline-none placeholder:text-muted disabled:cursor-default"
                />
                {input.stop ? (
                    <button
                        type="button"
                        data-board-ask-stop
                        onClick={view.onStop}
                        className={cn(SEND_BTN, "cursor-pointer bg-edge-mid text-secondary hover:bg-edge-strong")}
                    >
                        <Square size={10} strokeWidth={0} fill="currentColor" aria-hidden />
                        Stop
                    </button>
                ) : (
                    <button
                        type="button"
                        data-board-ask-send
                        disabled={input.disabled}
                        onClick={send}
                        className={cn(
                            SEND_BTN,
                            input.disabled
                                ? "cursor-default bg-edge-mid text-muted"
                                : empty
                                  ? "cursor-pointer bg-edge-mid text-secondary"
                                  : "cursor-pointer bg-accent text-background hover:bg-accenthover"
                        )}
                    >
                        Ask
                    </button>
                )}
            </div>
            {/* the facts get only the room left past the group's 320px, up to their own width, so they empty first */}
            <span
                data-board-facts
                className="min-w-0 max-w-max flex-[1000_1_0px] truncate font-mono text-[11px] text-muted"
            >
                {facts}
            </span>
        </div>
    );
}
