import { describe, expect, it } from "vitest";
import { runPaletteAction } from "./palette-action";

describe("runPaletteAction", () => {
    it("reports success only after the action resolves", async () => {
        await expect(runPaletteAction(async () => undefined)).resolves.toEqual({ ok: true });
    });

    it("returns a concise failure without throwing", async () => {
        await expect(runPaletteAction(async () => Promise.reject(new Error("route unavailable")))).resolves.toEqual({
            ok: false,
            error: "Error: route unavailable",
        });
    });
});
