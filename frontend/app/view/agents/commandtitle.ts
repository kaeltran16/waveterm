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
    "claude",
]);
// a subcommand worth naming is a plain word, never a quoted prompt or a path
const SUBCOMMAND_WORD = /^[a-z][a-z0-9-]*$/i;

// programs that run the command after them: the title names that one. Each maps to its flags that take a value as the
// next word
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["timeout", new Set(["-s", "-k", "--signal", "--kill-after"])],
    ["env", new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"])],
    ["nohup", new Set<string>()],
    ["time", new Set(["-f", "-o", "--format", "--output"])],
    ["command", new Set<string>()],
]);
const DURATION = /^\d+(\.\d+)?[smhd]?$/;

// a leading cd into a directory, then && or ;
const LEADING_CD = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/;

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

// the command's words from its program on: leading assignments, export and wrappers (with their flags and a timeout's
// duration) dropped
function programWords(words: string[]): string[] {
    let k = 0;
    while (k < words.length) {
        if (ASSIGNMENT.test(words[k]) || words[k] === "export") {
            k++;
            continue;
        }
        const wrapper = programName(words[k]);
        const valued = WRAPPERS.get(wrapper);
        if (!valued) {
            break;
        }
        k++;
        while (k < words.length && words[k].startsWith("-")) {
            k += valued.has(words[k]) ? 2 : 1;
        }
        if (wrapper === "timeout" && DURATION.test(words[k] ?? "")) {
            k++;
        }
    }
    return words.slice(k);
}

function closingParen(src: string, from: number): number {
    let depth = 1;
    for (let j = from; j < src.length; j++) {
        if (src[j] === "(") depth++;
        if (src[j] === ")" && --depth === 0) return j + 1;
    }
    return src.length;
}

// the command with every $( ) and backtick substitution removed, so a command inside one never names the title; a
// single-quoted span stays as it is, since the shell does not expand it
function withoutSubstitutions(src: string): string {
    let out = "";
    let inDouble = false;
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        let next = i + 1;
        if (c === "\\") {
            next = i + 2;
            out += src.slice(i, next);
        } else if (c === "'" && !inDouble) {
            const end = src.indexOf("'", i + 1);
            next = end < 0 ? src.length : end + 1;
            out += src.slice(i, next);
        } else if (c === "`") {
            const end = src.indexOf("`", i + 1);
            next = end < 0 ? src.length : end + 1;
        } else if (c === "$" && src[i + 1] === "(") {
            next = closingParen(src, i + 2);
        } else {
            if (c === '"') inDouble = !inDouble;
            out += c;
        }
        i = next;
    }
    return out;
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
    if (sub && SUBCOMMAND_TOOLS.has(program) && SUBCOMMAND_WORD.test(sub)) {
        return `Ran ${program} ${sub}`;
    }
    if (sub && lang && /\.\w+$/.test(sub)) {
        return `Ran ${program} ${basename(sub)}`;
    }
    // "Ran grep" only repeats the command's first word beside it
    return undefined;
}

// the first simple command, past assignments, wrappers and a leading cd, decides the title; a short one-liner gets none
export function commandTitle(command: string): string | undefined {
    if (!isHardToRead(command)) {
        return undefined;
    }
    for (const cmd of simpleCommands(tokenize(withoutSubstitutions(command)))) {
        const words = programWords(cmd.words);
        if (words.length === 0 || programName(words[0]) === "cd") {
            continue;
        }
        return titleOf({ words, redirs: cmd.redirs });
    }
    return undefined;
}

// the command as a step row previews it: a leading cd dropped, so the width goes to the command itself
export function commandPreview(command: string): string {
    return command.replace(LEADING_CD, "") || command;
}
