// frontend/util/paths.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { joinRepoPath } from "./paths";

describe("joinRepoPath", () => {
    it("joins a forward-slashed git path onto a backslashed Windows root", () => {
        expect(joinRepoPath("C:\\repo", "src/main.ts")).toBe("C:\\repo\\src\\main.ts");
    });

    it("normalizes a mixed-separator join to a single separator style", () => {
        expect(joinRepoPath("C:/repo", "src/main.ts")).toBe("C:\\repo\\src\\main.ts");
    });

    it("handles a root-level file", () => {
        expect(joinRepoPath("C:\\repo", "README.md")).toBe("C:\\repo\\README.md");
    });

    it("does not choke on a trailing separator on the root", () => {
        expect(joinRepoPath("C:\\repo\\", "a.ts")).toBe("C:\\repo\\a.ts");
    });
});
