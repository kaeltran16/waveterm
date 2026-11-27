// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Agent (Focus) surface: AgentTree | center [| AgentDetailsRail]. The rail is toggleable
// (railVisibleAtom, default off, `d` key) so the surface is normally 2 panes, 3 with the rail open. In the
// Rendered view the workspace pane takes the rail's place, and only while the agent has tabs open in it.
// The center is the focused agent's live Claude Code terminal (CockpitFocusPane) — the real TUI,
// not a narrated transcript; an AgentHeader bar sits above it for identity + the rail toggle. With no
// explicit focus it defaults to the tree's first agent (handoff dc.html:1790
// `focusAgent = …find(fid) || list[0]`) — never the cockpit grid; only a zero-agent roster shows an
// empty state. Routing is shell-side (this file is imported only by cockpitshell.tsx) so agents.tsx
// never imports CockpitFocusPane, keeping the agents -> focus-pane -> blockregistry -> agents eval
// cycle broken.

import { CockpitFocusPane } from "@/app/cockpit/focus-pane";
import { easeFluidCss, MOTION, viewFade } from "@/app/element/motiontokens";
import { Skeleton, SkeletonLine } from "@/app/element/skeleton";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { buildAgentBindings } from "@/app/store/keybindings/bindings";
import { focusClaimed, isEditableTarget } from "@/app/store/keybindings/dispatcher";
import { useKeybindings } from "@/app/store/keybindings/store";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { CodePeekContext } from "../code/codepeekhost";
import type { AgentsViewModel } from "./agents";
import { AgentDetailsRail } from "./agentdetailsrail";
import { usePaneShown } from "./agentpanes";
import { AgentHeader } from "./agentheader";
import { AgentLaunchHero } from "./agentlaunchhero";
import { AgentTree } from "./agenttree";
import { compactedSummary } from "./brainstormmodel";
import { BrainstormPane } from "./brainstormpane";
import { brainstormAtom } from "./brainstormstore";
import { CanvasPane } from "./canvaspane";
import { useCanvasPoller } from "./canvaspoller";
import { CanvasWindow } from "./canvaswindow";
import { rosterLoadPhase } from "./cockpitsurfacemodel";
import { autoOpenedAskIdsAtom, docReviewAtom, shouldAutoOpen } from "./docreview";
import { EndedTranscript } from "./endedtranscript";
import { finalRowFocusId } from "./finalstage";
import { FinalStagePane } from "./finalstagepane";
import { rosterSeededAtom } from "./liveagents";
import { terminalFullscreenAtom } from "./railstore";
import { canRender, effectiveViewMode, pickerFlipAtom, viewModeAtom } from "./renderedmode";
import { RenderedView, useUnflipOnPrompt } from "./renderedview";
import { isEndedWorkerId } from "./runlineage";
import { focusSubagentAtom } from "./subagentsstore";
import { SubagentView } from "./subagentview";
import { paneShape } from "./workspacemodel";
import { WorkspacePane } from "./workspacepane";
import { workspaceAtom } from "./workspacestore";

export function AgentSurface({ model, tabId }: { model: AgentsViewModel; tabId: string }) {
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const terminals = useAtomValue(model.terminalsAtom);
    const focusOrder = useAtomValue(model.focusOrderAtom);
    const fullscreen = useAtomValue(terminalFullscreenAtom);
    const focusSub = useAtomValue(focusSubagentAtom);
    const ended = useAtomValue(model.endedWorkerAtom);
    const stage = useAtomValue(model.finalStageAtom);
    const seeded = useAtomValue(rosterSeededAtom);
    const wrapRef = useRef<HTMLDivElement>(null);
    // Focusable set = agents + background terminals. handoff (dc.html:1790): focusAgent = …find(fid) ||
    // list[0] — the Focus surface always shows something, defaulting to the tree's first agent (never
    // a terminal, so background terminals stay backgrounded); it falls back to the first terminal only
    // when there are no agents. focusId is kept "always real" (initialized to a default, never empty).
    // A done task's worker has no terminal to mount, so it is focusable without being mountable; so is a run's
    // final stage before a verifier session stands for it.
    const mountable = [...agents, ...terminals];
    const focused =
        focusId != null ? (mountable.find((a) => a.id === focusId) ?? ended?.agent ?? stage?.agent) : undefined;
    const firstInTree = focusOrder.map((id) => agents.find((a) => a.id === id)).find((a) => a != null);
    const agent = focused ?? firstInTree ?? agents[0] ?? terminals[0];
    const showSub = focusSub != null && focusSub.parentId === agent?.id;
    const brainstorm = useAtomValue(brainstormAtom(agent?.id ?? ""));
    // the brainstorm or canvas showing: Rendered's tab beside the transcript, or the Terminal view's center
    const shown = usePaneShown(model, agent?.id ?? "");
    const compacted = brainstorm?.file?.compacted;
    const showCompacted = shown == null && compacted != null && compacted > brainstorm!.lastViewedMs;
    useCanvasPoller(model, agent);
    // ended workers and the final stage win over Rendered
    const viewMode = effectiveViewMode(
        useAtomValue(viewModeAtom(agent?.id ?? "")),
        useAtomValue(pickerFlipAtom(agent?.id ?? ""))
    );
    // Rendered stays mounted, laid out but invisible, under an open subagent, so going back keeps its scroll
    const rendersUnder =
        agent != null &&
        viewMode === "rendered" &&
        canRender(agent, { ended: isEndedWorkerId(agent.id), stage: stage != null && agent.id === stage.agent.id });
    const inRendered = rendersUnder && !showSub;
    // in Terminal a brainstorm or canvas takes over the center, hiding the terminal and the rail; Rendered keeps the
    // transcript and shows it as a workspace tab
    const centerPane = rendersUnder ? null : shown;
    const paneMode = centerPane != null;
    const ws = useAtomValue(workspaceAtom(agent?.id ?? ""));
    const shape = inRendered ? paneShape(ws) : "none";
    const [rowRef, , rowRect] = useDimensionsWithCallbackRef<HTMLDivElement>();
    const centerRef = useRef<HTMLDivElement>(null);
    useColumnGlide(centerRef, shape !== "none");
    useUnflipOnPrompt(agent);

    // sync focusId to the defaulted agent so the tree highlights it and ←/→ start from the right place
    useEffect(() => {
        if (agent != null && focusId !== agent.id) {
            globalStore.set(model.focusIdAtom, agent.id);
        }
    }, [agent?.id, focusId, model]);

    // the stage's row becomes its verifier's session once that is in the roster, and the focus goes with the row
    const stageFocusId = stage ? finalRowFocusId(stage.run, agents) : undefined;
    useEffect(() => {
        if (stageFocusId != null && stageFocusId !== focusId) {
            globalStore.set(model.focusIdAtom, stageFocusId);
        }
    }, [stageFocusId, focusId, model]);

    // the parent stays laid out, invisible, under its subagent, where a still-focused xterm or message box would take
    // the keys typed at the subagent view
    useEffect(() => {
        if (showSub) {
            wrapRef.current?.focus({ preventScroll: true });
        }
    }, [showSub]);

    // a stale subagent view (its parent is no longer focused) closes so the parent returns
    useEffect(() => {
        if (focusSub != null && focusSub.parentId !== agent?.id) {
            globalStore.set(focusSubagentAtom, null);
        }
    }, [agent?.id, focusSub]);

    // a lead's Spec/Plan review opens by itself once per ask, only while you are on that lead and not typing
    const surface = useAtomValue(model.surfaceAtom);
    const askId = agent?.ask?.askId;
    useEffect(() => {
        const opened = globalStore.get(autoOpenedAskIdsAtom);
        const editable = isEditableTarget(document.activeElement);
        if (!shouldAutoOpen({ surface, focusedId: focusId, agent, opened, editable })) {
            return;
        }
        globalStore.set(docReviewAtom, agent.id);
        globalStore.set(autoOpenedAskIdsAtom, new Set(opened).add(askId));
    }, [surface, focusId, agent?.id, askId]);

    // only pull focus to the wrapper for the no-terminal fallback (so esc/←→/d work without a click).
    // when the live terminal is shown it must own focus for immediate typing — stealing it back to the
    // wrapper would force a click before every keystroke, defeating the real-TUI default. the
    // surface keys still fire whenever focus isn't inside the terminal (e.g. after a tree-row click).
    useEffect(() => {
        if (agent != null && agent.blockId == null) {
            wrapRef.current?.focus();
        }
    }, [agent?.id]);

    // canvas and brainstorm modes hide the terminal, and a hidden xterm can still hold focus and eat b/c/[/]/m,
    // so entering one pulls focus to the wrapper; returning to the same agent's terminal hands focus back to its xterm
    const lastPane = useRef<{ id: string; on: boolean } | null>(null);
    useEffect(() => {
        const prev = lastPane.current;
        lastPane.current = agent != null ? { id: agent.id, on: paneMode } : null;
        if (agent == null || prev == null) {
            return;
        }
        if (paneMode && (!prev.on || prev.id !== agent.id)) {
            wrapRef.current?.focus();
        } else if (!paneMode && prev.on && prev.id === agent.id) {
            wrapRef.current?.querySelector<HTMLElement>(`[data-agent-terminal="${agent.id}"] .xterm-helper-textarea`)?.focus();
        }
    }, [agent?.id, paneMode]);

    // toggling the same agent hands focus to the view it shows: the composer in Rendered, the xterm in Terminal.
    // Arriving at an agent already in Rendered takes the wrapper instead, so j/k keep stepping the tree and the
    // previous agent's now-hidden xterm cannot keep focus.
    const lastRendered = useRef<{ id: string; on: boolean } | null>(null);
    useEffect(() => {
        const prev = lastRendered.current;
        lastRendered.current = agent != null ? { id: agent.id, on: inRendered } : null;
        if (agent == null || prev == null || prev.on === inRendered) {
            return;
        }
        if (prev.id !== agent.id) {
            if (inRendered) {
                wrapRef.current?.focus();
            }
            return;
        }
        const target = inRendered
            ? "[data-rendered-composer] textarea"
            : `[data-agent-terminal="${agent.id}"] .xterm-helper-textarea`;
        wrapRef.current?.querySelector<HTMLElement>(target)?.focus();
    }, [agent?.id, inRendered]);

    // the surface stays mounted, so the effects above never run on a switch back to it, and arriving left
    // focus on <body>: typing reached the agent only after a click. Arriving hands focus to the live
    // terminal or the Rendered composer, or the wrapper when neither is showing (canvas, brainstorm, subagent
    // view, no terminal).
    useEffect(() => {
        const wrap = wrapRef.current;
        if (
            surface !== "agent" ||
            agent == null ||
            wrap == null ||
            wrap.contains(document.activeElement) ||
            focusClaimed()
        ) {
            return;
        }
        const target = [
            `[data-agent-terminal="${agent.id}"] .xterm-helper-textarea`,
            "[data-rendered-composer] textarea",
        ]
            .map((sel) => wrap.querySelector<HTMLElement>(sel))
            .find((el) => el?.checkVisibility({ visibilityProperty: true }));
        (target ?? wrap).focus({ preventScroll: true });
    }, [surface]);

    // Agent-surface keys live in the registry (bindings.ts). Stable array — run() reads live atoms.
    const agentBindings = useMemo(() => buildAgentBindings(model), [model]);
    useKeybindings(agentBindings);

    if (!agent) {
        return rosterLoadPhase(seeded, agents.length) === "loading" ? (
            <AgentSurfaceSkeleton />
        ) : (
            <AgentLaunchHero model={model} />
        );
    }

    return (
        <MotionConfig reducedMotion="user">
            <div ref={wrapRef} tabIndex={0} data-cockpit-surface-wrap className="flex h-full w-full bg-background outline-none">
                {/* the tree stays in canvas and brainstorm modes: hiding it made reaching another agent a round trip
                    through the terminal */}
                {!fullscreen ? <AgentTree model={model} /> : null}
                <div ref={rowRef} className="relative flex min-w-0 flex-1">
                    {/* expanded, the pane fills the row over the center, which stays laid out so the focused terminal
                        keeps its size (terminalClass) */}
                    <div
                        ref={centerRef}
                        data-agent-center
                        className={cn(
                            "flex min-w-0 flex-col",
                            shape === "expanded" ? "invisible absolute inset-0" : "flex-1"
                        )}
                    >
                        {/* the parent's stack stays mounted and laid out (invisible) while a subagent is shown, so
                            returning never remounts/replays the live TUI (frame-stacking) and Rendered keeps its scroll */}
                        <div className={cn("flex min-h-0 flex-1 flex-col", showSub && "invisible absolute inset-0")}>
                            <AgentHeader model={model} agent={agent} />
                            {showCompacted ? (
                                <div
                                    data-brainstorm-compacted
                                    className="mx-[16px] mt-[12px] flex flex-none items-center gap-[10px] rounded-[8px] border border-edge-mid bg-surface-raised px-[12px] py-[10px]"
                                >
                                    <span className="h-[7px] w-[7px] flex-none rounded-full bg-accent" aria-hidden />
                                    <span className="flex-1 text-[13px] leading-[1.45] text-secondary">
                                        {compactedSummary(brainstorm!.file!)}
                                    </span>
                                </div>
                            ) : null}
                            <div className="relative flex min-h-0 flex-1 flex-col">
                                {mountable
                                    .filter((a) => a.blockId != null)
                                    .map((a) => (
                                        <div
                                            key={a.id}
                                            data-agent-terminal={a.id}
                                            className={cn(
                                                "min-h-0 flex-1",
                                                terminalClass(a.id === agent.id, paneMode, rendersUnder)
                                            )}
                                        >
                                            <CodePeekContext.Provider
                                                value={{ model, transcriptPath: a.transcriptPath }}
                                            >
                                                <CockpitFocusPane blockId={a.blockId!} tabId={tabId} />
                                            </CodePeekContext.Provider>
                                        </div>
                                    ))}
                                {isEndedWorkerId(agent.id) ? (
                                    <EndedTranscript model={model} agent={agent} />
                                ) : stage != null && agent.id === stage.agent.id ? (
                                    <FinalStagePane model={model} run={stage.run} />
                                ) : centerPane === "brainstorm" ? (
                                    <BrainstormPane model={model} agent={agent} />
                                ) : centerPane === "canvas" ? (
                                    // keyed like the brainstorm pane, so opening the canvas or another agent's fades in
                                    <motion.div
                                        key={agent.id}
                                        variants={viewFade}
                                        initial="initial"
                                        animate="animate"
                                        className="flex min-h-0 flex-1 flex-col"
                                    >
                                        <CanvasPane model={model} agent={agent} />
                                    </motion.div>
                                ) : agent.blockId == null ? (
                                    <div className="flex flex-1 items-center justify-center text-[13px] text-muted">
                                        No live terminal for this agent.
                                    </div>
                                ) : rendersUnder ? (
                                    <RenderedView key={agent.id} model={model} agent={agent} />
                                ) : null}
                            </div>
                        </div>
                        {showSub ? <SubagentView model={model} focus={focusSub!} parentName={agent.name} /> : null}
                    </div>
                    {/* fullscreen hides the tree, not the pane: the pane holds what you opened */}
                    <AnimatePresence>
                        {shape !== "none" ? (
                            <WorkspacePane
                                key="workspace"
                                model={model}
                                agent={agent}
                                ws={ws}
                                availablePx={rowRect?.width ?? null}
                            />
                        ) : null}
                    </AnimatePresence>
                </div>
                {!fullscreen && !paneMode && !inRendered && agent.kind !== "terminal" ? (
                    <AgentDetailsRail model={model} agent={agent} />
                ) : null}
                <CanvasWindow model={model} />
            </div>
        </MotionConfig>
    );
}

// the centered columns a pane's arrival or exit moves sideways: Rendered's transcript and its composer
const GLIDE_COLUMNS = "[data-rendered-column], [data-rendered-composer] > *";

// the workspace pane enters and leaves the flow at its full width (workspacepane.tsx), so the center changes width in
// one frame and its centered columns would jump sideways. They slide from where they were instead, by transform only,
// so the feed still rewraps once. A column that mounted with the change (another agent, another view) has no old place
// and stays put
function useColumnGlide(center: RefObject<HTMLElement | null>, paneIn: boolean) {
    const committed = useRef(paneIn);
    // read during render, against the DOM as it was before this commit
    const from = committed.current !== paneIn ? columnLefts(center.current) : null;
    useLayoutEffect(() => {
        committed.current = paneIn;
        if (from == null || globalStore.get(atoms.prefersReducedMotionAtom)) {
            return;
        }
        const duration = (paneIn ? MOTION.durMacro : MOTION.durExit) * 1000;
        for (const [el, left] of columnLefts(center.current)) {
            const dx = (from.get(el) ?? left) - left;
            if (Math.abs(dx) >= 1) {
                el.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], {
                    duration,
                    easing: easeFluidCss,
                });
            }
        }
    }, [paneIn]);
}

function columnLefts(center: HTMLElement | null): Map<Element, number> {
    const lefts = new Map<Element, number>();
    for (const el of center?.querySelectorAll(GLIDE_COLUMNS) ?? []) {
        lefts.set(el, el.getBoundingClientRect().left);
    }
    return lefts;
}

// the tree column and the terminal pane, so the first agent lands where the skeleton was
// the focused agent's terminal stays laid out, invisible, under Rendered: a terminal starts its controller on its first
// sized fit (termwrap handleResize), so a display:none one would leave a tab that opens Rendered never started
function terminalClass(focused: boolean, paneMode: boolean, showRendered: boolean): string {
    if (!focused || paneMode) {
        return "hidden";
    }
    return showRendered ? "invisible absolute inset-0 flex flex-col" : "flex flex-col";
}

function AgentSurfaceSkeleton() {
    return (
        <div aria-hidden="true" className="flex h-full w-full bg-background">
            <div className="flex w-[248px] shrink-0 flex-col gap-3 border-r border-border bg-surface px-4 pt-4">
                <SkeletonLine className="h-[12px] w-[90px]" />
                {[0, 1, 2, 3].map((i) => (
                    <SkeletonLine key={i} className="h-[30px] w-full rounded-[8px]" />
                ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3 p-5">
                <SkeletonLine className="h-[18px] w-[220px]" />
                <Skeleton className="min-h-0 flex-1 rounded-[10px]" />
            </div>
        </div>
    );
}
