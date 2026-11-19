// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { describe, expect, it } from "vitest";
import {
    aboutLine,
    aboutTitle,
    agentChip,
    agentChoices,
    askBox,
    besideLines,
    boardFacts,
    drawerWorking,
    elapsedText,
    SLOW_AFTER_MS,
    switcherGroups,
    switcherRows,
    talkItems as talkItemsIn,
    talkTime,
    type Placement,
} from "./boardtalkmodel";

const at = (h: number, m: number, s = 0) => new Date(2026, 10, 12, h, m, s).getTime();
const NOW = at(16, 0);

const about: BoardSource = { kind: "project", ref: "", title: "waveterm" };

// the Boards surface's items unless a test names another placement
const talkItems = (t: BoardTalk, now: number, placement: Placement = "surface") => talkItemsIn(t, now, placement);

function turn(over: Partial<BoardTurn>): BoardTurn {
    return { id: "t1", ts: at(15, 20), state: "answered", ...over };
}

function talk(turns: BoardTurn[], agent?: BoardAgent): BoardTalk {
    return { channelid: "ch1", boardid: "b1", about, turns, agent };
}

function agentVM(over: Partial<AgentVM>): AgentVM {
    return {
        id: "tab1",
        name: "claude · waveterm",
        task: "",
        state: "idle",
        agent: "claude",
        project: "waveterm",
        blockId: "blk1",
        ...over,
    };
}

const CLAUDE: BoardAgent = { tabid: "tab1", title: "claude · waveterm", runtime: "claude" };

function info(over: Partial<BoardInfo>): BoardInfo {
    return { id: "b1", name: "Board", channelid: "ch1", path: "/b1", createdts: at(9, 0), ...over };
}

describe("talkItems", () => {
    it("shows an answered first turn that only added shapes as 'drew N shapes'", () => {
        const items = talkItems(
            talk([
                turn({
                    question: "How does wavesrv start?",
                    on: "wavesrv",
                    reply: "Opened it up.",
                    title: "wavesrv, opened up",
                    added: 5,
                    shapeids: ["a", "b"],
                    answeredts: at(15, 20),
                }),
            ]),
            NOW
        );
        expect(items).toEqual([
            { kind: "question", turnId: "t1", text: "How does wavesrv start?", on: "wavesrv" },
            {
                kind: "reply",
                turnId: "t1",
                text: "Opened it up.",
                card: { title: "wavesrv, opened up", summary: "drew 5 shapes · 15:20", shapeIds: ["a", "b"] },
                reroute: "agent",
            },
        ]);
    });

    it("words the card by the non-zero parts after the first answered turn", () => {
        const items = talkItems(
            talk([
                turn({ id: "t1", question: "q1", reply: "r1", title: "one", added: 3, answeredts: at(15, 20) }),
                turn({
                    id: "t2",
                    question: "q2",
                    reply: "r2",
                    title: "two",
                    added: 1,
                    changed: 2,
                    removed: 4,
                    answeredts: at(15, 30),
                }),
                turn({ id: "t3", question: "q3", reply: "r3", title: "three", changed: 1, answeredts: at(15, 40) }),
            ]),
            NOW
        );
        const cards = items.flatMap((i) => (i.kind === "reply" && i.card ? [i.card.summary] : []));
        expect(cards).toEqual([
            "drew 3 shapes · 15:20",
            "added 1 shape · changed 2 · removed 4 · 15:30",
            "changed 1 · 15:40",
        ]);
    });

    it("words a first answered turn that also changed things by its parts", () => {
        const items = talkItems(
            talk([turn({ question: "q", reply: "r", title: "t", added: 2, changed: 1, answeredts: at(15, 20) })]),
            NOW
        );
        expect(items[1]).toMatchObject({ card: { summary: "added 2 shapes · changed 1 · 15:20" } });
    });

    it("counts the first answered turn, not the first turn", () => {
        const items = talkItems(
            talk([
                turn({ id: "t1", question: "q1", state: "failed", reason: "boom" }),
                turn({ id: "t2", question: "q2", reply: "r", title: "t", added: 1, answeredts: at(15, 30) }),
            ]),
            NOW
        );
        expect(items[3]).toMatchObject({ card: { summary: "drew 1 shape · 15:30" } });
    });

    it("gives an answer with words and no drawing no card", () => {
        const items = talkItems(talk([turn({ question: "q", reply: "Because it starts first." })]), NOW);
        expect(items[1]).toEqual({ kind: "reply", turnId: "t1", text: "Because it starts first.", reroute: "agent" });
    });

    it("shows an answering turn with the seconds since it was asked", () => {
        const items = talkItems(talk([turn({ question: "q", state: "answering", ts: NOW - 18_000 })]), NOW);
        expect(items[1]).toEqual({ kind: "working", turnId: "t1", slow: false, elapsed: "18 s", waiting: false });
    });

    it("turns slow at 90 s", () => {
        const slowAt = (ms: number) =>
            talkItems(talk([turn({ question: "q", state: "answering", ts: NOW - ms })]), NOW)[1];
        expect(slowAt(SLOW_AFTER_MS - 1_000)).toMatchObject({ slow: false });
        expect(slowAt(SLOW_AFTER_MS)).toMatchObject({ slow: true, elapsed: "1 min 30 s" });
    });

    it("shows a waiting turn as waiting", () => {
        const items = talkItems(talk([turn({ question: "q", state: "waiting" })]), NOW);
        expect(items[1]).toMatchObject({ kind: "working", waiting: true, slow: false });
    });

    it("explains a failure with its reason capitalised and no doubled full stop", () => {
        const items = talkItems(
            talk([turn({ question: "q", state: "failed", reason: "the drawer timed out.", answeredts: at(15, 25) })]),
            NOW
        );
        expect(items[1]).toEqual({
            kind: "failed",
            turnId: "t1",
            time: "15:25",
            text: "The drawer timed out. Nothing on the board changed. Retry asks the same question again.",
        });
    });

    it("falls back to the turn's own time and still explains a failure with no reason", () => {
        const items = talkItems(talk([turn({ question: "q", state: "failed" })]), NOW);
        expect(items[1]).toMatchObject({
            time: "15:20",
            text: "Nothing on the board changed. Retry asks the same question again.",
        });
    });

    it("shows a stopped turn", () => {
        const items = talkItems(talk([turn({ question: "q", state: "stopped" })]), NOW);
        expect(items[1]).toEqual({ kind: "stopped", turnId: "t1" });
    });

    it("shows an asks turn with and without a choice", () => {
        const open = talkItems(talk([turn({ question: "q", state: "asks", reply: "Belongs elsewhere?" })]), NOW);
        expect(open[1]).toEqual({ kind: "asks", turnId: "t1", text: "Belongs elsewhere?", choice: undefined });
        const kept = talkItems(
            talk([turn({ question: "q", state: "asks", reply: "Belongs elsewhere?", choice: "keep" })]),
            NOW
        );
        expect(kept[1]).toMatchObject({ choice: "keep" });
        const moved = talkItems(talk([turn({ question: "q", state: "asks", reply: "x", choice: "new" })]), NOW);
        expect(moved[1]).toMatchObject({ choice: "new" });
    });

    it("shows a briefing turn as the briefing, not as a question", () => {
        const items = talkItems(
            talk([
                turn({
                    briefing: {
                        from: "claude · waveterm",
                        text: "The retry is in pkg/x.",
                        ask: "Where does retry live?",
                    },
                    state: "asks",
                    reply: "New board?",
                }),
            ]),
            NOW
        );
        expect(items[0]).toEqual({
            kind: "briefing",
            turnId: "t1",
            from: "claude · waveterm",
            time: "15:20",
            text: "The retry is in pkg/x.",
            ask: "Where does retry live?",
        });
        expect(items.map((i) => i.kind)).toEqual(["briefing", "asks"]);
    });

    it("shows no question item for a kept turn, and still shows its answer", () => {
        const items = talkItems(
            talk([turn({ question: "Where does retry live?", kept: true, reply: "In pkg/x.", added: 2 })]),
            NOW
        );
        expect(items.map((i) => i.kind)).toEqual(["reply"]);
    });
});

describe("talkItems, routed turns", () => {
    const drawn = (over: Partial<BoardTurn> = {}) =>
        turn({
            id: "d1",
            question: "Open this up.",
            route: "draw",
            title: "wavesrv, opened up",
            added: 5,
            shapeids: ["a"],
            answeredts: at(15, 20),
            ...over,
        });
    const forwarded = (forward: BoardForward | undefined, over: Partial<BoardTurn> = {}) =>
        turn({
            id: "f1",
            question: "Why does it own the orchestrator?",
            route: "agent",
            state: "forwarded",
            forward,
            ...over,
        });
    const forwardItem = (t: BoardTurn, placement: Placement, agent?: BoardAgent) =>
        talkItems(talk([t], agent), NOW, placement).find((i) => i.kind === "forward");
    const placements: Placement[] = ["beside", "expanded", "surface"];

    it("shows a drawn turn as its card with no words, offering Send to the agent", () => {
        const items = talkItems(talk([drawn()]), NOW);
        expect(items).toEqual([
            { kind: "question", turnId: "d1", text: "Open this up." },
            {
                kind: "reply",
                turnId: "d1",
                text: "",
                card: { title: "wavesrv, opened up", summary: "drew 5 shapes · 15:20", shapeIds: ["a"] },
                reroute: "agent",
            },
        ]);
    });

    it("offers no send-the-other-way on an agent's request, drawn or kept", () => {
        const briefing = drawn({
            question: undefined,
            briefing: { from: "claude · waveterm", text: "", ask: "the loop" },
        });
        const kept = drawn({ id: "k1", kept: true, question: "the loop" });
        const items = talkItems(talk([briefing, kept]), NOW);
        expect(items.filter((i) => "reroute" in i)).toEqual([]);
    });

    it("words a forward waiting on an asking agent by the agent it waits for, in every placement", () => {
        const held: BoardForward = { state: "held", tabid: "tab1", title: "claude · waveterm", runtime: "claude" };
        for (const p of placements) {
            expect(forwardItem(forwarded(held), p)).toEqual({
                kind: "forward",
                turnId: "f1",
                state: "held",
                line: "waiting for claude · waveterm",
                reroute: "draw",
            });
        }
    });

    it("says a sent forward is answered in the transcript only beside it", () => {
        const sent: BoardForward = { state: "sent", tabid: "tab1", title: "claude · waveterm", sentts: at(15, 22) };
        expect(forwardItem(forwarded(sent), "beside")).toMatchObject({
            state: "sent",
            line: "sent to the agent · answered in the transcript",
            reroute: "draw",
        });
        expect(forwardItem(forwarded(sent), "expanded")).toMatchObject({ line: "sent to the agent" });
        expect(forwardItem(forwarded(sent), "surface")).toMatchObject({ line: "sent to the agent" });
    });

    it("shows the copied reply where the transcript is not in view, with the way to the agent", () => {
        const replied: BoardForward = {
            state: "replied",
            tabid: "tab1",
            title: "claude · waveterm",
            reply: "Because a run outlives any one agent tab.",
            replyts: at(15, 23),
        };
        const line = "claude · waveterm answered · 15:23";
        expect(forwardItem(forwarded(replied), "surface")).toEqual({
            kind: "forward",
            turnId: "f1",
            state: "replied",
            line,
            reply: "Because a run outlives any one agent tab.",
            agentTabId: "tab1",
            way: "open",
            reroute: "draw",
        });
        expect(forwardItem(forwarded(replied), "expanded")).toMatchObject({ line, way: "back", reply: replied.reply });
        const beside = forwardItem(forwarded(replied), "beside");
        expect(beside).toMatchObject({ line, reroute: "draw" });
        expect(beside).not.toHaveProperty("reply");
        expect(beside).not.toHaveProperty("way");
    });

    it("keeps a needs-an-agent turn's reason, capitalised, in every placement", () => {
        const needs: BoardForward = { state: "needsagent", reason: "the board has no agent" };
        for (const p of placements) {
            expect(forwardItem(forwarded(needs), p)).toEqual({
                kind: "forward",
                turnId: "f1",
                state: "needsagent",
                line: "needs an agent",
                reason: "The board has no agent",
                reroute: "draw",
            });
        }
    });

    it("names the agent from the board's tie when the forward names none, else 'the agent'", () => {
        expect(forwardItem(forwarded({ state: "held" }), "surface", CLAUDE)).toMatchObject({
            line: "waiting for claude · waveterm",
        });
        expect(forwardItem(forwarded({ state: "held" }), "surface")).toMatchObject({ line: "waiting for the agent" });
    });

    it("shows a forwarded turn not yet sent as on its way", () => {
        expect(forwardItem(forwarded(undefined), "surface")).toEqual({
            kind: "forward",
            turnId: "f1",
            state: "sending",
            line: "sending to the agent",
            reroute: "draw",
        });
    });

    it("lists a forwarded turn's question before its forward", () => {
        const items = talkItems(talk([forwarded({ state: "sent" }, { on: "pkg/orchestrate" })]), NOW);
        expect(items.map((i) => i.kind)).toEqual(["question", "forward"]);
        expect(items[0]).toEqual({
            kind: "question",
            turnId: "f1",
            text: "Why does it own the orchestrator?",
            on: "pkg/orchestrate",
        });
    });

    it("names what a rerouted turn redoes", () => {
        const toAgent = talkItems(talk([forwarded({ state: "sent" }, { id: "f2", from: "d1" })]), NOW);
        expect(toAgent[0]).toMatchObject({ kind: "question", rerouted: "sent to the agent instead of drawn" });
        const toDraw = talkItems(talk([drawn({ id: "d2", from: "f1" })]), NOW);
        expect(toDraw[0]).toMatchObject({ kind: "question", rerouted: "drawn instead of sent to the agent" });
    });
});

describe("agentChoices", () => {
    it("offers the project's live claude and pi agents only, marking the board's own", () => {
        const choices = agentChoices(
            [
                agentVM({ id: "c1", name: "claude · waveterm" }),
                agentVM({ id: "p1", name: "pi · waveterm", agent: "pi", state: "working" }),
                agentVM({ id: "x1", agent: "codex" }),
                agentVM({ id: "o1", agent: "opencode" }),
                agentVM({ id: "t1", kind: "terminal", agent: undefined }),
                agentVM({ id: "bg", kind: "background" }),
                agentVM({ id: "nb", blockId: undefined }),
                agentVM({ id: "boot", booting: true }),
                agentVM({ id: "other", project: "elsewhere" }),
            ],
            "waveterm",
            "p1"
        );
        expect(choices).toEqual([
            { tabId: "c1", name: "claude · waveterm", runtime: "claude", current: false },
            { tabId: "p1", name: "pi · waveterm", runtime: "pi", current: true },
        ]);
    });

    it("reads an agent with no runtime as claude, as the server does", () => {
        expect(agentChoices([agentVM({ agent: undefined })], "waveterm", undefined)).toMatchObject([
            { runtime: "claude" },
        ]);
    });
});

describe("agentChip", () => {
    it("names the board's agent, or says it has none", () => {
        expect(agentChip(CLAUDE)).toEqual({ label: "claude · waveterm", runtime: "claude" });
        expect(agentChip(undefined)).toEqual({ label: "No agent" });
    });
});

describe("elapsedText", () => {
    it("reads seconds, then minutes with padded seconds", () => {
        expect(elapsedText(18_000)).toBe("18 s");
        expect(elapsedText(59_900)).toBe("59 s");
        expect(elapsedText(125_000)).toBe("2 min 05 s");
        expect(elapsedText(-5)).toBe("0 s");
    });
});

describe("talkTime", () => {
    it("is HH:MM today and 'D Mon' on another day", () => {
        expect(talkTime(at(15, 20), NOW)).toBe("15:20");
        expect(talkTime(at(9, 5), NOW)).toBe("09:05");
        expect(talkTime(new Date(2026, 10, 11, 23, 59).getTime(), NOW)).toBe("11 Nov");
        expect(talkTime(new Date(2026, 9, 5, 8, 0).getTime(), NOW)).toBe("5 Oct");
    });
});

describe("about", () => {
    it("names the project's code for a project, empty or missing about", () => {
        expect(aboutTitle(undefined, "waveterm")).toBe("the waveterm code");
        expect(aboutTitle({ kind: "", ref: "", title: "" }, "waveterm")).toBe("the waveterm code");
        expect(aboutTitle(about, "waveterm")).toBe("the waveterm code");
        expect(aboutLine(undefined)).toBe("the drawer reads the project's code");
        expect(aboutLine(about)).toBe("the drawer reads the project's code");
    });

    it("names a thing by its title and says where the drawer starts", () => {
        const agent: BoardSource = { kind: "agent", ref: "tab1", title: "claude · waveterm" };
        expect(aboutTitle(agent, "waveterm")).toBe("claude · waveterm");
        expect(aboutLine(agent)).toBe("The drawer starts from this agent's session and reads the project's code.");
        expect(aboutLine({ kind: "run", ref: "r", title: "run 690cc20a" })).toBe(
            "The drawer starts from this run and reads the project's code."
        );
        expect(aboutLine({ kind: "briefing", ref: "", title: "claude · x", text: "t" })).toBe(
            "The drawer starts from this briefing and reads the project's code."
        );
    });
});

describe("askBox", () => {
    const placeholder = "Ask the board";
    it("puts a board that won't open before everything", () => {
        expect(askBox(null, "wavesrv", true, true)).toEqual({
            disabled: true,
            hint: "This board won't open, so the drawer can't answer on it",
            placeholder,
            stoppable: false,
        });
    });

    it("is disabled while busy, or while the talk has a turn in flight", () => {
        const hint = "You can ask once this answer lands";
        expect(askBox(null, "wavesrv", true, false)).toEqual({
            disabled: true,
            hint,
            placeholder,
            stoppable: false,
        });
        expect(askBox(talk([turn({ state: "answering" })]), null, false, false).hint).toBe(hint);
        expect(askBox(talk([turn({ state: "waiting" })]), null, false, false).disabled).toBe(true);
    });

    it("offers Stop only while a turn is answering", () => {
        expect(askBox(talk([turn({ state: "answering" })]), null, false, false).stoppable).toBe(true);
        expect(askBox(talk([turn({ state: "answering" })]), null, true, false).stoppable).toBe(true);
        expect(askBox(talk([turn({ state: "waiting" })]), null, false, false).stoppable).toBe(false);
        expect(askBox(talk([turn({ state: "stopped" })]), null, false, false).stoppable).toBe(false);
        expect(askBox(talk([turn({ state: "answering" })]), null, false, true).stoppable).toBe(false);
    });

    it("names the selection, or asks for one", () => {
        expect(askBox(talk([turn({})]), "wavesrv", false, false)).toEqual({
            disabled: false,
            hint: "Selected wavesrv",
            placeholder,
            stoppable: false,
        });
        expect(askBox(null, null, false, false)).toEqual({
            disabled: false,
            hint: "Select shapes to ask about them",
            placeholder,
            stoppable: false,
        });
    });
});

describe("boardFacts", () => {
    it("says empty with the created time when nothing was asked or drawn", () => {
        expect(boardFacts(info({ createdts: at(14, 5) }), 0, NOW)).toBe("empty · created 14:05");
    });

    it("counts drawings and shapes, singular and plural, with the last drawing's time", () => {
        expect(
            boardFacts(info({ questions: 4, drawings: 3, drawnts: at(15, 20), answeredts: at(15, 40) }), 14, NOW)
        ).toBe("3 drawings · 14 shapes · drawn 15:20");
        expect(boardFacts(info({ questions: 1, drawings: 1, drawnts: at(15, 20) }), 1, NOW)).toBe(
            "1 drawing · 1 shape · drawn 15:20"
        );
    });

    it("leaves out 'drawn' before the first drawing, for hand-drawn shapes and for questions sent to the agent", () => {
        expect(boardFacts(info({}), 3, NOW)).toBe("0 drawings · 3 shapes");
        expect(boardFacts(info({ questions: 1 }), 0, NOW)).toBe("0 drawings · 0 shapes");
    });
});

describe("switcherRows", () => {
    it("keeps the order, words the heading and sub, and marks each state", () => {
        const { heading, rows } = switcherRows(
            [
                info({
                    id: "a",
                    name: "A",
                    state: "answering",
                    questions: 1,
                    about: "claude · waveterm",
                    activets: at(15, 50),
                }),
                info({ id: "b", name: "B", state: "asks", questions: 2 }),
                info({
                    id: "c",
                    name: "C",
                    state: "failed",
                    questions: 0,
                    createdts: new Date(2026, 10, 10, 9).getTime(),
                }),
                info({ id: "d", name: "D", questions: 3 }),
                info({ id: "e", name: "E", state: "answering", loaderror: "not valid JSON" }),
            ],
            "waveterm",
            NOW
        );
        expect(heading).toBe("5 boards in waveterm");
        expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
        expect(rows.map((r) => r.mark)).toEqual(["answering", "asks", "failed", null, "wontopen"]);
        expect(rows[0]).toMatchObject({ time: "15:50", sub: "1 question · claude · waveterm" });
        expect(rows[1]).toMatchObject({ time: "09:00", sub: "2 questions · the waveterm code" });
        expect(rows[2]).toMatchObject({ time: "10 Nov", sub: "0 questions · the waveterm code" });
    });

    it("words one board in the heading", () => {
        expect(switcherRows([info({})], "waveterm", NOW).heading).toBe("1 board in waveterm");
    });
});

describe("switcherGroups", () => {
    it("puts the open board's project first, then projects by their latest board, and drops empty ones", () => {
        const groups = switcherGroups(
            [
                { channelId: "old", project: "old", boards: [info({ id: "o", activets: at(10, 0) })] },
                { channelId: "empty", project: "empty", boards: [] },
                { channelId: "cur", project: "cur", boards: [info({ id: "c", activets: at(9, 0) })] },
                { channelId: "new", project: "new", boards: [info({ id: "n", activets: at(15, 0) })] },
            ],
            "cur",
            NOW
        );
        expect(groups.map((g) => g.channelId)).toEqual(["cur", "new", "old"]);
        expect(groups[1]).toMatchObject({
            heading: "1 board in new",
            rows: [{ id: "n", sub: "0 questions · the new code" }],
        });
    });

    it("keeps the open project even with no boards", () => {
        expect(switcherGroups([{ channelId: "cur", project: "cur", boards: [] }], "cur", NOW)).toHaveLength(1);
    });
});

describe("the board tab in the agent's workspace", () => {
    const request = (over: Partial<BoardTurn> = {}) =>
        turn({
            id: "a1",
            briefing: { from: "claude · waveterm", text: "The shell starts wavesrv.", ask: "how the app fits" },
            route: "draw",
            title: "How Arc fits together",
            added: 9,
            shapeids: ["s1"],
            answeredts: at(15, 12),
            ...over,
        });
    const drawn = (id: string, over: Partial<BoardTurn> = {}) =>
        turn({
            id,
            question: `Open ${id} up.`,
            on: "wavesrv",
            title: `${id}, opened up`,
            added: 5,
            shapeids: [`${id}-s`],
            answeredts: at(15, 20),
            ...over,
        });
    const sent = (id: string) =>
        turn({ id, question: "Why does it own the orchestrator?", state: "forwarded", forward: { state: "sent" } });

    describe("talkItems", () => {
        it("says the agent asked, with its one-line request, beside the transcript and expanded over it", () => {
            for (const p of ["beside", "expanded"] as Placement[]) {
                expect(talkItems(talk([request()]), NOW, p)[0]).toEqual({
                    kind: "briefing",
                    turnId: "a1",
                    from: "claude · waveterm",
                    time: "15:20",
                    text: "",
                    ask: "how the app fits",
                    asked: true,
                });
            }
        });

        it("keeps the full briefing on the Boards surface", () => {
            expect(talkItems(talk([request()]), NOW, "surface")[0]).toMatchObject({
                text: "The shell starts wavesrv.",
                ask: "how the app fits",
            });
            expect(talkItems(talk([request()]), NOW, "surface")[0]).not.toHaveProperty("asked");
        });
    });

    describe("besideLines", () => {
        const lines = (turns: BoardTurn[]) => besideLines(talkItems(talk(turns, CLAUDE), NOW, "beside"));

        it("lists the last 2 turns, one line each", () => {
            expect(lines([request(), drawn("d1"), drawn("d2"), sent("f1")]).map((l) => l.turnId)).toEqual(["d2", "f1"]);
        });

        it("gives a drawn turn of yours its card's facts, Show and Send to the agent", () => {
            expect(lines([drawn("d1", { added: 2, changed: 1 })])).toEqual([
                {
                    turnId: "d1",
                    text: "Open d1 up.",
                    agent: false,
                    detail: "on wavesrv · d1, opened up · added 2 shapes · changed 1 · 15:20",
                    shapeIds: ["d1-s"],
                    reroute: "agent",
                },
            ]);
        });

        it("gives a forwarded turn its forward's line and Draw instead", () => {
            expect(lines([sent("f1")])).toEqual([
                {
                    turnId: "f1",
                    text: "Why does it own the orchestrator?",
                    agent: false,
                    detail: "sent to the agent · answered in the transcript",
                    forward: "sent",
                    reroute: "draw",
                },
            ]);
        });

        it("marks the agent's request as the agent's, with Show and no send-the-other-way", () => {
            expect(lines([request()])).toEqual([
                {
                    turnId: "a1",
                    text: "how the app fits",
                    agent: true,
                    detail: "How Arc fits together · drew 9 shapes · 15:12",
                    shapeIds: ["s1"],
                },
            ]);
        });

        it("leaves a turn still being drawn to the header, listing the 2 before it", () => {
            const answering = drawn("d3", { state: "answering", ts: NOW - 6000, answeredts: undefined });
            expect(lines([drawn("d1"), sent("f1"), answering]).map((l) => l.turnId)).toEqual(["d1", "f1"]);
        });

        it("offers Retry on a failed turn and the choice on an agent's request that asks where it goes", () => {
            const failed = drawn("x1", { state: "failed", reason: "the reply was not JSON" });
            const asks = request({ id: "a2", state: "asks", reply: "Does this belong on a new board?" });
            expect(lines([failed, asks])).toEqual([
                { turnId: "x1", text: "Open x1 up.", agent: false, detail: "couldn't answer", failed: true },
                {
                    turnId: "a2",
                    text: "how the app fits",
                    agent: true,
                    detail: "Does this belong on a new board?",
                    asks: true,
                },
            ]);
            const chosen = request({ id: "a3", state: "asks", reply: "New board?", choice: "keep" });
            expect(lines([chosen])[0]).toMatchObject({ detail: "kept here" });
            expect(lines([chosen])[0]).not.toHaveProperty("asks");
        });
    });

    describe("drawerWorking", () => {
        it("is the answering turn's elapsed time, slow past the slow mark", () => {
            const answering = (ms: number) => talk([drawn("d1", { state: "answering", ts: NOW - ms })]);
            expect(drawerWorking(answering(6000), NOW)).toEqual({ turnId: "d1", elapsed: "6 s", slow: false });
            expect(drawerWorking(answering(SLOW_AFTER_MS), NOW)).toMatchObject({ slow: true });
        });

        it("is null with nothing being drawn, a waiting turn included", () => {
            expect(drawerWorking(talk([drawn("d1")]), NOW)).toBeNull();
            expect(drawerWorking(talk([drawn("d1", { state: "waiting" })]), NOW)).toBeNull();
            expect(drawerWorking(null, NOW)).toBeNull();
        });
    });
});
