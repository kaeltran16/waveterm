// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure detail extractors for the transcript projection. No React, no Wave runtime imports.
// Deterministic; no LLM. An edit's diff is its removed block then its added block, unnumbered, until its result's
// structuredPatch replaces it with the file's own numbered hunks.

import type { AskQuestionDetail, DiffLine, EditFile, GrepMatch, ToolImage } from "./agentsviewmodel";

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

const IMAGE_MEDIA_TYPE = /^image\/[\w.+-]+$/;

// the { type:"image", source:{ type:"base64", media_type, data } } items of a tool_result `content`
export function toolResultImages(content: unknown): ToolImage[] {
    if (!Array.isArray(content)) return [];
    return content
        .filter(
            (b: any) =>
                b?.type === "image" &&
                b.source?.type === "base64" &&
                typeof b.source.data === "string" &&
                typeof b.source.media_type === "string" &&
                IMAGE_MEDIA_TYPE.test(b.source.media_type)
        )
        .map((b: any) => ({ mediaType: b.source.media_type, data: b.source.data }));
}

// An edit's old and new strings as a diff. The lines both share at either end are the anchor quoted around the change,
// so they stay context and only the lines between count as removed and added.
export function buildEditDiff(path: string, oldStr: string, newStr: string): EditFile {
    const a = oldStr === "" ? [] : oldStr.split("\n");
    const b = newStr === "" ? [] : newStr.split("\n");
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) {
        head++;
    }
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
        tail++;
    }
    const context = (text: string) => ({ sign: "" as const, text });
    const lines = [
        ...a.slice(0, head).map(context),
        ...a.slice(head, a.length - tail).map((text) => ({ sign: "-" as const, text })),
        ...b.slice(head, b.length - tail).map((text) => ({ sign: "+" as const, text })),
        ...a.slice(a.length - tail).map(context),
    ];
    return {
        path,
        badge: oldStr === "" ? "A" : "M",
        adds: b.length - head - tail,
        dels: a.length - head - tail,
        lines,
    };
}

type PatchHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

function isPatchHunk(h: any): h is PatchHunk {
    return (
        typeof h?.oldStart === "number" &&
        typeof h.newStart === "number" &&
        Array.isArray(h.lines) &&
        h.lines.every((l: unknown) => typeof l === "string")
    );
}

// An Edit/Write result's toolUseResult.structuredPatch as a numbered diff: each hunk's lines counted from its
// oldStart/newStart, a later hunk opened by its @@ header. Null when the patch is missing, empty or malformed (a
// failed call carries an error string; a Write that created the file carries []).
export function editFromPatch(path: string, patch: unknown): EditFile | null {
    if (!Array.isArray(patch) || patch.length === 0 || !patch.every(isPatchHunk)) {
        return null;
    }
    const lines: DiffLine[] = [];
    let adds = 0;
    let dels = 0;
    patch.forEach((h, i) => {
        if (i > 0) {
            lines.push({ sign: "", text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, hunk: true });
        }
        let oldNo = h.oldStart;
        let newNo = h.newStart;
        for (const raw of h.lines) {
            const sign = raw[0];
            if (sign === "+") {
                adds++;
                lines.push({ sign: "+", text: raw.slice(1), newNo: newNo++ });
            } else if (sign === "-") {
                dels++;
                lines.push({ sign: "-", text: raw.slice(1), oldNo: oldNo++ });
            } else if (sign !== "\\") {
                lines.push({ sign: "", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
            }
        }
    });
    return { path, badge: patch.every((h) => h.oldLines === 0) ? "A" : "M", adds, dels, lines };
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

// AskUserQuestion's input questions, unanswered. Entries without a question text are dropped.
export function askQuestions(raw: unknown[]): AskQuestionDetail[] {
    return raw
        .filter((q: any) => typeof q?.question === "string")
        .map((q: any) => ({
            question: q.question,
            ...(typeof q.header === "string" && q.header !== "" ? { header: q.header } : {}),
            options: (Array.isArray(q.options) ? q.options : [])
                .filter((o: any) => typeof o?.label === "string")
                .map((o: any) => ({
                    label: o.label,
                    ...(typeof o.description === "string" && o.description !== ""
                        ? { description: o.description }
                        : {}),
                })),
            picked: [],
        }));
}

const ASK_ANSWER_JOIN = ", ";

// claude records one string per question: the picked labels joined with ", ", or the text typed under "Other"
// ponytail: a label holding ", " matches only when picked alone; read per-option picks if claude ever records them
export function splitAskAnswer(answer: string, labels: string[]): { picked: string[]; typed?: string } {
    if (labels.includes(answer)) {
        return { picked: [answer] };
    }
    const parts = answer.split(ASK_ANSWER_JOIN);
    const picked = parts.filter((p) => labels.includes(p));
    const typed = parts.filter((p) => !labels.includes(p)).join(ASK_ANSWER_JOIN);
    return typed !== "" ? { picked, typed } : { picked };
}

const ASK_SUMMARY_MAX = 32; // the tool line's summary never shrinks, so a long answer would push the question out

// fills each question's answer from the result's question -> answer map, and returns the tool line's summary
export function answerAsk(questions: AskQuestionDetail[], answers: Record<string, unknown>): string | undefined {
    const given: string[] = [];
    for (const q of questions) {
        const answer = answers[q.question];
        if (typeof answer !== "string" || answer === "") {
            continue;
        }
        Object.assign(
            q,
            splitAskAnswer(
                answer,
                q.options.map((o) => o.label)
            )
        );
        given.push(answer);
    }
    if (given.length === 0) {
        return undefined;
    }
    if (questions.length > 1) {
        return `${given.length} answers`;
    }
    return given[0].length > ASK_SUMMARY_MAX ? given[0].slice(0, ASK_SUMMARY_MAX - 1) + "…" : given[0];
}

export function formatDuration(ms?: number): string {
    if (ms == null) return "";
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m`;
}
