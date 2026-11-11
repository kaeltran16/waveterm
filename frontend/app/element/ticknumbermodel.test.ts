// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { reservedWidth, tickDirection } from "./ticknumbermodel";

describe("tickDirection", () => {
    it("rolls up when the new value is larger and down when it is smaller", () => {
        expect(tickDirection(3, 4)).toBe(1);
        expect(tickDirection(4, 3)).toBe(-1);
        expect(tickDirection(-1, 0)).toBe(1);
    });

    it("does not roll an unchanged value", () => {
        expect(tickDirection(7, 7)).toBe(0);
    });
});

describe("reservedWidth", () => {
    it("reserves the longer of the old and new formatted strings", () => {
        expect(reservedWidth("9", "10")).toBe(2);
        expect(reservedWidth("$1,000", "$999")).toBe(6);
        expect(reservedWidth("12", "34")).toBe(2);
    });
});
