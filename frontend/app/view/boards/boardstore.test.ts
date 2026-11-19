// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
    BoardListCommand: vi.fn(),
    BoardTalkCommand: vi.fn(),
}));

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));

import { globalStore } from "@/app/store/jotaiStore";
import {
    boardListAtom,
    boardOwnsEscapeAtom,
    boardsChannelAtom,
    boardTalkAtom,
    liveBoardApply,
    loadBoardList,
    loadBoardTalk,
    onBoardUpdate,
    onLiveBoardRegistered,
    openBoardByChannelAtom,
    registerBoardEscape,
    registerLiveBoard,
    runBoardEscape,
    selectBoard,
    setBoardFormEscape,
} from "./boardstore";

const ABOUT: BoardSource = { kind: "project", ref: "", title: "" };

function talk(boardId: string, turns: BoardTurn[] = []): BoardTalk {
    return { channelid: "c1", boardid: boardId, about: ABOUT, turns };
}

function turn(id: string): BoardTurn {
    return { id, ts: 1, state: "answered", question: "How does it fit?" };
}

beforeEach(() => {
    vi.resetAllMocks();
    rpc.BoardListCommand.mockResolvedValue({ project: "waveterm", boards: [] });
    rpc.BoardTalkCommand.mockImplementation(async (_c, data: CommandBoardRefData) => talk(data.boardid));
});

describe("board selection", () => {
    it("selects a board within its project and keeps each project's own", () => {
        selectBoard("c1", "b1");
        selectBoard("c2", "b9");
        expect(globalStore.get(boardsChannelAtom)).toBe("c2");
        expect(globalStore.get(openBoardByChannelAtom)).toMatchObject({ c1: "b1", c2: "b9" });
    });
});

describe("board:update reloads", () => {
    it("reloads a loaded list on list, talk and answer", async () => {
        await loadBoardList("c1");
        rpc.BoardListCommand.mockClear();
        for (const what of ["list", "talk", "answer", "draw", "status"]) {
            onBoardUpdate({ channelid: "c1", boardid: "b1", what });
        }
        await vi.waitFor(() => expect(rpc.BoardListCommand).toHaveBeenCalledTimes(3));
    });

    it("reloads a loaded board's talk on talk and answer events, and ignores others", async () => {
        await loadBoardTalk("c1", "b1");
        rpc.BoardTalkCommand.mockClear();
        rpc.BoardTalkCommand.mockResolvedValue(talk("b1", [turn("t1")]));
        for (const what of ["talk", "answer", "draw", "status", "failed"]) {
            onBoardUpdate({ channelid: "c1", boardid: "b1", what });
        }
        await vi.waitFor(() => expect(rpc.BoardTalkCommand).toHaveBeenCalledTimes(2));
        expect(rpc.BoardTalkCommand).toHaveBeenLastCalledWith({}, { channelid: "c1", boardid: "b1" });
        await vi.waitFor(() => expect(globalStore.get(boardTalkAtom("b1"))?.turns.map((t) => t.id)).toEqual(["t1"]));
    });

    it("leaves an unread project and board alone", () => {
        onBoardUpdate({ channelid: "c-unread", boardid: "b-unread", what: "talk" });
        expect(rpc.BoardListCommand).not.toHaveBeenCalled();
        expect(rpc.BoardTalkCommand).not.toHaveBeenCalled();
    });

    it("lands only the latest of two overlapping list reads", async () => {
        let first!: (v: BoardListRtnData) => void;
        rpc.BoardListCommand.mockImplementationOnce(() => new Promise((r) => (first = r))).mockResolvedValueOnce({
            project: "waveterm",
            boards: [{ id: "b2", name: "new", channelid: "c3", path: "", createdts: 2 }],
        });
        const older = loadBoardList("c3");
        await loadBoardList("c3");
        first({ project: "waveterm", boards: [] });
        await older;
        expect(globalStore.get(boardListAtom("c3"))?.boards.map((b) => b.id)).toEqual(["b2"]);
    });

    it("lands only the latest of two overlapping talk reads", async () => {
        let first!: (v: BoardTalk) => void;
        rpc.BoardTalkCommand.mockImplementationOnce(() => new Promise((r) => (first = r))).mockResolvedValueOnce(
            talk("b7", [turn("t2")])
        );
        const older = loadBoardTalk("c1", "b7");
        await loadBoardTalk("c1", "b7");
        first(talk("b7"));
        await older;
        expect(globalStore.get(boardTalkAtom("b7"))?.turns.map((t) => t.id)).toEqual(["t2"]);
    });
});

describe("loadBoardTalk", () => {
    it("keeps the board's agent", async () => {
        const agent: BoardAgent = { tabid: "tab1", title: "claude · waveterm", runtime: "claude", readts: 5 };
        rpc.BoardTalkCommand.mockResolvedValueOnce({ ...talk("b8"), agent });
        await loadBoardTalk("c1", "b8");
        expect(globalStore.get(boardTalkAtom("b8"))?.agent).toEqual(agent);
    });
});

describe("the open canvas's hooks", () => {
    it("routes answers to a registered board until it unregisters", async () => {
        const apply = vi.fn(async () => ["s1"]);
        const unregister = registerLiveBoard("c1", "b1", apply);
        expect(liveBoardApply("b1")).toBe(apply);
        unregister();
        expect(liveBoardApply("b1")).toBeUndefined();
    });

    it("tells registration listeners which board opened, until they unsubscribe", () => {
        const heard = vi.fn();
        const unsubscribe = onLiveBoardRegistered(heard);
        const unregister = registerLiveBoard("c1", "b1", vi.fn());
        expect(heard).toHaveBeenCalledExactlyOnceWith("c1", "b1");
        unregister();
        unsubscribe();
        registerLiveBoard("c1", "b2", vi.fn())();
        expect(heard).toHaveBeenCalledOnce();
    });

    it("keeps a newer canvas's handler when an older one unregisters", () => {
        const older = registerLiveBoard("c1", "b1", vi.fn());
        const newer = vi.fn();
        const unregisterNewer = registerLiveBoard("c1", "b1", newer);
        older();
        expect(liveBoardApply("b1")).toBe(newer);
        unregisterNewer();
    });

    it("sends answers to the newer of two canvases on one board, and back to the older when the newer goes", () => {
        const older = vi.fn(async () => ["s1"]);
        const newer = vi.fn(async () => ["s2"]);
        const unregisterOlder = registerLiveBoard("c1", "b1", older);
        const unregisterNewer = registerLiveBoard("c1", "b1", newer);
        expect(liveBoardApply("b1")).toBe(newer);
        unregisterNewer();
        expect(liveBoardApply("b1")).toBe(older);
        unregisterOlder();
        expect(liveBoardApply("b1")).toBeUndefined();
    });

    it("runs the top canvas's Escape, and falls back as canvases unmount in either order", () => {
        const first = vi.fn();
        const second = vi.fn();
        const a = registerBoardEscape(first);
        const b = registerBoardEscape(second);
        expect(runBoardEscape()).toBe(true);
        expect(second).toHaveBeenCalledOnce();
        expect(first).not.toHaveBeenCalled();
        b.unregister();
        runBoardEscape();
        expect(first).toHaveBeenCalledOnce();
        const c = registerBoardEscape(second);
        a.unregister();
        runBoardEscape();
        expect(second).toHaveBeenCalledTimes(2);
        expect(first).toHaveBeenCalledOnce();
        c.unregister();
        expect(runBoardEscape()).toBe(false);
    });

    it("owns Escape by the top canvas's flag only", () => {
        const lower = registerBoardEscape(vi.fn());
        const top = registerBoardEscape(vi.fn());
        lower.setOwns(true);
        expect(globalStore.get(boardOwnsEscapeAtom)).toBe(false);
        top.setOwns(true);
        expect(globalStore.get(boardOwnsEscapeAtom)).toBe(true);
        top.unregister();
        expect(globalStore.get(boardOwnsEscapeAtom)).toBe(true);
        lower.setOwns(false);
        expect(globalStore.get(boardOwnsEscapeAtom)).toBe(false);
        lower.setOwns(true);
        lower.unregister();
        expect(globalStore.get(boardOwnsEscapeAtom)).toBe(false);
    });

    it("an open form owns Escape before the canvas, and gives it back when it closes", () => {
        const clear = vi.fn();
        const cancel = vi.fn();
        const canvas = registerBoardEscape(clear);
        setBoardFormEscape(cancel);
        expect(globalStore.get(boardOwnsEscapeAtom)).toBe(true);
        runBoardEscape();
        expect(cancel).toHaveBeenCalledOnce();
        expect(clear).not.toHaveBeenCalled();
        setBoardFormEscape(null);
        expect(globalStore.get(boardOwnsEscapeAtom)).toBe(false);
        canvas.setOwns(true);
        expect(globalStore.get(boardOwnsEscapeAtom)).toBe(true);
        canvas.unregister();
        expect(globalStore.get(boardOwnsEscapeAtom)).toBe(false);
    });
});
