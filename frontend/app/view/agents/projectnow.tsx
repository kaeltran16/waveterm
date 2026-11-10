// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The project Overview's Now region: what runs in the project, and what finished that is not read yet. Both empty
// collapse into one "Now" with a sentence. The pure rows are projectnowmodel.ts.

import { cardVariants, computeEntrances, initialEntranceState, morphTransition } from "@/app/element/motiontokens";
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { MONO_FAINT, ROW_BORDER } from "@/app/view/jarvis/briefstyle";
import { openTarget } from "@/app/view/jarvis/openref";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { formatAge, projectOf, type AgentVM } from "./agentsviewmodel";
import { leadlessCardId } from "./cardgridlayout";
import { agentEventsAtom, seenTsAtom } from "./cockpiteventsrail";
import { RegionHead, RegionNote, type OverviewRegionProps } from "./overviewregion";
import {
    finishedRows,
    isQuiet,
    runningRows,
    type FinishedRow,
    type RunningRow,
    type TerminalRead,
} from "./projectnowmodel";
import { ensureRunEvents, runEventsAtom } from "./runeventstore";
import { leadAgentOf, type Lineage } from "./runlineage";

const RUNNING_COMMAND = "running-command";
const INSTANT: Transition = { duration: 0 };

type CommandSeen = { command: string; since: number };

// each project terminal's running command, from its block's RT info (osc-handlers.ts writes it), read when the
// region opens and when the project's terminals change. A shell without integration never reads as running. The
// first time a command is seen stands in for when it started, which RT info does not record.
function useTerminalReads(terminals: AgentVM[]): TerminalRead[] {
    const [seen, setSeen] = useState<Record<string, CommandSeen | null>>({});
    const key = terminals.map((t) => `${t.id}:${t.blockId ?? ""}`).join(",");
    useEffect(() => {
        let live = true;
        for (const t of terminals) {
            if (!t.blockId) {
                continue;
            }
            RpcApi.GetRTInfoCommand(TabRpcClient, { oref: `block:${t.blockId}` })
                .then((rt) => {
                    if (!live) {
                        return;
                    }
                    const command = rt?.["shell:state"] === RUNNING_COMMAND ? (rt["shell:lastcmd"] ?? "") : null;
                    setSeen((prev) => {
                        const was = prev[t.id];
                        const next =
                            command == null
                                ? null
                                : { command, since: was?.command === command ? was.since : Date.now() };
                        return { ...prev, [t.id]: next };
                    });
                })
                .catch((e) => console.warn(`project overview: rt info read failed for ${t.name}:`, e));
        }
        return () => {
            live = false;
        };
    }, [key]);
    return terminals.map((vm) => ({ vm, command: seen[vm.id]?.command ?? null, since: seen[vm.id]?.since }));
}

// every lineage run's engine events, loaded here because the Cockpit, which loads them otherwise, may be unmounted
function useRunEvents(lineage: Lineage): Record<string, RunEvent[]> {
    const runs = Object.values(lineage.runs).filter((r) => r.channelId);
    const runKey = runs.map((r) => `${r.runId}:${r.channelId}`).join(",");
    useEffect(() => {
        runs.forEach((r) => ensureRunEvents(r.runId, r.channelId));
    }, [runKey]);
    const eventsAtom = useMemo(
        () => atom((get) => Object.fromEntries(runs.map((r) => [r.runId, get(runEventsAtom(r.runId))]))),
        [runKey]
    );
    return useAtomValue(eventsAtom) as Record<string, RunEvent[]>;
}

export function ProjectNow({ model, project, close }: OverviewRegionProps) {
    const agents = useAtomValue(model.agentsAtom);
    const lineage = useAtomValue(model.lineageAtom);
    const allTerminals = useAtomValue(model.terminalsAtom);
    const now = useAtomValue(model.structuralNowAtom);
    const agentEvents = useAtomValue(agentEventsAtom);
    const seenTs = useAtomValue(seenTsAtom);
    const terminals = useTerminalReads(allTerminals.filter((t) => projectOf(t) === project));
    const runEvents = useRunEvents(lineage);
    const running = runningRows(agents, terminals, lineage, project, now);
    const finished = finishedRows({ agentEvents, runEvents, seenTs, project, agents, lineage });

    const open = (kind: "agent" | "run" | "terminal", id: string) => {
        if (kind === "run") {
            // the run's card on the Cockpit: its lead's, or the run's own with no lead in the roster
            const cardId = leadAgentOf(lineage, agents, id)?.id ?? leadlessCardId(id);
            globalStore.set(model.cursorIdAtom, cardId);
            globalStore.set(model.surfaceAtom, "cockpit");
        } else {
            fireAndForget(() => openTarget(model, { kind: "agent", tabId: id }));
        }
        close();
    };

    // A row that moves from Running to Finished is one element changing sections (layoutId), unless it is in
    // both at once (an agent working again with an earlier finish unread), where one id would name two rows.
    // Rows that start running while the region is up enter as cards; keyed on the project, so opening the
    // Overview or switching it to another project never cascades.
    const runningKeys = running.map((r) => `${r.kind}:${r.id}`);
    const finishedKeys = new Set(finished.map((f) => `${f.kind}:${f.id}`));
    const morphId = (key: string, other: { has: (k: string) => boolean }) =>
        other.has(key) ? undefined : `overview-now:${key}`;
    const runningKeySet = new Set(runningKeys);
    const entranceRef = useRef(initialEntranceState());
    const { animate: entering } = computeEntrances(entranceRef.current, project, runningKeys);
    const runningKeysJoined = runningKeys.join(",");
    useLayoutEffect(() => {
        entranceRef.current = computeEntrances(entranceRef.current, project, runningKeys).state;
    }, [runningKeysJoined, project]);

    if (isQuiet(running, finished)) {
        return (
            <section aria-label="Now" className="flex flex-col gap-1.5">
                <RegionHead label="Now" />
                <RegionNote>Nothing runs in {project}.</RegionNote>
            </section>
        );
    }
    return (
        <div className="flex flex-col gap-6">
            {running.length > 0 ? (
                <section aria-label="Running" className="flex flex-col gap-1.5">
                    <RegionHead label="Running" count={running.length} />
                    <div className="relative flex flex-col">
                        {/* a finish reaches the rail a commit after the agent stops running, so the row leaving
                            Running stays for its exit: the Finished row that follows takes its layoutId from it.
                            popLayout lifts the leaving row out of the flow, so that row travels to where it lands
                            rather than below a gap that then closes in one frame */}
                        <AnimatePresence initial={false} mode="popLayout">
                            {running.map((r) => (
                                <NowRow
                                    key={`${r.kind}:${r.id}`}
                                    layoutId={morphId(`${r.kind}:${r.id}`, finishedKeys)}
                                    enter={entering.has(`${r.kind}:${r.id}`)}
                                    kind={r.kind}
                                    mark={<RunningMark kind={r.kind} />}
                                    name={r.name}
                                    line={r.line}
                                    age={formatAge(now - r.since)}
                                    onOpen={() => open(r.kind, r.id)}
                                />
                            ))}
                        </AnimatePresence>
                    </div>
                </section>
            ) : null}
            {finished.length > 0 ? (
                <section aria-label="Finished, not read yet" className="flex flex-col gap-1.5">
                    <RegionHead label="Finished, not read" count={finished.length} />
                    <div className="flex flex-col">
                        {finished.map((f: FinishedRow) => (
                            <NowRow
                                key={`${f.kind}:${f.id}`}
                                layoutId={morphId(`${f.kind}:${f.id}`, runningKeySet)}
                                enter={false}
                                kind={f.kind}
                                mark={
                                    <span className="box-border h-2 w-2 flex-none rounded-full border-[1.5px] border-muted" />
                                }
                                name={f.name}
                                line={f.line}
                                age={formatAge(now - f.ts)}
                                onOpen={() => open(f.kind, f.id)}
                            />
                        ))}
                    </div>
                </section>
            ) : null}
        </div>
    );
}

function RunningMark({ kind }: { kind: RunningRow["kind"] }) {
    if (kind === "run") {
        return <span className="mx-px h-[7px] w-[7px] flex-none rotate-45 rounded-[1px] bg-working" />;
    }
    if (kind === "terminal") {
        return <span className="h-2 w-2 flex-none rounded-full bg-ink-mid" />;
    }
    return <span className="h-2 w-2 flex-none rounded-full bg-working ring-[3px] ring-working/20" />;
}

function NowRow(props: {
    kind: string;
    layoutId: string | undefined;
    enter: boolean;
    mark: ReactNode;
    name: string;
    line: string;
    age: string;
    onOpen: () => void;
    // popLayout measures the leaving row through this ref
    ref?: Ref<HTMLButtonElement>;
}) {
    // MotionConfig's reducedMotion drops transforms but not a layoutId's travel, so reduced motion lands it at once
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    return (
        <motion.button
            ref={props.ref}
            type="button"
            data-overview-now-row={props.kind}
            layoutId={props.layoutId}
            transition={reduce ? INSTANT : morphTransition}
            variants={cardVariants}
            initial={props.enter && !reduce ? "initial" : false}
            exit="exit"
            animate="animate"
            onClick={props.onOpen}
            className={cn(
                ROW_BORDER,
                "flex w-full cursor-pointer items-center gap-2.5 bg-transparent py-2 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            )}
        >
            {props.mark}
            <span className="w-[150px] flex-none truncate text-[13px] text-primary">{props.name}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-mid">{props.line}</span>
            <span className={cn("min-w-10 flex-none whitespace-nowrap text-right", MONO_FAINT)}>{props.age}</span>
        </motion.button>
    );
}
