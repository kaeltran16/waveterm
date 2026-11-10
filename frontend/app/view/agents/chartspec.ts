// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The chart spec an agent writes in a ```chart fenced block (taught by skills/charts). Parsing never
// throws: a spec that fails returns the reason, and the card shows the raw block with it.

export const CHART_TYPES = ["bar", "line", "area", "scatter"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const MAX_SERIES = 8;
export const MAX_POINTS = 500;

export type ChartPoint = { x: string | number; y: number };
export type ChartSeries = { name: string; points: ChartPoint[] };
export type ChartSpec = {
    type: ChartType;
    title: string;
    x?: { label?: string };
    y?: { label?: string; unit?: string };
    series: ChartSeries[];
};

export type ChartParse = { ok: true; spec: ChartSpec } | { ok: false; reason: string };

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(reason: string): ChartParse {
    return { ok: false, reason };
}

function parseAxis(
    v: unknown,
    name: string,
    keys: string[]
): { ok: true; axis: Record<string, string> } | { ok: false; reason: string } {
    if (v === undefined) return { ok: true, axis: undefined };
    if (!isObject(v)) return { ok: false, reason: `${name} must be an object` };
    const axis: Record<string, string> = {};
    for (const k of keys) {
        if (v[k] === undefined) continue;
        if (typeof v[k] !== "string") return { ok: false, reason: `${name}.${k} must be a string` };
        axis[k] = v[k] as string;
    }
    return { ok: true, axis };
}

function parseSeries(
    v: unknown,
    i: number,
    numericX: boolean
): { ok: true; s: ChartSeries } | { ok: false; reason: string } {
    if (!isObject(v)) return { ok: false, reason: `series[${i}] must be an object` };
    if (typeof v.name !== "string") return { ok: false, reason: `series[${i}].name must be a string` };
    if (!Array.isArray(v.points) || v.points.length === 0) {
        return { ok: false, reason: `series[${i}].points must be a non-empty array` };
    }
    if (v.points.length > MAX_POINTS) {
        return { ok: false, reason: `series[${i}] has ${v.points.length} points, at most ${MAX_POINTS}` };
    }
    const points: ChartPoint[] = [];
    for (let j = 0; j < v.points.length; j++) {
        const p = v.points[j];
        const at = `series[${i}].points[${j}]`;
        if (!isObject(p)) return { ok: false, reason: `${at} must be an object` };
        if (typeof p.y !== "number" || !Number.isFinite(p.y)) {
            return { ok: false, reason: `${at}.y must be a finite number` };
        }
        if (numericX && (typeof p.x !== "number" || !Number.isFinite(p.x))) {
            return { ok: false, reason: `${at}.x must be a finite number in a scatter chart` };
        }
        if (typeof p.x !== "string" && (typeof p.x !== "number" || !Number.isFinite(p.x))) {
            return { ok: false, reason: `${at}.x must be a string or a finite number` };
        }
        points.push({ x: p.x, y: p.y });
    }
    return { ok: true, s: { name: v.name, points } };
}

// x values as band categories, in first-seen order across series
export function chartCategories(spec: ChartSpec): string[] {
    const seen = new Set<string>();
    for (const s of spec.series) for (const p of s.points) seen.add(String(p.x));
    return [...seen];
}

// a numeric x axis needs every x a number; scatter guarantees it, line and area may carry labels
export function hasNumericX(spec: ChartSpec): boolean {
    return spec.series.every((s) => s.points.every((p) => typeof p.x === "number"));
}

// [lo, hi] for a linear scale, widened so a flat series still spans an axis
export function valueDomain(values: number[], includeZero: boolean): [number, number] {
    let lo = includeZero ? 0 : Infinity;
    let hi = includeZero ? 0 : -Infinity;
    for (const v of values) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    if (lo === hi) return lo === 0 ? [0, 1] : [lo - Math.abs(lo) / 2, hi + Math.abs(hi) / 2];
    return [lo, hi];
}

// straight segments: no curve helper is a declared dependency (decision 11)
export function segmentsPath(xy: [number, number][]): string {
    return xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

export function fmtChartValue(v: number, unit?: string): string {
    const n = new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 2,
        notation: Math.abs(v) >= 1e4 ? "compact" : "standard",
    }).format(v);
    return unit ? `${n}${unit}` : n;
}

export function parseChartSpec(raw: string): ChartParse {
    let v: unknown;
    try {
        v = JSON.parse(raw);
    } catch (e) {
        return fail(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!isObject(v)) return fail("the spec must be a JSON object");
    if (typeof v.type !== "string" || !(CHART_TYPES as readonly string[]).includes(v.type)) {
        return fail(`type must be one of ${CHART_TYPES.join(", ")}`);
    }
    const type = v.type as ChartType;
    if (typeof v.title !== "string" || v.title.trim() === "") return fail("title must be a non-empty string");
    const x = parseAxis(v.x, "x", ["label"]);
    if ("reason" in x) return fail(x.reason);
    const y = parseAxis(v.y, "y", ["label", "unit"]);
    if ("reason" in y) return fail(y.reason);
    if (!Array.isArray(v.series) || v.series.length === 0) return fail("series must be a non-empty array");
    if (v.series.length > MAX_SERIES) return fail(`${v.series.length} series, at most ${MAX_SERIES}`);
    const series: ChartSeries[] = [];
    for (let i = 0; i < v.series.length; i++) {
        const s = parseSeries(v.series[i], i, type === "scatter");
        if ("reason" in s) return fail(s.reason);
        series.push(s.s);
    }
    return { ok: true, spec: { type, title: v.title, x: x.axis, y: y.axis, series } };
}
