// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Agent surface center's Rendered mode: the focused claude agent's live transcript as a readable timeline,
// with a composer that drives the same pty the terminal shows. The terminal block stays mounted beside it.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { interruptAgent } from "./agentactions";
import type { AgentComposerHandle } from "./agentcomposer";
import type { AgentsViewModel } from "./agents";
import { askSentKey, type AgentVM } from "./agentsviewmodel";
import { AnswerBar } from "./answerbar";
import { entriesAtomFor } from "./livetranscriptatoms";
import { NarrationTimeline } from "./narrationtimeline";
import { NowLine } from "./nowlineview";
import { PermissionBand } from "./permissionband";
import { anchorMarks } from "./permissionmodel";
import { permissionLogAtom } from "./permissionstore";
import { RenderedComposer } from "./renderedcomposer";
import { askDocked, isPickerCommand, pickerFlipAtom, shouldUnflip } from "./renderedmode";
import { getLastHookAtom } from "./session-models/agentstatusstore";
import { JumpToLatestPill, useStickToBottom } from "./sticktobottom";
import { TranscriptSkeleton } from "./transcriptskeleton";

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

function AskDock({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const selections = useAtomValue(model.answerSelAtom)[agent.id] ?? {};
    const texts = useAtomValue(model.answerTextAtom)[agent.id] ?? {};
    const activeQuestion = useAtomValue(model.answerTabAtom)[agent.id] ?? 0;
    const sent = useAtomValue(model.sentIdsAtom).has(askSentKey(agent) ?? "");
    return (
        <div data-rendered-ask className="border-t border-edge-mid px-[14px] py-2">
            <AnswerBar
                agent={agent}
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

export function RenderedView({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const entries = useAtomValue(entriesAtomFor(agent.id));
    const marks = useAtomValue(permissionLogAtom(agent.id));
    const { scrollRef, onScroll, atBottom, jumpToBottom } = useStickToBottom(entries);
    const composerRef = useRef<AgentComposerHandle>(null);
    const askShown = askDocked(agent);
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
                    onScroll={onScroll}
                    className="h-full overflow-y-auto px-[22px] py-[18px]"
                >
                    {/* min-h, not h: the stick-to-bottom observer watches this box, so it must grow with the
                        timeline (an image or chart that lays out late) for the tail to stay pinned. Only a markdown
                        message's top-level text blocks keep a reading measure; cards, code and diffs use the width */}
                    <div
                        data-rendered-column
                        className="mx-auto flex min-h-full w-full flex-col [&_.agent-md>:is(p,ul,ol,h1,h2,h3,h4,h5,h6,blockquote)]:max-w-[75ch]"
                    >
                        {entries.length > 0 ? (
                            <NarrationTimeline
                                entries={entries}
                                renderers
                                marks={anchorMarks(entries, marks)}
                                accentLatest
                                active={agent.state === "working"}
                            />
                        ) : agent.transcriptPath ? (
                            <div data-rendered-empty="skeleton" className="flex-1">
                                <TranscriptSkeleton />
                            </div>
                        ) : (
                            <div
                                data-rendered-empty="no-transcript"
                                className="flex flex-1 items-center justify-center text-[12px] text-muted"
                            >
                                No transcript for this session yet.
                            </div>
                        )}
                    </div>
                </div>
                <JumpToLatestPill show={!atBottom} onClick={jumpToBottom} />
            </div>
            <NowLine model={model} agent={agent} entries={entries} />
            {askShown ? <AskDock model={model} agent={agent} /> : null}
            <PermissionBand
                agentId={agent.id}
                blockId={agent.blockId}
                askShown={askShown}
                onLastChoice={() => composerRef.current?.focus()}
            />
            <div data-rendered-composer className="shrink-0 px-[22px] pb-4">
                <RenderedComposer
                    ref={composerRef}
                    blockId={agent.blockId}
                    working={agent.state === "working"}
                    onInterrupt={() => interruptAgent(agent.blockId)}
                    onSubmitText={onSubmitText}
                />
            </div>
        </div>
    );
}
