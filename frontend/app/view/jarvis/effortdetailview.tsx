// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The effort detail Stage subject: the full record — every chunk trail, owner, workref, and the
// same edit ops the inline tracker has, at full width with no truncation.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatAge } from "@/app/view/agents/agentsviewmodel";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { Mark } from "./effortcard";
import { buildEffortCard, CHUNK_CHIP_CLASSES } from "./effortmodel";
import {
    addChunkOp,
    advanceChunk,
    appendChunkNote,
    effortChunkRows,
    effortDetailAtom,
    effortSummaryOf,
    loadEffortDetail,
    reopenChunk,
} from "./effortstore";
import { activeSubjectAtom } from "./jarvissubjectstore";
import { ProgressBar } from "./progressbar";
import { STAGE_GUTTER, STAGE_SCROLLER } from "./stagemeasure";

const fmtDay = (ts: number): string => {
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// a workref names who is on the chunk: the agent's name when the roster knows the tab, else the oref.
function workrefLabel(ref: ChunkWorkRef, agents: { id: string; name: string }[]): string {
    if (ref.kind === "agent") {
        const tabid = ref.oref.replace(/^agent:/, "");
        const name = agents.find((a) => a.id === tabid)?.name;
        return name != null ? `${name} working here` : ref.oref;
    }
    return ref.oref;
}

export function EffortDetailView({ model }: { model: AgentsViewModel }) {
    const subject = useAtomValue(activeSubjectAtom);
    const cache = useAtomValue(effortDetailAtom);
    const agents = useAtomValue(model.agentsAtom);
    const oref = subject?.kind === "effort" ? "effort:" + subject.id : null;
    const effort = oref != null ? (cache.get(oref) ?? null) : null;
    const [error, setError] = useState<string | null>(null);
    const [addingChunk, setAddingChunk] = useState(false);
    const [noting, setNoting] = useState(false);
    const [chunkDraft, setChunkDraft] = useState("");
    const [noteDraft, setNoteDraft] = useState("");
    const [mutateError, setMutateError] = useState<string | null>(null);

    // the subject selection warms the cache; this effect covers direct mounts and retries.
    useEffect(() => {
        if (oref == null || effort != null) {
            return;
        }
        let cancelled = false;
        setError(null);
        loadEffortDetail(oref).catch((e) => {
            if (!cancelled) {
                setError(e instanceof Error ? e.message : String(e));
            }
        });
        return () => {
            cancelled = true;
        };
    }, [oref, effort]);

    const runMutation = async (fn: () => Promise<void>): Promise<void> => {
        setMutateError(null);
        try {
            await fn();
        } catch (e) {
            setMutateError(e instanceof Error ? e.message : String(e));
        }
    };

    const retry = (): void => {
        if (oref == null) {
            return;
        }
        setError(null);
        void loadEffortDetail(oref).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    };

    const card = effort != null ? buildEffortCard(effortSummaryOf(effort)) : null;
    const rows = effort != null ? effortChunkRows(effort) : [];

    const submitChunk = (): void => {
        const label = chunkDraft.trim();
        if (label === "" || oref == null) {
            return;
        }
        setChunkDraft("");
        setAddingChunk(false);
        void runMutation(() => addChunkOp(oref, label));
    };
    const submitNote = (): void => {
        const text = noteDraft.trim();
        if (text === "" || oref == null) {
            return;
        }
        setNoteDraft("");
        setNoting(false);
        void runMutation(() => appendChunkNote(oref, card?.activeChunk ?? null, text));
    };

    return (
        <div className={cn(STAGE_SCROLLER, "min-h-0 flex-1")}>
            <div className={cn(STAGE_GUTTER, "flex flex-col gap-4 py-4")} aria-live="polite">
                {error != null ? (
                    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface px-4 py-3">
                        <span className="text-[13px] font-semibold text-primary">Couldn't load this initiative.</span>
                        <span className="text-[12px] text-secondary">{error}</span>
                        <button
                            type="button"
                            onClick={retry}
                            className="mt-1 w-fit cursor-pointer rounded-[7px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-primary"
                        >
                            Retry
                        </button>
                    </div>
                ) : null}
                {effort == null && error == null ? (
                    <div className="flex flex-col gap-4">
                        {["chunk", "chunk", "chunk"].map((_, i) => (
                            <div
                                key={i}
                                className="h-10 animate-pulse motion-reduce:animate-none rounded-[10px] bg-surface"
                            />
                        ))}
                    </div>
                ) : null}
                {effort != null && card != null ? (
                    <>
                        <div className="flex flex-col gap-1">
                            <div className="flex items-baseline gap-2">
                                <span className="truncate text-[15px] font-semibold text-primary">{effort.title}</span>
                                {effort.ticket != null ? (
                                    <span className="flex-none rounded-full bg-surface-raised px-[6px] py-[1px] font-mono text-[9.5px] text-muted">
                                        {effort.ticket}
                                    </span>
                                ) : null}
                                {effort.project != null ? (
                                    <span className="flex-none rounded-full bg-surface-raised px-[6px] py-[1px] font-mono text-[9.5px] text-muted">
                                        {effort.project}
                                    </span>
                                ) : null}
                                {effort.status === "archived" ? (
                                    <span className="flex-none rounded-full bg-surface-raised px-[6px] py-[1px] font-mono text-[9.5px] uppercase text-muted">
                                        archived
                                    </span>
                                ) : null}
                                <span className="ml-auto flex-none font-mono text-[10px] text-muted">
                                    updated {fmtDay(effort.updatedts)} · {card.countLine}
                                </span>
                            </div>
                            <ProgressBar pct={card.progressPct} className="mt-2" />
                        </div>
                        <div className="flex flex-col">
                            {rows.map((r, i) => (
                                <div
                                    key={r.label}
                                    className={cn(
                                        "group flex flex-col gap-0.5 rounded-[8px] px-2.5 py-2",
                                        i > 0 && "border-t border-edge-faint"
                                    )}
                                >
                                    <div className="flex items-center gap-2.5">
                                        <Mark tone={r.tone} />
                                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-primary">
                                            {r.label}
                                        </span>
                                        {r.status === "done" ? (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    void runMutation(() => reopenChunk("effort:" + effort.oid, r.label))
                                                }
                                                className="hidden cursor-pointer rounded-[4px] border border-border px-1.5 py-[1px] font-mono text-[9px] text-muted group-hover:block hover:text-primary"
                                            >
                                                reopen
                                            </button>
                                        ) : null}
                                        <span
                                            className={cn(
                                                "flex-none rounded-[4px] px-[5px] py-[1px] font-mono text-[9px] font-semibold uppercase",
                                                CHUNK_CHIP_CLASSES[r.tone]
                                            )}
                                        >
                                            {r.status}
                                        </span>
                                    </div>
                                    {r.owner != null ? (
                                        <span className="pl-[22px] font-mono text-[10px] text-muted">
                                            owner: {r.owner}
                                        </span>
                                    ) : null}
                                    {r.workrefs.length > 0 ? (
                                        <span className="flex flex-col pl-[22px]">
                                            {r.workrefs.map((w) => (
                                                <span
                                                    key={w.oref}
                                                    title={w.oref}
                                                    className="font-mono text-[10px] text-accent-soft"
                                                >
                                                    {workrefLabel(w, agents)} · {formatAge(Date.now() - w.ts)}
                                                </span>
                                            ))}
                                        </span>
                                    ) : null}
                                    {r.trail.length > 0 ? (
                                        <span className="flex flex-col gap-0.5 pl-[22px]">
                                            {r.trail.map((n, j) => (
                                                <span key={j} className="font-mono text-[10.5px] text-muted">
                                                    {fmtDay(n.ts)} {n.text}
                                                </span>
                                            ))}
                                        </span>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                disabled={card.activeChunk == null}
                                onClick={() => void runMutation(() => advanceChunk("effort:" + effort.oid))}
                                className="cursor-pointer rounded-[7px] bg-accent px-3 py-[5px] text-[11px] font-semibold text-background hover:bg-accenthover disabled:cursor-default disabled:opacity-40"
                            >
                                Mark active chunk done
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setAddingChunk(true);
                                    setNoting(false);
                                }}
                                className="cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[10px] text-secondary hover:border-accent hover:text-primary"
                            >
                                + chunk
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setNoting(true);
                                    setAddingChunk(false);
                                }}
                                className="cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[10px] text-secondary hover:border-accent hover:text-primary"
                            >
                                note
                            </button>
                            {addingChunk ? (
                                <input
                                    autoFocus
                                    value={chunkDraft}
                                    onChange={(e) => setChunkDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            submitChunk();
                                        } else if (e.key === "Escape") {
                                            setAddingChunk(false);
                                            setChunkDraft("");
                                        }
                                    }}
                                    placeholder="chunk label"
                                    className="w-44 rounded-[7px] border border-edge-mid bg-background px-2 py-1 text-[12px] text-primary outline-none focus:border-accent/60"
                                />
                            ) : null}
                            {noting ? (
                                <input
                                    autoFocus
                                    value={noteDraft}
                                    onChange={(e) => setNoteDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            submitNote();
                                        } else if (e.key === "Escape") {
                                            setNoting(false);
                                            setNoteDraft("");
                                        }
                                    }}
                                    placeholder={
                                        card.activeChunk != null
                                            ? `note on ${card.activeChunk}`
                                            : "initiative-level note"
                                    }
                                    className="w-64 rounded-[7px] border border-edge-mid bg-background px-2 py-1 text-[12px] text-primary outline-none focus:border-accent/60"
                                />
                            ) : null}
                            {mutateError != null ? <span className="text-[11px] text-error">{mutateError}</span> : null}
                        </div>
                    </>
                ) : null}
            </div>
        </div>
    );
}
