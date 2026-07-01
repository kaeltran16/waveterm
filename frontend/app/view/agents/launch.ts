// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type Runtime = "claude" | "codex" | "antigravity" | "terminal";

const RUNTIME_CMD: Record<Runtime, string> = {
    claude: "claude",
    codex: "codex",
    antigravity: "agy",
    terminal: "",
};

export function runtimeStartupCommand(runtime: Runtime): string {
    return RUNTIME_CMD[runtime] ?? "";
}

export interface FlagDef {
    id: string; // stable key (shared across runtimes, e.g. "skip-permissions")
    flag: string; // the CLI token appended to the startup command
    desc: string; // one-line explanation shown in the flag menu
}

// Per-runtime launch-flag catalog (ports flagDefs from Wave-cockpit-live.dc.html). Terminal takes
// no flags. Ids are intentionally shared where the concept matches (e.g. "skip-permissions" maps to
// --dangerously-skip-permissions on claude and --dangerously-bypass-approvals on codex).
export const RUNTIME_FLAGS: Record<Runtime, FlagDef[]> = {
    claude: [
        { id: "skip-permissions", flag: "--dangerously-skip-permissions", desc: "Bypass all permission prompts" },
        { id: "verbose", flag: "--verbose", desc: "Stream every tool call" },
        { id: "continue", flag: "--continue", desc: "Resume the last session" },
        { id: "print", flag: "--print", desc: "Non-interactive: print and exit" },
        { id: "ide", flag: "--ide", desc: "Auto-connect to the IDE extension" },
        { id: "debug", flag: "--debug", desc: "Emit debug diagnostics" },
        { id: "no-color", flag: "--no-color", desc: "Disable ANSI colors" },
    ],
    codex: [
        { id: "full-auto", flag: "--full-auto", desc: "Run without approval gates" },
        { id: "skip-permissions", flag: "--dangerously-bypass-approvals", desc: "Skip approval prompts" },
        { id: "quiet", flag: "--quiet", desc: "Hide reasoning logs" },
        { id: "search", flag: "--search", desc: "Enable web search" },
        { id: "json", flag: "--json", desc: "Machine-readable output" },
    ],
    antigravity: [
        { id: "yolo", flag: "--yolo", desc: "Auto-approve file edits" },
        { id: "verbose", flag: "--verbose", desc: "Stream every tool call" },
        { id: "no-telemetry", flag: "--no-telemetry", desc: "Disable usage reporting" },
    ],
    terminal: [],
};

// Append the runtime's enabled flags to the base startup command, skipping any flag the user already
// typed into the base (so toggling a flag that's also hand-written doesn't duplicate it). Preserves
// catalog order. buildLaunchMeta then tokenizes the result into cmd + args.
export function composeStartupCommand(base: string, runtime: Runtime, enabled: Record<string, boolean>): string {
    const trimmed = base.trim();
    const present = new Set(trimmed.split(/\s+/).filter(Boolean));
    const flags = RUNTIME_FLAGS[runtime].filter((f) => enabled[f.id] && !present.has(f.flag)).map((f) => f.flag);
    return [trimmed, ...flags].join(" ").trim();
}

export function runtimeLaunchLabel(runtime: Runtime): string {
    return runtime === "terminal" ? "Open terminal" : "Launch agent";
}

export function runtimeShowsTask(runtime: Runtime): boolean {
    return runtime !== "terminal";
}

export function runtimeCreatesAgentPanel(runtime: Runtime): boolean {
    return runtime !== "terminal";
}

// Worktrees only make sense for the agent runtimes; a terminal launches in the project dir.
export function runtimeSupportsWorktree(runtime: Runtime): boolean {
    return runtime !== "terminal";
}

// A fresh, non-colliding branch name off base (git refuses a worktree on an already-checked-out
// branch). "<base>-agent", bumping "-agent-2", "-3"… past names already in the repo.
export function deriveBranch(base: string, existing: string[]): string {
    const candidate = `${base}-agent`;
    if (!existing.includes(candidate)) {
        return candidate;
    }
    let n = 2;
    while (existing.includes(`${candidate}-${n}`)) {
        n++;
    }
    return `${candidate}-${n}`;
}

// One-line preview of what launching a worktree on `branch` will do, so the choice is never silent.
export function worktreeOutcome(args: { branch: string; currentBranch: string; branchNames: string[] }): string {
    const branch = args.branch.trim();
    if (!branch) {
        return "Enter a branch name";
    }
    if (branch === args.currentBranch) {
        return `Creates new branch ${deriveBranch(branch, args.branchNames)} off ${args.currentBranch}`;
    }
    if (args.branchNames.includes(branch)) {
        return `Checks out existing branch ${branch} in a worktree`;
    }
    return `Creates new branch ${branch} off current HEAD`;
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
        // force WAVETERM_JWT into the agent's env. cmd/shell:false runs the agent non-interactively,
        // so Wave's shell-integration bootstrap (which exchanges the swap token for the real JWT)
        // never runs; without this the agent inherits a stale/absent ambient JWT and the external
        // status reporter's `wsh` routes agent:status to the wrong wavesrv (e.g. a coexisting Wave
        // install) instead of this one — leaving the cockpit roster empty.
        "cmd:jwt": true,
    };
    if (spec.cwd) {
        meta["cmd:cwd"] = spec.cwd;
    }
    return meta;
}
