// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Child-ask card: the questions of this run's dag children that are the human's to answer. A child's
// question goes to the lead first; what the lead forwards, and what it left past its deadline or could not
// deliver, lands here with the reason. The child's own ask card sits on a session nobody sees, so this is
// where the human answers it, through the dag answer path.

import { useAtomValue } from "jotai";
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
    const asks = userOwnedAsks(useAtomValue(childAsksAtom));
    const selections = useAtomValue(childAskSelAtom);
    const texts = useAtomValue(childAskTextAtom);
    const sent = useAtomValue(childAskSentAtom);
    const errors = useAtomValue(childAskErrorAtom);
    const events = useRunEvents(runId, channelId);
    const seenEventsRef = useRef(new Set<string>());
    const [activeQuestion, setActiveQuestion] = useState<Record<string, number>>({});

    useEffect(() => {
        bindChildAsks(channelId, runId);
    }, [channelId, runId]);

    // an answer clearing publishes no dag:child-ask, only its run row, so the rows drive a refresh too
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

    if (asks.length === 0) {
        return null;
    }
    return (
        <div className="mb-4 overflow-hidden rounded-xl border border-warning/30 bg-warning/5">
            <div className="flex items-center gap-2 border-b border-warning/15 px-3.5 py-2">
                <span className="text-[12px] text-warning">?</span>
                <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[.09em] text-warning">
                    Questions for you
                </span>
                <div className="flex-1" />
                <span className="font-mono text-[10px] text-muted">{asks.length} waiting</span>
            </div>
            <div className="flex flex-col gap-2 px-3.5 py-3">
                {asks.map((a) => {
                    const key = childAskKey(a);
                    const agent = childAskAgent(a);
                    const answered = childAskSent(sent[key], a, events);
                    const ready = canSubmitAsk(agent.ask?.questions ?? [], selections[key] ?? {}, texts[key] ?? {});
                    return (
                        <div key={key} className="rounded-[9px] border border-warning/20 bg-background px-3 py-2.5">
                            <div className="font-mono text-[10px] text-ink-mid">{a.taskid}</div>
                            {a.note ? <div className="mt-1 text-[12px] text-secondary">{a.note}</div> : null}
                            <AnswerBar
                                agent={agent}
                                selections={selections[key] ?? {}}
                                texts={texts[key] ?? {}}
                                sent={answered}
                                showHint={false}
                                activeQuestion={activeQuestion[key] ?? 0}
                                onSelectQuestion={(qi) => setActiveQuestion((cur) => ({ ...cur, [key]: qi }))}
                                onToggle={(qi, oi) => toggleChildAnswer(a, qi, oi)}
                                onText={(qi, value) => setChildAnswerText(a, qi, value)}
                                onSubmit={() => submitChildAnswer(channelId, runId, a)}
                            />
                            {errors[key] ? <div className="mt-2 text-[11px] text-warning">{errors[key]}</div> : null}
                            {answered ? null : (
                                <button
                                    type="button"
                                    disabled={!ready}
                                    onClick={() => submitChildAnswer(channelId, runId, a)}
                                    className="mt-2 cursor-pointer rounded-md border border-edge-mid bg-surface-hover px-2.5 py-1 text-[11.5px] font-semibold text-secondary hover:border-accent/60 hover:text-primary disabled:cursor-default disabled:opacity-40"
                                >
                                    Send answer
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
