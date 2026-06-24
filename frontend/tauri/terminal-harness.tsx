import { getFileSubject } from "@/app/store/wps";
import type { WshClient } from "@/app/store/wshclient";
import { RpcApi } from "@/app/store/wshclientapi";
import { getApi } from "@/store/global";
import { base64ToArray, stringToBase64 } from "@/util/util";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { hlog } from "./api";
import * as chrome from "./chrome";
import { buildTauriMenu } from "./menu";

export function TerminalHarness({ client, tabId }: { client: WshClient; tabId: string }) {
    const elemRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(1);
    const [ctrlShift, setCtrlShift] = useState(false);
    const [ctxChecked, setCtxChecked] = useState(false);

    useEffect(() => {
        let disposed = false;
        let onResize: (() => void) | null = null;
        const term = new Terminal({ fontSize: 13, fontFamily: "monospace", cursorBlink: true });
        const fit = new FitAddon();
        term.loadAddon(fit);
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => hlog("webgl context lost -> would fall back to dom"));
        term.loadAddon(webgl);
        term.open(elemRef.current);
        fit.fit();
        hlog("webgl active: " + !webgl.isDisposed);

        (async () => {
            try {
                // CreateBlockCommand returns an ORef string ("block:<id>"), not an object.
                const oref = await RpcApi.CreateBlockCommand(client, {
                    tabid: tabId,
                    blockdef: { meta: { view: "term", controller: "shell" } },
                    ephemeral: true,
                });
                const blockId = oref.substring(oref.indexOf(":") + 1);
                hlog("created block oref=" + oref + " blockId=" + blockId);
                if (disposed) return;

                // subscribe to the "term" blockfile BEFORE resync so we don't miss initial output.
                let loggedFirstAppend = false;
                const fileSub = getFileSubject(blockId, "term");
                fileSub.subscribe((msg: WSFileEventData) => {
                    if (msg.fileop === "append") {
                        const bytes = base64ToArray(msg.data64);
                        if (!loggedFirstAppend) {
                            loggedFirstAppend = true;
                            hlog("first term append: " + bytes.length + " bytes (PTY output flowing)");
                        }
                        term.write(bytes);
                    } else if (msg.fileop === "truncate") {
                        term.clear();
                    }
                });

                await RpcApi.ControllerResyncCommand(client, {
                    tabid: tabId,
                    blockid: blockId,
                    rtopts: { termsize: { rows: term.rows, cols: term.cols } },
                });
                hlog("controller resync done; rows=" + term.rows + " cols=" + term.cols);

                term.onData((data) => {
                    RpcApi.ControllerInputCommand(client, { blockid: blockId, inputdata64: stringToBase64(data) });
                });

                onResize = () => {
                    fit.fit();
                    RpcApi.ControllerInputCommand(client, {
                        blockid: blockId,
                        termsize: { rows: term.rows, cols: term.cols },
                    });
                };
                window.addEventListener("resize", onResize);
            } catch (e: any) {
                hlog("TERMINAL ERROR: " + (e?.stack ?? e?.message ?? String(e)));
            }
        })();

        return () => {
            disposed = true;
            if (onResize) {
                window.removeEventListener("resize", onResize);
            }
            term.dispose();
        };
    }, []);

    useEffect(() => {
        // observe-gate 2: prove the Rust→FE event round-trip and the capabilities wiring.
        getApi().onWaveInit((opts) => getApi().sendLog("wave-init received: " + JSON.stringify(opts)));
    }, []);

    useEffect(() => {
        setZoom(getApi().getZoomFactor());
        getApi().onZoomFactorChange((z) => setZoom(z));
        getApi().onControlShiftStateUpdate((s) => setCtrlShift(s));
    }, []);

    const onContextMenu = async (e: React.MouseEvent) => {
        e.preventDefault();
        const items: ContextMenuItem[] = [
            { label: "Log Hello", click: () => getApi().sendLog("ctx: hello") },
            { type: "separator" },
            { label: "Checkable", type: "checkbox", checked: ctxChecked, click: () => setCtxChecked((v) => !v) },
            { label: "Submenu", submenu: [{ label: "Inner", click: () => getApi().sendLog("ctx: inner") }] },
        ];
        const menu = await buildTauriMenu(items);
        await menu.popup(new LogicalPosition(e.clientX, e.clientY));
    };

    return (
        <div
            style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column" }}
            onContextMenu={onContextMenu}
        >
            <div
                data-tauri-drag-region
                style={{ display: "flex", alignItems: "center", height: 32, background: "#1a1a1a", color: "#ddd", fontFamily: "monospace", fontSize: 12, userSelect: "none" }}
            >
                <span style={{ paddingLeft: 10, flex: 1, pointerEvents: "none" }}>Wave Tauri Spike</span>
                <button onClick={() => getCurrentWindow().minimize()}>—</button>
                <button onClick={() => getCurrentWindow().toggleMaximize()}>▢</button>
                <button onClick={() => getCurrentWindow().close()}>✕</button>
            </div>
            <div style={{ display: "flex", gap: 8, padding: 4, alignItems: "center", background: "#222", color: "#ddd", fontFamily: "monospace", fontSize: 12 }}>
                <button onClick={() => getApi().setWindowInitStatus("ready")}>init: ready</button>
                <button onClick={() => getApi().openExternal("https://waveterm.dev")}>open external</button>
                <button onClick={() => getApi().incrementTermCommands()}>incr term cmds</button>
                <button onClick={() => getApi().setIsActive()}>set active</button>
                <span style={{ marginLeft: 12 }}>zoom:</span>
                <button onClick={() => chrome.zoomOut()}>-</button>
                <span>{zoom.toFixed(2)}</span>
                <button onClick={() => chrome.zoomIn()}>+</button>
                <button onClick={() => chrome.zoomReset()}>reset</button>
                <button onClick={() => chrome.toggleFullscreen()}>fullscreen</button>
                <span style={{ marginLeft: 12 }}>ctrl+shift:</span>
                <span style={{ width: 10, height: 10, borderRadius: 5, background: ctrlShift ? "#4caf50" : "#555" }} />
            </div>
            <div ref={elemRef} style={{ flex: 1 }} />
        </div>
    );
}
