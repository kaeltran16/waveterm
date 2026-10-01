// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { nextCtrlHeld } from "./ctrlheld";

describe("nextCtrlHeld", () => {
    it("Control down sets the flag and Control up clears it", () => {
        expect(nextCtrlHeld(false, { type: "keydown", key: "Control" })).toBe(true);
        expect(nextCtrlHeld(true, { type: "keyup", key: "Control" })).toBe(false);
    });

    it("a blur clears it, so Alt+Tab with Ctrl held leaves nothing underlined", () => {
        expect(nextCtrlHeld(true, { type: "blur" })).toBe(false);
        expect(nextCtrlHeld(false, { type: "blur" })).toBe(false);
    });

    it("other keys leave it as it was", () => {
        for (const held of [true, false]) {
            expect(nextCtrlHeld(held, { type: "keydown", key: "p" })).toBe(held);
            expect(nextCtrlHeld(held, { type: "keyup", key: "Shift" })).toBe(held);
        }
    });
});
