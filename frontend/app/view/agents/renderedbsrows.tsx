// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Rendered transcript's own rows for brainstorm entries: an answer Arc sent folds to its question and pick with
// where it was picked (opening read-only to the question's options), an answer only the file's history knows reads as
// answered, a canvas mark line is a bubble with its crop, and the brainstorm's pane-action lines draw at the column's
// compact sizes. renderedbsrowsmodel.ts decides which; this draws it, and the pinned bar's one-line read of each.

import { turnTransition } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { useLocalImage } from "@/app/view/jarvis/localimage";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Check, ChevronDown, Lightbulb } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { openPaneTab } from "./agentpanes";
import type { AgentsViewModel } from "./agents";
import type { AgentEntry, AgentVM } from "./agentsviewmodel";
import { arcMessageOf } from "./arcmessage";
import { ArcMessageRow } from "./arcmessagerow";
import { brainstormAnswersAtom, brainstormAtom, getBrainstorm, openBrainstormAt } from "./brainstormstore";
import { boardLabel, canvasDir, canvasFeedbackFile } from "./canvasmodel";
import { attachCanvas, canvasStateAtom } from "./canvasstore";
import { COMPACT_CARD_PX } from "./renderedbrainstormmodel";
import { entryRowView, type EntryRowView } from "./renderedbsrowsmodel";
import { useTranscriptContext } from "./transcriptcontext";

const ORIGIN_WORDS = { transcript: "picked here", pane: "picked in the brainstorm pane" } as const;
const NO_RECORDS: never[] = [];

type AnswerView = Extract<EntryRowView, { kind: "answer" }>;
type MarkView = Extract<EntryRowView, { kind: "mark" }>;

// the rows sit in the timeline, which never runs compact in Rendered, so each measures the column as the card host does
function Measured({ children }: { children: (compact: boolean) => ReactNode }) {
    const [ref, , rect] = useDimensionsWithCallbackRef<HTMLDivElement>();
    const compact = rect != null && rect.width < COMPACT_CARD_PX;
    return (
        <div ref={ref} data-rbs-compact={compact ? "" : undefined}>
            {children(compact)}
        </div>
    );
}

function OptionList({ view, compact }: { view: AnswerView; compact: boolean }) {
    return (
        <div className={cn("flex flex-col", compact ? "gap-1" : "gap-1.5")}>
            {view.options.map((o, i) => (
                <div
                    key={i}
                    data-rbs-option
                    data-picked={o.picked ? "" : undefined}
                    className={cn("flex min-w-0 items-baseline gap-2.5", o.picked ? "text-foreground" : "text-ink-mid")}
                >
                    <span className="flex h-lh w-3 shrink-0 items-center justify-center self-start">
                        {o.picked ? <Check size={12} strokeWidth={2.8} className="text-success" aria-hidden /> : null}
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                        <span className={cn(o.picked && "font-semibold")}>{o.label}</span>
                        {o.detail ? <span className="text-muted [overflow-wrap:anywhere]">{o.detail}</span> : null}
                    </span>
                </div>
            ))}
            {view.ownWords != null ? (
                <div data-rbs-own-words className="text-ink-mid [overflow-wrap:anywhere]">
                    In your words: <span className="text-foreground">{view.ownWords}</span>
                </div>
            ) : null}
        </div>
    );
}

// the folded answer's line: the question it answers and the pick; the pinned bar draws it alone
function AnswerSummary({ view, compact }: { view: AnswerView; compact: boolean }) {
    return (
        <>
            <Lightbulb size={15} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />
            <span
                data-rbs-answer-kind
                className={cn("shrink-0 text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}
            >
                {view.builder ? "Builder question" : `Question ${view.n}`}
            </span>
            <span
                className={cn("min-w-0 truncate font-normal text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}
            >
                {view.question}
            </span>
            <span className="flex-1" />
            <Check size={12} strokeWidth={2.8} className="shrink-0 text-success" aria-hidden />
            <span
                data-rbs-answer
                className={cn(
                    "max-w-[40%] shrink-0 truncate font-semibold text-foreground",
                    compact ? "text-[12.5px]" : "text-[13.5px]"
                )}
            >
                {view.answer}
            </span>
        </>
    );
}

// one answered question, folded to its pick and where it was picked; opened, read-only, to the question, its why and its
// options with the pick marked (decision 4): answering again is the pane's
function FoldedAnswer({ view, compact }: { view: AnswerView; compact: boolean }) {
    const [open, setOpen] = useState(false);
    return (
        <div
            data-rbs-row="answer"
            data-origin={view.origin}
            className={cn("rounded-[10px] border border-edge-mid font-sans", compact ? "my-2" : "my-3")}
        >
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className={cn(
                    "flex w-full min-w-0 cursor-pointer items-center text-left",
                    compact ? "gap-2 px-2.5 py-2" : "gap-2.5 px-4 py-2.5"
                )}
            >
                <AnswerSummary view={view} compact={compact} />
                <span
                    className={cn("shrink-0 whitespace-nowrap text-muted", compact ? "text-[11.5px]" : "text-[12px]")}
                >
                    {ORIGIN_WORDS[view.origin]}
                </span>
                <ChevronDown
                    size={13}
                    strokeWidth={2}
                    style={turnTransition}
                    className={cn(
                        "shrink-0 text-muted transition-transform motion-reduce:transition-none",
                        open && "rotate-180"
                    )}
                    aria-hidden
                />
            </button>
            <PaneReveal open={open}>
                <div
                    data-rbs-answer-body
                    className={cn(
                        "flex flex-col border-t border-edge-faint",
                        compact ? "gap-2 px-2.5 py-2 text-[12px]" : "gap-2.5 px-3.5 py-3 text-[13px]"
                    )}
                >
                    <div className="flex flex-col gap-1">
                        <span className="font-semibold text-foreground [overflow-wrap:anywhere]">{view.question}</span>
                        {view.why ? <span className="text-ink-mid [overflow-wrap:anywhere]">{view.why}</span> : null}
                    </div>
                    <OptionList view={view} compact={compact} />
                </div>
            </PaneReveal>
        </div>
    );
}

// an answer the file's history holds but no record does: Arc cannot say where it was given, so it claims no place
function AnsweredRow({ n, answer, compact }: { n: number; answer: string; compact: boolean }) {
    return (
        <div
            data-rbs-row="answered"
            className={cn(
                "flex min-w-0 items-center justify-center gap-2 py-0.5 font-sans text-muted",
                compact ? "my-2 text-[12px]" : "my-3 text-[12.5px]"
            )}
        >
            <AnsweredSummary n={n} answer={answer} />
        </div>
    );
}

function AnsweredSummary({ n, answer }: { n: number; answer: string }) {
    return (
        <>
            <Lightbulb size={13} strokeWidth={2} className="shrink-0" aria-hidden />
            <span className="shrink-0">You answered question {n}:</span>
            <span className="min-w-0 truncate text-secondary">{answer}</span>
        </>
    );
}

// where the agent's project is, for a canvas it may not have attached: its canvas's, else its brainstorm's
function projectDirOf(agent: AgentVM, canvas: string, canvasTopic: string | null, canvasProject: string | null) {
    if (canvasTopic === canvas && canvasProject != null) return canvasProject;
    return getBrainstorm(agent.id)?.cwd ?? agent.cwd ?? null;
}

// the board the mark was made on: the canvas window on it when the canvas is the brainstorm's, else the Canvas tab
// beside the transcript
function openMarkedBoard(agent: AgentVM, view: MarkView, projectDir: string) {
    if (getBrainstorm(agent.id)?.file?.canvas === view.canvas) {
        openBrainstormAt(agent.id, { board: view.board });
        return;
    }
    const now = Date.now();
    attachCanvas(
        agent.id,
        { topic: view.canvas, dir: canvasDir(projectDir, view.canvas), projectDir, board: view.board },
        now
    );
    openPaneTab(agent.id, "canvas", now);
}

// the mark's crop URL, its board's label and how to open the board at it, for the bubble and the pinned bar
function useMark(view: MarkView, agent: AgentVM) {
    const c = useAtomValue(canvasStateAtom(agent.id));
    const projectDir = projectDirOf(agent, view.canvas, c?.topic ?? null, c?.projectDir ?? null);
    // read as a blob: the packaged app's CSP img-src does not take the canvas route's http url
    const { url } = useLocalImage(
        projectDir == null ? null : canvasFeedbackFile(canvasDir(projectDir, view.canvas), view.file)
    );
    const board = boardLabel(view.board);
    const open = projectDir != null ? () => openMarkedBoard(agent, view, projectDir) : undefined;
    return { url, board, open };
}

// a mark sent from the canvas: a user bubble with the marked crop and the note, and where it was made
function MarkBubble({ view, agent, compact }: { view: MarkView; agent: AgentVM; compact: boolean }) {
    const { url, board, open } = useMark(view, agent);
    return (
        <div
            data-rbs-row="mark"
            className={cn("flex flex-col items-end gap-[5px] font-sans", compact ? "my-3.5 ml-7" : "my-6")}
        >
            <div
                className={cn(
                    "flex max-w-[82%] flex-col bg-surface-hover",
                    compact ? "gap-2 rounded-[10px] px-[11px] py-2" : "gap-2.5 rounded-[12px] px-3 pt-2.5 pb-[11px]"
                )}
            >
                <button
                    type="button"
                    data-rbs-crop
                    title={`Open ${board} in the canvas at this mark`}
                    disabled={open == null}
                    onClick={open}
                    className="block cursor-pointer self-start overflow-hidden rounded-[6px] border-2 border-accent bg-background p-0 disabled:cursor-default"
                >
                    {url != null ? (
                        <img
                            src={url}
                            alt={`The mark on ${board}`}
                            className={cn(
                                "block h-auto w-auto",
                                compact ? "max-h-[120px] max-w-[220px]" : "max-h-[160px] max-w-[300px]"
                            )}
                        />
                    ) : (
                        <span className={cn("block", compact ? "h-[56px] w-[220px]" : "h-[76px] w-[300px]")} />
                    )}
                </button>
                {view.note != null ? (
                    <span
                        data-rbs-note
                        className={cn(
                            "leading-[1.55] text-foreground [overflow-wrap:anywhere]",
                            compact ? "text-[13px]" : "text-[14px]"
                        )}
                    >
                        {view.note}
                    </span>
                ) : null}
            </div>
            <span className={cn("text-muted", compact ? "text-[11.5px]" : "text-[12px]")}>
                marked on{" "}
                <button
                    type="button"
                    disabled={open == null}
                    onClick={open}
                    className="cursor-pointer border-0 bg-transparent p-0 text-accent-soft hover:underline disabled:cursor-default"
                >
                    {board}
                </button>{" "}
                · {view.canvas}
            </span>
        </div>
    );
}

function EntryRow({ view, agent, compact }: { view: EntryRowView; agent: AgentVM; compact: boolean }) {
    switch (view.kind) {
        case "answer":
            return <FoldedAnswer view={view} compact={compact} />;
        case "answered":
            return <AnsweredRow n={view.n} answer={view.answer} compact={compact} />;
        case "mark":
            return <MarkBubble view={view} agent={agent} compact={compact} />;
    }
}

// a pinned mark: its crop small, the note and where it was made, on one line
function PinnedMark({ view, agent }: { view: MarkView; agent: AgentVM }) {
    const { url, board } = useMark(view, agent);
    return (
        <>
            {url != null ? (
                <img
                    src={url}
                    alt={`The mark on ${board}`}
                    className="block h-[18px] w-auto max-w-[48px] shrink-0 rounded-[3px] border border-accent object-cover"
                />
            ) : (
                <span className="block h-[18px] w-[32px] shrink-0 rounded-[3px] border border-accent" />
            )}
            {view.note != null ? <span className="min-w-0 truncate text-foreground">{view.note}</span> : null}
            <span className="shrink-0 whitespace-nowrap text-muted">
                marked on {board} · {view.canvas}
            </span>
        </>
    );
}

// the pinned bar's line for a prompt the transcript draws as its own row, read as that row reads
export function PinnedRow({ view, agent }: { view: EntryRowView; agent: AgentVM }) {
    switch (view.kind) {
        case "answer":
            return <AnswerSummary view={view} compact={true} />;
        case "answered":
            return <AnsweredSummary n={view.n} answer={view.answer} />;
        case "mark":
            return <PinnedMark view={view} agent={agent} />;
    }
}

// which row the transcript draws for an entry, from the agent's brainstorm and its answer records
export function useEntryRowView(agent: AgentVM): (entry: AgentEntry) => EntryRowView | null {
    const s = useAtomValue(brainstormAtom(agent.id));
    const all = useAtomValue(brainstormAnswersAtom);
    const records = s != null ? (all[s.path] ?? NO_RECORDS) : NO_RECORDS;
    const file = s?.file ?? null;
    return useCallback((entry: AgentEntry) => entryRowView(entry, records, file), [records, file]);
}

export function useRenderedEntryRow(
    model: AgentsViewModel,
    agent: AgentVM,
    rowOf: (entry: AgentEntry) => EntryRowView | null
): (entry: AgentEntry, index: number) => ReactNode | null {
    const ctx = useTranscriptContext(model, agent);
    return useCallback(
        (entry: AgentEntry, _index: number): ReactNode | null => {
            const view = rowOf(entry);
            if (view != null) {
                return <Measured>{(compact) => <EntryRow view={view} agent={agent} compact={compact} />}</Measured>;
            }
            // the brainstorm's own lines (pane actions, the judge, the builder check) as everywhere, at the column's size
            const message = entry.kind === "user" ? arcMessageOf(entry, false) : null;
            if (message?.kind === "brainstorm") {
                return (
                    <Measured>{(compact) => <ArcMessageRow message={message} ctx={ctx} compact={compact} />}</Measured>
                );
            }
            return null;
        },
        [rowOf, ctx, agent]
    );
}
