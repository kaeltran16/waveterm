// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The lead asks for spec approval as an ordinary ask under a known header (pkg/jarvis/leadprompt.go): the
// question's first line is the spec's path, each "- " line a decision it makes. The lead card renders that ask
// as a spec block; an ask that misses the convention stays an ordinary question.

import type { AgentAsk } from "./agentsviewmodel";

export const SPEC_REVIEW_HEADER = "Spec review";

export interface SpecReview {
    qi: number;
    path: string;
    decisions: string[];
}

const DECISION_PREFIX = "- ";

export function parseSpecReview(ask: AgentAsk | undefined): SpecReview | null {
    const qs = ask?.questions ?? [];
    const qi = qs.findIndex((q) => q.header?.trim().toLowerCase() === SPEC_REVIEW_HEADER.toLowerCase());
    if (qi < 0) {
        return null;
    }
    const lines = qs[qi].question
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    const path = (lines[0] ?? "").replace(/^`|`$/g, "");
    if (!/\.md$/i.test(path)) {
        return null;
    }
    const decisions = lines
        .slice(1)
        .filter((l) => l.startsWith(DECISION_PREFIX))
        .map((l) => l.slice(DECISION_PREFIX.length).trim());
    return { qi, path, decisions };
}
