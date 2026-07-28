// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Stage: header, record band, thread, composer. The thread slot is a sibling of the band and the graph
// overlay — never nested inside either — so expanding a record or peeking the graph cannot unmount live
// worker output.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { ambientProviderAtom, ensureAmbient } from "@/app/view/agents/ambientstore";
import { tierFromMeta } from "@/app/view/agents/channelmessages";
import {
    activeChannelAtom,
    activeChannelRunsAtom,
    channelDismissedRunsAtom,
    channelsAtom,
} from "@/app/view/agents/channelsstore";
import { getJarvisProfile, pendingRunFocusAtom } from "@/app/view/agents/runactions";
import { RunBody } from "@/app/view/agents/runbody";
import { resolveActiveRunId } from "@/app/view/agents/runmodel";
import { SurfaceEmptyState } from "@/app/view/agents/surfacescaffold";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { ConversationView } from "./conversationview";
import { GraphPeek } from "./graphpeek";
import { activeConversationAtom, graphPeekOpenAtom, profileRailOpenAtom } from "./jarvisstore";
import {
    activeRunIdAtom,
    activeSubjectAtom,
    loadRecordDetail,
    recordBandOpenAtom,
    recordDetailAtom,
    selectSubject,
    setActiveRunId,
    toggleRecordBand,
} from "./jarvissubjectstore";
import { mentionedDossierIds } from "./mentions";
import { recordBandCase } from "./recordband";
import { RecordBand } from "./recordbandview";
import { RecordThread } from "./recordthread";
import { StageComposer } from "./stagecomposer";
import { composeStage } from "./stagecompose";
import { StageHeader } from "./stageheader";
import { dossierDetailAtom } from "./tasksstore";

export function Stage({ model }: { model: AgentsViewModel }) {
    const subject = useAtomValue(activeSubjectAtom);
    const channel = useAtomValue(activeChannelAtom);
    const detail = useAtomValue(dossierDetailAtom);
    const conversation = useAtomValue(activeConversationAtom);
    const ambient = useAtomValue(ambientProviderAtom);
    const agents = useAtomValue(model.agentsAtom);
    const allRuns = useAtomValue(activeChannelRunsAtom);
    const dismissedMap = useAtomValue(channelDismissedRunsAtom);
    const bandOpen = useAtomValue(recordBandOpenAtom);
    const runIds = useAtomValue(activeRunIdAtom);
    const bandDetails = useAtomValue(recordDetailAtom);
    const channels = useAtomValue(channelsAtom);
    const pendingFocus = useAtomValue(pendingRunFocusAtom);
    const setPendingFocus = useSetAtom(pendingRunFocusAtom);
    const graphOpen = useAtomValue(graphPeekOpenAtom);
    const setGraphOpen = useSetAtom(graphPeekOpenAtom);
    const setProfileOpen = useSetAtom(profileRailOpenAtom);
    const [profile, setProfile] = useState<JarvisProfile | undefined>(undefined);

    useEffect(() => ensureAmbient(), []);

    // the channel's resolved profile drives the composer's run footer and every createRun default; the ⚙
    // drawer edits it. Refetched when the channel on the Stage changes.
    useEffect(() => {
        const channelId = subject?.kind === "channel" ? subject.id : null;
        if (channelId == null) {
            setProfile(undefined);
            return;
        }
        let live = true;
        getJarvisProfile(channelId)
            .then((r) => {
                if (live) {
                    setProfile(r.resolved);
                }
            })
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [subject?.kind, subject?.id]);

    // land a "Open run" focus request (Radar, the graph peek): put its channel on the Stage, then select
    // the run once that channel's runs have loaded. Clearing the atom is the one-shot guard.
    useEffect(() => {
        if (pendingFocus == null) {
            return;
        }
        if (subject?.kind !== "channel" || subject.id !== pendingFocus.channelId) {
            selectSubject({ kind: "channel", id: pendingFocus.channelId });
            return;
        }
        if (allRuns.some((r) => r.id === pendingFocus.runId)) {
            setActiveRunId(pendingFocus.channelId, pendingFocus.runId);
            setPendingFocus(null);
        }
    }, [pendingFocus, subject, allRuns, setPendingFocus]);

    const open = subject != null ? (bandOpen[subject.id] ?? false) : false;
    const tags =
        subject?.kind === "channel" && subject.id === channel?.oid
            ? ambient.tagsFor({ oref: "run:" + (resolveActiveRunId(allRuns, runIds[subject.id]) ?? "") })
            : [];
    const band = recordBandCase({ kind: subject?.kind ?? "channel", tags, mentionedIds: [] });
    const bandRecordId = band.case === "one" ? band.edge.taskId : band.case === "several" ? band.primary.taskId : null;

    // the band's record is loaded only once it is actually expanded — a collapsed band needs the edge, not
    // the whole dossier.
    useEffect(() => {
        if (open && bandRecordId != null) {
            loadRecordDetail(bandRecordId);
        }
    }, [open, bandRecordId]);

    if (subject == null) {
        return (
            <SurfaceEmptyState
                title="Point me at some work."
                body="I dispatch runs, keep the record of what they did, and remember it afterwards. Start a channel and I'll drive it — or just ask me something and I'll tell you what I can and can't ground."
            />
        );
    }

    const comp = composeStage(subject.kind);
    const meta = (channel?.meta as Record<string, unknown> | undefined) ?? {};
    const tier = tierFromMeta(meta);
    const mode = (meta["delegator:mode"] as string) ?? "report";
    const title =
        subject.kind === "channel"
            ? (channel?.name ?? "")
            : subject.kind === "dossier"
              ? (detail?.objective ?? "")
              : conversation.title;
    const subtitle = subject.kind === "channel" ? (channel?.projectpath ?? "") : "";

    const dismissed = new Set(dismissedMap[subject.id] ?? []);
    const runs = allRuns.filter((r) => !dismissed.has(r.id));
    const run = runs.find((r) => r.id === resolveActiveRunId(runs, runIds[subject.id]));
    const bandDetail = subject.kind === "dossier" ? detail : bandRecordId != null ? (bandDetails[bandRecordId] ?? null) : null;

    return (
        <div className="relative flex min-w-0 flex-1 flex-col bg-background">
            <StageHeader
                comp={comp}
                title={title}
                subtitle={subtitle}
                channelId={subject.kind === "channel" ? subject.id : null}
                tier={tier}
                mode={mode}
                onOpenProfile={() => setProfileOpen((o) => !o)}
                onOpenGraph={() => setGraphOpen(true)}
            />
            <RecordBand
                kind={subject.kind}
                tags={tags}
                mentionedIds={comp.recordBand === "mentions" ? mentionedDossierIds(conversation) : []}
                detail={bandDetail}
                open={open}
                onToggle={() => toggleRecordBand(subject.id)}
            />
            {/* one thread slot, three renderers — a sibling of the band above and the overlay below */}
            <div className="flex min-h-0 flex-1 flex-col">
                {comp.thread === "run" ? (
                    run != null && channel != null ? (
                        <RunBody model={model} channel={channel} agents={agents} run={run} />
                    ) : (
                        <SurfaceEmptyState
                            title={`Start a run in #${channel?.name ?? "channel"}`}
                            body="Give Jarvis a goal below. @quick spawns one worker, @run kicks off the channel's full strategy, and @ask is a one-shot consult."
                        />
                    )
                ) : comp.thread === "record" ? (
                    <RecordThread detail={detail} model={model} />
                ) : (
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        <ConversationView conversation={conversation} model={model} />
                    </div>
                )}
            </div>
            <StageComposer
                model={model}
                comp={comp}
                channel={channel}
                channels={channels ?? []}
                agents={agents}
                run={run}
                recordId={subject.kind === "dossier" ? subject.id : null}
                recordObjective={detail?.objective ?? ""}
                profile={profile}
            />
            {/* last child, so the overlay layers above the whole Stage while containing none of it */}
            {graphOpen ? (
                <GraphPeek
                    model={model}
                    onClose={() => setGraphOpen(false)}
                    onOpenSubject={(next) => selectSubject(next)}
                />
            ) : null}
        </div>
    );
}
