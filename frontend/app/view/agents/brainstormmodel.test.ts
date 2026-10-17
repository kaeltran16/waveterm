// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import {
    BUILDER_PART,
    asksUser,
    brainstormAttention,
    brainstormCounts,
    brainstormFilePath,
    brainstormLine,
    canCheck,
    compactedSummary,
    exitedSummary,
    handoffSummary,
    handoffView,
    historyRows,
    isAsking,
    orderedParts,
    paneView,
    parseBrainstorm,
    parseBrainstormPath,
    partTitle,
    resumePrompt,
    runLine,
    runPrefill,
    sentenceDiff,
    treeLine,
    withBrainstorm,
    type BrainstormFile,
    type BrainstormPart,
    type ParseResult,
    type PartState,
} from "./brainstormmodel";

const part = (id: string, state: PartState, over: Partial<BrainstormPart> = {}): BrainstormPart => ({
    id,
    title: `Title ${id}`,
    state,
    body: "",
    ...over,
});

const file = (over: Partial<BrainstormFile> = {}): BrainstormFile => ({
    v: 1,
    title: "Lag alerts",
    spec: "",
    question: null,
    working: null,
    parts: [],
    history: [],
    done: false,
    check: null,
    run: null,
    ...over,
});

const raw = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 1, title: "T", parts: [{ id: "a", title: "A", state: "yours", body: "x" }], ...over });

const errorOf = (r: ParseResult): string | undefined => (r as { error?: string }).error;

const agent = (over: Partial<AgentVM> = {}): AgentVM => ({ id: "t1", name: "loom", task: "x", state: "idle", ...over });

describe("parseBrainstorm", () => {
    it("rejects invalid json", () => {
        const r = parseBrainstorm("{nope");
        expect(r.ok).toBe(false);
        expect(errorOf(r).startsWith("brainstorm.json is not valid JSON:")).toBe(true);
    });

    it("rejects a version other than 1, naming it", () => {
        const r = parseBrainstorm(raw({ v: 2 }));
        expect(errorOf(r)).toContain("2");
        expect(errorOf(r)).toContain("version");
    });

    it("rejects a missing or non-string title", () => {
        for (const title of [undefined, 5]) {
            const r = parseBrainstorm(raw({ title }));
            expect(errorOf(r)).toContain("title");
        }
    });

    it("rejects a missing parts array", () => {
        const r = parseBrainstorm(raw({ parts: undefined }));
        expect(errorOf(r)).toContain("parts");
    });

    it("rejects a part with an unknown state, naming the part and the state", () => {
        const r = parseBrainstorm(raw({ parts: [{ id: "p1", title: "P", state: "maybe", body: "" }] }));
        expect(errorOf(r)).toContain("p1");
        expect(errorOf(r)).toContain("maybe");
    });

    it("rejects duplicate part ids, naming the id", () => {
        const p = { id: "dup", title: "P", state: "yours", body: "" };
        const r = parseBrainstorm(raw({ parts: [p, p] }));
        expect(errorOf(r)).toContain("dup");
    });

    it("defaults the optional fields", () => {
        const r = parseBrainstorm(raw());
        expect(r.ok).toBe(true);
        if (!r.ok) {
            return;
        }
        expect(r.file).toMatchObject({
            v: 1,
            title: "T",
            spec: "",
            question: null,
            working: null,
            history: [],
            done: false,
            check: null,
            run: null,
        });
        expect(r.file.parts[0]).toMatchObject({ id: "a", state: "yours", body: "x" });
    });

    it("turns a bare-string call into {text} and keeps the P4 additions", () => {
        const r = parseBrainstorm(
            raw({
                compacted: 1234,
                check: {
                    yours: [{ q: "Q?", why: "w", a: "ans", into: "a" }],
                    calls: ["bare", { text: "with part", part: "a" }],
                    answered: ["done one"],
                    touched: ["a"],
                },
            })
        );
        expect(r.ok).toBe(true);
        if (!r.ok) {
            return;
        }
        expect(r.file.compacted).toBe(1234);
        expect(r.file.check?.calls).toEqual([{ text: "bare" }, { text: "with part", part: "a" }]);
        expect(r.file.check?.yours[0]).toEqual({ q: "Q?", why: "w", a: "ans", into: "a" });
        expect(r.file.check?.touched).toEqual(["a"]);
        expect(r.file.check?.answered).toEqual(["done one"]);
    });

    it("accepts a question.part that names no part", () => {
        const r = parseBrainstorm(raw({ question: { n: 3, text: "Why?", part: "ghost" } }));
        expect(r.ok && r.file.question).toEqual({ n: 3, text: "Why?", part: "ghost" });
    });

    it("reads history entries", () => {
        const r = parseBrainstorm(
            raw({
                history: [
                    { kind: "question", n: 1, q: "q1", a: "a1", into: ["a"] },
                    { kind: "recon", q: "rq", a: "ra", into: ["b"] },
                ],
            })
        );
        expect(r.ok && r.file.history).toEqual([
            { kind: "question", n: 1, q: "q1", a: "a1", into: ["a"] },
            { kind: "recon", q: "rq", a: "ra", into: ["b"] },
        ]);
    });
});

describe("brainstorm paths", () => {
    it("builds the file path with the separator of the cwd", () => {
        expect(brainstormFilePath("C:\\proj", "lag")).toBe("C:\\proj\\.superpowers\\brainstorm\\lag\\brainstorm.json");
        expect(brainstormFilePath("/home/p/", "lag")).toBe("/home/p/.superpowers/brainstorm/lag/brainstorm.json");
    });

    it("parses a path back, with either separator", () => {
        expect(parseBrainstormPath("C:\\proj\\.superpowers\\brainstorm\\lag\\brainstorm.json")).toEqual({
            cwd: "C:\\proj",
            topic: "lag",
        });
        expect(parseBrainstormPath("/home/p/.superpowers/brainstorm/lag/brainstorm.json")).toEqual({
            cwd: "/home/p",
            topic: "lag",
        });
        expect(parseBrainstormPath("/home/p/.superpowers/design/lag/canvas.json")).toBeNull();
    });
});

describe("counts and gates", () => {
    const f = file({
        parts: [part("a", "yours"), part("b", "guess"), part("c", "guess"), part("d", "asked"), part("e", "open")],
    });

    it("counts yours, guesses, and asked plus open", () => {
        expect(brainstormCounts(f)).toEqual({ yours: 1, guesses: 2, open: 2 });
    });

    it("canCheck needs done, at least one part and every part yours", () => {
        expect(canCheck(file({ done: true, parts: [part("a", "yours")] }))).toBe(true);
        expect(canCheck(file({ done: false, parts: [part("a", "yours")] }))).toBe(false);
        expect(canCheck(file({ done: true, parts: [] }))).toBe(false);
        expect(canCheck(file({ done: true, parts: [part("a", "yours"), part("b", "guess")] }))).toBe(false);
    });

    it("isAsking is a question with no working line", () => {
        const q = { n: 1, text: "?", part: "a" };
        expect(isAsking(file({ question: q }))).toBe(true);
        expect(isAsking(file({ question: q, working: "Writing" }))).toBe(false);
        expect(isAsking(file())).toBe(false);
    });

    it("asksUser needs the agent at its prompt", () => {
        const f2 = file({ question: { n: 1, text: "?", part: "a" } });
        expect(asksUser(f2, { state: "idle" })).toBe(true);
        expect(asksUser(f2, { state: "working", atPrompt: true })).toBe(true);
        expect(asksUser(f2, { state: "working" })).toBe(false);
        expect(asksUser(null, { state: "idle" })).toBe(false);
        expect(asksUser(file(), { state: "idle" })).toBe(false);
    });
});

describe("withBrainstorm", () => {
    const f = file({ question: { n: 2, text: "?", part: "a" } });

    it("overlays asking with the time since it went idle", () => {
        const a = withBrainstorm(agent({ idleSince: 1000 }), f, 6000);
        expect(a.state).toBe("asking");
        expect(a.blockedMs).toBe(5000);
    });

    it("returns the same object when it is not asking", () => {
        const a = agent({ idleSince: 1000 });
        expect(withBrainstorm(a, null, 6000)).toBe(a);
        expect(withBrainstorm(a, file(), 6000)).toBe(a);
        const busy = agent({ state: "working" });
        expect(withBrainstorm(busy, f, 6000)).toBe(busy);
    });
});

describe("treeLine", () => {
    it("says done with the first 8 chars of the run", () => {
        expect(treeLine(file({ run: "abcdef0123456789" }), false)).toEqual({
            lead: "Brainstorm done",
            text: "run abcdef01",
            runId: "abcdef0123456789",
        });
    });

    it("names asking, the builder check, working and the default", () => {
        const q = { n: 4, text: "?", part: "a" };
        expect(treeLine(file({ question: q }), true)).toEqual({ lead: "Brainstorm", text: "asking question 4" });
        expect(treeLine(file({ check: { yours: [], calls: [], answered: [] } }), false).text).toBe("builder check");
        expect(treeLine(file({ working: "Writing" }), false).text).toBe("writing up your answer");
        expect(treeLine(file(), false)).toEqual({ lead: "Brainstorm", text: "in progress" });
    });
});

describe("brainstormLine", () => {
    it("types every action as its line", () => {
        expect(brainstormLine({ kind: "answer", text: "my answer" })).toBe("my answer");
        expect(brainstormLine({ kind: "guess" })).toBe("brainstorm: guess");
        expect(brainstormLine({ kind: "skip" })).toBe("brainstorm: skip questions");
        expect(brainstormLine({ kind: "confirm", part: "p" })).toBe("brainstorm: confirm p");
        expect(brainstormLine({ kind: "edit", part: "p", text: "new" })).toBe("brainstorm: edit p: new");
        expect(brainstormLine({ kind: "keep", part: "p" })).toBe("brainstorm: keep p");
        expect(brainstormLine({ kind: "restore", part: "p" })).toBe("brainstorm: restore p");
        expect(brainstormLine({ kind: "check" })).toBe("brainstorm: check");
        expect(brainstormLine({ kind: "builder-answer", text: "x" })).toBe("brainstorm: builder answer: x");
        expect(brainstormLine({ kind: "approved" })).toBe("brainstorm: approved");
        expect(brainstormLine({ kind: "keep-talking" })).toBe("brainstorm: keep talking");
    });

    it("joins a multi-line, tab-filled text into one line", () => {
        expect(brainstormLine({ kind: "answer", text: "a\n\tb  c\r\n" })).toBe("a b c");
        expect(brainstormLine({ kind: "edit", part: "p", text: "x\ny" })).toBe("brainstorm: edit p: x y");
    });

    it("types nothing for a blank text", () => {
        expect(brainstormLine({ kind: "answer", text: "  \n " })).toBeNull();
        expect(brainstormLine({ kind: "edit", part: "p", text: "\t" })).toBeNull();
        expect(brainstormLine({ kind: "builder-answer", text: "" })).toBeNull();
    });
});

describe("unknown part ids render raw", () => {
    const f = file({
        parts: [part("a", "yours")],
        history: [{ kind: "question", n: 1, q: "q", a: "a", into: ["a", "ghost"] }],
        check: {
            yours: [],
            calls: [{ text: "c1", part: "ghost" }, { text: "c2", part: "a" }, { text: "c3" }],
            answered: [],
        },
    });

    it("partTitle falls back to the id", () => {
        expect(partTitle(f, "a")).toBe("Title a");
        expect(partTitle(f, "ghost")).toBe("ghost");
    });

    it("historyRows shows the raw id and does not throw", () => {
        expect(historyRows(f)[0].into).toEqual([
            { id: "a", title: "Title a" },
            { id: "ghost", title: "ghost" },
        ]);
    });

    it("callsByPart keys an unknown part by its raw id and leaves a partless call out", () => {
        expect(handoffView(f).callsByPart).toEqual({ ghost: ["c1"], a: ["c2"] });
    });
});

describe("historyRows", () => {
    it("is newest first, labelled Q<n> or Recon", () => {
        const f = file({
            history: [
                { kind: "question", n: 1, q: "q1", a: "a1", into: [] },
                { kind: "recon", q: "rq", a: "ra", into: [] },
                { kind: "question", n: 2, q: "q2", a: "a2", into: [] },
            ],
        });
        expect(historyRows(f).map((r) => r.label)).toEqual(["Q2", "Recon", "Q1"]);
    });
});

describe("orderedParts", () => {
    it("keeps file order and moves the builder part last", () => {
        const f = file({ parts: [part("x", "yours"), part(BUILDER_PART, "open"), part("y", "guess")] });
        expect(orderedParts(f).map((p) => p.id)).toEqual(["x", "y", BUILDER_PART]);
    });
});

describe("sentenceDiff", () => {
    it("marks same, removed and added sentences", () => {
        expect(sentenceDiff("One. Two. Three.", "One. Deux! Three.")).toEqual([
            { kind: "same", text: "One." },
            { kind: "removed", text: "Two." },
            { kind: "added", text: "Deux!" },
            { kind: "same", text: "Three." },
        ]);
    });

    it("handles an empty side", () => {
        expect(sentenceDiff("", "A.")).toEqual([{ kind: "added", text: "A." }]);
        expect(sentenceDiff("A?", "")).toEqual([{ kind: "removed", text: "A?" }]);
    });
});

describe("handoffView", () => {
    const check = {
        yours: [{ q: "q1", a: "ans" }, { q: "q2" }],
        calls: [{ text: "c1", part: "p1" }],
        answered: ["x"],
    };
    const parts = [part("p1", "yours"), part("p2", "yours"), part("p3", "yours")];

    it("counts questions, finds the open one and gates approval", () => {
        const v = handoffView(file({ parts, check }));
        expect(v.questions).toBe(2 + 1 + 1);
        expect(v.open).toEqual({ q: "q2" });
        expect(v.answered).toEqual([{ q: "q1", a: "ans" }]);
        expect(v.canApprove).toBe(false);
    });

    it("can approve once every question is answered and no run started", () => {
        const answered = { ...check, yours: [{ q: "q1", a: "ans" }] };
        expect(handoffView(file({ parts, check: answered })).canApprove).toBe(true);
        expect(handoffView(file({ parts, check: answered, run: "r1" })).canApprove).toBe(false);
    });

    it("treats every part as touched when touched is absent", () => {
        const v = handoffView(file({ parts, check }));
        expect(v.touched.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
        expect(v.untouched).toEqual([]);
    });

    it("splits touched and untouched when the builder named them", () => {
        const v = handoffView(file({ parts, check: { ...check, touched: ["p2", "ghost"] } }));
        expect(v.touched.map((p) => p.id)).toEqual(["p2"]);
        expect(v.untouched.map((p) => p.id)).toEqual(["p1", "p3"]);
    });
});

describe("summaries", () => {
    const parts = [
        ...["a", "b", "c", "d", "e"].map((id) => part(id, "yours")),
        part("f", "guess"),
        part("g", "guess"),
        part("h", "open"),
    ];

    it("handoffSummary", () => {
        const yours8 = file({ done: true, parts: Array.from({ length: 8 }, (_, i) => part(`p${i}`, "yours")) });
        expect(handoffSummary(yours8)).toBe("8 yours · nothing open · the agent has no more questions");
        expect(handoffSummary(file({ parts }))).toBe("5 yours · 1 open");
        expect(handoffSummary(file({ parts, done: true }))).toBe("5 yours · 1 open");
    });

    it("compactedSummary", () => {
        expect(compactedSummary(file({ parts }))).toBe(
            "The agent compacted its context and re-read its brainstorm file: 5 parts yours, 2 guesses, 1 open. Nothing was lost."
        );
        expect(compactedSummary(file({ parts: [part("a", "yours"), part("b", "guess"), part("c", "open")] }))).toBe(
            "The agent compacted its context and re-read its brainstorm file: 1 part yours, 1 guess, 1 open. Nothing was lost."
        );
    });

    it("exitedSummary", () => {
        const two = parts.slice(0, 7);
        expect(exitedSummary(file({ parts: two, question: { n: 5, text: "?", part: "a" } }))).toBe(
            "The brainstorm is saved: 5 parts yours, 2 guesses, and question 5 still unanswered. A new agent reads it and carries on from that question."
        );
        expect(exitedSummary(file({ parts: two }))).toBe(
            "The brainstorm is saved: 5 parts yours, 2 guesses. A new agent reads it and carries on."
        );
    });

    it("resumePrompt and runLine", () => {
        expect(resumePrompt("C:\\p\\brainstorm.json")).toBe(
            "Resume the brainstorm in C:\\p\\brainstorm.json with arc:brainstorm."
        );
        expect(runLine("siem-pipeline")).toBe("siem-pipeline · orchestrator · this design attached");
    });
});

describe("runPrefill", () => {
    const base = { projectName: "proj", cwd: "C:\\proj" };

    it("joins a relative spec to the cwd and builds the goal", () => {
        const p = runPrefill(file({ title: "Lag alerts", spec: "docs/specs/lag.md" }), base);
        expect(p.projectName).toBe("proj");
        expect(p.shape).toBe("orchestrator");
        expect(p.goal).toBe("Build Lag alerts as specified in C:\\proj\\docs\\specs\\lag.md.");
        expect(p.prototype).toBeUndefined();
    });

    it("keeps an absolute spec as it is", () => {
        const p = runPrefill(file({ title: "T", spec: "D:\\elsewhere\\s.md" }), base);
        expect(p.goal).toBe("Build T as specified in D:\\elsewhere\\s.md.");
    });

    it("uses the first listed board, in part order, as the prototype", () => {
        const f = file({
            canvas: "lag",
            spec: "s.md",
            parts: [
                part("a", "yours"),
                part("b", "guess", { boards: ["Page.dc.html"] }),
                part("c", "guess", { boards: ["Other.dc.html"] }),
            ],
        });
        expect(runPrefill(f, base).prototype).toBe("C:\\proj\\.superpowers\\design\\lag\\project\\Page.dc.html");
    });

    it("has no prototype without a listed board or without a canvas", () => {
        expect(runPrefill(file({ canvas: "lag", parts: [part("a", "yours")] }), base).prototype).toBeUndefined();
        expect(
            runPrefill(file({ parts: [part("a", "yours", { boards: ["Page.dc.html"] })] }), base).prototype
        ).toBeUndefined();
    });
});

describe("brainstormAttention", () => {
    it("builds the popup item", () => {
        const f = file({
            question: { n: 3, text: "What pages you?", part: "page" },
            parts: [part("page", "asked", { title: "What on-call sees" })],
        });
        expect(brainstormAttention({ agentId: "t1", agentName: "loom", topic: "lag" }, f)).toEqual({
            kind: "brainstorm",
            key: "brainstorm:t1:3",
            source: "loom",
            text: "What pages you?",
            reason: "For “What on-call sees” · question 3",
            action: "brainstorm",
            oref: "brainstorm:lag",
            phaseidx: 0,
            waitingsince: 0,
        });
    });

    it("shows the raw id for a part that does not exist", () => {
        const f = file({ question: { n: 1, text: "?", part: "ghost" } });
        expect(brainstormAttention({ agentId: "t", agentName: "n", topic: "x" }, f).reason).toBe(
            "For “ghost” · question 1"
        );
    });
});

describe("paneView", () => {
    const f = file();
    const s = { file: f, error: null, removed: false, exited: false, showDesign: false, board: null };

    it("defaults to the design", () => {
        expect(paneView(s)).toBe("design");
    });

    it("removed beats everything", () => {
        expect(paneView({ ...s, removed: true, error: "e", exited: true, board: "B" })).toBe("removed");
    });

    it("error shows only with no last good file", () => {
        expect(paneView({ ...s, file: null, error: "bad" })).toBe("error");
        expect(paneView({ ...s, error: "bad" })).toBe("design");
    });

    it("exited holds unless showDesign or a run started", () => {
        expect(paneView({ ...s, exited: true })).toBe("exited");
        expect(paneView({ ...s, exited: true, showDesign: true })).toBe("design");
        expect(paneView({ ...s, exited: true, file: file({ run: "r1" }) })).toBe("design");
    });

    it("board beats check beats design", () => {
        const withCheck = file({ check: { yours: [], calls: [], answered: [] } });
        expect(paneView({ ...s, file: withCheck, board: "B.dc.html" })).toBe("board");
        expect(paneView({ ...s, file: withCheck })).toBe("check");
    });
});
