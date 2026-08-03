// frontend/app/view/code/codetree.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: turn the flat, forward-slashed path list from `git ls-files` into the tree the Code surface
// renders, and flatten that tree to rows given a set of expanded directories. No React, no IO.

export interface TreeNode {
    name: string;
    path: string; // repo-relative, forward slashes
    isDir: boolean;
    children: TreeNode[];
}

export interface TreeRow {
    kind: "dir" | "file";
    path: string;
    name: string;
    depth: number;
    expanded: boolean; // always false on a file row
}

export function buildTree(paths: readonly string[]): TreeNode[] {
    const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
    // path -> node, so a directory with thousands of siblings costs a lookup, not a scan
    const index = new Map<string, TreeNode>();
    for (const p of paths) {
        const segs = p.split("/").filter((s) => s !== "");
        let parent = root;
        segs.forEach((seg, i) => {
            const path = parent.path === "" ? seg : `${parent.path}/${seg}`;
            let node = index.get(path);
            if (node == null) {
                node = { name: seg, path, isDir: i < segs.length - 1, children: [] };
                parent.children.push(node);
                index.set(path, node);
            }
            parent = node;
        });
    }
    sortNodes(root);
    return root.children;
}

function sortNodes(node: TreeNode): void {
    node.children.sort((a, b) => {
        if (a.isDir !== b.isDir) {
            return a.isDir ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
    for (const child of node.children) {
        sortNodes(child);
    }
}

export function visibleRows(tree: readonly TreeNode[], expanded: ReadonlySet<string>): TreeRow[] {
    const rows: TreeRow[] = [];
    const walk = (nodes: readonly TreeNode[], depth: number) => {
        for (const n of nodes) {
            const isOpen = n.isDir && expanded.has(n.path);
            rows.push({
                kind: n.isDir ? "dir" : "file",
                path: n.path,
                name: n.name,
                depth,
                expanded: isOpen,
            });
            if (isOpen) {
                walk(n.children, depth + 1);
            }
        }
    };
    walk(tree, 0);
    return rows;
}

// the directories that must be expanded for `path` to be visible — the finder opens files in
// collapsed subtrees, and the tree should show where you landed.
export function ancestorsOf(path: string): string[] {
    const segs = path.split("/").filter((s) => s !== "");
    const out: string[] = [];
    for (let i = 1; i < segs.length; i++) {
        out.push(segs.slice(0, i).join("/"));
    }
    return out;
}
