// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
    BoardInboxCommand: vi.fn(),
    BoardInboxAckCommand: vi.fn(),
    BoardReadCommand: vi.fn(),
    BoardSaveCommand: vi.fn(),
    BoardListCommand: vi.fn(),
    BoardStatusCommand: vi.fn(),
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
vi.mock("./boardconvert", () => ({
    convertSkeleton: () => [
        {
            id: "r1",
            type: "rectangle",
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            groupIds: [],
            isDeleted: false,
            version: 1,
            customData: undefined,
        },
    ],
}));

import type { AgentsViewModel } from "../agents/agents";
import { startBoardApplier } from "./boardapplier";
import { parseBoardFile } from "./boardmodel";
import { registerLiveBoard } from "./boardstore";

const model = {} as AgentsViewModel;
const BOARD = "0a1b2c3d";

const draw: BoardDraw = {
    id: "d-1",
    channelid: "c1",
    boardid: BOARD,
    sourcekey: "run:r1",
    source: { kind: "run", ref: "r1", channelid: "c1", title: "run 690cc20a" },
    skeleton: '[{"type":"rectangle","x":0,"y":0}]',
    shapes: 3,
    ts: 1,
};

const emptyBoard = JSON.stringify({ arc: { name: "Escalation", createdts: 1 }, elements: [], appState: {}, files: {} });

function readRtn(rev: string): BoardReadRtnData {
    return {
        info: { id: BOARD, name: "Escalation", channelid: "c1", path: "/b.excalidraw", groups: 0, createdts: 1 },
        data: emptyBoard,
        rev,
        arc: { name: "Escalation", createdts: 1 },
    };
}

function emit(data: BoardUpdateData): void {
    handlers.forEach((h) => h({ data }));
}

let stop: () => void = () => {};

beforeEach(() => {
    vi.resetAllMocks();
    rpc.BoardInboxCommand.mockResolvedValue([]);
    rpc.BoardInboxAckCommand.mockResolvedValue(undefined);
    rpc.BoardListCommand.mockResolvedValue({
        project: "waveterm",
        boards: [{ id: BOARD, name: "Escalation", channelid: "c1", path: "", groups: 0, createdts: 1 }],
    });
    rpc.BoardReadCommand.mockResolvedValue(readRtn("rev-1"));
    rpc.BoardSaveCommand.mockResolvedValue({ rev: "rev-2" });
});

afterEach(() => stop());

describe("the board applier", () => {
    it("saves a draw for a closed board, then acks it, then toasts", async () => {
        const order: string[] = [];
        rpc.BoardInboxCommand.mockResolvedValue([draw]);
        rpc.BoardSaveCommand.mockImplementation(async () => (order.push("save"), { rev: "rev-2" }));
        rpc.BoardInboxAckCommand.mockImplementation(async () => void order.push("ack"));
        pushToast.mockImplementation(() => order.push("toast"));
        stop = startBoardApplier(model);
        await vi.waitFor(() => expect(order).toEqual(["save", "ack", "toast"]));
        const save = rpc.BoardSaveCommand.mock.calls[0][1];
        expect(save.baserev).toBe("rev-1");
        const saved = parseBoardFile(save.data);
        expect(saved.arc.sources?.map((s) => s.key)).toEqual(["run:r1"]);
        expect(saved.elements[0].customData?.arcSource).toBe("run:r1");
        expect(rpc.BoardInboxAckCommand.mock.calls[0][1]).toEqual({ channelid: "c1", boardid: BOARD, drawid: "d-1" });
        expect(pushToast.mock.calls[0][0]).toMatchObject({
            title: "Scribe drew 3 shapes on Escalation",
            message: "From run 690cc20a",
            level: "info",
            action: { label: "Open" },
        });
    });

    it("re-reads and saves once more when the save lost to another writer", async () => {
        rpc.BoardInboxCommand.mockResolvedValue([draw]);
        rpc.BoardReadCommand.mockResolvedValueOnce(readRtn("rev-1")).mockResolvedValueOnce(readRtn("rev-9"));
        rpc.BoardSaveCommand.mockResolvedValueOnce({ conflict: true }).mockResolvedValueOnce({ rev: "rev-10" });
        stop = startBoardApplier(model);
        await vi.waitFor(() => expect(rpc.BoardInboxAckCommand).toHaveBeenCalledOnce());
        expect(rpc.BoardReadCommand).toHaveBeenCalledTimes(2);
        expect(rpc.BoardSaveCommand.mock.calls.map((c) => c[1].baserev)).toEqual(["rev-1", "rev-9"]);
    });

    it("hands a live board's draw to its canvas and saves nothing itself", async () => {
        const apply = vi.fn(async () => "new" as const);
        const unregister = registerLiveBoard(BOARD, apply);
        try {
            stop = startBoardApplier(model);
            await vi.waitFor(() => expect(rpc.BoardInboxCommand).toHaveBeenCalled());
            rpc.BoardInboxCommand.mockResolvedValue([{ ...draw, follow: true }]);
            emit({ channelid: "c1", boardid: BOARD, what: "draw" });
            await vi.waitFor(() => expect(pushToast).toHaveBeenCalledOnce());
            expect(rpc.BoardInboxCommand).toHaveBeenLastCalledWith({}, { channelid: "c1", boardid: BOARD });
            expect(apply).toHaveBeenCalledWith(expect.objectContaining({ id: "d-1" }));
            expect(rpc.BoardReadCommand).not.toHaveBeenCalled();
            expect(rpc.BoardSaveCommand).not.toHaveBeenCalled();
            expect(rpc.BoardInboxAckCommand).toHaveBeenCalledOnce();
            expect(pushToast.mock.calls[0][0].message).toBe("From run 690cc20a · following");
        } finally {
            unregister();
        }
    });

    it("leaves a draw on a board that won't open in the inbox, silently", async () => {
        rpc.BoardInboxCommand.mockResolvedValue([draw]);
        rpc.BoardReadCommand.mockRejectedValue(new Error("its file is not valid Excalidraw JSON (x, at line 3)"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        stop = startBoardApplier(model);
        await vi.waitFor(() => expect(warn).toHaveBeenCalled());
        expect(rpc.BoardSaveCommand).not.toHaveBeenCalled();
        expect(rpc.BoardInboxAckCommand).not.toHaveBeenCalled();
        expect(pushToast).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it("toasts a failed pass with the board, the source and the reason, and an Open", async () => {
        rpc.BoardStatusCommand.mockResolvedValue({
            channelid: "c1",
            boardid: BOARD,
            sources: [{ sourcekey: "run:r1", source: draw.source, state: "failed", reason: "timed out", ts: 1 }],
        });
        stop = startBoardApplier(model);
        emit({ channelid: "c1", boardid: BOARD, what: "failed", sourcekey: "run:r1", reason: "timed out" });
        await vi.waitFor(() => expect(pushToast).toHaveBeenCalledOnce());
        const toast = pushToast.mock.calls[0][0];
        expect(toast).toMatchObject({
            title: "Scribe couldn't draw on Escalation",
            message: "run 690cc20a: timed out",
            level: "error",
            action: { label: "Open" },
        });
        openTarget.mockResolvedValue({ ok: true });
        toast.action.run();
        expect(openTarget).toHaveBeenCalledWith(model, { kind: "board", channelId: "c1", boardId: BOARD });
    });
});
