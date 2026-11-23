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
    askInput,
    barLine,
    boardFacts,
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
    const placements: Placement[] = ["expanded", "surface"];

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

    it("says a sent forward was sent, in every placement", () => {
        const sent: BoardForward = { state: "sent", tabid: "tab1", title: "claude · waveterm", sentts: at(15, 22) };
        for (const p of placements) {
            expect(forwardItem(forwarded(sent), p)).toMatchObject({ line: "sent to the agent", reroute: "draw" });
        }
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
        expect(askBox(null, "wavesrv", true, true, true)).toEqual({
            disabled: true,
            hint: "This board won't open, so the drawer can't answer on it",
            placeholder,
            stoppable: false,
            selected: null,
        });
    });

    it("is disabled while busy, or while the talk has a turn in flight", () => {
        const hint = "You can ask once this answer lands";
        expect(askBox(null, "wavesrv", true, false, true)).toEqual({
            disabled: true,
            hint,
            placeholder,
            stoppable: false,
            selected: null,
        });
        expect(askBox(talk([turn({ state: "answering" })]), null, false, false, true).hint).toBe(hint);
        expect(askBox(talk([turn({ state: "waiting" })]), null, false, false, true).disabled).toBe(true);
    });

    it("offers Stop only while a turn is answering", () => {
        expect(askBox(talk([turn({ state: "answering" })]), null, false, false, true).stoppable).toBe(true);
        expect(askBox(talk([turn({ state: "answering" })]), null, true, false, true).stoppable).toBe(true);
        expect(askBox(talk([turn({ state: "waiting" })]), null, false, false, true).stoppable).toBe(false);
        expect(askBox(talk([turn({ state: "stopped" })]), null, false, false, true).stoppable).toBe(false);
        expect(askBox(talk([turn({ state: "answering" })]), null, false, true, true).stoppable).toBe(false);
    });

    it("names the selection, or asks for one", () => {
        expect(askBox(talk([turn({})]), "wavesrv", false, false, true)).toEqual({
            disabled: false,
            hint: "Selected wavesrv",
            placeholder,
            stoppable: false,
            selected: "wavesrv",
        });
        expect(askBox(null, null, false, false, true)).toEqual({
            disabled: false,
            hint: "Select shapes to ask about them",
            placeholder,
            stoppable: false,
            selected: null,
        });
    });

    it("points to Edit and ignores the selection in view mode", () => {
        const viewing = { disabled: false, hint: "Press Edit to ask about shapes", placeholder, stoppable: false };
        expect(askBox(talk([turn({})]), "wavesrv", false, false, false)).toEqual({ ...viewing, selected: null });
        expect(askBox(null, null, false, false, false)).toEqual({ ...viewing, selected: null });
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

    it("counts the canvas's drawings once it has loaded, so the facts agree with the drawings row", () => {
        const listed = info({ questions: 2, drawings: 2, drawnts: at(15, 20) });
        expect(boardFacts(listed, 5, NOW, 1)).toBe("1 drawing · 5 shapes · drawn 15:20");
        expect(boardFacts(listed, 5, NOW, null)).toBe("2 drawings · 5 shapes · drawn 15:20");
        expect(boardFacts(info({}), 0, NOW, 0)).toMatch(/^empty/);
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

    describe("talkItems", () => {
        it("says the agent asked, with its one-line request, expanded over the transcript", () => {
            expect(talkItems(talk([request()]), NOW, "expanded")[0]).toEqual({
                kind: "briefing",
                turnId: "a1",
                from: "claude · waveterm",
                time: "15:20",
                text: "",
                ask: "how the app fits",
                asked: true,
            });
        });

        it("keeps the full briefing on the Boards surface", () => {
            expect(talkItems(talk([request()]), NOW, "surface")[0]).toMatchObject({
                text: "The shell starts wavesrv.",
                ask: "how the app fits",
            });
            expect(talkItems(talk([request()]), NOW, "surface")[0]).not.toHaveProperty("asked");
        });
    });
});

describe("barLine", () => {
    const mine = (over: Partial<BoardTurn>) => turn({ id: "n1", question: "Add the retry", ts: NOW - 18_000, ...over });
    const request = (over: Partial<BoardTurn>) =>
        turn({ id: "n1", briefing: { from: "claude · waveterm", text: "", ask: "Draw the cancel path too" }, ...over });
    const forward = (f: BoardForward | undefined) => mine({ state: "forwarded", route: "agent", forward: f });
    const line = (over: Partial<ReturnType<typeof barLine>>) => ({
        turnId: "n1",
        text: "Add the retry",
        needs: false,
        ...over,
    });

    it.each<[string, BoardTurn[]]>([
        ["answered", [mine({})]],
        ["stopped", [mine({ state: "stopped" })]],
        ["sent", [forward({ state: "sent" })]],
        ["replied", [forward({ state: "replied", reply: "r" })]],
        ["a request already chosen", [request({ state: "asks", reply: "New board?", choice: "keep" })]],
        ["an answered turn after a failed one", [mine({ id: "x", state: "failed" }), mine({})]],
        ["no turns", []],
    ])("shows nothing when the newest turn is %s", (_, turns) => {
        expect(barLine(talk(turns, CLAUDE), NOW)).toBeNull();
    });

    it("shows nothing before the talk is read", () => {
        expect(barLine(null, NOW)).toBeNull();
    });

    it.each<[string, BoardTurn[], object]>([
        ["waiting", [mine({ state: "waiting" })], line({ state: "drawing", detail: "Waiting" })],
        ["answering", [mine({ state: "answering" })], line({ state: "drawing", detail: "Drawing", elapsed: "18 s" })],
        [
            "answering past the slow mark",
            [mine({ state: "answering", ts: NOW - SLOW_AFTER_MS })],
            line({ state: "drawing", detail: "Still drawing", elapsed: "1 min 30 s" }),
        ],
        [
            "a request waiting on your choice",
            [request({ state: "asks", reply: "Does this belong on a new board?" })],
            line({ state: "asks", text: "Draw the cancel path too", detail: "wants a new board", needs: true }),
        ],
        [
            "failed, after an answered turn",
            [mine({ id: "x" }), mine({ state: "failed", reason: "the reply was not JSON" })],
            line({ state: "failed", detail: "couldn't answer" }),
        ],
        ["a forward on its way", [forward(undefined)], line({ state: "forward", detail: "sending to the agent" })],
        [
            "a forward held for its agent",
            [forward({ state: "held" })],
            line({ state: "forward", detail: "waiting for claude · waveterm" }),
        ],
        [
            "a forward that needs an agent",
            [forward({ state: "needsagent", reason: "no agent" })],
            line({ state: "forward", detail: "needs an agent", needs: true }),
        ],
    ])("shows the newest turn when it is %s", (_, turns, want) => {
        expect(barLine(talk(turns, CLAUDE), NOW)).toEqual(want);
    });
});

describe("askInput", () => {
    const answering = talk([turn({ state: "answering" })]);
    it.each<[string, Parameters<typeof askBox>, ReturnType<typeof askInput>]>([
        [
            "in flight, answering",
            [answering, "wavesrv", false, false, true],
            { placeholder: "You can ask once this answer lands", disabled: true, chip: null, stop: true },
        ],
        [
            "in flight, waiting",
            [talk([turn({ state: "waiting" })]), null, false, false, true],
            { placeholder: "You can ask once this answer lands", disabled: true, chip: null, stop: false },
        ],
        [
            "idle with a selection",
            [talk([turn({})]), "wavesrv +1", false, false, true],
            { placeholder: "Ask the board", disabled: false, chip: "wavesrv +1", stop: false },
        ],
        [
            "idle with nothing selected",
            [talk([turn({ state: "failed" })]), null, false, false, true],
            { placeholder: "Select shapes to ask about them", disabled: false, chip: null, stop: false },
        ],
        [
            "in view mode with a selection",
            [talk([turn({})]), "wavesrv +1", false, false, false],
            { placeholder: "Press Edit to ask about shapes", disabled: false, chip: null, stop: false },
        ],
        [
            "a board that won't open",
            [answering, "wavesrv", false, true, true],
            {
                placeholder: "This board won't open, so the drawer can't answer on it",
                disabled: true,
                chip: null,
                stop: false,
            },
        ],
    ])("words the input %s", (_, args, want) => {
        expect(askInput(askBox(...args))).toEqual(want);
    });
});
