// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure, dependency-free line tokenizer for transcript code blocks. Ported from the claude-design
// mock's hlLine. Returns tokens tagged with a Tailwind text-color utility (design-system token),
// never a raw hex. Language-agnostic lexical heuristics (keywords/strings/numbers/comments) — good
// enough for prose code snippets, not a full parser.

export interface CodeToken {
    t: string;
    cls: string;
}

const KEYWORDS = new Set([
    "const", "let", "var", "function", "return", "new", "import", "from", "export", "default",
    "if", "else", "for", "while", "await", "async", "class", "extends", "true", "false", "null",
    "undefined", "this", "void", "type", "interface",
]);

// group order matters: comment | string | number | ident | whitespace | punctuation
const TOKEN_RE =
    /(\/\/[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z0-9_$])/g;

export function highlightLine(line: string): CodeToken[] {
    const toks: CodeToken[] = [];
    let m: RegExpExecArray | null;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(line))) {
        let cls = "text-syntax-ident";
        if (m[1]) cls = "text-syntax-comment";
        else if (m[2]) cls = "text-syntax-string";
        else if (m[3]) cls = "text-syntax-number";
        else if (m[4]) cls = KEYWORDS.has(m[4]) ? "text-syntax-keyword" : "text-syntax-ident";
        else if (m[6]) cls = "text-syntax-punct";
        toks.push({ t: m[0], cls });
    }
    if (toks.length === 0) toks.push({ t: " ", cls: "text-syntax-ident" });
    return toks;
}
