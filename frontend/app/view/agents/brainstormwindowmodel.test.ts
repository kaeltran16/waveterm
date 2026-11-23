// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AnswerOption, BrainstormFile, BrainstormQuestion, JudgeRecord } from "./brainstormmodel";
import { bandPickable, partScope, questionScope, scopeOpenBoard } from "./brainstormwindowmodel";
import type { ScopeSource, WindowScope } from "./canvaswindowmodel";

const file = (over: Partial<BrainstormFile> = {}): BrainstormFile => ({
    v: 1,
    title: "Lag alerts",
    spec: "",
    canvas: "topic",
    question: null,
    working: null,
    parts: [],
    history: [],
    done: false,
    check: null,
    run: null,
    ...over,
});

const opt = (label: string, boards?: string[], over: Partial<AnswerOption> = {}): AnswerOption => ({
    label,
    detail: `${label} detail`,
    ...(boards ? { boards } : {}),
    ...over,
});

const asked = (
    options: AnswerOption[] | undefined,
    partBoards: string[],
    over: Partial<BrainstormQuestion> = {},
    fileOver: Partial<BrainstormFile> = {}
): BrainstormFile =>
    file({
        parts: [{ id: "layout", title: "Layout", state: "asked", body: "", boards: partBoards }],
        question: { n: 3, text: "Which layout?", part: "layout", options, ...over },
        ...fileOver,
    });

const tabLabels = (s: WindowScope | null) => s?.tabs.map((t) => [t.board, t.label]);

describe("questionScope tabs", () => {
    const L = "Left-rail.dc.html";
    const P = "Page.dc.html";
    const T = "Top.dc.html";

    it.each([
        ["an answer's only board is named by the answer", [opt("Rail", [L]), opt("Strip")], [L], [[L, "1 · Rail"]]],
        [
            "an answer with several boards labels each by its board",
            [opt("Rail", [L, T]), opt("Strip")],
            [L, T],
            [
                [L, "1 · Left-rail"],
                [T, "1 · Top"],
            ],
        ],
        [
            "a board two answers share is one tab listing both numbers",
            [opt("Rail", [L]), opt("Strip"), opt("Both", [L])],
            [L],
            [[L, "1, 3 · Left-rail"]],
        ],
        ["one board no answer names is Every answer", [opt("A"), opt("B")], [P], [[P, "Every answer"]]],
        [
            "several Every answer boards keep their names, in the part's order",
            [opt("A"), opt("B")],
            [T, P],
            [
                [T, "Every answer · Top"],
                [P, "Every answer · Page"],
            ],
        ],
        [
            "answers first in answer order, a shared board at its first answer, Every answer last",
            [opt("A", [T]), opt("B", [L, T])],
            [P, L, T],
            [
                [T, "1, 2 · Top"],
                [L, "2 · Left-rail"],
                [P, "Every answer"],
            ],
        ],
        [
            "a question with no options shows the part's boards as Every answer",
            undefined,
            [L, P],
            [
                [L, "Every answer · Left-rail"],
                [P, "Every answer · Page"],
            ],
        ],
    ])("%s", (_name, options, partBoards, expected) => {
        const scope = questionScope(asked(options, partBoards), partBoards, false);
        expect(tabLabels(scope)).toEqual(expected);
    });

    it("leaves out boards that are not on the canvas, and relabels by what is left", () => {
        const f = asked([opt("Rail", [L, T]), opt("Strip")], [P]);
        expect(tabLabels(questionScope(f, [L, P], false))).toEqual([
            [L, "1 · Rail"],
            [P, "Every answer"],
        ]);
    });

    it("names an answer's boards that sit outside the asked part", () => {
        expect(tabLabels(questionScope(asked([opt("Rail", [L])], [P]), [L, P], false))).toEqual([
            [L, "1 · Rail"],
            [P, "Every answer"],
        ]);
    });
});

describe("questionScope bands and source", () => {
    const L = "Left-rail.dc.html";
    const P = "Page.dc.html";

    it("an answers band carries each answer's number, label, pick, detail, pros and cons", () => {
        const f = asked(
            [opt("Rail", [L], { pick: true, pros: ["quiet"], cons: ["narrow"] }), opt("Strip"), opt("Both", [L])],
            [L]
        );
        const tab = questionScope(f, [L], false)?.tabs[0];
        expect(tab?.band).toEqual({
            kind: "answers",
            answers: [
                { index: 0, label: "Rail", detail: "Rail detail", pick: true, pros: ["quiet"], cons: ["narrow"] },
                { index: 2, label: "Both", detail: "Both detail", pick: false, pros: [], cons: [] },
            ],
        });
    });

    it("an Every answer tab has the every band", () => {
        expect(questionScope(asked([opt("A")], [P]), [P], false)?.tabs[0].band).toEqual({ kind: "every" });
    });

    it("the source carries the question's n and text, and whether the judge weighed it", () => {
        const judge: JudgeRecord = { kind: "weighed", added: [], dropped: [] };
        const f = asked([opt("A", [L])], [L], { judge });
        expect(questionScope(f, [L], false)?.source).toEqual({
            kind: "question",
            n: 3,
            text: "Which layout?",
            judging: false,
            judged: true,
        });
        const failed = asked([opt("A", [L])], [L], { judge: { kind: "failed", reason: "x" } });
        expect(questionScope(failed, [L], false)?.source).toMatchObject({ judged: false });
        expect(questionScope(asked([opt("A", [L])], [L]), [L], false)?.source).toMatchObject({ judged: false });
    });

    it("while the judge weighs, the approaches are the answers: name and description, no pros, cons or pick", () => {
        const f = asked([opt("Ignored", [P])], [L, P], {
            approaches: [
                { name: "Rail", description: "a rail", facts: ["f"], boards: [L] },
                { name: "Strip", description: "a strip", facts: [] },
            ],
        });
        const scope = questionScope({ ...f, working: "Weighing." }, [L, P], true);
        expect(scope?.source).toMatchObject({ judging: true });
        expect(scope?.tabs).toEqual([
            {
                board: L,
                label: "1 · Rail",
                band: {
                    kind: "answers",
                    answers: [{ index: 0, label: "Rail", detail: "a rail", pick: false, pros: [], cons: [] }],
                },
            },
            { board: P, label: "Every answer", band: { kind: "every" } },
        ]);
    });

    it("is null with no question, with no canvas, with nothing on the canvas to draw", () => {
        const f = asked([opt("A", [L])], [L]);
        expect(questionScope({ ...f, question: null }, [L], false)).toBeNull();
        expect(questionScope({ ...f, canvas: undefined }, [L], false)).toBeNull();
        expect(questionScope(f, [], false)).toBeNull();
    });

    it("is null while the agent writes over the question, except in the judge's wait", () => {
        const f = asked([opt("A", [L])], [L], { approaches: [{ name: "X", description: "", facts: [], boards: [L] }] });
        expect(questionScope({ ...f, working: "Writing up your answer." }, [L], false)).toBeNull();
        expect(questionScope({ ...f, working: "Weighing." }, [L], true)).not.toBeNull();
    });
});

describe("partScope", () => {
    const f = file({
        parts: [
            {
                id: "layout",
                title: "Layout",
                state: "yours",
                gist: "A left rail.",
                body: "",
                boards: ["A.dc.html", "B.dc.html"],
            },
            { id: "empty", title: "Empty", state: "open", body: "" },
            { id: "gone", title: "Gone", state: "yours", body: "", boards: ["Gone.dc.html"] },
        ],
    });

    it("tabs the part's on-canvas boards by name, each with the part's title and gist", () => {
        const scope = partScope(f, "layout", ["B.dc.html", "A.dc.html", "Other.dc.html"]);
        expect(scope?.source).toEqual({ kind: "part", id: "layout", title: "Layout" });
        expect(scope?.tabs).toEqual([
            { board: "A.dc.html", label: "A", band: { kind: "part", title: "Layout", gist: "A left rail." } },
            { board: "B.dc.html", label: "B", band: { kind: "part", title: "Layout", gist: "A left rail." } },
        ]);
    });

    it("is null for an unknown part, a part with no boards, or none on the canvas", () => {
        expect(partScope(f, "nope", ["A.dc.html"])).toBeNull();
        expect(partScope(f, "empty", ["A.dc.html"])).toBeNull();
        expect(partScope(f, "gone", ["A.dc.html"])).toBeNull();
    });
});

describe("bandPickable", () => {
    const question = (judging: boolean, n = 3): ScopeSource => ({
        kind: "question",
        n,
        text: "q",
        judging,
        judged: false,
    });
    const live = asked([opt("A", ["a.dc.html"])], ["a.dc.html"], {
        approaches: [{ name: "X", description: "", facts: [] }],
    });

    it.each([
        ["the live open question", live, question(false), false, true],
        ["the judge's wait, opened during it", { ...live, working: "Weighing." }, question(true), false, true],
        ["the next question", { ...live, question: { ...live.question!, n: 4 } }, question(false), false, false],
        ["no question any more", { ...live, question: null }, question(false), false, false],
        ["the agent writing over the question", { ...live, working: "Writing." }, question(false), true, false],
        ["the judge has finished since a wait scope opened", live, question(true), false, false],
        [
            "the judge's wait since a question scope opened",
            { ...live, working: "Weighing." },
            question(false),
            false,
            false,
        ],
        ["a line sent ends the wait", { ...live, working: "Weighing." }, question(true), true, false],
    ] as [string, BrainstormFile, ScopeSource, boolean, boolean][])("%s", (_name, f, source, pending, expected) => {
        expect(bandPickable(f, source, pending)).toBe(expected);
    });

    it("a part source never picks", () => {
        expect(bandPickable(live, { kind: "part", id: "layout", title: "Layout" }, false)).toBe(false);
    });
});

describe("scopeOpenBoard", () => {
    const answers = (...index: number[]) => ({
        kind: "answers" as const,
        answers: index.map((i) => ({ index: i, label: "", detail: "", pick: false, pros: [], cons: [] })),
    });
    const scope: WindowScope = {
        source: { kind: "question", n: 1, text: "q", judging: false, judged: false },
        tabs: [
            { board: "a.dc.html", label: "", band: answers(0, 2) },
            { board: "b.dc.html", label: "", band: answers(1) },
            { board: "c.dc.html", label: "", band: { kind: "every" } },
        ],
    };

    it.each([
        ["the answer's first tab", 1, "b.dc.html"],
        ["the first tab that lists a shared answer", 2, "a.dc.html"],
        ["the first tab with no answer focused", null, "a.dc.html"],
        ["the first tab for an answer with no board", 5, "a.dc.html"],
    ])("%s", (_name, answer, expected) => {
        expect(scopeOpenBoard(scope, answer)).toBe(expected);
    });

    it("is null for a scope with no tabs", () => {
        expect(scopeOpenBoard({ ...scope, tabs: [] }, 0)).toBeNull();
    });
});
