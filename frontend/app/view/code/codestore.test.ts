// frontend/app/view/code/codestore.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { canRestoreProject } from "./codestore";

const registry = {
    alpha: { path: "C:\\repos\\alpha" },
    beta: { path: "/home/u/beta" },
} as Record<string, ProjectKeywords>;

describe("canRestoreProject", () => {
    it("rejects when nothing was stored", () => {
        expect(canRestoreProject(null, registry)).toBe(false);
    });

    it("restores a project still in the registry", () => {
        expect(canRestoreProject({ name: "alpha", path: "C:\\repos\\alpha" }, registry)).toBe(true);
    });

    it("ignores separator and case differences in the path", () => {
        expect(canRestoreProject({ name: "alpha", path: "c:/repos/ALPHA" }, registry)).toBe(true);
    });

    it("rejects a project the registry no longer knows", () => {
        expect(canRestoreProject({ name: "gone", path: "C:\\repos\\gone" }, registry)).toBe(false);
    });

    it("rejects while the registry has not loaded yet", () => {
        expect(canRestoreProject({ name: "alpha", path: "C:\\repos\\alpha" }, {})).toBe(false);
    });
});
