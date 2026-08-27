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
    "child_done",
    "gate_open",
    "dag_blocked",
    "dag_complete",
    "child_ask",
    "child_stalled",
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

// dagEventMessage maps an engine dag control command to a watcher-visible notification line.
export function dagEventMessage(kind: string, detail: string): string {
    const labels: Record<string, string> = {
        child_done: "child done",
        gate_open: "gate open — review in cockpit",
        dag_blocked: "dag blocked",
        dag_complete: "dag complete",
        child_ask: "child is asking",
        child_stalled: "child stalled",
    };
    const label = labels[kind] ?? kind;
    return detail ? `${label}: ${detail}` : label;
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

// wave_vault_ask shells out to `wsh jarvis ask` (the stateless work-ledger question). --json keeps
// the tool's answer parseable; the flag order (positional question first) matches cobra's
// flags-after-args tolerance.
export function vaultAskArgs(question: string, cwd?: string): string[] {
    const args = ["jarvis", "ask", question, "--json"];
    if (cwd) {
        args.push("--cwd", cwd);
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

// makeSerialChain coerces burst callers into one-at-a-time execution: each call waits for the
// previous run to settle (fulfilled or rejected) before starting, so interleaved invocations cannot
// race each other. Errors are delivered to onError and never poison the chain. Used by the control
// watcher, where fs.watch callbacks sharing one command file would otherwise run concurrently.
export function makeSerialChain(run: () => Promise<void>, onError: (err: unknown) => void): () => void {
    let chain: Promise<void> = Promise.resolve();
    return () => {
        chain = chain.then(run).catch(onError);
    };
}

export default function noop(): void {}
