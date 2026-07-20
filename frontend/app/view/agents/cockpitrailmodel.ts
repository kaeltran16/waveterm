// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure glue for the cockpit right rail (CockpitRail / UsageBar). Extracted so the rail's
// provider gating + usage-bar visibility are unit-testable without rendering.

import type { WindowTokens } from "./windowtokenstore";

// provider identity for the plan strip. not theme tokens — brand colors, single source.
const PROVIDER_DOT: Record<string, string> = { claude: "bg-provider-claude", codex: "bg-provider-codex" };
const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };

export function providerLabel(provider: string): string {
    return PROVIDER_LABEL[provider] ?? provider;
}

export function providerDot(provider: string): string {
    return PROVIDER_DOT[provider] ?? "bg-muted";
}

// real used-token sum is claude-only (windowtokenstore); other providers report no token line.
export function windowUsedTokens(
    provider: string,
    windowTokens: WindowTokens | null,
    window: "fivehour" | "week"
): number | undefined {
    return provider === "claude" ? windowTokens?.[window] : undefined;
}

// a null pct (api-key auth or a window not yet reported) renders no bar.
export function usageBarVisible(pct: number | undefined): boolean {
    return pct != null;
}

export function usageBarShowsMeta(used: number | undefined, reset: number | undefined): boolean {
    return used != null || !!reset;
}
