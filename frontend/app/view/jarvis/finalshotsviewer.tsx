// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Final check's screenshots, every finished round (.superpowers/design/final-shots: Viewer and States
// boards). Opened from the run sheet; everything it shows is derived in finalshotsmodel.ts.

import { modalBackdrop, modalPanel, morphTransition, MOTION, viewFade } from "@/app/element/motiontokens";
import { StepSwap } from "@/app/element/stepswap";
import { TickNumber } from "@/app/element/ticknumber";
import { focusTrapTarget, takeModalFocus } from "@/app/modals/modalfocus";
import { registerModal } from "@/app/modals/modalstack";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { buildFinalShotsBindings } from "@/app/store/keybindings/bindings";
import { useKeybindings } from "@/app/store/keybindings/store";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, motion, MotionConfig, type Variants } from "motion/react";
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
    clampSelection,
    emptyRoundText,
    roundLabel,
    roundTally,
    scenarioTally,
    shotPath,
    shotRounds,
    type ShotRound,
    type ShotScenario,
    type ShotVerdict,
} from "./finalshotsmodel";
import { finalShotsViewerOpenAtom } from "./finalshotsstore";
import { useLocalImage } from "./localimage";

const MODAL_ID = "final-shots-viewer";
const FOCUSABLE_SELECTOR =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const ROUND_DOT: Record<string, string> = { passed: "bg-success", failed: "bg-error", unverified: "bg-warning" };
export const VERDICT_DOT: Record<ShotVerdict, string> = {
    pass: "bg-success",
    fail: "bg-error",
    none: "border border-muted", // a plain listing entry has no verdict
};
const STEP_BADGE: Record<FinalShotStep["state"], { label: string; cls: string }> = {
    pass: { label: "PASS", cls: "border-success text-success-soft" },
    fail: { label: "FAIL", cls: "border-error text-error-soft" },
    skip: { label: "SKIP", cls: "border-warning text-warning-soft" },
};

// the steps drawer sits beside the stage, so it reveals along its width (a pane reveal's timing) and the stage
// narrows with it instead of jumping
const DRAWER_PX = 360;
const drawerReveal: Variants = {
    initial: { width: 0, opacity: 0 },
    animate: { width: DRAWER_PX, opacity: 1, transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid } },
    exit: { width: 0, opacity: 0, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } },
};

function baseName(file: string): string {
    return file.slice(file.lastIndexOf("/") + 1);
}

function Dot({ cls, size = "size-[7px]" }: { cls: string; size?: string }) {
    return <span className={cn("flex-none rounded-full", size, cls)} aria-hidden="true" />;
}

function toggleBtn(on: boolean): string {
    return cn(
        "inline-flex cursor-pointer items-center gap-[7px] rounded-md border px-[11px] py-1.5 text-xs",
        on ? "border-accent bg-accentbg text-accent-soft" : "border-edge-mid bg-modalbg text-secondary"
    );
}

export function FinalShotsViewer({
    group,
    initial,
    onClose,
}: {
    group: TaskGroup;
    // file: the screenshot of that scenario to open on, as a step's thumbnail names it
    initial: { round: number; scenario?: string; file?: string };
    onClose: () => void;
}): JSX.Element {
    const rounds = useMemo(() => shotRounds(group), [group]);
    const [roundNo, setRoundNo] = useState(initial.round);
    const round = rounds.find((r) => r.round === roundNo) ?? rounds[rounds.length - 1];
    // dir is the way the last screenshot move went (+1 next, -1 previous), for the step slide
    const [sel, setSel] = useState(() => {
        const s = Math.max(0, round?.scenarios.findIndex((x) => x.name === initial.scenario) ?? 0);
        const k = Math.max(0, round?.scenarios[s]?.files.indexOf(initial.file) ?? 0);
        return { s, k, dir: 1 };
    });
    const [zoom, setZoom] = useState(false);
    // null: the drawer follows the scenario (open where a step failed) until the human toggles it
    const [stepsToggle, setStepsToggle] = useState<boolean | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    // a scenario or round switch fades the view in, but opening the viewer is the panel's own entrance
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
    }, []);

    // a dag update can shrink the round on screen
    const { s, k } = round ? clampSelection(round, sel.s, sel.k) : { s: 0, k: 0 };
    const scenario: ShotScenario | undefined = round?.scenarios[s];
    const file = scenario?.files[k];
    const stepsOpen = !!round?.manifest && !!scenario && (stepsToggle ?? scenario.verdict === "fail");

    const pickRound = (n: number) => {
        setRoundNo(n);
        setSel({ s: 0, k: 0, dir: 1 });
        setStepsToggle(null);
    };
    const pickScenario = (i: number) => {
        setSel({ s: i, k: 0, dir: 1 });
        setStepsToggle(null);
    };
    const pickShot = (next: number) => setSel({ s, k: next, dir: Math.sign(next - k) || 1 });
    const handlers = {
        scenario: (d: 1 | -1) => {
            const next = s + d;
            if (round && next >= 0 && next < round.scenarios.length) {
                pickScenario(next);
            }
        },
        shot: (d: 1 | -1) => {
            const next = k + d;
            if (scenario && next >= 0 && next < scenario.files.length) {
                pickShot(next);
            }
        },
        zoom: () => setZoom((z) => !z),
        steps: () => {
            if (round?.manifest) {
                setStepsToggle(!stepsOpen);
            }
        },
        close: onClose,
    };
    // the bindings are registered once; they reach the current render's state through this ref
    const handlersRef = useRef(handlers);
    handlersRef.current = handlers;
    const bindings = useMemo(
        () =>
            buildFinalShotsBindings({
                scenario: (d) => handlersRef.current.scenario(d),
                shot: (d) => handlersRef.current.shot(d),
                zoom: () => handlersRef.current.zoom(),
                steps: () => handlersRef.current.steps(),
                close: () => handlersRef.current.close(),
            }),
        []
    );
    useKeybindings(bindings);

    useEffect(() => {
        globalStore.set(finalShotsViewerOpenAtom, true);
        // top of the modal stack, so the run sheet's shell underneath yields Escape
        const unregister = registerModal(MODAL_ID);
        const restore = takeModalFocus(panelRef.current, document.activeElement as HTMLElement | null);
        // Tab is not a cockpit binding: keep it inside the dialog the way the DAG modal does
        const onTab = (e: KeyboardEvent) => {
            if (e.key !== "Tab" || panelRef.current == null) {
                return;
            }
            e.preventDefault();
            const focusables = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
            (focusTrapTarget(focusables, document.activeElement, e.shiftKey) ?? panelRef.current).focus();
        };
        window.addEventListener("keydown", onTab);
        return () => {
            window.removeEventListener("keydown", onTab);
            globalStore.set(finalShotsViewerOpenAtom, false);
            unregister();
            restore();
        };
    }, []);

    const buttons = (
        <>
            <button type="button" onClick={handlers.zoom} aria-pressed={zoom} className={toggleBtn(zoom)}>
                {zoom ? "Actual size" : "Fit"}
            </button>
            {round?.manifest && scenario != null && (
                <button
                    type="button"
                    onClick={handlers.steps}
                    aria-expanded={stepsOpen}
                    className={toggleBtn(stepsOpen)}
                >
                    <Dot cls={VERDICT_DOT[scenario.verdict]} />
                    Steps {scenarioTally(scenario).short}
                </button>
            )}
        </>
    );

    // portaled: the run sheet's panel is transformed, which would make it the containing block of a fixed child
    return createPortal(
        <MotionConfig reducedMotion="user">
            <motion.div
                variants={modalBackdrop}
                initial="initial"
                animate="animate"
                className="fixed inset-0 z-[70] bg-black/60"
                onMouseDown={(e) => {
                    if (e.target === e.currentTarget) {
                        onClose();
                    }
                }}
            >
                <motion.div
                    ref={panelRef}
                    variants={modalPanel}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Final check screenshots"
                    tabIndex={-1}
                    data-final-shots-viewer=""
                    className="absolute inset-4 flex flex-col overflow-hidden rounded-xl border border-edge-mid bg-modalbg text-foreground shadow-popover outline-none"
                >
                    <ViewerHeader rounds={rounds} round={round} onPick={pickRound} onClose={onClose} />
                    {round == null || round.scenarios.length === 0 ? (
                        <motion.div
                            key={`empty:${round?.round}`}
                            variants={viewFade}
                            initial={mounted.current ? "initial" : false}
                            animate="animate"
                            data-final-shots-empty=""
                            className="flex flex-1 items-center justify-center text-xs text-ink-mid"
                        >
                            {emptyRoundText(
                                [...(group.pastfinals ?? []), group.final].find(
                                    (f) => f != null && f.round === round?.round
                                )
                            )}
                        </motion.div>
                    ) : (
                        <>
                            <ScenarioTabs round={round} current={s} onPick={pickScenario} />
                            <motion.div
                                key={`${round.round}:${s}`}
                                data-final-shots-view=""
                                variants={viewFade}
                                initial={mounted.current ? "initial" : false}
                                animate="animate"
                                className="flex min-h-0 flex-1"
                            >
                                <div className="flex min-w-0 flex-1 flex-col bg-surface-code">
                                    {file == null ? (
                                        // a scenario that threw before its first screenshot
                                        <>
                                            <ShotToolbar buttons={buttons} />
                                            <Stage zoom={zoom}>
                                                <span className="text-xs text-ink-mid">No screenshot</span>
                                            </Stage>
                                        </>
                                    ) : (
                                        <Shot
                                            path={shotPath(round, file)}
                                            file={file}
                                            pos={`${k + 1} of ${scenario.files.length}`}
                                            dir={sel.dir}
                                            zoom={zoom}
                                            onToggleZoom={handlers.zoom}
                                            buttons={buttons}
                                        />
                                    )}
                                    <Filmstrip round={round} scenario={scenario} current={k} onPick={pickShot} />
                                </div>
                                <StepsDrawer open={stepsOpen} scenario={scenario} />
                            </motion.div>
                        </>
                    )}
                </motion.div>
            </motion.div>
        </MotionConfig>,
        document.body
    );
}

function ViewerHeader({
    rounds,
    round,
    onPick,
    onClose,
}: {
    rounds: ShotRound[];
    round: ShotRound | undefined;
    onPick: (n: number) => void;
    onClose: () => void;
}) {
    return (
        <div className="flex h-12 flex-none items-center gap-3 border-b border-edge-mid pl-4 pr-2.5">
            <span className="text-[13px] font-semibold">Final check</span>
            {rounds.length > 1 ? (
                <div role="group" aria-label="Round" className="flex overflow-hidden rounded-md border border-edge-mid">
                    {rounds.map((r) => {
                        const on = r.round === round?.round;
                        return (
                            <button
                                key={r.round}
                                type="button"
                                aria-pressed={on}
                                onClick={() => onPick(r.round)}
                                className={cn(
                                    "inline-flex cursor-pointer items-center gap-[7px] px-[11px] py-1.5 text-xs",
                                    on ? "bg-surface-selected text-foreground" : "text-ink-mid"
                                )}
                            >
                                <Dot cls={ROUND_DOT[r.state] ?? "bg-warning"} size="size-1.5" />
                                {roundLabel(r)}
                            </button>
                        );
                    })}
                </div>
            ) : (
                round != null && (
                    <span className="inline-flex items-center gap-[7px] text-xs">
                        <Dot cls={ROUND_DOT[round.state] ?? "bg-warning"} size="size-1.5" />
                        {roundLabel(round)}
                    </span>
                )
            )}
            {round != null && <RoundTally text={roundTally(round)} />}
            <span className="ml-auto text-[11.5px] text-ink-mid">
                ↑ ↓ scenario · ← → screenshot · z zoom · s steps · esc close
            </span>
            <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="flex size-8 cursor-pointer items-center justify-center rounded-md border border-edge-mid text-secondary"
            >
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    aria-hidden="true"
                >
                    <path d="M6 6l12 12M18 6L6 18" />
                </svg>
            </button>
        </div>
    );
}

// the tally's counts roll when a round switch changes them; split on its numbers so the wording stays the model's
function RoundTally({ text }: { text: string }) {
    return (
        <span className="text-xs text-ink-mid">
            {text.split(/(\d+)/).map((part, i) => (i % 2 === 1 ? <TickNumber key={i} value={Number(part)} /> : part))}
        </span>
    );
}

function ScenarioTabs({ round, current, onPick }: { round: ShotRound; current: number; onPick: (i: number) => void }) {
    return (
        <div
            role="tablist"
            aria-label="Scenarios"
            className="flex flex-none gap-1.5 overflow-x-auto border-b border-edge-mid px-3 py-2"
        >
            {round.scenarios.map((sc, i) => {
                const on = i === current;
                const tally = scenarioTally(sc).short + (sc.files.length > 1 ? ` · ${sc.files.length} shots` : "");
                return (
                    <button
                        key={`${i}:${sc.name}`}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        onClick={() => onPick(i)}
                        className={cn(
                            "inline-flex flex-none cursor-pointer items-center gap-2 rounded-md border px-[11px] py-[7px]",
                            on ? "border-edge-strong bg-surface-selected" : "border-transparent"
                        )}
                    >
                        <Dot cls={VERDICT_DOT[sc.verdict]} />
                        <span className="font-mono text-xs text-foreground">
                            {sc.verdict === "none" && sc.files[0] ? baseName(sc.files[0]) : sc.name}
                        </span>
                        {tally && (
                            <span
                                className={cn(
                                    "text-[11.5px]",
                                    sc.verdict === "fail" ? "text-error-soft" : "text-ink-mid"
                                )}
                            >
                                {tally}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}

function ShotToolbar({ meta, buttons }: { meta?: ReactNode; buttons: ReactNode }) {
    return (
        <div className="flex flex-none items-center gap-2.5 px-3 py-2">
            {meta}
            <div className="ml-auto flex gap-1.5">{buttons}</div>
        </div>
    );
}

// layoutScroll: the size toggle's morph measures the image inside this scroll box
function Stage({ zoom, children }: { zoom: boolean; children: ReactNode }) {
    return (
        <motion.div
            layoutScroll
            data-final-shots-stage=""
            className={cn(
                "mx-3 mb-3 flex min-h-0 flex-1 overflow-auto rounded-md border border-edge-mid bg-background",
                zoom ? "items-start justify-start" : "items-center justify-center"
            )}
        >
            {children}
        </motion.div>
    );
}

// one fetch feeds both the toolbar's natural size and the stage; a new path slides in from the side it was
// stepped toward, and the size toggle morphs the image between Fit and Actual size
function Shot({
    path,
    file,
    pos,
    dir,
    zoom,
    onToggleZoom,
    buttons,
}: {
    path: string;
    file: string;
    pos: string;
    dir: number;
    zoom: boolean;
    onToggleZoom: () => void;
    buttons: ReactNode;
}) {
    const img = useLocalImage(path);
    const meta = (
        <>
            <span className="font-mono text-xs text-foreground">{baseName(file)}</span>
            <span className="text-xs text-ink-mid">
                {pos}
                {img.width != null && ` · ${img.width} × ${img.height}`}
            </span>
        </>
    );
    let body: ReactNode = null;
    if (img.status === "missing" || img.status === "error") {
        body = (
            <div className="flex flex-col items-center justify-center gap-2" data-final-shots-missing="">
                <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    className="text-muted"
                    aria-hidden="true"
                >
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <path d="M3 3l18 18" />
                </svg>
                <span className="text-xs text-secondary">
                    {img.status === "missing"
                        ? "No longer on disk"
                        : `Cannot load${img.httpStatus != null ? ` · HTTP ${img.httpStatus}` : ""}`}
                </span>
                <span className="font-mono text-[10.5px] text-muted">{path}</span>
            </div>
        );
    } else if (img.url != null) {
        body = (
            <motion.img
                layout
                layoutDependency={zoom}
                transition={morphTransition}
                src={img.url}
                alt={baseName(file)}
                onClick={onToggleZoom}
                className={cn(
                    "block",
                    zoom ? "flex-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain"
                )}
            />
        );
    }
    return (
        <>
            <ShotToolbar meta={meta} buttons={buttons} />
            <Stage zoom={zoom}>
                <StepSwap
                    stepKey={path}
                    dir={dir}
                    className={cn("flex size-full", zoom ? "items-start justify-start" : "items-center justify-center")}
                >
                    {body}
                </StepSwap>
            </Stage>
        </>
    );
}

function Filmstrip({
    round,
    scenario,
    current,
    onPick,
}: {
    round: ShotRound;
    scenario: ShotScenario;
    current: number;
    onPick: (i: number) => void;
}) {
    const file = scenario.files[current];
    return (
        <div className="flex flex-none items-center gap-2 border-t border-edge-mid bg-modalbg px-3 py-2">
            {scenario.files.map((f, i) => (
                <FilmThumb
                    key={`${i}:${f}`}
                    path={shotPath(round, f)}
                    file={f}
                    on={i === current}
                    onPick={() => onPick(i)}
                />
            ))}
            {file != null && (
                // right-aligned ellipsis keeps the file name end of a long path in view
                <span className="ml-auto min-w-0 max-w-[50%] overflow-hidden text-ellipsis whitespace-nowrap text-left font-mono text-[11px] text-muted [direction:rtl]">
                    {shotPath(round, file)}
                </span>
            )}
        </div>
    );
}

function FilmThumb({ path, file, on, onPick }: { path: string; file: string; on: boolean; onPick: () => void }) {
    const img = useLocalImage(path);
    return (
        <button
            type="button"
            aria-label={baseName(file)}
            aria-pressed={on}
            onClick={onPick}
            className={cn(
                "h-[55px] w-[92px] flex-none cursor-pointer overflow-hidden rounded-[5px] bg-background p-0",
                on ? "border-2 border-accent" : "border border-edge-mid"
            )}
        >
            {img.url != null && <img src={img.url} alt="" className="block size-full object-cover object-left-top" />}
        </button>
    );
}

function StepsDrawer({ open, scenario }: { open: boolean; scenario: ShotScenario }) {
    // width is not a transform, so MotionConfig would still tween it under reduced motion
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    const cls = "flex flex-none flex-col overflow-hidden border-l border-edge-mid bg-modalbg";
    if (reduce) {
        return open ? (
            <aside aria-label="Steps" className={cls} style={{ width: DRAWER_PX }}>
                <StepsList scenario={scenario} />
            </aside>
        ) : null;
    }
    return (
        <AnimatePresence initial={false}>
            {open && (
                <motion.aside
                    key="steps"
                    aria-label="Steps"
                    variants={drawerReveal}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className={cls}
                >
                    <StepsList scenario={scenario} />
                </motion.aside>
            )}
        </AnimatePresence>
    );
}

// the drawer's content at its full width, so the text never rewraps while the drawer slides
function StepsList({ scenario }: { scenario: ShotScenario }) {
    return (
        <div className="flex min-h-0 flex-1 flex-col" style={{ width: DRAWER_PX }}>
            <div className="flex items-baseline gap-2 px-4 pb-1.5 pt-3">
                <span className="text-[13px] font-semibold">{scenario.name}</span>
                <span className="text-xs text-ink-mid">{scenarioTally(scenario).long}</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 pb-3.5">
                {scenario.steps.map((st, i) => {
                    const badge = STEP_BADGE[st.state] ?? STEP_BADGE.skip;
                    const failed = st.state === "fail";
                    return (
                        <div key={i} className="flex gap-2.5 border-b border-edge-mid py-[9px]">
                            <span
                                className={cn(
                                    "h-fit w-10 flex-none rounded border py-0.5 text-center font-mono text-[10.5px] tracking-[.04em]",
                                    badge.cls
                                )}
                            >
                                {badge.label}
                            </span>
                            <div className="flex min-w-0 flex-col gap-1">
                                <span
                                    className={cn(
                                        "text-[13px] leading-normal",
                                        failed ? "font-semibold text-foreground" : "text-secondary"
                                    )}
                                >
                                    {st.step}
                                </span>
                                {st.detail && (
                                    <span className="break-words font-mono text-[11.5px] leading-normal text-ink-mid">
                                        {st.detail}
                                    </span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
