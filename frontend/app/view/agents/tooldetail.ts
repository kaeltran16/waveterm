// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure detail extractors for the transcript projection. No React, no Wave runtime imports.
// Deterministic; no LLM. v1 diffs are pragmatic: removed block then added block, no line gutters.

import type { EditFile, GrepMatch } from "./agentsviewmodel";

// A Claude tool_result `content` is either a string or an array of { type:"text", text }.
export function toolResultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((b: any) => b?.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("\n");
    }
    return "";
}

function baseCount(s: string): number {
    return s === "" ? 0 : s.split("\n").length;
}

export function buildEditDiff(path: string, oldStr: string, newStr: string): EditFile {
    const dels = baseCount(oldStr);
    const adds = baseCount(newStr);
    const lines = [
        ...(oldStr === "" ? [] : oldStr.split("\n").map((text) => ({ sign: "-" as const, text }))),
        ...(newStr === "" ? [] : newStr.split("\n").map((text) => ({ sign: "+" as const, text }))),
    ];
    return { path, badge: oldStr === "" ? "A" : "M", adds, dels, lines };
}

const GREP_PREFIX = /^(.*?:\d+):?(.*)$/;

export function parseGrep(output: string): GrepMatch[] {
    return output
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => {
            const m = GREP_PREFIX.exec(l);
            return m ? { loc: m[1], code: m[2] } : { loc: "", code: l };
        });
}

export function sliceRead(output: string, maxLines: number): { snippet: string; truncated: boolean } {
    const lines = output.split("\n");
    if (lines.length <= maxLines) return { snippet: output, truncated: false };
    return { snippet: lines.slice(0, maxLines).join("\n"), truncated: true };
}

export function formatDuration(ms?: number): string {
    if (ms == null) return "";
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m`;
}
