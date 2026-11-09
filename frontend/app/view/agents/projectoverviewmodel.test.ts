// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { changesLabel, samePath } from "./projectoverviewmodel";

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

describe("samePath", () => {
    it("matches one folder spelled with other slashes, case and a trailing slash", () => {
        expect(samePath("C:\\Repo\\X\\", "c:/repo/x")).toBe(true);
    });
    it("does not match a sibling that shares a prefix", () => {
        expect(samePath("C:\\Repo\\X", "C:\\Repo\\Xy")).toBe(false);
    });
    it("never matches an empty side", () => {
        expect(samePath("", "")).toBe(false);
        expect(samePath("C:\\Repo\\X", "")).toBe(false);
    });
});
