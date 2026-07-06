// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { diffNavIntent } from "./agentdiffnav";

describe("diffNavIntent", () => {
    it("opens Diff for the agent and selects a file when cwd and path are known", () => {
        expect(diffNavIntent("agent-1", "C:/repo", "src/app.ts")).toEqual({
            focusId: "agent-1",
            surface: "files",
            select: { cwd: "C:/repo", path: "src/app.ts" },
        });
    });

    it("opens Diff without file selection when the caller only wants the full file list", () => {
        expect(diffNavIntent("agent-1", "C:/repo")).toEqual({
            focusId: "agent-1",
            surface: "files",
            select: null,
        });
    });

    it("does not select a file when cwd is missing", () => {
        expect(diffNavIntent("agent-1", null, "src/app.ts")).toEqual({
            focusId: "agent-1",
            surface: "files",
            select: null,
        });
    });
});
