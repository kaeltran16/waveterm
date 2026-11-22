// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
    BoardAnswerInboxCommand: vi.fn(),
    BoardAnswerAckCommand: vi.fn(),
    BoardReadCommand: vi.fn(),
    BoardSaveCommand: vi.fn(),
    BoardListCommand: vi.fn(),
    BoardTalkCommand: vi.fn(),
}));
const pushToast = vi.hoisted(() => vi.fn());
const openTarget = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => [] as ((event: { data: unknown }) => void)[]);

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: { handler: (event: { data: unknown }) => void }) => {
        handlers.push(sub.handler);
        return () => handlers.splice(handlers.indexOf(sub.handler), 1);
    },
}));
vi.mock("@/app/cockpit/notificationstore", () => ({ pushToast: (...a: unknown[]) => pushToast(...a) }));
vi.mock("../jarvis/openref", () => ({ openTarget: (...a: unknown[]) => openTarget(...a) }));
// the real landAnswer converts through Excalidraw; this one adds one rectangle per answer
vi.mock("./boardconvert", () => ({
    landAnswer: (scene: { elements: unknown[] }, answer: BoardAnswer) => ({
        scene: {
            ...scene,
            elements: [
                ...scene.elements,
                { id: `${answer.id}-r`, type: "rectangle", x: 0, y: 0, width: 100, height: 50, isDeleted: false },
            ],
        },
        shapeIds: [`${answer.id}-r`],
        textIds: [],
    }),
}));

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";
import type { AgentsViewModel, SurfaceKey } from "../agents/agents";
import type { AgentVM } from "../agents/agentsviewmodel";
import { closeWorkspaceTab, openWorkspaceTab, workspaceAtom } from "../agents/workspacestore";
import { startBoardApplier } from "./boardapplier";
import { parseBoardFile } from "./boardmodel";
import { openBoardByChannelAtom, registerLiveBoard } from "./boardstore";

const BOARD = "0a1b2c3d";
const BOARD_KEY = `board:${BOARD}`;
const AGENT = "tab-applier";
const OTHER = "tab-applier-other";

const claude = (id: string): AgentVM => ({
    id,
    name: id,
    task: "",
    state: "idle",
    agent: "claude",
    blockId: `b-${id}`,
});

const model = {
    surfaceAtom: atom<SurfaceKey>("cockpit"),
    focusIdAtom: atom<string | undefined>(undefined),
    agentsAtom: atom<AgentVM[]>([claude(AGENT), claude(OTHER)]),
} as unknown as AgentsViewModel;

function showAgent(surface: SurfaceKey, focusId: string | undefined): void {
    globalStore.set(model.surfaceAtom as PrimitiveAtom<SurfaceKey>, surface);
    globalStore.set(model.focusIdAtom, focusId);
}

const answer: BoardAnswer = {
    id: "a-1",
    channelid: "c1",
    boardid: BOARD,
    turnid: "t-1",
    add: '[{"type":"rectangle","x":0,"y":0}]',
    ts: 1,
};

const emptyBoard = JSON.stringify({ arc: { name: "Escalation", createdts: 1 }, elements: [], appState: {}, files: {} });

function readRtn(rev: string): BoardReadRtnData {
    return {
        info: { id: BOARD, name: "Escalation", channelid: "c1", path: "/b.excalidraw", createdts: 1 },
        data: emptyBoard,
        rev,
        arc: { name: "Escalation", createdts: 1 },
    };
}

function emit(data: BoardUpdateData): void {
    handlers.forEach((h) => h({ data }));
}

function briefingTalk(state: string, from = "claude · waveterm"): BoardUpdateData {
    return { channelid: "c1", boardid: BOARD, what: "talk", turnid: "t-9", state, from };
}

let stop: () => void = () => {};

beforeEach(() => {
    vi.resetAllMocks();
    rpc.BoardAnswerInboxCommand.mockResolvedValue([]);
    rpc.BoardAnswerAckCommand.mockResolvedValue(undefined);
    rpc.BoardListCommand.mockResolvedValue({
        project: "waveterm",
        boards: [{ id: BOARD, name: "Escalation", channelid: "c1", path: "", createdts: 1 }],
    });
    rpc.BoardReadCommand.mockResolvedValue(readRtn("rev-1"));
    rpc.BoardSaveCommand.mockResolvedValue({ rev: "rev-2" });
    showAgent("cockpit", undefined);
});

afterEach(() => {
    stop();
    closeWorkspaceTab(AGENT, BOARD_KEY);
    closeWorkspaceTab(OTHER, BOARD_KEY);
    closeWorkspaceTab(AGENT, "changes");
    closeWorkspaceTab(OTHER, "changes");
});

describe("landing answers", () => {
    it("saves an answer for a closed board under the rev read, then acks it with its shape ids", async () => {
        const order: string[] = [];
        rpc.BoardAnswerInboxCommand.mockResolvedValue([answer]);
        rpc.BoardSaveCommand.mockImplementation(async () => (order.push("save"), { rev: "rev-2" }));
        rpc.BoardAnswerAckCommand.mockImplementation(async () => void order.push("ack"));
        stop = startBoardApplier(model);
        await vi.waitFor(() => expect(order).toEqual(["save", "ack"]));
        const save = rpc.BoardSaveCommand.mock.calls[0][1];
        expect(save.baserev).toBe("rev-1");
        expect(parseBoardFile(save.data).elements.map((el) => el.id)).toEqual(["a-1-r"]);
        expect(rpc.BoardAnswerAckCommand.mock.calls[0][1]).toEqual({
            channelid: "c1",
            boardid: BOARD,
            answerid: "a-1",
            turnid: "t-1",
            shapeids: ["a-1-r"],
        });
        expect(pushToast).not.toHaveBeenCalled();
    });

    it("re-reads and reapplies when the save lost to another writer", async () => {
        rpc.BoardAnswerInboxCommand.mockResolvedValue([answer]);
        rpc.BoardReadCommand.mockResolvedValueOnce(readRtn("rev-1")).mockResolvedValueOnce(readRtn("rev-9"));
        rpc.BoardSaveCommand.mockResolvedValueOnce({ conflict: true }).mockResolvedValueOnce({ rev: "rev-10" });
        stop = startBoardApplier(model);
        await vi.waitFor(() => expect(rpc.BoardAnswerAckCommand).toHaveBeenCalledOnce());
        expect(rpc.BoardReadCommand).toHaveBeenCalledTimes(2);
        expect(rpc.BoardSaveCommand.mock.calls.map((c) => c[1].baserev)).toEqual(["rev-1", "rev-9"]);
        expect(parseBoardFile(rpc.BoardSaveCommand.mock.calls[1][1].data).elements).toHaveLength(1);
    });

    it("hands an open board's answer to its canvas, saves nothing itself, and acks the canvas's shape ids", async () => {
        const apply = vi.fn(async () => ["s1", "s2"]);
        const unregister = registerLiveBoard("c1", BOARD, apply);
        try {
            stop = startBoardApplier(model);
            await vi.waitFor(() => expect(rpc.BoardAnswerInboxCommand).toHaveBeenCalled());
            rpc.BoardAnswerInboxCommand.mockResolvedValue([answer]);
            emit({ channelid: "c1", boardid: BOARD, what: "answer" });
            await vi.waitFor(() => expect(rpc.BoardAnswerAckCommand).toHaveBeenCalledOnce());
            expect(rpc.BoardAnswerInboxCommand).toHaveBeenLastCalledWith({}, { channelid: "c1", boardid: BOARD });
            expect(apply).toHaveBeenCalledWith(expect.objectContaining({ id: "a-1" }));
            expect(rpc.BoardReadCommand).not.toHaveBeenCalled();
            expect(rpc.BoardSaveCommand).not.toHaveBeenCalled();
            expect(rpc.BoardAnswerAckCommand.mock.calls[0][1].shapeids).toEqual(["s1", "s2"]);
        } finally {
            unregister();
        }
    });

    it("reads a board's inbox when it opens after start, and lands its waiting answer", async () => {
        stop = startBoardApplier(model);
        await vi.waitFor(() => expect(rpc.BoardAnswerInboxCommand).toHaveBeenCalledWith({}, {}));
        rpc.BoardAnswerInboxCommand.mockResolvedValue([answer]);
        const apply = vi.fn(async () => ["s1"]);
        const unregister = registerLiveBoard("c1", BOARD, apply);
        try {
            await vi.waitFor(() => expect(rpc.BoardAnswerAckCommand).toHaveBeenCalledOnce());
            expect(rpc.BoardAnswerInboxCommand).toHaveBeenLastCalledWith({}, { channelid: "c1", boardid: BOARD });
            expect(apply).toHaveBeenCalledWith(expect.objectContaining({ id: "a-1" }));
        } finally {
            unregister();
        }
    });

    it("leaves an answer that failed to land in the inbox, and lands it on the next read", async () => {
        rpc.BoardAnswerInboxCommand.mockResolvedValue([answer]);
        rpc.BoardReadCommand.mockRejectedValueOnce(new Error("its file is not valid Excalidraw JSON (x, at line 3)"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        stop = startBoardApplier(model);
        await vi.waitFor(() => expect(warn).toHaveBeenCalled());
        expect(rpc.BoardSaveCommand).not.toHaveBeenCalled();
        expect(rpc.BoardAnswerAckCommand).not.toHaveBeenCalled();
        emit({ channelid: "c1", boardid: BOARD, what: "answer" });
        await vi.waitFor(() => expect(rpc.BoardAnswerAckCommand).toHaveBeenCalledOnce());
        warn.mockRestore();
    });
});

describe("briefing toasts", () => {
    it("toasts an answered briefing turn once, with Open on its board", async () => {
        stop = startBoardApplier(model);
        emit(briefingTalk("answered"));
        emit(briefingTalk("answered"));
        await vi.waitFor(() => expect(pushToast).toHaveBeenCalledOnce());
        const toast = pushToast.mock.calls[0][0];
        expect(toast).toMatchObject({
            title: "The drawer drew on Escalation",
            message: "From claude · waveterm's briefing",
            level: "info",
            action: { label: "Open" },
        });
        openTarget.mockResolvedValue({ ok: true });
        toast.action.run();
        expect(openTarget).toHaveBeenCalledWith(model, { kind: "board", channelId: "c1", boardId: BOARD });
    });

    it("toasts a briefing turn that asks you", async () => {
        stop = startBoardApplier(model);
        emit(briefingTalk("asks"));
        await vi.waitFor(() => expect(pushToast).toHaveBeenCalledOnce());
        expect(pushToast.mock.calls[0][0]).toMatchObject({
            title: "The drawer asks you on Escalation",
            message: "Does claude · waveterm's briefing belong on a new board?",
            level: "info",
            action: { label: "Open" },
        });
    });

    it("toasts a failed briefing turn with the reason, and again after a Retry fails it", async () => {
        stop = startBoardApplier(model);
        emit({ ...briefingTalk("failed"), reason: "the drawer ran past its 10 minutes" });
        await vi.waitFor(() => expect(pushToast).toHaveBeenCalledOnce());
        expect(pushToast.mock.calls[0][0]).toMatchObject({
            title: "The drawer couldn't draw on Escalation",
            message: "the drawer ran past its 10 minutes",
            level: "error",
            action: { label: "Open" },
        });
        rpc.BoardTalkCommand.mockResolvedValue({
            channelid: "c1",
            boardid: BOARD,
            about: { kind: "briefing", ref: "", title: "claude · waveterm" },
            turns: [{ id: "t-9", ts: 1, state: "failed", reason: "the board's file won't open: bad json" }],
        });
        emit(briefingTalk("answering"));
        emit(briefingTalk("failed"));
        await vi.waitFor(() => expect(pushToast).toHaveBeenCalledTimes(2));
        expect(pushToast.mock.calls[1][0].message).toBe("the board's file won't open: bad json");
    });

    it("never toasts a turn without a briefing's sender, or a working state", async () => {
        stop = startBoardApplier(model);
        emit(briefingTalk("answered", ""));
        emit(briefingTalk("failed", ""));
        emit(briefingTalk("answering"));
        emit(briefingTalk("waiting"));
        await new Promise((r) => setTimeout(r, 20));
        expect(pushToast).not.toHaveBeenCalled();
    });
});

describe("toasts by placement", () => {
    function tiedList(): void {
        rpc.BoardListCommand.mockResolvedValue({
            project: "waveterm",
            boards: [{ id: BOARD, name: "Escalation", channelid: "c1", path: "", createdts: 1, agenttabid: AGENT }],
        });
    }

    it("stays quiet while the Agent surface shows the tied agent with its board pane open", async () => {
        tiedList();
        openWorkspaceTab(AGENT, { kind: "board", channelId: "c1", boardId: BOARD });
        showAgent("agent", AGENT);
        stop = startBoardApplier(model);
        emit(briefingTalk("answered"));
        emit(briefingTalk("failed"));
        await vi.waitFor(() => expect(rpc.BoardListCommand).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 20));
        expect(pushToast).not.toHaveBeenCalled();
    });

    it("toasts while another surface shows, and its Open goes through the router", async () => {
        tiedList();
        openWorkspaceTab(AGENT, { kind: "board", channelId: "c1", boardId: BOARD });
        showAgent("boards", AGENT);
        stop = startBoardApplier(model);
        emit(briefingTalk("answered"));
        await vi.waitFor(() => expect(pushToast).toHaveBeenCalledOnce());
        expect(pushToast.mock.calls[0][0].title).toBe("The drawer drew on Escalation");
        openTarget.mockResolvedValue({ ok: true });
        pushToast.mock.calls[0][0].action.run();
        expect(openTarget).toHaveBeenCalledWith(model, { kind: "board", channelId: "c1", boardId: BOARD });
    });

    it("toasts while the Agent surface shows another agent", async () => {
        tiedList();
        showAgent("agent", OTHER);
        stop = startBoardApplier(model);
        emit(briefingTalk("answered"));
        await vi.waitFor(() => expect(pushToast).toHaveBeenCalledOnce());
    });
});

describe("joins", () => {
    it("adds the board's tab behind the active one, unseen, in the joining agent's workspace", async () => {
        openWorkspaceTab(AGENT, { kind: "changes", selected: null });
        stop = startBoardApplier(model);
        emit({ channelid: "c1", boardid: BOARD, what: "join", agenttabid: AGENT });
        const ws = globalStore.get(workspaceAtom(AGENT));
        expect(ws.tabs.map((t) => t.kind)).toEqual(["changes", "board"]);
        expect(ws.active).toBe("changes");
        expect(ws.unseen).toEqual([BOARD_KEY]);
        expect(pushToast).not.toHaveBeenCalled();
    });

    it("moves the tab out of the agent it was with", async () => {
        openWorkspaceTab(AGENT, { kind: "changes", selected: null });
        openWorkspaceTab(OTHER, { kind: "changes", selected: null });
        stop = startBoardApplier(model);
        emit({ channelid: "c1", boardid: BOARD, what: "join", agenttabid: AGENT });
        emit({ channelid: "c1", boardid: BOARD, what: "join", agenttabid: OTHER });
        expect(globalStore.get(workspaceAtom(AGENT)).tabs.map((t) => t.kind)).toEqual(["changes"]);
        expect(globalStore.get(workspaceAtom(OTHER)).tabs.map((t) => t.kind)).toEqual(["changes", "board"]);
    });

    it.each([
        ["opens the joined board on Boards too", "agent" as SurfaceKey, { c1: BOARD }],
        ["leaves the board you are reading on Boards", "boards" as SurfaceKey, { c1: "b-reading" }],
    ])("%s", (_name, surface, open) => {
        globalStore.set(openBoardByChannelAtom, { c1: "b-reading" });
        showAgent(surface, AGENT);
        stop = startBoardApplier(model);
        emit({ channelid: "c1", boardid: BOARD, what: "join", agenttabid: AGENT });
        expect(globalStore.get(openBoardByChannelAtom)).toEqual(open);
    });
});
