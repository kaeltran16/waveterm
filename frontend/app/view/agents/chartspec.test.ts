import { describe, expect, it } from "vitest";
import {
    chartCategories,
    fmtChartValue,
    hasNumericX,
    MAX_POINTS,
    MAX_SERIES,
    parseChartSpec,
    segmentsPath,
    valueDomain,
    type ChartSpec,
} from "./chartspec";

describe("chart drawing helpers", () => {
    const two: ChartSpec = {
        type: "line",
        title: "t",
        series: [
            {
                name: "a",
                points: [
                    { x: "mon", y: 1 },
                    { x: "tue", y: 2 },
                ],
            },
            {
                name: "b",
                points: [
                    { x: "tue", y: 3 },
                    { x: "wed", y: 4 },
                ],
            },
        ],
    };
    it("lists categories in first-seen order across series", () => {
        expect(chartCategories(two)).toEqual(["mon", "tue", "wed"]);
        expect(hasNumericX(two)).toBe(false);
    });
    it("widens a flat domain and includes zero when asked", () => {
        expect(valueDomain([5, 9], true)).toEqual([0, 9]);
        expect(valueDomain([5, 9], false)).toEqual([5, 9]);
        expect(valueDomain([0, 0], true)).toEqual([0, 1]);
        expect(valueDomain([4], false)).toEqual([2, 6]);
        expect(valueDomain([-3, 2], true)).toEqual([-3, 2]);
    });
    it("builds a straight-segment path", () => {
        expect(
            segmentsPath([
                [0, 10],
                [5, 2.25],
            ])
        ).toBe("M0.0,10.0 L5.0,2.3");
    });
    it("formats values with their unit", () => {
        expect(fmtChartValue(41.234, "s")).toBe("41.23s");
        expect(fmtChartValue(12000)).toBe("12K");
    });
});

function spec(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
        type: "bar",
        title: "Slowest packages",
        series: [{ name: "wall", points: [{ x: "pkg/a", y: 41 }] }],
        ...over,
    });
}

function reasonOf(raw: string): string {
    const r = parseChartSpec(raw);
    expect(r.ok).toBe(false);
    return "reason" in r ? r.reason : "";
}

describe("parseChartSpec", () => {
    it("parses a valid spec of each type", () => {
        for (const type of ["bar", "line", "area", "scatter"]) {
            const r = parseChartSpec(
                spec({
                    type,
                    x: { label: "x" },
                    y: { label: "time", unit: "s" },
                    series: [
                        {
                            name: "a",
                            points: [
                                { x: 1, y: 2 },
                                { x: 2, y: 3.5 },
                            ],
                        },
                        { name: "b", points: [{ x: 1, y: 0 }] },
                    ],
                })
            );
            expect(r.ok).toBe(true);
            if (!("spec" in r)) continue;
            expect(r.spec.type).toBe(type);
            expect(r.spec.y?.unit).toBe("s");
            expect(r.spec.series).toHaveLength(2);
        }
    });

    it("accepts string categories outside scatter", () => {
        const r = parseChartSpec(spec({ type: "line" }));
        expect(r.ok).toBe(true);
    });

    it("rejects bad JSON", () => {
        expect(reasonOf("{type: bar")).toMatch(/json/i);
    });

    it("rejects a non-object", () => {
        expect(reasonOf("[1,2]")).toMatch(/object/i);
    });

    it("rejects an unknown type", () => {
        expect(reasonOf(spec({ type: "pie" }))).toMatch(/type/);
    });

    it("rejects a missing title", () => {
        expect(reasonOf(spec({ title: undefined }))).toMatch(/title/);
        expect(reasonOf(spec({ title: "  " }))).toMatch(/title/);
    });

    it("rejects empty series", () => {
        expect(reasonOf(spec({ series: [] }))).toMatch(/series/);
        expect(reasonOf(spec({ series: undefined }))).toMatch(/series/);
    });

    it("rejects a series with no points", () => {
        expect(reasonOf(spec({ series: [{ name: "a", points: [] }] }))).toMatch(/points/);
    });

    it("rejects a NaN or string y", () => {
        // JSON has no NaN literal: JSON.stringify writes null for it
        expect(reasonOf(spec({ series: [{ name: "a", points: [{ x: "p", y: NaN }] }] }))).toMatch(/\by\b/);
        expect(reasonOf('{"type":"bar","title":"t","series":[{"name":"a","points":[{"x":"p","y":NaN}]}]}')).toMatch(
            /json/i
        );
        expect(reasonOf(spec({ series: [{ name: "a", points: [{ x: "p", y: "41" }] }] }))).toMatch(/\by\b/);
    });

    it("rejects more than 8 series", () => {
        const series = Array.from({ length: MAX_SERIES + 1 }, (_, i) => ({
            name: `s${i}`,
            points: [{ x: 1, y: 1 }],
        }));
        expect(reasonOf(spec({ series }))).toMatch(/series/);
    });

    it("rejects more than 500 points", () => {
        const points = Array.from({ length: MAX_POINTS + 1 }, (_, i) => ({ x: i, y: i }));
        expect(reasonOf(spec({ type: "line", series: [{ name: "a", points }] }))).toMatch(/points/);
    });

    it("rejects a scatter with string x", () => {
        expect(reasonOf(spec({ type: "scatter" }))).toMatch(/scatter/);
    });

    it("rejects a malformed axis", () => {
        expect(reasonOf(spec({ y: { unit: 5 } }))).toMatch(/unit/);
    });

    it("never throws on a 10,000-point spec", () => {
        const points = Array.from({ length: 10_000 }, (_, i) => ({ x: i, y: Math.sin(i) }));
        const raw = spec({ type: "scatter", series: [{ name: "a", points }] });
        expect(() => parseChartSpec(raw)).not.toThrow();
        expect(parseChartSpec(raw).ok).toBe(false);
    });

    it("never throws on hostile shapes", () => {
        for (const raw of [
            "null",
            '"x"',
            "42",
            '{"series":[null]}',
            '{"type":"bar","title":"t","series":[{"points":[null]}]}',
        ]) {
            expect(() => parseChartSpec(raw)).not.toThrow();
            expect(parseChartSpec(raw).ok).toBe(false);
        }
    });
});
