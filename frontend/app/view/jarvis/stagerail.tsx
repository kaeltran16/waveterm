// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one context rail. Which sections exist is decided by composeStage plus what actually has content —
// absent rather than empty. Needs you is the exception that is always drawn and never Space-filtered:
// attention beats focus, so an ask in a hidden channel still reaches the user, labelled "outside focus".

import { CollapsibleRail, type RailSection } from "@/app/element/collapsiblerail";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { ConsultsSection, FleetRoster, NeedsRow } from "@/app/view/agents/channelcontextpanel";
import {
    activeChannelAtom,
    activeChannelMessagesAtom,
    channelsAtom,
    consultStreamsAtom,
} from "@/app/view/agents/channelsstore";
import { fleetCounts } from "@/app/view/agents/jarviscards";
import { buildFleetSnapshot, fleetCostUsd, type WorkerState } from "@/app/view/agents/jarvisderive";
import { RAIL_ICON } from "@/app/view/agents/railicons";
import { createRun, pendingRunFocusAtom } from "@/app/view/agents/runactions";
import { spaceScopeAtom } from "@/app/view/agents/spacestore";
import { fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { fleetForRecord } from "./fleetscope";
import { groundingSection, hasGroundingAnswer } from "./groundingrail";
import { activeConversationAtom, conversationsByIdAtom, profileRailOpenAtom, stageRailOpenAtom } from "./jarvisstore";
import {
    activeSubjectAtom,
    recordConversationAtom,
    recordScopeAtom,
    selectSubject,
    setActiveRunId,
} from "./jarvissubjectstore";
import { ProfilePanel } from "./profilepanel";
import { buildRailNeeds } from "./railneeds";
import type { StageComposition } from "./stagecompose";
import { useFleetSummary } from "./usefleetsummary";

const LABEL = "mb-2 font-mono text-[9px] uppercase tracking-[.09em] text-muted";

function formatUsd(n: number): string {
    return `$${n.toFixed(2)}`;
}

// comp is null when no subject is selected. The rail still mounts: Needs you is the surface's attention
// channel and its contract is "always drawn, never filtered" — an ask that is only visible once the user
// happens to click a subject is not an attention channel. Every other section is subject-derived and
// stays absent, per the surface's absent-rather-than-empty rule.
export function StageRail({ model, comp }: { model: AgentsViewModel; comp: StageComposition | null }) {
    const subject = useAtomValue(activeSubjectAtom);
    const channels = useAtomValue(channelsAtom);
    const channel = useAtomValue(activeChannelAtom);
    const messages = useAtomValue(activeChannelMessagesAtom);
    const agents = useAtomValue(model.agentsAtom);
    const consultStreams = useAtomValue(consultStreamsAtom);
    const spaceScope = useAtomValue(spaceScopeAtom);
    const conversation = useAtomValue(activeConversationAtom);
    const convIdByRecord = useAtomValue(recordConversationAtom);
    const convsById = useAtomValue(conversationsByIdAtom);
    const recordScopes = useAtomValue(recordScopeAtom);
    const profileOpen = useAtomValue(profileRailOpenAtom);
    const setPendingFocus = useSetAtom(pendingRunFocusAtom);
    const { summary, runSummary } = useFleetSummary();

    // the pinned Channel's own messages lag the row-backed list, so splice them the way the Channels
    // surface did — the roster and the summary must derive from the same source the thread renders.
    const channelForDerive = channel != null ? { ...channel, messages } : null;

    const needs = buildRailNeeds({ channels, agents, scope: spaceScope });

    // a need in another channel has to move the Stage there first; pendingRunFocus is the existing
    // one-shot the Stage already consumes to land on a run once that channel's runs have loaded.
    const goToNeed = (channelId: string, runId?: string) => {
        if (runId != null) {
            setPendingFocus({ channelId, runId });
            return;
        }
        selectSubject({ kind: "channel", id: channelId });
    };

    const recordId = subject?.kind === "dossier" ? subject.id : null;
    const recordFleet =
        recordId != null
            ? fleetForRecord({
                  channels: channels ?? [],
                  agents,
                  attributedRunORefs: recordScopes[recordId]?.runorefs ?? [],
              })
            : null;
    const snapshot: WorkerState[] =
        recordFleet != null ? recordFleet.workers : channelForDerive != null ? buildFleetSnapshot(channelForDerive, agents) : [];
    const counts = fleetCounts(snapshot);
    const costUsd = fleetCostUsd(snapshot);
    const countsLine =
        recordFleet != null
            ? `${counts.working} working · across ${recordFleet.channelCount} channel${recordFleet.channelCount === 1 ? "" : "s"}`
            : `${counts.working} working · ${counts.waiting} waiting${costUsd > 0 ? ` · ${formatUsd(costUsd)}` : ""}`;

    // grounding follows the Stage's thread: a conversation subject shows its own answers, a record shows
    // the answers to what was asked about it. A channel has no Jarvis thread of its own.
    const stageConversation =
        recordId != null ? convsById[convIdByRecord[recordId] ?? ""] : comp?.thread === "turns" ? conversation : undefined;

    const sections: RailSection[] = [
        {
            id: "needs-you",
            label: needs.length > 0 ? `Needs you · ${needs.length}` : "Needs you",
            icon: RAIL_ICON.bell,
            content: (
                <div>
                    <div className="mb-2 flex items-center gap-2">
                        <span className="font-mono text-[9px] uppercase tracking-[.09em] text-muted">Needs you</span>
                        {needs.length > 0 ? (
                            <span className="rounded-full bg-asking px-1.5 font-mono text-[10px] font-bold text-background">
                                {needs.length}
                            </span>
                        ) : null}
                        <div className="flex-1" />
                        <span className="font-mono text-[9.5px] text-ink-faint">never filtered</span>
                    </div>
                    {needs.length === 0 ? (
                        <div className="flex items-center gap-2 rounded-[10px] border border-border bg-background px-3 py-2.5">
                            <span className="h-[7px] w-[7px] flex-none rounded-full bg-success" />
                            <span className="text-[12px] leading-[1.4] text-secondary">
                                All clear — Jarvis is handling routine asks.
                            </span>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2">
                            {needs.map((n) => (
                                <NeedsRow
                                    key={n.key}
                                    kind={n.kind}
                                    source={`${n.source} · #${n.channelName}`}
                                    text={n.text}
                                    action={n.action}
                                    note={n.outsideFocus ? "outside focus" : undefined}
                                    onGo={() => goToNeed(n.channelId, n.runId)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            ),
        },
    ];

    if (comp?.composerTarget === "worker-or-jarvis" && channelForDerive != null) {
        sections.push({
            id: "consults",
            label: "Consults",
            icon: RAIL_ICON.info,
            content: (
                <div>
                    <div className={LABEL}>Consults · Ask-mode results</div>
                    <ConsultsSection
                        channelId={channelForDerive.oid}
                        messages={messages}
                        streams={consultStreams}
                        onDispatch={(goal) =>
                            fireAndForget(async () => {
                                const created = await createRun(channelForDerive.oid, goal);
                                setActiveRunId(channelForDerive.oid, created.id);
                            })
                        }
                    />
                </div>
            ),
        });
    }

    if (stageConversation != null && hasGroundingAnswer(stageConversation)) {
        sections.push(groundingSection(stageConversation, model));
    }

    if (comp?.showFleet) {
        sections.push({
            id: "fleet",
            label: comp.fleetTitle ?? "Fleet",
            icon: RAIL_ICON.fleet,
            content: (
                <div>
                    <div className="mb-2 flex items-center gap-2">
                        <span className="whitespace-nowrap font-mono text-[9px] uppercase tracking-[.09em] text-muted">
                            {comp.fleetTitle}
                        </span>
                        <div className="flex-1" />
                        <span className="whitespace-nowrap font-mono text-[9.5px] font-semibold text-success">
                            {countsLine}
                        </span>
                    </div>
                    <FleetRoster model={model} snapshot={snapshot} channelId={channelForDerive?.oid} />
                    {channelForDerive != null ? (
                        <button
                            type="button"
                            onClick={() => runSummary(channelForDerive, agents)}
                            disabled={snapshot.length === 0}
                            className="mt-2 w-full cursor-pointer rounded-[9px] border border-accent/25 px-2.5 py-2 text-left hover:border-accent/40 disabled:cursor-default disabled:opacity-40"
                        >
                            <span className="block text-[11.5px] font-bold text-accent-soft">Summarize the fleet</span>
                            <span className="block text-[10px] text-muted">posts here — not a new place</span>
                        </button>
                    ) : null}
                    {summary != null ? (
                        <div className="mt-2 rounded-[10px] border border-border bg-background px-3 py-2.5">
                            <div className="mb-1 font-mono text-[8.5px] font-semibold uppercase tracking-[.08em] text-accent-soft">
                                Jarvis {summary.status === "streaming" ? "· thinking…" : ""}
                            </div>
                            <div className="whitespace-pre-wrap text-[12px] leading-[1.55] text-secondary">
                                {summary.text || "…"}
                            </div>
                        </div>
                    ) : null}
                </div>
            ),
        });
    }

    return (
        <>
            <CollapsibleRail
                openAtom={stageRailOpenAtom}
                ariaLabel="Stage context"
                sections={sections}
                forceCollapsed={profileOpen}
            />
            {/* the ⚙ drawer shares the right-edge slot: it has no strip of its own and the rail above
                force-collapses while it is open, so the two never stack. */}
            <ProfilePanel channelId={comp?.showProfile && subject?.kind === "channel" ? subject.id : ""} />
        </>
    );
}
