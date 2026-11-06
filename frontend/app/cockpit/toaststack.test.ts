// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ERROR_TOAST_TTL_MS, toastStackBottom } from "./toaststack";

const REACH = 172;

describe("toastStackBottom", () => {
    it("sits a gap above the avatar in the bottom-right corner", () => {
        expect(toastStackBottom("bottom-right", null, REACH)).toBe(REACH + 12);
    });

    it("rises over a bubble shown in the bottom-right corner", () => {
        expect(toastStackBottom("bottom-right", 80, REACH)).toBe(REACH + 10 + 80 + 12);
    });

    it("sits a gap above the footer when the pet is bottom-left", () => {
        expect(toastStackBottom("bottom-left", null, REACH)).toBe(28 + 12);
    });

    it("ignores a bubble in the other corner", () => {
        expect(toastStackBottom("bottom-left", 80, REACH)).toBe(28 + 12);
    });

    it("an error toast lives 12 s", () => {
        expect(ERROR_TOAST_TTL_MS).toBe(12000);
    });
});
