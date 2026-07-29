// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A record's thread region. The record's own fields live in the band above; this is its activity — the
// runs attributed to it and the decisions appended to it.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { runStatusView } from "@/app/view/agents/runmodel";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Brain } from "lucide-react";
import { DecisionLog } from "./decisionlog";
import { isAnswerTurn } from "./jarviscontract";
import { conversationsByIdAtom, retryJarvisQuery } from "./jarvisstore";
import { recordRunsAtom, sourceConversationAtom } from "./jarvissubjectstore";
import { JarvisAnswer, JarvisUserTurn } from "./jarvisturn";

const RUN_TONE: Record<string, string> = {
    running: "text-success",
    done: "text-muted",
    blocked: "text-warning",
    failed: "text-error",
    cancelled: "text-ink-faint",
};

export function RecordThread({ detail, model }: { detail: DossierDetail | null; model: AgentsViewModel }) {
    const byRecord = useAtomValue(recordRunsAtom);
    const convIdBySource = useAtomValue(sourceConversationAtom);
    const convsById = useAtomValue(conversationsByIdAtom);
    const runs = detail != null ? (byRecord[detail.id] ?? []) : [];
    // a record's thread is the one attached to its own oref — the same key askAboutRecord writes.
    const conversation = detail != null ? convsById[convIdBySource["task:" + detail.id] ?? ""] : undefined;
    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 pb-2.5 pt-4">
            <div className="flex items-center gap-2.5">
                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                    Record activity
                </span>
                <div className="h-px flex-1 bg-border" />
                <span className="font-mono text-[10.5px] text-muted">no phases — a record does not run</span>
            </div>
            {detail == null ? (
                <div className="text-[13px] text-muted">Loading…</div>
            ) : (
                <>
                    <div className="flex flex-col gap-2">
                        <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                            Runs attributed to this record
                        </span>
                        {runs.length === 0 ? (
                            <div className="rounded-[10px] border border-dashed border-border px-3 py-2.5 text-[12.5px] text-muted">
                                No run is attributed to this record yet.
                            </div>
                        ) : (
                            <div className="flex flex-col gap-1.5">
                                {runs.map((r) => {
                                    const view = runStatusView(r.status);
                                    return (
                                        <div
                                            key={r.id}
                                            className="flex items-center gap-2.5 rounded-[10px] border border-border bg-surface px-3 py-2"
                                        >
                                            <span className="flex-none font-mono text-[10.5px] text-muted">
                                                {r.id.slice(0, 8)}
                                            </span>
                                            <span className="min-w-0 flex-1 truncate text-[12.5px] text-secondary">
                                                {r.goal}
                                            </span>
                                            <span
                                                className={cn(
                                                    "flex-none font-mono text-[10px]",
                                                    RUN_TONE[view.tone] ?? "text-accent-soft"
                                                )}
                                            >
                                                {view.label}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                    <div className="flex flex-col gap-2">
                        <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                            Decisions · append-only
                        </span>
                        <DecisionLog decisions={detail.decisions ?? []} dossierId={detail.id} />
                    </div>
                    {/* asking Jarvis about a record lands here, drawn by the one shared turn renderer */}
                    {conversation != null && conversation.turns.length > 0 ? (
                        <div className="flex flex-col gap-4 border-t border-border pt-3.5">
                            {conversation.turns.map((turn, i) =>
                                isAnswerTurn(turn) ? (
                                    <div key={i} className="flex gap-3">
                                        <Brain size={18} strokeWidth={1.8} className="mt-1 shrink-0 text-accent" />
                                        <JarvisAnswer
                                            turn={turn}
                                            model={model}
                                            onRetry={() => retryJarvisQuery(conversation.id, i)}
                                        />
                                    </div>
                                ) : (
                                    <JarvisUserTurn key={i} text={turn.text} />
                                )
                            )}
                        </div>
                    ) : null}
                </>
            )}
        </div>
    );
}
