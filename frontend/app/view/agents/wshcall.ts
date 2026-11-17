// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: which wsh calls a Bash command line makes, read from the command itself (never wsh's human output), so the
// transcript can draw a wsh change as a card and a wsh read as a structured view. No React, no Wave runtime.

export interface WshCall {
    path: string[]; // the subcommand chain: ["effort","chunk","status"]
    args: string[]; // positionals after it
    flags: Record<string, string | true>; // long flags (--note x, --note=x); a short flag is true
    unresolved?: true; // a positional or a fetch flag still holds a variable or a command substitution
}

// every Bool flag of the wsh commands this file keys: one never takes the next word as its value
export const WSH_BOOL_FLAGS: ReadonlySet<string> = new Set([
    "all",
    "archived",
    "autonomous",
    "continue",
    "force",
    "force-land",
    "hold-land",
    "inject",
    "json",
    "others",
    "reviewer-picks",
    "round",
    "start",
    "tasks",
    "wait",
    "yes",
]);

export type WshViewKey =
    | "effort-show"
    | "effort-list"
    | "dag-status"
    | "runs-show"
    | "runs-attention"
    | "agents-list"
    | "jira-show"
    | "jira-attachments";

export type WshCardKey =
    | "effort-create"
    | "chunk-status"
    | "effort-advance"
    | "chunk-add"
    | "chunk-note"
    | "runs-start"
    | "runs-answer"
    | "dag-submit"
    | "dag-planreview"
    | "dag-review"
    | "dag-final"
    | "jarvis-complete"
    | "dag-answer"
    | "dag-tell"
    | "dag-amend"
    | "dag-retry"
    | "dag-forward"
    | "dag-escalate"
    | "dag-merge"
    | "dag-skip"
    | "dag-sendback"
    | "agents-send"
    | "agents-read"
    | "note-add"
    | "brainstorm-judge"
    | "ui-reveal"
    | "other-change";

export type WshKey = WshViewKey | WshCardKey;

const VIEW_KEYS: ReadonlySet<WshKey> = new Set<WshViewKey>([
    "effort-show",
    "effort-list",
    "dag-status",
    "runs-show",
    "runs-attention",
    "agents-list",
    "jira-show",
    "jira-attachments",
]);

const DAG_CARD_VERBS = [
    "submit",
    "planreview",
    "review",
    "final",
    "answer",
    "tell",
    "amend",
    "retry",
    "forward",
    "escalate",
    "merge",
    "skip",
    "sendback",
] as const;

const OTHER = "other-change" as const;
const others = (verbs: string[]): Record<string, WshKey> => Object.fromEntries(verbs.map((v) => [v, OTHER]));

// the subcommand chain joined by spaces -> its key
const KEYS: Record<string, WshKey> = {
    "effort show": "effort-show",
    "effort list": "effort-list",
    "effort create": "effort-create",
    "effort advance": "effort-advance",
    "effort chunk status": "chunk-status",
    "effort chunk add": "chunk-add",
    "effort chunk note": "chunk-note",
    ...prefixed(
        "effort",
        others(["rename", "project", "ticket", "status", "unarchive", "link", "unlink", "delete", "reopen"])
    ),
    ...prefixed("effort chunk", others(["rename", "move", "remove", "stage", "owner", "attach", "detach"])),
    "runs show": "runs-show",
    "runs attention": "runs-attention",
    "runs start": "runs-start",
    "runs answer": "runs-answer",
    ...prefixed("runs", others(["cancel", "end-final", "rerun-final", "land", "ack"])),
    "jarvis dag status": "dag-status",
    ...Object.fromEntries(DAG_CARD_VERBS.map((v) => [`jarvis dag ${v}`, `dag-${v}` as WshKey])),
    ...prefixed("jarvis dag", others(["cancel", "goalpost"])),
    "jarvis complete": "jarvis-complete",
    "agents list": "agents-list",
    "agents send": "agents-send",
    "agents read": "agents-read",
    "note add": "note-add",
    "note delete": OTHER,
    "jira show": "jira-show",
    "jira attachments": "jira-attachments",
    "brainstorm judge": "brainstorm-judge",
    "brainstorm check": OTHER,
    "ui reveal": "ui-reveal",
    "ui do": OTHER,
};

function prefixed(prefix: string, table: Record<string, WshKey>): Record<string, WshKey> {
    return Object.fromEntries(Object.entries(table).map(([k, v]) => [`${prefix} ${k}`, v]));
}

// every proper prefix of a keyed chain is a group a subcommand word can follow
const GROUPS: ReadonlySet<string> = new Set(
    Object.keys(KEYS).flatMap((k) => {
        const parts = k.split(" ");
        return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join(" "));
    })
);

// a word that still holds a variable or a command substitution after expansion: the call's real id is unknown
const UNRESOLVED = /[$`]/;
// flags whose value a card shows but never fetches by (jarvis complete's sha, a note's text), so a substitution there
// is harmless
const DISPLAY_FLAGS: ReadonlySet<string> = new Set([
    "body",
    "commit",
    "detail",
    "message",
    "note",
    "reason",
    "summary",
    "title",
]);

// an unresolved card call is the generic change row (argv, timing, output; no fetch); an unresolved view call has no key
export function wshKey(call: WshCall): WshKey | null {
    const chain = call.path.join(" ");
    if (!Object.prototype.hasOwnProperty.call(KEYS, chain)) {
        return null;
    }
    const key = KEYS[chain];
    if (!call.unresolved) {
        return key;
    }
    return isCardKey(key) ? OTHER : null;
}

export function isCardKey(key: WshKey): key is WshCardKey {
    return !VIEW_KEYS.has(key);
}

// literal: the [start, end) ranges of text that were single-quoted, where the shell expands nothing.
// redir: a redirection's operator and its target word; a heredoc's target is its delimiter
export type Token =
    | { kind: "word"; text: string; literal?: [number, number][] }
    | { kind: "sep" }
    | { kind: "redir"; op: string; target: string };

const SEP_CHARS = new Set([";", "&", "|", "\n", "(", ")"]);
const SPACE = /[ \t\r]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// shell keywords after which the next word is still in command position
const COMMAND_PREFIXES: ReadonlySet<string> = new Set([
    "if",
    "then",
    "else",
    "elif",
    "while",
    "until",
    "do",
    "!",
    "{",
    "time",
]);
const FD_PREFIX = /^\d+$/;

// shell words, command separators and redirections; a heredoc body is skipped
export function tokenize(src: string): Token[] {
    const out: Token[] = [];
    const heredocs: { delim: string; strip: boolean }[] = [];
    let word = "";
    let literal: [number, number][] = [];
    let inWord = false;
    let i = 0;
    const flush = () => {
        if (inWord) {
            out.push(literal.length > 0 ? { kind: "word", text: word, literal } : { kind: "word", text: word });
        }
        word = "";
        literal = [];
        inWord = false;
    };
    // reads one word starting at i (used for redirect targets and heredoc delimiters)
    const readWord = (): string => {
        while (i < src.length && SPACE.test(src[i])) i++;
        let w = "";
        while (i < src.length && !SPACE.test(src[i]) && !SEP_CHARS.has(src[i]) && src[i] !== "<" && src[i] !== ">") {
            const c = src[i];
            if (c === "'" || c === '"') {
                const end = src.indexOf(c, i + 1);
                w += src.slice(i + 1, end < 0 ? src.length : end);
                i = end < 0 ? src.length : end + 1;
                continue;
            }
            if (c === "\\" && i + 1 < src.length) {
                w += src[i + 1];
                i += 2;
                continue;
            }
            w += c;
            i++;
        }
        return w;
    };
    const skipHeredocBodies = () => {
        for (const { delim, strip } of heredocs) {
            while (i < src.length) {
                const nl = src.indexOf("\n", i);
                const line = src.slice(i, nl < 0 ? src.length : nl);
                i = nl < 0 ? src.length : nl + 1;
                if ((strip ? line.replace(/^\t+/, "") : line) === delim) {
                    break;
                }
            }
        }
        heredocs.length = 0;
    };
    while (i < src.length) {
        const c = src[i];
        if (SPACE.test(c)) {
            flush();
            i++;
        } else if (c === "#" && !inWord) {
            while (i < src.length && src[i] !== "\n") i++;
        } else if (c === "'") {
            const end = src.indexOf("'", i + 1);
            const quoted = src.slice(i + 1, end < 0 ? src.length : end);
            if (quoted) literal.push([word.length, word.length + quoted.length]);
            word += quoted;
            inWord = true;
            i = end < 0 ? src.length : end + 1;
        } else if (c === '"') {
            inWord = true;
            i++;
            while (i < src.length && src[i] !== '"') {
                if (src[i] === "\\" && i + 1 < src.length && '"\\$`\n'.includes(src[i + 1])) {
                    if (src[i + 1] !== "\n") word += src[i + 1];
                    i += 2;
                } else {
                    word += src[i++];
                }
            }
            i++;
        } else if (c === "\\") {
            if (src[i + 1] !== "\n") {
                word += src[i + 1] ?? "";
                inWord = true;
            }
            i += 2;
        } else if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
            flush();
            i += 2;
            const strip = src[i] === "-";
            if (strip) i++;
            const delim = readWord();
            heredocs.push({ delim, strip });
            out.push({ kind: "redir", op: strip ? "<<-" : "<<", target: delim });
        } else if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
            // a bare fd number before the operator (2>&1) belongs to the redirection
            if (inWord && FD_PREFIX.test(word)) {
                word = "";
                inWord = false;
            }
            flush();
            const opStart = i;
            while (i < src.length && "<>&|".includes(src[i])) i++;
            const op = src.slice(opStart, i);
            out.push({ kind: "redir", op, target: readWord() });
        } else if (SEP_CHARS.has(c)) {
            flush();
            if (out.at(-1)?.kind !== "sep") out.push({ kind: "sep" });
            i++;
            if (c === "\n" && heredocs.length > 0) skipHeredocBodies();
        } else {
            word += c;
            inWord = true;
            i++;
        }
    }
    flush();
    return out;
}

function isWshCommandWord(w: string): boolean {
    const base = (w.split(/[\\/]/).pop() ?? "").toLowerCase();
    return base === "wsh" || base === "wsh.exe";
}

// whether w continues the chain: the chain so far is a group and w names a group or keyed command under it
function isSubcommand(path: string[], w: string): boolean {
    const chain = [...path, w].join(" ");
    return GROUPS.has(path.join(" ")) && (GROUPS.has(chain) || Object.prototype.hasOwnProperty.call(KEYS, chain));
}

// a word after expansion; unresolved when its unquoted part still holds a variable or a command substitution
interface Word {
    text: string;
    unresolved: boolean;
}

// one wsh invocation's words after the command word
function parseArgv(words: Word[]): WshCall {
    const path: string[] = [];
    const args: string[] = [];
    const flags: Record<string, string | true> = {};
    let unresolved = false;
    const setFlag = (name: string, value: string, wordUnresolved: boolean) => {
        flags[name] = value;
        unresolved ||= wordUnresolved && !DISPLAY_FLAGS.has(name);
    };
    let flagsDone = false;
    for (let k = 0; k < words.length; k++) {
        const { text: w, unresolved: wu } = words[k];
        if (!flagsDone && w === "--") {
            flagsDone = true;
        } else if (!flagsDone && w.startsWith("--")) {
            const eq = w.indexOf("=");
            if (eq > 0) {
                setFlag(w.slice(2, eq), w.slice(eq + 1), wu);
                continue;
            }
            const name = w.slice(2);
            const next = words[k + 1];
            if (!WSH_BOOL_FLAGS.has(name) && next != null && !next.text.startsWith("--")) {
                setFlag(name, next.text, next.unresolved);
                k++;
            } else {
                flags[name] = true;
            }
        } else if (!flagsDone && w.length > 1 && w.startsWith("-") && !/^-\d/.test(w)) {
            for (const letter of w.slice(1)) flags[letter] = true;
        } else if (path.length === 0 || (args.length === 0 && isSubcommand(path, w))) {
            path.push(w);
            unresolved ||= wu;
        } else {
            args.push(w);
            unresolved ||= wu;
        }
    }
    return unresolved ? { path, args, flags, unresolved: true } : { path, args, flags };
}

const VAR_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

// $NAME and ${NAME} for every assigned NAME outside single quotes, in one pass so a value is never expanded again
function expandWord(token: { text: string; literal?: [number, number][] }, vars: ReadonlyMap<string, string>): Word {
    let text = "";
    let unresolved = false;
    const expand = (part: string) => {
        const out = part.replace(VAR_REF, (ref, braced, bare) => vars.get(braced ?? bare) ?? ref);
        unresolved ||= UNRESOLVED.test(out);
        text += out;
    };
    let at = 0;
    for (const [start, end] of token.literal ?? []) {
        expand(token.text.slice(at, start));
        text += token.text.slice(start, end);
        at = end;
    }
    expand(token.text.slice(at));
    return { text, unresolved };
}

export function parseWshCalls(command: string): WshCall[] {
    const calls: WshCall[] = [];
    const vars = new Map<string, string>();
    let commandWords: Word[] | null = null; // the current simple command's words once its command word is wsh
    let atCommand = true;
    const end = () => {
        if (commandWords) calls.push(parseArgv(commandWords));
        commandWords = null;
        atCommand = true;
    };
    for (const t of tokenize(command)) {
        if (t.kind === "sep") {
            end();
        } else if (t.kind === "redir") {
            continue;
        } else if (commandWords) {
            commandWords.push(expandWord(t, vars));
        } else if (atCommand) {
            if (ASSIGNMENT.test(t.text)) {
                // the name holds no $, so the expanded word's first = is still the assignment's
                const assigned = expandWord(t, vars).text;
                const eq = assigned.indexOf("=");
                vars.set(assigned.slice(0, eq), assigned.slice(eq + 1));
                continue;
            }
            if (COMMAND_PREFIXES.has(t.text) || t.text === "export") {
                continue;
            }
            atCommand = false;
            if (isWshCommandWord(t.text)) {
                commandWords = [];
            }
        }
    }
    end();
    return calls;
}

export function firstWshCall(command: string | undefined): { call: WshCall; key: WshKey } | null {
    if (!command) {
        return null;
    }
    for (const call of parseWshCalls(command)) {
        const key = wshKey(call);
        if (key) {
            return { call, key };
        }
    }
    return null;
}

// the RPC return wsh printed, when the keyed call ran with --json and exited 0
export function wshJsonOutput<T>(
    command: string | undefined,
    output: string | undefined,
    exit: number | undefined
): T | null {
    const first = firstWshCall(command);
    const json = first?.call.flags["json"];
    if (exit !== 0 || !output || !(json === true || json === "true")) {
        return null;
    }
    try {
        return JSON.parse(output) as T;
    } catch {
        return null;
    }
}
