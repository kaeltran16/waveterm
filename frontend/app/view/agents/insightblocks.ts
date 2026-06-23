// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Splits an assistant message into prose and "insight callout" segments. The
// explanatory output-style emits a fixed block — `★ Insight ───…` / points /
// `───…` — whose rule lines are backtick-wrapped, so plain markdown renders them
// as two inline-code "pills". We detect that literal shape deterministically so
// the renderer can style it as a callout. No markdown parsing here; the caller
// re-renders each segment's text through the markdown pipeline.

export type MessageSegment = { kind: "text"; text: string } | { kind: "insight"; text: string };

// opener: the ★ Insight line (optional wrapping backticks, optional trailing rule dashes).
// closer: a run of >= 5 rule dashes (optional backticks); the >= 5 floor keeps a markdown
// "---" horizontal rule from being mistaken for a closer.
const OPENER = /^`?★\s*Insight\b[\s─-]*`?$/;
const CLOSER = /^`?[─-]{5,}`?$/;

export function splitInsightBlocks(text: string): MessageSegment[] {
    const lines = text.split("\n");
    const segments: MessageSegment[] = [];
    let buf: string[] = [];

    const flushText = () => {
        const joined = buf.join("\n").trim();
        if (joined !== "") {
            segments.push({ kind: "text", text: joined });
        }
        buf = [];
    };

    for (let i = 0; i < lines.length; i++) {
        if (!OPENER.test(lines[i].trim())) {
            buf.push(lines[i]);
            continue;
        }
        let close = -1;
        for (let j = i + 1; j < lines.length; j++) {
            if (CLOSER.test(lines[j].trim())) {
                close = j;
                break;
            }
        }
        if (close === -1) {
            // no closer: a malformed block must not swallow the rest of the message
            buf.push(lines[i]);
            continue;
        }
        flushText();
        segments.push({ kind: "insight", text: lines.slice(i + 1, close).join("\n").trim() });
        i = close;
    }
    flushText();
    return segments;
}
