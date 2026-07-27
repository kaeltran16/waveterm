// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Stage: header, record band, thread, composer. The thread slot is a sibling of the band and the graph
// overlay — never nested inside either — so expanding a record or peeking the graph cannot unmount live
// worker output.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { ambientProviderAtom, ensureAmbient } from "@/app/view/agents/ambientstore";
import { tierFromMeta } from "@/app/view/agents/channelmessages";
import { activeChannelAtom } from "@/app/view/agents/channelsstore";
import { SurfaceEmptyState } from "@/app/view/agents/surfacescaffold";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { ConversationView } from "./conversationview";
import { activeConversationAtom } from "./jarvisstore";
import { activeSubjectAtom } from "./jarvissubjectstore";
import { mentionedDossierIds } from "./mentions";
import { RecordBand } from "./recordbandview";
import { RecordThread } from "./recordthread";
import { composeStage } from "./stagecompose";
import { StageHeader } from "./stageheader";
import { dossierDetailAtom } from "./tasksstore";

export function Stage({ model }: { model: AgentsViewModel }) {
    const subject = useAtomValue(activeSubjectAtom);
    const channel = useAtomValue(activeChannelAtom);
    const detail = useAtomValue(dossierDetailAtom);
    const conversation = useAtomValue(activeConversationAtom);
    const ambient = useAtomValue(ambientProviderAtom);

    useEffect(() => ensureAmbient(), []);

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

    return (
        <div className="relative flex min-w-0 flex-1 flex-col bg-background">
            <StageHeader
                comp={comp}
                title={title}
                subtitle={subtitle}
                channelId={subject.kind === "channel" ? subject.id : null}
                tier={tier}
                mode={mode}
                onOpenProfile={() => {}}
                onOpenGraph={() => {}}
            />
            <RecordBand
                kind={subject.kind}
                tags={comp.recordBand === "attributed" ? ambient.tagsFor({ oref: "run:" + subject.id }) : []}
                mentionedIds={comp.recordBand === "mentions" ? mentionedDossierIds(conversation) : []}
                detail={detail}
                open={false}
                onToggle={() => {}}
            />
            {/* one thread slot, three renderers — a sibling of the band above and the overlay below */}
            <div className="flex min-h-0 flex-1 flex-col">
                {comp.thread === "record" ? (
                    <RecordThread detail={detail} />
                ) : comp.thread === "turns" ? (
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        <ConversationView conversation={conversation} model={model} />
                    </div>
                ) : null}
            </div>
        </div>
    );
}
