// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The effort detail Stage subject: the full record — every chunk trail, owner, workref, and the
// same edit ops the inline tracker has, untruncated. A settled chunk's trail folds to its newest
// note behind a count, which is the only thing here that isn't shown outright.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatAge } from "@/app/view/agents/agentsviewmodel";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { Mark, REVEAL_ON_HOVER, StageHeader, StageTag } from "./effortcard";
import { buildEffortCard, CHUNK_CHIP_CLASSES, chunkTrailView, groupChunksByStage, stageOptions } from "./effortmodel";
import {
    addChunkOp,
    advanceChunk,
    appendChunkNote,
    effortChunkRows,
    effortDetailAtom,
    effortSummaryOf,
    loadEffortDetail,
    reopenChunk,
    setChunkStage,
    type ChunkRowModel,
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

// The full-record row: no truncation pressure here, so unlike the card's row it keeps the spelled-out
// status chip alongside the mark.
function ChunkDetailRow({
    row,
    agents,
    divider,
    options,
    onReopen,
    onStage,
}: {
    row: ChunkRowModel;
    agents: { id: string; name: string }[];
    divider: boolean;
    options: string[];
    onReopen: () => void;
    onStage: (stage: string) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const trail = chunkTrailView(row, expanded);
    const earlier = row.trail.length - 1;
    return (
        <div
            className={cn(
                "group flex flex-col gap-0.5 rounded-[8px] px-2.5 py-2",
                divider && "border-t border-edge-faint"
            )}
        >
            <div className="flex items-center gap-2.5">
                <Mark tone={row.tone} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-primary">{row.label}</span>
                <StageTag stage={row.stage} options={options} onCommit={onStage} />
                {row.status === "done" ? (
                    <button
                        type="button"
                        onClick={onReopen}
                        className={cn(
                            "cursor-pointer rounded-[4px] border border-border px-1.5 py-[1px] font-mono text-[9px] text-muted hover:text-primary",
                            REVEAL_ON_HOVER
                        )}
                    >
                        reopen
                    </button>
                ) : null}
                <span
                    className={cn(
                        "flex-none rounded-[4px] px-[5px] py-[1px] font-mono text-[9px] font-semibold uppercase",
                        CHUNK_CHIP_CLASSES[row.tone]
                    )}
                >
                    {row.status}
                </span>
            </div>
            {row.owner != null ? (
                <span className="pl-[22px] font-mono text-[10px] text-muted">owner: {row.owner}</span>
            ) : null}
            {row.workrefs.length > 0 ? (
                <span className="flex flex-col pl-[22px]">
                    {row.workrefs.map((w) => (
                        <span key={w.oref} title={w.oref} className="font-mono text-[10px] text-accent-soft">
                            {workrefLabel(w, agents)} · {formatAge(Date.now() - w.ts)}
                        </span>
                    ))}
                </span>
            ) : null}
            {row.trail.length > 0 ? (
                <div className="flex flex-col gap-2 pt-1 pl-[22px]">
                    {trail.hidden > 0 || expanded ? (
                        <button
                            type="button"
                            onClick={() => setExpanded(!expanded)}
                            aria-expanded={expanded}
                            className="w-fit cursor-pointer font-mono text-xxs text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            {`${expanded ? "▾" : "▸"} ${earlier} earlier ${earlier === 1 ? "note" : "notes"}`}
                        </button>
                    ) : null}
                    {trail.notes.map((n, j) => (
                        <div key={n.ts + ":" + j} className="flex gap-2.5">
                            <span className="w-[34px] flex-none pt-[2px] font-mono text-xxs text-muted">
                                {fmtDay(n.ts)}
                            </span>
                            {/* a measure cap, not a width: these notes run to paragraphs and the Stage is
                                wide enough to set them 180 characters to the line without one. */}
                            <span className="min-w-0 max-w-[72ch] whitespace-pre-wrap text-[12px] leading-[1.6] text-secondary">
                                {n.text}
                            </span>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
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
    const options = stageOptions(rows);

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
                            {groupChunksByStage(rows).map((g, gi) => (
                                <div key={g.stage + ":" + gi} className="flex flex-col">
                                    {/* every run gets a header: an unstaged one renders as "+ stage",
                                        which both separates it and is the way to name it. */}
                                    <StageHeader
                                        stage={g.stage}
                                        fraction={g.fraction}
                                        options={options}
                                        onCommit={(next) =>
                                            void runMutation(() =>
                                                setChunkStage(
                                                    "effort:" + effort.oid,
                                                    g.rows.map((r) => r.label),
                                                    next
                                                )
                                            )
                                        }
                                    />
                                    {g.rows.map((r, i) => (
                                        <ChunkDetailRow
                                            key={r.label}
                                            row={r}
                                            agents={agents}
                                            divider={i > 0}
                                            options={options}
                                            onReopen={() =>
                                                void runMutation(() => reopenChunk("effort:" + effort.oid, r.label))
                                            }
                                            // the run tail: this chunk down to the next stage boundary
                                            onStage={(next) =>
                                                void runMutation(() =>
                                                    setChunkStage(
                                                        "effort:" + effort.oid,
                                                        g.rows.slice(i).map((x) => x.label),
                                                        next
                                                    )
                                                )
                                            }
                                        />
                                    ))}
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
