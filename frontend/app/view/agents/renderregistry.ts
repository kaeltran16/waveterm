// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Mermaid } from "@/app/element/mermaid";
import { createElement, type ComponentType } from "react";
import type { ActionDetail, AgentActionEntry, EditFile } from "./agentsviewmodel";
import { ChartCard } from "./chartcard";
import { parseTestOutput, type TestSummary } from "./testoutput";
import { parseUnifiedDiff } from "./unifieddiff";

// The registry for fenced blocks and tool output. Fenced blocks are keyed by language and consulted by
// MarkdownMessage, so a chart block draws wherever markdown renders. Tool output is keyed by tool
// and consulted by NarrationTimeline only when its `renderers` prop is set. wsh calls have their own
// registry, wshrenderers.tsx, keyed by the call (wshcall.ts).

export type BlockRenderer = ComponentType<{ raw: string }>;

export const BLOCK_RENDERERS: Record<string, BlockRenderer> = {
    chart: ChartCard,
    mermaid: ({ raw }) => createElement(Mermaid, { chart: raw }),
};

export function blockRendererFor(lang?: string): BlockRenderer | undefined {
    return lang && Object.prototype.hasOwnProperty.call(BLOCK_RENDERERS, lang) ? BLOCK_RENDERERS[lang] : undefined;
}

export type ToolRendererKey = "image" | "git-diff" | "test";

// git [global flags] diff|show, anywhere in a compound command; a flag's value never starts with "-",
// so a flag and a value can't both claim one token (that ambiguity backtracks exponentially)
const GIT_DIFF_CMD = /(?:^|[\s;&|(])git\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*?(?:diff|show)\b/;
// Arc's own runners: verify.mjs (go packages), the CDP runners and the task that wraps one; either path separator
const TEST_CMD =
    /(?:^|[\s;&|(])(?:go\s+test|vitest|task\s+verify:ui)\b|(?:^|[\s;&|(/\\])scripts[\\/](?:cdp[\\/](?:final-)?)?verify\.mjs\b/;

export function isGitDiffCommand(cmd: string): boolean {
    return GIT_DIFF_CMD.test(cmd);
}

export function isTestCommand(cmd: string): boolean {
    return TEST_CMD.test(cmd);
}

export type BashCard = { key: "git-diff"; files: EditFile[] } | { key: "test"; summary: TestSummary };

// a timeline re-renders every row on each streamed entry, so a big output is parsed once per detail object
const bashCards = new WeakMap<ActionDetail, BashCard | null>();

// the parsed card for a Bash action's output, or null when its command or output is not one we render
export function bashCard(detail: ActionDetail | undefined): BashCard | null {
    if (detail?.kind !== "bash" || !detail.command) {
        return null;
    }
    if (bashCards.has(detail)) {
        return bashCards.get(detail);
    }
    let card: BashCard | null = null;
    if (isGitDiffCommand(detail.command)) {
        const files = parseUnifiedDiff(detail.output);
        card = files ? { key: "git-diff", files } : null;
    }
    if (card == null && isTestCommand(detail.command)) {
        const summary = parseTestOutput(detail.output);
        card = summary ? { key: "test", summary } : null;
    }
    bashCards.set(detail, card);
    return card;
}

export function toolRendererKey(action: AgentActionEntry): ToolRendererKey | null {
    if (action.images?.length) {
        return "image";
    }
    return bashCard(action.detail)?.key ?? null;
}
