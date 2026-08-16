// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Child-ask mirror card: the pending asks of the selected run's dag, rendered on the run surface so a
// question raised by a headless child is answerable where the human actually looks. Children block on
// one ask at a time; answering here delivers through the dag answer path (the child resumes).

import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { answerChildAsk, bindChildAsks, childAsksAtom } from "./childaskstore";

export function ChildAskCard({ channelId, runId }: { channelId: string; runId: string }) {
    const asks = useAtomValue(childAsksAtom);
    useEffect(() => {
        bindChildAsks(channelId, runId);
    }, [channelId, runId]);
    if (asks.length === 0) {
        return null;
    }
    return (
        <div className="mb-4 overflow-hidden rounded-xl border border-warning/30 bg-warning/5">
            <div className="flex items-center gap-2 border-b border-warning/15 px-3.5 py-2">
                <span className="text-[12px] text-warning">?</span>
                <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[.09em] text-warning">
                    Children are asking
                </span>
                <div className="flex-1" />
                <span className="font-mono text-[10px] text-muted">
                    {asks.length} pending · answer here or `wsh jarvis dag asks`
                </span>
            </div>
            <div className="flex flex-col gap-2 px-3.5 py-3">
                {asks.map((a) => (
                    <div key={a.taskid} className="rounded-[9px] border border-warning/20 bg-background px-3 py-2.5">
                        <div className="font-mono text-[10px] text-ink-mid">{a.taskid}</div>
                        <div className="mt-0.5 text-[13px] font-semibold text-primary">{a.question}</div>
                        {(a.options ?? []).length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                                {(a.options ?? []).map((o, i) => (
                                    <button
                                        key={o.label + i}
                                        type="button"
                                        onClick={() =>
                                            answerChildAsk(channelId, runId, a.taskid, [{ selectedindexes: [i] }])
                                        }
                                        className="cursor-pointer rounded-md border border-edge-mid bg-surface-hover px-2.5 py-1 text-[11.5px] font-semibold text-secondary hover:border-accent/60 hover:text-primary"
                                    >
                                        {o.label}
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <div className="mt-2 font-mono text-[10px] text-muted">
                                answer with wsh jarvis dag answer {a.taskid} (text)
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
