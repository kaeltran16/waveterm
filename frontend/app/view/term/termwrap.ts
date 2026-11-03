// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { setBadge } from "@/app/store/badge";
import { getFileSubject } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { shouldRelaunchWorker } from "@/app/view/agents/session-models/agentresumestore";
import {
    fetchWaveFile,
    getOverrideConfigAtom,
    getSettingsKeyAtom,
    globalStore,
    isDev,
    openLink,
    WOS,
} from "@/store/global";
import * as services from "@/store/services";
import { isMacOS, PLATFORM, PlatformMacOS } from "@/util/platformutil";
import { base64ToArray, fireAndForget } from "@/util/util";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import * as TermTypes from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import { colord } from "colord";
import debug from "debug";
import * as jotai from "jotai";
import { debounce } from "throttle-debounce";
import {
    handleOsc16162Command,
    handleOsc52Command,
    handleOsc7Command,
    type ShellIntegrationStatus,
} from "./osc-handlers";
import { fileLinkRange, findFileLinks, isPeekModifier, type FileLinkMatch } from "./termfilelinks";
import {
    bufferLinesToText,
    createTempFileFromBlob,
    extractAllClipboardData,
    normalizeCursorStyle,
    trimTerminalSelection,
} from "./termutil";

const dlog = debug("wave:termwrap");

const TermFileName = "term";
const TermCacheFileName = "cache:term:full";
const MinDataProcessedForCache = 100 * 1024;
export const SupportsImageInput = true;
const MaxRepaintTransactionMs = 2000;
const WebglRetryDelayMs = 2000;
const WebglLossWindowMs = 30_000;

// detect webgl support
function detectWebGLSupport(): boolean {
    try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("webgl2");
        return !!ctx;
    } catch (e) {
        return false;
    }
}

export const WebGLSupported = detectWebGLSupport();
let loggedWebGL = false;

export type FileLinkHit = { match: FileLinkMatch; bufferLine: number };

export type FileLinkHandler = {
    activate(hit: FileLinkHit): void;
    // client coords just below the hovered row; null hides
    hint(at: { x: number; y: number } | null): void;
};

const FileLinkAccentVar = "--color-accent-soft";

// xterm decorations take only #rrggbb, and the theme token is read at hover time so themes apply.
function fileLinkAccentHex(): string | undefined {
    const value = getComputedStyle(document.documentElement).getPropertyValue(FileLinkAccentVar).trim();
    const color = colord(value);
    return color.isValid() ? color.alpha(1).toHex() : undefined;
}

type TermWrapOptions = {
    keydownHandler?: (e: KeyboardEvent) => boolean;
    useWebGl?: boolean;
    sendDataHandler?: (data: string) => void;
    nodeModel?: BlockNodeModel;
};

export class TermWrap {
    tabId: string;
    blockId: string;
    ptyOffset: number;
    dataBytesProcessed: number;
    terminal: Terminal;
    connectElem: HTMLDivElement;
    fitAddon: FitAddon;
    serializeAddon: SerializeAddon;
    mainFileSubject: SubjectWithRef<WSFileEventData>;
    loaded: boolean;
    heldData: Uint8Array[];
    handleResize_debounced: () => void;
    hasResized: boolean;
    sendDataHandler: (data: string) => void;
    toDispose: TermTypes.IDisposable[] = [];
    webglAddon: WebglAddon | null = null;
    webglEnabledAtom: jotai.PrimitiveAtom<boolean>;
    pasteActive: boolean = false;
    lastUpdated: number;
    promptMarkers: TermTypes.IMarker[] = [];
    shellIntegrationStatusAtom: jotai.PrimitiveAtom<ShellIntegrationStatus | null>;
    nodeModel: BlockNodeModel; // this can be null
    hoveredLinkUri: string | null = null;
    onLinkHover?: (uri: string | null, mouseX: number, mouseY: number) => void;
    fileLinkHandler: FileLinkHandler | null = null;

    // Paste deduplication
    // xterm.js paste() method triggers onData event, which can cause duplicate sends
    lastPasteData: string = "";
    lastPasteTime: number = 0;

    // dev only (for debugging)
    recentWrites: { idx: number; data: string; ts: number }[] = [];
    recentWritesCounter: number = 0;

    // for repaint transaction scrolling behavior
    lastClearScrollbackTs: number = 0;
    lastMode2026SetTs: number = 0;
    lastMode2026ResetTs: number = 0;
    inSyncTransaction: boolean = false;
    inRepaintTransaction: boolean = false;

    constructor(
        tabId: string,
        blockId: string,
        connectElem: HTMLDivElement,
        options: TermTypes.ITerminalOptions & TermTypes.ITerminalInitOnlyOptions,
        waveOptions: TermWrapOptions
    ) {
        this.loaded = false;
        this.tabId = tabId;
        this.blockId = blockId;
        this.sendDataHandler = waveOptions.sendDataHandler;
        this.nodeModel = waveOptions.nodeModel;
        this.ptyOffset = 0;
        this.dataBytesProcessed = 0;
        this.hasResized = false;
        this.lastUpdated = Date.now();
        this.promptMarkers = [];
        this.shellIntegrationStatusAtom = jotai.atom(null) as jotai.PrimitiveAtom<ShellIntegrationStatus | null>;
        this.webglEnabledAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
        // registerDecoration (the file-link accent) is proposed api in xterm 6 and throws without this
        this.terminal = new Terminal({ ...options, allowProposedApi: true });
        this.fitAddon = new FitAddon();
        this.serializeAddon = new SerializeAddon();
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(this.serializeAddon);
        this.terminal.loadAddon(
            new WebLinksAddon(
                (e, uri) => {
                    e.preventDefault();
                    switch (PLATFORM) {
                        case PlatformMacOS:
                            if (e.metaKey) {
                                fireAndForget(() => openLink(uri));
                            }
                            break;
                        default:
                            if (e.ctrlKey) {
                                fireAndForget(() => openLink(uri));
                            }
                            break;
                    }
                },
                {
                    hover: (e, uri) => {
                        this.hoveredLinkUri = uri;
                        this.onLinkHover?.(uri, e.clientX, e.clientY);
                    },
                    leave: () => {
                        this.hoveredLinkUri = null;
                        this.onLinkHover?.(null, 0, 0);
                    },
                }
            )
        );
        this.toDispose.push(
            this.terminal.registerLinkProvider({ provideLinks: (y, callback) => callback(this.provideFileLinks(y)) })
        );
        this.setTermRenderer(WebGLSupported && waveOptions.useWebGl ? "webgl" : "dom");
        // Register OSC handlers
        this.terminal.parser.registerOscHandler(7, (data: string) => {
            try {
                return handleOsc7Command(data, this.blockId, this.loaded);
            } catch (e) {
                console.error("[termwrap] osc 7 handler error", this.blockId, e);
                return false;
            }
        });
        this.terminal.parser.registerOscHandler(52, (data: string) => {
            try {
                return handleOsc52Command(data, this.blockId, this.loaded, this);
            } catch (e) {
                console.error("[termwrap] osc 52 handler error", this.blockId, e);
                return false;
            }
        });
        this.terminal.parser.registerOscHandler(16162, (data: string) => {
            try {
                return handleOsc16162Command(data, this.blockId, this.loaded, this);
            } catch (e) {
                console.error("[termwrap] osc 16162 handler error", this.blockId, e);
                return false;
            }
        });
        this.toDispose.push(
            this.terminal.parser.registerCsiHandler({ final: "J" }, (params) => {
                if (params == null || params.length < 1) {
                    return false;
                }
                if (params[0] === 3) {
                    this.lastClearScrollbackTs = Date.now();
                    if (this.inSyncTransaction) {
                        console.log("[termwrap] repaint transaction starting");
                        this.inRepaintTransaction = true;
                    }
                }
                return false;
            })
        );
        this.toDispose.push(
            this.terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
                if (params == null || params.length < 1) {
                    return false;
                }
                if (params[0] === 2026) {
                    this.lastMode2026SetTs = Date.now();
                    this.inSyncTransaction = true;
                }
                return false;
            })
        );
        this.toDispose.push(
            this.terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
                if (params == null || params.length < 1) {
                    return false;
                }
                if (params[0] === 2026) {
                    this.lastMode2026ResetTs = Date.now();
                    this.inSyncTransaction = false;
                    const wasRepaint = this.inRepaintTransaction;
                    this.inRepaintTransaction = false;
                    if (wasRepaint && Date.now() - this.lastClearScrollbackTs <= MaxRepaintTransactionMs) {
                        setTimeout(() => {
                            console.log("[termwrap] repaint transaction complete, scrolling to bottom");
                            this.terminal.scrollToBottom();
                        }, 20);
                    }
                }
                return false;
            })
        );
        this.toDispose.push(
            this.terminal.onBell(() => {
                if (!this.loaded) {
                    return true;
                }
                console.log("BEL received in terminal", this.blockId);
                const bellIndicatorEnabled =
                    globalStore.get(getOverrideConfigAtom(this.blockId, "term:bellindicator")) ?? false;
                if (bellIndicatorEnabled) {
                    setBadge(this.blockId, { icon: "bell", color: "#fbbf24", priority: 1 });
                }
                return true;
            })
        );
        this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
            if (!waveOptions.keydownHandler) {
                return true;
            }
            return waveOptions.keydownHandler(e);
        });
        this.connectElem = connectElem;
        this.mainFileSubject = null;
        this.heldData = [];
        this.handleResize_debounced = debounce(50, this.handleResize.bind(this));
        this.terminal.open(this.connectElem);

        // a dropped file carries no path in the webview (native drag-drop is off so HTML5 drag works),
        // so there is nothing to paste; swallow the drop so the webview doesn't navigate to the file.
        const dropGuard = (e: DragEvent) => e.preventDefault();
        this.connectElem.addEventListener("dragover", dropGuard);
        this.connectElem.addEventListener("drop", dropGuard);
        this.toDispose.push({
            dispose: () => {
                this.connectElem.removeEventListener("dragover", dropGuard);
                this.connectElem.removeEventListener("drop", dropGuard);
            },
        });
        // a gpu reset paints a lost webgl canvas white (with a sad face) while the addon waits up to 3s
        // for a restore; drop to the dom renderer at once instead. the event doesn't bubble, so capture it.
        // webgl is retried once the gpu is back, unless losses keep coming, so a flaky gpu can't loop.
        let lastLossTs = 0;
        let retryTimer: ReturnType<typeof setTimeout> = null;
        const contextLostHandler = () => {
            const now = Date.now();
            const repeated = now - lastLossTs < WebglLossWindowMs;
            lastLossTs = now;
            this.setTermRenderer("dom");
            clearTimeout(retryTimer);
            if (!repeated) {
                retryTimer = setTimeout(() => {
                    try {
                        this.setTermRenderer("webgl");
                    } catch (e) {
                        // chromium turns webgl off after repeated gpu crashes; the addon then throws
                        console.log("[termwrap] webgl retry failed, staying on dom", this.blockId, e);
                    }
                }, WebglRetryDelayMs);
            }
        };
        this.connectElem.addEventListener("webglcontextlost", contextLostHandler, true);
        this.toDispose.push({
            dispose: () => {
                clearTimeout(retryTimer);
                this.connectElem.removeEventListener("webglcontextlost", contextLostHandler, true);
            },
        });
        this.handleResize();
        const pasteHandler = this.pasteHandler.bind(this);
        this.connectElem.addEventListener("paste", pasteHandler, true);
        this.toDispose.push({
            dispose: () => {
                this.connectElem.removeEventListener("paste", pasteHandler, true);
            },
        });
    }

    getZoneId(): string {
        return this.blockId;
    }

    setCursorStyle(cursorStyle: string) {
        this.terminal.options.cursorStyle = normalizeCursorStyle(cursorStyle);
    }

    setCursorBlink(cursorBlink: boolean) {
        this.terminal.options.cursorBlink = cursorBlink ?? false;
    }

    setTermRenderer(renderer: "webgl" | "dom") {
        if (renderer === "webgl") {
            if (this.webglAddon != null) {
                return;
            }
            if (!WebGLSupported) {
                renderer = "dom";
            }
        } else {
            if (this.webglAddon == null) {
                return;
            }
        }
        if (this.webglAddon != null) {
            this.webglAddon.dispose();
            this.webglAddon = null;
            globalStore.set(this.webglEnabledAtom, false);
        }
        if (renderer === "webgl") {
            const addon = new WebglAddon();
            this.terminal.loadAddon(addon);
            this.webglAddon = addon;
            globalStore.set(this.webglEnabledAtom, true);
            if (!loggedWebGL) {
                console.log("loaded webgl!");
                loggedWebGL = true;
            }
        }
    }

    getTermRenderer(): "webgl" | "dom" {
        return this.webglAddon != null ? "webgl" : "dom";
    }

    isWebGlEnabled(): boolean {
        return this.webglAddon != null;
    }

    async initTerminal() {
        const copyOnSelectAtom = getSettingsKeyAtom("term:copyonselect");
        const trimTrailingWhitespaceAtom = getSettingsKeyAtom("term:trimtrailingwhitespace");
        this.toDispose.push(this.terminal.onData(this.handleTermData.bind(this)));
        this.toDispose.push(
            this.terminal.onSelectionChange(
                debounce(50, () => {
                    if (!globalStore.get(copyOnSelectAtom)) {
                        return;
                    }
                    let selectedText = this.terminal.getSelection();
                    if (selectedText.length > 0) {
                        if (globalStore.get(trimTrailingWhitespaceAtom) !== false) {
                            selectedText = trimTerminalSelection(selectedText);
                        }
                        navigator.clipboard.writeText(selectedText);
                    }
                })
            )
        );

        this.mainFileSubject = getFileSubject(this.getZoneId(), TermFileName);
        this.mainFileSubject.subscribe(this.handleNewFileSubjectData.bind(this));

        try {
            const rtInfo = await RpcApi.GetRTInfoCommand(TabRpcClient, {
                oref: WOS.makeORef("block", this.blockId),
            });
            let shellState: ShellIntegrationStatus = null;

            if (rtInfo && rtInfo["shell:integration"]) {
                shellState = rtInfo["shell:state"] as ShellIntegrationStatus;
                globalStore.set(this.shellIntegrationStatusAtom, shellState || null);
            } else {
                globalStore.set(this.shellIntegrationStatusAtom, null);
            }
        } catch (e) {
            console.log("Error loading runtime info:", e);
        }

        try {
            await this.loadInitialTerminalData();
        } finally {
            this.loaded = true;
        }
        this.runProcessIdleTimeout();
    }

    dispose() {
        this.promptMarkers.forEach((marker) => {
            try {
                marker.dispose();
            } catch (_) {
                /* nothing */
            }
        });
        this.promptMarkers = [];
        this.terminal.dispose();
        this.toDispose.forEach((d) => {
            try {
                d.dispose();
            } catch (_) {
                /* nothing */
            }
        });
        this.mainFileSubject.release();
    }

    handleTermData(data: string) {
        if (!this.loaded) {
            return;
        }

        this.sendDataHandler?.(data);
    }

    addFocusListener(focusFn: () => void) {
        this.terminal.textarea.addEventListener("focus", focusFn);
    }

    setFileLinkHandler(handler: FileLinkHandler | null) {
        this.fileLinkHandler = handler;
    }

    markLine(bufferLine: number): TermTypes.IMarker | undefined {
        const buf = this.terminal.buffer.active;
        return this.terminal.registerMarker(bufferLine - (buf.baseY + buf.cursorY));
    }

    // 1-based buffer row in, as xterm's link provider passes it; no handler means no file links.
    private provideFileLinks(bufferLineNumber: number): TermTypes.ILink[] | undefined {
        if (this.fileLinkHandler == null) {
            return undefined;
        }
        const bufferLine = bufferLineNumber - 1;
        const row = this.terminal.buffer.active.getLine(bufferLine);
        if (row == null) {
            return undefined;
        }
        const links = findFileLinks(row.translateToString(true)).map((m) => this.makeFileLink(m, bufferLine));
        return links.length > 0 ? links : undefined;
    }

    private makeFileLink(match: FileLinkMatch, bufferLine: number): TermTypes.ILink {
        let hover: TermTypes.IDisposable | null = null;
        const endHover = () => {
            hover?.dispose();
            hover = null;
        };
        const link: TermTypes.ILink = {
            range: fileLinkRange(match, bufferLine),
            text: match.path,
            decorations: { underline: false, pointerCursor: false },
            activate: (e) => {
                if (!isPeekModifier(e, isMacOS())) {
                    return;
                }
                e.preventDefault();
                this.fileLinkHandler?.activate({ match, bufferLine });
            },
            hover: (e) => {
                endHover();
                hover = this.hoverFileLink(link, match, bufferLine, e);
            },
            leave: () => {
                // xterm still tracks this link during leave, so this clears its underline and cursor
                link.decorations.underline = false;
                link.decorations.pointerCursor = false;
                endHover();
            },
            dispose: endHover,
        };
        return link;
    }

    // underline, accent and hint follow the modifier for as long as the pointer is on the link,
    // including a press or release mid-hover.
    private hoverFileLink(
        link: TermTypes.ILink,
        match: FileLinkMatch,
        bufferLine: number,
        e: MouseEvent
    ): TermTypes.IDisposable {
        let clientX = e.clientX;
        let held = false;
        let accent: TermTypes.IMarker | undefined;
        const clearAccent = () => {
            accent?.dispose();
            accent = undefined;
        };
        const apply = (nowHeld: boolean) => {
            held = nowHeld;
            link.decorations.underline = held;
            link.decorations.pointerCursor = held;
            if (held && accent == null) {
                accent = this.accentFileLink(match, bufferLine);
            } else if (!held) {
                clearAccent();
            }
            this.fileLinkHandler?.hint(held ? this.belowRow(bufferLine, clientX) : null);
        };
        const onKey = (ke: KeyboardEvent) => {
            const nowHeld = isPeekModifier(ke, isMacOS());
            if (nowHeld !== held) {
                apply(nowHeld);
            }
        };
        const onMove = (me: MouseEvent) => {
            clientX = me.clientX;
            if (held) {
                this.fileLinkHandler?.hint(this.belowRow(bufferLine, clientX));
            }
        };
        // capture: a focused xterm stops key events from bubbling to window
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("keyup", onKey, true);
        this.terminal.element?.addEventListener("mousemove", onMove);
        // xterm calls hover before it starts tracking the link's decorations, so a write made now is lost
        let disposed = false;
        queueMicrotask(() => {
            if (!disposed) {
                apply(isPeekModifier(e, isMacOS()));
            }
        });
        return {
            dispose: () => {
                disposed = true;
                window.removeEventListener("keydown", onKey, true);
                window.removeEventListener("keyup", onKey, true);
                this.terminal.element?.removeEventListener("mousemove", onMove);
                clearAccent();
                if (held) {
                    this.fileLinkHandler?.hint(null);
                }
            },
        };
    }

    // recolors the link's cells; the decoration is disposed with its marker.
    private accentFileLink(match: FileLinkMatch, bufferLine: number): TermTypes.IMarker | undefined {
        const color = fileLinkAccentHex();
        const marker = color ? this.markLine(bufferLine) : undefined;
        if (marker == null) {
            return undefined;
        }
        const deco = this.terminal.registerDecoration({
            marker,
            x: match.start,
            width: match.end - match.start,
            foregroundColor: color,
            layer: "top",
        });
        if (deco == null) {
            marker.dispose();
            return undefined;
        }
        return marker;
    }

    private belowRow(bufferLine: number, clientX: number): { x: number; y: number } | null {
        const screen = this.terminal.element?.querySelector(".xterm-screen");
        if (screen == null) {
            return null;
        }
        const rect = screen.getBoundingClientRect();
        const rowHeight = rect.height / this.terminal.rows;
        const viewRow = bufferLine - this.terminal.buffer.active.viewportY;
        return { x: clientX, y: rect.top + (viewRow + 1) * rowHeight };
    }

    handleNewFileSubjectData(msg: WSFileEventData) {
        if (msg.fileop == "truncate") {
            this.terminal.clear();
            this.heldData = [];
        } else if (msg.fileop == "append") {
            const decodedData = base64ToArray(msg.data64);
            if (this.loaded) {
                this.doTerminalWrite(decodedData, null);
            } else {
                this.heldData.push(decodedData);
            }
        } else {
            console.log("bad fileop for terminal", msg);
            return;
        }
    }

    doTerminalWrite(data: string | Uint8Array, setPtyOffset?: number): Promise<void> {
        if (isDev() && this.loaded) {
            const dataStr = data instanceof Uint8Array ? new TextDecoder().decode(data) : data;
            this.recentWrites.push({ idx: this.recentWritesCounter++, ts: Date.now(), data: dataStr });
            if (this.recentWrites.length > 50) {
                this.recentWrites.shift();
            }
        }
        let resolve: () => void = null;
        const prtn = new Promise<void>((presolve, _) => {
            resolve = presolve;
        });
        this.terminal.write(data, () => {
            if (setPtyOffset != null) {
                this.ptyOffset = setPtyOffset;
            } else {
                this.ptyOffset += data.length;
                this.dataBytesProcessed += data.length;
            }
            this.lastUpdated = Date.now();
            resolve();
        });
        return prtn;
    }

    async loadInitialTerminalData(): Promise<void> {
        const startTs = Date.now();
        const zoneId = this.getZoneId();
        const { data: cacheData, fileInfo: cacheFile } = await fetchWaveFile(zoneId, TermCacheFileName);
        let ptyOffset = 0;
        if (cacheFile != null) {
            ptyOffset = cacheFile.meta["ptyoffset"] ?? 0;
            if (cacheData.byteLength > 0) {
                const curTermSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
                const fileTermSize: TermSize = cacheFile.meta["termsize"];
                let didResize = false;
                if (
                    fileTermSize != null &&
                    (fileTermSize.rows != curTermSize.rows || fileTermSize.cols != curTermSize.cols)
                ) {
                    console.log("terminal restore size mismatch, temp resize", fileTermSize, curTermSize);
                    this.terminal.resize(fileTermSize.cols, fileTermSize.rows);
                    didResize = true;
                }
                this.doTerminalWrite(cacheData, ptyOffset);
                if (didResize) {
                    this.terminal.resize(curTermSize.cols, curTermSize.rows);
                }
            }
        }
        const { data: mainData, fileInfo: mainFile } = await fetchWaveFile(zoneId, TermFileName, ptyOffset);
        console.log(
            `terminal loaded cachefile:${cacheData?.byteLength ?? 0} main:${mainData?.byteLength ?? 0} bytes, ${Date.now() - startTs}ms`
        );
        if (mainFile != null) {
            await this.doTerminalWrite(mainData, null);
        }
    }

    // the status of the run an engine worker belongs to when a remount must not relaunch it (the run is over,
    // or blocked on a stopped worker), so its last frame stays up; null when the block may relaunch
    async unrelaunchableRunStatus(): Promise<string | null> {
        const meta = WOS.getObjectValue<Block>(WOS.makeORef("block", this.blockId))?.meta;
        const runId = meta?.["agent:runid"];
        if (typeof runId !== "string" || !runId) {
            return null;
        }
        const run = await WOS.loadAndPinWaveObject<Run>(WOS.makeORef("run", runId)).catch(() => null);
        return shouldRelaunchWorker(meta, run?.status) ? null : run.status;
    }

    async resyncController(reason: string) {
        dlog("resync controller", this.blockId, reason);
        const runStatus = await this.unrelaunchableRunStatus();
        if (runStatus != null) {
            const notice =
                runStatus === "blocked"
                    ? "this worker stopped; resume it from its run"
                    : "this worker's run is over; it was not relaunched";
            this.terminal.write(`\r\n\x1b[2m[arc] ${notice}\x1b[0m\r\n`);
            return;
        }
        const rtOpts: RuntimeOpts = { termsize: { rows: this.terminal.rows, cols: this.terminal.cols } };
        try {
            await RpcApi.ControllerResyncCommand(TabRpcClient, {
                tabid: this.tabId,
                blockid: this.blockId,
                rtopts: rtOpts,
            });
        } catch (e) {
            console.log(`error controller resync (${reason})`, this.blockId, e);
        }
    }

    handleResize() {
        // skip while hidden/detached (display:none -> offsetParent null, 0 size) so we don't fit to a
        // 0-size box and shrink the PTY; the ResizeObserver fires again with real dims on re-show.
        if (
            this.connectElem.offsetParent == null ||
            this.connectElem.clientWidth === 0 ||
            this.connectElem.clientHeight === 0
        ) {
            return;
        }
        const oldRows = this.terminal.rows;
        const oldCols = this.terminal.cols;
        this.fitAddon.fit();
        if (oldRows !== this.terminal.rows || oldCols !== this.terminal.cols) {
            const termSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
            console.log(
                "[termwrap] resize",
                `${oldRows}x${oldCols}`,
                "->",
                `${this.terminal.rows}x${this.terminal.cols}`
            );
            RpcApi.ControllerInputCommand(TabRpcClient, { blockid: this.blockId, termsize: termSize });
        }
        dlog("resize", `${this.terminal.rows}x${this.terminal.cols}`, `${oldRows}x${oldCols}`, this.hasResized);
        if (!this.hasResized) {
            this.hasResized = true;
            this.resyncController("initial resize");
        }
    }

    processAndCacheData() {
        if (this.dataBytesProcessed < MinDataProcessedForCache) {
            return;
        }
        const serializedOutput = this.serializeAddon.serialize();
        const termSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
        console.log("idle timeout term", this.dataBytesProcessed, serializedOutput.length, termSize);
        fireAndForget(() =>
            services.BlockService.SaveTerminalState(this.blockId, serializedOutput, "full", this.ptyOffset, termSize)
        );
        this.dataBytesProcessed = 0;
    }

    runProcessIdleTimeout() {
        setTimeout(() => {
            window.requestIdleCallback(() => {
                this.processAndCacheData();
                this.runProcessIdleTimeout();
            });
        }, 5000);
    }

    async pasteHandler(e?: ClipboardEvent): Promise<void> {
        this.pasteActive = true;
        e?.preventDefault();
        e?.stopPropagation();

        try {
            const clipboardData = await extractAllClipboardData(e);
            let firstImage = true;
            for (const data of clipboardData) {
                if (data.image && SupportsImageInput) {
                    if (!firstImage) {
                        await new Promise((r) => setTimeout(r, 150));
                    }
                    const tempPath = await createTempFileFromBlob(data.image);
                    this.terminal.paste(tempPath + " ");
                    firstImage = false;
                }
                if (data.text) {
                    this.terminal.paste(data.text);
                }
            }
        } catch (err) {
            console.error("Paste error:", err);
        } finally {
            setTimeout(() => {
                this.pasteActive = false;
            }, 30);
        }
    }

    getScrollbackContent(): string {
        if (!this.terminal) {
            return "";
        }
        const buffer = this.terminal.buffer.active;
        const lines = bufferLinesToText(buffer, 0, buffer.length);
        return lines.join("\n");
    }
}
