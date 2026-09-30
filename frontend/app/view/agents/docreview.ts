// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The lead asks for approval of its spec, and of its round-2 plan, as an ordinary ask under a known header
// (pkg/jarvis/leadprompt.go): one question whose first line is the document's path, before "- " lines that
// each name a decision or finding. That ask opens as a review dialog; an ask that misses the convention
// stays an ordinary question.

import { atom, type PrimitiveAtom } from "jotai";
import type { AgentAsk, AgentVM } from "./agentsviewmodel";

export const DOC_REVIEW_HEADERS = { spec: "Spec review", plan: "Plan review" } as const;

export type DocReviewKind = keyof typeof DOC_REVIEW_HEADERS;

export interface DocReview {
    kind: DocReviewKind;
    path: string;
    intro: string[];
    items: string[];
    approveIndex: number;
    requestIndex: number;
}

const ITEM_PREFIX = "- ";
const REQUEST_LABEL = "request changes";
const RECOMMENDED = /\s*\(recommended\)\s*/i;

const kindOf = (header: string | undefined): DocReviewKind | null => {
    const h = header?.trim().toLowerCase();
    return (
        (Object.keys(DOC_REVIEW_HEADERS) as DocReviewKind[]).find((k) => DOC_REVIEW_HEADERS[k].toLowerCase() === h) ??
        null
    );
};

export function parseDocReview(ask: AgentAsk | undefined): DocReview | null {
    const qs = ask?.questions ?? [];
    if (qs.length !== 1) {
        return null;
    }
    const kind = kindOf(qs[0].header);
    if (!kind) {
        return null;
    }
    const lines = qs[0].question
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    const path = (lines[0] ?? "").replace(/^`|`$/g, "");
    if (!/\.md$/i.test(path)) {
        return null;
    }
    const rest = lines.slice(1);
    const firstItem = rest.findIndex((l) => l.startsWith(ITEM_PREFIX));
    const introLines = firstItem < 0 ? rest : rest.slice(0, firstItem);
    const items = rest.filter((l) => l.startsWith(ITEM_PREFIX)).map((l) => l.slice(ITEM_PREFIX.length).trim());
    const labels = (qs[0].options ?? []).map((o) => o.label.replace(RECOMMENDED, " ").trim().toLowerCase());
    const requestIndex = labels.findIndex((l) => l.startsWith(REQUEST_LABEL));
    const approveIndex = labels.findIndex((_, i) => i !== requestIndex);
    return { kind, path, intro: introLines, items, approveIndex, requestIndex };
}

// the id of the agent whose doc-review ask the dialog shows; null = closed
export const docReviewAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// askIds that already auto-opened this session, so closing the dialog keeps it closed
export const autoOpenedAskIdsAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;

export function shouldAutoOpen(input: {
    surface: string;
    focusedId: string | undefined;
    agent: AgentVM | undefined;
    opened: Set<string>;
    editable: boolean;
}): boolean {
    const { surface, focusedId, agent, opened, editable } = input;
    if (surface !== "agent" || editable || !agent || agent.id !== focusedId) {
        return false;
    }
    const askId = agent.ask?.askId;
    return !!askId && !opened.has(askId) && parseDocReview(agent.ask) != null;
}
