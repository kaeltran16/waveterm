// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Agent surface center's Rendered mode: the focused claude agent's live transcript as a readable timeline,
// with a message box that drives the same pty the terminal shows. The terminal block stays mounted beside it.
// The working line is the timeline's tail, under the messages still waiting on the agent; once your last prompt has
// scrolled out of view, a bar pinned at the top holds it. A file path in a reply opens in a File tab of the workspace
// pane beside the transcript.

import { cardVariants, composerReveal } from "@/app/element/motiontokens";
import { PopoverReveal } from "@/app/element/popoverreveal";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUp } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { interruptAgent } from "./agentactions";
import type { AgentComposerHandle } from "./agentcomposer";
import type { AgentsViewModel } from "./agents";
import { askSentKey, type AgentEntry, type AgentVM } from "./agentsviewmodel";
import { AnswerBar } from "./answerbar";
import { showEarlierTranscript } from "./livetranscript";
import { earlierAtomFor, entriesAtomFor, waitingAtomFor } from "./livetranscriptatoms";
import { FileLinkContext } from "./markdownmessage";
import { CommandChip, NarrationTimeline, PersonBubble } from "./narrationtimeline";
import { useWorkingTail } from "./nowlineview";
import { PermissionBand } from "./permissionband";
import { anchorMarks } from "./permissionmodel";
import { permissionLogAtom } from "./permissionstore";
import { lastPrompt, pinnedPrompt, samePin, type PinnedPrompt, type RowOf } from "./pinnedprompt";
import { footList, type FootItem } from "./queuedprompts";
import { NeedsInputPill, RenderedBrainstorm } from "./renderedbrainstorm";
import { PinnedRow, useEntryRowView, useRenderedEntryRow } from "./renderedbsrows";
import { RenderedComposer } from "./renderedcomposer";
import { askDocked, isPickerCommand, pickerFlipAtom, shouldUnflip } from "./renderedmode";
import type { ReplyFileLink } from "./replyfilelinks";
import { getLastHookAtom } from "./session-models/agentstatusstore";
import { ShowEarlier } from "./showearlier";
import { JumpToLatestPill, useStickToBottom } from "./sticktobottom";
import { useTranscriptContext, type TranscriptContext } from "./transcriptcontext";
import { lastCanvasReveal } from "./transcriptlayout";
import { TranscriptSkeleton } from "./transcriptskeleton";
import { openBeside } from "./workspacestore";

// the transcript column's measure, and the pinned bar's (the Working board)
const COLUMN = "mx-auto w-full max-w-[736px]";
// the transcript column, shared with an ended worker's read-back. Only a markdown message's top-level text blocks keep
// a reading measure; cards, code and diffs use the width
export const TRANSCRIPT_COLUMN = `${COLUMN} flex min-h-full flex-col [&_.agent-md>:is(p,ul,ol,h1,h2,h3,h4,h5,h6,blockquote)]:max-w-[75ch]`;

// a reply's file link opens the file in a File tab of the workspace pane, landed on the cited line. openBeside
// declines only off the Agent surface or outside Rendered, where this view is not on screen to be clicked
function useReplyFileLink(model: AgentsViewModel, agent: AgentVM) {
    return useCallback(
        (link: ReplyFileLink) => {
            openBeside(model, agent.id, { kind: "file", path: link.path, line: link.line });
        },
        [model, agent.id]
    );
}

// A picker the composer flipped to the terminal has closed once the agent's next prompt-boundary hook lands. Called
// by the surface, not the view, because the view is unmounted while the flip holds the terminal.
export function useUnflipOnPrompt(agent: AgentVM | undefined) {
    const flipAtom = pickerFlipAtom(agent?.id ?? "");
    const flipTs = useAtomValue(flipAtom);
    const last = useAtomValue(getLastHookAtom(agent?.blockId ? `block:${agent.blockId}` : ""));
    useEffect(() => {
        if (agent != null && shouldUnflip(flipTs, last)) {
            globalStore.set(flipAtom, null);
        }
    }, [agent?.id, flipTs, last]);
}

// the agent's question, after the last item in the column: the Needs your input label, then the ask card
function AskCard({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const selections = useAtomValue(model.answerSelAtom)[agent.id] ?? {};
    const texts = useAtomValue(model.answerTextAtom)[agent.id] ?? {};
    const activeQuestion = useAtomValue(model.answerTabAtom)[agent.id] ?? 0;
    const sent = useAtomValue(model.sentIdsAtom).has(askSentKey(agent) ?? "");
    return (
        <div data-rendered-ask className="mt-1 flex flex-col pb-2">
            <NeedsInputPill />
            <AnswerBar
                agent={agent}
                variant="card"
                selections={selections}
                texts={texts}
                sent={sent}
                numbered
                activeQuestion={activeQuestion}
                onToggle={(qi, oi) => model.toggleAnswer(agent.id, qi, oi)}
                onText={(qi, value) => model.setAnswerText(agent.id, qi, value)}
                onSubmit={() => model.submitAnswer(agent.id)}
                onSelectQuestion={(qi) => globalStore.set(model.answerTabAtom, (prev) => ({ ...prev, [agent.id]: qi }))}
                onDismiss={
                    agent.ask?.oref
                        ? () => fireAndForget(() => RpcApi.AgentAskClearCommand(TabRpcClient, agent.ask!.oref!))
                        : undefined
                }
            />
        </div>
    );
}

// the timeline's row for an entry: its bubble, or the row a host drew in its place (NarrationTimeline)
function promptRow(scroller: HTMLElement | null, index: number | undefined): HTMLElement | null {
    return index == null ? null : (scroller?.querySelector<HTMLElement>(`[data-entry-index="${index}"]`) ?? null);
}

// which prompt the bar pins, re-read on each scroll and after each layout of the timeline
function usePinnedPrompt(
    scrollRef: RefObject<HTMLDivElement>,
    entries: AgentEntry[],
    ctx: TranscriptContext,
    rowOf: RowOf
) {
    const [prompt, setPrompt] = useState<PinnedPrompt | null>(null);
    const update = () => {
        const el = scrollRef.current;
        if (el == null) {
            return;
        }
        const last = lastPrompt(entries, ctx, rowOf);
        const next = pinnedPrompt(
            last,
            promptRow(el, last?.index)?.getBoundingClientRect() ?? null,
            el.getBoundingClientRect()
        );
        setPrompt((prev) => (samePin(prev, next) ? prev : next));
    };
    useLayoutEffect(update, [entries, ctx, rowOf]);
    const jump = () => {
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        promptRow(scrollRef.current, prompt?.index)?.scrollIntoView({
            block: "start",
            behavior: reduce ? "auto" : "smooth",
        });
    };
    return { prompt, update, jump };
}

function PinnedPromptBar({
    prompt,
    agent,
    onJump,
}: {
    prompt: PinnedPrompt | null;
    agent: AgentVM;
    onJump: () => void;
}) {
    // the bar keeps what it shows while it leaves
    const shownRef = useRef<PinnedPrompt | null>(null);
    if (prompt != null) {
        shownRef.current = prompt;
    }
    const shown = shownRef.current;
    return (
        <PopoverReveal
            open={prompt != null}
            origin="top"
            className="pointer-events-none absolute inset-x-0 top-0 z-20 px-6 pt-2.5"
        >
            <button
                type="button"
                data-pinned-prompt
                aria-label="Jump to your last message"
                onClick={onJump}
                className={`${COLUMN} pointer-events-auto flex cursor-pointer items-center gap-2.5 rounded-[10px] border border-edge-mid bg-surface px-3 py-[7px] text-left text-[13px] text-secondary hover:border-edge-strong`}
            >
                {shown?.row != null ? (
                    <span data-pinned-row={shown.row.kind} className="flex min-w-0 flex-1 items-center gap-2">
                        <PinnedRow view={shown.row} agent={agent} />
                    </span>
                ) : (
                    <span className="min-w-0 flex-1 truncate">{shown?.text ?? ""}</span>
                )}
                <ArrowUp size={13} strokeWidth={2.2} aria-hidden className="shrink-0 text-muted" />
            </button>
        </PopoverReveal>
    );
}

// the line under the last waiting message, counting them
function QueuedLine({ count }: { count: number }) {
    return (
        <div data-queued-line className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted">
            {`${count === 1 ? "Queued" : `${count} queued`} · `}
            <kbd className="rounded-[4px] border border-edge-strong px-[5px] font-mono text-[10.5px] text-ink-mid">
                Esc
            </kbd>
            {" to stop and send now"}
        </div>
    );
}

// The messages waiting on the agent, after the timeline and above the working line. A message enters as an item
// (moment 1); it has no exit, since the transcript row that shows it read takes its place in the same frame. The
// Queued line reveals and leaves in place (moment 6).
function QueuedFoot({ items }: { items: FootItem[] }) {
    const last = items.length - 1;
    return (
        <div data-queued-foot>
            {items.map((item, i) => (
                <motion.div
                    key={item.key}
                    data-queued-item
                    variants={cardVariants}
                    initial="initial"
                    animate="animate"
                    className={item.command != null ? "flex flex-col" : "my-6 flex flex-col items-end"}
                >
                    {item.command != null ? (
                        <CommandChip name={item.command.name} args={item.command.args} compact={false} />
                    ) : (
                        <PersonBubble text={item.text} clamp compact={false} />
                    )}
                    <AnimatePresence initial={false}>
                        {i === last ? (
                            <motion.div
                                key="line"
                                variants={composerReveal}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                                className="flex justify-end overflow-hidden"
                            >
                                <QueuedLine count={items.length} />
                            </motion.div>
                        ) : null}
                    </AnimatePresence>
                </motion.div>
            ))}
        </div>
    );
}

// the foot's list for the agent
function useQueuedFoot(agent: AgentVM): FootItem[] {
    const waiting = useAtomValue(waitingAtomFor(agent.id));
    return useMemo(() => footList(waiting), [waiting]);
}

export function RenderedView({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const entries = useAtomValue(entriesAtomFor(agent.id));
    const marks = useAtomValue(permissionLogAtom(agent.id));
    const earlier = useAtomValue(earlierAtomFor(agent.id));
    const whole = earlier === "shown";
    const feedRef = useRef<HTMLDivElement>(null);
    // the whole file remounts the feed, so its rows come in without an entrance fade; the reader keeps their place
    const { scrollRef, onScroll, atBottom, jumpToBottom } = useStickToBottom(entries, {
        rows: () => feedRef.current?.firstElementChild,
        mount: whole,
    });
    const ctx = useTranscriptContext(model, agent);
    const canvasReveal = useMemo(() => lastCanvasReveal(entries) ?? undefined, [entries]);
    const timelineCtx = useMemo(() => ({ ...ctx, canvasReveal }), [ctx, canvasReveal]);
    const working = useWorkingTail(model.nowAtom, agent, entries);
    const foot = useQueuedFoot(agent);
    // one node per change of either, so the memoized timeline does not re-render on every view render; an idle feed
    // gets no foot element, so its list holds only the rows it draws
    const tail = useMemo(() => {
        if (foot.length === 0) {
            return working;
        }
        return (
            <>
                <QueuedFoot items={foot} />
                {working}
            </>
        );
    }, [foot, working]);
    const rowOf = useEntryRowView(agent);
    const pin = usePinnedPrompt(scrollRef, entries, ctx, rowOf);
    const composerRef = useRef<AgentComposerHandle>(null);
    const askShown = askDocked(agent);
    const openFileLink = useReplyFileLink(model, agent);
    const entryRow = useRenderedEntryRow(model, agent, rowOf);
    // the picker only exists in the TUI, so the flip lands before the command is typed
    const onSubmitText = (text: string) => {
        if (isPickerCommand(text)) {
            globalStore.set(pickerFlipAtom(agent.id), Date.now());
        }
    };
    return (
        <div data-rendered-view className="flex min-h-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
                <div
                    data-rendered-scroll
                    ref={scrollRef}
                    onScroll={() => {
                        onScroll();
                        pin.update();
                    }}
                    className="h-full overflow-y-auto px-6 py-[18px]"
                >
                    {/* min-h, not h: the stick-to-bottom observer watches this box, so it must grow with the
                        timeline (an image or chart that lays out late) for the tail to stay pinned */}
                    <div data-rendered-column className={TRANSCRIPT_COLUMN}>
                        {entries.length > 0 ? (
                            <>
                                <ShowEarlier
                                    show={earlier === "hidden" || earlier === "loading"}
                                    marker="data-rendered-earlier"
                                    onClick={() => fireAndForget(() => showEarlierTranscript(agent.id))}
                                />
                                <div data-rendered-feed ref={feedRef}>
                                    <FileLinkContext.Provider value={openFileLink}>
                                        <NarrationTimeline
                                            key={whole ? "whole" : "tail"}
                                            entries={entries}
                                            renderers
                                            marks={anchorMarks(entries, marks)}
                                            accentLatest
                                            thoughts
                                            renderAll={whole}
                                            active={agent.state === "working"}
                                            ctx={timelineCtx}
                                            tail={tail}
                                            entryRow={entryRow}
                                        />
                                    </FileLinkContext.Provider>
                                </div>
                            </>
                        ) : agent.transcriptPath ? (
                            <div data-rendered-empty="skeleton" className="flex-1">
                                <TranscriptSkeleton />
                            </div>
                        ) : (
                            <div
                                data-rendered-empty="no-transcript"
                                className="flex flex-1 items-center justify-center text-[13px] text-muted"
                            >
                                No transcript for this session yet.
                            </div>
                        )}
                        {/* after the timeline, whose working line hides while the agent asks */}
                        {askShown ? <AskCard model={model} agent={agent} /> : null}
                        {/* the brainstorm's live card is always the transcript's last item; a canvas alone has its
                            card on the reveal row instead */}
                        <RenderedBrainstorm model={model} agent={agent} />
                    </div>
                </div>
                <PinnedPromptBar prompt={pin.prompt} agent={agent} onJump={pin.jump} />
                <JumpToLatestPill show={!atBottom} onClick={jumpToBottom} />
            </div>
            <PermissionBand
                agentId={agent.id}
                blockId={agent.blockId}
                onLastChoice={() => composerRef.current?.focus()}
            />
            <div data-rendered-composer className="shrink-0 px-6 pb-4 pt-3">
                <div className={COLUMN}>
                    <RenderedComposer
                        ref={composerRef}
                        model={model}
                        agent={agent}
                        hasTranscript={entries.length > 0}
                        onInterrupt={() => interruptAgent(agent.blockId)}
                        onSubmitText={onSubmitText}
                    />
                </div>
            </div>
        </div>
    );
}
