// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { termScrollback } from "./termutil";

describe("termScrollback", () => {
    it("is 2000 lines when nothing sets it", () => {
        expect(termScrollback(undefined)).toBe(2000);
    });
    it("takes the setting, and a block's own value over it", () => {
        expect(termScrollback(5000)).toBe(5000);
        expect(termScrollback(5000, 300.7)).toBe(300);
    });
});
