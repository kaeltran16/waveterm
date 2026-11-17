// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentEntry } from "./agentsviewmodel";
import { appendLines, boxKey, promptHistory, type BoxKeyState } from "./boxrecallmodel";

const user = (text: string): AgentEntry => ({ kind: "user", text });

// history [a, /x, b], oldest first in the transcript
const ENTRIES: AgentEntry[] = [user("a"), { kind: "command", name: "/x" }, user("b")];
const HISTORY = promptHistory(ENTRIES);

const state = (over: Partial<BoxKeyState>): BoxKeyState => ({
    text: "",
    held: false,
    history: HISTORY,
    recall: null,
    ...over,
});

// presses keys from a start, applying each recall the way the box does, and returns the box's text after each
function press(keys: ("ArrowUp" | "ArrowDown")[], start: Partial<BoxKeyState> = {}): string[] {
    let s = state(start);
    const texts: string[] = [];
    for (const k of keys) {
        const act = boxKey(k, s);
        if (act?.kind === "recall") {
            s = { ...s, text: act.text, recall: act.recall };
        }
        texts.push(s.text);
    }
    return texts;
}

describe("box ↑ / ↓", () => {
    it("asks for take-back on ↑ in the empty box while the mod holds something", () => {
        expect(boxKey("ArrowUp", state({ held: true }))).toEqual({ kind: "takeback" });
    });

    it("steps back through history newest first and stays at the oldest", () => {
        expect(press(["ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp"])).toEqual(["b", "/x", "a", "a"]);
    });

    it("steps forward from the oldest and empties the box past the newest", () => {
        const ups = press(["ArrowUp", "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowDown"]);
        expect(ups.slice(3)).toEqual(["/x", "b", ""]);
    });

    it("leaves the box alone on ↓ when it is not recalling", () => {
        expect(boxKey("ArrowDown", state({}))).toBeNull();
        expect(boxKey("ArrowDown", state({ text: "draft" }))).toBeNull();
    });

    it("leaves ↑ to the caret in a box holding typed text", () => {
        expect(boxKey("ArrowUp", state({ text: "draft" }))).toBeNull();
        expect(boxKey("ArrowUp", state({ text: "draft", held: true }))).toBeNull();
    });

    it("leaves recall once the recalled text is edited", () => {
        // recall 0 is "b"; the person typed after it
        expect(boxKey("ArrowUp", state({ text: "b!", recall: 0 }))).toBeNull();
        expect(boxKey("ArrowDown", state({ text: "b!", recall: 0 }))).toBeNull();
    });

    it("does nothing on ↑ with no history and nothing held", () => {
        expect(boxKey("ArrowUp", state({ history: [] }))).toBeNull();
    });
});

describe("prompt history", () => {
    it("lists typed prompts and commands newest first", () => {
        expect(HISTORY).toEqual(["b", "/x", "a"]);
    });

    it("writes a command with its args as typed", () => {
        expect(promptHistory([{ kind: "command", name: "/review", args: "the panel" }])).toEqual(["/review the panel"]);
    });

    it("leaves out Arc's messages and shell runs", () => {
        const entries: AgentEntry[] = [
            user("a"),
            user("wake: task 3 failed (exit 1)"),
            user("brainstorm: question 2 answered"),
            user(
                '[Message from agent "fixer" (tab 3f2a), sent with wsh agents send. Not typed by the user.]\nrebase first'
            ),
            { kind: "shell", command: "git status" },
            user("b"),
        ];
        expect(promptHistory(entries)).toEqual(["b", "a"]);
    });

    it("keeps a prompt sent twice in a row once", () => {
        expect(promptHistory([user("a"), user("go on"), user("go on"), user("a")])).toEqual(["a", "go on", "a"]);
    });

    it("skips an entry with no text", () => {
        expect(promptHistory([user("a"), user("  ")])).toEqual(["a"]);
    });
});

describe("appendLines", () => {
    it("fills an empty box one line each, in order", () => {
        expect(appendLines("", ["first", "second"])).toEqual("first\nsecond");
    });

    it("puts the lines under text already in the box", () => {
        expect(appendLines("draft", ["first"])).toEqual("draft\nfirst");
    });

    it("leaves the box as it is with nothing to add", () => {
        expect(appendLines("draft", [])).toEqual("draft");
    });
});
