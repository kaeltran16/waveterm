// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    buildLaunchMeta,
    composeStartupCommand,
    deriveBranch,
    RUNTIME_FLAGS,
    runtimeLaunchLabel,
    runtimeCreatesAgentPanel,
    runtimeShowsTask,
    runtimeStartupCommand,
    runtimeSupportsWorktree,
    worktreeOutcome,
} from "./launch";

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
    it("creates pending agent panels for agent runtimes only", () => {
        expect(runtimeCreatesAgentPanel("claude")).toBe(true);
        expect(runtimeCreatesAgentPanel("codex")).toBe(true);
        expect(runtimeCreatesAgentPanel("antigravity")).toBe(true);
        expect(runtimeCreatesAgentPanel("terminal")).toBe(false);
    });
    it("supports worktrees for every runtime except terminal", () => {
        expect(runtimeSupportsWorktree("claude")).toBe(true);
        expect(runtimeSupportsWorktree("codex")).toBe(true);
        expect(runtimeSupportsWorktree("antigravity")).toBe(true);
        expect(runtimeSupportsWorktree("terminal")).toBe(false);
    });
});

describe("deriveBranch", () => {
    it("appends -agent when there is no collision", () => {
        expect(deriveBranch("main", [])).toBe("main-agent");
        expect(deriveBranch("main", ["main"])).toBe("main-agent");
    });
    it("bumps a numeric suffix on collision", () => {
        expect(deriveBranch("main", ["main", "main-agent"])).toBe("main-agent-2");
        expect(deriveBranch("main", ["main", "main-agent", "main-agent-2"])).toBe("main-agent-3");
    });
});

describe("worktreeOutcome", () => {
    it("prompts when the branch is empty", () => {
        expect(worktreeOutcome({ branch: "", currentBranch: "main", branchNames: ["main"] })).toBe(
            "Enter a branch name"
        );
    });
    it("derives a fresh branch off the current (checked-out) branch", () => {
        expect(worktreeOutcome({ branch: "main", currentBranch: "main", branchNames: ["main"] })).toBe(
            "Creates new branch main-agent off main"
        );
    });
    it("checks out an existing non-current branch", () => {
        expect(
            worktreeOutcome({ branch: "feat/x", currentBranch: "main", branchNames: ["main", "feat/x"] })
        ).toBe("Checks out existing branch feat/x in a worktree");
    });
    it("creates a new branch for an unknown name", () => {
        expect(worktreeOutcome({ branch: "feat/new", currentBranch: "main", branchNames: ["main"] })).toBe(
            "Creates new branch feat/new off current HEAD"
        );
    });
});

describe("composeStartupCommand", () => {
    it("returns the base untouched when no flags are enabled", () => {
        expect(composeStartupCommand("claude", "claude", {})).toBe("claude");
    });
    it("appends enabled flags in catalog order", () => {
        expect(composeStartupCommand("claude", "claude", { verbose: true, "skip-permissions": true })).toBe(
            "claude --dangerously-skip-permissions --verbose"
        );
    });
    it("maps a shared flag id to the runtime's own flag string", () => {
        expect(composeStartupCommand("codex", "codex", { "skip-permissions": true })).toBe(
            "codex --dangerously-bypass-approvals"
        );
    });
    it("does not duplicate a flag already typed into the base", () => {
        expect(composeStartupCommand("claude --verbose", "claude", { verbose: true })).toBe("claude --verbose");
    });
    it("ignores flags outside the runtime's catalog", () => {
        expect(composeStartupCommand("codex", "codex", { verbose: true })).toBe("codex");
    });
    it("terminal has no flags", () => {
        expect(RUNTIME_FLAGS.terminal).toEqual([]);
        expect(composeStartupCommand("", "terminal", { verbose: true })).toBe("");
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
