// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { backspaceMention, insertMention, mentionQueryAt, mentionTokens } from "./filementionmodel";

const end = (s: string) => s.length;

describe("mentionQueryAt", () => {
    it("opens on an @ at the start of the text with the typed query", () => {
        expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
        expect(mentionQueryAt("@src/ap", 7)).toEqual({ start: 0, query: "src/ap" });
    });
    it("opens on an @ after whitespace, a newline included", () => {
        expect(mentionQueryAt("look at @rea", end("look at @rea"))).toEqual({ start: 8, query: "rea" });
        expect(mentionQueryAt("one\n@two", end("one\n@two"))).toEqual({ start: 4, query: "two" });
    });
    it("takes the query only up to the caret", () => {
        expect(mentionQueryAt("@readme", 4)).toEqual({ start: 0, query: "rea" });
    });
    it("stays text for an @ inside a word or an email", () => {
        expect(mentionQueryAt("a@b", 3)).toBeNull();
        expect(mentionQueryAt("mail me@example.com", end("mail me@example.com"))).toBeNull();
        expect(mentionQueryAt("@alice@x", 8)).toBeNull();
    });
    it("stays closed when the caret is outside the word", () => {
        expect(mentionQueryAt("@src/a.ts more", end("@src/a.ts more"))).toBeNull();
        expect(mentionQueryAt("@src/a.ts ", 10)).toBeNull();
        expect(mentionQueryAt("x @abc", 1)).toBeNull();
    });
});

describe("insertMention", () => {
    it("replaces exactly @query and puts the caret after the trailing space", () => {
        expect(insertMention("see @rea now", 4, 8, "README.md")).toEqual({ text: "see @README.md  now", caret: 15 });
        expect(insertMention("@co", 0, 3, "src/code.ts")).toEqual({ text: "@src/code.ts ", caret: 13 });
    });
    it("quotes a path holding whitespace", () => {
        expect(insertMention("@my", 0, 3, "docs/my notes.md")).toEqual({
            text: '@"docs/my notes.md" ',
            caret: 20,
        });
    });
});

describe("mentionTokens", () => {
    it("finds path-like words: a separator or an extension", () => {
        expect(mentionTokens("@src/app and @README.md and @C:\\x\\y")).toEqual([
            { start: 0, end: 8, path: "src/app" },
            { start: 13, end: 23, path: "README.md" },
            { start: 28, end: 35, path: "C:\\x\\y" },
        ]);
    });
    it("leaves a bare name, an email and an @ inside a word as text", () => {
        expect(mentionTokens("@alice me@x.com a@b/c")).toEqual([]);
    });
    it("drops trailing punctuation from the path", () => {
        expect(mentionTokens("read @src/a.ts, then @b/c.md).")).toEqual([
            { start: 5, end: 14, path: "src/a.ts" },
            { start: 21, end: 28, path: "b/c.md" },
        ]);
    });
    it("reads the quoted form whole, past its closing quote", () => {
        expect(mentionTokens('see @"docs/my notes.md" ok')).toEqual([{ start: 4, end: 23, path: "docs/my notes.md" }]);
    });
    it("skips an unclosed quote", () => {
        expect(mentionTokens('@"docs/my notes.md')).toEqual([]);
    });
});

describe("backspaceMention", () => {
    it("at a token's end removes the token and the space after it", () => {
        expect(backspaceMention("see @src/a.ts more", 13)).toEqual({ text: "see more", caret: 4 });
    });
    it("right after the token's space removes token and space", () => {
        expect(backspaceMention("@src/a.ts ", 10)).toEqual({ text: "", caret: 0 });
        expect(backspaceMention('x @"a b.md" y', 12)).toEqual({ text: "x y", caret: 2 });
    });
    it("returns null elsewhere", () => {
        expect(backspaceMention("@src/a.ts ", 5)).toBeNull();
        expect(backspaceMention("@src/a.ts  ", 11)).toBeNull();
        expect(backspaceMention("plain text", 10)).toBeNull();
        expect(backspaceMention("@alice ", 7)).toBeNull();
    });
});
