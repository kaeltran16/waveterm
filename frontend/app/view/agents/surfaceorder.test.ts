import { describe, expect, it } from "vitest";
import { SURFACE_ORDER } from "./agents";
import { ITEMS } from "./navrail";

describe("SURFACE_ORDER", () => {
    it("has exactly 8 entries so Ctrl+1..8 covers every one — no surface is unreachable by chord", () => {
        expect(SURFACE_ORDER).toHaveLength(8);
    });

    it("no longer carries the merged-away or removed surfaces", () => {
        expect(SURFACE_ORDER).not.toContain("channels");
        expect(SURFACE_ORDER).not.toContain("graph");
        expect(SURFACE_ORDER).not.toContain("tasks");
        expect(SURFACE_ORDER).not.toContain("vault");
    });

    it("keeps setup and settings off the chords, like the rail's bottom group", () => {
        expect(SURFACE_ORDER).not.toContain("setup");
        expect(SURFACE_ORDER).not.toContain("settings");
    });

    it("matches the nav rail's order exactly, so the chord numbers line up with what the user sees", () => {
        expect(ITEMS.map((i) => i.key)).toEqual([...SURFACE_ORDER]);
    });

    it("keeps Jarvis second — Ctrl+2 is the merged surface", () => {
        expect(SURFACE_ORDER[1]).toBe("jarvis");
    });
});
