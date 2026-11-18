// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Send: a picture of the board with its mark goes to <canvas>/feedback/NNN.png, then one line naming it goes
// to the agent as a prompt: its mod runs it, leaving the composer alone, and a session with no mod has it
// typed. Every failure throws before the line is sent, and the mark stays for a retry.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { invoke } from "@tauri-apps/api/core";
import { showPane } from "./agentpanes";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import {
    canvasHandoffLine,
    cropRect,
    feedbackRelPath,
    nextFeedbackName,
    visibleRect,
    type DOMRectLike,
} from "./canvasmarks";
import { canvasFeedbackDir, canvasFeedbackFile, shownBoard } from "./canvasmodel";
import { canvasWindowAtom, getCanvas, setMarking } from "./canvasstore";
import { tauriFileIO, type FileIO } from "./fileio";
import { rendersNow } from "./workspacestore";

export type SendIO = FileIO & {
    capture(): Promise<Blob>;
    crop(png: Blob, rect: DOMRectLike): Promise<Blob>;
    // inWindow: the canvas window is open, and its board, not the one in the pane behind it, is the marked one
    boardRect(inWindow: boolean): DOMRectLike | null;
    prompt(blockId: string, text: string): Promise<void>;
};

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

async function step<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        throw new Error(`${what}: ${errText(e)}`);
    }
}

export const tauriSendIO: SendIO = {
    ...tauriFileIO,
    async capture() {
        return new Blob([await invoke<ArrayBuffer>("capture_webview")], { type: "image/png" });
    },
    async crop(png, rect) {
        const bitmap = await createImageBitmap(png);
        try {
            const { sx, sy, sw, sh } = cropRect(rect, window.innerWidth, bitmap);
            if (sw === 0 || sh === 0) {
                throw new Error("the board is off screen");
            }
            const canvas = new OffscreenCanvas(sw, sh);
            canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
            return await canvas.convertToBlob({ type: "image/png" });
        } finally {
            bitmap.close();
        }
    },
    boardRect(inWindow) {
        const root = inWindow ? document.querySelector("[data-canvas-window]") : document;
        const board = root?.querySelector("[data-canvas-board]")?.getBoundingClientRect();
        const pane = root?.querySelector("[data-canvas-scroll]")?.getBoundingClientRect();
        return board == null || pane == null ? null : visibleRect(board, pane);
    },
    async prompt(blockId, text) {
        await RpcApi.AgentPromptCommand(TabRpcClient, { blockid: blockId, text });
    },
};

export async function sendCanvasMark(model: AgentsViewModel, agent: AgentVM, io: SendIO = tauriSendIO): Promise<void> {
    const s = getCanvas(agent.id);
    if (s?.mark == null) {
        throw new Error("Nothing to send");
    }
    if (!agent.blockId) {
        throw new Error("This agent has no session to send to");
    }
    const inWindow = globalStore.get(canvasWindowAtom) === agent.id;
    const rect = io.boardRect(inWindow);
    if (rect == null) {
        throw new Error("The board isn't on screen");
    }
    // first, while the overlay and the mark are still drawn
    const png = await step("Couldn't capture the board", async () => io.crop(await io.capture(), rect));
    const dir = canvasFeedbackDir(s.dir);
    const name = await step(`Couldn't save the picture in ${dir}`, async () => {
        await io.mkdir(dir);
        const next = nextFeedbackName(await io.list(dir));
        await io.write(canvasFeedbackFile(s.dir, next), new Uint8Array(await png.arrayBuffer()));
        return next;
    });
    const line = canvasHandoffLine(feedbackRelPath(s.topic, name), shownBoard(s).name, s.mark);
    await step(`Couldn't send to ${agent.name}`, () => io.prompt(agent.blockId!, line));
    // in Rendered the tab stays: the transcript the reply lands in is already beside it. The window stays too
    if (inWindow || rendersNow(model, agent.id)) {
        setMarking(agent.id, false);
        return;
    }
    showPane(model, agent.id, "canvas", false, Date.now());
}
