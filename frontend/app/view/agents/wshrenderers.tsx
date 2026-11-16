// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The registry for wsh calls in a transcript, keyed by wshKey (wshcall.ts). A view key's component renders the opened
// body of its step; a card key's component renders the whole standalone card. Each family of calls fills its own
// module's map, so the families are built apart.

import type { ComponentType } from "react";
import type { AgentActionEntry } from "./agentsviewmodel";
import type { TranscriptContext } from "./transcriptcontext";
import type { WshCall, WshKey } from "./wshcall";
import { AGENTS_RENDERERS } from "./wshcards-agents";
import { DAG_RENDERERS } from "./wshcards-dag";
import { DAG_ACTION_RENDERERS } from "./wshcards-dagactions";
import { INITIATIVE_RENDERERS } from "./wshcards-initiative";
import { NOTES_RENDERERS } from "./wshcards-notes";
import { RUNS_RENDERERS } from "./wshcards-runs";

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

// marks a view whose data came from Arc's RPCs: current state, not the state when the call ran
export function AsOfNow() {
    return <span className="shrink-0 font-mono text-[10.5px] text-muted">as of now</span>;
}
