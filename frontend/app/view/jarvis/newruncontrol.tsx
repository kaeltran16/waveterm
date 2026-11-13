// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// + New run: the app bar's way to start work, from any surface. It was + Channel, which asked you to create a container and then
// find the goal box somewhere else — two steps because the Subjects column owned channel creation and the
// Stage owned composition, and B5 rescued each affordance to wherever it would still mount rather than
// asking whether they were one thing. They are: a project is what you pick, a goal is what you write, and
// the channel underneath is storage that resolves by path or gets minted (newrun.resolveChannelTarget).
//
// The launcher's own controls are here too, not a reduced copy of them. They used to live only on the
// sheet, which renders the launcher while a project has never run and the run body forever after
// (briefsheetmodel: body is "run" once a run exists) — so after the first launch there was no reachable
// way to say "not this time", and every run silently took the profile's shape. The window lays them out in
// two panes (Main.dc.html) but every control writes the launcher's own atoms, which is what keeps one answer
// to what a launch dispatches with: the same atoms, the same profile hydration, the same route.
//
// The window's open state is model.newRunOpenAtom, so deriveKeyContext sees it as a modal. The Brief's `r`
// binding presses the app-bar button by its data attribute (buildJarvisBindings), which is why the
// attribute matters more than the label.

import { CrossFade } from "@/app/element/crossfade";
import { errorNudge, microFade, morphTransition, viewFade } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { DialogButton } from "@/app/modals/dialogbutton";
import { ModalShell } from "@/app/modals/modalshell";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { harnessPreferenceAtom } from "@/app/view/agents/harnessstore";
import { formatChordString } from "@/util/keysym";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import { Bot, Check, Network, Paperclip, X, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { AgentsViewModel } from "../agents/agents";
import { AttachmentTray } from "../agents/attachmenttray";
import { channelsAtom, createChannel, primeChannels } from "../agents/channelsstore";
import { attachmentBlocker, pickFilePaths, useComposerAttachments } from "../agents/composerattachments";
import { noteRecentProject, projectListAtom, recentProjectsAtom } from "../agents/projectsstore";
import { RoutePicker } from "../agents/routepicker";
import {
    channelOverrideAtom,
    createRun,
    loadResolvedProfile,
    resolveChannelLaunchRoute,
    resolvedProfileAtom,
} from "../agents/runactions";
import {
    SHAPE_CARDS,
    effectiveStart,
    launchBlocker,
    startNote,
    startOptions,
    type DesignFirst,
    type RunShape,
    type StartFrom,
} from "../agents/runconfig";
import {
    autonomousAtom,
    beginRunConfigDraft,
    endRunConfigDraft,
    hydrateRunConfigFromProfile,
    lightReviewerRouteAtom,
    parallelismAtom,
    planPathAtom,
    planPreviewAtom,
    resetRunConfigForChannel,
    reviewerPicksAtom,
    reviewerRouteAtom,
    routeTouchedAtom,
    runRouteAtom,
    runShapeAtom,
    setLightReviewerRoute,
    setPlanPath,
    setReviewerPicks,
    setReviewerRoute,
    setRunRoute,
    setRunShape,
    setStart,
    setWorkerRoute,
    startAtom,
    stepParallelism,
    workerRouteAtom,
} from "../agents/runconfigstore";
import { ApprovalsSection, EYEBROW, LauncherSegmented, WorkerStepper, usePlanPreview } from "../agents/runlauncher";
import { planShapeText, planWarnings } from "../orchestrate/dagdigest";
import {
    initialPick,
    launchGoal,
    launchOptsFromConfig,
    prefillToLaunch,
    resolveChannelTarget,
    type NewRunPrefill,
} from "./newrun";
import { planMixLine, planModelRows, workersModelName, type PlanModelTone, type WorkersSetting } from "./newrunplan";
import { openTarget } from "./openref";
import { ProjectPicker } from "./projectpickerview";

// Module scope, not component state: NewRunModalHost unmounts the modal on close, so a project picked for
// one launch was gone by the next one and every run started by re-picking the same project. Not persisted
// — where you last started work is a convenience for the session, not a setting. Exported for the palette,
// which offers its launch rows in the same project.

// What the next open of the window starts from, set by a canvas's Build this… or the palette's Quick and Orchestrate;
// the window clears it once read.
export const newRunPrefillAtom = atom<NewRunPrefill | null>(null) as PrimitiveAtom<NewRunPrefill | null>;

// RoutePicker caps its trigger for the inline rows it usually sits in; a Models row gives it the column, at the
// window's field height
const FULL_WIDTH_PICKER =
    "min-w-0 flex-1 [&>div]:w-full [&>div>button]:h-8 [&>div>button]:w-full [&>div>button]:max-w-none [&>div>button]:justify-between [&>div>button]:rounded-[8px] [&>div>button]:text-[12px]";
const INSTANT: Transition = { duration: 0 };
const SHAPE_ICON: Record<RunShape, LucideIcon> = { orchestrator: Network, quick: Bot };
const PLAN_GRID = "grid grid-cols-[40px_minmax(0,1fr)_96px_112px] gap-x-2.5 px-3";
const START_LABEL: Record<StartFrom, string> = { design: "Approved design", goal: "Goal", plan: "Plan file" };
const DESIGN_FIRST_OPTIONS: DesignFirst[] = ["", "brainstorm", "canvas"];
const DESIGN_FIRST_LABEL: Record<DesignFirst, string> = { "": "Off", brainstorm: "Brainstorm", canvas: "Mock up" };
const MODEL_TONE: Record<PlanModelTone, string> = {
    "plan-live": "text-accent-soft",
    "plan-ignored": "text-ink-faint line-through",
    "at-review": "text-muted",
    workers: "text-ink-mid",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <span className={EYEBROW}>{label}</span>
            {children}
        </div>
    );
}

function ModelRow({
    label,
    attrs,
    children,
}: {
    label: string;
    attrs?: Record<`data-${string}`, string>;
    children: ReactNode;
}) {
    return (
        <div {...attrs} className="flex items-center gap-2">
            <span className="w-[104px] flex-none text-[12.5px] text-ink-mid">{label}</span>
            <div className={FULL_WIDTH_PICKER}>{children}</div>
        </div>
    );
}

function ModelsSection({ orchestrator }: { orchestrator: boolean }) {
    const route = useAtomValue(runRouteAtom);
    const workerRoute = useAtomValue(workerRouteAtom);
    const reviewerPicks = useAtomValue(reviewerPicksAtom);
    const reviewerRoute = useAtomValue(reviewerRouteAtom);
    const lightReviewerRoute = useAtomValue(lightReviewerRouteAtom);
    return (
        <div className="flex flex-col gap-2">
            <span className={EYEBROW}>Models</span>
            <ModelRow label="Lead">
                <RoutePicker value={route} onChange={setRunRoute} placement="bottom-start" title="Lead model" />
            </ModelRow>
            <PaneReveal open={orchestrator}>
                <div className="flex flex-col gap-2">
                    <ModelRow label="Workers">
                        <RoutePicker
                            value={workerRoute}
                            onChange={setWorkerRoute}
                            placement="bottom-start"
                            title="Workers model"
                            canInherit
                            inheritedLabel="Same as lead"
                            extraOption={{
                                label: "Reviewer picks",
                                selected: reviewerPicks,
                                onSelect: () => setReviewerPicks(true),
                            }}
                        />
                    </ModelRow>
                    <ModelRow label="Reviewers">
                        <RoutePicker
                            value={reviewerRoute}
                            onChange={setReviewerRoute}
                            placement="bottom-start"
                            title="Reviewers model"
                            canInherit
                            inheritedLabel="Same as lead"
                        />
                    </ModelRow>
                    <ModelRow label="Light reviewers" attrs={{ "data-light-reviewers-row": "" }}>
                        <RoutePicker
                            value={lightReviewerRoute}
                            onChange={setLightReviewerRoute}
                            placement="bottom-start"
                            title="Light reviewers model"
                            canInherit
                            inheritedLabel="Sonnet (default)"
                        />
                    </ModelRow>
                </div>
            </PaneReveal>
        </div>
    );
}

// The shape as the New agent window lists runtimes: the picked row's fill moves to the new pick (moment 17), and
// the width only an orchestrator has opens inside its row, so the stepper reads as the orchestrator's.
function ShapeRows({ shape, parallelism }: { shape: RunShape; parallelism: number | null }) {
    // MotionConfig's reducedMotion drops transforms but not a layoutId's travel
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    return (
        <div className="flex flex-col gap-2">
            <span className={EYEBROW}>Shape</span>
            <div role="group" aria-label="Shape" className="flex flex-col gap-px">
                {SHAPE_CARDS.map((card) => {
                    const sel = shape === card.id;
                    const Icon = SHAPE_ICON[card.id];
                    return (
                        <div key={card.id} className={cn("relative rounded-[7px]", !sel && "hover:bg-surface-hover")}>
                            {sel ? (
                                <motion.div
                                    layoutId="new-run-shape"
                                    transition={reduce ? INSTANT : morphTransition}
                                    className="absolute inset-0 rounded-[7px] bg-surface-selected"
                                />
                            ) : null}
                            <button
                                type="button"
                                aria-pressed={sel}
                                onClick={() => setRunShape(card.id)}
                                className="relative flex w-full cursor-pointer items-center gap-[9px] rounded-[7px] p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                            >
                                {/* the first child's text is the bare shape name: the CDP scenarios pick a shape by it */}
                                <span className="flex flex-none items-center gap-[9px]">
                                    <Icon
                                        size={16}
                                        strokeWidth={1.8}
                                        aria-hidden
                                        className={cn("transition-colors", sel ? "text-accent-soft" : "text-ink-mid")}
                                    />
                                    <span
                                        className={cn(
                                            "text-[12.5px] font-semibold",
                                            sel ? "text-primary" : "text-muted-foreground"
                                        )}
                                    >
                                        {card.id}
                                    </span>
                                </span>
                                <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">{card.desc}</span>
                                <AnimatePresence initial={false}>
                                    {sel ? (
                                        <motion.span
                                            key="check"
                                            variants={microFade}
                                            initial="initial"
                                            animate="animate"
                                            exit="exit"
                                            className="flex flex-none"
                                        >
                                            <Check size={14} strokeWidth={2.4} className="text-accent" />
                                        </motion.span>
                                    ) : null}
                                </AnimatePresence>
                            </button>
                            {card.id === "orchestrator" ? (
                                <PaneReveal open={sel} className="relative">
                                    <div className="mx-2 flex items-center gap-1.5 border-t border-edge-strong pb-2 pl-[25px] pt-1.5">
                                        <span className="flex-1 text-[12px] text-ink-mid">Workers at once</span>
                                        <WorkerStepper value={parallelism} onStep={stepParallelism} />
                                    </div>
                                </PaneReveal>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function StartToggle({
    start,
    hasDesign,
    onPick,
}: {
    start: StartFrom;
    hasDesign: boolean;
    onPick: (next: StartFrom) => void;
}) {
    return (
        <div className="flex items-center gap-2.5">
            <LauncherSegmented
                label="Start from"
                options={startOptions(hasDesign)}
                labels={START_LABEL}
                value={start}
                onPick={onPick}
            />
            <span className="min-w-0 flex-1 text-[11.5px] leading-[1.45] text-muted">{startNote(start)}</span>
        </div>
    );
}

// The approved design is what the lead plans from, so it is shown, not edited: a design to change goes back to
// the session that made it.
function DesignRow({ attrs, label, path }: { attrs: Record<`data-${string}`, string>; label: string; path: string }) {
    return (
        <span {...attrs} title={path} className="min-w-0 truncate font-mono text-[11.5px] text-muted">
            <span className="text-ink-mid">{label}</span> · {path}
        </span>
    );
}

function DesignRows({ spec, prototype }: { spec: string; prototype: string }) {
    return (
        <div
            data-new-run-design
            className="flex flex-col gap-1 rounded-[8px] border border-border bg-surface px-3 py-2"
        >
            {spec !== "" ? <DesignRow attrs={{ "data-new-run-design-spec": "" }} label="Spec" path={spec} /> : null}
            {prototype !== "" ? (
                <DesignRow attrs={{ "data-new-run-design-prototype": "" }} label="Prototype" path={prototype} />
            ) : null}
        </div>
    );
}

function DesignFirstToggle({ value, onPick }: { value: DesignFirst; onPick: (next: DesignFirst) => void }) {
    return (
        <div className="flex items-center gap-2.5">
            <span className="text-[12.5px] text-ink-mid">Design first</span>
            <LauncherSegmented
                label="Design first"
                options={DESIGN_FIRST_OPTIONS}
                labels={DESIGN_FIRST_LABEL}
                value={value}
                onPick={onPick}
            />
        </div>
    );
}

function PlanTable({ result, workers }: { result: CommandDagPlanPreviewRtnData; workers: WorkersSetting }) {
    const tasks = result.tasks ?? [];
    const mix = planMixLine(tasks, workers);
    return (
        <div data-jarvis-plan-preview="ready" className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex items-baseline gap-2.5">
                {result.title ? (
                    <span className="min-w-0 truncate text-[14px] font-semibold text-ink-hi">{result.title}</span>
                ) : null}
                <span className="flex-none font-mono text-[10.5px] text-ink-mid">{planShapeText(result.shape)}</span>
                <span
                    className={cn(
                        "ml-auto flex-none font-mono text-[10.5px]",
                        mix.accent ? "text-accent-soft" : "text-ink-mid"
                    )}
                >
                    {mix.text}
                </span>
            </div>
            {planWarnings(result.shape, result.verify).map((warning) => (
                <span key={warning} className="font-mono text-[10.5px] text-warning">
                    {warning}
                </span>
            ))}
            <div className="min-h-0 flex-1 overflow-y-auto rounded-[8px] border border-border bg-surface">
                <div
                    className={cn(
                        PLAN_GRID,
                        "sticky top-0 border-b border-border bg-surface py-1.5 font-mono text-[10.5px] uppercase tracking-[.08em] text-muted"
                    )}
                >
                    <span>task</span>
                    <span>title</span>
                    <span>needs</span>
                    <span>model</span>
                </div>
                {planModelRows(tasks, workers).map((row, i) => (
                    <div
                        key={row.id}
                        className={cn(PLAN_GRID, "items-center py-1.5", i > 0 && "border-t border-edge-faint")}
                    >
                        <span className="font-mono text-[10.5px] text-muted">{row.id}</span>
                        <span className="truncate text-[12.5px] text-ink-hi">{row.title}</span>
                        <span className="truncate font-mono text-[10.5px] text-muted">{row.needs}</span>
                        <span
                            title={row.model}
                            className={cn("truncate font-mono text-[10.5px]", MODEL_TONE[row.tone])}
                        >
                            {row.model}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

// The plan is parsed here, before anything is created (spec §1): a plan that will not run shows the parser's
// message in place of the table and holds the start.
function PlanPane({
    projectPath,
    workers,
    inputRef,
}: {
    projectPath: string;
    workers: WorkersSetting;
    inputRef: RefObject<HTMLInputElement>;
}) {
    const path = useAtomValue(planPathAtom);
    const current = usePlanPreview(path, projectPath);
    return (
        <>
            <input
                ref={inputRef}
                data-jarvis-plan-path
                autoFocus
                value={path}
                aria-label="Plan file path"
                onChange={(e) => setPlanPath(e.target.value)}
                placeholder="Plan path, absolute or relative to the project"
                className="h-9 w-full rounded-[8px] border border-edge-mid bg-surface px-3 font-mono text-[12px] text-primary placeholder:text-muted outline-none focus:border-accent-700"
            />
            <CrossFade
                swapKey={current?.error != null ? "error" : current?.result != null ? "result" : "none"}
                className="flex min-h-0 flex-1 flex-col items-stretch"
            >
                {current?.error != null ? (
                    <span data-jarvis-plan-preview="error" className="text-[11.5px] leading-[1.45] text-error">
                        {current.error}
                    </span>
                ) : current?.result != null ? (
                    <PlanTable result={current.result} workers={workers} />
                ) : null}
            </CrossFade>
        </>
    );
}

function NewRunModal({ model, onClose }: { model: AgentsViewModel; onClose: () => void }) {
    const rows = useAtomValue(projectListAtom);
    const recent = useAtomValue(recentProjectsAtom);
    const channels = useAtomValue(channelsAtom);
    const profiles = useAtomValue(resolvedProfileAtom);
    const overrides = useAtomValue(channelOverrideAtom);
    const pref = useAtomValue(harnessPreferenceAtom);
    const shape = useAtomValue(runShapeAtom);
    const parallelism = useAtomValue(parallelismAtom);
    const workerRoute = useAtomValue(workerRouteAtom);
    const reviewerPicks = useAtomValue(reviewerPicksAtom);
    const reviewerRoute = useAtomValue(reviewerRouteAtom);
    const lightReviewerRoute = useAtomValue(lightReviewerRouteAtom);
    const autonomous = useAtomValue(autonomousAtom);
    const startAtomValue = useAtomValue(startAtom);
    const planPath = useAtomValue(planPathAtom);
    const preview = useAtomValue(planPreviewAtom);
    const runRoute = useAtomValue(runRouteAtom);
    const routeTouched = useAtomValue(routeTouchedAtom);
    const names = rows.map((r) => r.name);
    // the project you last started work in, else the only one there is — either way the common case is
    // type-a-goal-and-go rather than pick-the-same-project-again
    const [picked, setPicked] = useState<string | null>(() => initialPick(names, recent[0] ?? null));
    const [goal, setGoal] = useState("");
    // the approved design a prefill brought; read-only, so only a prefill sets them
    const [spec, setSpec] = useState("");
    const [prototype, setPrototype] = useState("");
    const [designFirst, setDesignFirst] = useState<DesignFirst>("");
    // the shape and start a prefill opened the window for, which hydration applies over the profile's
    const [openedShape, setOpenedShape] = useState<RunShape | null>(null);
    const [openedStart, setOpenedStart] = useState<StartFrom | null>(null);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [startPicked, setStartPicked] = useState(false);
    const goalRef = useRef<HTMLTextAreaElement>(null);
    const planRef = useRef<HTMLInputElement>(null);
    const onStartedRef = useRef<((runId: string) => void) | null>(null);
    const { attachments, addPaths, remove, retry, onPaste } = useComposerAttachments();
    const hasDesign = spec !== "" || prototype !== "";
    const startFrom = effectiveStart(startAtomValue, hasDesign);
    const config = {
        shape,
        parallelism,
        workerRoute,
        start: startFrom,
        planPath,
        reviewerPicks,
        reviewerRoute,
        lightReviewerRoute,
        autonomous,
        spec,
        prototype,
        designFirst,
    };
    const orchestrator = shape === "orchestrator";
    // a plan start is named by its plan, so it has no goal field to fill
    const planStart = orchestrator && startFrom === "plan";
    const blocker =
        launchBlocker({ shape, start: startFrom, goal, planPath, preview, designFirst, autonomous }) ??
        (planStart ? null : attachmentBlocker(attachments));
    const projectPath = rows.find((r) => r.name === picked)?.path ?? "";
    const footBlocker = picked == null ? "pick a project" : blocker;

    // The project's own channel is where its profile lives, and a project that has never run has no channel
    // yet — hydrating from `undefined` then leaves the launcher on its baselines, which is the right answer
    // for a project that has never said otherwise.
    const target = picked != null ? resolveChannelTarget(channels, picked, projectPath) : null;
    const pickedOid = target?.kind === "existing" ? target.oid : null;
    // first, so the channel and profile effects below start from it
    useEffect(() => {
        beginRunConfigDraft();
    }, []);
    useEffect(() => {
        // keepTouched: the project is a field of this one launch, not a place you navigated to, so
        // changing it must not rewrite the shape or the width you already picked
        resetRunConfigForChannel(pickedOid, true);
        if (pickedOid != null) {
            loadResolvedProfile(pickedOid);
        }
    }, [pickedOid]);
    useEffect(() => {
        hydrateRunConfigFromProfile(pickedOid != null ? profiles[pickedOid] : null, openedShape, openedStart);
    }, [pickedOid, profiles, openedShape, openedStart]);
    // the lead route the picker opens on, same precedence the sheet's composer uses: the project's own
    // saved route, else the harness preference — and never over a route the user has picked by hand
    const profileRoute = (pickedOid != null ? overrides[pickedOid]?.route : null) ?? pref.route ?? null;
    useEffect(() => {
        if (!routeTouched && profileRoute != null) {
            globalStore.set(runRouteAtom, profileRoute);
        }
    }, [pickedOid, profileRoute, routeTouched]);

    // Waits for the project list: read while it is still loading, the prefill's project would not be found and
    // the pick would be dropped for good, since the atom is cleared on read.
    useEffect(() => {
        const prefill = globalStore.get(newRunPrefillAtom);
        if (prefill == null) {
            return;
        }
        globalStore.set(newRunPrefillAtom, null);
        onStartedRef.current = prefill.onStarted ?? null;
        const p = prefillToLaunch(prefill, names);
        if (p.picked != null) {
            setPicked(p.picked);
        }
        setOpenedShape(p.shape);
        setOpenedStart(p.start);
        setGoal(p.goal);
        setSpec(p.spec);
        setPrototype(p.prototype);
    }, [rows]);

    const select = (project: string) => {
        setPicked(project);
        // back to the field, so the next keystroke types into the launch rather than landing on the picker
        (goalRef.current ?? planRef.current)?.focus();
    };

    const pickStart = (next: StartFrom) => {
        setStartPicked(true);
        setStart(next);
    };

    const register = () => {
        onClose();
        globalStore.set(model.newProjectOpenAtom, true);
    };

    // Picked files are referenced where they are, so no copy and no size cap.
    const pickFiles = () =>
        fireAndForget(async () => {
            try {
                const paths = await pickFilePaths();
                if (paths.length > 0) {
                    addPaths(paths);
                }
            } catch (e) {
                setError(`Could not open the file picker: ${String(e)}`);
            }
        });

    // DEV-only: the new-run-attachments scenario's seam into the dialog's handler, since CDP cannot drive the
    // native dialog
    useEffect(() => {
        if (!import.meta.env.DEV) {
            return;
        }
        const w = window as unknown as { __newRunAttachPaths?: (paths: string[]) => void };
        w.__newRunAttachPaths = addPaths;
        return () => {
            delete w.__newRunAttachPaths;
        };
    }, [addPaths]);

    const start = () => {
        if (picked == null || blocker != null || starting) {
            return;
        }
        if (target == null) {
            setError("Still reading your projects — try again in a moment.");
            return;
        }
        setStarting(true);
        setError(null);
        fireAndForget(async () => {
            let oid: string;
            let run: Run;
            try {
                // a channel minted here and then orphaned by a failed launch is the project's channel
                // either way, so there is nothing to roll back — the next run finds it
                oid = target.kind === "existing" ? target.oid : await createChannel(target.name, target.path);
                // a route the user picked in the Models section is the answer; otherwise resolve the
                // project's own, which also validates that the route is actually available right now
                const route = routeTouched && runRoute != null ? runRoute : await resolveChannelLaunchRoute(oid);
                run = await createRun(oid, launchGoal(config, goal, attachments), route, launchOptsFromConfig(config));
            } catch (e) {
                // only a failure BEFORE the run exists keeps this modal: there is still a launch to retry
                setError(String(e));
                setStarting(false);
                return;
            }
            noteRecentProject(picked);
            const followedByCaller = onStartedRef.current != null;
            onStartedRef.current?.(run.id);
            // the launch consumed this draft, so the next one starts from the project's saved defaults
            endRunConfigDraft(globalStore.get(resolvedProfileAtom)[oid]);
            // The run exists, so the launch has succeeded and the modal's work is done. Landing on it is a
            // separate concern that reports its own failures (openTarget toasts) — holding the modal open
            // over a run that is already running told the user their launch had failed. openTarget rather
            // than openChannelSheet because + New run is on the app bar: a launch from any surface has to
            // switch to the Brief, or the sheet opens where nobody is looking. A caller that follows the run
            // itself (a brainstorm's pane shows its run) keeps the user where they are.
            onClose();
            if (!followedByCaller) {
                await openTarget(model, { kind: "channel", channelId: oid, runId: run.id });
            }
        });
    };

    return (
        <ModalShell
            open
            onClose={onClose}
            onSubmit={start}
            // a stray click outside would throw away a written goal
            dismissOnBackdrop={false}
            className={cn("flex w-[min(960px,94vw)] flex-col", rows.length > 0 && "h-[min(720px,88vh)]")}
        >
            <div
                data-new-run-window
                className="flex shrink-0 items-center gap-[10px] border-b border-border py-[13px] pl-[18px] pr-3"
            >
                <h2 className="m-0 flex-1 text-[15px] font-semibold text-primary">New run</h2>
                <button
                    type="button"
                    aria-label="Close"
                    onClick={onClose}
                    className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[7px] text-muted hover:bg-surface-hover hover:text-primary"
                >
                    <X size={15} strokeWidth={2} />
                </button>
            </div>
            {rows.length === 0 ? (
                <div className="flex flex-col items-start gap-3 px-[18px] pb-5 pt-[18px]">
                    <span className="text-[12.5px] text-secondary">
                        A run needs a project, and none are registered yet.
                    </span>
                    <DialogButton variant="primary" onClick={register}>
                        Register a project
                    </DialogButton>
                </div>
            ) : (
                <>
                    <div className="grid min-h-0 flex-1 grid-cols-[380px_minmax(0,1fr)]">
                        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r border-border px-[18px] py-4">
                            <Field label="Project">
                                <ProjectPicker
                                    projects={rows}
                                    recent={recent}
                                    picked={picked}
                                    onPick={select}
                                    onRegister={register}
                                />
                            </Field>
                            <ShapeRows shape={shape} parallelism={parallelism} />
                            <ModelsSection orchestrator={orchestrator} />
                            <PaneReveal open={orchestrator}>
                                <ApprovalsSection />
                            </PaneReveal>
                        </div>
                        <div className="flex min-h-0 min-w-0 flex-col gap-3 px-[18px] py-4">
                            <PaneReveal open={orchestrator}>
                                <StartToggle start={startFrom} hasDesign={hasDesign} onPick={pickStart} />
                            </PaneReveal>
                            {/* a start the user picks fades its row in; the one the window opens on, or a profile
                                hydrates, does not */}
                            <motion.div
                                key={startFrom}
                                data-new-run-start-row={startFrom}
                                variants={viewFade}
                                initial={startPicked ? "initial" : false}
                                animate="animate"
                                className="flex min-h-0 flex-1 flex-col gap-3"
                            >
                                {orchestrator && startFrom === "design" ? (
                                    <DesignRows spec={spec} prototype={prototype} />
                                ) : null}
                                {planStart ? (
                                    <PlanPane
                                        projectPath={projectPath}
                                        workers={{
                                            picks: reviewerPicks,
                                            model: workersModelName(workerRoute, runRoute),
                                        }}
                                        inputRef={planRef}
                                    />
                                ) : (
                                    <>
                                        <textarea
                                            ref={goalRef}
                                            autoFocus
                                            aria-label="Goal"
                                            value={goal}
                                            onChange={(e) => setGoal(e.target.value)}
                                            onPaste={onPaste}
                                            placeholder="What should it do?"
                                            className="min-h-0 w-full flex-1 resize-none rounded-[8px] border border-edge-mid bg-surface px-3 py-2.5 text-[13px] leading-[1.5] text-primary placeholder:text-muted outline-none focus:border-accent-700"
                                        />
                                        <div data-goal-attachments className="flex items-center gap-2.5">
                                            <button
                                                type="button"
                                                data-attach-files
                                                onClick={pickFiles}
                                                className="flex flex-none cursor-pointer items-center gap-1.5 py-1 text-[12px] font-semibold text-ink-mid hover:text-primary"
                                            >
                                                <Paperclip size={13} aria-hidden />
                                                Attach files
                                            </button>
                                            <AttachmentTray items={attachments} onRemove={remove} onRetry={retry} />
                                        </div>
                                        {orchestrator && startFrom === "goal" ? (
                                            <DesignFirstToggle value={designFirst} onPick={setDesignFirst} />
                                        ) : null}
                                    </>
                                )}
                            </motion.div>
                        </div>
                    </div>
                    <div
                        data-new-run-footer
                        className="flex shrink-0 items-center gap-3 border-t border-border px-[18px] py-[13px]"
                    >
                        {/* the blocker first whenever there is one: a disabled Start run that named the shape
                            instead of saying "Write the goal" read as a dead button, which is what a silent click on
                            it looks like. Keyed by kind, not text, so typing never re-fades the summary. */}
                        <AnimatePresence initial={false} mode="popLayout">
                            {error != null ? (
                                <motion.span
                                    key="error"
                                    data-new-run-error
                                    variants={errorNudge}
                                    initial="initial"
                                    animate="animate"
                                    className="min-w-0 flex-1 truncate text-[12px] text-error"
                                >
                                    {error}
                                </motion.span>
                            ) : (
                                <motion.span
                                    key={footBlocker != null ? "blocker" : "summary"}
                                    variants={microFade}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                    className={cn(
                                        "min-w-0 flex-1 truncate text-[12px]",
                                        footBlocker != null ? "text-secondary" : "text-muted"
                                    )}
                                >
                                    {footBlocker ?? (
                                        <>
                                            <span className="font-mono text-[11px] text-ink-hi">
                                                {orchestrator ? `${shape} × ${parallelism}` : shape}
                                            </span>
                                            {" in "}
                                            <span className="font-mono text-[11px] text-ink-hi">{picked}</span>
                                            {orchestrator && autonomous ? " · autonomous" : ""}
                                        </>
                                    )}
                                </motion.span>
                            )}
                        </AnimatePresence>
                        <DialogButton data-new-run-cancel variant="secondary" hint="esc" onClick={onClose}>
                            Cancel
                        </DialogButton>
                        <DialogButton
                            data-new-run-start
                            variant="primary"
                            hint={formatChordString("Cmd:Enter")}
                            disabled={footBlocker != null || starting}
                            onClick={start}
                        >
                            <CrossFade swapKey={starting ? "starting" : "idle"}>
                                {starting ? "Starting…" : "Start run"}
                            </CrossFade>
                        </DialogButton>
                    </div>
                </>
            )}
        </ModalShell>
    );
}

export function NewRunModalHost({ model }: { model: AgentsViewModel }) {
    const open = useAtomValue(model.newRunOpenAtom);
    // only the Brief loads the channel list, so a window opened from any other surface before the Brief
    // has mounted would wait on it forever; primeChannels, not loadChannels, which also selects a channel
    useEffect(() => {
        if (open) {
            fireAndForget(primeChannels);
        }
    }, [open]);
    return open ? <NewRunModal model={model} onClose={() => globalStore.set(model.newRunOpenAtom, false)} /> : null;
}
