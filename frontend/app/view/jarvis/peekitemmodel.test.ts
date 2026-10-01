// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { goneLine, itemButtons, itemHints, itemKeyCommand, openLabel } from "./peekitemmodel";
import type { PeekFacts } from "./peekstore";

const FOCUS: PeekFacts["focus"] = { ref: { kind: "run", id: "r1" }, label: "Ship", project: "arc" };

describe("itemButtons", () => {
    it("disables both while the body has not reported (loading)", () => {
        expect(itemButtons("run", null)).toEqual({ open: "disabled", focus: "disabled" });
    });

    it("disables both when the target is gone", () => {
        expect(itemButtons("run", { gone: true, focus: FOCUS })).toEqual({ open: "disabled", focus: "disabled" });
        expect(itemButtons("agent", { gone: true, focus: null })).toEqual({ open: "disabled", focus: "disabled" });
    });

    it("has no Focus this for a target with nothing to focus on", () => {
        expect(itemButtons("effort", { gone: false, focus: null })).toEqual({ open: "enabled", focus: "absent" });
    });

    it("enables both for a present, focusable target", () => {
        expect(itemButtons("run", { gone: false, focus: FOCUS })).toEqual({ open: "enabled", focus: "enabled" });
    });
});

describe("openLabel", () => {
    it("names each kind the way the item view does", () => {
        expect(openLabel("run")).toBe("Open run");
        expect(openLabel("agent")).toBe("Open agent");
        expect(openLabel("record")).toBe("Open record");
        expect(openLabel("effort")).toBe("Open initiative");
        expect(openLabel("radar")).toBe("Open finding");
    });

    it("the gone line uses the same word", () => {
        expect(goneLine("effort")).toBe("That initiative no longer exists");
    });
});

describe("itemHints", () => {
    const labels = (facts: PeekFacts | null) => itemHints("run", facts).map((h) => `${h.keys.join("")} ${h.label}`);

    it("offers focus this only while Focus this is enabled", () => {
        expect(labels({ gone: false, focus: FOCUS })).toEqual(["↵ open run", "f focus this", "⌫ back", "esc close"]);
        expect(labels({ gone: false, focus: null })).toEqual(["↵ open run", "⌫ back", "esc close"]);
        expect(labels(null)).toEqual(["↵ open run", "⌫ back", "esc close"]);
        expect(labels({ gone: true, focus: FOCUS })).toEqual(["↵ open run", "⌫ back", "esc close"]);
    });
});

describe("itemKeyCommand", () => {
    it("maps Enter, f, Backspace and Escape", () => {
        expect(itemKeyCommand("Enter")).toBe("open");
        expect(itemKeyCommand("f")).toBe("focus");
        expect(itemKeyCommand("Backspace")).toBe("back");
        expect(itemKeyCommand("Escape")).toBe("close");
    });

    it("maps nothing else", () => {
        for (const key of ["F", " ", "j", "k", "/", "Delete", "ArrowLeft", "o"]) {
            expect(itemKeyCommand(key)).toBeNull();
        }
    });
});
