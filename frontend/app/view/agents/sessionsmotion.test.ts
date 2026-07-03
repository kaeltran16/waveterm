// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MOTION } from "@/app/element/motiontokens";
import { reflowProps } from "./sessionsmotion";

describe("reflowProps", () => {
    it("animates chip-driven reflow with the fluid macro transition", () => {
        const rp = reflowProps(true);
        expect(rp.initial).toBe("initial");
        expect(rp.exit).toBe("exit");
        expect(rp.transition).toEqual({ duration: MOTION.durMacro, ease: MOTION.easeFluid });
    });

    it("makes search-driven changes instant (no enter, no exit, zero-duration layout)", () => {
        const rp = reflowProps(false);
        expect(rp.initial).toBe(false);
        expect(rp.exit).toBeUndefined();
        expect(rp.transition).toEqual({ duration: 0 });
    });
});
