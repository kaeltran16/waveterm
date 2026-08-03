// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one context rail. Which sections exist is decided by composeStage plus what actually has content —
// absent rather than empty. Needs you is the exception that is always drawn and never Space-filtered:
// attention beats focus, so an ask in a hidden channel still reaches the user, labelled "outside focus".

import { CollapsibleRail, type RailExtraIcon, type RailSection } from "@/app/element/collapsiblerail";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { ambientProviderAtom, ensureAmbient } from "@/app/view/agents/ambientstore";
import { ConsultsSection, FleetRoster, NeedsRow } from "@/app/view/agents/channelcontextpanel";
import { attentionAtom } from "@/app/view/agents/attentionstore";
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
import { useEffect } from "react";
import { ambientSection } from "./ambientrailview";
import { fleetCountsLine, fleetForRecord } from "./fleetscope";
import { groundingSection, hasGroundingAnswer } from "./groundingrail";
import { activeConversationAtom, conversationsByIdAtom, profileRailOpenAtom, stageRailOpenAtom } from "./jarvisstore";
import {
    activeSubjectAtom,
    recordRunsAtom,
    recordScopeAtom,
    selectSubject,
    setActiveRunId,
    sourceConversationAtom,
    stageRunAtom,
} from "./jarvissubjectstore";
import { ProfilePanel } from "./profilepanel";
import type { StageComposition } from "./stagecompose";
import { useFleetSummary } from "./usefleetsummary";

const LABEL = "mb-2 font-mono text-[9px] uppercase tracking-[.09em] text-muted";

// The server's Kind vocabulary is terse ("gate", "ask"); the row renders it as its own eyebrow label, so
// spell it out here rather than shipping a bare "GATE". Falls through for an unknown future kind.
const NEED_KIND_LABEL: Record<string, string> = {
    gate: "review gate",
    escalation: "escalation",
    ask: "worker ask",
};

// comp is null when no subject is selected. The rail still mounts: Needs you is the surface's attention
// channel and its contract is "always drawn, never filtered" — an ask that is only visible once the user
// happens to click a subject is not an attention channel. Every other section is subject-derived and
// stays absent, per the surface's absent-rather-than-empty rule.
export function StageRail({
    model,
    comp,
    overlay,
}: {
    model: AgentsViewModel;
    comp: StageComposition | null;
    overlay?: boolean;
}) {
    const subject = useAtomValue(activeSubjectAtom);
    const channels = useAtomValue(channelsAtom);
    const channel = useAtomValue(activeChannelAtom);
    const messages = useAtomValue(activeChannelMessagesAtom);
    const agents = useAtomValue(model.agentsAtom);
    const consultStreams = useAtomValue(consultStreamsAtom);
    const spaceScope = useAtomValue(spaceScopeAtom);
    const conversation = useAtomValue(activeConversationAtom);
    const convIdBySource = useAtomValue(sourceConversationAtom);
    const convsById = useAtomValue(conversationsByIdAtom);
    const recordScopes = useAtomValue(recordScopeAtom);
    const profileOpen = useAtomValue(profileRailOpenAtom);
    const setProfileOpen = useSetAtom(profileRailOpenAtom);
    const setPendingFocus = useSetAtom(pendingRunFocusAtom);
    const { summary, runSummary } = useFleetSummary();
    const ambient = useAtomValue(ambientProviderAtom);
    const stageRun = useAtomValue(stageRunAtom);
    const recordRuns = useAtomValue(recordRunsAtom);
    // the provider is lazy, and this rail reads decisionsFor *before* RelevantDecisions mounts and calls
    // ensureAmbient itself — so without this the section would judge "no decisions" on an unloaded map.
    useEffect(() => ensureAmbient(), []);

    // the pinned Channel's own messages lag the row-backed list, so splice them the way the Channels
    // surface did — the roster and the summary must derive from the same source the thread renders.
    const channelForDerive = channel != null ? { ...channel, messages } : null;

    // Attention beats focus: a Space scopes the Subjects column and the Stage, never this list — an item
    // in a channel outside focus still surfaces, labelled as such. The label describes membership, not
    // filtering, so it stands whether or not "Show all" is on.
    const attention = useAtomValue(attentionAtom);
    const focused = spaceScope != null ? new Set(spaceScope.channeloids ?? []) : null;
    const needs = attention.map((n) => ({
        ...n,
        // a standalone item (no channel) is in no Space, so it can never be "outside" one
        outsideFocus: focused != null && !!n.channelid && !focused.has(n.channelid),
    }));

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
    const countsLine = fleetCountsLine(counts, fleetCostUsd(snapshot), recordFleet);

    // grounding follows the Stage's thread: a conversation subject shows its own answers, a record shows
    // the answers to what was asked about it. A channel has no Jarvis thread of its own.
    const stageConversation =
        recordId != null
            ? convsById[convIdBySource["task:" + recordId] ?? ""]
            : comp?.thread === "turns"
              ? conversation
              : undefined;

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
                                    kind={NEED_KIND_LABEL[n.kind] ?? n.kind}
                                    // a standalone agent has no channel, so there is no "#name" to append
                                    source={n.channelname ? `${n.source} · #${n.channelname}` : n.source}
                                    text={n.text}
                                    action={n.action}
                                    note={n.outsideFocus ? "outside focus" : undefined}
                                    // a standalone agent's ask has no channel and no run to land on, so
                                    // it renders as static info per NeedsRow's own contract rather than
                                    // as a control that would navigate nowhere
                                    onGo={n.channelid ? () => goToNeed(n.channelid, n.runid) : undefined}
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
                    {/* the counts hold their line and the title yields: at 300px the two together can
                        exceed the row, and a clipped count ("…across 0 ch") misreads as a smaller fleet. */}
                    <div className="mb-2 flex items-center gap-2">
                        <span className="min-w-0 truncate font-mono text-[9px] uppercase tracking-[.09em] text-muted">
                            {comp.fleetTitle}
                        </span>
                        <span className="ml-auto flex-none whitespace-nowrap font-mono text-[9.5px] font-semibold text-success">
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

    // last, after Fleet: this is the only unsolicited, dismissible section, so it must not sit above live
    // fleet state — and it must never be first, because CollapsibleRail draws sections[0].icon as the
    // collapsed strip's single glyph and that has to stay the Needs-you bell.
    const ambientSec =
        subject != null
            ? ambientSection({
                  kind: subject.kind,
                  run: stageRun,
                  recordRuns: recordId != null ? (recordRuns[recordId] ?? []) : [],
                  hasDecisions: stageRun != null && ambient.decisionsFor({ oref: `run:${stageRun.id}` }).length > 0,
              })
            : null;
    if (ambientSec != null) {
        sections.push(ambientSec);
    }

    // one gate for the trigger and the drawer it opens, so the ⚙ cannot appear on a subject that has no
    // profile to edit — or go missing on one that does.
    const profileChannelId = comp?.showProfile && subject?.kind === "channel" ? subject.id : "";
    // the ⚙ rides this rail's icon slot rather than the Stage header: the drawer it opens slides out of
    // this edge, and a trigger three regions away from its own panel read as one more header control for
    // the subject. Sharing the slot also keeps the right edge one column wide (see RailExtraIcon).
    const extraIcons: RailExtraIcon[] | undefined =
        profileChannelId !== ""
            ? [
                  {
                      key: "profile",
                      icon: RAIL_ICON.gear,
                      ariaLabel: "Channel profile",
                      onClick: () => setProfileOpen((o) => !o),
                  },
              ]
            : undefined;

    return (
        <>
            {/* below the width where collapsing to strips is still enough, the rail leaves the flow rather
                than take the Stage under its floor. Absolute, not fixed: it must clip to the surface.
                `contents` keeps the ordinary case a direct flex child of the surface row. */}
            <div className={overlay ? "absolute bottom-0 right-0 top-0 z-10 flex" : "contents"}>
                <CollapsibleRail
                    openAtom={stageRailOpenAtom}
                    ariaLabel="Stage context"
                    // the third column's header band — same height and rule as the Stage's header and the
                    // Subjects column's, so one line runs across the whole surface
                    title="Context"
                    sections={sections}
                    extraIcons={extraIcons}
                    forceCollapsed={profileOpen}
                />
            </div>
            {/* the ⚙ drawer shares the right-edge slot: it has no strip of its own — its trigger is this
                rail's extra icon — and the rail above force-collapses while it is open, so the two never
                stack. Closing is the drawer's own › or Esc, since the trigger goes with the rail. */}
            <ProfilePanel channelId={profileChannelId} />
        </>
    );
}
