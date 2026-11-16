// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The registry for wsh calls in a transcript, keyed by wshKey (wshcall.ts). A view key's component renders the opened
// body of its step; a card key's component renders the whole standalone card. Each family of calls fills its own
// module's map, so the families are built apart.

import type { ComponentType } from "react";
import type { AgentActionEntry } from "./agentsviewmodel";
import { jiraAttachmentsStepSummary } from "./notescards";
import type { TranscriptContext } from "./transcriptcontext";
import type { WshCall, WshKey, WshViewKey } from "./wshcall";
import { AGENTS_RENDERERS } from "./wshcards-agents";
import { DAG_RENDERERS } from "./wshcards-dag";
import { DAG_ACTION_RENDERERS } from "./wshcards-dagactions";
import { INITIATIVE_RENDERERS } from "./wshcards-initiative";
import { NOTES_RENDERERS } from "./wshcards-notes";
import { RUNS_RENDERERS, RUNS_STEP_SUMMARIES } from "./wshcards-runs";

export interface WshRendererProps {
    call: WshCall;
    wshKey: WshKey;
    action: AgentActionEntry;
    ctx: TranscriptContext;
    compact: boolean;
}

export type WshRenderers = Partial<Record<WshKey, ComponentType<WshRendererProps>>>;

export const WSH_RENDERERS: WshRenderers = {
    ...INITIATIVE_RENDERERS,
    ...DAG_RENDERERS,
    ...DAG_ACTION_RENDERERS,
    ...RUNS_RENDERERS,
    ...AGENTS_RENDERERS,
    ...NOTES_RENDERERS,
};

export function wshRendererFor(key: WshKey): ComponentType<WshRendererProps> | undefined {
    return WSH_RENDERERS[key];
}

// a short word for a read call's collapsed step row, from the call and its own output only: a row never fetches. Its
// tone is the colour the call's own board draws that word in
export type WshStepSummary = {
    summary: (call: WshCall, output: string | undefined) => string | undefined;
    tone: "muted" | "secondary";
};
export type WshStepSummaries = Partial<Record<WshViewKey, WshStepSummary>>;

export const WSH_STEP_SUMMARIES: WshStepSummaries = {
    ...RUNS_STEP_SUMMARIES,
    "jira-attachments": { summary: jiraAttachmentsStepSummary, tone: "muted" },
};

// marks a view whose data came from Arc's RPCs: current state, not the state when the call ran
export function AsOfNow() {
    return <span className="shrink-0 font-mono text-[10.5px] text-muted">as of now</span>;
}
