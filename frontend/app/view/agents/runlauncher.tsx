// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The run launcher: shape, which machine fans out, how wide, and the two routes. It fills the Stage's
// thread slot while a run is being composed, directly above the goal box it configures.
//
// It lived in the right rail for one iteration and that was wrong twice over. The rail is 300px, so the
// three shape cards stacked into a column instead of reading side by side; and the rail is collapsible
// and persisted, so a user who had collapsed it lost every run control with no way back. The deeper
// problem was that the middle of the screen during composition is an empty state telling you to look
// somewhere else, while the primary action of the surface hid in a reading panel.
//
// Which sections a given shape actually has is decided by runconfig.runLauncherFace; this file renders.

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { ORCHESTRATION_OPTIONS, type Orchestration } from "./orchestratorpicker";
import { RoutePicker } from "./routepicker";
import { MAX_DAG_TASKS, MAX_PARALLELISM, SHAPE_CARDS, machineNote, runLauncherFace } from "./runconfig";
import {
    orchestrationAtom,
    parallelismAtom,
    routeOpenRequestAtom,
    runRouteAtom,
    runShapeAtom,
    setOrchestration,
    setRunRoute,
    setRunShape,
    setWorkerRoute,
    stepParallelism,
    workerRouteAtom,
} from "./runconfigstore";

export const EYEBROW = "font-mono text-[9px] font-bold uppercase tracking-[.12em] text-muted";

// One selectable card treatment for both pickers, so the shape and the machine read as the same kind of
// choice. Tokens only — a literal colour here would opt the launcher out of every runtime theme.
function pickTone(active: boolean): string {
    return active
        ? "border-accent/40 bg-accentbg text-accent-soft"
        : "border-border bg-surface-raised text-secondary hover:border-edge-mid";
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className={EYEBROW}>{label}</span>
            {children}
        </div>
    );
}

// Side by side rather than stacked: the three shapes are alternatives to one another, and a column made
// the reader compare them in sequence instead of at a glance.
function ShapeCards() {
    const shape = useAtomValue(runShapeAtom);
    return (
        <Section label="Shape">
            <div className="grid grid-cols-3 gap-2">
                {SHAPE_CARDS.map((card) => (
                    <button
                        key={card.id}
                        type="button"
                        aria-pressed={shape === card.id}
                        onClick={() => setRunShape(card.id)}
                        className={cn(
                            "flex cursor-pointer flex-col gap-1 rounded-[9px] border px-3 py-2.5 text-left",
                            pickTone(shape === card.id)
                        )}
                    >
                        <span className="font-mono text-[12px] font-semibold capitalize">{card.id}</span>
                        <span className="text-[11px] leading-[1.45] text-muted">{card.desc}</span>
                    </button>
                ))}
            </div>
        </Section>
    );
}

function MachineCards() {
    const orchestration = useAtomValue(orchestrationAtom);
    return (
        <Section label="Who fans out">
            <div className="flex gap-2">
                {ORCHESTRATION_OPTIONS.map((option: Orchestration) => (
                    <button
                        key={option}
                        type="button"
                        aria-pressed={orchestration === option}
                        onClick={() => setOrchestration(option)}
                        className={cn(
                            "cursor-pointer rounded-[7px] border px-3 py-1.5 font-mono text-[11.5px] font-semibold capitalize",
                            pickTone(orchestration === option)
                        )}
                    >
                        {option}
                    </button>
                ))}
            </div>
            <span className="text-[11px] leading-[1.45] text-muted">{machineNote(orchestration)}</span>
        </Section>
    );
}

// The width dial. It sits with the plan rather than in a settings panel because it is the one control
// whose cost the user pays directly: N concurrent children are N live worktrees and N token streams.
function ParallelismStepper() {
    const par = useAtomValue(parallelismAtom);
    return (
        <Section label="Parallelism">
            <div className="flex items-center gap-2.5 self-start rounded-[8px] border border-edge-mid bg-surface-raised px-2.5 py-1.5">
                <button
                    type="button"
                    onClick={() => stepParallelism(-1)}
                    disabled={par <= 1}
                    aria-label="Fewer concurrent children"
                    className="h-6 w-6 cursor-pointer rounded-[6px] border border-edge-mid font-mono text-[13px] font-semibold text-secondary hover:text-primary disabled:cursor-default disabled:opacity-40"
                >
                    −
                </button>
                <span aria-live="polite" className="w-[18px] text-center font-mono text-[14px] font-bold text-primary">
                    {par}
                </span>
                <button
                    type="button"
                    onClick={() => stepParallelism(1)}
                    disabled={par >= MAX_PARALLELISM}
                    aria-label="More concurrent children"
                    className="h-6 w-6 cursor-pointer rounded-[6px] border border-edge-mid font-mono text-[13px] font-semibold text-secondary hover:text-primary disabled:cursor-default disabled:opacity-40"
                >
                    ＋
                </button>
                <span className="text-[11px] leading-[1.35] text-muted">
                    concurrent children · {MAX_DAG_TASKS} tasks max
                </span>
            </div>
        </Section>
    );
}

// `bottom-start` because the launcher is top-aligned in the thread slot: a menu opening upward from here
// would run off the top of the Stage, and one opening downward has the whole thread height to use.
function RoutingSection({ showWorkerRoute }: { showWorkerRoute: boolean }) {
    const route = useAtomValue(runRouteAtom);
    const workerRoute = useAtomValue(workerRouteAtom);
    const openRequest = useAtomValue(routeOpenRequestAtom);
    return (
        <Section label="Routing">
            <div className="flex flex-wrap items-center gap-2">
                <RoutePicker
                    value={route}
                    onChange={setRunRoute}
                    placement="bottom-start"
                    openRequest={openRequest}
                    title="Lead model"
                />
                {showWorkerRoute ? (
                    <RoutePicker
                        value={workerRoute}
                        onChange={setWorkerRoute}
                        placement="bottom-start"
                        title="Workers model"
                        inheritedLabel="Same as lead"
                    />
                ) : null}
            </div>
        </Section>
    );
}

// The controls themselves, without the intro. The + Run modal names the project and the action in its own
// header, so it renders these directly rather than printing a second heading over the same three sections.
export function RunLauncherSections() {
    const shape = useAtomValue(runShapeAtom);
    const orchestration = useAtomValue(orchestrationAtom);
    const face = runLauncherFace(shape, orchestration);
    return (
        <>
            <ShapeCards />
            {face.showMachine ? <MachineCards /> : null}
            {face.showParallelism ? <ParallelismStepper /> : null}
            <RoutingSection showWorkerRoute={face.showWorkerRoute} />
        </>
    );
}

// No Launch button of its own: the goal and its `Run ⏎` are in the composer immediately below, and a
// second button here would have to reach across components to submit through that same face.
export function RunLauncher({ projectName }: { projectName: string }) {
    return (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-2">
            <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
                <div className="flex flex-col gap-1">
                    <span className="text-[15px] font-semibold text-primary">Start a run in {projectName}</span>
                    <span className="text-[12px] leading-[1.5] text-muted">
                        Set it up here, then give Jarvis the goal below and press Run ⏎. Typing @quick, @run or @ask in
                        the goal overrides the shape for that one launch.
                    </span>
                </div>
                <RunLauncherSections />
            </div>
        </div>
    );
}
