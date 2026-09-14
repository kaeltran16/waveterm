// frontend/app/view/code/codehistory.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    back,
    canBack,
    canForward,
    currentEntry,
    EMPTY_HISTORY,
    forward,
    push,
    recentPaths,
    withLine,
} from "./codehistory";

const three = () => push(push(push(EMPTY_HISTORY, "a.ts"), "b.ts"), "c.ts");
const paths = (h: ReturnType<typeof three>) => h.stack.map((e) => e.path);

describe("codehistory", () => {
    it("starts empty with nothing to walk", () => {
        expect(currentEntry(EMPTY_HISTORY)).toBeNull();
        expect(canBack(EMPTY_HISTORY)).toBe(false);
        expect(canForward(EMPTY_HISTORY)).toBe(false);
    });

    it("pushes onto the end and points at the newest entry", () => {
        const h = three();
        expect(paths(h)).toEqual(["a.ts", "b.ts", "c.ts"]);
        expect(currentEntry(h)?.path).toBe("c.ts");
    });

    it("ignores re-opening the file already shown", () => {
        const h = push(push(EMPTY_HISTORY, "a.ts"), "a.ts");
        expect(paths(h)).toEqual(["a.ts"]);
    });

    it("walks back and forward over the stack", () => {
        const h = back(back(three()));
        expect(currentEntry(h)?.path).toBe("a.ts");
        expect(currentEntry(forward(h))?.path).toBe("b.ts");
    });

    it("clamps at both ends instead of going out of range", () => {
        const h = three();
        expect(currentEntry(back(back(back(back(h)))))?.path).toBe("a.ts");
        expect(currentEntry(forward(h))?.path).toBe("c.ts");
    });

    it("truncates the forward tail when pushing after going back", () => {
        const h = push(back(three()), "d.ts");
        expect(paths(h)).toEqual(["a.ts", "b.ts", "d.ts"]);
        expect(canForward(h)).toBe(false);
    });

    it("treats a jump to another line of the open file as a move", () => {
        const h = push(withLine(push(EMPTY_HISTORY, "a.ts"), 10), "a.ts", 200);
        expect(h.stack).toEqual([
            { path: "a.ts", line: 10 },
            { path: "a.ts", line: 200 },
        ]);
    });

    it("ignores a jump to the line the caret already sits on", () => {
        const h = push(withLine(push(EMPTY_HISTORY, "a.ts"), 10), "a.ts", 10);
        expect(h.stack).toHaveLength(1);
    });

    it("walks back to the line the caret was on when the entry was left", () => {
        const left = push(withLine(push(EMPTY_HISTORY, "a.ts"), 42), "b.ts");
        expect(currentEntry(back(left))).toEqual({ path: "a.ts", line: 42 });
    });

    it("keeps the recorded line when there is no caret to read", () => {
        const h = withLine(push(EMPTY_HISTORY, "a.ts", 7), null);
        expect(currentEntry(h)?.line).toBe(7);
    });
});

describe("recentPaths", () => {
    it("lists visited files most recent first, once each, leaving out the open one", () => {
        const h = push(push(push(push(EMPTY_HISTORY, "a.ts"), "b.ts"), "a.ts"), "c.ts");
        expect(recentPaths(h)).toEqual(["a.ts", "b.ts"]);
    });

    it("leaves out the file shown after walking back", () => {
        const h = back(push(push(push(EMPTY_HISTORY, "a.ts"), "b.ts"), "c.ts"));
        expect(recentPaths(h)).toEqual(["c.ts", "a.ts"]);
    });

    it("is empty before anything was opened", () => {
        expect(recentPaths(EMPTY_HISTORY)).toEqual([]);
    });
});
