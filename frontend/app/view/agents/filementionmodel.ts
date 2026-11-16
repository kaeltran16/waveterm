// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// the `@` file mention of the Rendered box: where an `@` word is being typed, the text a pick writes, which words
// draw as pills, and the Backspace that removes a pill whole. The text is the single source of truth: a pill is only
// a way of drawing a token of it.

// an `@` at the start or after whitespace, then a word with no whitespace and no second `@` up to the caret
const MENTION_AT_CARET = /(^|\s)@([^\s@]*)$/;
// a token's `@` follows the start, whitespace or an opening bracket
const TOKEN_LEADING = /[\s([{]/;
// a path holds a separator or ends in an extension, so `@alice` stays text
const PATH_LIKE = /[\\/]|\.[A-Za-z0-9]{1,8}$/;
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

export interface MentionToken {
    start: number; // the `@`
    end: number; // just past the path, or past the closing quote of a quoted one
    path: string;
}

export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
    const m = MENTION_AT_CARET.exec(text.slice(0, caret));
    if (m == null) {
        return null;
    }
    return { start: caret - m[2].length - 1, query: m[2] };
}

// a path with whitespace is written quoted, the form Claude Code reads
export function insertMention(
    text: string,
    start: number,
    caret: number,
    path: string
): { text: string; caret: number } {
    const token = /\s/.test(path) ? `@"${path}"` : `@${path}`;
    return { text: text.slice(0, start) + token + " " + text.slice(caret), caret: start + token.length + 1 };
}

export function mentionTokens(text: string): MentionToken[] {
    const out: MentionToken[] = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== "@" || (i > 0 && !TOKEN_LEADING.test(text[i - 1]))) {
            continue;
        }
        const tok = tokenAt(text, i);
        if (tok == null) {
            continue;
        }
        out.push(tok);
        i = tok.end - 1;
    }
    return out;
}

function tokenAt(text: string, at: number): MentionToken | null {
    let path: string;
    let end: number;
    if (text[at + 1] === '"') {
        const close = text.indexOf('"', at + 2);
        if (close < 0) {
            return null;
        }
        path = text.slice(at + 2, close);
        end = close + 1;
    } else {
        path = (/^\S+/.exec(text.slice(at + 1))?.[0] ?? "").replace(TRAILING_PUNCT, "");
        end = at + 1 + path.length;
    }
    if (path === "" || path.includes("@") || !PATH_LIKE.test(path.replace(/[\\/]+$/, "") || path)) {
        return null;
    }
    return { start: at, end, path };
}

// the caret at a token's end, or right after the one space that follows it: the token and that space go
export function backspaceMention(text: string, caret: number): { text: string; caret: number } | null {
    for (const t of mentionTokens(text)) {
        const spaced = text[t.end] === " ";
        if (caret === t.end || (spaced && caret === t.end + 1)) {
            return { text: text.slice(0, t.start) + text.slice(t.end + (spaced ? 1 : 0)), caret: t.start };
        }
    }
    return null;
}
