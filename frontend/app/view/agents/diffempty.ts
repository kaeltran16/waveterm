// frontend/app/view/agents/diffempty.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: why the diff pane has nothing to draw, in words. Null means there is something to draw, or
// the pair is still loading and the pane's skeleton is the honest answer.

export type EmptyDiffKind = "nothing" | "nofile" | "toolarge" | "binary" | "unchanged";

export interface EmptyDiff {
    kind: EmptyDiffKind;
    title: string;
    body: string;
}

export interface EmptyDiffInput {
    path: string | null;
    pair: { path: string; binary: boolean; tooLarge: boolean; original: string; modified: string } | null;
    // set when compare's aggregate is selected and lists no files
    nothingToCompare: { base: string; head: string } | null;
}

export function emptyDiffState(i: EmptyDiffInput): EmptyDiff | null {
    if (i.nothingToCompare != null) {
        const { base, head } = i.nothingToCompare;
        return { kind: "nothing", title: "Nothing to compare", body: `${base} and ${head} have no file differences.` };
    }
    if (!i.path) {
        return {
            kind: "nofile",
            title: "Pick a file to see its changes",
            body: "Choose one from the list, or move through it with the arrow keys.",
        };
    }
    if (i.pair == null || i.pair.path !== i.path) {
        return null;
    }
    if (i.pair.tooLarge) {
        // gitinfo.maxDiffBytes
        return {
            kind: "toolarge",
            title: "Too large to show here",
            body: "Diffs stop at 2 MB. Open it in Code to read the file.",
        };
    }
    if (i.pair.binary) {
        return {
            kind: "binary",
            title: "Binary file",
            body: "Git records a change here, but there is no text to compare.",
        };
    }
    if (i.pair.original === i.pair.modified) {
        return { kind: "unchanged", title: "Contents unchanged", body: "Only the name or the file mode changed." };
    }
    return null;
}
