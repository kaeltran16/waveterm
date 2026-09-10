// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Stage: header, record band, thread, composer. The thread slot is a sibling of the band and the graph
// overlay — never nested inside either — so expanding a record or peeking the graph cannot unmount live
// worker output.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { ambientProviderAtom, ensureAmbient } from "@/app/view/agents/ambientstore";
import { tierFromMeta } from "@/app/view/agents/channelmessages";
import { activeChannelAtom, activeChannelRunsAtom, channelsAtom } from "@/app/view/agents/channelsstore";
import { resolveTargetChannel } from "@/app/view/agents/channelderive";
import {
    loadResolvedProfile,
    pendingRunDraftAtom,
    pendingRunFocusAtom,
    channelOverrideAtom,
} from "@/app/view/agents/runactions";
import { RunBody } from "@/app/view/agents/runbody";
import { RunLauncher } from "@/app/view/agents/runlauncher";
import { liveWorkers } from "@/app/view/agents/runmodel";
import { SurfaceEmptyState } from "@/app/view/agents/surfacescaffold";
import { buildChannelsAskBindings, buildJarvisBindings } from "@/app/store/keybindings/bindings";
import { useKeybindings } from "@/app/store/keybindings/store";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { cn } from "@/util/util";
import { AnimatePresence } from "motion/react";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { ConversationView } from "./conversationview";
import { BriefingView } from "./briefingview";
import { briefingStateAtom, refreshBriefing } from "./briefingstore";
import { openJarvisWithSource } from "./contextualentry";
import { EffortDetailView } from "./effortdetailview";
import { EffortsListView } from "./effortslistview";
import { peekFocus } from "./graphfocus";
import { GraphPeek } from "./graphpeek";
import { DagModal } from "../orchestrate/dagmodal";
import { setDagModalAgentsContext } from "../orchestrate/dagmodalstate";
import { activeConversationAtom, graphPeekOpenAtom } from "./jarvisstore";
import {
    activeSubjectAtom,
    composingRunAtom,
    loadRecordDetail,
    recordBandOpenAtom,
    recordDetailAtom,
    selectSubject,
    setActiveRunId,
    stageRunAtom,
    toggleRecordBand,
} from "./jarvissubjectstore";
import { effortDetailAtom } from "./effortstore";
import { mentionedDossierIds } from "./mentions";
import { recordBandCase } from "./recordband";
import { RecordBand } from "./recordbandview";
import { RecordThread } from "./recordthread";
import { StageComposer } from "./stagecomposer";
import { composeStage } from "./stagecompose";
import { StageHeader } from "./stageheader";
import { STAGE_GUTTER, STAGE_SCROLLER } from "./stagemeasure";

export function Stage({ model }: { model: AgentsViewModel }) {
    const subject = useAtomValue(activeSubjectAtom);
    const channel = useAtomValue(activeChannelAtom);
    const conversation = useAtomValue(activeConversationAtom);
    const ambient = useAtomValue(ambientProviderAtom);
    const agents = useAtomValue(model.agentsAtom);
    useEffect(() => {
        setDagModalAgentsContext(model, agents);
    }, [model, agents]);
    const allRuns = useAtomValue(activeChannelRunsAtom);
    const bandOpen = useAtomValue(recordBandOpenAtom);
    const composingRun = useAtomValue(composingRunAtom);
    const recordDetails = useAtomValue(recordDetailAtom);
    const channels = useAtomValue(channelsAtom);
    const pendingFocus = useAtomValue(pendingRunFocusAtom);
    const setPendingFocus = useSetAtom(pendingRunFocusAtom);
    const pendingDraft = useAtomValue(pendingRunDraftAtom);
    const setPendingDraft = useSetAtom(pendingRunDraftAtom);
    const graphOpen = useAtomValue(graphPeekOpenAtom);
    const setGraphOpen = useSetAtom(graphPeekOpenAtom);
    const overrides = useAtomValue(channelOverrideAtom);
    const profileChannelId = subject?.kind === "channel" ? subject.id : null;
    const briefingSnapshot = useAtomValue(briefingStateAtom).snapshot;
    const effortCache = useAtomValue(effortDetailAtom);

    useEffect(() => ensureAmbient(), []);

    // the profile cache supplies channel route overrides, but never selects the launch mode.
    useEffect(() => {
        if (profileChannelId != null) {
            loadResolvedProfile(profileChannelId);
        }
    }, [profileChannelId]);

    // land a "Open run" focus request (Radar, the graph peek): put its channel on the Stage, then select
    // the run once that channel's runs have loaded. `landed` bounds the navigation to one attempt — a run
    // that never appears (channel load failed, run gone) used to re-fire this on every subject change and
    // yank the user back to it, with no way out but a reload. Landing on the channel is the useful part;
    // silently giving up on the run is the right degradation.
    useEffect(() => {
        if (pendingFocus == null) {
            return;
        }
        if (subject?.kind !== "channel" || subject.id !== pendingFocus.channelId) {
            if (pendingFocus.landed) {
                setPendingFocus(null);
                return;
            }
            selectSubject({ kind: "channel", id: pendingFocus.channelId });
            setPendingFocus({ ...pendingFocus, landed: true });
            return;
        }
        if (allRuns.some((r) => r.id === pendingFocus.runId)) {
            setActiveRunId(pendingFocus.channelId, pendingFocus.runId);
            setPendingFocus(null);
        }
    }, [pendingFocus, subject, allRuns, setPendingFocus]);

    // land a Radar "Start investigation" draft: put its project's channel on the Stage so the composer
    // opens on the right one. `landed` is the one-shot guard, so re-navigating never re-routes the user.
    useEffect(() => {
        if (pendingDraft == null || pendingDraft.landed) {
            return;
        }
        const target = resolveTargetChannel(channels ?? [], pendingDraft.projectPath);
        if (target != null) {
            selectSubject({ kind: "channel", id: target.oid });
        }
        setPendingDraft({ ...pendingDraft, landed: true });
    }, [pendingDraft, channels, setPendingDraft]);

    // a draft run is selected in the Subjects column. It is not a Run yet (the server requires a goal), so
    // the Stage shows its "start a run" state rather than the run that would otherwise auto-resolve
    // underneath it — the column highlights the draft, and both must name the same thing.
    const composing = subject?.kind === "channel" && (composingRun[subject.id] ?? false);
    const open = subject != null ? (bandOpen[subject.id] ?? false) : false;
    // one resolution, shared with the context rail (jarvissubjectstore.stageRunAtom). Resolved inline here
    // twice with different guards, the band and the run body could name different runs mid-channel-switch.
    const run = useAtomValue(stageRunAtom) ?? undefined;
    // null rather than "run:" when nothing resolves: the band hangs Attach and every per-edge correction off
    // this oref, and an empty one would write a correction against no run at all.
    const activeRunORef = run != null ? "run:" + run.id : null;
    const tags = activeRunORef != null ? ambient.tagsFor({ oref: activeRunORef }) : [];
    const band = recordBandCase({ kind: subject?.kind ?? "channel", tags, mentionedIds: [] });
    const bandRecordId = band.case === "one" ? band.edge.taskId : band.case === "several" ? band.primary.taskId : null;

    // the band's record is loaded only once it is actually expanded — a collapsed band needs the edge, not
    // the whole dossier.
    useEffect(() => {
        if (open && bandRecordId != null) {
            loadRecordDetail(bandRecordId);
        }
    }, [open, bandRecordId]);

    // the ask card's numbered (1-9) badges + Enter, targeting the shown run's asking worker. A ref keeps the
    // binding array stable while reading the live worker each render; moved here with the run body it serves.
    const askAgentRef = useRef<AgentVM | undefined>(undefined);
    const askBindings = useMemo(() => buildChannelsAskBindings(model, askAgentRef), [model]);
    useKeybindings(askBindings);

    // the surface's own keys (rail, graph peek, run switcher, + Channel / + Thread, band, composer). Here
    // rather than in JarvisSurface because the Stage is mounted for the whole surface either way, and these
    // register above the early return so they work before a subject is selected.
    const jarvisBindings = useMemo(() => buildJarvisBindings(), []);
    useKeybindings(jarvisBindings);

    if (subject == null) {
        // the region marker is on both branches: the collapse order's floor is a claim about the Stage's
        // width, and a check that only holds once a subject is selected is not a check on the layout.
        return (
            <div data-jarvis-region="stage" className="flex min-w-0 flex-1 flex-col bg-background">
                <SurfaceEmptyState
                    className={STAGE_GUTTER}
                    title="Point me at some work."
                    body="I dispatch runs, keep the record of what they did, and remember it afterwards. Start a channel and I'll drive it — or just ask me something and I'll tell you what I can and can't ground."
                />
                <DagModal />
            </div>
        );
    }

    const comp = composeStage(subject.kind);
    // one cache, two readers: the record the user selected, and the record a channel's run is attributed to.
    const detail = subject.kind === "dossier" ? (recordDetails[subject.id] ?? null) : null;
    const effort = subject.kind === "effort" ? (effortCache.get("effort:" + subject.id) ?? null) : null;
    const meta = (channel?.meta as Record<string, unknown> | undefined) ?? {};
    const tier = tierFromMeta(meta);
    const mode = (meta["delegator:mode"] as string) ?? "report";
    const title =
        subject.kind === "briefing"
            ? "Work briefing"
            : subject.kind === "channel"
              ? (channel?.name ?? "")
              : subject.kind === "dossier"
                ? (detail?.objective ?? "")
                : subject.kind === "effort"
                  ? (effort?.title ?? "Initiative")
                  : subject.kind === "effort-list"
                    ? "Initiatives"
                    : conversation.title;
    const subtitle =
        subject.kind === "channel"
            ? (channel?.projectpath ?? "")
            : subject.kind === "briefing"
              ? "All work"
              : subject.kind === "effort"
                ? "chunks tracker"
                : subject.kind === "effort-list"
                  ? "all initiatives"
                  : "";

    const bandDetail =
        subject.kind === "dossier" ? detail : bandRecordId != null ? (recordDetails[bandRecordId] ?? null) : null;
    askAgentRef.current = run ? liveWorkers(run, agents).find((w) => w.state === "asking") : undefined;

    return (
        <div data-jarvis-region="stage" className="relative flex min-w-0 flex-1 flex-col bg-background">
            <StageHeader
                comp={comp}
                title={title}
                subtitle={subtitle}
                channelId={subject.kind === "channel" ? subject.id : null}
                tier={tier}
                mode={mode}
                onOpenGraph={() => setGraphOpen(true)}
                snapshotTimeMs={subject.kind === "briefing" ? (briefingSnapshot?.queryStartedAt ?? null) : null}
                onRefresh={subject.kind === "briefing" ? refreshBriefing : null}
            />
            {/* absent rather than empty: the "attributed" band speaks about "this run", and neither a
                draft nor a channel whose first run does not exist yet has one — both of those show the
                launcher below instead. The "subject" and "mentions" bands are about a record or a thread
                and never have a run, so the guard is on the attributed case alone. Briefing has neither. */}
            {composing || comp.recordBand === "none" || (comp.recordBand === "attributed" && run == null) ? null : (
                <RecordBand
                    kind={subject.kind}
                    tags={tags}
                    mentionedIds={comp.recordBand === "mentions" ? mentionedDossierIds(conversation) : []}
                    detail={bandDetail}
                    runORef={activeRunORef}
                    open={open}
                    onToggle={() => toggleRecordBand(subject.id)}
                />
            )}
            {/* one thread slot, three renderers — a sibling of the band above and the overlay below */}
            <div className="flex min-h-0 flex-1 flex-col">
                {comp.thread === "run" ? (
                    run != null && channel != null ? (
                        <RunBody model={model} channel={channel} agents={agents} run={run} />
                    ) : (
                        // no run to read means one is being set up, so the slot holds the launcher rather
                        // than an empty state pointing at controls elsewhere. It sits directly above the
                        // goal box that consumes it, and that composer's Run ⏎ is the launch.
                        <RunLauncher channelName={channel?.name ?? "channel"} />
                    )
                ) : comp.thread === "record" ? (
                    <RecordThread detail={detail} model={model} />
                ) : comp.thread === "briefing" ? (
                    <BriefingView model={model} />
                ) : comp.thread === "effort" ? (
                    <EffortDetailView model={model} />
                ) : comp.thread === "effort-list" ? (
                    <EffortsListView model={model} />
                ) : (
                    <div className={cn(STAGE_SCROLLER, "min-h-0 flex-1")}>
                        <ConversationView conversation={conversation} model={model} />
                    </div>
                )}
            </div>
            <StageComposer
                model={model}
                comp={comp}
                subjectId={subject.id}
                channel={channel}
                channels={channels ?? []}
                agents={agents}
                run={run}
                recordId={subject.kind === "dossier" ? subject.id : null}
                recordObjective={detail?.objective ?? ""}
                route={profileChannelId != null ? overrides[profileChannelId]?.route : undefined}
            />
            {/* last child, so the overlay layers above the whole Stage while containing none of it. The
                Stage resolves what the peek opens on: it already holds the run, the attribution and the
                thread's attachments, and the peek must not re-derive any of them. */}
            {/* AnimatePresence so the overlay fades out too — dropping it from the tree on close made the
                whole Stage snap back into view, which reads as a navigation rather than a peek closing. */}
            <AnimatePresence>
                {graphOpen ? (
                    <GraphPeek
                        key="graph-peek"
                        model={model}
                        focus={peekFocus({
                            subject,
                            runORef: run != null ? "run:" + run.id : null,
                            attachedORefs: conversation.scope.attached.map((a) => a.oref),
                            mentionedDossierIds: mentionedDossierIds(conversation),
                            tagsFor: (oref) => ambient.tagsFor({ oref }),
                        })}
                        onClose={() => setGraphOpen(false)}
                        canOpenRuns
                        // a record opens on the Stage, where the three-pane composition shows it; an ask
                        // continues the source's own thread. Both are the same routes the graph's other
                        // entries use, so the overlay names an exit rather than performing a second one.
                        onOpenRecord={(dossierId) => selectSubject({ kind: "dossier", id: dossierId })}
                        onAskAbout={(ref) => openJarvisWithSource(model, ref)}
                    />
                ) : null}
            </AnimatePresence>
            <DagModal />
        </div>
    );
}
