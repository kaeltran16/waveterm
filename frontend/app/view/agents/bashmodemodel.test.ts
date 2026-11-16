// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { bashOffKey, bashOnInput } from "./bashmodemodel";

describe("bashOnInput", () => {
    it("turns on with an empty box for a ! typed into an empty box", () => {
        expect(bashOnInput("", "!")).toEqual({ bash: true, text: "" });
    });
    it("keeps the command of a pasted !cmd", () => {
        expect(bashOnInput("", "!ls")).toEqual({ bash: true, text: "ls" });
    });
    it("leaves a ! typed after text alone", () => {
        expect(bashOnInput("a", "a!")).toBeNull();
    });
    it("leaves text without a leading ! alone", () => {
        expect(bashOnInput("", "ls")).toBeNull();
        expect(bashOnInput("", "a!")).toBeNull();
    });
});

describe("bashOffKey", () => {
    it("turns off on Escape with no panel open", () => {
        expect(bashOffKey("Escape", "ls", false)).toBe(true);
    });
    it("stays on for Escape while a panel is open", () => {
        expect(bashOffKey("Escape", "ls", true)).toBe(false);
    });
    it("turns off on Backspace in an empty box", () => {
        expect(bashOffKey("Backspace", "", false)).toBe(true);
    });
    it("stays on for Backspace with text", () => {
        expect(bashOffKey("Backspace", "x", false)).toBe(false);
    });
    it("stays on for other keys", () => {
        expect(bashOffKey("Enter", "", false)).toBe(false);
        expect(bashOffKey("a", "", false)).toBe(false);
    });
});
