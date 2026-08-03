// frontend/app/view/code/codehistory.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { back, canBack, canForward, currentPath, EMPTY_HISTORY, forward, push } from "./codehistory";

const three = () => push(push(push(EMPTY_HISTORY, "a.ts"), "b.ts"), "c.ts");

describe("codehistory", () => {
    it("starts empty with nothing to walk", () => {
        expect(currentPath(EMPTY_HISTORY)).toBeNull();
        expect(canBack(EMPTY_HISTORY)).toBe(false);
        expect(canForward(EMPTY_HISTORY)).toBe(false);
    });

    it("pushes onto the end and points at the newest entry", () => {
        const h = three();
        expect(h.stack).toEqual(["a.ts", "b.ts", "c.ts"]);
        expect(currentPath(h)).toBe("c.ts");
    });

    it("ignores re-opening the file already shown", () => {
        const h = push(push(EMPTY_HISTORY, "a.ts"), "a.ts");
        expect(h.stack).toEqual(["a.ts"]);
    });

    it("walks back and forward over the stack", () => {
        const h = back(back(three()));
        expect(currentPath(h)).toBe("a.ts");
        expect(currentPath(forward(h))).toBe("b.ts");
    });

    it("clamps at both ends instead of going out of range", () => {
        const h = three();
        expect(currentPath(back(back(back(back(h)))))).toBe("a.ts");
        expect(currentPath(forward(h))).toBe("c.ts");
    });

    it("truncates the forward tail when pushing after going back", () => {
        const h = push(back(three()), "d.ts");
        expect(h.stack).toEqual(["a.ts", "b.ts", "d.ts"]);
        expect(canForward(h)).toBe(false);
    });
});
