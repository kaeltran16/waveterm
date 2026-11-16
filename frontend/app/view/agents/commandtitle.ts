// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: a short title for a Bash command that has no description and is hard to read in one line, so the step row
// reads "Ran a Python script" beside the raw command rather than the raw command alone. No React.

import { tokenize, type Token } from "./wshcall";

// past this many characters a one-line command no longer reads at a glance in a step row
const LONG_COMMAND_CHARS = 80;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const LEADING_ASSIGNMENT = /^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/;

const INTERPRETERS: Record<string, string> = {
    python: "Python",
    python3: "Python",
    py: "Python",
    node: "Node",
    bash: "shell",
    sh: "shell",
    zsh: "shell",
    pwsh: "shell",
    powershell: "shell",
};
// the words that make an interpreter read its script from the line or stdin rather than a file
const INLINE_SCRIPT_FLAGS: ReadonlySet<string> = new Set(["-", "-c", "-e", "-command"]);

// tools whose meaning is their subcommand: "Ran git status", not "Ran git"
const SUBCOMMAND_TOOLS: ReadonlySet<string> = new Set([
    "git",
    "npm",
    "npx",
    "go",
    "cargo",
    "task",
    "wsh",
    "docker",
    "gh",
    "kubectl",
    "pnpm",
    "yarn",
]);

interface SimpleCommand {
    words: string[];
    redirs: { op: string; target: string }[];
}

function basename(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}

function programName(word: string): string {
    return basename(word)
        .toLowerCase()
        .replace(/\.exe$/, "");
}

function simpleCommands(tokens: Token[]): SimpleCommand[] {
    const out: SimpleCommand[] = [{ words: [], redirs: [] }];
    for (const t of tokens) {
        const cur = out[out.length - 1];
        if (t.kind === "sep") {
            out.push({ words: [], redirs: [] });
        } else if (t.kind === "redir") {
            cur.redirs.push({ op: t.op, target: t.target });
        } else {
            cur.words.push(t.text);
        }
    }
    return out;
}

// the command's words from its program on: leading assignments and export dropped
function programWords(words: string[]): string[] {
    let k = 0;
    while (k < words.length && (ASSIGNMENT.test(words[k]) || words[k] === "export")) {
        k++;
    }
    return words.slice(k);
}

function firstNonFlag(words: string[]): string | undefined {
    return words.find((w) => !w.startsWith("-"));
}

function isHardToRead(command: string): boolean {
    const trimmed = command.trim();
    return trimmed.includes("\n") || LEADING_ASSIGNMENT.test(trimmed) || trimmed.length > LONG_COMMAND_CHARS;
}

function titleOf({ words, redirs }: SimpleCommand): string | undefined {
    const program = programName(words[0]);
    const args = words.slice(1);
    const heredoc = redirs.some((r) => r.op.startsWith("<<"));
    const lang = INTERPRETERS[program];
    if (lang && (heredoc || args.some((a) => INLINE_SCRIPT_FLAGS.has(a.toLowerCase())))) {
        return `Ran a ${lang} script`;
    }
    if (heredoc && (program === "cat" || program === "tee")) {
        const file = program === "tee" ? firstNonFlag(args) : redirs.find((r) => r.op.startsWith(">"))?.target;
        if (file) {
            return `Wrote ${basename(file)}`;
        }
    }
    const sub = firstNonFlag(args);
    if (sub && (SUBCOMMAND_TOOLS.has(program) || (lang && /\.\w+$/.test(sub)))) {
        return `Ran ${program} ${lang ? basename(sub) : sub}`;
    }
    return `Ran ${program}`;
}

// the first simple command, past assignments and a leading cd, decides the title; a short one-liner gets none
export function commandTitle(command: string): string | undefined {
    if (!isHardToRead(command)) {
        return undefined;
    }
    for (const cmd of simpleCommands(tokenize(command))) {
        const words = programWords(cmd.words);
        if (words.length === 0 || programName(words[0]) === "cd") {
            continue;
        }
        return titleOf({ words, redirs: cmd.redirs });
    }
    return undefined;
}
