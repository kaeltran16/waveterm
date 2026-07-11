// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { resolveScope } from "./radarstore";

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
