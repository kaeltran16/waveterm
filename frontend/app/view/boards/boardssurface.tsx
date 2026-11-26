// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Boards surface (boards B1-B12, A2): a board draws what you ask, and sends a question to the board's agent. The
// turns lead on the left, the board (plain Excalidraw) fills the rest, the header's board name switches between the
// project's boards (every project's under "All projects"), and its agent chip picks the board's agent. The open
// board's state and actions are boardview.tsx's.
// An ask form (new, about a thing, a handoff, a briefing) takes the talk column's place until it asks. The project
// is the one a router landing named, else the cockpit's current one, else under "All projects" the one with the latest
// board; a switcher change made while Boards shows replaces a landing's. What must outlive a surface switch lives in
// boardstore.ts.

import { palettePickChannel } from "@/app/cockpit/palette-data";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { Shapes } from "lucide-react";
import { MotionConfig } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentsViewModel } from "../agents/agents";
import { activeChannelAtom } from "../agents/channelsstore";
import { projectListAtom, rowsWithChannel } from "../agents/projectsstore";
import { SurfaceEmptyState, SurfaceError, SurfaceToolbar } from "../agents/surfacescaffold";
import { openTarget } from "../jarvis/openref";
import { BoardAgentChip } from "./boardagentpicker";
import { BoardAskForm, NewBoardDialog, startsWithLines, type BoardAskFormProps } from "./boardaskform";
import { boardFormAtom, type BoardFormRequest } from "./boardformrequest";
import { copyElements } from "./boardmodel";
import {
    boardListAtom,
    boardsChannelAtom,
    loadBoardList,
    openBoardByChannelAtom,
    selectBoard,
    setBoardFormEscape,
    setOpenBoard,
} from "./boardstore";
import { BoardStrip } from "./boardstrip";
import { BoardSwitcher } from "./boardswitcher";
import { BoardTalk } from "./boardtalk";
import {
    aboutLine,
    aboutTitle,
    agentChip,
    agentChoices,
    askBox,
    boardFacts,
    latestBoardChannel,
    switcherGroups,
    talkItems,
    type SwitcherList,
} from "./boardtalkmodel";
import {
    act,
    briefingForm,
    errorText,
    Facts,
    LazyBoardCanvas,
    openBoardAgent,
    startBoardAgent,
    useBoardView,
} from "./boardview";

const PROJECT_ABOUT: BoardSource = { kind: "project", ref: "", title: "" };

// "All projects" with no project to follow opens the project whose board was active last, picked once per mount so a
// board drawn in another project does not pull the view away; undefined while the lists load
function useLatestBoardChannel(enabled: boolean): Channel | null | undefined {
    const rows = rowsWithChannel(useAtomValue(projectListAtom));
    const key = rows.map((r) => r.channel.oid).join(",");
    const [picked, setPicked] = useState<{ key: string; id: string | null } | null>(null);
    const pickedId = picked?.key === key ? picked.id : undefined;
    useEffect(() => {
        if (!enabled || pickedId !== undefined) {
            return;
        }
        let live = true;
        const ids = rows.map((r) => r.channel.oid);
        const unread = ids.filter((id) => globalStore.get(boardListAtom(id)) == null);
        Promise.allSettled(unread.map((id) => loadBoardList(id))).then((results) => {
            results.forEach((r, i) => {
                if (r.status === "rejected") {
                    console.warn("boards: listing failed", unread[i], r.reason);
                }
            });
            if (live) {
                const lists = ids.map((id) => ({
                    channelId: id,
                    boards: globalStore.get(boardListAtom(id))?.boards ?? [],
                }));
                setPicked({ key, id: latestBoardChannel(lists) });
            }
        });
        return () => {
            live = false;
        };
    }, [enabled, pickedId, key]);
    if (pickedId === undefined) {
        return undefined;
    }
    return rows.find((r) => r.channel.oid === pickedId)?.channel ?? null;
}

// the explicit project a landing named, else the switcher's project, else the active or only one, else under "All
// projects" the one with the latest board; undefined while that is being found
function useBoardsChannel(model: AgentsViewModel): Channel | null | undefined {
    const explicit = useAtomValue(boardsChannelAtom);
    const filter = useAtomValue(model.projectFilterAtom);
    const rows = useAtomValue(projectListAtom);
    const active = useAtomValue(activeChannelAtom);
    const followed =
        explicit == null
            ? (rows.find((r) => r.name === filter)?.channel ?? palettePickChannel(active, rows, null))
            : null;
    const latest = useLatestBoardChannel(explicit == null && followed == null && filter === "all");
    // starts at the value Boards arrives with, so only a change made while Boards shows unpins a landing's project;
    // "All projects" names nothing to follow
    const prevFilterRef = useRef(filter);
    useEffect(() => {
        const prev = prevFilterRef.current;
        prevFilterRef.current = filter;
        if (filter !== prev && filter !== "all") {
            globalStore.set(boardsChannelAtom, null);
        }
    }, [filter]);
    if (explicit != null) {
        return rows.find((r) => r.channel?.oid === explicit)?.channel ?? ({ oid: explicit, name: "" } as Channel);
    }
    return followed ?? (filter === "all" ? latest : null);
}

// the switcher's lists: every project's under "All projects", else the open project's alone
function useSwitcherLists(model: AgentsViewModel, channelId: string | null, project: string): SwitcherList[] {
    const filter = useAtomValue(model.projectFilterAtom);
    const rows = useAtomValue(projectListAtom);
    const others = filter === "all" ? rowsWithChannel(rows).filter((r) => r.channel.oid !== channelId) : [];
    const key = others.map((r) => r.channel.oid).join(",");
    useEffect(() => {
        for (const r of others) {
            loadBoardList(r.channel.oid).catch((e) => console.warn("boards: listing failed", r.name, e));
        }
    }, [key]);
    const listsAtom = useMemo(
        () =>
            atom((get) => {
                const lists: SwitcherList[] = [];
                if (channelId != null) {
                    lists.push({ channelId, project, boards: get(boardListAtom(channelId))?.boards ?? [] });
                }
                for (const r of others) {
                    const list = get(boardListAtom(r.channel.oid));
                    if (list != null) {
                        lists.push({ channelId: r.channel.oid, project: list.project || r.name, boards: list.boards });
                    }
                }
                return lists;
            }),
        [channelId, project, key]
    );
    return useAtomValue(listsAtom);
}

function openBoardTarget(model: AgentsViewModel, channelId: string, boardId: string): void {
    fireAndForget(() => openTarget(model, { kind: "board", channelId, boardId }));
}

interface OpenForm {
    req: BoardFormRequest;
    // a fresh form per request, so its fields start from the request's
    key: number;
}

export function BoardsSurface({ model }: { model: AgentsViewModel }) {
    const channel = useBoardsChannel(model);
    const channelId = channel?.oid ?? null;
    const list = useAtomValue(boardListAtom(channelId ?? ""));
    const openMap = useAtomValue(openBoardByChannelAtom);
    const request = useAtomValue(boardFormAtom);
    const agents = useAtomValue(model.agentsAtom);
    const [form, setForm] = useState<OpenForm | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    const formKeyRef = useRef(0);

    const boards = list?.boards ?? [];
    const project = list?.project || channel?.name || "this project";
    const openId = channelId != null ? (openMap[channelId] ?? null) : null;
    const board = boards.find((b) => b.id === openId) ?? null;
    const switcherLists = useSwitcherLists(model, channelId, project);
    const view = useBoardView(channelId, board?.id ?? null);
    const { talk, now, controlRef } = view;

    const openForm = (req: BoardFormRequest) => setForm({ req, key: ++formKeyRef.current });
    const closeForm = () => setForm(null);

    // a form asked for from anywhere (the palette, a toast) opens here, once
    useEffect(() => {
        if (request != null) {
            openForm(request);
            globalStore.set(boardFormAtom, null);
        }
    }, [request]);

    // an open form's Cancel is what Escape means, even with focus on its buttons
    const formOpen = form != null;
    useEffect(() => {
        if (!formOpen) {
            return;
        }
        setBoardFormEscape(closeForm);
        return () => setBoardFormEscape(null);
    }, [formOpen]);

    const reloadList = () => {
        if (channelId == null) {
            return;
        }
        loadBoardList(channelId).then(
            () => setListError(null),
            (e) => setListError(errorText(e))
        );
    };
    useEffect(reloadList, [channelId]);

    // a project opens on its most recently active board
    useEffect(() => {
        if (channelId != null && list != null && board == null && boards.length > 0) {
            setOpenBoard(channelId, boards[0].id);
        }
    }, [channelId, list, board, boards[0]?.id]);

    const loadError = board?.loaderror || view.canvasError;
    const shapesNow = view.shapes;
    const choices = agentChoices(agents, project, talk?.agent?.tabid);

    const onRetryBoard = () => {
        view.retryCanvas();
        reloadList();
    };

    const onChoice = (turnId: string, choice: "keep" | "new") => {
        if (channelId == null || board == null) {
            return;
        }
        if (choice === "keep") {
            view.onKeep(turnId);
            return;
        }
        openForm(briefingForm(channelId, board.id, talk, turnId));
    };

    // Ask on a form makes the board (its first turn starts when there is a question), then opens it
    const startBoard = async (req: BoardFormRequest, about: BoardSource, name: string, question: string) => {
        if (channelId == null) {
            return;
        }
        const data: CommandBoardStartData = { channelid: channelId, name, question: question || undefined, about };
        if (req.kind === "handoff") {
            data.fromboardid = req.fromBoardId;
            data.elements = JSON.stringify(copyElements(controlRef.current?.elements() ?? []));
        }
        const info = await RpcApi.BoardStartCommand(TabRpcClient, data);
        if (req.kind === "briefing") {
            act("record the move to a new board", () =>
                RpcApi.BoardAskChoiceCommand(TabRpcClient, {
                    channelid: channelId,
                    boardid: req.fromBoardId,
                    turnid: req.turnId,
                    choice: "new",
                })
            );
        }
        await loadBoardList(channelId).catch((e) => console.warn("boards: reloading the list failed", e));
        closeForm();
        // a board about a claude or pi agent is tied to it, so it opens where that agent's boards do
        if (req.kind === "about" && req.about.kind === "agent") {
            openBoardTarget(model, channelId, info.id);
            return;
        }
        setOpenBoard(channelId, info.id);
    };

    // a pick here stays here, tied or not; the palette and the agent's own opens go through the router
    const pickBoard = (ch: string, id: string) => {
        if (ch === channelId) {
            setOpenBoard(ch, id);
        } else {
            selectBoard(ch, id);
        }
    };

    let header: ReactNode = <span className="text-[12px] text-muted">{channelId != null ? project : null}</span>;
    let actions: ReactNode = null;
    let body: ReactNode;
    if (channel === undefined) {
        body = null;
    } else if (channelId == null) {
        body = (
            <SurfaceEmptyState
                glyph={<Shapes size={28} strokeWidth={1.8} aria-hidden className="mb-[18px] text-ink-faint" />}
                title="No project to keep boards in"
                body="Boards belong to a project. Pick or add one in the project switcher, then come back."
            />
        );
    } else if (listError != null && list == null) {
        body = <SurfaceError message={`Couldn't list the boards in ${project}: ${listError}`} onRetry={reloadList} />;
    } else if (list != null && boards.length === 0 && form == null) {
        body = (
            <NoBoards
                project={project}
                onAsk={(name, question) => startBoard({ kind: "new", channelId }, PROJECT_ABOUT, name, question)}
            />
        );
    } else if (list != null) {
        const req = form?.req ?? null;
        const fromBoard = req?.kind === "handoff" ? boards.find((b) => b.id === req.fromBoardId) : undefined;
        if (req != null) {
            header = (
                <>
                    <Slash />
                    <span className="text-[13.5px] font-semibold text-secondary">New board</span>
                    <span className="text-[12px] text-muted">
                        {fromBoard != null ? `from ${fromBoard.name}` : `in ${project}`}
                    </span>
                </>
            );
        } else if (board != null) {
            header = (
                <>
                    <Slash />
                    <BoardSwitcher
                        name={board.name}
                        openId={board.id}
                        groups={switcherGroups(switcherLists, channelId, now)}
                        onPick={pickBoard}
                        onAskNew={() => openForm({ kind: "new", channelId })}
                    />
                    <span data-board-facts className="text-[12px] text-muted">
                        {loadError ? (
                            "won't open"
                        ) : shapesNow != null ? (
                            <Facts text={boardFacts(board, shapesNow, now, view.drawings)} />
                        ) : null}
                    </span>
                    {talk != null ? (
                        <BoardAgentChip
                            chip={agentChip(talk.agent)}
                            choices={choices}
                            project={project}
                            onPick={view.onSetAgent}
                        />
                    ) : null}
                </>
            );
            const empty = (board.questions ?? 0) === 0 && (shapesNow ?? 0) === 0;
            actions = (
                <button
                    type="button"
                    data-board-handoff
                    disabled={!!loadError || empty}
                    onClick={() => openForm({ kind: "handoff", channelId, fromBoardId: board.id })}
                    className="cursor-pointer rounded-lg border border-edge-mid bg-surface-raised px-[11px] py-[5px] text-[12.5px] font-semibold text-secondary hover:border-edge-strong hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:text-ink-faint disabled:hover:border-edge-mid disabled:hover:bg-surface-raised"
                >
                    New board from this
                </button>
            );
        }
        // a handoff keeps the board it copies on the canvas; every other form waits on an empty one
        const showCanvas = board != null && (req == null || req.kind === "handoff");
        let column: ReactNode = null;
        if (req != null) {
            const props = formProps(req, project, fromBoard, talk, shapesNow ?? 0);
            column = (
                <BoardAskForm
                    key={form.key}
                    {...props.form}
                    onAsk={(name, question) => startBoard(req, props.about, name, question)}
                    onCancel={closeForm}
                />
            );
        } else if (board != null && talk != null) {
            column = (
                <BoardTalk
                    about={aboutTitle(talk.about, project)}
                    items={talkItems(talk, now, "surface")}
                    ask={askBox(talk, view.selection.label, view.asking, !!loadError, view.editing)}
                    shownTurnId={view.shownTurnId}
                    onAsk={view.onAsk}
                    onShow={view.onShow}
                    onStop={view.onStop}
                    onRetry={view.onRetry}
                    onChoice={onChoice}
                    onReroute={view.onReroute}
                    onOpenAgent={(tabId) => openBoardAgent(model, tabId)}
                    agentChoices={choices}
                    project={project}
                    onPickAgent={view.onSetAgent}
                    onStartAgent={() => startBoardAgent(model, project)}
                />
            );
        } else {
            column = <aside className="w-[400px] shrink-0 border-r border-border bg-surface" />;
        }
        body = (
            <div className="flex min-h-0 flex-1">
                {column}
                <div className="flex min-w-0 flex-1 flex-col">
                    {showCanvas && !loadError ? <BoardStrip boardId={board.id} onPick={view.onPickDrawing} /> : null}
                    <section
                        aria-label={board != null && showCanvas ? `Board: ${board.name}` : "Board"}
                        className="relative min-h-0 flex-1 overflow-hidden bg-background"
                    >
                        {!showCanvas ? (
                            req != null ? (
                                <div
                                    data-board-canvas-waiting
                                    className="absolute inset-0 flex items-center justify-center"
                                >
                                    <span className="text-[13px] text-muted">The drawer draws here once you ask.</span>
                                </div>
                            ) : null
                        ) : loadError ? (
                            <LoadError board={board} reason={loadError} onRetry={onRetryBoard} />
                        ) : (
                            <LazyBoardCanvas
                                key={`${board.id}:${view.attempt}`}
                                channelId={channelId}
                                boardId={board.id}
                                controlRef={controlRef}
                                onLoaded={view.onScene}
                                onScene={view.onScene}
                                onError={view.onCanvasError}
                                onSelection={view.onSelection}
                            />
                        )}
                        {showCanvas && !loadError && req == null && shapesNow === 0 ? <EmptyBoard /> : null}
                    </section>
                </div>
            </div>
        );
    }

    return (
        <MotionConfig reducedMotion="user">
            <div data-boards-surface className="flex h-full min-h-0 flex-col bg-background">
                <SurfaceToolbar title="Boards" actions={actions}>
                    {header}
                </SurfaceToolbar>
                {body}
            </div>
        </MotionConfig>
    );
}

// what the column form says for each request, and the About the new board starts from
function formProps(
    req: BoardFormRequest,
    project: string,
    fromBoard: BoardInfo | undefined,
    talk: BoardTalk | null,
    shapes: number
): { form: Omit<BoardAskFormProps, "variant" | "onAsk" | "onCancel">; about: BoardSource } {
    const aboutOf = (about: BoardSource) => ({
        title: aboutTitle(about, project),
        line: aboutLine(about),
        runtime: about.runtime,
    });
    switch (req.kind) {
        case "about":
            return { form: { title: "Ask a board about this", about: aboutOf(req.about) }, about: req.about };
        case "handoff": {
            // the board handed over is the open one, so its talk is the one loaded
            const about = talk?.boardid === req.fromBoardId ? talk.about : PROJECT_ABOUT;
            const name = fromBoard?.name ?? "this board";
            return {
                form: {
                    title: `New board from ${name}`,
                    about: aboutOf(about),
                    startsWith: startsWithLines(name, fromBoard?.questions ?? 0, shapes),
                },
                about,
            };
        }
        case "briefing":
            return {
                form: { title: "Ask something new", about: aboutOf(req.about), initialQuestion: req.ask },
                about: req.about,
            };
        default:
            return { form: { title: "Ask something new", about: aboutOf(PROJECT_ABOUT) }, about: PROJECT_ABOUT };
    }
}

function Slash() {
    return <span className="text-[13px] text-ink-faint">/</span>;
}

function Kbd({ children }: { children: string }) {
    return (
        <span className="rounded-[5px] border border-edge-mid px-1.5 py-px font-mono text-[11px] text-ink-mid">
            {children}
        </span>
    );
}

// the shared empty state, as Cockpit's "No agents running"; New board opens the dialog
function NoBoards({ project, onAsk }: { project: string; onAsk: (name: string, question: string) => Promise<void> }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <SurfaceEmptyState
                data={{ "data-boards-empty": "" }}
                glyph={<Shapes size={30} strokeWidth={1.8} aria-hidden className="mb-[18px] text-accent-soft" />}
                title={`No boards in ${project} yet`}
                body="A board is where your agent's explanations get drawn. Ask about a choice, the code or the architecture: the drawer draws it, and a question for the agent goes to the board's agent."
                action={{
                    label: "New board",
                    onClick: () => setOpen(true),
                    data: { "data-boards-new": "" },
                    hint: (
                        <span data-boards-empty-hint>
                            or press <Kbd>Ctrl K</Kbd> on an agent, run or initiative and choose Ask a board about this…
                        </span>
                    ),
                }}
            />
            <NewBoardDialog open={open} project={project} onAsk={onAsk} onClose={() => setOpen(false)} />
        </>
    );
}

function LoadError({ board, reason, onRetry }: { board: BoardInfo; reason: string; onRetry: () => void }) {
    return (
        <div data-board-load-error>
            <SurfaceError
                message={`Couldn't open ${board.name}: ${reason}. Arc has not changed the file.`}
                onRetry={onRetry}
            />
            <div className="mx-[28px] mt-3.5 flex flex-col gap-1.5 text-[12.5px] text-ink-mid">
                <span>The file:</span>
                <span className="self-start rounded-md border border-edge-mid bg-surface-raised px-[9px] py-1.5 font-mono text-[12px] text-secondary">
                    {board.path}
                </span>
                <span>Fix or restore it, then Retry. The drawer can't answer on this board until it opens.</span>
            </div>
        </div>
    );
}

function EmptyBoard() {
    return (
        <div data-board-empty className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex max-w-[420px] flex-col items-center gap-2.5 text-center">
                <Shapes size={28} strokeWidth={1.8} aria-hidden className="text-ink-faint" />
                <span className="text-[15px] font-semibold text-secondary">Nothing on this board yet</span>
                <span className="text-[13px] leading-[1.6] text-muted">
                    Press Edit to draw on it, or ask the drawer on the left.
                </span>
            </div>
        </div>
    );
}
