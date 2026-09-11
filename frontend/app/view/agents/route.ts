// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure route selection and backend-capability presentation. The backend is the sole source of valid
// runtime/tier pairs; capable is only a legacy normalization for settings and older task records.

export type RouteSource = "task" | "run" | "channel" | "settings";
export type RouteCapability = NonNullable<HarnessInfo["routecapabilities"]>[number];
export type EffectiveRoute = {
    pin: RoutePin;
    source: RouteSource;
    capability?: RouteCapability;
};

export interface RoutePickerSection {
    runtime: string;
    label: string;
    capabilities: RouteCapability[];
}

export function normalizeLegacyRoute(runtime: string, tier?: string, model?: string): RoutePin | null {
    if (!runtime) {
        return null;
    }
    return { runtime, tier: tier || "capable", ...(model ? { model } : {}) };
}

export function capabilityFor(pin: RoutePin | null | undefined, harnesses: HarnessInfo[]): RouteCapability | undefined {
    if (pin == null) {
        return undefined;
    }
    const caps = harnesses.flatMap((h) => h.routecapabilities ?? []);
    if (pin.model) {
        const byModel = caps.find((c) => c.runtime === pin.runtime && c.model === pin.model);
        if (byModel != null) {
            return byModel;
        }
    }
    // legacy tier fallback: persisted pins without a model still render their resolved tier model
    return caps.find((c) => c.runtime === pin.runtime && (c.tier ?? "") !== "" && c.tier === (pin.tier || "capable"));
}

export function resolveEffectiveRoute(input: {
    settings: RoutePin | null;
    channel?: RoutePin | null;
    run?: RoutePin | null;
    task?: RoutePin | null;
    harnesses: HarnessInfo[];
}): EffectiveRoute | null {
    const candidates: [RouteSource, RoutePin | null | undefined][] = [
        ["task", input.task],
        ["run", input.run],
        ["channel", input.channel],
        ["settings", input.settings],
    ];
    for (const [source, raw] of candidates) {
        if (raw == null) {
            continue;
        }
        const pin = normalizeLegacyRoute(raw.runtime, raw.tier, raw.model);
        if (pin != null) {
            return { pin, source, capability: capabilityFor(pin, input.harnesses) };
        }
    }
    return null;
}

export function routeForRuntime(
    runtime: string,
    effective: RoutePin | null | undefined,
    harnesses: HarnessInfo[]
): RoutePin | undefined {
    const harness = harnesses.find((h) => h.runtime === runtime);
    const capabilities = harness?.routecapabilities ?? [];
    if (capabilities.length === 0) {
        return undefined;
    }
    // a model pin survives a no-op runtime switch; model ids are per-harness namespaces, so one can
    // never be carried across harnesses
    if (effective?.runtime === runtime && effective.model) {
        return effective;
    }
    const normalized = effective == null ? null : normalizeLegacyRoute(effective.runtime, effective.tier);
    const selected = normalized?.runtime === runtime ? normalized : undefined;
    if (selected != null && capabilityFor(selected, harnesses) != null) {
        return selected;
    }
    const sameTier = normalized == null ? undefined : capabilities.find((c) => c.tier === normalized.tier);
    const capable = capabilities.find((c) => c.tier === "capable");
    const choice = sameTier ?? capable ?? capabilities[0];
    return { runtime: choice.runtime, tier: choice.tier };
}

export function normalizeProfileOverrideRoute(override: ProfileOverride): ProfileOverride {
    if (override.route == null) {
        return override;
    }
    const route = normalizeLegacyRoute(override.route.runtime, override.route.tier);
    return route == null ? { ...override, route: undefined } : { ...override, route };
}

export function routePickerItems(harnesses: HarnessInfo[]): RoutePickerSection[] {
    return harnesses
        .filter((h) => (h.routecapabilities ?? []).length > 0)
        .map((h) => ({ runtime: h.runtime, label: h.label, capabilities: h.routecapabilities ?? [] }));
}

export interface PickerModelRow {
    runtime: string;
    model: string;
    provider: string;
    contexthint: string;
    default: boolean;
    label: string;
}

export interface PickerSection {
    runtime: string;
    label: string;
    rows: PickerModelRow[];
}

// model-only rows for the picker; legacy tier capabilities never become rows ("flat model list").
export function buildPickerSections(harnesses: HarnessInfo[]): PickerSection[] {
    return harnesses
        .map((h) => ({
            runtime: h.runtime,
            label: h.label,
            rows: (h.routecapabilities ?? [])
                .filter((c) => (c.model ?? "") !== "")
                .map((c) => ({
                    runtime: c.runtime,
                    model: c.model!,
                    provider: c.provider ?? "",
                    contexthint: c.contexthint ?? "",
                    default: c.default ?? false,
                    label: h.label,
                })),
        }))
        .filter((s) => s.rows.length > 0);
}

export function filterPickerSections(sections: PickerSection[], query: string): PickerSection[] {
    const q = query.trim().toLowerCase();
    if (q === "") {
        return sections;
    }
    return sections
        .map((s) => ({ ...s, rows: s.rows.filter((r) => r.model.toLowerCase().includes(q) || r.provider.toLowerCase().includes(q)) }))
        .filter((s) => s.rows.length > 0);
}

// Which harness the picker is showing. The catalog is lopsided — one harness can enumerate several
// hundred models while another has three — so a single flat list buries every other harness that many
// rows down a scroller. Scoping by harness is what keeps them reachable without a scroll marathon.
export function scopePickerSections(sections: PickerSection[], runtime: string | null): PickerSection[] {
    if (runtime == null) {
        return sections;
    }
    const scoped = sections.filter((s) => s.runtime === runtime);
    // a scope the query has already emptied is not worth honouring: it would report no matches for a
    // model that does exist, just under a different harness
    return scoped.length > 0 ? scoped : sections;
}

// displayed id on the picker face / graph route line
export function modelFace(pin: RoutePin): string {
    return pin.model ?? pin.tier ?? "capable";
}

export function pickerTitleFor(customTitle?: string): string {
    const t = customTitle?.trim();
    return t ? t : "Run route";
}
