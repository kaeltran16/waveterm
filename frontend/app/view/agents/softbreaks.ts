// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's reply shows a single newline as a line break in its terminal, where markdown would join the two lines
// into one. The remark plugin keeps those breaks; code is a node of its own, so it never reaches the visitor.

import type { Break, PhrasingContent, Root, Text } from "mdast";
import type { Parent } from "unist";
import { SKIP, visit } from "unist-util-visit";

const NEWLINE_RE = /\r?\n/;

/** remark plugin: each newline inside a text node becomes a break node. */
export function remarkSoftBreaks() {
    return (tree: Root) => {
        visit(tree, "text", (node: Text, index, parent: Parent | undefined) => {
            if (parent == null || index == null || !NEWLINE_RE.test(node.value)) {
                return;
            }
            const nodes: Array<Text | Break> = [];
            node.value.split(NEWLINE_RE).forEach((part, i) => {
                if (i > 0) {
                    nodes.push({ type: "break" });
                }
                if (part !== "") {
                    nodes.push({ type: "text", value: part });
                }
            });
            (parent.children as PhrasingContent[]).splice(index, 1, ...nodes);
            return [SKIP, index + nodes.length];
        });
    };
}
