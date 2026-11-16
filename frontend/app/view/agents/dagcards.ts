// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure models behind the run cards (plan submitted, fix round, review verdicts, Final, completion) and the dag
// status view: argv first, then the run and dag status Arc holds, so a card still says what happened when the
// run is gone. No React.

import { lanesOf } from "../orchestrate/daglayout";
import { fmtDuration } from "./runcompletion";
import { roleRunId, workerAsk } from "./runlineage";
import { planReviewLensTitle } from "./runtimeline";
import type { TranscriptContext } from "./transcriptcontext";
import type { WshCall } from "./wshcall";

// how much of a commit hash a card shows, as git's short form does
const SHA_CHARS = 7;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

// a run's elapsed time: "39m 38s", and past an hour "2h 41m"
export function fmtElapsed(ms: number): string {
    if (ms < HOUR_MS) {
        return fmtDuration(ms);
    }
    return `${Math.floor(ms / HOUR_MS)}h ${Math.floor((ms % HOUR_MS) / MINUTE_MS)}m`;
}

// every fix-round task's description opens with this line (pkg/orchestrate round.go fixRoundLineFmt)
const FIX_ROUND_RE = /^Fix round (\d+):/;

export const dagDataKey = (runId: string) => `dag:${runId}`;
export const runDataKey = (runId: string) => `run:${runId}`;

// a literal sha only: `--commit $(git rev-parse HEAD)` reaches the transcript unexpanded
export function shortSha(s: string | true | undefined): string | undefined {
    return typeof s === "string" && SHA_RE.test(s) ? s.slice(0, SHA_CHARS) : undefined;
}

function flagText(call: WshCall, name: string): string | undefined {
    const v = call.flags[name];
    return typeof v === "string" && v !== "" ? v : undefined;
}

// the run a dag call acts on: the agent's run (a lead's own, else its lead's), else the call's --runid
export function dagRunId(call: WshCall, ctx: TranscriptContext): string | undefined {
    return ctx.role ? roleRunId(ctx.role) : flagText(call, "runid");
}

export function dagChannelId(call: WshCall, ctx: TranscriptContext): string | undefined {
    return ctx.channelId || flagText(call, "channel");
}

function fixRoundOf(task: TaskNode): number | undefined {
    const m = FIX_ROUND_RE.exec(task.description ?? "");
    return m ? Number(m[1]) : undefined;
}

// longestChain is jarvis.LongestChain (pkg/jarvis/plan.go): the number of tasks on the longest dependency path
export function longestChain(tasks: Pick<TaskNode, "id" | "deps">[]): number {
    const deps = new Map(tasks.map((t) => [t.id, t.deps ?? []] as const));
    const depth = new Map<string, number>();
    const walk = (id: string): number => {
        const known = depth.get(id);
        if (known != null) {
            return known;
        }
        const d = 1 + Math.max(0, ...(deps.get(id) ?? []).filter((x) => deps.has(x)).map(walk));
        depth.set(id, d);
        return d;
    };
    return Math.max(0, ...tasks.map((t) => walk(t.id)));
}

export interface PlanCell {
    id: string;
    label: string;
    after: string[];
}

export interface PlanReviewLine {
    state: string;
    round: number;
    // the lenses still reading, while the review runs
    readers: string[];
}

export type SubmitModel =
    | {
          kind: "plan";
          tasks?: number;
          lanes?: number;
          longestChain?: number;
          // one row per lane, each its tasks in run order
          grid: PlanCell[][];
          columns: number;
          review?: PlanReviewLine;
      }
    | { kind: "round"; round?: number; last: boolean; tasks: { id: string; label: string }[] };

function planReviewLine(pr: PlanReviewStage | undefined): PlanReviewLine | undefined {
    if (pr == null) {
        return undefined;
    }
    const readers = (pr.reviewers ?? []).filter((r) => r.state === "reviewing").map((r) => planReviewLensTitle(r.lens));
    return { state: pr.state, round: pr.round, readers };
}

// submitModel is a plan submit's card: the plan's tasks (fix-round tasks aside) laid out by lane, or with --round
// the newest fix round's tasks. Without the dag it is the bare title.
export function submitModel(call: WshCall, group: TaskGroup | undefined): SubmitModel {
    const tasks = group?.tasks ?? [];
    if (call.flags.round === true) {
        const rounds = tasks.map(fixRoundOf).filter((r): r is number => r != null);
        const round = rounds.length > 0 ? Math.max(...rounds) : undefined;
        const mine = round == null ? [] : tasks.filter((t) => fixRoundOf(t) === round);
        return {
            kind: "round",
            round,
            // a dag created before the engine stamped its limit has none, and no round reads as the last
            last: round != null && !!group?.maxfinalrounds && round >= group.maxfinalrounds,
            tasks: mine.map((t) => ({ id: t.id, label: t.label ?? "" })),
        };
    }
    if (group == null) {
        return { kind: "plan", grid: [], columns: 0 };
    }
    const plan = tasks.filter((t) => fixRoundOf(t) == null);
    const byId = new Map(plan.map((t) => [t.id, t] as const));
    const lanes = lanesOf(plan);
    const grid = lanes.map((ids) =>
        ids.map((id) => {
            const t = byId.get(id)!;
            return { id, label: t.label ?? "", after: t.deps ?? [] };
        })
    );
    return {
        kind: "plan",
        tasks: plan.length,
        lanes: lanes.length,
        longestChain: longestChain(plan),
        grid,
        columns: Math.max(0, ...grid.map((row) => row.length)),
        review: planReviewLine(group.planreview),
    };
}

export interface ReviewModel {
    taskId?: string;
    passed: boolean;
    // the failed reviews so far, for a send-back; the engine counts only failures
    round?: number;
    total?: number;
    note: string;
}

// reviewModel is a task reviewer's verdict: `dag review <pass|fail> <note>`. The reviewer's run is placed on its
// task, so the task id comes from its role.
export function reviewModel(call: WshCall, ctx: TranscriptContext, group: TaskGroup | undefined): ReviewModel {
    const taskId = ctx.role?.kind === "worker" ? ctx.role.taskId : undefined;
    const passed = call.args[0] === "pass";
    const task = taskId ? group?.tasks?.find((t) => t.id === taskId) : undefined;
    const round = !passed && task?.reviewround ? task.reviewround : undefined;
    return { taskId, passed, round, total: group?.maxreviewrounds || undefined, note: call.args[1] ?? "" };
}

const PLAN_VERDICTS: Record<string, string> = { pass: "passed", fail: "failed", accept: "accepted" };

// planReviewModel is `dag planreview <pass|fail|accept> <text>`
export function planReviewModel(call: WshCall): { verdict: string; tone: "pass" | "fail" | "warn"; text: string } {
    const v = call.args[0] ?? "";
    const tone = v === "pass" ? "pass" : v === "fail" ? "fail" : "warn";
    return { verdict: PLAN_VERDICTS[v] ?? v, tone, text: call.args[1] ?? "" };
}

export interface FinalModel {
    passed: boolean;
    round?: number;
    total?: number;
    sha?: string;
    text?: string;
    unverified: string[];
    hasShots: boolean;
}

function finalStages(group: TaskGroup | undefined): FinalStage[] {
    return [...(group?.pastfinals ?? []), ...(group?.final ? [group.final] : [])];
}

// finalModel is Final's verdict: what the caller knows (argv, a wake's text), then the stage it judged, found by its
// text (the engine stores the verdict's text as the stage's detail), else the current one.
export function finalModel(
    props: { passed: boolean; round?: number; total?: number; sha?: string; text?: string },
    group: TaskGroup | undefined,
    hasShots: (group: TaskGroup, round: number) => boolean = () => false
): FinalModel {
    const stages = finalStages(group);
    const text = props.text?.trim();
    const stage =
        (props.round != null ? stages.find((s) => s.round === props.round) : undefined) ??
        (text ? stages.find((s) => s.detail?.trim() === text) : undefined) ??
        (props.round == null ? group?.final : undefined);
    const round = props.round ?? stage?.round;
    const max = group?.maxfinalrounds;
    // a granted round past the limit has no total to draw
    const total = props.total ?? (max && round != null && round <= max ? max : undefined);
    return {
        passed: props.passed,
        round,
        total,
        sha: props.sha ?? shortSha(stage?.commit),
        text: props.text,
        unverified: stage?.unverified ?? [],
        hasShots: group != null && round != null && hasShots(group, round),
    };
}

// the final verdict from `dag final <pass|fail> <text>`
export function finalArgs(call: WshCall): { passed: boolean; text: string } {
    return { passed: call.args[0] === "pass", text: call.args[1] ?? "" };
}

export interface RunStats {
    tasks: number;
    failures: number;
    elapsedMs?: number;
    commits: number;
    questions: number;
}

export type CompleteModel =
    | { kind: "task"; taskId?: string; sha?: string; dagId?: string }
    | {
          kind: "run";
          runId?: string;
          land: "landed" | "held" | "unknown";
          sha?: string;
          base?: string;
          reason?: string;
          // the branch that stays unmerged while the land is held
          branch?: string;
          landLine?: string;
          stats?: RunStats;
      };

function runStats(status: CommandDagStatusRtnData | undefined): RunStats | undefined {
    const g = status?.group;
    if (g == null) {
        return undefined;
    }
    const d = status.digest;
    return {
        tasks: (g.tasks ?? []).length,
        failures: g.failures ?? 0,
        elapsedMs: d?.durations?.elapsedms || undefined,
        commits: d?.report?.commits?.length ?? 0,
        questions: d?.report?.forwarded ?? 0,
    };
}

// completeModel is `wsh jarvis complete`: a worker's task, else the run its lead completes, landed or held by the
// run's land state.
export function completeModel(
    call: WshCall,
    ctx: TranscriptContext,
    run: Run | undefined,
    status: CommandDagStatusRtnData | undefined
): CompleteModel {
    const argSha = shortSha(call.flags.commit);
    const role = ctx.role;
    if (role?.kind === "worker") {
        const task = status?.group?.tasks?.find((t) => t.id === role.taskId);
        const landed = status?.digest?.report?.commits?.find((c) => c.taskid === role.taskId)?.commit;
        return {
            kind: "task",
            taskId: role.taskId,
            sha: argSha ?? shortSha(task?.reviewcommit) ?? shortSha(landed),
            dagId: status?.group?.oid || status?.group?.id || undefined,
        };
    }
    const runId = role ? roleRunId(role) : run?.oid;
    const stats = runStats(status);
    const land = run?.land;
    if (land?.state === "held") {
        const forced = status?.group?.final?.state === "failed";
        return {
            kind: "run",
            runId,
            land: "held",
            reason: land.reason,
            branch: run?.landpath && runId ? `wave/${runId}` : undefined,
            landLine: runId ? `wsh runs land ${runId}${forced ? " --force" : ""}` : undefined,
            stats,
        };
    }
    if (land?.state === "landed") {
        return {
            kind: "run",
            runId,
            land: "landed",
            sha: shortSha(land.commit) ?? argSha,
            base: run?.basebranch || undefined,
            stats,
        };
    }
    return { kind: "run", runId, land: "unknown", sha: argSha, stats };
}

export type TaskPill = "landed" | "done" | "running" | "asks" | "review" | "queued" | "failed" | "muted";

export interface DagStatusRow {
    id: string;
    label: string;
    pill: TaskPill;
    pillText: string;
    right?: string;
    // the right column is a commit hash
    rightMono?: boolean;
}

export interface DagStatusModel {
    status: string;
    done: number;
    total: number;
    parallelism: number;
    rows: DagStatusRow[];
}

const QUEUED = new Set(["pending", "ready"]);
const FAILING = new Set(["stalled", "failed", "verify-failed", "blocked-merge", "review-failed"]);
const ENDED = new Set(["skipped", "cancelled"]);
const IN_REVIEW = new Set(["reviewing", "verifying", "preparing"]);

function statusRow(
    t: TaskNode,
    digest: DagStatusDigest | undefined,
    done: Set<string>,
    now: number,
    fmt: (ms: number) => string
): DagStatusRow {
    const base = { id: t.id, label: t.label ?? "" };
    const commit = digest?.report?.commits?.find((c) => c.taskid === t.id)?.commit;
    if (t.merged) {
        return { ...base, pill: "landed", pillText: "landed", right: shortSha(commit), rightMono: true };
    }
    if (t.state === "done") {
        return { ...base, pill: "done", pillText: "done", right: shortSha(commit ?? t.reviewcommit), rightMono: true };
    }
    if (FAILING.has(t.state)) {
        return { ...base, pill: "failed", pillText: t.state.replace(/-/g, " ") };
    }
    if (ENDED.has(t.state)) {
        return { ...base, pill: "muted", pillText: t.state };
    }
    if (QUEUED.has(t.state)) {
        const waits = (t.deps ?? []).filter((d) => !done.has(d));
        return {
            ...base,
            pill: "queued",
            pillText: "queued",
            right: waits.length ? `after ${waits.join(", ")}` : undefined,
        };
    }
    if (IN_REVIEW.has(t.state)) {
        const idle = t.lastactivity ? `idle ${fmt(now - t.lastactivity)}` : undefined;
        return { ...base, pill: "review", pillText: t.state === "reviewing" ? "in review" : t.state, right: idle };
    }
    if (workerAsk(digest, t.id)) {
        return { ...base, pill: "asks", pillText: "asks" };
    }
    const since = t.firstactivity || t.spawnedts;
    return { ...base, pill: "running", pillText: "running", right: since ? fmt(now - since) : undefined };
}

// dagStatusModel is the opened `wsh jarvis dag status [task-id]` step: the header the engine's digest counts, and
// one row per task (that task only, when the call named one)
export function dagStatusModel(
    status: CommandDagStatusRtnData,
    onlyTask: string | undefined,
    now: number,
    fmt: (ms: number) => string
): DagStatusModel {
    const g = status.group;
    const tasks = g?.tasks ?? [];
    const done = new Set(tasks.filter((t) => t.state === "done" || t.merged).map((t) => t.id));
    const rows = tasks
        .filter((t) => onlyTask == null || t.id === onlyTask)
        .map((t) => statusRow(t, status.digest, done, now, fmt));
    return {
        status: g?.status ?? "",
        done: status.digest?.counts?.done ?? done.size,
        total: status.digest?.counts?.total ?? tasks.length,
        parallelism: g?.parallelism ?? 0,
        rows,
    };
}
