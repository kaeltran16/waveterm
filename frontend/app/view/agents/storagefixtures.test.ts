// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { STORAGE_SCENARIOS, storageScenarios } from "./storagefixtures";

const NOW = new Date(2026, 9, 14, 9, 40).getTime();

describe("storage fixtures", () => {
    it("has every scenario the DEV mock loads", () => {
        expect(Object.keys(STORAGE_SCENARIOS).sort()).toEqual(
            ["clean", "cleared", "clearing", "error", "scanning", "storage"].sort()
        );
    });
    it("gives every row a unique id that does not move with the clock", () => {
        const a = storageScenarios(NOW).storage.items.map((it) => it.id);
        const b = storageScenarios(NOW + 86_400_000).storage.items.map((it) => it.id);
        expect(a).toHaveLength(19);
        expect(new Set(a).size).toBe(a.length);
        expect(b).toEqual(a);
    });
    it("carries the skipped checkout's tip and its two unique commits", () => {
        const skipped = storageScenarios(NOW).storage.items.find((it) =>
            it.path?.endsWith("9e473bf8-e50f-48e2-9a4d-bfb1b79dddcc")
        );
        expect(skipped.branchtip).toMatch(/^[0-9a-f]{40}$/);
        expect(skipped.onlycommits.map((c) => c.sha)).toEqual(["ad962fe1", "01a08218"]);
    });
    it("gives run rows a run id, with dca34385 executing", () => {
        const items = storageScenarios(NOW).storage.items;
        const runRows = items.filter((it) => it.runtitle);
        expect(runRows.length).toBeGreaterThan(0);
        expect(runRows.every((it) => it.runid)).toBe(true);
        expect(items.find((it) => it.runid?.startsWith("dca34385")).runstatus).toBe("executing");
    });
});
