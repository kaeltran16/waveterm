// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The open board: plain Excalidraw over the board file. It loads the file, stamps the time you looked, autosaves
// your edits under the rev it read, and takes scribe draws live (registerLiveBoard), so a draw landing while you
// edit goes through updateScene instead of overwriting the file under you. Loaded lazily by the Boards surface:
// Excalidraw's runtime is ~2 MB.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import "./boardcanvas.css";
import { convertSkeleton } from "./boardconvert";
import {
    applyDraw,
    dropPending,
    groupElementIds,
    keepPending,
    markEdits,
    newestSinceSeen,
    parseBoardFile,
    serializeBoard,
    type BoardScene,
} from "./boardmodel";
import { boardOwnsEscapeAtom, boardViewportAtom, registerLiveBoard, setBoardEscape } from "./boardstore";

const AUTOSAVE_MS = 500;
const SAVE_TRIES = 3;

// what the surface's list drives on the canvas
export interface BoardCanvasControl {
    select: (key: string) => void;
    keep: (key: string) => Promise<void>;
    drop: (key: string) => Promise<void>;
}

export interface BoardCanvasProps {
    channelId: string;
    boardId: string;
    controlRef: MutableRefObject<BoardCanvasControl | null>;
    // seenAtOpen: the seents the file had before this open stamped it, so New and the header count from it
    onLoaded: (scene: BoardScene, seenAtOpen: number, selected: string | null) => void;
    onScene: (scene: BoardScene) => void;
    onError: (message: string) => void;
    // the selection went empty, so the list's highlighted source row no longer says what is selected
    onDeselect: () => void;
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
    onDeselect,
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
    // the latest callbacks, so the long-lived handlers below never call a stale render's
    const cbRef = useRef({ onLoaded, onScene, onError, onDeselect });
    cbRef.current = { onLoaded, onScene, onError, onDeselect };
    const hadSelectionRef = useRef(false);
    // settles once the scene is in Excalidraw; a draw that arrives before then waits for it
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
    // writes again rather than dropping them (every scribe draw reaches an open board through this canvas)
    function save(): Promise<void> {
        const run = savingRef.current.then(async () => {
            const scene = markEdits(current(), Date.now());
            sceneRef.current = { ...sceneRef.current, arc: scene.arc };
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

    function flushAutosave(): void {
        if (timerRef.current == null) {
            return;
        }
        clearTimeout(timerRef.current);
        timerRef.current = null;
        save().catch((e) => console.warn("boards: autosave failed", boardId, e));
    }

    // a change made through the api (a draw, Keep, Drop) is saved at once and is its own undo step
    async function replaceScene(next: BoardScene): Promise<void> {
        const api = apiRef.current;
        if (api == null) {
            throw new Error("the board is not open");
        }
        sceneRef.current = { ...sceneRef.current, arc: next.arc };
        api.updateScene({ elements: next.elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        await save();
    }

    function select(key: string): void {
        const api = apiRef.current;
        const scene = sceneRef.current;
        const src = scene?.arc.sources?.find((s) => s.key === key);
        if (api == null || src == null) {
            return;
        }
        const ids = groupElementIds(current(), key);
        if (ids.length === 0) {
            return;
        }
        api.updateScene({
            appState: {
                selectedElementIds: Object.fromEntries(ids.map((id) => [id, true as const])),
                selectedGroupIds: { [src.groupid]: true },
                editingGroupId: null,
            },
            captureUpdate: CaptureUpdateAction.NEVER,
        });
        const idSet = new Set(ids);
        api.scrollToContent(
            api.getSceneElements().filter((el) => idSet.has(el.id)),
            { animate: true }
        );
    }

    useEffect(() => {
        let cancelled = false;
        const ready = deferred();
        readyRef.current = ready;
        // registered before the read, so no draw can reach the file between this read and the first save
        const unregister = registerLiveBoard(channelId, boardId, async (draw) => {
            await ready.promise;
            const converted = convertSkeleton(draw.skeleton);
            const { scene, outcome } = applyDraw(current(), draw, converted, Date.now());
            await replaceScene(scene);
            return outcome;
        });
        controlRef.current = {
            select,
            keep: (key) => replaceScene(keepPending(current(), key, Date.now())),
            drop: (key) => replaceScene(dropPending(current(), key)),
        };
        setBoardEscape(() => {
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
            flushAutosave();
            unregister();
            controlRef.current = null;
            setBoardEscape(null);
            globalStore.set(boardOwnsEscapeAtom, false);
            ready.reject(new Error("the board closed"));
        };
    }, [channelId, boardId]);

    // once Excalidraw has the scene: stamp the time you looked, select what is new since then, and save
    function onApi(api: ExcalidrawImperativeAPI): void {
        apiRef.current = api;
        const scene = sceneRef.current;
        if (scene == null) {
            return;
        }
        const seenAtOpen = scene.arc.seents ?? 0;
        const newest = newestSinceSeen(scene.arc, seenAtOpen);
        sceneRef.current = { ...scene, arc: { ...scene.arc, seents: Date.now() } };
        // Excalidraw hands the api over before it has restored the initial scene
        requestAnimationFrame(() => {
            readyRef.current?.resolve();
            if (newest != null) {
                select(newest);
            }
            cbRef.current.onLoaded(current(), seenAtOpen, newest);
            save().catch((e) => console.warn("boards: stamping the time you looked failed", boardId, e));
        });
    }

    function onChange(elements: readonly ExcalidrawElement[], appState: AppState): void {
        const hasSelection = Object.keys(appState.selectedElementIds).length > 0;
        if (hadSelectionRef.current && !hasSelection) {
            cbRef.current.onDeselect();
        }
        hadSelectionRef.current = hasSelection;
        const owns = ownsEscape(appState);
        if (owns !== ownsEscapeRef.current) {
            ownsEscapeRef.current = owns;
            globalStore.set(boardOwnsEscapeAtom, owns);
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
