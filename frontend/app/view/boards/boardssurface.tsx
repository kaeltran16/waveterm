// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Boards surface (boards B1-B12): a board is a conversation with a drawer. The talk column leads on the left,
// the board (plain Excalidraw) fills the rest, and the header's board name switches between the project's boards
// (every project's under "All projects").
// An ask form (new, about a thing, a handoff, a briefing) takes the talk column's place until it asks. The project
// is the one a router landing named, else the cockpit's current one; a switcher change made while Boards shows
// replaces a landing's. What must outlive a surface switch lives in boardstore.ts.

import { pushToast } from "@/app/cockpit/notificationstore";
import { palettePickChannel } from "@/app/cockpit/palette-data";
import { TickNumber } from "@/app/element/ticknumber";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { Shapes } from "lucide-react";
import { MotionConfig } from "motion/react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentsViewModel } from "../agents/agents";
import { activeChannelAtom } from "../agents/channelsstore";
import { projectListAtom, rowsWithChannel } from "../agents/projectsstore";
import { SurfaceEmptyState, SurfaceError, SurfaceToolbar } from "../agents/surfacescaffold";
import { BoardAskForm, NewBoardDialog, startsWithLines, type BoardAskFormProps } from "./boardaskform";
import type { BoardCanvasControl } from "./boardcanvas";
import { boardFormAtom, type BoardFormRequest } from "./boardformrequest";
import { copyElements, selectionLabel, shapeCount, type BoardScene } from "./boardmodel";
import {
    boardListAtom,
    boardsChannelAtom,
    boardTalkAtom,
    loadBoardList,
    loadBoardTalk,
    openBoardByChannelAtom,
    selectBoard,
    setBoardFormEscape,
} from "./boardstore";
import { BoardSwitcher } from "./boardswitcher";
import { BoardTalk } from "./boardtalk";
import {
    aboutLine,
    aboutTitle,
    askBox,
    boardFacts,
    switcherGroups,
    talkItems,
    type SwitcherList,
} from "./boardtalkmodel";

// vite.config.ts (excalidrawFonts) serves Excalidraw's fonts from the app, under this path's fonts/
const EXCALIDRAW_ASSET_PATH = "/excalidraw/";
const TICK_MS = 1000;
const PROJECT_ABOUT: BoardSource = { kind: "project", ref: "", title: "" };
const COUNT_FACT = /^(\d+) (.+)$/;

const BoardCanvas = lazy(() => {
    (window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
    return import("./boardcanvas");
});

function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// the explicit project a landing named, else the switcher's project, else the active or only one
function useBoardsChannel(model: AgentsViewModel): Channel | null {
    const explicit = useAtomValue(boardsChannelAtom);
    const filter = useAtomValue(model.projectFilterAtom);
    const rows = useAtomValue(projectListAtom);
    const active = useAtomValue(activeChannelAtom);
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
    return rows.find((r) => r.name === filter)?.channel ?? palettePickChannel(active, rows, null);
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

// re-renders every second while active: the answering turn's elapsed time and its 90 s switch to slow
function useTick(active: boolean): void {
    const [, setTick] = useState(0);
    useEffect(() => {
        if (!active) {
            return;
        }
        const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
        return () => clearInterval(timer);
    }, [active]);
}

// the open board, without pinning the project as a landing does
function setOpenBoard(channelId: string, boardId: string): void {
    globalStore.set(openBoardByChannelAtom, (prev) => ({ ...prev, [channelId]: boardId }));
}

function act(what: string, fn: () => Promise<unknown>): void {
    fireAndForget(async () => {
        try {
            await fn();
        } catch (e) {
            pushToast({ title: `Couldn't ${what}`, message: errorText(e), level: "error" });
        }
    });
}

function inFlight(talk: BoardTalk | null): boolean {
    return (talk?.turns ?? []).some((t) => t.state === "answering" || t.state === "waiting");
}

interface OpenForm {
    req: BoardFormRequest;
    // a fresh form per request, so its fields start from the request's
    key: number;
}

interface Selection {
    ids: string[];
    label: string | null;
}

const NO_SELECTION: Selection = { ids: [], label: null };

export function BoardsSurface({ model }: { model: AgentsViewModel }) {
    const channel = useBoardsChannel(model);
    const channelId = channel?.oid ?? null;
    const list = useAtomValue(boardListAtom(channelId ?? ""));
    const openMap = useAtomValue(openBoardByChannelAtom);
    const request = useAtomValue(boardFormAtom);
    const [form, setForm] = useState<OpenForm | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    const [canvasError, setCanvasError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [shapes, setShapes] = useState<{ boardId: string; count: number } | null>(null);
    const [selection, setSelection] = useState<Selection>(NO_SELECTION);
    const [shown, setShown] = useState<{ turnId: string; ids: string[] } | null>(null);
    const [asking, setAsking] = useState(false);
    const controlRef = useRef<BoardCanvasControl | null>(null);
    const formKeyRef = useRef(0);

    const boards = list?.boards ?? [];
    const project = list?.project || channel?.name || "this project";
    const openId = channelId != null ? (openMap[channelId] ?? null) : null;
    const board = boards.find((b) => b.id === openId) ?? null;
    const switcherLists = useSwitcherLists(model, channelId, project);
    const talkValue = useAtomValue(boardTalkAtom(board?.id ?? ""));
    const talk = talkValue != null && talkValue.boardid === board?.id ? talkValue : null;
    useTick(inFlight(talk));
    const now = Date.now();

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

    useEffect(() => {
        setCanvasError(null);
        setShapes(null);
        setSelection(NO_SELECTION);
        setShown(null);
        if (channelId != null && board != null) {
            loadBoardTalk(channelId, board.id).catch((e) =>
                console.warn("boards: reading the talk failed", board.id, e)
            );
        }
    }, [channelId, board?.id]);

    const loadError = board?.loaderror || canvasError;
    const shapesNow = shapes != null && shapes.boardId === board?.id ? shapes.count : null;

    const onScene = (boardId: string, scene: BoardScene) => setShapes({ boardId, count: shapeCount(scene.elements) });
    const onSelection = (ids: string[]) => {
        setSelection(
            ids.length === 0 ? NO_SELECTION : { ids, label: selectionLabel(controlRef.current?.elements() ?? [], ids) }
        );
        // Show is on only while the selection is what it selected
        setShown((prev) =>
            prev != null && (ids.length === 0 || ids.some((id) => !prev.ids.includes(id))) ? null : prev
        );
    };
    const onRetryBoard = () => {
        setCanvasError(null);
        setAttempt((n) => n + 1);
        reloadList();
    };

    const ref = channelId != null && board != null ? { channelid: channelId, boardid: board.id } : null;
    const onAsk = (question: string) => {
        if (ref == null) {
            return;
        }
        act("ask the drawer", async () => {
            setAsking(true);
            try {
                await controlRef.current?.flush();
                await RpcApi.BoardAskCommand(TabRpcClient, {
                    ...ref,
                    question,
                    on: selection.label ?? undefined,
                    selectedids: selection.ids.length > 0 ? selection.ids : undefined,
                });
                await loadBoardTalk(ref.channelid, ref.boardid);
            } finally {
                setAsking(false);
            }
        });
    };
    const onShow = (turnId: string, ids: string[]) => {
        if (shown?.turnId === turnId) {
            controlRef.current?.show([]);
            setShown(null);
            return;
        }
        controlRef.current?.show(ids);
        setShown({ turnId, ids });
    };
    const onStop = () => {
        if (ref != null) {
            act("stop the answer", () => RpcApi.BoardAskStopCommand(TabRpcClient, ref));
        }
    };
    const onRetry = (turnId: string) => {
        if (ref != null) {
            act("retry", () => RpcApi.BoardAskRetryCommand(TabRpcClient, { ...ref, turnid: turnId }));
        }
    };
    const onChoice = (turnId: string, choice: "keep" | "new") => {
        if (ref == null) {
            return;
        }
        if (choice === "keep") {
            act("keep it here", () => RpcApi.BoardAskChoiceCommand(TabRpcClient, { ...ref, turnid: turnId, choice }));
            return;
        }
        const briefing = talk?.turns.find((t) => t.id === turnId)?.briefing;
        openForm({
            kind: "briefing",
            channelId: ref.channelid,
            fromBoardId: ref.boardid,
            turnId,
            about: { kind: "briefing", ref: "", title: briefing?.from ?? "", text: briefing?.text },
            ask: briefing?.ask ?? "",
        });
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
        setOpenBoard(channelId, info.id);
    };

    let header: ReactNode = <span className="text-[12px] text-muted">{channelId != null ? project : null}</span>;
    let actions: ReactNode = null;
    let body: ReactNode;
    if (channelId == null) {
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
                        onPick={(ch, id) => (ch === channelId ? setOpenBoard(ch, id) : selectBoard(ch, id))}
                        onAskNew={() => openForm({ kind: "new", channelId })}
                    />
                    <span data-board-facts className="text-[12px] text-muted">
                        {loadError ? (
                            "won't open"
                        ) : shapesNow != null ? (
                            <Facts text={boardFacts(board, shapesNow, now)} />
                        ) : null}
                    </span>
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
                    items={talkItems(talk, now)}
                    ask={askBox(talk, board.name, selection.label, asking, !!loadError)}
                    shownTurnId={shown?.turnId ?? null}
                    onAsk={onAsk}
                    onShow={onShow}
                    onStop={onStop}
                    onRetry={onRetry}
                    onChoice={onChoice}
                />
            );
        } else {
            column = <aside className="w-[400px] shrink-0 border-r border-border bg-surface" />;
        }
        body = (
            <div className="flex min-h-0 flex-1">
                {column}
                <section
                    aria-label={board != null && showCanvas ? `Board: ${board.name}` : "Board"}
                    className="relative min-w-0 flex-1 overflow-hidden bg-background"
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
                        <Suspense fallback={null}>
                            <BoardCanvas
                                key={`${board.id}:${attempt}`}
                                channelId={channelId}
                                boardId={board.id}
                                controlRef={controlRef}
                                onLoaded={(s) => onScene(board.id, s)}
                                onScene={(s) => onScene(board.id, s)}
                                onError={setCanvasError}
                                onSelection={onSelection}
                            />
                        </Suspense>
                    )}
                    {showCanvas && !loadError && req == null && shapesNow === 0 ? <EmptyBoard /> : null}
                </section>
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

// "2 questions · 14 shapes · answered 15:20": each count rolls when it changes (moment 12)
function Facts({ text }: { text: string }) {
    return (
        <>
            {text.split(" · ").map((fact, i) => {
                const m = COUNT_FACT.exec(fact);
                return (
                    <span key={i}>
                        {i > 0 ? " · " : null}
                        {m != null ? (
                            <>
                                <TickNumber value={Number(m[1])} /> {m[2]}
                            </>
                        ) : (
                            fact
                        )}
                    </span>
                );
            })}
        </>
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
                body="A board is a conversation with a drawer. Ask about a choice, the code or the architecture, and it answers in a few words and a drawing you can keep asking about."
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
                    Draw on it with the tools above, or ask the drawer on the left.
                </span>
            </div>
        </div>
    );
}
