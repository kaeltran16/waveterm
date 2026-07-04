// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MOTION, cardVariants, computeEntrances, easeFluidCss, initialEntranceState, modalBackdrop, modalPanel, shouldFadeEntry, reflowProps } from "./motiontokens";

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

describe("easeFluidCss", () => {
    it("is the css cubic-bezier form of MOTION.easeFluid", () => {
        expect(easeFluidCss).toBe(`cubic-bezier(${MOTION.easeFluid.join(", ")})`);
        expect(easeFluidCss).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    });
});

describe("computeEntrances", () => {
    it("first mount animates nothing and seeds seen", () => {
        const r = computeEntrances(initialEntranceState(), "k1", ["a", "b"]);
        expect([...r.animate]).toEqual([]);
        expect([...r.state.seen].sort()).toEqual(["a", "b"]);
        expect(r.state.key).toBe("k1");
    });

    it("switching key animates nothing and reseeds", () => {
        const first = computeEntrances(initialEntranceState(), "k1", ["a", "b"]);
        const r = computeEntrances(first.state, "k2", ["x", "y"]);
        expect([...r.animate]).toEqual([]);
        expect([...r.state.seen].sort()).toEqual(["x", "y"]);
        expect(r.state.key).toBe("k2");
    });

    it("same-key append animates only the new ids", () => {
        const first = computeEntrances(initialEntranceState(), "k1", ["a", "b"]);
        const r = computeEntrances(first.state, "k1", ["a", "b", "c"]);
        expect([...r.animate]).toEqual(["c"]);
        expect([...r.state.seen].sort()).toEqual(["a", "b", "c"]);
    });

    it("undefined key (no source) seeds silently", () => {
        const r = computeEntrances(initialEntranceState(), undefined, []);
        expect([...r.animate]).toEqual([]);
        expect(r.state.key).toBeUndefined();
    });

    it("a removed id does not error and stays remembered", () => {
        const first = computeEntrances(initialEntranceState(), "k1", ["a", "b"]);
        const r = computeEntrances(first.state, "k1", ["a"]);
        expect([...r.animate]).toEqual([]);
        expect(r.state.seen.has("b")).toBe(true);
    });
});

describe("reflowProps", () => {
    it("animates chip-driven reflow with the fluid macro transition", () => {
        const rp = reflowProps(true);
        expect(rp.initial).toBe("initial");
        expect(rp.exit).toBe("exit");
        expect(rp.transition).toEqual({ duration: MOTION.durMacro, ease: MOTION.easeFluid });
    });

    it("makes non-chip changes instant (no enter, no exit, zero-duration layout)", () => {
        const rp = reflowProps(false);
        expect(rp.initial).toBe(false);
        expect(rp.exit).toBeUndefined();
        expect(rp.transition).toEqual({ duration: 0 });
    });
});
