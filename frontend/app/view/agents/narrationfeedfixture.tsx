// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY: one narration feed over fixture entries, so the narration-feed and transcript-* CDP scenarios
// (scripts/cdp/narrationfeed.mjs, scripts/cdp/transcript-fixture.mjs) can check the rendered feed. Every real host of
// the feed needs a live session or run. Same seam shape as window.__waveDagModalFixture
// (view/orchestrate/dagmodalstate.ts).

import { COCKPIT_ROUTE_ID } from "@/app/cockpit/uiapi";
import { ModalShell } from "@/app/modals/modalshell";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { DefaultRouter } from "@/app/store/wshrpcutil-base";
import type { AgentsViewModel } from "./agents";
import type { AgentEntry } from "./agentsviewmodel";
import { NarrationTimeline } from "./narrationtimeline";
import type { NowLine } from "./nowline";
import { WorkingLine } from "./nowlineview";
import type { TimelineMark } from "./permissionmodel";
import { seedRunEvents } from "./runeventstore";
import { transcriptContextFor, type TranscriptContext } from "./transcriptcontext";
import { seedWshData } from "./wshdata";

export interface NarrationFeedFixtureOpts {
    ctx?: Omit<TranscriptContext, "model">;
    // a live session's tab id: the ctx a real host builds for it (transcriptContextFor), under ctx's own fields
    liveAgent?: string;
    compact?: boolean;
    active?: boolean;
    // permission marks, drawn as the rendered view draws its answered requests
    marks?: TimelineMark[];
    renderers?: boolean;
    seed?: Record<string, unknown>;
    runEvents?: Record<string, RunEvent[]>;
    // drawn as the timeline's tail, as a working host draws it
    nowLine?: NowLine;
}

interface ModalProps {
    entries: AgentEntry[];
    width: number;
    ctx?: TranscriptContext;
    marks?: TimelineMark[];
    compact?: boolean;
    active?: boolean;
    renderers?: boolean;
    nowLine?: NowLine;
}

export function NarrationFeedFixtureModal({
    entries,
    width,
    ctx,
    compact,
    active,
    renderers,
    marks,
    nowLine,
}: ModalProps) {
    return (
        <ModalShell open onClose={() => modalsModel.popModal()}>
            <div data-narration-fixture style={{ width }} className="max-h-[80vh] overflow-y-auto bg-surface px-3 py-2">
                <NarrationTimeline
                    entries={entries}
                    active={!!active}
                    renderers={renderers}
                    marks={marks}
                    ctx={ctx}
                    compact={compact}
                    tail={nowLine ? <WorkingLine line={nowLine} compact={compact} /> : undefined}
                />
            </div>
        </ModalShell>
    );
}

// the live cockpit's model, so cards link through the router as they do in the app
function cockpitModel(): AgentsViewModel | undefined {
    return (DefaultRouter?.routeMap.get(COCKPIT_ROUTE_ID) as { model?: AgentsViewModel } | undefined)?.model;
}

// the agent surface lists terminals beside agents, so a host's session is either
function liveContext(model: AgentsViewModel | undefined, agentId: string): TranscriptContext {
    const roster = model ? [...globalStore.get(model.agentsAtom), ...globalStore.get(model.terminalsAtom)] : [];
    const agent = roster.find((a) => a.id === agentId);
    if (agent == null) {
        throw new Error(`no live session ${agentId} in the cockpit's roster`);
    }
    return transcriptContextFor({ model, agent });
}

if (import.meta.env.DEV && typeof window !== "undefined") {
    window.__narrationFeedFixture = {
        show: (entries, width, opts = {}) => {
            const { seed, runEvents, ctx, liveAgent, ...rest } = opts;
            const model = cockpitModel();
            const live = liveAgent ? liveContext(model, liveAgent) : {};
            if (seed) seedWshData(seed);
            for (const [runId, events] of Object.entries(runEvents ?? {})) seedRunEvents(runId, events);
            modalsModel.pushModal("NarrationFeedFixtureModal", {
                entries,
                width,
                ...rest,
                ctx: { ...live, ...ctx, model },
            });
        },
        clear: () => {
            while (modalsModel.hasOpenModals()) {
                modalsModel.popModal();
            }
        },
    };
}

declare global {
    interface Window {
        __narrationFeedFixture?: {
            show: (entries: AgentEntry[], width: number, opts?: NarrationFeedFixtureOpts) => void;
            clear: () => void;
        };
    }
}
