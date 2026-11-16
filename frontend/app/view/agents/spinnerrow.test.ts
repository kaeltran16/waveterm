// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseSpinner } from "./spinnerrow";

describe("parseSpinner", () => {
    it("reads glyph, verb and the whole parenthesised detail", () => {
        expect(parseSpinner(["✻ Undulating… (58s · ↓ 4.5k tokens · thinking with high effort)"])).toEqual({
            glyph: "✻",
            verb: "Undulating…",
            detail: "58s · ↓ 4.5k tokens · thinking with high effort",
            tokens: "4.5k",
        });
    });

    it("drops key-hint segments from the detail", () => {
        expect(parseSpinner(["✶ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)"])?.detail).toBe(
            "12s · ↑ 1.2k tokens"
        );
        expect(parseSpinner(["✳ Musing… (Ctrl+T to hide · shift+tab to cycle)"])).toEqual({
            glyph: "✳",
            verb: "Musing…",
        });
    });

    it("reads the output tokens off the detail, and none when it shows no output count", () => {
        expect(parseSpinner(["✻ Cogitating… (24s · ↓ 1.8k tokens)"])?.tokens).toBe("1.8k");
        expect(parseSpinner(["✶ Pondering… (12s · ↑ 1.2k tokens)"])?.tokens).toBeUndefined();
        expect(parseSpinner(["✻ Cogitating… (24s)"])?.tokens).toBeUndefined();
        expect(parseSpinner(["· Thinking…"])?.tokens).toBeUndefined();
    });

    it("reads a spinner with no detail", () => {
        expect(parseSpinner(["· Thinking…"])).toEqual({ glyph: "·", verb: "Thinking…" });
    });

    it("finds the spinner row above the input box and status rows, scanning bottom-up", () => {
        const screen = [
            "● I'll look at the file first.",
            "* Reading the file…",
            "",
            "✢ Frolicking… (3s · ↓ 120 tokens)   ",
            "",
            "╭──────────────────────────────────────╮",
            "│ >                                    │",
            "╰──────────────────────────────────────╯",
            "  ⏵⏵ accept edits on (shift+tab to cycle)",
        ];
        expect(parseSpinner(screen)).toEqual({
            glyph: "✢",
            verb: "Frolicking…",
            detail: "3s · ↓ 120 tokens",
            tokens: "120",
        });
    });

    it("rejects agent output and finished rows that only look like a spinner", () => {
        expect(parseSpinner(["* Reading the file…"])).toBeNull();
        expect(parseSpinner(["✻ Worked for 3m 10s"])).toBeNull();
        expect(parseSpinner(["- Undulating…"])).toBeNull();
        expect(parseSpinner(["· done"])).toBeNull();
        expect(parseSpinner([])).toBeNull();
        expect(parseSpinner(["", "   ", ""])).toBeNull();
    });
});
