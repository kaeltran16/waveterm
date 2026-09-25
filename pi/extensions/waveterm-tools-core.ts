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
    return ["view", absPath];
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

// dagRulesArgs asks wsh for the orchestration rules of the lead this session is; wsh prints nothing for
// any other session.
export function dagRulesArgs(): string[] {
    return ["jarvis", "dag", "rules"];
}

// withOrchestrationRules appends a lead's rules to a provider request as its last message (orchestrator
// redesign §7). No rules leaves the request untouched, which is every session that is not a lead holding
// a dag.
export function withOrchestrationRules(messages: unknown[], rules: string, now: number): unknown[] | undefined {
    const text = rules.trim();
    if (!text) {
        return undefined;
    }
    return [...messages, { role: "user", content: text, timestamp: now }];
}

export default function noop(): void {}
