// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Child-ask card: the questions of this run's dag children that are the human's to answer. A child's
// question goes to the lead first; what the lead forwards, and what it left past its deadline or could not
// deliver, lands here with the reason. The child's own ask card sits on a session nobody sees, so this is
// where the human answers it, through the dag answer path.

import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { MessageCircleQuestion } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { canSubmitAsk } from "./agentsviewmodel";
import { AnswerBar } from "./answerbar";
import { childAskAgent, childAskKey, childAskSent, newAskEventIds, userOwnedAsks } from "./childaskmodel";
import {
    bindChildAsks,
    childAskErrorAtom,
    childAskSelAtom,
    childAskSentAtom,
    childAskTextAtom,
    childAsksAtom,
    refreshChildAsks,
    setChildAnswerText,
    submitChildAnswer,
    toggleChildAnswer,
} from "./childaskstore";
import { useRunEvents } from "./runeventstore";

export function ChildAskCard({ channelId, runId }: { channelId: string; runId: string }) {
    const asks = userOwnedAsks(useAtomValue(childAsksAtom)[runId] ?? []);
    const events = useChildAskRefresh(channelId, runId);

    if (asks.length === 0) {
        return null;
    }
    // flex-none: in the orchestrator body's column the card would shrink to a sliver in a short sheet, and
    // it is the one thing there the human has to act on, so the body scrolls instead
    return (
        <div className="mb-4 flex-none overflow-hidden rounded-xl border border-warning/30 bg-warning/5">
            <div className="flex items-center gap-2 border-b border-warning/15 px-3.5 py-2">
                <MessageCircleQuestion size={13} aria-hidden className="flex-none text-warning" />
                <span className={cn(REGION_LABEL, "text-warning")}>Questions for you</span>
                <div className="flex-1" />
                <span className="font-mono text-[10.5px] text-muted">{asks.length} waiting</span>
            </div>
            <div className="flex flex-col gap-2 px-3.5 py-3">
                {asks.map((a) => (
                    <div
                        key={childAskKey(a)}
                        className="rounded-[9px] border border-warning/20 bg-background px-3 py-2.5"
                    >
                        <div className="font-mono text-[10.5px] text-ink-mid">{a.taskid}</div>
                        <ChildAskEntry channelId={channelId} runId={runId} ask={a} events={events} />
                    </div>
                ))}
            </div>
        </div>
    );
}

// useChildAskRefresh binds the run's asks and returns its events. An answer clearing publishes no dag:child-ask,
// only its run row, so the rows drive a refresh too.
export function useChildAskRefresh(channelId: string, runId: string): RunEvent[] {
    const events = useRunEvents(runId, channelId);
    const seenEventsRef = useRef(new Set<string>());

    useEffect(() => {
        bindChildAsks(channelId, runId);
    }, [channelId, runId]);

    useEffect(() => {
        const fresh = newAskEventIds(events, seenEventsRef.current);
        if (fresh.length === 0) {
            return;
        }
        for (const id of fresh) {
            seenEventsRef.current.add(id);
        }
        refreshChildAsks(channelId, runId);
    }, [events, channelId, runId]);
    return events;
}

// ChildAskEntry is one question the human answers, through the dag answer path: its note, the answer bar, a send
// error, and Send answer. Its picks live in the store, so another host of the same ask shows the same picks.
export function ChildAskEntry({
    channelId,
    runId,
    ask,
    events,
}: {
    channelId: string;
    runId: string;
    ask: DagAskItem;
    events: RunEvent[];
}) {
    const key = childAskKey(ask);
    const selections = useAtomValue(childAskSelAtom)[key] ?? {};
    const texts = useAtomValue(childAskTextAtom)[key] ?? {};
    const sentTs = useAtomValue(childAskSentAtom)[key];
    const error = useAtomValue(childAskErrorAtom)[key];
    const [activeQuestion, setActiveQuestion] = useState(0);
    const agent = childAskAgent(ask);
    const answered = childAskSent(sentTs, ask, events);
    const ready = canSubmitAsk(agent.ask?.questions ?? [], selections, texts);
    return (
        <>
            {ask.note ? <div className="mt-1 text-[12px] text-secondary">{ask.note}</div> : null}
            <AnswerBar
                agent={agent}
                selections={selections}
                texts={texts}
                sent={answered}
                showHint={false}
                activeQuestion={activeQuestion}
                onSelectQuestion={setActiveQuestion}
                onToggle={(qi, oi) => toggleChildAnswer(ask, qi, oi)}
                onText={(qi, value) => setChildAnswerText(ask, qi, value)}
                onSubmit={() => submitChildAnswer(channelId, runId, ask)}
            />
            {error ? <div className="mt-2 text-[11px] text-warning">{error}</div> : null}
            {answered ? null : (
                <button
                    type="button"
                    disabled={!ready}
                    onClick={() => submitChildAnswer(channelId, runId, ask)}
                    className="mt-2 cursor-pointer rounded-md border border-edge-mid bg-surface-hover px-2.5 py-1 text-[11.5px] font-semibold text-secondary hover:border-accent/60 hover:text-primary disabled:cursor-default disabled:opacity-40"
                >
                    Send answer
                </button>
            )}
        </>
    );
}
