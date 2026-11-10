import { describe, expect, it } from "vitest";
import { ChartCard } from "./chartcard";
import { blockRendererFor } from "./renderregistry";

describe("blockRendererFor", () => {
    it("maps the chart language to ChartCard", () => {
        expect(blockRendererFor("chart")).toBe(ChartCard);
    });
    it("has no renderer for other or missing languages", () => {
        expect(blockRendererFor(undefined)).toBeUndefined();
        expect(blockRendererFor("ts")).toBeUndefined();
    });
    it("does not resolve inherited object keys", () => {
        expect(blockRendererFor("constructor")).toBeUndefined();
        expect(blockRendererFor("toString")).toBeUndefined();
    });
});
