// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildLaunchMeta, runtimeLaunchLabel, runtimeShowsTask, runtimeStartupCommand } from "./launch";

describe("runtime helpers", () => {
    it("derives the startup command", () => {
        expect(runtimeStartupCommand("claude")).toBe("claude");
        expect(runtimeStartupCommand("codex")).toBe("codex");
        expect(runtimeStartupCommand("terminal")).toBe("");
    });
    it("labels the launch button", () => {
        expect(runtimeLaunchLabel("claude")).toBe("Launch agent");
        expect(runtimeLaunchLabel("terminal")).toBe("Open terminal");
    });
    it("hides the task field for terminal", () => {
        expect(runtimeShowsTask("claude")).toBe(true);
        expect(runtimeShowsTask("terminal")).toBe(false);
    });
});

describe("buildLaunchMeta", () => {
    it("passes the task as a positional arg with cwd", () => {
        const m = buildLaunchMeta({ runtime: "claude", startupCommand: "claude", task: "fix the bug", cwd: "/code/x" });
        expect(m).toMatchObject({
            view: "term",
            controller: "cmd",
            cmd: "claude",
            "cmd:args": ["fix the bug"],
            "cmd:shell": false,
            "cmd:cwd": "/code/x",
        });
    });
    it("tokenizes a custom startup command with flags", () => {
        const m = buildLaunchMeta({ runtime: "claude", startupCommand: "claude --model opus", task: "go", cwd: "/x" });
        expect(m["cmd:args"]).toEqual(["--model", "opus", "go"]);
    });
    it("omits args when there is no task", () => {
        const m = buildLaunchMeta({ runtime: "claude", startupCommand: "claude", task: "  ", cwd: "/x" });
        expect(m["cmd:args"]).toEqual([]);
    });
    it("terminal is a shell block with no task", () => {
        const m = buildLaunchMeta({ runtime: "terminal", startupCommand: "", task: "", cwd: "/x" });
        expect(m).toEqual({ view: "term", controller: "shell", "cmd:cwd": "/x" });
    });
});
