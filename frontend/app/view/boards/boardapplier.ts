// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Lands scribe draws (decision 4). wavesrv leaves each result in the board's inbox and publishes board:update;
// this converts and applies it, to the open canvas when the board is open, else to the file under the rev it
// read, then acks it and toasts. A draw that cannot land stays in the inbox for the next try, so a reload or a
// restart loses nothing. One draw per board is in flight at a time, oldest first.

import { pushToast } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import type { AgentsViewModel } from "../agents/agents";
import { openTarget } from "../jarvis/openref";
import { applyDraw, BoardFileError, parseBoardFile, serializeBoard } from "./boardmodel";
import { boardListAtom, liveBoardApply } from "./boardstore";

const SAVE_TRIES = 3;

function shapesText(n: number): string {
    return `${n} ${n === 1 ? "shape" : "shapes"}`;
}

// the name as the list has it; a toast still names something when the list can't be read
async function boardName(channelId: string, boardId: string): Promise<string> {
    const named = (list: BoardListRtnData | null | undefined) => list?.boards?.find((b) => b.id === boardId)?.name;
    const cached = named(globalStore.get(boardListAtom(channelId)));
    if (cached) {
        return cached;
    }
    try {
        return named(await RpcApi.BoardListCommand(TabRpcClient, { channelid: channelId })) || `board ${boardId}`;
    } catch {
        return `board ${boardId}`;
    }
}

async function sourceTitle(data: BoardUpdateData): Promise<string> {
    const fallback = data.sourcekey || "a source";
    try {
        const status = await RpcApi.BoardStatusCommand(TabRpcClient, {
            channelid: data.channelid,
            boardid: data.boardid,
        });
        return status?.sources?.find((s) => s.sourcekey === data.sourcekey)?.source?.title || fallback;
    } catch {
        return fallback;
    }
}

// read, apply, save under the rev read; a save that lost to another writer re-reads and reapplies
async function saveToFile(draw: BoardDraw): Promise<string> {
    const ref = { channelid: draw.channelid, boardid: draw.boardid };
    // loaded on the first draw: the shell mounts this at boot, and Excalidraw's runtime is ~2 MB
    const { convertSkeleton } = await import("./boardconvert");
    const converted = convertSkeleton(draw.skeleton);
    for (let i = 0; i < SAVE_TRIES; i++) {
        const read = await RpcApi.BoardReadCommand(TabRpcClient, ref);
        if (read?.info?.loaderror) {
            throw new BoardFileError(read.info.loaderror);
        }
        const scene = parseBoardFile(read.data);
        const { scene: next } = applyDraw(scene, draw, converted, Date.now());
        const saved = await RpcApi.BoardSaveCommand(TabRpcClient, {
            ...ref,
            data: serializeBoard(next),
            baserev: read.rev,
        });
        if (!saved?.conflict) {
            return read.info?.name || scene.arc.name;
        }
    }
    throw new Error(`the board changed under ${SAVE_TRIES} saves in a row`);
}

export function startBoardApplier(model: AgentsViewModel): () => void {
    // a draw is taken once; one that fails to land is let go, so the next inbox read retries it
    const taken = new Set<string>();
    const chains = new Map<string, Promise<void>>();
    let stopped = false;

    const openAction = (channelId: string, boardId: string) => ({
        label: "Open",
        run: () => fireAndForget(() => openTarget(model, { kind: "board", channelId, boardId })),
    });

    // true once the draw is on the board
    async function land(draw: BoardDraw): Promise<boolean> {
        if (stopped) {
            return false;
        }
        let name: string;
        try {
            const live = liveBoardApply(draw.boardid);
            if (live != null) {
                await live(draw);
                name = await boardName(draw.channelid, draw.boardid);
            } else {
                name = await saveToFile(draw);
            }
        } catch (e) {
            // a board that won't open keeps its draws, silently: the surface shows why it won't open
            console.warn("boards: a draw could not land; it stays in the inbox", draw.boardid, draw.id, e);
            return false;
        }
        try {
            await RpcApi.BoardInboxAckCommand(TabRpcClient, {
                channelid: draw.channelid,
                boardid: draw.boardid,
                drawid: draw.id,
            });
        } catch (e) {
            // the draw is on the board; left in the inbox, it lands again in place after a restart
            console.warn("boards: acking a landed draw failed", draw.boardid, draw.id, e);
        }
        pushToast({
            title: `Scribe drew ${shapesText(draw.shapes)} on ${name}`,
            message: `From ${draw.source.title}${draw.follow ? " · following" : ""}`,
            level: "info",
            action: openAction(draw.channelid, draw.boardid),
        });
        return true;
    }

    function take(draw: BoardDraw): void {
        if (stopped || taken.has(draw.id)) {
            return;
        }
        taken.add(draw.id);
        const prev = chains.get(draw.boardid) ?? Promise.resolve();
        chains.set(
            draw.boardid,
            prev.then(async () => {
                if (!(await land(draw))) {
                    taken.delete(draw.id);
                }
            })
        );
    }

    function readInbox(data: CommandBoardInboxData): void {
        RpcApi.BoardInboxCommand(TabRpcClient, data)
            .then((draws) => (draws ?? []).forEach(take))
            .catch((e) => console.warn("boards: reading the draw inbox failed", data, e));
    }

    async function onFailed(data: BoardUpdateData): Promise<void> {
        const [name, title] = await Promise.all([boardName(data.channelid, data.boardid), sourceTitle(data)]);
        if (stopped) {
            return;
        }
        pushToast({
            title: `Scribe couldn't draw on ${name}`,
            message: `${title}: ${data.reason || "no reason given"}`,
            level: "error",
            action: openAction(data.channelid, data.boardid),
        });
    }

    const unsubscribe = waveEventSubscribeSingle({
        eventType: "board:update",
        handler: (event) => {
            const data = event.data as BoardUpdateData;
            if (data?.what === "draw") {
                readInbox({ channelid: data.channelid, boardid: data.boardid });
            } else if (data?.what === "failed" && data.boardid) {
                fireAndForget(() => onFailed(data));
            }
        },
    });
    readInbox({});
    return () => {
        stopped = true;
        unsubscribe();
    };
}
