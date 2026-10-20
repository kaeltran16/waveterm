import { describe, expect, it } from "vitest";
import type { Mark, Segment } from "./highlight-core";
import {
    askOf,
    canSkim,
    DIM_KEY,
    HIGHLIGHT_KEY,
    HIGHLIGHT_REMINDER,
    HIGHLIGHT_SECTION,
    isKept,
    keepMarks,
    layout,
    MAX_KEPT,
    parseMarks,
    settingAfter,
    settingsOf,
    submitContext,
} from "./highlight-core";

// the highlighted text of each drawn line, in order
function highlighted(segments: Segment[]): string[] {
    return segments
        .filter((s) => s.kind === "line")
        .map((s) =>
            s.runs
                .filter((r) => r.isMarked)
                .map((r) => r.text)
                .join("")
        );
}

function draw(reply: string, isSkim = true): Segment[] {
    const { clean, marks } = parseMarks(reply);
    return layout(clean, marks, isSkim);
}

describe("parseMarks", () => {
    it("strips the marks and keeps where each one sits in the stored text", () => {
        const { clean, marks } = parseMarks("Intro.\nSo ==this is the point.== Then more.");
        expect(clean).toBe("Intro.\nSo this is the point. Then more.");
        expect(marks).toEqual([{ line: 1, from: 3, to: 21, text: "this is the point." }]);
        expect(clean.split("\n")[1]?.slice(3, 21)).toBe("this is the point.");
    });

    it("keeps the offsets of a second mark on a line in the stripped line", () => {
        const { clean, marks } = parseMarks("==One.== and ==two.==");
        expect(clean).toBe("One. and two.");
        expect(marks.map((m) => clean.slice(m.from, m.to))).toEqual(["One.", "two."]);
    });

    it.each([
        "The check is a==b and c==d in prose.",
        "Compare x==y here.",
        "Strict a===b and c===d both hold.",
        "Use x!==y and z!==w for that.",
        "An arrow <==this==> stays.",
        "The spaced a == b form stays.",
    ])("leaves an operator in prose as written: %s", (reply) => {
        expect(parseMarks(reply)).toEqual({ clean: reply, marks: [] });
    });

    it("marks cjk prose with no space around the mark", () => {
        const { clean, marks } = parseMarks("这是==重点。==后面");
        expect(clean).toBe("这是重点。后面");
        expect(marks.map((m) => m.text)).toEqual(["重点。"]);
    });

    it("marks a sentence opening the line and one inside punctuation", () => {
        expect(parseMarks("==First.== (==second==)").marks.map((m) => m.text)).toEqual(["First.", "second"]);
    });

    it("leaves code spans and fences alone", () => {
        const reply = "Run `a ==b== c` now.\n```\n==not a mark==\n```";
        expect(parseMarks(reply)).toEqual({ clean: reply, marks: [] });
    });
});

describe("layout", () => {
    it("draws marks after a marked table row, which the engine keeps", () => {
        const segments = draw(
            [
                "Intro.",
                "",
                "| a | b |",
                "|---|---|",
                "| ==cell mark== | x |",
                "",
                "Later, ==the real point.== More.",
            ].join("\n")
        );
        expect(highlighted(segments)).toEqual(["the real point."]);
        const table = segments.find((s) => s.kind === "markdown" && s.text.includes("| cell mark |"));
        expect(table).toBeDefined();
    });

    it("highlights the copy of a repeated sentence that was marked", () => {
        const segments = draw("Run it now. Later: ==Run it now.==");
        const line = segments.find((s) => s.kind === "line");
        expect(line?.kind === "line" && line.runs.map((r) => [r.text, !!r.isMarked])).toEqual([
            ["Run it now. Later: ", false],
            ["Run it now.", true],
        ]);
    });

    it("dims the unmarked text only under skim", () => {
        const reply = "Plain context.\n\nThen ==the point.==";
        expect(draw(reply, true).find((s) => s.kind === "markdown")).toMatchObject({ isDim: true });
        expect(draw(reply, false).find((s) => s.kind === "markdown")).toMatchObject({ isDim: false });
    });

    it("hangs a marked list item behind its marker", () => {
        const line = draw("- ==Item point.== rest").find((s) => s.kind === "line");
        expect(line).toMatchObject({ kind: "line", prefix: "- " });
    });

    it("draws a fence of commands to type highlighted, without its fence lines", () => {
        const segments = draw("Then:\n```\n! task dev\n```");
        expect(highlighted(segments)).toEqual(["! task dev"]);
    });
});

describe("askOf and canSkim", () => {
    const mark = (text: string): Mark => ({ line: 0, from: 0, to: text.length, text });

    it("reads the question the last mark asks", () => {
        expect(askOf([mark("Context."), mark("Which one?")])).toBe("Which one?");
        expect(askOf([mark("Which one?"), mark("Context.")])).toBeNull();
        expect(askOf([])).toBeNull();
    });

    it("dims only while the marks cover a third of the reply or less", () => {
        expect(canSkim("x".repeat(30), [mark("x".repeat(10))])).toBe(true);
        expect(canSkim("x".repeat(30), [mark("x".repeat(11))])).toBe(false);
    });
});

describe("kept marks", () => {
    const marks: Mark[] = [{ line: 0, from: 0, to: 3, text: "abc" }];

    it("replaces a reply's entry and caps the list, newest last", () => {
        const full = Array.from({ length: MAX_KEPT }, (_, i) => [`h${i}`, marks] as [string, Mark[]]);
        const kept = keepMarks(full, "h0", marks);
        expect(kept).toHaveLength(MAX_KEPT);
        expect(kept.at(-1)?.[0]).toBe("h0");
        expect(kept.filter(([h]) => h === "h0")).toHaveLength(1);
    });

    it("reads back only the current shape", () => {
        expect(isKept([["h", marks]])).toBe(true);
        expect(isKept([["h", ["abc"]]])).toBe(false);
        expect(isKept(null)).toBe(false);
    });
});

describe("settings", () => {
    it("turns an option off only on an explicit false", () => {
        expect(settingsOf({})).toEqual({ isHighlightOn: true, isDimOn: true });
        expect(settingsOf({ dim: false })).toEqual({ isHighlightOn: true, isDimOn: false });
        expect(settingsOf({ highlight: false, dim: true })).toEqual({ isHighlightOn: false, isDimOn: true });
    });

    it("follows a change to the mod's own /config rows and no other", () => {
        const on = settingsOf({});
        expect(settingAfter(on, HIGHLIGHT_KEY, false)).toEqual({ isHighlightOn: false, isDimOn: true });
        expect(settingAfter(on, DIM_KEY, false)).toEqual({ isHighlightOn: true, isDimOn: false });
        expect(settingAfter(settingsOf({ dim: false }), DIM_KEY, true)).toEqual({ isHighlightOn: true, isDimOn: true });
        expect(settingAfter(on, "theme", false)).toBe(on);
    });
});

describe("submitContext", () => {
    const base = { isInteractive: true, isCommand: false, isComposed: false, hasTold: false };

    it("sends the section first, the reminder after, and nothing where the system prompt took it", () => {
        expect(submitContext(base)).toBe(HIGHLIGHT_SECTION);
        expect(submitContext({ ...base, hasTold: true })).toBe(HIGHLIGHT_REMINDER);
        expect(submitContext({ ...base, isComposed: true })).toBeNull();
        expect(submitContext({ ...base, isInteractive: false })).toBeNull();
        expect(submitContext({ ...base, isCommand: true })).toBeNull();
    });
});
