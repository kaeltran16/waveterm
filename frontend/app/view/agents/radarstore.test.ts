// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { pickInitialScope, resolveScope, type RadarScope } from "./radarstore";

const projects = { "payments-api": { path: "/repos/payments-api" } } as Record<string, ProjectKeywords>;

describe("resolveScope", () => {
    it("resolves a registered project name to name+path", () => {
        expect(resolveScope("payments-api", projects)).toEqual({ name: "payments-api", path: "/repos/payments-api" });
    });
    it("returns null for the all filter", () => {
        expect(resolveScope("all", projects)).toBeNull();
    });
    it("returns null for an unregistered name", () => {
        expect(resolveScope("nope", projects)).toBeNull();
    });
    it("returns null for a project with no path", () => {
        expect(resolveScope("x", { x: {} } as Record<string, ProjectKeywords>)).toBeNull();
    });
});

describe("pickInitialScope", () => {
    const owned: RadarScope = { name: "payments-api", path: "/repos/payments-api" };

    it("keeps an already-owned scope (a remount must not re-derive and wipe it)", () => {
        // regression: navigating away and back remounts RadarSurface; the owned scope must survive.
        expect(pickInitialScope(owned, null, "all", projects)).toEqual({ action: "keep" });
    });
    it("restores the persisted project over the global filter", () => {
        expect(pickInitialScope(null, "payments-api", "all", projects)).toEqual({ action: "set", scope: owned });
    });
    it("falls back to the global project filter when nothing is persisted", () => {
        expect(pickInitialScope(null, null, "payments-api", projects)).toEqual({ action: "set", scope: owned });
    });
    it("sets a null scope when nothing is persisted and the filter is all", () => {
        expect(pickInitialScope(null, null, "all", projects)).toEqual({ action: "set", scope: null });
    });
    it("waits when a desired project can't be resolved yet (registry not loaded / project gone)", () => {
        expect(pickInitialScope(null, "payments-api", "all", {})).toEqual({ action: "wait" });
    });
});
