// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { changesLabel, overviewTarget } from "./projectoverviewmodel";

describe("changesLabel", () => {
    it("says nothing before the repo is read", () => {
        expect(changesLabel(null)).toBe("");
    });
    it("names a clean checkout", () => {
        expect(changesLabel({ files: 0 })).toBe("no uncommitted changes");
    });
    it("counts changed files, singular and plural", () => {
        expect(changesLabel({ files: 1 })).toBe("1 file");
        expect(changesLabel({ files: 3 })).toBe("3 files");
    });
});

describe("overviewTarget", () => {
    it("has no target with every project in scope", () => {
        expect(overviewTarget("all")).toBeNull();
        expect(overviewTarget("")).toBeNull();
    });
    it("targets the scoped project", () => {
        expect(overviewTarget("waveterm")).toBe("waveterm");
    });
});
