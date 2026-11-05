// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { CONTROL_SELECTOR, petYields, type Beneath } from "./petyield";

const box = { left: 850, top: 528, right: 982, bottom: 660 };
const control = (): Beneath => ({ closest: (sel) => (sel === CONTROL_SELECTOR ? {} : null) });
const text = (): Beneath => ({ closest: () => null });
const at = (x: number, y: number, buttons = 0) => ({ x, y, buttons });

describe("petYields", () => {
    it("yields while the pointer is over its box and a control is under that point", () => {
        expect(petYields(at(925, 567), box, control, false)).toBe(true);
    });

    it("keeps its box where nothing under the pointer is a control", () => {
        expect(petYields(at(925, 567), box, text, false)).toBe(false);
        expect(petYields(at(925, 567), box, () => null, false)).toBe(false);
    });

    it("hit-tests under the pointer only inside its box", () => {
        let reads = 0;
        const counted = () => {
            reads++;
            return control();
        };
        petYields(at(10, 10), box, counted, false);
        expect(reads).toBe(0);
        petYields(at(925, 567), box, counted, false);
        expect(reads).toBe(1);
    });

    it("comes back once the pointer leaves its box", () => {
        expect(petYields(at(840, 567), box, control, true)).toBe(false);
        expect(petYields(at(925, 670), box, control, true)).toBe(false);
    });

    it("never changes while a button is held, so a drag across a control is not cut off", () => {
        expect(petYields(at(925, 567, 1), box, control, false)).toBe(false);
        expect(petYields(at(840, 567, 1), box, text, true)).toBe(true);
    });
});
