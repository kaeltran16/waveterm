// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Boards surface's state, kept at module level because the surface unmounts on a switch (and the router
// writes the selection before it switches here): which project and board are open, each project's board list,
// each board's scribe status, its viewport, the agents following it, and the open canvas's live-apply and
// Escape hooks. A board:update event reloads whatever is loaded.

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, useAtomValue, type Atom, type PrimitiveAtom } from "jotai";
import { atomFamily } from "jotai/utils";
import { useMemo } from "react";
import type { AgentsViewModel } from "../agents/agents";
import { followOf, type ApplyOutcome, type BoardFollowMeta } from "./boardmodel";

export interface BoardViewport {
    scrollX: number;
    scrollY: number;
    zoom: number;
}

export interface BoardFollower {
    tabId: string;
    agentName: string;
    ask: string;
}

// the surface's explicit project, until a switcher change made while Boards shows; null = the cockpit's current one
export const boardsChannelAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const openBoardByChannelAtom = atom<Record<string, string>>({}) as PrimitiveAtom<Record<string, string>>;

// null = not read yet
export const boardListAtom = atomFamily(
    (_channelId: string) => atom<BoardListRtnData | null>(null) as PrimitiveAtom<BoardListRtnData | null>
);
export const boardStatusAtom = atomFamily(
    (_boardId: string) => atom<BoardStatusData | null>(null) as PrimitiveAtom<BoardStatusData | null>
);
export const boardViewportAtom = atomFamily(
    (_boardId: string) => atom<BoardViewport | null>(null) as PrimitiveAtom<BoardViewport | null>
);

// the open canvas has a selection or an active tool, so Escape is the canvas's before it is the shell's
export const boardOwnsEscapeAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

export function selectBoard(channelId: string, boardId: string): void {
    globalStore.set(boardsChannelAtom, channelId);
    globalStore.set(openBoardByChannelAtom, (prev) => ({ ...prev, [channelId]: boardId }));
}

// an update event can start a read while an earlier one is in flight; only the latest may land
const listSeq = new Map<string, number>();
const statusSeq = new Map<string, number>();
// what has been read, so an event reloads it; a status remembers its channel for the reload
const loadedChannels = new Set<string>();
const loadedBoards = new Map<string, string>();

function nextSeq(seqs: Map<string, number>, key: string): () => boolean {
    const seq = (seqs.get(key) ?? 0) + 1;
    seqs.set(key, seq);
    return () => seqs.get(key) === seq;
}

export async function loadBoardList(channelId: string): Promise<BoardListRtnData> {
    loadedChannels.add(channelId);
    const latest = nextSeq(listSeq, channelId);
    const rtn = await RpcApi.BoardListCommand(TabRpcClient, { channelid: channelId });
    const list = { project: rtn?.project ?? "", boards: rtn?.boards ?? [] };
    if (latest()) {
        globalStore.set(boardListAtom(channelId), list);
    }
    return list;
}

export async function loadBoardStatus(channelId: string, boardId: string): Promise<BoardStatusData> {
    loadedBoards.set(boardId, channelId);
    const latest = nextSeq(statusSeq, boardId);
    const rtn = await RpcApi.BoardStatusCommand(TabRpcClient, { channelid: channelId, boardid: boardId });
    const status = { channelid: channelId, boardid: boardId, sources: rtn?.sources ?? [] };
    if (latest()) {
        globalStore.set(boardStatusAtom(boardId), status);
    }
    return status;
}

const LIST_EVENTS = new Set(["list", "draw", "failed"]);
const STATUS_EVENTS = new Set(["status", "draw", "failed"]);

function reload(what: string, load: () => Promise<unknown>): void {
    load().catch((e) => console.warn(`boards: reloading the ${what} after board:update failed`, e));
}

export function onBoardUpdate(data: BoardUpdateData | undefined): void {
    if (data == null) {
        return;
    }
    if (LIST_EVENTS.has(data.what) && loadedChannels.has(data.channelid)) {
        reload("list", () => loadBoardList(data.channelid));
    }
    if (data.boardid && STATUS_EVENTS.has(data.what) && loadedBoards.has(data.boardid)) {
        const channelId = loadedBoards.get(data.boardid);
        reload("status", () => loadBoardStatus(channelId, data.boardid));
    }
}

export function subscribeBoardUpdates(): () => void {
    return waveEventSubscribeSingle({
        eventType: "board:update",
        handler: (event) => onBoardUpdate(event.data as BoardUpdateData),
    });
}

// --- follows: live on the agent's tab meta (decision 12)

export function useAgentFollow(tabId: string): BoardFollowMeta | null {
    const [tab] = WOS.useWaveObjectValue<Tab>(WOS.makeORef("tab", tabId));
    const meta = tab?.meta;
    return useMemo(() => followOf(meta), [meta]);
}

// the live roster's agents whose follow names the board; an agent that leaves the roster leaves the list
export function boardFollowsAtom(model: AgentsViewModel, boardId: string): Atom<BoardFollower[]> {
    return atom((get) =>
        get(model.agentsAtom).flatMap((a) => {
            const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", a.id)));
            const follow = followOf(tab?.meta);
            return follow?.boardId === boardId ? [{ tabId: a.id, agentName: a.name, ask: follow.ask }] : [];
        })
    );
}

export function useBoardFollows(model: AgentsViewModel, boardId: string): BoardFollower[] {
    const followsAtom = useMemo(() => boardFollowsAtom(model, boardId), [model, boardId]);
    return useAtomValue(followsAtom);
}

// --- the open canvas

export type LiveBoardApply = (draw: BoardDraw) => Promise<ApplyOutcome>;

const liveBoards = new Map<string, LiveBoardApply>();
const registeredListeners = new Set<(channelId: string, boardId: string) => void>();

// the open canvas takes draws itself (updateScene), so a hand edit is never overwritten by a stale-rev save.
// listeners hear every open, so a board's waiting draws land when it opens (a first open, a re-open, a Retry).
export function registerLiveBoard(channelId: string, boardId: string, apply: LiveBoardApply): () => void {
    liveBoards.set(boardId, apply);
    registeredListeners.forEach((fn) => fn(channelId, boardId));
    return () => {
        if (liveBoards.get(boardId) === apply) {
            liveBoards.delete(boardId);
        }
    };
}

export function liveBoardApply(boardId: string): LiveBoardApply | undefined {
    return liveBoards.get(boardId);
}

export function onLiveBoardRegistered(fn: (channelId: string, boardId: string) => void): () => void {
    registeredListeners.add(fn);
    return () => {
        registeredListeners.delete(fn);
    };
}

let boardEscape: (() => void) | null = null;

// the canvas registers what clearing its selection or tool means; the keybindings never import Excalidraw
export function setBoardEscape(fn: (() => void) | null): void {
    boardEscape = fn;
}

export function runBoardEscape(): boolean {
    if (boardEscape == null) {
        return false;
    }
    boardEscape();
    return true;
}
