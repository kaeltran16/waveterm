// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Agent surface center's Rendered mode: the focused claude agent's live transcript as a readable timeline,
// with a message box that drives the same pty the terminal shows. The terminal block stays mounted beside it.
// The working line is the timeline's tail; once your last prompt has scrolled out of view, a bar pinned at the top
// holds it. A file path in a reply opens the Code peek docked under the transcript, beside the agent.

import { microFade, viewFade } from "@/app/element/motiontokens";
import { PopoverReveal } from "@/app/element/popoverreveal";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUp } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CodePeekCard } from "../code/codepeekcard";
import { PEEK_PREFERRED_PX } from "../code/codepeekmodel";
import { closePeek, codePeekAtom, togglePeek } from "../code/codepeekstore";
import { interruptAgent } from "./agentactions";
import type { AgentComposerHandle } from "./agentcomposer";
import { resolveCwd } from "./agentcwdresolve";
import type { AgentsViewModel } from "./agents";
import { askSentKey, type AgentEntry, type AgentVM } from "./agentsviewmodel";
import { AnswerBar } from "./answerbar";
import { showEarlierTranscript } from "./livetranscript";
import { earlierAtomFor, entriesAtomFor } from "./livetranscriptatoms";
import { FileLinkContext } from "./markdownmessage";
import { NarrationTimeline } from "./narrationtimeline";
import { useWorkingTail } from "./nowlineview";
import { PermissionBand } from "./permissionband";
import { anchorMarks } from "./permissionmodel";
import { permissionLogAtom } from "./permissionstore";
import { pinnedPrompt, type PinnedPrompt } from "./pinnedprompt";
import { NeedsInputPill, RenderedBrainstorm } from "./renderedbrainstorm";
import { useRenderedEntryRow } from "./renderedbsrows";
import { RenderedComposer } from "./renderedcomposer";
import { askDocked, isPickerCommand, pickerFlipAtom, shouldUnflip } from "./renderedmode";
import type { ReplyFileLink } from "./replyfilelinks";
import { getLastHookAtom } from "./session-models/agentstatusstore";
import { JumpToLatestPill, useStickToBottom } from "./sticktobottom";
import { useTranscriptContext, type TranscriptContext } from "./transcriptcontext";
import { TranscriptSkeleton } from "./transcriptskeleton";

// the transcript column's measure, and the pinned bar's (the Working board)
const COLUMN = "mx-auto w-full max-w-[736px]";
const BUBBLE = "[data-user-bubble]";
// the docked peek's share of the view at most, so the transcript keeps the rest
const PEEK_MAX_HEIGHT = "50%";

// a reply's peek is keyed apart from the terminal's own, which shares the agent's block
const replyPeekKey = (agent: AgentVM) => `rendered:${agent.blockId ?? agent.id}`;

// the open file a reply's path asked for, docked under the transcript; a second click on the path closes it
function useReplyPeek(model: AgentsViewModel, agent: AgentVM) {
    const key = replyPeekKey(agent);
    const peek = useAtomValue(codePeekAtom);
    const open = useCallback(
        (link: ReplyFileLink) =>
            fireAndForget(async () => {
                const cwd = await resolveCwd(agent.transcriptPath, agent.blockId);
                await togglePeek({ blockId: key, bufferLine: 0, start: 0, raw: link.path, line: link.line, cwd });
            }),
        [key, agent.transcriptPath, agent.blockId]
    );
    // the card leaves with the view (another agent, or the terminal), or its Enter and Esc would still be armed
    useEffect(
        () => () => {
            if (globalStore.get(codePeekAtom)?.blockId === key) {
                closePeek();
            }
        },
        [key]
    );
    const card = peek?.blockId === key ? peek : null;
    return {
        open,
        dock: (
            <AnimatePresence initial={false}>
                {card != null ? (
                    // a fade at its full height: the editor inside measures its box once, on mount, so a box growing
                    // from 0 leaves it blank
                    <motion.div
                        key="peek"
                        data-rendered-peek
                        variants={microFade}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="shrink-0 px-6 pt-2"
                        style={{ height: PEEK_PREFERRED_PX, maxHeight: PEEK_MAX_HEIGHT }}
                    >
                        <div className={`${COLUMN} h-full`}>
                            <CodePeekCard peek={card} model={model} blockId={agent.blockId ?? agent.id} side="below" />
                        </div>
                    </motion.div>
                ) : null}
            </AnimatePresence>
        ),
    };
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

function lastBubble(scroller: HTMLElement | null): HTMLElement | null {
    const all = scroller?.querySelectorAll<HTMLElement>(BUBBLE);
    return all != null && all.length > 0 ? all[all.length - 1] : null;
}

// which prompt the bar pins, re-read on each scroll and after each layout of the timeline
function usePinnedPrompt(scrollRef: RefObject<HTMLDivElement>, entries: AgentEntry[], ctx: TranscriptContext) {
    const [prompt, setPrompt] = useState<PinnedPrompt | null>(null);
    const update = () => {
        const el = scrollRef.current;
        if (el == null) {
            return;
        }
        const next = pinnedPrompt(
            entries,
            lastBubble(el)?.getBoundingClientRect() ?? null,
            el.getBoundingClientRect(),
            ctx
        );
        setPrompt((prev) => (prev?.index === next?.index && prev?.text === next?.text ? prev : next));
    };
    useLayoutEffect(update, [entries, ctx]);
    const jump = () => {
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        lastBubble(scrollRef.current)?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    };
    return { prompt, update, jump };
}

function PinnedPromptBar({ prompt, onJump }: { prompt: PinnedPrompt | null; onJump: () => void }) {
    // the bar keeps its text while it leaves
    const textRef = useRef("");
    if (prompt != null) {
        textRef.current = prompt.text;
    }
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
                <span className="min-w-0 flex-1 truncate">{textRef.current}</span>
                <ArrowUp size={13} strokeWidth={2.2} aria-hidden className="shrink-0 text-muted" />
            </button>
        </PopoverReveal>
    );
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
    const tail = useWorkingTail(model.nowAtom, agent, entries);
    const pin = usePinnedPrompt(scrollRef, entries, ctx);
    const composerRef = useRef<AgentComposerHandle>(null);
    const askShown = askDocked(agent);
    const replyPeek = useReplyPeek(model, agent);
    const entryRow = useRenderedEntryRow(model, agent);
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
                        timeline (an image or chart that lays out late) for the tail to stay pinned. Only a markdown
                        message's top-level text blocks keep a reading measure; cards, code and diffs use the width */}
                    <div
                        data-rendered-column
                        className={`${COLUMN} flex min-h-full flex-col [&_.agent-md>:is(p,ul,ol,h1,h2,h3,h4,h5,h6,blockquote)]:max-w-[75ch]`}
                    >
                        {entries.length > 0 ? (
                            <>
                                <AnimatePresence initial={false}>
                                    {earlier === "hidden" || earlier === "loading" ? (
                                        <motion.button
                                            key="earlier"
                                            type="button"
                                            data-rendered-earlier=""
                                            onClick={() => fireAndForget(() => showEarlierTranscript(agent.id))}
                                            variants={viewFade}
                                            initial="initial"
                                            animate="animate"
                                            className="w-full cursor-pointer rounded-[6px] py-2 text-center text-[12px] font-semibold text-muted hover:bg-surface-hover hover:text-primary"
                                        >
                                            Show earlier turns
                                        </motion.button>
                                    ) : null}
                                </AnimatePresence>
                                <div data-rendered-feed ref={feedRef}>
                                    <FileLinkContext.Provider value={replyPeek.open}>
                                        <NarrationTimeline
                                            key={whole ? "whole" : "tail"}
                                            entries={entries}
                                            renderers
                                            marks={anchorMarks(entries, marks)}
                                            accentLatest
                                            thoughts
                                            renderAll={whole}
                                            active={agent.state === "working"}
                                            ctx={ctx}
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
                        {/* the brainstorm's live card is always the transcript's last item */}
                        <RenderedBrainstorm model={model} agent={agent} />
                    </div>
                </div>
                <PinnedPromptBar prompt={pin.prompt} onJump={pin.jump} />
                <JumpToLatestPill show={!atBottom} onClick={jumpToBottom} />
            </div>
            {replyPeek.dock}
            <PermissionBand
                agentId={agent.id}
                blockId={agent.blockId}
                askShown={askShown}
                onLastChoice={() => composerRef.current?.focus()}
            />
            <div data-rendered-composer className="shrink-0 px-6 pb-4 pt-3">
                <div className={COLUMN}>
                    <RenderedComposer
                        ref={composerRef}
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
