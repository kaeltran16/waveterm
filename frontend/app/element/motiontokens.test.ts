// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MOTION, cardVariants, modalBackdrop, modalPanel, shouldFadeEntry } from "./motiontokens";

describe("motiontokens", () => {
    it("uses the Fluid feel: macro ~360ms on the chosen ease curve", () => {
        expect(MOTION.durMacro).toBeCloseTo(0.36);
        expect(MOTION.durExit).toBeLessThan(MOTION.durMacro); // exits leave quicker
        expect(MOTION.easeFluid).toEqual([0.22, 1, 0.36, 1]);
    });

    it("card entrance animates opacity/scale only (never x/y — Reorder owns the transform)", () => {
        expect(cardVariants.initial).not.toHaveProperty("y");
        expect(cardVariants.initial).not.toHaveProperty("x");
        // Variant is a union that includes a resolver function; these presets are plain
        // target objects, so assert the shape we're testing.
        expect((cardVariants.initial as { opacity: number }).opacity).toBe(0);
        expect((cardVariants.animate as { opacity: number }).opacity).toBe(1);
    });

    it("only narrates message/user entries — tool bursts do not fade (burst guard)", () => {
        expect(shouldFadeEntry("message")).toBe(true);
        expect(shouldFadeEntry("user")).toBe(true);
        expect(shouldFadeEntry("action")).toBe(false);
    });

    it("modal backdrop cross-fades: micro in, exit out, fluid ease", () => {
        expect((modalBackdrop.initial as { opacity: number }).opacity).toBe(0);
        expect((modalBackdrop.animate as any).opacity).toBe(1);
        expect((modalBackdrop.animate as any).transition.duration).toBeCloseTo(MOTION.durMicro);
        expect((modalBackdrop.exit as any).transition.duration).toBeCloseTo(MOTION.durExit);
        expect((modalBackdrop.animate as any).transition.ease).toEqual(MOTION.easeFluid);
    });

    it("modal panel reuses the card entrance signature (single source of feel)", () => {
        expect(modalPanel).toBe(cardVariants);
    });
});
