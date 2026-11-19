// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The open board: plain Excalidraw over the board file. It loads the file, autosaves your edits under the rev it
// read, and takes the drawer's answers live (registerLiveBoard), so an answer landing while you edit goes through
// updateScene instead of overwriting the file under you. Loaded lazily by the Boards surface: Excalidraw's runtime
// is ~2 MB.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import "./boardcanvas.css";
import { landAnswer } from "./boardconvert";
import { parseBoardFile, serializeBoard, type BoardScene } from "./boardmodel";
import { boardViewportAtom, registerBoardEscape, registerLiveBoard } from "./boardstore";

const AUTOSAVE_MS = 500;
const SAVE_TRIES = 3;

// what the surface drives on the canvas
export interface BoardCanvasControl {
    // selects exactly these shapes and scrolls to them (decision 7); [] clears the selection
    show(ids: string[]): void;
    // saves a pending autosave now, so the drawer reads the board as you see it
    flush(): Promise<void>;
    elements(): readonly ExcalidrawElement[];
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
            const { scene, shapeIds } = landAnswer(current(), answer, Date.now());
            api.updateScene({ elements: scene.elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
            await save();
            return shapeIds;
        });
        controlRef.current = {
            show,
            flush: () => flush().catch((e) => console.warn("boards: saving before an ask failed", boardId, e)),
            elements: () => apiRef.current?.getSceneElements() ?? [],
        };
        ownsEscapeRef.current = false;
        const escape = registerBoardEscape(() => {
            const api = apiRef.current;
            if (api == null) {
                return;
            }
            api.setActiveTool({ type: "selection" });
            api.updateScene({
                appState: { selectedElementIds: {}, selectedGroupIds: {}, editingGroupId: null },
                captureUpdate: CaptureUpdateAction.NEVER,
            });
        });
        escapeRef.current = escape;
        (async () => {
            try {
                const read = await RpcApi.BoardReadCommand(TabRpcClient, ref);
                const scene = parseBoardFile(read.data);
                if (cancelled) {
                    return;
                }
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
            readyRef.current?.resolve();
            const scene = current();
            sigRef.current = elementsSig(scene.elements);
            cbRef.current.onLoaded(scene);
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
        const vpAtom = boardViewportAtom(boardId);
        const vp = globalStore.get(vpAtom);
        if (vp?.scrollX !== appState.scrollX || vp?.scrollY !== appState.scrollY || vp?.zoom !== appState.zoom.value) {
            globalStore.set(vpAtom, {
                scrollX: appState.scrollX,
                scrollY: appState.scrollY,
                zoom: appState.zoom.value,
            });
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
    const viewport = globalStore.get(boardViewportAtom(boardId));
    return (
        <div className="arc-board absolute inset-0" data-board-canvas={boardId}>
            <Excalidraw
                excalidrawAPI={onApi}
                onChange={onChange}
                theme="dark"
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
                    scrollToContent: viewport == null,
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
