// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure view-model logic for the Agent surface's left tree. No React, no Wave runtime imports.
// Produces group headers, agent rows, each orchestrator run's workers nested under its lead, and a brainstorm's
// builder-check reviewer and judge nested under the brainstorming agent, and each agent-started worker nested under the
// agent that started it; subagent
// children are read from per-block atoms in the component (they're ephemeral and keyed by block ORef), so
// they stay out of this pure helper.

import { displayAgeMs, formatAgeShort, projectOf, type AgentVM } from "./agentsviewmodel";
import type { BuilderCheckRecord } from "./brainstormmodel";
import { finalRowFocusId, finalStageView } from "./finalstage";
import {
    allEndedPlanReviewers,
    BRAINSTORM_JUDGE_ROLE,
    BUILDER_CHECK_ROLE,
    endedReviewerVM,
    endedWorkerId,
    failedWithTranscript,
    holdsTask,
    isEndedWorkerId,
    mergeGateLine,
    NO_LINEAGE,
    PLAN_REVIEWER_ROLE,
    planReviewerOf,
    workerAsk,
    workerEnded,
    type Lineage,
    type RunInfo,
} from "./runlineage";

export const UNGROUPED_PROJECT = "ungrouped";

export type AgentTreeRow =
    | { kind: "group"; project: string; count: number; attn: number }
    // `depth` is how many agent-started workers deep it nests under a top-level agent; 0 or absent at the top
    | { kind: "parent"; agent: AgentVM; project: string; depth?: number }
    // a builder check's reviewer or a judge under the brainstorming agent that started it; `stageRole` is which, and
    // `state` is that agent's record of it
    | { kind: "check"; agent: AgentVM; project: string; stageRole: string; state: BuilderCheckRecord["state"] }
    // an orchestrator lead; `live` counts its workers that are not done
    | { kind: "lead"; agent: AgentVM; project: string; run: RunInfo; open: boolean; live: number }
    // a run whose workers are in the roster but whose lead is not: a plan-path run before its first lead
    | { kind: "run"; project: string; run: RunInfo; open: boolean; live: number }
    // a task's worker; a done task whose session is gone has no agent. `extras` counts the task's other tabs (its
    // reviewer, an earlier attempt), listed as `nested` rows beneath it while `extrasOpen`. `gate` is a done lane
    // tip's merge gate line (mergeGateLine) while it waits to merge
    | {
          kind: "worker";
          agent?: AgentVM;
          project: string;
          run: RunInfo;
          task: TaskNode;
          gate?: string;
          nested?: boolean;
          extras?: number;
          extrasOpen?: boolean;
      }
    // a session the engine started to judge the whole run: its plan reviewer, its final verifier. `outcome` is its
    // verdict once it has one; `lens` is a plan reviewer's, and `round` its round when the review had more than one
    | {
          kind: "stage";
          agent: AgentVM;
          project: string;
          run: RunInfo;
          stageRole: string;
          outcome?: StageOutcome;
          lens?: string;
          round?: number;
      }
    // the run's final stage, one per run: `agent` is the current round's verifier session while it is in the roster
    | { kind: "final"; project: string; run: RunInfo; agent?: AgentVM }
    // the fold of what finished: `count` done tasks (`landed` of them merged), the tasks settled without landing
    // (`skipped`, `cancelled`), and `stages` stages with a verdict, the passed final stage included, `planReviews` of
    // them plan review sessions
    | {
          kind: "done";
          project: string;
          run: RunInfo;
          count: number;
          landed: number;
          skipped: number;
          cancelled: number;
          stages: number;
          planReviews: number;
          open: boolean;
      }
    | { kind: "queued"; project: string; run: RunInfo; count: number; open: boolean };

// TreeFolds is what the human folded: runs whose workers are hidden, runs whose done or queued tasks are listed,
// and tasks (by taskFoldKey) whose other tabs are listed. A done fold is keyed to how many tasks were done when it
// opened, so the next landing closes it: left open, every landing would push the run's live workers further down.
export interface TreeFolds {
    collapsed: ReadonlySet<string>;
    doneOpen: ReadonlyMap<string, number>;
    queuedOpen: ReadonlySet<string>;
    extrasOpen: ReadonlySet<string>;
}

const NO_FOLDS: TreeFolds = { collapsed: new Set(), doneOpen: new Map(), queuedOpen: new Set(), extrasOpen: new Set() };

export function taskFoldKey(runId: string, taskId: string): string {
    return `${runId}:${taskId}`;
}

// splitTaskTabs picks the tab a task's row stands for, its worker, and leaves the rest to nest beneath it. With no
// worker tab left, a done task's row is its ended worker's transcript, so every tab nests; otherwise the first stands in.
function splitTaskTabs(task: TaskNode, agents: AgentVM[]): { primary?: AgentVM; extras: AgentVM[] } {
    const i = agents.findIndex((a) => a.runId != null && a.runId === task.runid);
    if (i >= 0) {
        return { primary: agents[i], extras: agents.filter((_, j) => j !== i) };
    }
    if (task.state === "done") {
        return { primary: undefined, extras: agents };
    }
    const [primary, ...extras] = agents;
    return { primary, extras };
}

type TopItem =
    | { kind: "parent"; agent: AgentVM; project: string }
    | { kind: "lead"; agent: AgentVM; project: string; run: RunInfo }
    | { kind: "run"; project: string; run: RunInfo };

// A worker waits on the human only when the human holds its question; one asking its lead does not. With
// no digest yet, asking is the only signal there is.
export function workerNeedsYou(run: RunInfo, taskId: string, agent: AgentVM | undefined): boolean {
    if (run.digest == null) {
        return agent?.state === "asking";
    }
    return workerAsk(run.digest, taskId)?.owner === "you";
}

const QUEUED = new Set(["pending", "ready"]);
// settled without landing: nothing more happens to it, so with no tab left it has no row
const DROPPED = new Set(["skipped", "cancelled"]);

type StageAgent = { agent: AgentVM; stageRole: string };

// accepted: the human accepted a failed plan review, so its every session reads as that, not as its own verdict
export type StageOutcome = "passed" | "failed" | "unverified" | "accepted";

const STAGE_VERDICT_TEXT: Partial<Record<StageOutcome, string>> = { accepted: "accepted by you" };

/** Pure: the words a stage row's second line gives its outcome. */
export function stageVerdictText(outcome: StageOutcome | undefined): string | undefined {
    return outcome && (STAGE_VERDICT_TEXT[outcome] ?? outcome);
}

const FINAL_OUTCOMES: Record<string, StageOutcome> = { passed: "passed", unverified: "unverified", failed: "failed" };

/** Pure: a stage session's verdict, or undefined while it is still judging. A plan reviewer reads its own verdict
 *  from its round's reviewers, a final verifier its stage's. A session from an earlier round the dag does not keep
 *  (every final round, and a plan review stored before past rounds were kept) reads as failed: a stage gets another
 *  round only after one fails. A session the engine replaced within a round is stopped with its tab, so it has no
 *  row to misread. */
export function stageOutcome(
    run: RunInfo,
    stageRole: string,
    agentRunId: string | undefined
): StageOutcome | undefined {
    const cur = stageRole === "plan-reviewer" ? run.dag?.planreview : run.dag?.final;
    if (cur == null || agentRunId == null) {
        return undefined;
    }
    if (stageRole === "plan-reviewer") {
        const review = run.dag.planreview;
        const reviewer = planReviewerOf(review, agentRunId);
        // the human accepted the last round, so an earlier round's reviewer keeps its own verdict
        if (reviewer != null && reviewer.round !== review.round) {
            return reviewer.verdict ?? "failed";
        }
        if (review.state === "accepted") {
            return "accepted";
        }
        if (reviewer != null) {
            return reviewer.verdict;
        }
    } else if (run.dag.final.verifierrunid === agentRunId) {
        return FINAL_OUTCOMES[run.dag.final.state];
    }
    return cur.round > 1 ? "failed" : undefined;
}

// stageSubline is a stage row's second line: its verdict, a plan reviewer's round when the review had more than one,
// and age. the row's title already names the role, and is too long to keep a round in view.
export function stageSubline(verdict: string | undefined, age: string | undefined, round?: number): string {
    return [verdict, round != null && `round ${round}`, age].filter(Boolean).join(" · ");
}

// stageRowAge is a stage row's age. An ended reviewer's row has none: the tree has only the dag's record of it,
// which says when it started, not when it ended, so any age would be wrong.
export function stageRowAge(agent: AgentVM, now: number): string | undefined {
    return isEndedWorkerId(agent.id) ? undefined : formatAgeShort(displayAgeMs(agent, now));
}

type JudgedStage = StageAgent & { outcome?: StageOutcome; lens?: string; round?: number };

// history order: a plan review came before any task, a final verification after every one. Plan reviewers sort by
// round, oldest first, a session the dag no longer places (an earlier round of a dag stored before past rounds were
// kept) before every round it does; within a round, and among final verifiers, a failed session comes first
const stageOrder = (a: JudgedStage, b: JudgedStage) =>
    stageGroup(a) - stageGroup(b) || (a.round ?? 0) - (b.round ?? 0) || failedRank(a) - failedRank(b);
const stageGroup = (s: JudgedStage) => (s.stageRole === PLAN_REVIEWER_ROLE ? 0 : 1);
const failedRank = (s: JudgedStage) => (s.outcome === "failed" ? 0 : 1);

function runRows(
    item: Extract<TopItem, { kind: "lead" | "run" }>,
    workers: Map<string, AgentVM[]>,
    stages: StageAgent[],
    folds: TreeFolds,
    focusId: string | undefined
): { rows: AgentTreeRow[]; members: number; attn: number } {
    const { run, project } = item;
    const tasks = run.dag?.tasks ?? [];
    // a done lane tip at the merge gate has not landed: it stays a live row until it merges
    const atGate = (t: TaskNode) => t.state === "done" && mergeGateLine(run, t.id) != null;
    // a task past its worker is still under way: verifying its merge, or failed and waiting on a judgment. Cleanup
    // reaps its worker's tab with the tree, so it keeps its row with no agent
    const live = tasks.filter(
        (t) =>
            atGate(t) || (t.state !== "done" && (workers.has(t.id) || !(QUEUED.has(t.state) || DROPPED.has(t.state))))
    );
    const done = tasks.filter((t) => t.state === "done" && !atGate(t));
    // settled without landing and with no tab left: listed in the done fold, which the run's progress counts them in
    const dropped = tasks.filter((t) => DROPPED.has(t.state) && !workers.has(t.id));
    // tasks not dispatched yet have no session to open, so they fold away until asked for
    const queued = tasks.filter((t) => QUEUED.has(t.state) && !workers.has(t.id));
    const open = !folds.collapsed.has(run.runId);
    // the stage's row is its current verifier's session while that is in the roster, so the session gets no
    // stage row of its own; a tab an earlier round's verifier left stays a failed stage row
    const final = finalStageView(run.dag, [], 0);
    const verifierRunId = run.dag?.final?.verifierrunid;
    const verifier = final.visible
        ? stages.find((s) => verifierRunId != null && s.agent.runId === verifierRunId)?.agent
        : undefined;
    const finalRow: AgentTreeRow | undefined = final.visible
        ? { kind: "final", project, run, agent: verifier }
        : undefined;
    const finalRunning = finalRow != null && final.tone === "run";
    const finalPassed = finalRow != null && final.tone === "pass";
    // a plan reviewer with a verdict has no tab once the engine stops it, so the dag gives its row
    const tabbed = new Set(stages.map((s) => s.agent.runId));
    const endedReviewers: StageAgent[] = allEndedPlanReviewers(run)
        .filter(({ reviewer }) => !tabbed.has(reviewer.runid))
        .map(({ reviewer }) => ({ agent: endedReviewerVM(run.runId, reviewer), stageRole: PLAN_REVIEWER_ROLE }));
    const judged: JudgedStage[] = [...stages.filter((s) => s.agent !== verifier), ...endedReviewers]
        .map((s) => {
            const reviewer =
                s.stageRole === PLAN_REVIEWER_ROLE ? planReviewerOf(run.dag?.planreview, s.agent.runId) : undefined;
            return {
                ...s,
                outcome: stageOutcome(run, s.stageRole, s.agent.runId),
                lens: reviewer?.lens,
                round: reviewer?.round,
            };
        })
        .sort(stageOrder);
    // a one-round review's rows read as they always have, with no round
    const multiRound = (run.dag?.planreview?.pastrounds?.length ?? 0) > 0;
    const judging = judged.filter((s) => s.outcome == null);
    const finished = judged.filter((s) => s.outcome != null);
    const busy = live.length + judging.length + (finalRunning ? 1 : 0);
    const head: AgentTreeRow =
        item.kind === "lead"
            ? { kind: "lead", agent: item.agent, project, run, open, live: busy }
            : { kind: "run", project, run, open, live: busy };
    const rows: AgentTreeRow[] = [head];
    // a task's row is its worker's; its reviewer and any tab an earlier attempt left fold beneath it, opening on
    // their own when one of them asks
    const pushTask = (task: TaskNode) => {
        const { primary, extras } = splitTaskTabs(task, workers.get(task.id) ?? []);
        const extrasOpen =
            extras.length > 0 &&
            (folds.extrasOpen.has(taskFoldKey(run.runId, task.id)) || extras.some((a) => a.state === "asking"));
        const gate = mergeGateLine(run, task.id);
        rows.push({ kind: "worker", agent: primary, project, run, task, gate, extras: extras.length, extrasOpen });
        if (extrasOpen) {
            for (const agent of extras) {
                rows.push({ kind: "worker", agent, project, run, task, nested: true });
            }
        }
    };
    const pushStage = ({ agent, stageRole, outcome, lens, round }: JudgedStage) =>
        rows.push({
            kind: "stage",
            agent,
            project,
            run,
            stageRole,
            outcome,
            lens,
            round: multiRound ? round : undefined,
        });
    if (open) {
        // oldest first: what finished, what is running, what is still to come
        if (done.length > 0 || dropped.length > 0 || finished.length > 0 || finalPassed) {
            // the row being read keeps its fold open, or a landing or the stage passing would pull it out from
            // under the reader
            const doneOpen =
                folds.doneOpen.get(run.runId) === done.length ||
                done.some((t) => endedWorkerId(run.runId, t.id) === focusId) ||
                (finalPassed && finalRowFocusId(run, verifier ? [verifier] : []) === focusId);
            const stageCount = finished.length + (finalPassed ? 1 : 0);
            rows.push({
                kind: "done",
                project,
                run,
                count: done.length,
                landed: done.filter((t) => t.merged).length,
                skipped: dropped.filter((t) => t.state === "skipped").length,
                cancelled: dropped.filter((t) => t.state === "cancelled").length,
                stages: stageCount,
                planReviews: finished.filter((s) => s.stageRole === "plan-reviewer").length,
                open: doneOpen,
            });
            if (doneOpen) {
                finished.filter((s) => s.stageRole === "plan-reviewer").forEach(pushStage);
                done.forEach(pushTask);
                dropped.forEach(pushTask);
                finished.filter((s) => s.stageRole !== "plan-reviewer").forEach(pushStage);
                if (finalPassed) {
                    rows.push(finalRow);
                }
            }
        }
        live.forEach(pushTask);
        // a stage still judging is what the run is doing now, so it sits between what finished and what is to come
        judging.forEach(pushStage);
        // a failed or unverified final stage stays out of the fold: it is what the run is waiting on
        if (finalRow != null && !finalPassed) {
            rows.push(finalRow);
        }
        if (queued.length > 0) {
            const queuedOpen = folds.queuedOpen.has(run.runId);
            rows.push({ kind: "queued", project, run, count: queued.length, open: queuedOpen });
            if (queuedOpen) {
                queued.forEach(pushTask);
            }
        }
    }
    const attn = live.filter((t) => workerNeedsYou(run, t.id, workers.get(t.id)?.[0])).length;
    const agents =
        live.filter((t) => workers.has(t.id)).length + judging.length + (finalRunning && verifier != null ? 1 : 0);
    return { rows, members: agents, attn };
}

/** Pure: roster -> [group, ...rows] per project. Projects appear in the roster's first-seen order; top-level
 *  rows within a group follow the roster (the session sidebar's order, which does not move when an agent parks),
 *  pinned agents first. A run's workers follow its lead in plan order, and a run with no lead in the roster takes
 *  the place of its first worker. `count` is the group's visible agents, done workers aside; `attn` is how many wait on the human. */
export function buildAgentTree(
    agents: AgentVM[],
    lineage: Lineage = NO_LINEAGE,
    folds: TreeFolds = NO_FOLDS,
    focusId?: string
): AgentTreeRow[] {
    const leads = new Map<string, AgentVM>();
    const workers = new Map<string, Map<string, AgentVM[]>>();
    const stages = new Map<string, StageAgent[]>();
    for (const a of agents) {
        const role = lineage.roles[a.id];
        if (role?.kind === "lead" && lineage.runs[role.runId] && !leads.has(role.runId)) {
            leads.set(role.runId, a);
        } else if (role?.kind === "stage" && lineage.runs[role.leadRunId]) {
            stages.set(role.leadRunId, [
                ...(stages.get(role.leadRunId) ?? []),
                { agent: a, stageRole: role.stageRole },
            ]);
        } else if (role?.kind === "worker" && lineage.runs[role.leadRunId]) {
            let byTask = workers.get(role.leadRunId);
            if (!byTask) {
                byTask = new Map();
                workers.set(role.leadRunId, byTask);
            }
            byTask.set(role.taskId, [...(byTask.get(role.taskId) ?? []), a]);
        }
    }
    // the task's current run leads its agents, so a tab left from an earlier attempt never takes its row
    for (const [runId, byTask] of workers) {
        const run = lineage.runs[runId];
        for (const [taskId, list] of byTask) {
            list.sort((a, b) => Number(holdsTask(run, taskId, b)) - Number(holdsTask(run, taskId, a)));
        }
    }

    // a builder check's reviewer and a judge are runs of their own with no lead, so only the brainstorming agent's
    // record of one links it to that agent. It nests there while the agent has a plain row, and is a plain row once
    // that tab is gone
    type Owned = { owner: AgentVM; stageRole: string; state: BuilderCheckRecord["state"] };
    const checkOwners = new Map<string, Owned>(); // by the record's run id
    for (const a of agents) {
        if (lineage.roles[a.id] != null) {
            continue;
        }
        for (const [stageRole, record] of [
            [BUILDER_CHECK_ROLE, a.builderCheck],
            [BRAINSTORM_JUDGE_ROLE, a.brainstormJudge],
        ] as const) {
            if (record?.runId && !checkOwners.has(record.runId)) {
                checkOwners.set(record.runId, { owner: a, stageRole, state: record.state });
            }
        }
    }
    type Nested = { agent: AgentVM; stageRole: string; state: BuilderCheckRecord["state"] };
    const checks = new Map<string, Nested[]>(); // by the brainstorming agent's id

    const groups: { project: string; items: TopItem[] }[] = [];
    const byProject = new Map<string, TopItem[]>();
    const push = (item: TopItem) => {
        let items = byProject.get(item.project);
        if (!items) {
            items = [];
            byProject.set(item.project, items);
            groups.push({ project: item.project, items });
        }
        items.push(item);
    };
    // a worker nests under the agent that started it while that agent has a plain row: a run's rows and a check's
    // are laid out by their run or brainstorm. Workers whose parents name each other in a loop stay top-level rows
    const isPlain = (a: AgentVM) => {
        const role = lineage.roles[a.id];
        if (role?.kind === "lead") {
            return leads.get(role.runId) !== a;
        }
        if (role?.kind === "worker" || role?.kind === "stage") {
            return !lineage.runs[role.leadRunId];
        }
        return !(a.runId != null && checkOwners.has(a.runId));
    };
    const byId = new Map(agents.map((a) => [a.id, a]));
    const parentOf = (a: AgentVM): AgentVM | undefined => {
        const p = a.parentTabId != null ? byId.get(a.parentTabId) : undefined;
        return p != null && isPlain(p) ? p : undefined;
    };
    const nestsUnder = new Map<string, AgentVM>();
    for (const a of agents) {
        const p = isPlain(a) ? parentOf(a) : undefined;
        if (p == null) {
            continue;
        }
        const seen = new Set([a.id]);
        let up: AgentVM | undefined = p;
        while (up != null && !seen.has(up.id)) {
            seen.add(up.id);
            up = parentOf(up);
        }
        if (up == null) {
            nestsUnder.set(a.id, p);
        }
    }
    const workersOf = new Map<string, AgentVM[]>(); // by the parent's id, in roster order
    for (const a of agents) {
        const p = nestsUnder.get(a.id);
        if (p != null) {
            workersOf.set(p.id, [...(workersOf.get(p.id) ?? []), a]);
        }
    }

    const placedRuns = new Set<string>();
    for (const a of agents) {
        const role = lineage.roles[a.id];
        if (nestsUnder.has(a.id)) {
            continue;
        }
        if (role?.kind === "lead" && leads.get(role.runId) === a) {
            placedRuns.add(role.runId);
            push({ kind: "lead", agent: a, project: projectOf(a) || UNGROUPED_PROJECT, run: lineage.runs[role.runId] });
        } else if ((role?.kind === "worker" || role?.kind === "stage") && lineage.runs[role.leadRunId]) {
            if (leads.has(role.leadRunId) || placedRuns.has(role.leadRunId)) {
                continue;
            }
            placedRuns.add(role.leadRunId);
            const run = lineage.runs[role.leadRunId];
            push({ kind: "run", project: run.project || UNGROUPED_PROJECT, run });
        } else if (a.runId != null && checkOwners.has(a.runId)) {
            const { owner, stageRole, state } = checkOwners.get(a.runId);
            checks.set(owner.id, [...(checks.get(owner.id) ?? []), { agent: a, stageRole, state }]);
        } else {
            push({ kind: "parent", agent: a, project: projectOf(a) || UNGROUPED_PROJECT });
        }
    }

    const isPinned = (item: TopItem) => item.kind !== "run" && item.agent.pinned === true;
    const rows: AgentTreeRow[] = [];
    for (const g of groups) {
        const body: AgentTreeRow[] = [];
        let count = 0;
        let attn = 0;
        for (const item of [...g.items.filter(isPinned), ...g.items.filter((i) => !isPinned(i))]) {
            if (item.kind === "parent") {
                const pushAgent = (agent: AgentVM, depth: number) => {
                    const nested = checks.get(agent.id) ?? [];
                    body.push(
                        depth > 0 ? { ...item, agent, depth } : item,
                        ...nested.map((n) => ({ kind: "check" as const, project: g.project, ...n }))
                    );
                    const members = [agent, ...nested.map((n) => n.agent)];
                    count += members.length;
                    attn += members.filter((a) => a.state === "asking").length;
                    for (const w of workersOf.get(agent.id) ?? []) {
                        pushAgent(w, depth + 1);
                    }
                };
                pushAgent(item.agent, 0);
                continue;
            }
            const r = runRows(
                item,
                workers.get(item.run.runId) ?? new Map(),
                stages.get(item.run.runId) ?? [],
                folds,
                focusId
            );
            body.push(...r.rows);
            count += r.members + (item.kind === "lead" ? 1 : 0);
            attn += r.attn + (item.kind === "lead" && item.agent.state === "asking" ? 1 : 0);
        }
        rows.push({ kind: "group", project: g.project, count, attn }, ...body);
    }
    return rows;
}

const ERROR_STATES = new Set(["failed", "verify-failed", "blocked-merge", "review-failed"]);

/** Pure: the tone a task's worker row draws its dot and second line in: a failure is an error, a stall a warning. */
export function workerRowTone(task: TaskNode): "error" | "warning" | undefined {
    if (ERROR_STATES.has(task.state)) {
        return "error";
    }
    return task.state === "stalled" ? "warning" : undefined;
}

/** Pure: the id a click on the row focuses; none for a fold or header. A done task's worker, or one whose tab its
 *  merge reaped, opens as its ended worker's transcript; the final stage is its verifier's session once that is
 *  in the roster. */
export function rowFocusKey(row: AgentTreeRow): string | undefined {
    switch (row.kind) {
        case "parent":
        case "check":
        case "lead":
        case "stage":
            return row.agent.id;
        case "worker": {
            const ended =
                !row.nested &&
                (row.task.state === "done" ||
                    (row.agent == null && (workerEnded(row.task) || failedWithTranscript(row.task))));
            return ended ? endedWorkerId(row.run.runId, row.task.id) : row.agent?.id;
        }
        case "final":
            return finalRowFocusId(row.run, row.agent ? [row.agent] : []);
        default:
            return undefined;
    }
}

/** Pure: what the focus keys step through: the rows' focus keys in the order the tree shows them, then the
 *  terminals, which the tree lists below its groups. */
export function treeFocusOrder(rows: AgentTreeRow[], terminals: AgentVM[]): string[] {
    const keys = rows.map(rowFocusKey).filter((k): k is string => k != null);
    return [...keys, ...terminals.map((t) => t.id)];
}

/** Pure: the tree's total for its header, the sum of its groups' counts. */
/** Pure: the done fold's words: what landed, what finished without a merge, what was settled without landing,
 *  then the stages with a verdict. */
export function doneFoldLabel(
    row: Pick<
        Extract<AgentTreeRow, { kind: "done" }>,
        "count" | "landed" | "skipped" | "cancelled" | "stages" | "planReviews"
    >
): string {
    const others = row.stages - row.planReviews;
    return [
        row.landed > 0 ? `${row.landed} landed` : "",
        row.count - row.landed > 0 ? `${row.count - row.landed} done` : "",
        row.skipped > 0 ? `${row.skipped} skipped` : "",
        row.cancelled > 0 ? `${row.cancelled} cancelled` : "",
        row.planReviews > 0 ? `${row.planReviews} ${row.planReviews === 1 ? "plan review" : "plan reviews"}` : "",
        others > 0 ? `${others} ${others === 1 ? "review" : "reviews"}` : "",
    ]
        .filter(Boolean)
        .join(" · ");
}

export function treeAgentCount(rows: AgentTreeRow[]): number {
    return rows.reduce((n, r) => n + (r.kind === "group" ? r.count : 0), 0);
}
