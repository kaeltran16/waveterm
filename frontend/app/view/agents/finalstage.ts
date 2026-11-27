// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The final stage as every site draws it: the Agent tree's row, the stage pane, the rails and the DAG's last
// node all read this one view. Derived from the dag's FinalStage and the run's final-step events, which alone
// keep a finished step's duration and result. No React, no store.

import { emptyRoundText, stageHasShots } from "@/app/view/jarvis/finalshotsmodel";
import type { LocalImageStatus } from "@/app/view/jarvis/localimage";
import type { AgentVM } from "./agentsviewmodel";
import { shortModel } from "./modelname";
import { fmtClock, fmtDuration, memoryFigures } from "./runcompletion";
import { detailOf } from "./runtimeline";
import { isTestCommand, parseTestOutput, type TestSummary } from "./testoutput";

// review: a fast-track stage's end review, beside the commands
export type FinalStepKey = "tree" | "check" | "verify" | "final" | "review" | "verifier";
// notrun: the stage ended before it. stopped: a human ended the stage while it ran.
export type FinalStepState = "waiting" | "running" | "passed" | "failed" | "unverified" | "stopped" | "notrun";
export type FinalTone = "wait" | "run" | "pass" | "fail" | "warn";

export interface FinalStep {
    key: FinalStepKey;
    label: string;
    state: FinalStepState;
    tone: FinalTone;
    // a finished step's duration, or a running step's elapsed
    ms?: number;
    text: string;
    // the plan's own command; for tree, review and verifier, what the step does
    command: string;
    // where a command step that ended kept its output; ts is its end, so a rerun's output is not read from cache
    kept?: { path: string; ts: number };
    // a running command waiting at the memory gate: "waiting for memory · 2.1 GB free, 3.5 GB needed"
    memory?: string;
}

export interface FinalRoundLine {
    round: number;
    tone: FinalTone;
    text: string;
    // the round's outcome alone: "failed at Final"
    outcome: string;
    // the round's failure detail, "" when none
    detail: string;
    hasShots: boolean;
}

export interface FinalStageView {
    // whether the tree has a row
    visible: boolean;
    round: number;
    // final.state, "" when not started
    state: string;
    tone: FinalTone;
    steps: FinalStep[];
    // the command step running; the verifier when only it runs
    running?: FinalStepKey;
    // the verifier works beside a running command
    alongside: boolean;
    // 1-based position of the running step, 0 when none
    stepIndex: number;
    // the running step's elapsed, or a finished stage's total
    elapsedMs?: number;
    // the round's time: since its start while it runs, the total once it has ended
    stageMs?: number;
    // ids of the tasks not done yet, in plan order
    waitsOn: string[];
    // final.output while a command runs, else ""
    output: string;
    detail: string;
    unverified: string[];
    // a human ended the stage
    endedByYou: boolean;
    // earlier rounds, oldest first
    past: FinalRoundLine[];
    subline: string;
    nodeMeta: string;
    headline: string;
    // "next Final, then the verifier"; "" when nothing follows
    next: string;
}

const FINAL_STEP_EVENT = "final-step";
const FINAL_ENDED_EVENT = "final-ended";
const MEMORY_HELD_EVENT = "memory-held";
const MEMORY_ADMITTED_EVENT = "memory-admitted";
// the memory gate's role for each command step; the stage runs no Setup of its own (finalTree reuses the landing tree)
const MEMORY_ROLES: Partial<Record<FinalStepKey, string>> = { check: "Check", verify: "Verify", final: "Final" };
// the engine's finalEndedByHuman, trimmed: what opens the reason of a stage a human ended
const ENDED_BY_HUMAN = "ended by the human:";
const RUNNING_STATES = new Set(["checking", "final", "verifying"]);
const DID_NOT_RUN = "did not run";
const TASK_FINISHED = new Set(["done", "skipped"]);

const LABELS: Record<FinalStepKey, string> = {
    tree: "Tree",
    check: "Check",
    verify: "Verify",
    final: "Final",
    review: "End review",
    verifier: "Verifier",
};
const WHAT_IT_DOES: Partial<Record<FinalStepKey, string>> = {
    tree: "prepares the tree the stage runs in",
    review: "reviews the whole run's diff",
    verifier: "judges the merged result",
};
// FinalEndReview.state as a step: lost twice reads as failed
const END_REVIEW_STEP_STATES: Record<string, FinalStepState> = {
    reviewing: "running",
    passed: "passed",
    failed: "failed",
    lost: "failed",
    stopped: "stopped",
};
// the engine's endReviewDetail, which opens a failed end review's block in the stage's Detail
const END_REVIEW_DETAIL = "[End review] ";
// the engine's endReviewUnverified and endReviewDidNotFinish, which open the end review's unverified reasons
const END_REVIEW_REASONS = ["end review: ", "the end review did not finish: "];
const STEP_TONES: Record<FinalStepState, FinalTone> = {
    waiting: "wait",
    notrun: "wait",
    running: "run",
    passed: "pass",
    failed: "fail",
    unverified: "warn",
    stopped: "warn",
};
export const STEP_WORDS: Record<FinalStepState, string> = {
    waiting: "waiting",
    notrun: "not run",
    running: "running",
    passed: "passed",
    failed: "failed",
    unverified: "unverified",
    stopped: "stopped",
};
const STAGE_TONES: Record<string, FinalTone> = {
    checking: "run",
    final: "run",
    verifying: "run",
    passed: "pass",
    failed: "fail",
    unverified: "warn",
};

// the steps whose output the engine keeps once they end (keepFinalStepOutput)
const KEPT_STEPS = new Set<FinalStepKey>(["check", "verify", "final"]);

/** Pure: where the engine keeps a round's finished step output, beside its ARC_FINAL_OUT (finalStepsDir in
 *  pkg/orchestrate/final.go). */
export function finalStepOutputPath(outDir: string, key: FinalStepKey): string {
    return `${outDir}-steps/${key}.txt`;
}

type StepEvent = { ts: number; ms: number; ok: boolean };
type StepEventDetail = { round?: number; step?: string; ms?: number; ok?: boolean };
type Commands = Pick<TaskGroup, "check" | "verify" | "finalcmd">;

type MemoryEventDetail = { taskid?: string; role?: string; free?: number; need?: number };

// the stage's commands held at the memory gate, by role: a task-less memory-held with no later memory-admitted,
// after the run's latest final-ended (the previous round's end), so a hold an earlier round left is not shown
function memoryHolds(events: RunEvent[]): Map<string, string> {
    let roundStart = 0;
    for (const e of events) {
        if (e.kind === FINAL_ENDED_EVENT && e.ts > roundStart) {
            roundStart = e.ts;
        }
    }
    const held = new Map<string, { ts: number; text: string }>();
    const admitted = new Map<string, number>();
    for (const e of events) {
        if (e.ts <= roundStart || (e.kind !== MEMORY_HELD_EVENT && e.kind !== MEMORY_ADMITTED_EVENT)) {
            continue;
        }
        const d = detailOf<MemoryEventDetail>(e);
        if (!d?.role || d.taskid) {
            continue;
        }
        if (e.kind === MEMORY_ADMITTED_EVENT) {
            admitted.set(d.role, Math.max(admitted.get(d.role) ?? 0, e.ts));
        } else if ((held.get(d.role)?.ts ?? 0) < e.ts) {
            held.set(d.role, { ts: e.ts, text: `waiting for memory · ${memoryFigures(d.free ?? 0, d.need ?? 0)}` });
        }
    }
    const holds = new Map<string, string>();
    for (const [role, h] of held) {
        if ((admitted.get(role) ?? 0) < h.ts) {
            holds.set(role, h.text);
        }
    }
    return holds;
}

function stepKeys(group: Commands, stage: FinalStage | undefined): FinalStepKey[] {
    const commands = (["check", "verify", "final"] as const).filter((k) => commandOf(group, k) !== "");
    const tree: FinalStepKey[] = commands.length > 0 ? ["tree", ...commands] : [];
    const review: FinalStepKey[] = stage?.endreview ? ["review"] : [];
    return [...tree, ...review, "verifier"];
}

function commandOf(group: Commands, key: FinalStepKey): string {
    return finalStepCommand({ ...group, final: { state: "", round: 0, step: key } });
}

// the newest event of each of a round's steps: a restart reruns a step
function roundEvents(events: RunEvent[], round: number): Map<string, StepEvent> {
    const byStep = new Map<string, StepEvent>();
    for (const e of events) {
        if (e.kind !== FINAL_STEP_EVENT) {
            continue;
        }
        const d = detailOf<StepEventDetail>(e);
        if (d?.round !== round || !d.step || (byStep.get(d.step)?.ts ?? -Infinity) >= e.ts) {
            continue;
        }
        byStep.set(d.step, { ts: e.ts, ms: d.ms ?? 0, ok: d.ok === true });
    }
    return byStep;
}

function endedByHuman(stage: FinalStage): boolean {
    return [stage.detail ?? "", ...(stage.unverified ?? [])].some((s) => s.startsWith(ENDED_BY_HUMAN));
}

// the command step an ended stage stopped at, or -1 when its commands all ran and the verifier ended it
function endedAt(stage: FinalStage, group: Commands, commands: FinalStepKey[], evs: Map<string, StepEvent>): number {
    // with a Final command the verifier starts only once the commands are over
    if (group.finalcmd && stage.verifierrunid) {
        return -1;
    }
    if (endedByHuman(stage)) {
        return commands.findIndex((k) => evs.get(k)?.ok !== true);
    }
    if (stage.state === "unverified") {
        return evs.get("tree")?.ok === false ? commands.indexOf("tree") : -1;
    }
    // the engine opens a command's failure with its name; any other detail is the verifier's. The detail
    // decides first: a Check that could not verify is not ok either, yet the stage goes on past it
    const detail = stage.detail ?? "";
    if (detail !== "") {
        const named = /^(Check|Verify|Final) `/.exec(detail)?.[1];
        return commands.findIndex((k) => LABELS[k] === named);
    }
    const ran = commands.filter((k) => evs.has(k));
    const last = ran[ran.length - 1];
    return last != null && evs.get(last).ok === false ? commands.indexOf(last) : -1;
}

function stepStates(
    stage: FinalStage | undefined,
    group: Commands,
    keys: FinalStepKey[],
    evs: Map<string, StepEvent>
): FinalStepState[] {
    const commands = keys.slice(0, -1);
    // a step the stage went on past: not ok means it could not verify, since a failure ends the stage
    const settled = (k: FinalStepKey): FinalStepState => (evs.get(k)?.ok === false ? "unverified" : "passed");
    const state = stage?.state ?? "";
    if (state === "") {
        return keys.map(() => "waiting");
    }
    if (state === "passed") {
        return [...commands.map(settled), "passed"];
    }
    if (RUNNING_STATES.has(state)) {
        const reviewing = state === "verifying";
        const at = commands.indexOf(stage.step as FinalStepKey);
        const verifier = reviewing || (state === "checking" && !!stage.verifierrunid) ? "running" : "waiting";
        return [
            ...commands.map((k, i): FinalStepState => {
                if (reviewing || i < at || (at < 0 && evs.has(k))) {
                    return settled(k);
                }
                return i === at ? "running" : "waiting";
            }),
            verifier,
        ];
    }
    const ending: FinalStepState = endedByHuman(stage) ? "stopped" : state === "failed" ? "failed" : "unverified";
    const at = endedAt(stage, group, commands, evs);
    if (at < 0) {
        return [...commands.map(settled), ending];
    }
    return keys.map((k, i) => (i < at ? settled(k) : i === at ? ending : "notrun"));
}

// a stage Detail cut where the engine's applyEndReview appended a failed end review's block (alone, or after the
// commands' and verifier's detail and a blank line): what came before it, and the block itself
function splitEndReview(detail: string): { before: string; review: string } {
    const at = detail.startsWith(END_REVIEW_DETAIL) ? 0 : detail.indexOf(`\n\n${END_REVIEW_DETAIL}`);
    if (at < 0) {
        return { before: detail, review: "" };
    }
    return { before: detail.slice(0, at), review: detail.slice(at).replace(/^\n\n/, "") };
}

// the stage as its commands and verifier left it: the end review's Detail block and reasons taken out, and a stage
// that ended, or waits only on the end review, read by what is left
function withoutEndReview(stage: FinalStage): FinalStage {
    const rest: FinalStage = {
        ...stage,
        detail: splitEndReview(stage.detail ?? "").before,
        unverified: (stage.unverified ?? []).filter((r) => !END_REVIEW_REASONS.some((p) => r.startsWith(p))),
    };
    const settled = !RUNNING_STATES.has(stage.state) || stage.endreview?.waiting === true;
    if (stage.state !== "" && settled) {
        rest.state = rest.detail !== "" ? "failed" : rest.unverified.length > 0 ? "unverified" : "passed";
    }
    return rest;
}

// every step's state: the end review's from its own record, the others' as the stage reads without it
function allStepStates(
    stage: FinalStage | undefined,
    group: Commands,
    keys: FinalStepKey[],
    evs: Map<string, StepEvent>
): FinalStepState[] {
    const er = stage?.endreview;
    if (er == null) {
        return stepStates(stage, group, keys, evs);
    }
    const states = stepStates(
        withoutEndReview(stage),
        group,
        keys.filter((k) => k !== "review"),
        evs
    );
    const review =
        er.state === "passed" && er.unverified ? "unverified" : (END_REVIEW_STEP_STATES[er.state] ?? "waiting");
    states.splice(keys.indexOf("review"), 0, review);
    return states;
}

// what works beside a running step: "verifier alongside", "verifier and end review alongside"
function besideText(verifier: boolean, review: boolean): string | undefined {
    const who = [verifier ? "verifier" : "", review ? "end review" : ""].filter(Boolean);
    return who.length > 0 ? `${who.join(" and ")} alongside` : undefined;
}

function withTime(word: string, ms: number | undefined, sep = " "): string {
    return ms == null ? word : `${word}${sep}${fmtDuration(ms)}`;
}

function span(from: number | undefined, to: number | undefined): number | undefined {
    return from && to && to >= from ? to - from : undefined;
}

function buildSteps(
    stage: FinalStage | undefined,
    group: Commands,
    evs: Map<string, StepEvent>,
    now: number,
    verifierRun: Pick<Run, "completedts"> | undefined,
    holds: Map<string, string> = new Map()
): FinalStep[] {
    const keys = stepKeys(group, stage);
    const states = allStepStates(stage, group, keys, evs);
    // startedts is the verifier session's start only once there is one
    const verifierStart = stage?.verifierrunid ? stage.startedts : undefined;
    return keys.map((key, i) => {
        const state = states[i];
        let ms: number | undefined;
        if (key === "verifier") {
            ms =
                state === "running"
                    ? span(verifierStart, now)
                    : state !== "waiting" && state !== "notrun"
                      ? span(verifierStart, verifierRun?.completedts)
                      : undefined;
        } else if (key === "review") {
            ms = state === "running" ? span(stage.endreview.startedts, now) : evs.get(key)?.ms;
        } else if (state === "running") {
            ms = span(stage.stepts, now);
        } else if (state !== "waiting" && state !== "notrun") {
            ms = evs.get(key)?.ms;
        }
        const ended = evs.get(key);
        const kept =
            ended && stage?.outdir && KEPT_STEPS.has(key)
                ? { path: finalStepOutputPath(stage.outdir, key), ts: ended.ts }
                : undefined;
        return {
            key,
            label: LABELS[key],
            state,
            tone: STEP_TONES[state],
            ms,
            text: withTime(STEP_WORDS[state], ms),
            command: WHAT_IT_DOES[key] ?? commandOf(group, key),
            kept,
            memory: state === "running" && MEMORY_ROLES[key] ? holds.get(MEMORY_ROLES[key]) : undefined,
        };
    });
}

// how an ended stage reads in a line: "failed at Final", "unverified", "passed"
function outcomeText(stage: FinalStage, steps: FinalStep[]): string {
    if (stage.state !== "failed") {
        return stage.state;
    }
    const stopped = steps.find((s) => s.state === "stopped");
    if (stopped) {
        return `failed, stopped at ${stopped.label}`;
    }
    const failed = steps.find((s) => s.state === "failed");
    return failed ? `failed at ${failed.label}` : "failed";
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function joinDot(parts: (string | undefined)[]): string {
    return parts.filter(Boolean).join(" · ");
}

function nextText(steps: FinalStep[]): string {
    const names = steps
        .filter((s) => s.state === "waiting")
        .map((s) => (s.key === "verifier" ? "the verifier" : s.label));
    if (!steps.some((s) => s.state === "running") || names.length === 0) {
        return "";
    }
    return names.length === 1
        ? `next ${names[0]}`
        : `next ${names.slice(0, -1).join(", ")}, then ${names[names.length - 1]}`;
}

// a round's total, once every step it runs in turn has a time, and its start
function roundTimes(
    stage: FinalStage | undefined,
    steps: FinalStep[],
    evs: Map<string, StepEvent>
): { total?: number; start?: number } {
    // the end review works beside the other steps, so it adds nothing to the round's time
    const serial = steps.filter((s) => s.key !== "review");
    const total = serial.every((s) => s.ms != null) ? serial.reduce((sum, s) => sum + s.ms, 0) : undefined;
    const starts = [...evs.values()].map((e) => e.ts - e.ms);
    // with commands and no event left, startedts may already be the verifier's start, not the round's
    const startedTs = stage?.verifierrunid && steps.length > 1 ? undefined : stage?.startedts;
    return { total, start: starts.length > 0 ? Math.min(...starts) : startedTs };
}

const HIDDEN: FinalStageView = {
    visible: false,
    round: 1,
    state: "",
    tone: "wait",
    steps: [],
    alongside: false,
    stepIndex: 0,
    waitsOn: [],
    output: "",
    detail: "",
    unverified: [],
    endedByYou: false,
    past: [],
    subline: "",
    nodeMeta: "",
    headline: "",
    next: "",
};

/** Pure: the final stage of a dag, for every site that draws it. verifierRun is the Run of the current
 *  round's verifier session, undefined while there is none or it has not loaded. */
export function finalStageView(
    group: TaskGroup | undefined,
    events: RunEvent[],
    now: number,
    verifierRun?: Pick<Run, "completedts">
): FinalStageView {
    const tasks = group?.tasks ?? [];
    if (group == null || tasks.length === 0) {
        return HIDDEN;
    }
    const stage = group.final;
    const round = stage?.round || 1;
    const state = stage?.state ?? "";
    const evs = roundEvents(events, round);
    const steps = buildSteps(stage, group, evs, now, verifierRun, memoryHolds(events));
    const isRunning = RUNNING_STATES.has(state);
    const ended = state !== "" && !isRunning;

    const command = steps.find((s) => s.state === "running" && s.key !== "verifier" && s.key !== "review");
    const verifier = steps[steps.length - 1];
    const verifierRunning = verifier.state === "running";
    const review = steps.find((s) => s.key === "review" && s.state === "running");
    const running = command ?? (verifierRunning ? verifier : review);
    const alongside = command != null && verifierRunning;

    const { total, start: roundStart } = roundTimes(stage, steps, evs);

    const waitsOn = tasks.filter((t) => !TASK_FINISHED.has(t.state)).map((t) => t.id);
    const roundText = `round ${round}`;
    const outcome = ended ? outcomeText(stage, steps) : "";
    const reasons = stage?.unverified ?? [];

    let subline: string;
    let nodeMeta: string;
    let headline: string;
    if (command) {
        const time = command.ms == null ? undefined : fmtDuration(command.ms);
        const position = `step ${steps.indexOf(command) + 1} of ${steps.length}`;
        subline = joinDot([command.label, time, besideText(verifierRunning, review != null) ?? position]);
        nodeMeta = joinDot([roundText, command.label, alongside ? "verifier" : review ? "end review" : time]);
        headline = joinDot([roundText, finalStageActivity(stage), time]);
    } else if (running) {
        const time = running.ms == null ? undefined : fmtDuration(running.ms);
        const who = running === review ? "end review" : "verifier";
        subline = joinDot([
            `${who} reviewing`,
            time,
            running === review ? undefined : besideText(false, review != null),
        ]);
        nodeMeta = joinDot([roundText, who, time]);
        headline = joinDot([roundText, `${who} reviewing`, time]);
    } else if (isRunning) {
        // between two commands the stage names no step
        subline = "starting";
        nodeMeta = headline = joinDot([roundText, "starting"]);
    } else if (state === "failed") {
        subline = joinDot([outcome, roundText]);
        nodeMeta = headline = joinDot([roundText, outcome]);
    } else if (state === "unverified") {
        subline = joinDot(["unverified", reasons.length > 0 ? plural(reasons.length, "reason") : undefined]);
        nodeMeta = headline = joinDot([roundText, "unverified"]);
    } else if (ended) {
        const time = total == null ? undefined : fmtDuration(total);
        subline = joinDot([state, time]);
        nodeMeta = headline = joinDot([roundText, state, time]);
    } else if (stage == null && group.status === "cancelled") {
        subline = DID_NOT_RUN;
        nodeMeta = headline = joinDot([DID_NOT_RUN, "run cancelled"]);
    } else if (round > 1) {
        subline = waitsOn.length > 0 ? `${roundText} after ${plural(waitsOn.length, "fix task")}` : roundText;
        nodeMeta = headline = waitsOn.length > 0 ? `${roundText} waits on ${waitsOn.join(", ")}` : roundText;
    } else if (waitsOn.length > 0) {
        subline = `after ${plural(waitsOn.length, "more task")}`;
        nodeMeta = headline = "waits on every task";
    } else {
        subline = "starting";
        nodeMeta = headline = joinDot([roundText, "starting"]);
    }

    const past = [...(group.pastfinals ?? [])]
        .sort((a, b) => a.round - b.round)
        .map((p): FinalRoundLine => {
            const pastSteps = buildSteps(p, group, roundEvents(events, p.round), now, undefined);
            const pastOutcome = outcomeText(p, pastSteps);
            return {
                round: p.round,
                tone: STAGE_TONES[p.state] ?? "wait",
                text: joinDot([`round ${p.round}`, pastOutcome]),
                outcome: pastOutcome,
                detail: p.detail ?? "",
                hasShots: stageHasShots(p),
            };
        });

    return {
        visible: group.status === "finalizing" || state !== "" || round > 1,
        round,
        state,
        tone: STAGE_TONES[state] ?? "wait",
        steps,
        running: running?.key,
        alongside,
        stepIndex: running ? steps.indexOf(running) + 1 : 0,
        elapsedMs: running ? running.ms : ended ? total : undefined,
        stageMs: isRunning ? span(roundStart, now) : ended ? total : undefined,
        waitsOn,
        output: command ? (stage.output ?? "") : "",
        detail: stage?.detail ?? "",
        unverified: reasons,
        endedByYou: ended && endedByHuman(stage),
        past,
        subline,
        nodeMeta,
        headline,
        next: nextText(steps),
    };
}

// final.step: the plan command the final stage is running
const FINAL_STEP_LABELS: Record<string, string> = {
    tree: "preparing the tree",
    check: "running Check",
    verify: "running Verify",
    final: "running Final",
};

/** Pure: what a running final stage is doing, or undefined when it is not running. With no Final command the
 *  verifier works alongside Check and Verify, and a fast-track stage's end review beside every step, so they show. */
export function finalStageActivity(final: FinalStage | undefined): string | undefined {
    const reviewing = final?.endreview?.state === "reviewing";
    if (final?.state === "verifying") {
        return final.endreview?.waiting
            ? "end review reviewing"
            : joinDot(["verifier reviewing", besideText(false, reviewing)]);
    }
    if (final?.state !== "checking" && final?.state !== "final") {
        return undefined;
    }
    const step = FINAL_STEP_LABELS[final.step ?? ""] ?? "starting";
    return joinDot([step, besideText(final.state === "checking" && !!final.verifierrunid, reviewing)]);
}

/** Pure: the plan's own command behind the final stage's running step, so the label stays generic and the
 *  detail is whatever this project runs. */
export function finalStepCommand(group: Pick<TaskGroup, "check" | "verify" | "finalcmd" | "final">): string {
    switch (group.final?.step) {
        case "check":
            return group.check ?? "";
        case "verify":
            return group.verify ?? "";
        case "final":
            return group.finalcmd ?? "";
        default:
            return "";
    }
}

const FINAL_STAGE_PREFIX = "final:";

// finalStageId is what the stage's row is focused by while no verifier session stands for it.
export function finalStageId(runId: string): string {
    return `${FINAL_STAGE_PREFIX}${runId}`;
}

export function isFinalStageId(id: string): boolean {
    return id.startsWith(FINAL_STAGE_PREFIX);
}

export function finalStageRunId(id: string): string | undefined {
    return isFinalStageId(id) ? id.slice(FINAL_STAGE_PREFIX.length) : undefined;
}

/** Pure: the id a click on the row focuses: the current round's verifier agent when it is in the roster, else
 *  the stage's own. A tab an earlier round's verifier left is not the row. */
export function finalRowFocusId(
    run: { runId: string; dag?: TaskGroup },
    agents: Pick<AgentVM, "id" | "runId">[]
): string {
    const verifierRunId = run.dag?.final?.verifierrunid;
    const agent = verifierRunId ? agents.find((a) => a.runId === verifierRunId) : undefined;
    return agent?.id ?? finalStageId(run.runId);
}

/** Pure: whether a step's row opens to a body: a command running once it printed, or one that ended and kept its
 *  output. */
export function finalStepOpens(view: FinalStageView, step: FinalStep): boolean {
    return step.kept != null || (step.state === "running" && step.key === view.running && view.output !== "");
}

const RERUN_HINT = "Rerun it if the failure was outside the code.";

/** Pure: what a failed stage's pane tells the human, by its run's lead: asking about it, judging it, or gone. */
export function finalFailedNote(lead: { asking: boolean } | undefined): string {
    if (lead == null) return `This failure is yours. ${RERUN_HINT}`;
    if (lead.asking) return `The lead is asking you about this failure. ${RERUN_HINT}`;
    return "The lead has this failure and decides what happens next.";
}

export type FinalTabSection = "why" | "verified" | "verifier" | "shots" | "changes";

// one screenshot file; step is the 0-based step the scenario tagged it with, which names it
export interface FinalTabFrame {
    file: string;
    step?: number;
    label: string;
    failed: boolean;
}

// ran and passed count the steps that ran, skips left out; a plain listing has none
export interface FinalTabScenario {
    name: string;
    failed: number;
    ran: number;
    passed: number;
    frames: FinalTabFrame[];
}

export interface FinalTabView {
    // every round, oldest first, and the one shown
    rounds: number[];
    round: number;
    // the shown round is the dag's current one
    current: boolean;
    stage: FinalStage;
    state: string;
    tone: FinalTone;
    meta: string;
    why: { detail: string; note: string } | null;
    verifier: { ran: boolean; text: string; meta: string; session: boolean };
    shots: FinalTabScenario[];
    // why the round has no screenshots, "" when it has some
    emptyShots: string;
    order: FinalTabSection[];
}

export type FinalTabInput = {
    // the round picked on the tab, null for the current one
    round: number | null;
    // the ended verifier's run id whose row opened the tab
    session?: string;
    // the shown round's verifier session, once loaded
    verifierRun?: Pick<Run, "completedts" | "model">;
    // the run's lead, as finalFailedNote reads it
    lead?: { asking: boolean };
};

export const NO_VERDICT_TEXT = "No verdict text was recorded for this round.";
const VERIFIER_NOT_RUN = "Did not run: the stage ended before it.";
const VERIFIER_TEXT: Partial<Record<FinalStepState, string>> = {
    waiting: "Waits for the steps before it.",
    running: "Reviewing the merged result.",
};
const SHORT_COMMIT = 7;
const ORDER_FAILED: FinalTabSection[] = ["why", "shots", "verifier", "verified", "changes"];
const ORDER_SESSION: FinalTabSection[] = ["verifier", "verified", "shots", "changes"];
const ORDER: FinalTabSection[] = ["verified", "verifier", "shots", "changes"];

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// a step that already opens with its own number ("3.", "2b.", "B5."), which the label keeps
const NUMBERED_STEP = /^[A-Za-z]?\d+[a-z]?\.\s/;

function fileStem(file: string): string {
    const name = file.slice(file.lastIndexOf("/") + 1);
    return name.replace(/\.[^.]+$/, "");
}

function tabScenario(shot: FinalShot): FinalTabScenario {
    const steps = shot.steps ?? [];
    const ran = steps.filter((st) => st.state !== "skip");
    const failed = ran.filter((st) => st.state === "fail").length;
    const frames = (shot.files ?? []).map((file): FinalTabFrame => {
        const step = shot.filesteps?.[file];
        const st = step == null ? undefined : steps[step];
        if (st == null) {
            return { file, label: fileStem(file), failed: false };
        }
        const label = NUMBERED_STEP.test(st.step) ? st.step : `${step + 1}. ${st.step}`;
        return { file, step, label, failed: st.state === "fail" };
    });
    return { name: shot.name, failed, ran: ran.length, passed: ran.length - failed, frames };
}

// the scenarios that took a screenshot, failed ones first, each group in manifest order
function tabShots(stage: FinalStage): FinalTabScenario[] {
    const all = (stage.shots ?? []).map(tabScenario).filter((s) => s.frames.length > 0);
    return [...all.filter((s) => s.failed > 0), ...all.filter((s) => s.failed === 0)];
}

// what the verifier said: its verdict, else, for rounds recorded before it was kept, a fail's detail or the end
// review's text for a round the end review settled
function verdictText(stage: FinalStage): string {
    return (
        stage.verdicttext || (stage.state === "failed" ? stage.detail : "") || stage.endreview?.text || NO_VERDICT_TEXT
    );
}

function verifierOf(stage: FinalStage, step: FinalStep, input: FinalTabInput): FinalTabView["verifier"] {
    const session = !!input.session && stage.verifierrunid === input.session;
    if (step.state === "notrun") {
        return { ran: false, text: VERIFIER_NOT_RUN, meta: "", session };
    }
    const ended = !RUNNING_STATES.has(stage.state) && step.state !== "waiting";
    const reasons = stage.unverified?.length ?? 0;
    const meta =
        step.state === "waiting"
            ? ""
            : joinDot([
                  input.verifierRun?.model ? shortModel(input.verifierRun.model) : undefined,
                  step.ms == null ? undefined : fmtDuration(step.ms),
                  ended ? (reasons > 0 ? `${reasons} unverified` : "nothing unverified") : undefined,
              ]);
    return { ran: true, text: VERIFIER_TEXT[step.state] ?? verdictText(stage), meta, session };
}

/** Pure: the workspace pane's Final tab, one round of a dag's Final verification at a time. Null for a dag whose
 *  stage has not begun. */
export function finalTabView(
    group: TaskGroup | undefined,
    events: RunEvent[],
    now: number,
    input: FinalTabInput
): FinalTabView | null {
    const currentStage = group?.final;
    if (currentStage == null) {
        return null;
    }
    const currentRound = currentStage.round || 1;
    const stages = [...(group.pastfinals ?? []).filter((p) => p.round !== currentRound), currentStage].sort(
        (a, b) => (a.round || 1) - (b.round || 1)
    );
    const stage = stages.find((s) => (s.round || 1) === (input.round ?? currentRound)) ?? currentStage;
    const round = stage.round || 1;
    const current = stage === currentStage;
    const evs = roundEvents(events, round);
    const steps = buildSteps(stage, group, evs, now, input.verifierRun);
    const { start } = roundTimes(stage, steps, evs);
    const running = RUNNING_STATES.has(stage.state);
    const failed = stage.state === "failed";
    // an ended round is timed by the steps it ran, so one that ended early still has a time
    const ran = steps.filter((s) => s.key !== "review" && s.state !== "notrun");
    const total = ran.every((s) => s.ms != null) ? ran.reduce((sum, s) => sum + s.ms, 0) : undefined;
    const time = running ? span(start, now) : total;

    const state = running ? "running" : stage.state === "" ? "not started" : outcomeText(stage, steps);
    const max = group.maxfinalrounds;
    const meta = joinDot([
        max ? `round ${round} of ${max}` : `round ${round}`,
        time == null ? undefined : fmtDuration(time),
        start ? fmtClock(start) : undefined,
        failed && stage.commit ? `commit ${stage.commit.slice(0, SHORT_COMMIT)}` : undefined,
    ]);
    const verifier = verifierOf(stage, steps[steps.length - 1], input);
    const shots = tabShots(stage);
    return {
        rounds: stages.map((s) => s.round || 1),
        round,
        current,
        stage,
        state: capitalize(state),
        tone: STAGE_TONES[stage.state] ?? "wait",
        meta,
        why: failed ? { detail: stage.detail ?? "", note: current ? finalFailedNote(input.lead) : "" } : null,
        verifier,
        shots,
        emptyShots: shots.length > 0 ? "" : emptyRoundText(stage),
        order: failed ? ORDER_FAILED : verifier.session ? ORDER_SESSION : ORDER,
    };
}

export type FinalKept = { status: LocalImageStatus; text: string };

// what a step's body says when its kept output gives it nothing to show
export const KEPT_NOTE: Record<LocalImageStatus, string> = {
    loading: "loading the output...",
    ok: "the step printed nothing",
    missing: "no output kept: the step ran before Arc kept it, or it was swept",
    error: "could not read the step's output",
};

export type FinalStepBody =
    | { kind: "tail"; command: string; output: string }
    | { kind: "card"; summary: TestSummary; output: string }
    | { kind: "panel"; command: string; output: string; error?: string; note?: string };

const COMMAND_KEYS = new Set<FinalStepKey>(["check", "verify", "final"]);
const EXIT_CODE = /\(exit (\d+)\):\s*$/;

function failedCommand(step: FinalStep): boolean {
    return step.state === "failed" && COMMAND_KEYS.has(step.key);
}

/** Pure: what an open step's body draws. A running command is its live tail; an ended one is a Tests card when
 *  its kept output parses as a run of its test command, else a panel of the output. The stage's failure detail,
 *  less the end review's findings, rides in the failed command's panel as its error, except while the output
 *  loads or when a card carries it. */
export function finalStepBody(view: FinalStageView, step: FinalStep, kept: FinalKept): FinalStepBody {
    if (step.state === "running" && step.key === view.running) {
        return { kind: "tail", command: step.command, output: view.output };
    }
    const output = kept.status === "ok" ? kept.text : "";
    const summary = isTestCommand(step.command) ? parseTestOutput(output) : null;
    if (summary != null) {
        return { kind: "card", summary, output };
    }
    const body: FinalStepBody = { kind: "panel", command: step.command, output };
    if (output.trim() === "") {
        body.note = KEPT_NOTE[kept.status];
    }
    if (failedCommand(step) && kept.status !== "loading") {
        body.error = splitEndReview(view.detail).before;
    }
    return body;
}

/** Pure: whether a step's row starts open: the running command once it prints, or the failed step that kept
 *  output. A click records the human's choice over this in the pane. */
export function finalStepOpensByDefault(view: FinalStageView, step: FinalStep): boolean {
    if (step.state === "running") {
        return step.key === view.running && view.output !== "";
    }
    return failedCommand(step) && step.kept != null;
}

/** Pure: the exit chip of a failed step, `exit N` from the first line of the stage's detail when that line names
 *  the step's command, else `failed`. */
export function finalStepExit(view: FinalStageView, step: FinalStep): string {
    const first = view.detail.split("\n", 1)[0];
    const code = first.startsWith(`${step.label} \``) ? EXIT_CODE.exec(first)?.[1] : undefined;
    return code == null ? "failed" : `exit ${code}`;
}

/** Pure: the failure detail drawn above the steps' box, "" for none: the whole detail when no failed command step
 *  kept output to hold it (the verifier or end review failed, a human ended the stage), else the end review's
 *  findings alone, which belong to no command. */
export function finalDetailAbove(view: FinalStageView): string {
    const held = view.steps.some((s) => failedCommand(s) && s.kept != null);
    return held ? splitEndReview(view.detail).review : view.detail;
}

/** Pure: the last `lines` lines of a command's output. */
export function outputTail(output: string, lines: number): string {
    if (lines <= 0) {
        return "";
    }
    return output.replace(/\s+$/, "").split(/\r?\n/).slice(-lines).join("\n");
}
