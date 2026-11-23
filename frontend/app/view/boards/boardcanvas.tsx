// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The open board: plain Excalidraw over the board file, in view mode unless the board's Edit switch is on. It loads
// the file, autosaves your edits under the rev it read, and takes the drawer's answers live (registerLiveBoard), so an
// answer landing while you edit goes through updateScene instead of overwriting the file under you. The view follows
// the newest drawing while it is the one in view: a new drawing landing then is fitted, and otherwise marked new.
// Loaded lazily by the Boards surface: Excalidraw's runtime is ~2 MB.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import "./boardcanvas.css";
import { landAnswer } from "./boardconvert";
import { drawingInView, drawingsOf, isFrame } from "./boarddrawings";
import { parseBoardFile, serializeBoard, wrapEarlier, type BoardScene } from "./boardmodel";
import {
    boardDrawingsAtom,
    boardEditingAtom,
    boardViewportAtom,
    registerBoardEscape,
    registerLiveBoard,
    type BoardDrawings,
    type BoardViewport,
} from "./boardstore";

const AUTOSAVE_MS = 500;
const SAVE_TRIES = 3;
// a fitted drawing covers this share of the view, so its edges and title clear the canvas's edge
const FIT_VIEW_SHARE = 0.9;
// a small drawing is fitted at its drawn size, not blown up
const FIT_MAX_ZOOM = 1;

// what the surface drives on the canvas
export interface BoardCanvasControl {
    // selects exactly these shapes and scrolls to them (decision 7); [] clears the selection
    show(ids: string[]): void;
    // saves a pending autosave now, so the drawer reads the board as you see it
    flush(): Promise<void>;
    elements(): readonly ExcalidrawElement[];
    // moves the view to that drawing, fitted
    fitDrawing(id: string): void;
}

export interface BoardCanvasProps {
    channelId: string;
    boardId: string;
    controlRef: MutableRefObject<BoardCanvasControl | null>;
    onLoaded: (scene: BoardScene) => void;
    onScene: (scene: BoardScene) => void;
    onError: (message: string) => void;
    onSelection: (ids: string[]) => void;
}

// changes when an element is added, removed or edited; Excalidraw bumps version on every edit
function elementsSig(elements: readonly ExcalidrawElement[]): string {
    let sum = 0;
    for (const el of elements) {
        sum += el.version;
    }
    return `${elements.length}:${sum}`;
}

function ownsEscape(appState: AppState): boolean {
    return Object.keys(appState.selectedElementIds).length > 0 || appState.activeTool.type !== "selection";
}

function selectedIds(appState: AppState): string[] {
    return Object.entries(appState.selectedElementIds)
        .filter(([, on]) => on)
        .map(([id]) => id);
}

interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
    reject: (e: unknown) => void;
}

function deferred(): Deferred {
    let resolve: () => void = () => {};
    let reject: (e: unknown) => void = () => {};
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
}

function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function sameRow(a: BoardDrawings | null, b: BoardDrawings): boolean {
    return (
        a != null &&
        a.inView === b.inView &&
        a.fresh.join(",") === b.fresh.join(",") &&
        a.drawings.length === b.drawings.length &&
        a.drawings.every(
            (d, i) => d.id === b.drawings[i].id && d.n === b.drawings[i].n && d.title === b.drawings[i].title
        )
    );
}

// how the canvas opens: a board left following (or opened for the first time) fits its newest drawing, any other
// returns to where it was left; one with neither scrolls to its content
interface Opening {
    fit: string | null;
    viewport: BoardViewport | null;
}

function opening(scene: BoardScene, viewport: BoardViewport | null): Opening {
    const newest = drawingsOf(scene.elements).at(-1)?.id ?? null;
    const fit = viewport == null || viewport.following ? newest : null;
    return { fit, viewport: fit == null ? viewport : null };
}

export default function BoardCanvas({
    channelId,
    boardId,
    controlRef,
    onLoaded,
    onScene,
    onError,
    onSelection,
}: BoardCanvasProps) {
    const [initial, setInitial] = useState<BoardScene | null>(null);
    const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
    // the file as last read or saved: its arc record, appState and files ride along with Excalidraw's elements
    const sceneRef = useRef<BoardScene | null>(null);
    const revRef = useRef("");
    const sigRef = useRef("");
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const savingRef = useRef<Promise<void>>(Promise.resolve());
    const ownsEscapeRef = useRef(false);
    const escapeRef = useRef<ReturnType<typeof registerBoardEscape> | null>(null);
    const selectionRef = useRef("");
    // the latest callbacks, so the long-lived handlers below never call a stale render's
    const cbRef = useRef({ onLoaded, onScene, onError, onSelection });
    cbRef.current = { onLoaded, onScene, onError, onSelection };
    // settles once the scene is in Excalidraw; an answer that arrives before then waits for it
    const readyRef = useRef<Deferred | null>(null);
    const editing = useAtomValue(boardEditingAtom(boardId));
    const editingRef = useRef(editing);
    // read once as the file loads, so the first render and the first frame agree on it
    const openingRef = useRef<Opening>({ fit: null, viewport: null });
    // the load wrapped an old board's shapes in an "Earlier drawings" frame, saved once the canvas has it
    const wrappedRef = useRef(false);
    // as of the last change: the drawing in view, and whether it is the newest
    const inViewRef = useRef<string | null>(null);
    const followingRef = useRef(true);
    // the first frame has placed the view where the board opens; until then a change shows no drawing in view
    const openedRef = useRef(false);

    const ref = { channelid: channelId, boardid: boardId };

    function current(): BoardScene {
        const api = apiRef.current;
        const scene = sceneRef.current;
        if (api == null || scene == null) {
            throw new Error("the board is not open");
        }
        return { ...scene, elements: api.getSceneElementsIncludingDeleted(), files: api.getFiles() as BinaryFiles };
    }

    // one save at a time, in order; the canvas holds your edits, so a conflict takes the file's new rev and
    // writes again rather than dropping them (every answer reaches an open board through this canvas)
    function save(): Promise<void> {
        const run = savingRef.current.then(async () => {
            const scene = current();
            sigRef.current = elementsSig(scene.elements);
            const data = serializeBoard(scene);
            for (let i = 0; i < SAVE_TRIES; i++) {
                const saved = await RpcApi.BoardSaveCommand(TabRpcClient, { ...ref, data, baserev: revRef.current });
                if (!saved?.conflict) {
                    revRef.current = saved?.rev ?? revRef.current;
                    cbRef.current.onScene(scene);
                    return;
                }
                console.warn(
                    "boards: the board file changed under the open canvas; saving the canvas over it",
                    boardId
                );
                const read = await RpcApi.BoardReadCommand(TabRpcClient, ref);
                revRef.current = read.rev;
            }
            throw new Error(`the board changed under ${SAVE_TRIES} saves in a row`);
        });
        savingRef.current = run.catch(() => {});
        return run;
    }

    // a pending autosave runs now; otherwise the save in flight, if any, finishes
    function flush(): Promise<void> {
        if (timerRef.current == null) {
            return savingRef.current;
        }
        clearTimeout(timerRef.current);
        timerRef.current = null;
        return save();
    }

    function show(ids: string[]): void {
        const api = apiRef.current;
        if (api == null) {
            return;
        }
        const idSet = new Set(ids);
        const shown = api.getSceneElements().filter((el) => idSet.has(el.id));
        api.updateScene({
            appState: {
                selectedElementIds: Object.fromEntries(shown.map((el) => [el.id, true as const])),
                selectedGroupIds: {},
                editingGroupId: null,
            },
            captureUpdate: CaptureUpdateAction.NEVER,
        });
        if (shown.length > 0) {
            api.scrollToContent(shown, { animate: true });
        }
    }

    function fitDrawing(id: string): void {
        const api = apiRef.current;
        const frame = api?.getSceneElements().find((el) => el.id === id && isFrame(el));
        if (frame == null) {
            return;
        }
        api.scrollToContent(frame, {
            fitToViewport: true,
            viewportZoomFactor: FIT_VIEW_SHARE,
            maxZoom: FIT_MAX_ZOOM,
            animate: false,
        });
    }

    // the drawings row, the drawing in view and following, from the scene and view as they are now. A hidden
    // canvas (its tab off-screen) has no view, so it leaves them as the shown one set them
    function publishView(elements: readonly ExcalidrawElement[], appState: AppState): void {
        if (appState.width === 0 || appState.height === 0) {
            return;
        }
        const drawings = drawingsOf(elements);
        const inView = drawingInView(drawings, {
            scrollX: appState.scrollX,
            scrollY: appState.scrollY,
            zoom: appState.zoom.value,
            width: appState.width,
            height: appState.height,
        });
        const following = drawings.length === 0 || inView === drawings.at(-1).id;
        inViewRef.current = inView;
        followingRef.current = following;
        const vpAtom = boardViewportAtom(boardId);
        const vp = globalStore.get(vpAtom);
        if (
            vp?.scrollX !== appState.scrollX ||
            vp?.scrollY !== appState.scrollY ||
            vp?.zoom !== appState.zoom.value ||
            vp?.following !== following
        ) {
            globalStore.set(vpAtom, {
                scrollX: appState.scrollX,
                scrollY: appState.scrollY,
                zoom: appState.zoom.value,
                following,
            });
        }
        const rowAtom = boardDrawingsAtom(boardId);
        const prev = globalStore.get(rowAtom);
        const ids = new Set(drawings.map((d) => d.id));
        const row: BoardDrawings = {
            drawings: drawings.map(({ id, n, title }) => ({ id, n, title })),
            inView,
            fresh: (prev?.fresh ?? []).filter((id) => id !== inView && ids.has(id)),
        };
        if (!sameRow(prev, row)) {
            globalStore.set(rowAtom, row);
        }
    }

    function markFresh(id: string): void {
        globalStore.set(boardDrawingsAtom(boardId), (prev) =>
            prev == null || prev.fresh.includes(id) ? prev : { ...prev, fresh: [...prev.fresh, id] }
        );
    }

    function clearSelectionAndTool(): void {
        const api = apiRef.current;
        if (api == null) {
            return;
        }
        api.setActiveTool({ type: "selection" });
        api.updateScene({
            appState: { selectedElementIds: {}, selectedGroupIds: {}, editingGroupId: null },
            captureUpdate: CaptureUpdateAction.NEVER,
        });
    }

    // turning Edit off leaves nothing selected and no tool armed
    useEffect(() => {
        const was = editingRef.current;
        editingRef.current = editing;
        if (was && !editing) {
            clearSelectionAndTool();
        }
    }, [editing]);

    useEffect(() => {
        let cancelled = false;
        const ready = deferred();
        readyRef.current = ready;
        // registered before the read, so no answer can reach the file between this read and the first save.
        // the whole answer is one updateScene, so one undo takes it back (decision 6)
        const unregister = registerLiveBoard(channelId, boardId, async (answer) => {
            await ready.promise;
            const api = apiRef.current;
            if (api == null) {
                throw new Error("the board is not open");
            }
            const before = current();
            const had = new Set(drawingsOf(before.elements).map((d) => d.id));
            // as the person left the view: landing a drawing changes which one is newest
            const following = followingRef.current;
            const inView = inViewRef.current;
            const { scene, shapeIds, drawingId } = landAnswer(before, answer, Date.now());
            api.updateScene({ elements: scene.elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
            if (!had.has(drawingId)) {
                if (following) {
                    fitDrawing(drawingId);
                } else {
                    markFresh(drawingId);
                }
            } else if (drawingId === inView) {
                // an edit may have grown the drawing in view; one out of view stays out of it
                fitDrawing(drawingId);
            }
            await save();
            return shapeIds;
        });
        controlRef.current = {
            show,
            flush: () => flush().catch((e) => console.warn("boards: saving before an ask failed", boardId, e)),
            elements: () => apiRef.current?.getSceneElements() ?? [],
            fitDrawing,
        };
        ownsEscapeRef.current = false;
        const escape = registerBoardEscape(clearSelectionAndTool);
        escapeRef.current = escape;
        (async () => {
            try {
                const read = await RpcApi.BoardReadCommand(TabRpcClient, ref);
                const parsed = parseBoardFile(read.data);
                if (cancelled) {
                    return;
                }
                const scene = wrapEarlier(parsed, Date.now());
                wrappedRef.current = scene !== parsed;
                openingRef.current = opening(scene, globalStore.get(boardViewportAtom(boardId)));
                revRef.current = read.rev;
                sceneRef.current = scene;
                setInitial(scene);
            } catch (e) {
                ready.reject(e);
                if (!cancelled) {
                    cbRef.current.onError(errorText(e));
                }
            }
        })();
        return () => {
            cancelled = true;
            if (timerRef.current != null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
                save().catch((e) => console.warn("boards: autosave failed", boardId, e));
            }
            unregister();
            controlRef.current = null;
            escape.unregister();
            escapeRef.current = null;
            ready.reject(new Error("the board closed"));
        };
    }, [channelId, boardId]);

    function onApi(api: ExcalidrawImperativeAPI): void {
        apiRef.current = api;
        if (sceneRef.current == null) {
            return;
        }
        // Excalidraw hands the api over before it has restored the initial scene
        requestAnimationFrame(() => {
            if (openingRef.current.fit != null) {
                fitDrawing(openingRef.current.fit);
            }
            readyRef.current?.resolve();
            const scene = current();
            sigRef.current = elementsSig(scene.elements);
            openedRef.current = true;
            publishView(scene.elements, api.getAppState());
            cbRef.current.onLoaded(scene);
            if (wrappedRef.current) {
                wrappedRef.current = false;
                save().catch((e) => console.warn("boards: saving the earlier drawings' frame failed", boardId, e));
            }
        });
    }

    function onChange(elements: readonly ExcalidrawElement[], appState: AppState): void {
        const ids = selectedIds(appState);
        const selection = ids.join(",");
        if (selection !== selectionRef.current) {
            selectionRef.current = selection;
            cbRef.current.onSelection(ids);
        }
        const owns = ownsEscape(appState);
        if (owns !== ownsEscapeRef.current) {
            ownsEscapeRef.current = owns;
            escapeRef.current?.setOwns(owns);
        }
        if (openedRef.current) {
            publishView(elements, appState);
        }
        const sig = elementsSig(elements);
        if (sigRef.current === "" || sig === sigRef.current || sceneRef.current == null) {
            sigRef.current = sigRef.current || sig;
            return;
        }
        sigRef.current = sig;
        if (timerRef.current != null) {
            clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            save().catch((e) => console.warn("boards: autosave failed", boardId, e));
        }, AUTOSAVE_MS);
    }

    if (initial == null) {
        return null;
    }
    const { fit, viewport } = openingRef.current;
    return (
        <div className="arc-board absolute inset-0" data-board-canvas={boardId}>
            <Excalidraw
                excalidrawAPI={onApi}
                onChange={onChange}
                theme="dark"
                // controlled, so only the Edit switch changes it (Excalidraw's own toggle is disabled)
                viewModeEnabled={!editing}
                initialData={{
                    elements: initial.elements as ExcalidrawElement[],
                    files: initial.files as BinaryFiles,
                    appState: {
                        // transparent: the dark theme inverts the canvas's own colour, so the board's `background`
                        // comes from boardcanvas.css instead
                        viewBackgroundColor: "transparent",
                        ...(viewport != null
                            ? { scrollX: viewport.scrollX, scrollY: viewport.scrollY, zoom: { value: viewport.zoom } }
                            : {}),
                    } as Partial<AppState>,
                    scrollToContent: viewport == null && fit == null,
                }}
                UIOptions={{
                    canvasActions: {
                        changeViewBackgroundColor: false,
                        clearCanvas: false,
                        export: false,
                        loadScene: false,
                        saveToActiveFile: false,
                        saveAsImage: false,
                        toggleTheme: false,
                    },
                }}
            />
        </div>
    );
}
