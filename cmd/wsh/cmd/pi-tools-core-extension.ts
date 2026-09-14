// Pure helpers for the waveterm tools extension. No external imports so the repo's vitest can cover
// it. The default export is a no-op: pi auto-loads every file in the extensions directory, and this
// module is a dependency, not an extension.

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

export default function noop(): void {}
