import { describe, expect, it } from "vitest";
import { capabilityFor, normalizeLegacyRoute, normalizeProfileOverrideRoute, resolveEffectiveRoute, routeForRuntime, routePickerItems } from "./route";

const capability = (runtime: string, tier: string, resolvedmodel = `${runtime}/${tier}`): RouteCapabilityInfo => ({
    runtime,
    tier,
    resolvedmodel,
});
const harness = (runtime: string, routecapabilities?: RouteCapabilityInfo[]): HarnessInfo =>
    ({ runtime, label: runtime.toUpperCase(), installed: true, consultcapable: true, runworkercapable: true, routecapabilities }) as HarnessInfo;

const pin = (runtime: string, tier = "capable"): RoutePin => ({ runtime, tier });

describe("route derivation", () => {
    it("normalizes legacy empty tiers and runtime-only pins", () => {
        expect(normalizeLegacyRoute("pi")).toEqual(pin("pi"));
        expect(normalizeLegacyRoute("pi", "")).toEqual(pin("pi"));
        expect(normalizeLegacyRoute("", "capable")).toBeNull();
    });

    it("resolves task, run, channel, then settings", () => {
        const input = { settings: pin("settings"), channel: pin("channel"), run: pin("run"), task: pin("task"), harnesses: [] };
        expect(resolveEffectiveRoute(input)).toMatchObject({ pin: pin("task"), source: "task" });
        expect(resolveEffectiveRoute({ ...input, task: null })).toMatchObject({ pin: pin("run"), source: "run" });
        expect(resolveEffectiveRoute({ ...input, task: null, run: null })).toMatchObject({ pin: pin("channel"), source: "channel" });
        expect(resolveEffectiveRoute({ ...input, task: null, run: null, channel: null })).toMatchObject({ pin: pin("settings"), source: "settings" });
    });

    it("treats a cleared channel or task override as inheritance", () => {
        expect(resolveEffectiveRoute({ settings: pin("settings"), channel: null, run: null, task: null, harnesses: [] })).toMatchObject({ source: "settings" });
        expect(resolveEffectiveRoute({ settings: pin("settings"), channel: pin("channel"), run: null, task: null, harnesses: [] })).toMatchObject({ source: "channel" });
    });

    it("normalizes empty tiers at every precedence rung", () => {
        expect(resolveEffectiveRoute({ settings: { runtime: "settings", tier: "" }, channel: null, run: null, task: { runtime: "task", tier: "" }, harnesses: [] })).toMatchObject({ pin: pin("task"), source: "task" });
    });

    it("returns an unresolved route without substituting a capability", () => {
        const selected = resolveEffectiveRoute({ settings: pin("pi", "long"), harnesses: [harness("pi", [capability("pi", "capable")])] });
        expect(selected).toEqual({ pin: pin("pi", "long"), source: "settings", capability: undefined });
        expect(capabilityFor(pin("pi", "long"), [harness("pi", [capability("pi", "capable")])])).toBeUndefined();
    });

    it("keeps the effective tier for the same runtime and uses backend-only fallbacks", () => {
        const harnesses = [harness("pi", [capability("pi", "capable"), capability("pi", "cheap")]), harness("codex", [capability("codex", "cheap"), capability("codex", "long")])];
        expect(routeForRuntime("pi", pin("pi", "cheap"), harnesses)).toEqual(pin("pi", "cheap"));
        expect(routeForRuntime("codex", pin("pi", "cheap"), harnesses)).toEqual(pin("codex", "cheap"));
        expect(routeForRuntime("codex", pin("pi", "capable"), harnesses)).toEqual(pin("codex", "cheap"));
    });

    it("normalizes legacy channel override routes before persistence", () => {
        expect(normalizeProfileOverrideRoute({ route: { runtime: "pi", tier: "" } })).toEqual({ route: pin("pi") });
    });

    it("builds picker rows exclusively from backend capabilities", () => {
        const items = routePickerItems([harness("pi", [capability("pi", "capable"), capability("pi", "cheap")]), harness("codex")]);
        expect(items).toEqual([{ runtime: "pi", label: "PI", capabilities: [capability("pi", "capable"), capability("pi", "cheap")] }]);
    });
});
