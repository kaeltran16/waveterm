// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
    BoardListCommand: vi.fn(),
    BoardStatusCommand: vi.fn(),
}));
const tabs = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("@/app/store/wos", async () => {
    const { atom } = await import("jotai");
    const atoms = new Map<string, unknown>();
    return {
        makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
        getWaveObjectAtom: (oref: string) => {
            if (!atoms.has(oref)) {
                atoms.set(
                    oref,
                    atom(() => tabs.get(oref) ?? null)
                );
            }
            return atoms.get(oref);
        },
    };
});

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";
import type { AgentsViewModel } from "../agents/agents";
import type { AgentVM } from "../agents/agentsviewmodel";
import {
    boardFollowsAtom,
    boardListAtom,
    boardsChannelAtom,
    boardStatusAtom,
    liveBoardApply,
    loadBoardList,
    loadBoardStatus,
    onBoardUpdate,
    onLiveBoardRegistered,
    openBoardByChannelAtom,
    registerLiveBoard,
    runBoardEscape,
    selectBoard,
    setBoardEscape,
} from "./boardstore";

function followMeta(boardId: string, ask = ""): MetaType {
    return {
        "board:followid": boardId,
        "board:followchannel": "c1",
        "board:followname": "Escalation",
        "board:followask": ask,
    };
}

beforeEach(() => {
    vi.resetAllMocks();
    tabs.clear();
    rpc.BoardListCommand.mockResolvedValue({ project: "waveterm", boards: [] });
    rpc.BoardStatusCommand.mockResolvedValue({ channelid: "c1", boardid: "b1", sources: [] });
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
    it("reloads a loaded list on list, draw and failed, and a loaded status on status, draw and failed", async () => {
        await loadBoardList("c1");
        await loadBoardStatus("c1", "b1");
        rpc.BoardListCommand.mockClear();
        rpc.BoardStatusCommand.mockClear();
        for (const what of ["list", "status", "draw", "failed"]) {
            onBoardUpdate({ channelid: "c1", boardid: "b1", what });
        }
        await vi.waitFor(() => expect(rpc.BoardListCommand).toHaveBeenCalledTimes(3));
        expect(rpc.BoardStatusCommand).toHaveBeenCalledTimes(3);
        expect(rpc.BoardStatusCommand).toHaveBeenLastCalledWith({}, { channelid: "c1", boardid: "b1" });
    });

    it("leaves an unread project and board alone", () => {
        onBoardUpdate({ channelid: "c-unread", boardid: "b-unread", what: "draw" });
        expect(rpc.BoardListCommand).not.toHaveBeenCalled();
        expect(rpc.BoardStatusCommand).not.toHaveBeenCalled();
    });

    it("lands only the latest of two overlapping list reads", async () => {
        let first!: (v: BoardListRtnData) => void;
        rpc.BoardListCommand.mockImplementationOnce(() => new Promise((r) => (first = r))).mockResolvedValueOnce({
            project: "waveterm",
            boards: [{ id: "b2", name: "new", channelid: "c3", path: "", groups: 0, createdts: 2 }],
        });
        const older = loadBoardList("c3");
        await loadBoardList("c3");
        first({ project: "waveterm", boards: [] });
        await older;
        expect(globalStore.get(boardListAtom("c3"))?.boards.map((b) => b.id)).toEqual(["b2"]);
    });

    it("stores a board's status", async () => {
        rpc.BoardStatusCommand.mockResolvedValue({
            channelid: "c1",
            boardid: "b5",
            sources: [
                { sourcekey: "run:r1", source: { kind: "run", ref: "r1", title: "run r1" }, state: "drawing", ts: 1 },
            ],
        });
        await loadBoardStatus("c1", "b5");
        expect(globalStore.get(boardStatusAtom("b5"))?.sources.map((s) => s.state)).toEqual(["drawing"]);
    });
});

describe("useBoardFollows", () => {
    function makeModel(ids: string[]): AgentsViewModel & { agentsAtom: PrimitiveAtom<AgentVM[]> } {
        const vm = (id: string) => ({ id, name: `claude · ${id}`, task: "", state: "idle" }) as AgentVM;
        return { agentsAtom: atom(ids.map(vm)) } as unknown as AgentsViewModel & {
            agentsAtom: PrimitiveAtom<AgentVM[]>;
        };
    }

    it("lists the roster agents whose follow names the board, and drops one that left the roster", () => {
        tabs.set("tab:a1", { meta: followMeta("b1", "the escalation flow") });
        tabs.set("tab:a2", { meta: followMeta("b-other") });
        tabs.set("tab:a3", { meta: followMeta("b1") });
        const model = makeModel(["a1", "a2", "a3"]);
        const follows = boardFollowsAtom(model, "b1");
        expect(globalStore.get(follows)).toEqual([
            { tabId: "a1", agentName: "claude · a1", ask: "the escalation flow" },
            { tabId: "a3", agentName: "claude · a3", ask: "" },
        ]);
        globalStore.set(model.agentsAtom, (prev) => prev.filter((a) => a.id !== "a1"));
        expect(globalStore.get(follows).map((f) => f.tabId)).toEqual(["a3"]);
    });
});

describe("the open canvas's hooks", () => {
    it("routes draws to a registered board until it unregisters", async () => {
        const apply = vi.fn(async () => "new" as const);
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

    it("runs the canvas's Escape while one is registered", () => {
        const clear = vi.fn();
        setBoardEscape(clear);
        expect(runBoardEscape()).toBe(true);
        expect(clear).toHaveBeenCalledOnce();
        setBoardEscape(null);
        expect(runBoardEscape()).toBe(false);
    });
});
