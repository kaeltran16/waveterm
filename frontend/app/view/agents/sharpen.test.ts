// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { canSharpen, isCurrentRequest, undoAvailable, type SharpenState } from "./sharpen";

describe("canSharpen", () => {
    it("is false for terminal", () => {
        expect(canSharpen("terminal", "do it", false)).toBe(false);
    });
    it("is false when task is blank/whitespace", () => {
        expect(canSharpen("claude", "   ", false)).toBe(false);
        expect(canSharpen("claude", "", false)).toBe(false);
    });
    it("is false while a request is loading", () => {
        expect(canSharpen("claude", "do it", true)).toBe(false);
    });
    it("is true for an agent runtime with a non-empty task and no in-flight request", () => {
        expect(canSharpen("claude", "do it", false)).toBe(true);
        expect(canSharpen("codex", "do it", false)).toBe(true);
        expect(canSharpen("antigravity", "do it", false)).toBe(true);
    });
});

describe("isCurrentRequest", () => {
    it("accepts only the latest request id", () => {
        expect(isCurrentRequest(3, 3)).toBe(true);
        expect(isCurrentRequest(2, 3)).toBe(false);
    });
});

describe("undoAvailable", () => {
    const proposed: SharpenState = { kind: "proposed", undoTask: "old", proposedTask: "new", model: "fable" };
    it("is available while the textarea still holds the proposed text", () => {
        expect(undoAvailable(proposed, "new")).toBe(true);
    });
    it("is invalidated once the user edits the result", () => {
        expect(undoAvailable(proposed, "new edited")).toBe(false);
    });
    it("is false in idle/loading states", () => {
        expect(undoAvailable({ kind: "idle" }, "new")).toBe(false);
        expect(undoAvailable({ kind: "loading", reqId: 1, mode: "fast" }, "new")).toBe(false);
    });
});
