// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type Runtime = "claude" | "codex" | "antigravity" | "terminal";

const RUNTIME_CMD: Record<Runtime, string> = {
    claude: "claude",
    codex: "codex",
    antigravity: "antigravity",
    terminal: "",
};

export function runtimeStartupCommand(runtime: Runtime): string {
    return RUNTIME_CMD[runtime] ?? "";
}

export function runtimeLaunchLabel(runtime: Runtime): string {
    return runtime === "terminal" ? "Open terminal" : "Launch agent";
}

export function runtimeShowsTask(runtime: Runtime): boolean {
    return runtime !== "terminal";
}

export interface LaunchMetaSpec {
    runtime: Runtime;
    startupCommand: string; // resolved command (defaults to the runtime cmd; user-editable)
    task: string;
    cwd: string;
}

// Build the CreateBlock meta. Terminal -> default shell block. Agent runtimes -> cmd block with the
// task passed as a single positional arg (arg array avoids all shell-quoting issues). The startup
// command is tokenized on whitespace (best-effort if the user adds flags).
export function buildLaunchMeta(spec: LaunchMetaSpec): Record<string, unknown> {
    if (spec.runtime === "terminal") {
        const meta: Record<string, unknown> = { view: "term", controller: "shell" };
        if (spec.cwd) {
            meta["cmd:cwd"] = spec.cwd;
        }
        return meta;
    }
    const tokens = spec.startupCommand.trim().split(/\s+/).filter(Boolean);
    const cmd = tokens[0] ?? "claude";
    const args = tokens.slice(1);
    const task = spec.task.trim();
    if (task) {
        args.push(task);
    }
    const meta: Record<string, unknown> = {
        view: "term",
        controller: "cmd",
        cmd,
        "cmd:args": args,
        "cmd:shell": false,
    };
    if (spec.cwd) {
        meta["cmd:cwd"] = spec.cwd;
    }
    return meta;
}
