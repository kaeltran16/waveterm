// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    aboutLine,
    aboutTitle,
    askBox,
    boardFacts,
    elapsedText,
    SLOW_AFTER_MS,
    switcherRows,
    talkItems,
    talkTime,
} from "./boardtalkmodel";

const at = (h: number, m: number, s = 0) => new Date(2026, 10, 12, h, m, s).getTime();
const NOW = at(16, 0);

const about: BoardSource = { kind: "project", ref: "", title: "waveterm" };

function turn(over: Partial<BoardTurn>): BoardTurn {
    return { id: "t1", ts: at(15, 20), state: "answered", ...over };
}

function talk(turns: BoardTurn[]): BoardTalk {
    return { channelid: "ch1", boardid: "b1", about, turns };
}

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
        expect(items[1]).toEqual({ kind: "reply", turnId: "t1", text: "Because it starts first." });
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
    const placeholder = "Ask the drawer about Board";
    it("puts a board that won't open before everything", () => {
        expect(askBox(null, "Board", "wavesrv", true, true)).toEqual({
            disabled: true,
            hint: "This board won't open, so the drawer can't answer on it",
            placeholder,
            stoppable: false,
        });
    });

    it("is disabled while busy, or while the talk has a turn in flight", () => {
        const hint = "You can ask once this answer lands";
        expect(askBox(null, "Board", "wavesrv", true, false)).toEqual({
            disabled: true,
            hint,
            placeholder,
            stoppable: false,
        });
        expect(askBox(talk([turn({ state: "answering" })]), "Board", null, false, false).hint).toBe(hint);
        expect(askBox(talk([turn({ state: "waiting" })]), "Board", null, false, false).disabled).toBe(true);
    });

    it("offers Stop only while a turn is answering", () => {
        expect(askBox(talk([turn({ state: "answering" })]), "Board", null, false, false).stoppable).toBe(true);
        expect(askBox(talk([turn({ state: "answering" })]), "Board", null, true, false).stoppable).toBe(true);
        expect(askBox(talk([turn({ state: "waiting" })]), "Board", null, false, false).stoppable).toBe(false);
        expect(askBox(talk([turn({ state: "stopped" })]), "Board", null, false, false).stoppable).toBe(false);
        expect(askBox(talk([turn({ state: "answering" })]), "Board", null, false, true).stoppable).toBe(false);
    });

    it("names the selection, or asks for one", () => {
        expect(askBox(talk([turn({})]), "Board", "wavesrv", false, false)).toEqual({
            disabled: false,
            hint: "Selected wavesrv",
            placeholder,
            stoppable: false,
        });
        expect(askBox(null, "Board", null, false, false)).toEqual({
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

    it("counts questions and shapes, singular and plural, with the last answer", () => {
        expect(boardFacts(info({ questions: 2, answeredts: at(15, 20) }), 14, NOW)).toBe(
            "2 questions · 14 shapes · answered 15:20"
        );
        expect(boardFacts(info({ questions: 1, answeredts: at(15, 20) }), 1, NOW)).toBe(
            "1 question · 1 shape · answered 15:20"
        );
    });

    it("leaves out 'answered' before the first answer, and counts hand-drawn shapes on an unasked board", () => {
        expect(boardFacts(info({ questions: 1 }), 0, NOW)).toBe("1 question · 0 shapes");
        expect(boardFacts(info({}), 3, NOW)).toBe("0 questions · 3 shapes");
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
