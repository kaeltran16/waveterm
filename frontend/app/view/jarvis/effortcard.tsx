// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The effort card. Collapsed: a single header line (tone square, title, meta, count, bar) over one to
// three status lines saying what is moving and what is stuck. Expanded: the inline chunk tracker with
// marks/trails, advance / + chunk / note actions, reopen on done rows, and the CLI handle.
//
// The toggle is a button INSIDE the card, not a button wrapping it: the expanded body has buttons of
// its own, and nesting those inside an outer button is invalid and cost a stopPropagation call on
// every one of them.

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useId, useState } from "react";
import {
    effortStatusLines,
    effortTone,
    groupChunksByStage,
    stageOptions,
    type ChunkTone,
    type EffortCardModel,
} from "./effortmodel";
import {
    addChunkOp,
    advanceChunk,
    appendChunkNote,
    effortChunkRows,
    effortDetailAtom,
    effortDetailErrorAtom,
    loadEffortDetail,
    reopenChunk,
    setChunkStage,
    setEffortStatus,
    type ChunkRowModel,
} from "./effortstore";
import { ProgressBar } from "./progressbar";

// Row controls reveal on hover but stay IN FLOW: `hidden` -> `group-hover:block` reflowed the row
// (measured at 118.7px of label shrink), which reads as a jitter under the cursor. Opacity also
// keeps them focusable — a display:none button cannot be tabbed to.
export const REVEAL_ON_HOVER =
    "opacity-0 transition-opacity duration-[140ms] group-hover:opacity-100 focus-visible:opacity-100";

const MARKS: Record<ChunkTone, string | null> = {
    done: "✓",
    active: "▶",
    blocked: "!",
    deferred: "⏸",
    skipped: "–",
    pending: null,
};

// the per-tone square that leads a chunk row; the active/blocked glows mark the states that need eyes.
export function Mark({ tone }: { tone: ChunkTone }) {
    const cls =
        tone === "done"
            ? "border-success/40 bg-success/15 text-success"
            : tone === "active"
              ? "border-accent/60 text-accent-soft shadow-[0_0_0_3px_var(--color-accentbg)]"
              : tone === "blocked"
                ? "border-asking/60 text-asking shadow-[0_0_0_3px_var(--color-askingbg)]"
                : tone === "deferred"
                  ? "border-dashed border-edge-strong text-muted"
                  : tone === "skipped"
                    ? "border-transparent text-ink-faint"
                    : "border-edge-strong";
    return (
        <span
            role="img"
            title={tone}
            aria-label={tone}
            className={cn(
                "flex h-[14px] w-[14px] flex-none items-center justify-center rounded-[4px] border leading-none",
                // U+25B6 fills its em box where the tick and dash do not, so at a shared size it
                // overflows the square; one size per tone keeps Tailwind from having to pick.
                tone === "active" ? "text-[7px]" : "text-xxxs",
                cls
            )}
        >
            {MARKS[tone]}
        </span>
    );
}

const TONE_FILL: Record<"blocked" | "done" | "active", string> = {
    blocked: "bg-asking",
    done: "bg-success",
    active: "bg-accent",
};

const LINE_FG: Record<ChunkTone, string> = {
    done: "text-success",
    active: "text-accent-soft",
    blocked: "text-asking",
    deferred: "text-muted",
    skipped: "text-ink-faint",
    pending: "text-muted",
};

const fmtDay = (ts: number): string => {
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// a small bordered action, the shape every secondary control in the expanded footer takes.
function FooterButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="cursor-pointer rounded-[6px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:border-edge-strong hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
            {children}
        </button>
    );
}

// The one stage editor, shared by the header and the per-row tag. The datalist turns "put this chunk
// in a stage that already exists" into a pick; typing a fresh name starts a new run; empty clears.
// No blur handler, matching the chunk/note inputs below: Enter commits, Escape cancels.
function StageInput({
    value,
    options,
    onCommit,
    onCancel,
}: {
    value: string;
    options: string[];
    onCommit: (stage: string) => void;
    onCancel: () => void;
}) {
    const [draft, setDraft] = useState(value);
    const listId = useId();
    return (
        <>
            <input
                autoFocus
                list={listId}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                        onCommit(draft.trim());
                    } else if (e.key === "Escape") {
                        onCancel();
                    }
                }}
                placeholder="stage name (empty clears)"
                className="w-44 flex-none rounded-[7px] border border-edge-mid bg-background px-2 py-[2px] text-[12px] text-primary outline-none focus:border-accent/60"
            />
            <datalist id={listId}>
                {options.map((o) => (
                    <option key={o} value={o} />
                ))}
            </datalist>
        </>
    );
}

// The line above a run of chunks, wearing the cockpit's own group-header chrome (SectionHead in
// briefingview.tsx): mono uppercase tracked label, count pill, hairline rule. Matching that idiom is
// the whole point — a stage is the same kind of thing as an "Initiatives" or "Waiting on you" heading,
// and the earlier bespoke "STAGE <Name>" version set the name SMALLER than the chunk labels beneath
// it, so the header read as less important than its own children.
//
// Unstaged runs get a "+ stage" in the same slot: it names the whole run in one gesture, and it is
// the only always-visible way in — without it stages are a CLI-only secret.
//
// A header is a divider, not a container: the rows under it stay in the same flat list, each keeping
// its own status and its own right to block. It carries no progress bar on purpose — the initiative
// header already owns one, and a second bar reads as a second denominator.
export function StageHeader({
    stage,
    fraction,
    options,
    onCommit,
}: {
    stage: string;
    fraction: string;
    options: string[];
    onCommit: (stage: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    // a commit that changes nothing would still stamp "stage set to X" on every chunk in the run.
    const commit = (next: string): void => {
        setEditing(false);
        if (next !== stage) {
            onCommit(next);
        }
    };
    return (
        <div className="flex items-center gap-2 px-1.5 pb-1 pt-[9px]">
            {editing ? (
                <StageInput value={stage} options={options} onCommit={commit} onCancel={() => setEditing(false)} />
            ) : (
                <button
                    type="button"
                    title={
                        stage === ""
                            ? "name this run of chunks as a stage"
                            : "rename this stage — every chunk under it moves together; empty clears it"
                    }
                    onClick={() => setEditing(true)}
                    className={cn(
                        "min-w-0 cursor-pointer truncate font-mono text-[9.5px] font-bold uppercase tracking-[.12em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                        stage === "" ? "text-muted hover:text-secondary" : "text-feed-label hover:text-secondary"
                    )}
                >
                    {stage === "" ? "+ stage" : stage}
                </button>
            )}
            {stage !== "" ? (
                <span className="flex-none rounded-full border border-edge-faint bg-surface-raised px-2 py-[1px] font-mono text-[9.5px] font-semibold text-muted">
                    {fraction}
                </span>
            ) : null}
            <span className="h-px min-w-3 flex-1 bg-edge-faint" />
        </div>
    );
}

// The per-chunk stage control, hover-revealed like `reopen` so the row stays quiet. It means "a stage
// STARTS here": it claims this chunk and the rest of its run, leaving the next run alone. That is what
// makes repeated use subdivide a flat plan — each click trims the stage the previous click set,
// so three clicks cut fourteen chunks into three stages instead of fourteen edits.
//
// The header is the other half: it renames the run it sits on, whole. Both write setChunkStage.
export function StageTag({
    stage,
    options,
    onCommit,
}: {
    stage: string;
    options: string[];
    onCommit: (stage: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    if (editing) {
        return (
            <StageInput
                value={stage}
                options={options}
                onCommit={(next) => {
                    setEditing(false);
                    if (next !== stage) {
                        onCommit(next);
                    }
                }}
                onCancel={() => setEditing(false)}
            />
        );
    }
    return (
        <button
            type="button"
            title={
                stage === ""
                    ? "start a stage here — claims this chunk and the rest of its run"
                    : "stage: " + stage + " — start a different stage from here down"
            }
            onClick={() => setEditing(true)}
            className={cn(
                "flex-none cursor-pointer rounded-[6px] border border-border px-2 py-[3px] font-mono text-[9.5px] text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                REVEAL_ON_HOVER
            )}
        >
            stage
        </button>
    );
}

// One chunk row. The uppercase status chip this row used to carry was redundant with the mark square
// and cost the label the width it needed — these labels run past a hundred characters in practice.
function ChunkRow({
    row,
    options,
    onAdvance,
    onReopen,
    onStage,
}: {
    row: ChunkRowModel;
    options: string[];
    onAdvance: () => void;
    onReopen: () => void;
    onStage: (stage: string) => void;
}) {
    return (
        <div
            className="group flex min-h-[30px] items-center gap-2.5 rounded-[7px] px-1.5 py-[2px] transition-colors duration-[140ms] hover:bg-surface-hover"
            title={row.trail.length > 0 ? row.trail.map((n) => `${fmtDay(n.ts)} ${n.text}`).join("\n") : undefined}
        >
            <Mark tone={row.tone} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-secondary">{row.label}</span>
            {row.latestNote != null ? (
                <span className="max-w-[30%] truncate text-right font-mono text-[9.5px] text-muted">
                    {row.latestNote}
                </span>
            ) : null}
            <StageTag stage={row.stage} options={options} onCommit={onStage} />
            {row.status === "active" ? (
                <button
                    type="button"
                    onClick={onAdvance}
                    className="flex-none cursor-pointer rounded-[6px] border border-accent/40 bg-surface-raised px-2.5 py-[3px] text-[11px] font-semibold text-accent-soft hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                    Mark done
                </button>
            ) : null}
            {row.status === "done" ? (
                <button
                    type="button"
                    onClick={onReopen}
                    className={cn(
                        "flex-none cursor-pointer rounded-[6px] border border-border px-2 py-[3px] font-mono text-[9.5px] text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                        REVEAL_ON_HOVER
                    )}
                >
                    reopen
                </button>
            ) : null}
        </div>
    );
}

export function EffortCard({
    model,
    expanded,
    onToggle,
    onOpenDetail,
}: {
    model: EffortCardModel;
    expanded: boolean;
    onToggle: () => void;
    onOpenDetail?: () => void;
}) {
    const oid = model.oref.replace(/^effort:/, "");
    const effort = useAtomValue(effortDetailAtom).get(model.oref);
    const detailError = useAtomValue(effortDetailErrorAtom).get(model.oref);
    const [addingChunk, setAddingChunk] = useState(false);
    const [noting, setNoting] = useState(false);
    const [chunkDraft, setChunkDraft] = useState("");
    const [noteDraft, setNoteDraft] = useState("");
    const [mutateError, setMutateError] = useState<string | null>(null);

    const rows = effort != null ? effortChunkRows(effort) : [];
    const options = stageOptions(rows);
    const lines = effortStatusLines(model);
    const meta = [model.ticket, model.project, model.parentoid != null ? "parent" : null].filter(Boolean).join(" · ");
    const progress = `${model.done}/${model.done + model.remaining}`;

    // one error surface for every mutate path; never silently swallow.
    const runMutation = async (fn: () => Promise<void>): Promise<void> => {
        setMutateError(null);
        try {
            await fn();
        } catch (e) {
            setMutateError(e instanceof Error ? e.message : String(e));
        }
    };

    const submitChunk = (): void => {
        const label = chunkDraft.trim();
        if (label === "") {
            return;
        }
        setChunkDraft("");
        setAddingChunk(false);
        void runMutation(() => addChunkOp(model.oref, label));
    };
    const submitNote = (): void => {
        const text = noteDraft.trim();
        if (text === "") {
            return;
        }
        setNoteDraft("");
        setNoting(false);
        void runMutation(() => appendChunkNote(model.oref, model.activeChunk ?? null, text));
    };

    return (
        <div className="rounded-[10px] border border-border bg-surface px-[13px] py-[11px]">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                aria-label={(expanded ? "Collapse " : "Expand ") + model.title}
                className="-mx-1.5 flex w-[calc(100%+0.75rem)] cursor-pointer items-center gap-2.5 rounded-[8px] px-1.5 py-1 text-left transition-colors duration-[140ms] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
                <span className="w-[11px] flex-none font-mono text-[9.5px] text-muted">{expanded ? "▾" : "▸"}</span>
                <span className={cn("h-[7px] w-[7px] flex-none rounded-[2px]", TONE_FILL[effortTone(model)])} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-primary">{model.title}</span>
                {meta !== "" ? <span className="flex-none font-mono text-[9.5px] text-muted">{meta}</span> : null}
                <span className="flex-none font-mono text-[9.5px] text-muted">{progress}</span>
                <ProgressBar pct={model.progressPct} className="w-[72px] flex-none" />
            </button>

            {expanded ? null : (
                <div className="mt-2 flex flex-col gap-0.5">
                    {lines.map((l) => (
                        <div key={l.mark + l.text} className="flex min-w-0 items-center gap-2.5 pl-[21px]">
                            <span
                                className={cn(
                                    "w-3 flex-none text-center font-mono text-[9.5px] font-bold",
                                    LINE_FG[l.tone]
                                )}
                            >
                                {l.mark}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[12.5px] text-secondary">{l.text}</span>
                            <span className="flex-none font-mono text-[9.5px] text-muted">{l.reading}</span>
                        </div>
                    ))}
                </div>
            )}

            {expanded ? (
                <div className="ml-4 mt-2 flex flex-col border-l border-border pl-3">
                    {effort == null ? (
                        detailError != null ? (
                            <span className="flex items-center gap-2 text-[11px] text-error">
                                {detailError}
                                <FooterButton onClick={() => void loadEffortDetail(model.oref)}>retry</FooterButton>
                            </span>
                        ) : (
                            <div className="h-10 animate-pulse motion-reduce:animate-none rounded-[8px] bg-surface-raised" />
                        )
                    ) : (
                        <>
                            {groupChunksByStage(rows).map((g, gi) => (
                                <div key={g.stage + ":" + gi} className="flex flex-col">
                                    <StageHeader
                                        stage={g.stage}
                                        fraction={g.fraction}
                                        options={options}
                                        onCommit={(next) =>
                                            void runMutation(() =>
                                                setChunkStage(
                                                    model.oref,
                                                    g.rows.map((r) => r.label),
                                                    next
                                                )
                                            )
                                        }
                                    />
                                    {g.rows.map((r, i) => (
                                        <ChunkRow
                                            key={r.label}
                                            row={r}
                                            options={options}
                                            onAdvance={() => void runMutation(() => advanceChunk(model.oref))}
                                            onReopen={() => void runMutation(() => reopenChunk(model.oref, r.label))}
                                            // the run tail: this chunk down to the next stage boundary
                                            onStage={(next) =>
                                                void runMutation(() =>
                                                    setChunkStage(
                                                        model.oref,
                                                        g.rows.slice(i).map((x) => x.label),
                                                        next
                                                    )
                                                )
                                            }
                                        />
                                    ))}
                                </div>
                            ))}
                            <div className="flex flex-wrap items-center gap-2 px-1.5 pb-0.5 pt-[7px]">
                                <FooterButton
                                    onClick={() => {
                                        setAddingChunk(true);
                                        setNoting(false);
                                    }}
                                >
                                    + chunk
                                </FooterButton>
                                <FooterButton
                                    onClick={() => {
                                        setNoting(true);
                                        setAddingChunk(false);
                                    }}
                                >
                                    Note
                                </FooterButton>
                                {/* no confirm: the efforts list's "show archived" toggle is the way back */}
                                <FooterButton
                                    onClick={() => void runMutation(() => setEffortStatus(model.oref, "archived"))}
                                >
                                    Archive
                                </FooterButton>
                                {addingChunk ? (
                                    <input
                                        autoFocus
                                        value={chunkDraft}
                                        onChange={(e) => setChunkDraft(e.target.value)}
                                        onKeyDown={(e) => {
                                            e.stopPropagation();
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
                                            e.stopPropagation();
                                            if (e.key === "Enter") {
                                                submitNote();
                                            } else if (e.key === "Escape") {
                                                setNoting(false);
                                                setNoteDraft("");
                                            }
                                        }}
                                        placeholder={
                                            model.activeChunk != null
                                                ? `note on ${model.activeChunk}`
                                                : "initiative-level note"
                                        }
                                        className="w-64 rounded-[7px] border border-edge-mid bg-background px-2 py-1 text-[12px] text-primary outline-none focus:border-accent/60"
                                    />
                                ) : null}
                                <button
                                    type="button"
                                    title="copy the CLI handle"
                                    onClick={() => void navigator.clipboard.writeText("wsh effort show " + oid)}
                                    className="cursor-pointer font-mono text-[9.5px] text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                >
                                    wsh effort show {oid}
                                </button>
                                <span className="flex-1" />
                                {onOpenDetail != null ? (
                                    <button
                                        type="button"
                                        onClick={onOpenDetail}
                                        className="cursor-pointer font-mono text-[9.5px] font-semibold text-accent-soft hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                    >
                                        full record →
                                    </button>
                                ) : null}
                            </div>
                            <span className="px-1.5 font-mono text-[9.5px] text-ink-faint">
                                hover a row for its trail · reopen on done rows · a stage header renames its run, a row
                                starts one
                            </span>
                        </>
                    )}
                </div>
            ) : null}
            {mutateError != null ? <span className="mt-2 block text-[11px] text-error">{mutateError}</span> : null}
        </div>
    );
}
