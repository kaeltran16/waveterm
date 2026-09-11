import { describe, expect, it } from "vitest";
import {
    buildPickerSections,
    capabilityFor,
    filterPickerSections,
    modelFace,
    normalizeLegacyRoute,
    normalizeProfileOverrideRoute,
    resolveEffectiveRoute,
    routeForRuntime,
    routePickerItems,
    scopePickerSections,
} from "./route";

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

    it("keeps a model pin when the runtime is unchanged", () => {
        const harnesses = [harness("pi", [capability("pi", "capable")]), harness("codex", [capability("codex", "capable")])];
        const model: RoutePin = { runtime: "pi", tier: "", model: "opencode/deepseek-v4-pro" };
        expect(routeForRuntime("pi", model, harnesses)).toEqual(model);
        // switching harness cannot carry the old harness's model id into the new namespace
        expect(routeForRuntime("codex", model, harnesses)).toEqual(pin("codex"));
    });

    it("normalizes legacy channel override routes before persistence", () => {
        expect(normalizeProfileOverrideRoute({ route: { runtime: "pi", tier: "" } })).toEqual({ route: pin("pi") });
    });

    it("builds picker rows exclusively from backend capabilities", () => {
        const items = routePickerItems([harness("pi", [capability("pi", "capable"), capability("pi", "cheap")]), harness("codex")]);
        expect(items).toEqual([{ runtime: "pi", label: "PI", capabilities: [capability("pi", "capable"), capability("pi", "cheap")] }]);
    });
});

const cap = (
    runtime: string,
    model: string,
    extra: { provider?: string; contexthint?: string; default?: boolean } = {}
): RouteCapabilityInfo => ({
    runtime,
    model,
    resolvedmodel: model,
    provider: extra.provider ?? "",
    contexthint: extra.contexthint ?? "",
    default: extra.default ?? false,
});

const flatHarnesses: HarnessInfo[] = [
    harness("pi", [
        capability("pi", "capable", "deepseek-v4-pro"), // legacy tier row
        cap("pi", "opencode/deepseek-v4-flash", { provider: "opencode", contexthint: "1M" }),
        cap("pi", "opencode/deepseek-v4-pro", { provider: "opencode", contexthint: "1M" }),
    ]),
    harness("claude", [cap("claude", "opus", { default: true }), cap("claude", "sonnet"), cap("claude", "haiku")]),
];

describe("model-keyed capability lookup", () => {
    it("matches a model pin exactly and ignores legacy tier rows", () => {
        const c = capabilityFor({ runtime: "pi", tier: "", model: "opencode/deepseek-v4-flash" }, flatHarnesses);
        expect(c?.model).toBe("opencode/deepseek-v4-flash");
        expect(c?.provider).toBe("opencode");
    });

    it("falls back to the legacy tier row for pins without a model", () => {
        const c = capabilityFor({ runtime: "pi", tier: "capable" }, flatHarnesses);
        expect(c?.tier).toBe("capable");
        expect(c?.resolvedmodel).toBe("deepseek-v4-pro");
    });

    it("preserves the model through effective-route normalization", () => {
        const eff = resolveEffectiveRoute({ settings: { runtime: "pi", tier: "", model: "opencode/deepseek-v4-pro" }, harnesses: flatHarnesses });
        expect(eff?.pin.model).toBe("opencode/deepseek-v4-pro");
        expect(eff?.capability?.provider).toBe("opencode");
    });
});

describe("picker sections", () => {
    it("builds model-only rows grouped by runtime, excluding legacy tier rows", () => {
        const sections = buildPickerSections(flatHarnesses);
        expect(sections.map((s) => s.runtime)).toEqual(["pi", "claude"]);
        expect(sections[0].rows.map((r) => r.model)).toEqual(["opencode/deepseek-v4-flash", "opencode/deepseek-v4-pro"]);
        expect(sections[0].rows.every((r) => r.label === "PI")).toBe(true);
        expect(sections[1].rows.find((r) => r.model === "opus")?.default).toBe(true);
    });

    it("omits runtimes with no model capabilities at all", () => {
        const onlyLegacy = [harness("pi", [capability("pi", "capable", "deepseek-v4-pro")])];
        expect(buildPickerSections(onlyLegacy)).toEqual([]);
    });

    it("filters by model and provider, case-insensitive", () => {
        const sections = buildPickerSections(flatHarnesses);
        const byModel = filterPickerSections(sections, "deepseek-v4-flash");
        expect(byModel.flatMap((s) => s.rows.map((r) => r.model))).toEqual(["opencode/deepseek-v4-flash"]);
        const byProvider = filterPickerSections(sections, "OPENCODE");
        expect(byProvider.flatMap((s) => s.rows.map((r) => r.provider))).toEqual(["opencode", "opencode"]);
        expect(filterPickerSections(sections, "").flatMap((s) => s.rows)).toHaveLength(5);
    });

    it("scopes to one harness, and ignores a scope the query has emptied", () => {
        const sections = buildPickerSections(flatHarnesses);
        expect(scopePickerSections(sections, null).map((s) => s.runtime)).toEqual(["pi", "claude"]);
        expect(scopePickerSections(sections, "claude").map((s) => s.runtime)).toEqual(["claude"]);
        const onlyPi = filterPickerSections(sections, "deepseek");
        expect(scopePickerSections(onlyPi, "claude").map((s) => s.runtime)).toEqual(["pi"]);
    });

    it("modelFace returns model when set, tier otherwise", () => {
        expect(modelFace({ runtime: "pi", tier: "", model: "opencode/deepseek-v4-pro" })).toBe("opencode/deepseek-v4-pro");
        expect(modelFace({ runtime: "claude", tier: "capable" })).toBe("capable");
    });
});
