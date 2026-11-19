// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Boards surface's state, kept at module level because the surface unmounts on a switch (and the router
// writes the selection before it switches here): which project and board are open, each project's board list,
// each open board's talk and viewport, and the open canvas's live-apply and Escape hooks. A board:update event
// reloads whatever is loaded.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { atomFamily } from "jotai/utils";

export interface BoardViewport {
    scrollX: number;
    scrollY: number;
    zoom: number;
}

// the surface's explicit project, until a switcher change made while Boards shows; null = the cockpit's current one
export const boardsChannelAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const openBoardByChannelAtom = atom<Record<string, string>>({}) as PrimitiveAtom<Record<string, string>>;

// null = not read yet
export const boardListAtom = atomFamily(
    (_channelId: string) => atom<BoardListRtnData | null>(null) as PrimitiveAtom<BoardListRtnData | null>
);
export const boardTalkAtom = atomFamily(
    (_boardId: string) => atom<BoardTalk | null>(null) as PrimitiveAtom<BoardTalk | null>
);
export const boardViewportAtom = atomFamily(
    (_boardId: string) => atom<BoardViewport | null>(null) as PrimitiveAtom<BoardViewport | null>
);

// the open canvas has a selection or an active tool, or an ask form is open, so Escape is the board's before it
// is the shell's
export const boardOwnsEscapeAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

export function selectBoard(channelId: string, boardId: string): void {
    globalStore.set(boardsChannelAtom, channelId);
    globalStore.set(openBoardByChannelAtom, (prev) => ({ ...prev, [channelId]: boardId }));
}

// an update event can start a read while an earlier one is in flight; only the latest may land
const listSeq = new Map<string, number>();
const talkSeq = new Map<string, number>();
// what has been read, so an event reloads it; a talk remembers its channel for the reload
const loadedChannels = new Set<string>();
const loadedTalks = new Map<string, string>();

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

export async function loadBoardTalk(channelId: string, boardId: string): Promise<BoardTalk> {
    loadedTalks.set(boardId, channelId);
    const latest = nextSeq(talkSeq, boardId);
    const rtn = await RpcApi.BoardTalkCommand(TabRpcClient, { channelid: channelId, boardid: boardId });
    const talk: BoardTalk = {
        channelid: channelId,
        boardid: boardId,
        about: rtn?.about ?? { kind: "", ref: "", title: "" },
        sessionid: rtn?.sessionid,
        handoff: rtn?.handoff,
        agent: rtn?.agent,
        turns: rtn?.turns ?? [],
    };
    if (latest()) {
        globalStore.set(boardTalkAtom(boardId), talk);
    }
    return talk;
}

// a turn's state and an answer change the list's facts (questions, answered, the switcher's marks) as well
const LIST_EVENTS = new Set(["list", "talk", "answer"]);
const TALK_EVENTS = new Set(["list", "talk", "answer"]);

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
    if (data.boardid && TALK_EVENTS.has(data.what) && loadedTalks.has(data.boardid)) {
        const channelId = loadedTalks.get(data.boardid);
        reload("talk", () => loadBoardTalk(channelId, data.boardid));
    }
}

export function subscribeBoardUpdates(): () => void {
    return waveEventSubscribeSingle({
        eventType: "board:update",
        handler: (event) => onBoardUpdate(event.data as BoardUpdateData),
    });
}

// --- the open canvas

// lands an answer on the open canvas and returns the shape ids it added or changed
export type LiveBoardApply = (answer: BoardAnswer) => Promise<string[]>;

// a stack per board: one board can be mounted twice (its tab in the agent's workspace, which stays mounted, and the
// Boards surface), the newest applies answers, and when it goes the one before takes them again
const liveBoards = new Map<string, LiveBoardApply[]>();
const registeredListeners = new Set<(channelId: string, boardId: string) => void>();

// the open canvas takes answers itself (updateScene), so a hand edit is never overwritten by a stale-rev save.
// listeners hear every open, so a board's waiting answers land when it opens (a first open, a re-open, a Retry).
export function registerLiveBoard(channelId: string, boardId: string, apply: LiveBoardApply): () => void {
    liveBoards.set(boardId, [...(liveBoards.get(boardId) ?? []), apply]);
    registeredListeners.forEach((fn) => fn(channelId, boardId));
    return () => {
        const rest = (liveBoards.get(boardId) ?? []).filter((fn) => fn !== apply);
        if (rest.length > 0) {
            liveBoards.set(boardId, rest);
        } else {
            liveBoards.delete(boardId);
        }
    };
}

export function liveBoardApply(boardId: string): LiveBoardApply | undefined {
    return liveBoards.get(boardId)?.at(-1);
}

export function onLiveBoardRegistered(fn: (channelId: string, boardId: string) => void): () => void {
    registeredListeners.add(fn);
    return () => {
        registeredListeners.delete(fn);
    };
}

// --- Escape: an open ask form's Cancel first, then the canvas's selection or tool

let boardEscape: (() => void) | null = null;
let formEscape: (() => void) | null = null;
let canvasOwnsEscape = false;

function syncOwnsEscape(): void {
    globalStore.set(boardOwnsEscapeAtom, formEscape != null || canvasOwnsEscape);
}

// the canvas registers what clearing its selection or tool means; the keybindings never import Excalidraw
export function setBoardEscape(fn: (() => void) | null): void {
    boardEscape = fn;
    if (fn == null) {
        setCanvasOwnsEscape(false);
    }
}

export function setCanvasOwnsEscape(owns: boolean): void {
    canvasOwnsEscape = owns;
    syncOwnsEscape();
}

// an open ask form cancels on Escape even when focus is on its buttons, before the shell's Escape-home sees it
export function setBoardFormEscape(fn: (() => void) | null): void {
    formEscape = fn;
    syncOwnsEscape();
}

export function runBoardEscape(): boolean {
    const fn = formEscape ?? boardEscape;
    if (fn == null) {
        return false;
    }
    fn();
    return true;
}
