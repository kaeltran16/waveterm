// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Boards surface (boards F8, N1, N2, D2, E1): a project's boards in a list, the open one unfolded into its
// sources, and the board itself as plain Excalidraw. The project is the one a router landing named, else the
// cockpit's current one. What must outlive a surface switch lives in boardstore.ts.

import { pushToast } from "@/app/cockpit/notificationstore";
import { palettePickChannel } from "@/app/cockpit/palette-data";
import { TickNumber } from "@/app/element/ticknumber";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Shapes } from "lucide-react";
import { MotionConfig } from "motion/react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { AgentsViewModel } from "../agents/agents";
import { activeChannelAtom } from "../agents/channelsstore";
import { projectListAtom } from "../agents/projectsstore";
import { SurfaceEmptyState, SurfaceError, SurfaceToolbar } from "../agents/surfacescaffold";
import type { BoardCanvasControl } from "./boardcanvas";
import { boardTime, headerFacts, sourceRows, yourShapesLabel, type BoardScene } from "./boardmodel";
import { BoardsList } from "./boardslist";
import {
    boardListAtom,
    boardsChannelAtom,
    boardStatusAtom,
    loadBoardList,
    loadBoardStatus,
    openBoardByChannelAtom,
    useBoardFollows,
} from "./boardstore";

// vite.config.ts (excalidrawFonts) serves Excalidraw's fonts from the app, under this path's fonts/
const EXCALIDRAW_ASSET_PATH = "/excalidraw/";

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
    if (explicit != null) {
        return rows.find((r) => r.channel?.oid === explicit)?.channel ?? ({ oid: explicit, name: "" } as Channel);
    }
    return rows.find((r) => r.name === filter)?.channel ?? palettePickChannel(active, rows, null);
}

// the open board, without pinning the project as a landing does
function setOpenBoard(channelId: string, boardId: string): void {
    globalStore.set(openBoardByChannelAtom, (prev) => ({ ...prev, [channelId]: boardId }));
}

interface OpenScene {
    boardId: string;
    scene: BoardScene;
    seenAtOpen: number;
}

function liveCount(scene: BoardScene): number {
    return scene.elements.filter((el) => !el.isDeleted).length;
}

function FollowChip({ text, drawing }: { text: string; drawing: boolean }) {
    return (
        <span data-board-follow-chip className="flex items-center gap-[7px] text-[12px] text-secondary">
            <span className={`h-[7px] w-[7px] shrink-0 rounded-full bg-working ${drawing ? "pulse-dot" : ""}`} />
            {text}
        </span>
    );
}

export function BoardsSurface({ model }: { model: AgentsViewModel }) {
    const channel = useBoardsChannel(model);
    const channelId = channel?.oid ?? null;
    const list = useAtomValue(boardListAtom(channelId ?? ""));
    const openMap = useAtomValue(openBoardByChannelAtom);
    const [listError, setListError] = useState<string | null>(null);
    const [naming, setNaming] = useState(false);
    const [folded, setFolded] = useState(false);
    const [canvasError, setCanvasError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [open, setOpen] = useState<OpenScene | null>(null);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const controlRef = useRef<BoardCanvasControl | null>(null);

    const boards = list?.boards ?? [];
    const project = list?.project || channel?.name || "this project";
    const openId = channelId != null ? (openMap[channelId] ?? null) : null;
    const board = boards.find((b) => b.id === openId) ?? null;
    const status = useAtomValue(boardStatusAtom(board?.id ?? ""));
    const follows = useBoardFollows(model, board?.id ?? "");

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

    // a project opens on its most recently drawn board
    useEffect(() => {
        if (channelId != null && list != null && board == null && boards.length > 0) {
            setOpenBoard(channelId, boards[0].id);
        }
    }, [channelId, list, board, boards[0]?.id]);

    useEffect(() => {
        setOpen(null);
        setCanvasError(null);
        setSelectedKey(null);
        setFolded(false);
        if (channelId != null && board != null) {
            loadBoardStatus(channelId, board.id).catch((e) =>
                console.warn("boards: reading the scribe's status failed", board.id, e)
            );
        }
    }, [channelId, board?.id]);

    const now = Date.now();
    const loadError = board?.loaderror || canvasError;
    const scene = open != null && open.boardId === board?.id ? open : null;

    const onPickBoard = (boardId: string) => {
        if (channelId == null) {
            return;
        }
        if (boardId === board?.id) {
            setFolded((f) => !f);
            return;
        }
        setOpenBoard(channelId, boardId);
    };
    const onCreate = async (name: string) => {
        if (channelId == null) {
            return;
        }
        const info = await RpcApi.BoardCreateCommand(TabRpcClient, { channelid: channelId, name });
        await loadBoardList(channelId);
        setNaming(false);
        setOpenBoard(channelId, info.id);
    };
    const onRetryBoard = () => {
        setCanvasError(null);
        setAttempt((n) => n + 1);
        reloadList();
    };
    const act = (what: string, fn: () => Promise<unknown>) =>
        fireAndForget(async () => {
            try {
                await fn();
            } catch (e) {
                pushToast({ title: `Couldn't ${what}`, message: errorText(e), level: "error" });
            }
        });

    let body;
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
    } else if (list != null && boards.length === 0 && !naming) {
        body = (
            <SurfaceEmptyState
                data={{ "data-boards-empty": "" }}
                glyph={<Shapes size={28} strokeWidth={1.8} aria-hidden className="mb-[18px] text-ink-faint" />}
                title={`No boards in ${project} yet`}
                body="A board is a canvas you name and keep: an idea, an area of the code, a bug. Draw on it yourself, or have the scribe draw what an agent, run or initiative explains."
                action={{
                    label: (
                        <>
                            <span className="text-[18px] leading-none">+</span>New board
                        </>
                    ),
                    onClick: () => setNaming(true),
                    data: { "data-new-board-button": "" },
                    hint: (
                        <>
                            Or open the palette on an agent (<Kbd>Ctrl K</Kbd>) and choose Draw on a board…, which can
                            make one too.
                        </>
                    ),
                }}
            />
        );
    } else if (list != null) {
        const arc = scene?.scene.arc;
        const drawnTs = Object.fromEntries((arc?.sources ?? []).map((s) => [s.key, s.drawnts]));
        const empty = scene != null && liveCount(scene.scene) === 0;
        body = (
            <div className="flex min-h-0 flex-1">
                <BoardsList
                    project={project}
                    boards={boards}
                    openId={board?.id ?? null}
                    folded={folded}
                    naming={naming}
                    now={now}
                    onPickBoard={onPickBoard}
                    onNewBoard={() => setNaming(true)}
                    onCreate={onCreate}
                    onCancelNaming={() => setNaming(false)}
                    tree={{
                        rows: arc != null ? sourceRows(arc, status?.sources ?? [], scene.seenAtOpen, now) : [],
                        drawnTs,
                        follows,
                        yourShapes: scene != null ? yourShapesLabel(scene.scene.elements) : null,
                        empty,
                        selectedKey,
                        now,
                        onPick: (key) => {
                            setSelectedKey(key);
                            controlRef.current?.select(key);
                        },
                        onKeep: (key) => act("keep the redraw", () => controlRef.current?.keep(key)),
                        onDrop: (key) => act("drop the redraw", () => controlRef.current?.drop(key)),
                        onRetry: (key) =>
                            act("retry the draw", () =>
                                RpcApi.BoardRetryCommand(TabRpcClient, {
                                    channelid: channelId,
                                    boardid: board.id,
                                    sourcekey: key,
                                })
                            ),
                        onStop: (tabId) =>
                            act("stop following", () => RpcApi.BoardFollowStopCommand(TabRpcClient, { tabid: tabId })),
                    }}
                />
                <section
                    aria-label={board != null ? `Board: ${board.name}` : "Board"}
                    className="relative min-w-0 flex-1 overflow-hidden bg-background"
                >
                    {board != null && loadError ? (
                        <div data-board-load-error>
                            <SurfaceError
                                message={`Couldn't open ${board.name}: ${loadError}. Arc has not changed the file.`}
                                onRetry={onRetryBoard}
                            />
                            <div className="mx-[28px] mt-3.5 flex flex-col gap-1.5 text-[12.5px] text-ink-mid">
                                <span>The file:</span>
                                <span className="self-start rounded-md border border-edge-mid bg-surface-raised px-[9px] py-1.5 font-mono text-[12px] text-secondary">
                                    {board.path}
                                </span>
                                <span>Fix or restore it, then Retry. Nothing draws on this board until it opens.</span>
                            </div>
                        </div>
                    ) : board != null ? (
                        <Suspense fallback={null}>
                            <BoardCanvas
                                key={`${board.id}:${attempt}`}
                                channelId={channelId}
                                boardId={board.id}
                                controlRef={controlRef}
                                onLoaded={(s, seenAtOpen, selected) => {
                                    setOpen({ boardId: board.id, scene: s, seenAtOpen });
                                    setSelectedKey(selected);
                                }}
                                onScene={(s) =>
                                    setOpen((prev) => (prev?.boardId === board.id ? { ...prev, scene: s } : prev))
                                }
                                onError={setCanvasError}
                                onDeselect={() => setSelectedKey(null)}
                            />
                        </Suspense>
                    ) : null}
                    {empty && !loadError ? <EmptyBoard /> : null}
                </section>
            </div>
        );
    }

    return (
        <MotionConfig reducedMotion="user">
            <div data-boards-surface className="flex h-full min-h-0 flex-col bg-background">
                <SurfaceToolbar
                    title="Boards"
                    actions={<HeaderFollow follows={follows} status={status} hasBoard={board != null} />}
                >
                    {board != null && !(list != null && boards.length === 0) ? (
                        <>
                            <span className="text-[13px] text-ink-faint">/</span>
                            <span className="text-[13.5px] font-semibold text-secondary">{board.name}</span>
                            <span data-board-facts className="text-[12px] text-muted">
                                {loadError ? (
                                    "won't open"
                                ) : scene != null ? (
                                    <BoardFacts scene={scene} createdTs={board.createdts} now={now} />
                                ) : null}
                            </span>
                        </>
                    ) : (
                        <span className="text-[12px] text-muted">{channelId != null ? project : null}</span>
                    )}
                </SurfaceToolbar>
                {body}
            </div>
        </MotionConfig>
    );
}

function Kbd({ children }: { children: string }) {
    return (
        <span className="rounded-[5px] border border-edge-mid px-1.5 py-px font-mono text-[11px] text-ink-mid">
            {children}
        </span>
    );
}

// "4 groups · 1 new since you looked · last drawn 16:04"; the group count rolls when a draw lands (moment 12)
function BoardFacts({ scene, createdTs, now }: { scene: OpenScene; createdTs: number; now: number }) {
    const arc = scene.scene.arc;
    const groups = arc.sources?.length ?? 0;
    if (groups === 0 && liveCount(scene.scene) === 0) {
        return <>empty · created {boardTime(createdTs, now)}</>;
    }
    const rest = headerFacts(arc, scene.seenAtOpen, now).split(" · ").slice(1);
    return (
        <>
            <TickNumber value={groups} /> {groups === 1 ? "group" : "groups"}
            {rest.map((fact) => ` · ${fact}`).join("")}
        </>
    );
}

function HeaderFollow({
    follows,
    status,
    hasBoard,
}: {
    follows: { agentName: string }[];
    status: BoardStatusData | null;
    hasBoard: boolean;
}) {
    if (!hasBoard) {
        return null;
    }
    const drawing = (status?.sources ?? []).some((s) => s.state === "drawing");
    if (follows.length === 0) {
        return drawing ? <FollowChip text="Scribe drawing" drawing /> : null;
    }
    const who = follows.length === 1 ? follows[0].agentName : `${follows.length} agents`;
    return <FollowChip text={drawing ? `Scribe drawing · following ${who}` : `Following ${who}`} drawing={drawing} />;
}

function EmptyBoard() {
    return (
        <div data-board-empty className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex max-w-[420px] flex-col items-center gap-2.5 text-center">
                <Shapes size={28} strokeWidth={1.8} aria-hidden className="text-ink-faint" />
                <span className="text-[15px] font-semibold text-secondary">Nothing on this board yet</span>
                <span className="text-[13px] leading-[1.6] text-muted">
                    Draw on it with the tools above, or have the scribe fill it: on any agent, run or initiative, open
                    the palette (<Kbd>Ctrl K</Kbd>) and choose Draw on a board…
                </span>
            </div>
        </div>
    );
}
