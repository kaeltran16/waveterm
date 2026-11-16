// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// File paths in an agent's reply as links: a whole inline code span that is a path (`pkg/a.go:12`), or a path in prose
// that has a folder in it. The matching is the terminal's (termfilelinks.ts); a bare name in prose ("Node.js") is too
// often a word to link. The remark plugin turns each into a link node marked with the path, which markdownmessage.tsx
// draws as a file link.

import type { Link, PhrasingContent, Root, Text } from "mdast";
import type { Parent } from "unist";
import { SKIP, visit } from "unist-util-visit";
import { findFileLinks } from "../term/termfilelinks";

export type ReplyFileLink = { path: string; line: number | null };

// the hast properties a file link node carries (data-file-path, data-file-line on the element)
export const FILE_PATH_PROP = "dataFilePath";
export const FILE_LINE_PROP = "dataFileLine";

const SEPARATOR_RE = /[/\\]/;

/** Pure: the path a whole inline code span names, else null. */
export function codeSpanLink(code: string): ReplyFileLink | null {
    const text = code.trim();
    const matches = findFileLinks(text);
    if (matches.length !== 1 || matches[0].start !== 0 || matches[0].end !== text.length) {
        return null;
    }
    return { path: matches[0].path, line: matches[0].line };
}

/** Pure: prose split into its text and the paths in it, in order; a path here needs a folder separator. */
export function proseLinks(text: string): Array<string | (ReplyFileLink & { raw: string })> {
    const parts: Array<string | (ReplyFileLink & { raw: string })> = [];
    let at = 0;
    for (const m of findFileLinks(text)) {
        if (!SEPARATOR_RE.test(m.path)) {
            continue;
        }
        if (m.start > at) {
            parts.push(text.slice(at, m.start));
        }
        parts.push({ path: m.path, line: m.line, raw: text.slice(m.start, m.end) });
        at = m.end;
    }
    if (at < text.length) {
        parts.push(text.slice(at));
    }
    return parts;
}

function linkNode(link: ReplyFileLink, children: PhrasingContent[]): Link {
    const props: Record<string, string | number> = { [FILE_PATH_PROP]: link.path };
    if (link.line != null) {
        props[FILE_LINE_PROP] = link.line;
    }
    return { type: "link", url: "", children, data: { hProperties: props } };
}

/** remark plugin: file paths in inline code and prose become marked link nodes; text inside a link is left alone. */
export function remarkFileLinks() {
    return (tree: Root) => {
        visit(tree, (node, index, parent: Parent | undefined) => {
            if (node.type === "link" || node.type === "linkReference") {
                return SKIP;
            }
            if (parent == null || index == null) {
                return;
            }
            const siblings = parent.children as PhrasingContent[];
            if (node.type === "inlineCode") {
                const link = codeSpanLink(node.value);
                if (link != null) {
                    siblings[index] = linkNode(link, [node]);
                }
                return SKIP;
            }
            if (node.type !== "text") {
                return;
            }
            const parts = proseLinks((node as Text).value);
            if (parts.every((p) => typeof p === "string")) {
                return;
            }
            const nodes = parts.map(
                (p): PhrasingContent =>
                    typeof p === "string" ? { type: "text", value: p } : linkNode(p, [{ type: "text", value: p.raw }])
            );
            siblings.splice(index, 1, ...nodes);
            return [SKIP, index + nodes.length];
        });
    };
}
