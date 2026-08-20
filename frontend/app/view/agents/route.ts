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

export function normalizeLegacyRoute(runtime: string, tier?: string): RoutePin | null {
    if (!runtime) {
        return null;
    }
    return { runtime, tier: tier || "capable" };
}

export function capabilityFor(pin: RoutePin, harnesses: HarnessInfo[]): RouteCapability | undefined {
    return harnesses
        .flatMap((h) => h.routecapabilities ?? [])
        .find((capability) => capability.runtime === pin.runtime && capability.tier === pin.tier);
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
        const pin = normalizeLegacyRoute(raw.runtime, raw.tier);
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
