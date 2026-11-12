import { describe, expect, it } from "vitest";
import {
    boardDrawEcho,
    boardPickList,
    boardSub,
    drawOnBoardAction,
    listedBoards,
    parseBoardChoice,
    pickBoardChannel,
} from "./boarddraw";
import type { BoardDrawTarget } from "./types";

const board = (over: Partial<BoardInfo> = {}): BoardInfo => ({
    id: "0a1b2c3d",
    name: "Brainstorm internals",
    channelid: "ch1",
    path: "C:/data/boards/waveterm/0a1b2c3d.excalidraw",
    groups: 4,
    createdts: 0,
    ...over,
});
const channel = (oid: string, name: string, projectpath?: string) =>
    ({ oid, otype: "channel", version: 1, name, projectpath, createdts: 0 }) as Channel;

describe("drawOnBoardAction", () => {
    const target = (t: { ok: boolean }): BoardDrawTarget | null =>
        t.ok ? { channelId: "ch1", source: { kind: "run", ref: "r1", title: "run r1" }, followable: false } : null;
    const action = drawOnBoardAction("run", target);

    it("is the open group's Draw on a board…, taking a board", () => {
        expect(action.id).toBe("run:draw-board");
        expect(action.label).toBe("Draw on a board…");
        expect(action.group).toBe("open");
        expect(action.input?.kind).toBe("board");
    });
    it("applies only when the thing has a target", () => {
        expect(action.applies({ ok: true })).toBe(true);
        expect(action.applies({ ok: false })).toBe(false);
    });
    it("refuses a run without a board choice", () => {
        expect(() => action.run({ ok: true }, {} as any)).toThrow(/board/);
    });
});

describe("parseBoardChoice", () => {
    it("reads the drill's choice back", () => {
        expect(parseBoardChoice(JSON.stringify({ boardId: "0a1b2c3d", ask: "the flow", follow: true }))).toEqual({
            boardId: "0a1b2c3d",
            ask: "the flow",
            follow: true,
        });
    });
    it("refuses a value with no board id", () => {
        expect(() => parseBoardChoice(JSON.stringify({ ask: "x" }))).toThrow(/board/);
        expect(() => parseBoardChoice(undefined)).toThrow(/board/);
    });
});

describe("boardDrawEcho", () => {
    const base = { title: "claude · waveterm", board: "Brainstorm internals" };
    it("says the ask and the follow when there are both", () => {
        expect(boardDrawEcho({ ...base, ask: "the escalation flow", follow: true })).toBe(
            "Draw claude · waveterm: the escalation flow on Brainstorm internals, and keep following"
        );
    });
    it("leaves out an empty ask and an unticked follow", () => {
        expect(boardDrawEcho({ ...base, ask: "  ", follow: false })).toBe(
            "Draw claude · waveterm on Brainstorm internals"
        );
    });
    it("says the ask without a follow", () => {
        expect(boardDrawEcho({ ...base, ask: "the flow", follow: false })).toBe(
            "Draw claude · waveterm: the flow on Brainstorm internals"
        );
    });
});

describe("boardSub", () => {
    const now = new Date(2026, 10, 12, 18, 0).getTime();
    it("counts groups and says the last drawn time, today as HH:MM", () => {
        expect(boardSub(board({ lastdrawnts: new Date(2026, 10, 12, 16, 4).getTime() }), now)).toBe("4 groups · 16:04");
    });
    it("says one group, and an earlier day as MM-DD, falling back to when it was made", () => {
        expect(boardSub(board({ groups: 1, createdts: new Date(2026, 10, 4, 9, 0).getTime() }), now)).toBe(
            "1 group · 11-04"
        );
    });
    it("says a damaged board won't open", () => {
        expect(boardSub(board({ loaderror: "unexpected end of JSON" }), now)).toBe("won't open");
    });
});

describe("boardPickList", () => {
    const boards = [board(), board({ id: "11111111", name: "dag-lock bug" })];
    it("lists every board and a plain New board… with nothing typed", () => {
        const r = boardPickList(boards, "");
        expect(r.boards.map((b) => b.name)).toEqual(["Brainstorm internals", "dag-lock bug"]);
        expect(r.newName).toBe("");
    });
    it("filters by what was typed, carrying an unmatched name into New board", () => {
        const r = boardPickList(boards, "dag");
        expect(r.boards.map((b) => b.name)).toEqual(["dag-lock bug"]);
        expect(r.newName).toBe("dag");
    });
    it("carries nothing when the typed name is a board's own, in any case", () => {
        expect(boardPickList(boards, "  DAG-LOCK bug ").newName).toBe("");
    });
    it("carries a name that matches no board at all", () => {
        const r = boardPickList(boards, "Escalation flow");
        expect(r.boards).toEqual([]);
        expect(r.newName).toBe("Escalation flow");
    });
});

describe("pickBoardChannel", () => {
    const channels = [channel("ch1", "waveterm", "C:\\work\\waveterm"), channel("ch2", "siem", "C:/work/siem")];
    const current = () => channels[1];
    it("takes the channel whose project path matches, whatever the separators", () => {
        expect(pickBoardChannel(channels, current, "C:/work/waveterm/")).toBe("ch1");
    });
    it("falls back to the channel named like the project, then the current project", () => {
        expect(pickBoardChannel(channels, current, "C:/elsewhere", "waveterm")).toBe("ch1");
        expect(pickBoardChannel(channels, current, "C:/elsewhere", "nope")).toBe("ch2");
        expect(pickBoardChannel(channels, current)).toBe("ch2");
    });
    it("has no channel with no match and no current project", () => {
        expect(pickBoardChannel(channels, () => null, "C:/elsewhere")).toBeNull();
        expect(pickBoardChannel(null, () => null)).toBeNull();
    });
});

describe("listedBoards", () => {
    const data: BoardListRtnData = { project: "waveterm", boards: [board()] };

    it("is null at boot, with no list and no board drill", () => {
        expect(listedBoards(null, undefined)).toBeNull();
    });

    it("is null before the list for the channel loads", () => {
        expect(listedBoards(null, "ch1")).toBeNull();
    });

    it("is null for a stale list read for another channel", () => {
        expect(listedBoards({ channelId: "ch1", data }, "ch2")).toBeNull();
    });

    it("is the list's data when it was read for the channel", () => {
        expect(listedBoards({ channelId: "ch1", data }, "ch1")).toBe(data);
    });
});
