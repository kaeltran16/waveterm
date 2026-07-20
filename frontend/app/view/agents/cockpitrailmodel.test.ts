// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    providerDot,
    providerLabel,
    usageBarShowsMeta,
    usageBarVisible,
    windowUsedTokens,
} from "./cockpitrailmodel";
import type { WindowTokens } from "./windowtokenstore";

describe("providerLabel", () => {
    it("maps known providers to display names", () => {
        expect(providerLabel("claude")).toBe("Claude");
        expect(providerLabel("codex")).toBe("Codex");
    });
    it("falls back to the raw provider id when unknown", () => {
        expect(providerLabel("gemini")).toBe("gemini");
    });
});

describe("providerDot", () => {
    it("maps known providers to their brand dot class", () => {
        expect(providerDot("claude")).toBe("bg-provider-claude");
        expect(providerDot("codex")).toBe("bg-provider-codex");
    });
    it("falls back to bg-muted when unknown", () => {
        expect(providerDot("gemini")).toBe("bg-muted");
    });
});

describe("windowUsedTokens", () => {
    const wt: WindowTokens = { fivehour: 1200, week: 34000 };
    it("returns the window's claude token sum for the claude provider", () => {
        expect(windowUsedTokens("claude", wt, "fivehour")).toBe(1200);
        expect(windowUsedTokens("claude", wt, "week")).toBe(34000);
    });
    it("is undefined for non-claude providers (token sums are claude-only)", () => {
        expect(windowUsedTokens("codex", wt, "fivehour")).toBeUndefined();
    });
    it("is undefined when windowTokens is null", () => {
        expect(windowUsedTokens("claude", null, "fivehour")).toBeUndefined();
    });
});

describe("usageBarVisible", () => {
    it("is false when pct is null/undefined (api-key auth or unreported)", () => {
        expect(usageBarVisible(undefined)).toBe(false);
        expect(usageBarVisible(null as unknown as undefined)).toBe(false);
    });
    it("is true for any numeric pct including 0", () => {
        expect(usageBarVisible(0)).toBe(true);
        expect(usageBarVisible(73)).toBe(true);
    });
});

describe("usageBarShowsMeta", () => {
    it("shows the meta line when there are used tokens or a reset", () => {
        expect(usageBarShowsMeta(1200, undefined)).toBe(true);
        expect(usageBarShowsMeta(undefined, 1699999999)).toBe(true);
        expect(usageBarShowsMeta(0, undefined)).toBe(true);
    });
    it("hides the meta line when there are neither", () => {
        expect(usageBarShowsMeta(undefined, undefined)).toBe(false);
        expect(usageBarShowsMeta(undefined, 0)).toBe(false);
    });
});
