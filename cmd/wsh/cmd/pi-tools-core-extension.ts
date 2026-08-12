// Pure helpers for the waveterm tools + steering extension. No external imports so the repo's
// vitest can cover it. The default export is a no-op: pi auto-loads every file in the extensions
// directory, and this module is a dependency, not an extension.

export const CONTROL_COMMANDS = [
    "steer",
    "follow_up",
    "set_session_name",
    "compact",
    "abort",
    "new_session",
    "switch_session",
] as const;

export type ControlCommand = (typeof CONTROL_COMMANDS)[number];

export interface PiControlCommand {
    cmd: ControlCommand;
    content: string;
    name: string;
    path: string;
}

export function controlFileName(sessionId: string): string {
    return `${sessionId}.json`;
}

export function runCommandArgs(command: string, cwd?: string): string[] {
    const args = ["run"];
    if (cwd) {
        args.push("--cwd", cwd);
    }
    return [...args, "-c", command];
}

export function captureTailArgs(blockId: string): string[] {
    return ["termscrollback", "-b", blockId, "--lastcommand"];
}

export function openFileArgs(absPath: string): string[] {
    return ["editor", absPath];
}

export function querySessionsArgs(): string[] {
    return ["blocks", "list", "--json"];
}

export function notifyArgs(title: string, opts: { message?: string; level?: string } = {}): string[] {
    const args = ["notify", title];
    if (opts.message) {
        args.push("--message", opts.message);
    }
    if (opts.level && opts.level !== "info") {
        args.push("--level", opts.level);
    }
    return args;
}

export function parseControlCommand(raw: string): PiControlCommand | null {
    let j: unknown;
    try {
        j = JSON.parse(raw);
    } catch {
        return null;
    }
    const obj = j as Record<string, unknown>;
    if (typeof obj.cmd !== "string" || !(CONTROL_COMMANDS as readonly string[]).includes(obj.cmd)) {
        return null;
    }
    return {
        cmd: obj.cmd as ControlCommand,
        content: typeof obj.content === "string" ? obj.content : "",
        name: typeof obj.name === "string" ? obj.name : "",
        path: typeof obj.path === "string" ? obj.path : "",
    };
}

export default function noop(): void {}
