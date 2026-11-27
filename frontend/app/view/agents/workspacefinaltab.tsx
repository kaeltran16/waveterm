// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The workspace pane's Final tab: a run's Final verification, round by round, opened beside the Final stage's row
// or an ended verifier's transcript in place of the details rail (boards Final, Final-Failed and Verifier). What
// it shows is finalTabView's; this file only draws it.

import { morphTransition } from "@/app/element/motiontokens";
import { ViewSwap } from "@/app/element/viewswap";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { FinalShotsViewer } from "@/app/view/jarvis/finalshotsviewer";
import { useLocalImage } from "@/app/view/jarvis/localimage";
import { cn } from "@/util/util";
import { atom, useAtomValue, type Atom } from "jotai";
import { ArrowUpRight } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import {
    finalTabView,
    type FinalTabFrame,
    type FinalTabScenario,
    type FinalTabSection,
    type FinalTabView,
} from "./finalstage";
import { FinalFacts } from "./finalstagerail";
import { lineCountsShown } from "./gitstatus";
import { useRailGit } from "./railgit";
import type { RailGitState } from "./railstore";
import { useRunEvents } from "./runeventstore";
import { leadAgentOf, verifierStepTarget, type RunInfo } from "./runlineage";
import { FINAL_FILL } from "./runstrip";
import { AddsDels, ToolPanel } from "./steprows";
import { changesLine } from "./workspacechangesmodel";
import { tabKey, type WorkspaceTab } from "./workspacemodel";
import { openWorkspaceTab, updateWorkspaceTab } from "./workspacestore";

type FinalTabProps = {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "final" }>;
};

const NO_RUN: Atom<Run | undefined> = atom(undefined as Run | undefined);
const H3 = "m-0 text-[12px] font-semibold text-ink-mid";
const META = "font-mono text-[11px] text-muted";
const LINK_BUTTON =
    "inline-flex flex-none cursor-pointer items-center gap-[5px] rounded-[6px] border border-edge-strong px-[9px] py-[3px] text-[12px] text-secondary hover:bg-surface-hover";

export function FinalTab({ model, agent, tab }: FinalTabProps) {
    // the lead's run from the lineage the tree already holds, so a run only the page knows still reads
    const run = useAtomValue(model.lineageAtom).runs[tab.runId];
    const lineage = useAtomValue(model.lineageAtom);
    const agents = useAtomValue(model.agentsAtom);
    const now = useAtomValue(model.nowAtom);
    const events = useRunEvents(tab.runId, run?.channelId ?? "");
    const group = run?.dag;
    // the shown round's verifier session: its model and when it ended
    const shownRound = tab.round ?? group?.final?.round;
    const shownStage = [group?.final, ...(group?.pastfinals ?? [])].find((s) => s != null && s.round === shownRound);
    const verifierRunId = shownStage?.verifierrunid;
    const verifierRun = useAtomValue(
        verifierRunId ? WOS.getWaveObjectAtom<Run>(WOS.makeORef("run", verifierRunId)) : NO_RUN
    );
    const lead = leadAgentOf(lineage, agents, tab.runId);
    const view = finalTabView(group, events, now, {
        round: tab.round,
        session: tab.session,
        verifierRun: verifierRun ?? undefined,
        lead: lead ? { asking: lead.state === "asking" } : undefined,
    });
    // Open transcript only where a target exists: the current round's verifier, and not the row already shown
    const target = run && view?.current ? verifierStepTarget(run, agents) : undefined;
    const openTranscript =
        target != null && target !== agent.id ? () => globalStore.set(model.focusIdAtom, target) : undefined;
    const pickRound = (round: number) => updateWorkspaceTab(agent.id, tabKey(tab), { round });
    // the Changes tab's read, held here too so the counts land while that tab is unseen; holding adds no read
    const changes = landedChanges(useRailGit(agent), group?.final?.commit);

    return (
        <div data-workspace-final={tab.runId} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div
                data-workspace-final-head
                className="flex flex-none flex-col gap-[8px] border-b border-border px-[18px] pb-[14px] pt-[16px]"
            >
                <div className="flex items-center gap-[10px]">
                    <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-primary">
                        Final verification
                    </span>
                    {view ? (
                        <>
                            <span
                                data-final-tab-state={view.stage.state}
                                className="inline-flex flex-none items-center gap-[5px] text-[12px] text-secondary"
                            >
                                <span
                                    aria-hidden
                                    className={cn(
                                        "h-[6px] w-[6px] rounded-full",
                                        view.tone === "wait" ? "border border-muted" : FINAL_FILL[view.tone]
                                    )}
                                />
                                {view.state}
                            </span>
                            <RoundSwitch rounds={view.rounds} round={view.round} onPick={pickRound} />
                        </>
                    ) : null}
                </div>
                {view ? (
                    <div data-final-tab-meta className="font-mono text-[11px] text-muted">
                        {view.meta}
                    </div>
                ) : null}
            </div>
            {view && run ? (
                <ViewSwap
                    swapKey={String(view.round)}
                    className="flex flex-col gap-[18px] px-[18px] pb-[20px] pt-[16px]"
                >
                    {view.order.map((section) => (
                        <Section
                            key={section}
                            section={section}
                            view={view}
                            run={run}
                            leadAsking={lead?.state === "asking"}
                            changes={changes}
                            onOpenTranscript={openTranscript}
                            onOpenChanges={() => openWorkspaceTab(agent.id, { kind: "changes", selected: null })}
                        />
                    ))}
                </ViewSwap>
            ) : (
                <div className="px-[18px] py-[16px] text-[12.5px] text-muted">Final verification has not started.</div>
            )}
        </div>
    );
}

// the rail's counts once its read for this row has landed: the range Final verified, else the lead's run before
// Final has a commit. Another row's read, still shown while this row's starts, is left out
function landedChanges(rail: RailGitState | null, finalCommit: string | undefined): ChangesCounts | null {
    if (rail?.changes == null) {
        return null;
    }
    const landed = finalCommit ? rail.verified?.commit === finalCommit : rail.run === true && rail.verified == null;
    return landed ? { ...changesLine(rail), counted: lineCountsShown(rail.changes) } : null;
}

type ChangesCounts = ReturnType<typeof changesLine> & { counted: boolean };

// the round switch; the active fill is one shared layoutId, so a pick moves it (moment 17). One round has no switch
function RoundSwitch({ rounds, round, onPick }: { rounds: number[]; round: number; onPick: (n: number) => void }) {
    if (rounds.length < 2) {
        return null;
    }
    return (
        <div
            role="tablist"
            aria-label="Rounds"
            className="flex flex-none overflow-hidden rounded-[6px] border border-edge-mid text-[12px]"
        >
            {rounds.map((n) => (
                <button
                    key={n}
                    type="button"
                    role="tab"
                    aria-selected={n === round}
                    data-final-tab-round={n}
                    onClick={() => onPick(n)}
                    className={cn(
                        "relative cursor-pointer px-[10px] py-[4px]",
                        n === round ? "text-primary" : "text-muted hover:text-secondary"
                    )}
                >
                    {n === round ? (
                        <motion.span
                            layoutId="workspace-final-round-indicator"
                            aria-hidden
                            transition={morphTransition}
                            className="absolute inset-0 bg-surface-selected"
                        />
                    ) : null}
                    <span className="relative">Round {n}</span>
                </button>
            ))}
        </div>
    );
}

function Section({
    section,
    view,
    run,
    leadAsking,
    changes,
    onOpenTranscript,
    onOpenChanges,
}: {
    section: FinalTabSection;
    view: FinalTabView;
    run: RunInfo;
    leadAsking: boolean;
    changes: ChangesCounts | null;
    onOpenTranscript?: () => void;
    onOpenChanges: () => void;
}) {
    switch (section) {
        case "verified":
            return (
                <section data-final-tab-section="verified" className="flex flex-col">
                    <h3 className={cn(H3, "mb-[4px]")}>Verified</h3>
                    <FinalFacts run={run} stage={view.stage} />
                </section>
            );
        case "why":
            return (
                <section data-final-tab-section="why" className="flex flex-col gap-[8px]">
                    <h3 className={H3}>Why it failed</h3>
                    <ToolPanel error={view.why?.detail || undefined} />
                    {view.why?.note ? (
                        <div
                            data-final-tab-lead
                            className={cn("text-[12.5px]", leadAsking ? "text-asking" : "text-ink-mid")}
                        >
                            {view.why.note}
                        </div>
                    ) : null}
                </section>
            );
        case "verifier":
            return <VerifierSection view={view} onOpenTranscript={onOpenTranscript} />;
        case "shots":
            return <ShotsSection view={view} group={run.dag} />;
        case "changes":
            return (
                <section data-final-tab-section="changes" className="flex items-center gap-[10px]">
                    <h3 className={H3}>Changes</h3>
                    <span data-final-tab-changes className={cn(META, "flex flex-1 items-center gap-[6px]")}>
                        {changes != null ? (
                            <>
                                {changes.count}
                                {changes.counted ? <AddsDels adds={changes.adds} dels={changes.dels} compact /> : null}
                            </>
                        ) : null}
                    </span>
                    <button
                        type="button"
                        data-final-tab-open-changes
                        onClick={onOpenChanges}
                        className="inline-flex cursor-pointer items-center rounded-[6px] border border-edge-mid px-[9px] py-[3px] text-[12px] text-secondary hover:border-edge-strong"
                    >
                        Open changes
                    </button>
                </section>
            );
    }
}

function VerifierSection({ view, onOpenTranscript }: { view: FinalTabView; onOpenTranscript?: () => void }) {
    const v = view.verifier;
    const meta = [v.session ? "this session" : "", v.meta].filter(Boolean).join(" · ");
    return (
        <section
            data-final-tab-section="verifier"
            data-final-tab-verifier-ran={v.ran}
            data-final-tab-session={v.session || undefined}
            className="flex flex-col gap-[8px]"
        >
            <h3 className={H3}>Verifier</h3>
            {v.ran ? (
                <div
                    className={cn(
                        "flex flex-col gap-[6px] rounded-[8px] border px-[11px] py-[9px]",
                        v.session ? "border-accent" : "border-edge-mid"
                    )}
                >
                    <span className="whitespace-pre-wrap break-words text-[12.5px] leading-[1.55] text-secondary">
                        {v.text}
                    </span>
                    <span className="flex items-center gap-[8px]">
                        <span data-final-tab-verifier-meta className="flex-1 font-mono text-[11px] text-muted">
                            {meta}
                        </span>
                        {onOpenTranscript ? (
                            <button
                                type="button"
                                data-final-tab-open-transcript
                                onClick={onOpenTranscript}
                                className={LINK_BUTTON}
                            >
                                Open transcript
                                <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
                            </button>
                        ) : null}
                    </span>
                </div>
            ) : (
                <div className="text-[12.5px] text-muted">{v.text}</div>
            )}
        </section>
    );
}

function tally(s: FinalTabScenario): string {
    return s.ran > 0
        ? `${s.passed} of ${s.ran} steps`
        : `${s.frames.length} ${s.frames.length === 1 ? "shot" : "shots"}`;
}

function ShotsSection({ view, group }: { view: FinalTabView; group: TaskGroup | undefined }) {
    // the viewer mounts only while open: mounting is what claims the keys and the modal stack
    const [viewing, setViewing] = useState<{ scenario: string; file: string } | null>(null);
    return (
        <section data-final-tab-section="shots" className="flex flex-col gap-[8px]">
            <h3 className={H3}>Screenshots</h3>
            {view.shots.length === 0 ? (
                <div data-final-tab-shots-empty className="text-[12.5px] text-muted">
                    {view.emptyShots}
                </div>
            ) : (
                view.shots.map((s) => (
                    <div key={s.name} data-final-tab-scenario={s.name} className="flex flex-col gap-[6px]">
                        <div className="flex items-center gap-[8px] text-[12.5px] text-secondary">
                            <span className="min-w-0 truncate font-mono text-[12px]">{s.name}</span>
                            <span className="flex-1" />
                            {s.failed > 0 ? (
                                <span className="flex-none font-mono text-[11px] text-error">{s.failed} failed</span>
                            ) : null}
                            <span className="flex-none font-mono text-[11px] text-muted">
                                {s.failed > 0 ? "· " : ""}
                                {tally(s)}
                            </span>
                        </div>
                        <div className="flex flex-wrap gap-[6px]">
                            {s.frames.map((f) => (
                                <Thumb
                                    key={f.file}
                                    outDir={view.stage.outdir ?? ""}
                                    scenario={s.name}
                                    frame={f}
                                    onOpen={() => setViewing({ scenario: s.name, file: f.file })}
                                />
                            ))}
                        </div>
                    </div>
                ))
            )}
            {viewing && group ? (
                <FinalShotsViewer
                    group={group}
                    initial={{ round: view.round, scenario: viewing.scenario, file: viewing.file }}
                    onClose={() => setViewing(null)}
                />
            ) : null}
        </section>
    );
}

function Thumb({
    outDir,
    scenario,
    frame,
    onOpen,
}: {
    outDir: string;
    scenario: string;
    frame: FinalTabFrame;
    onOpen: () => void;
}) {
    const img = useLocalImage(`${outDir}/${frame.file}`);
    const title =
        frame.step != null
            ? `${scenario} · step ${frame.label}${frame.failed ? " · failed" : ""}`
            : `${scenario} · ${frame.file}`;
    return (
        <button
            type="button"
            title={title}
            data-final-tab-shot={frame.file}
            data-final-tab-shot-failed={frame.failed || undefined}
            onClick={onOpen}
            className={cn(
                "flex h-[80px] w-[128px] flex-none cursor-pointer flex-col overflow-hidden rounded-[6px] border bg-background p-0 text-left",
                frame.failed ? "border-error" : "border-edge-mid hover:border-edge-strong"
            )}
        >
            <span className="block min-h-0 flex-1 overflow-hidden">
                {img.url != null ? (
                    <img src={img.url} alt="" className="block size-full object-cover object-left-top" />
                ) : null}
            </span>
            <span
                className={cn(
                    "flex-none truncate px-[6px] py-[3px] font-mono text-[10.5px]",
                    frame.failed ? "text-error" : "text-ink-mid"
                )}
            >
                {frame.label}
            </span>
        </button>
    );
}
