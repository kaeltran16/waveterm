// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// One open board, wherever it renders (the Boards surface, an agent's workspace tab): its talk, the canvas's
// selection and Show, and the actions on it (ask, stop, retry, the briefing's choice, send the other way, the
// board's agent), with the lazily loaded canvas. What must outlive an unmount lives in boardstore.ts.

import { pushToast } from "@/app/cockpit/notificationstore";
import { TickNumber } from "@/app/element/ticknumber";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { lazy, Suspense, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AgentsViewModel } from "../agents/agents";
import { openTarget } from "../jarvis/openref";
import type { BoardCanvasControl, BoardCanvasProps } from "./boardcanvas";
import type { BoardFormRequest } from "./boardformrequest";
import { selectionLabel, shapeCount, type BoardScene } from "./boardmodel";
import { boardListAtom, boardTalkAtom, loadBoardList, loadBoardTalk } from "./boardstore";

// vite.config.ts (excalidrawFonts) serves Excalidraw's fonts from the app, under this path's fonts/
const EXCALIDRAW_ASSET_PATH = "/excalidraw/";
const TICK_MS = 1000;
const COUNT_FACT = /^(\d+) (.+)$/;

const BoardCanvas = lazy(() => {
    (window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
    return import("./boardcanvas");
});

// the canvas, loaded with Excalidraw on first use
export function LazyBoardCanvas(props: BoardCanvasProps) {
    return (
        <Suspense fallback={null}>
            <BoardCanvas {...props} />
        </Suspense>
    );
}

export function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export function act(what: string, fn: () => Promise<unknown>): void {
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

export interface BoardSelection {
    ids: string[];
    label: string | null;
}

const NO_SELECTION: BoardSelection = { ids: [], label: null };

export interface BoardView {
    talk: BoardTalk | null; // null until the open board's talk is read
    now: number;
    selection: BoardSelection;
    shownTurnId: string | null;
    asking: boolean;
    shapes: number | null; // the canvas's shapes, once it has loaded
    canvasError: string | null;
    attempt: number; // a canvas retry remounts it
    controlRef: MutableRefObject<BoardCanvasControl | null>;
    onScene: (scene: BoardScene) => void;
    onCanvasError: (message: string) => void;
    onSelection: (ids: string[]) => void;
    retryCanvas: () => void;
    onAsk: (question: string) => void;
    onShow: (turnId: string, ids: string[]) => void;
    onStop: () => void;
    onRetry: (turnId: string) => void;
    onKeep: (turnId: string) => void; // the briefing's Keep it here; New board from this is the caller's form
    onReroute: (turnId: string) => void;
    onSetAgent: (tabId: string) => void;
}

export function useBoardView(channelId: string | null, boardId: string | null): BoardView {
    const [canvasError, setCanvasError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [shapes, setShapes] = useState<{ boardId: string; count: number } | null>(null);
    const [selection, setSelection] = useState<BoardSelection>(NO_SELECTION);
    const [shown, setShown] = useState<{ turnId: string; ids: string[] } | null>(null);
    const [asking, setAsking] = useState(false);
    const controlRef = useRef<BoardCanvasControl | null>(null);

    const talkValue = useAtomValue(boardTalkAtom(boardId ?? ""));
    const talk = talkValue != null && talkValue.boardid === boardId ? talkValue : null;
    useTick(inFlight(talk));

    useEffect(() => {
        setCanvasError(null);
        setShapes(null);
        setSelection(NO_SELECTION);
        setShown(null);
        if (channelId != null && boardId != null) {
            loadBoardTalk(channelId, boardId).catch((e) => console.warn("boards: reading the talk failed", boardId, e));
        }
    }, [channelId, boardId]);

    const ref = channelId != null && boardId != null ? { channelid: channelId, boardid: boardId } : null;
    const onTurn = (what: string, turnId: string, call: (d: CommandBoardTurnData) => Promise<unknown>) => {
        if (ref != null) {
            act(what, () => call({ ...ref, turnid: turnId }));
        }
    };

    return {
        talk,
        now: Date.now(),
        selection,
        shownTurnId: shown?.turnId ?? null,
        asking,
        shapes: shapes != null && shapes.boardId === boardId ? shapes.count : null,
        canvasError,
        attempt,
        controlRef,
        onScene: (scene) => {
            if (boardId != null) {
                setShapes({ boardId, count: shapeCount(scene.elements) });
            }
        },
        onCanvasError: setCanvasError,
        onSelection: (ids) => {
            setSelection(
                ids.length === 0
                    ? NO_SELECTION
                    : { ids, label: selectionLabel(controlRef.current?.elements() ?? [], ids) }
            );
            // Show is on only while the selection is what it selected
            setShown((prev) =>
                prev != null && (ids.length === 0 || ids.some((id) => !prev.ids.includes(id))) ? null : prev
            );
        },
        retryCanvas: () => {
            setCanvasError(null);
            setAttempt((n) => n + 1);
        },
        onAsk: (question) => {
            if (ref == null) {
                return;
            }
            act("ask the board", async () => {
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
        },
        onShow: (turnId, ids) => {
            if (shown?.turnId === turnId) {
                controlRef.current?.show([]);
                setShown(null);
                return;
            }
            controlRef.current?.show(ids);
            setShown({ turnId, ids });
        },
        onStop: () => {
            if (ref != null) {
                act("stop the answer", () => RpcApi.BoardAskStopCommand(TabRpcClient, ref));
            }
        },
        onRetry: (turnId) => onTurn("retry", turnId, (d) => RpcApi.BoardAskRetryCommand(TabRpcClient, d)),
        onKeep: (turnId) =>
            onTurn("keep it here", turnId, (d) => RpcApi.BoardAskChoiceCommand(TabRpcClient, { ...d, choice: "keep" })),
        onReroute: (turnId) =>
            onTurn("send it the other way", turnId, (d) => RpcApi.BoardRerouteCommand(TabRpcClient, d)),
        onSetAgent: (tabId) => {
            if (ref != null) {
                act("change the board's agent", () =>
                    RpcApi.BoardSetAgentCommand(TabRpcClient, { ...ref, tabid: tabId })
                );
            }
        },
    };
}

// the board's list entry (its name and facts) and its project's name, read with the project's list; null ids read
// nothing, so a caller can hold the hook unconditionally
export function useBoardInfo(
    channelId: string | null,
    boardId: string | null
): { board: BoardInfo | null; project: string } {
    const list = useAtomValue(boardListAtom(channelId ?? ""));
    useEffect(() => {
        if (channelId != null) {
            loadBoardList(channelId).catch((e) => console.warn("boards: listing failed", channelId, e));
        }
    }, [channelId]);
    return { board: list?.boards.find((b) => b.id === boardId) ?? null, project: list?.project ?? "" };
}

// "2 drawings · 14 shapes · drawn 15:20": each count rolls when it changes (moment 12)
export function Facts({ text }: { text: string }) {
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

// New board from this on an agent's request that asks where it goes: the form on the request
export function briefingForm(
    channelId: string,
    boardId: string,
    talk: BoardTalk | null,
    turnId: string
): BoardFormRequest {
    const briefing = talk?.turns.find((t) => t.id === turnId)?.briefing;
    return {
        kind: "briefing",
        channelId,
        fromBoardId: boardId,
        turnId,
        about: { kind: "briefing", ref: "", title: briefing?.from ?? "", text: briefing?.text },
        ask: briefing?.ask ?? "",
    };
}

// Open agent on a replied turn: the agent, through the router
export function openBoardAgent(model: AgentsViewModel, tabId: string): void {
    fireAndForget(() => openTarget(model, { kind: "agent", tabId }));
}

// Start an agent on a turn that needs one (decision 16): the New agent dialog over this surface, on the board's
// project. The new agent is not tied and nothing is sent to it until it is picked.
export function startBoardAgent(model: AgentsViewModel, project: string): void {
    globalStore.set(model.newAgentProjectAtom, project);
    globalStore.set(model.newAgentOpenAtom, true);
}
