// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure view-model logic for a plain terminal's tree row: what its shell is running, read off the terminal's
// Resource Manager group (the job's process tree). No React, no Wave runtime imports. The process tree is the
// source because pwsh, the default shell here, reports no command or exit code through shell integration.

import { baseName } from "@/app/cockpit/resmon";

export type TerminalStatus = { running: false } | { running: true; command: string; ports: number[]; since: number };

const IMAGE_CONHOST = "conhost.exe";
const IMAGE_CMD = "cmd.exe";
const NODE_MODULES = "node_modules";
// node scripts whose package name is not the command people type
const NODE_SHIMS: Record<string, string> = {
    "npm-cli.js": "npm",
    "npx-cli.js": "npx",
    "pnpm.cjs": "pnpm",
    "yarn.js": "yarn",
};

// splits a command line into argv on whitespace, keeping double-quoted runs together
function argv(command: string): string[] {
    return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

function stripExe(name: string): string {
    return name.replace(/\.exe$/i, "");
}

// the name a node script runs as: a known shim, else its package under node_modules, else null
function nodeScriptName(script: string): string | null {
    const shim = NODE_SHIMS[baseName(script).toLowerCase()];
    if (shim) {
        return shim;
    }
    const parts = script.split(/[\\/]/);
    const at = parts.lastIndexOf(NODE_MODULES);
    if (at < 0 || at + 1 >= parts.length) {
        return null;
    }
    const pkg = parts[at + 1];
    return pkg.startsWith("@") && at + 2 < parts.length ? `${pkg}/${parts[at + 2]}` : pkg;
}

// the command as typed: image without its path and .exe, a node tool by its package name
export function commandLabel(row: ProcessInfo): string {
    const args = argv(row.command ?? "");
    const exe = stripExe(baseName(args[0] ?? row.name ?? ""));
    const rest = args.slice(1);
    if (exe.toLowerCase() === "node" && rest.length > 0) {
        const tool = nodeScriptName(rest[0]);
        if (tool) {
            return [tool, ...rest.slice(1)].join(" ");
        }
    }
    return [exe || stripExe(row.name ?? ""), ...rest].join(" ");
}

function isConhost(row: ProcessInfo): boolean {
    return (row.name ?? "").toLowerCase() === IMAGE_CONHOST;
}

// the end (exclusive) of rows[i]'s subtree in the pre-order rows
function subtreeEnd(rows: ProcessInfo[], i: number): number {
    let end = i + 1;
    while (end < rows.length && rows[end].depth > rows[i].depth) {
        end++;
    }
    return end;
}

// indexes of rows[i]'s direct children, the console host left out
function children(rows: ProcessInfo[], i: number): number[] {
    const out: number[] = [];
    const end = subtreeEnd(rows, i);
    for (let j = i + 1; j < end; j++) {
        if (rows[j].depth === rows[i].depth + 1 && !isConhost(rows[j])) {
            out.push(j);
        }
    }
    return out;
}

// a terminal's status from its group; null when there is no group to read (no sample yet, or unsupported).
// The foreground job is the shell's newest child; a cmd.exe wrapper (npm.cmd and the like) yields to its child.
export function terminalStatus(g: ResMonGroup | undefined): TerminalStatus | null {
    const rows = g?.rows ?? [];
    const shell = rows.findIndex((r) => r.tag === "shell");
    if (shell < 0) {
        return null;
    }
    const job = children(rows, shell).at(-1);
    if (job == null) {
        return { running: false };
    }
    let head = job;
    while ((rows[head].name ?? "").toLowerCase() === IMAGE_CMD && children(rows, head).length === 1) {
        head = children(rows, head)[0];
    }
    const tree = rows.slice(job, subtreeEnd(rows, job));
    const ports = [...new Set(tree.flatMap((r) => r.ports ?? []))].sort((a, b) => a - b);
    return { running: true, command: commandLabel(rows[head]), ports, since: rows[job].createts ?? 0 };
}
