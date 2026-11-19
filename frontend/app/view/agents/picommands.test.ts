// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { PI_BUILTIN_COMMANDS } from "./picommands";

// pi 1.5.2's BUILTIN_SLASH_COMMANDS, in its order
const PI_1_5_2 = [
    "settings",
    "model",
    "tree",
    "thinking",
    "scoped-models",
    "export",
    "import",
    "share",
    "bug",
    "copy",
    "name",
    "session",
    "changelog",
    "hotkeys",
    "fork",
    "clone",
    "trust",
    "login",
    "logout",
    "new",
    "compact",
    "resume",
    "reload",
    "quit",
];

describe("PI_BUILTIN_COMMANDS", () => {
    it("lists pi's built-ins in pi's order, each a built-in with pi's own description", () => {
        expect(PI_BUILTIN_COMMANDS.map((c) => c.name)).toEqual(PI_1_5_2);
        for (const c of PI_BUILTIN_COMMANDS) {
            expect(c.source).toBe("builtin");
            expect(c.description).toBeTruthy();
        }
        const desc = (name: string) => PI_BUILTIN_COMMANDS.find((c) => c.name === name)?.description;
        expect(desc("settings")).toBe("Open settings menu");
        expect(desc("model")).toBe("Select model (opens selector UI)");
        expect(desc("quit")).toBe("Quit pi");
    });
    it("has no command pi lacks", () => {
        expect(PI_BUILTIN_COMMANDS.map((c) => c.name)).not.toContain("mcp");
    });
});
