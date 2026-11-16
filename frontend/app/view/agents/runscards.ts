// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what the wsh runs cards and views show, from the call's argv, its --json output and what Arc's stores hold
// about the run. No React; the draw is wshcards-runs.tsx.

import { formatTokens } from "./agentsviewmodel";
import { shortModel } from "./modelname";
import { fmtDuration } from "./runcompletion";
import { runTitle } from "./runlineage";
import type { WshCall } from "./wshcall";

export const SHORT_SHA = 7;
export const SHOWN_TASKS = 4;
// a run's id as the board prints it
export const SHORT_RUN_ID = 8;
// the call's own time brackets the run it created; this much either side absorbs clock jitter between the two
const START_MATCH_SLACK_MS = 2_000;

export type Tone = "ok" | "warn" | "bad" | "muted";

// ---- runs show

// what `wsh runs show --json` prints, and what the same view is built from when the call had no --json
export interface RunShowSource {
    run: Run;
    channelId?: string;
    group?: TaskGroup;
    digest?: DagStatusDigest;
    usage?: UsageRow[];
}

interface RunShowJson {
    channelid?: string;
    run?: Run;
    dag?: { group?: TaskGroup; digest?: DagStatusDigest } | null;
    // the run's own pending question; the view does not draw it, but the output carries it
    asks?: DagAskItem[] | null;
}

export function runShowSourceFromJson(json: RunShowJson | null | undefined): RunShowSource | null {
    if (json?.run == null) {
        return null;
    }
    return {
        run: json.run,
        channelId: json.channelid,
        group: json.dag?.group ?? undefined,
        digest: json.dag?.digest ?? undefined,
    };
}

export interface RunShowTile {
    label: string;
    value: string;
    tone?: Tone;
}

export interface TokenRole {
    role: string;
    label: string;
    tokens: number;
    text: string;
    fill: string;
}

export interface TokenBar {
    total: string;
    meta: string;
    roles: TokenRole[];
}

export interface RunShowModel {
    runId: string;
    title: string;
    pill: { text: string; sha?: string; tone: Tone };
    tiles: RunShowTile[];
    tokens: TokenBar | null;
    tasks: { id: string; title: string; sha?: string }[];
    moreTasks: number;
    unverified: { taskId: string; text: string }[];
}

// each role's fill is a literal class so the stylesheet keeps it; the lane tokens are the Usage surface's
const ROLE_STYLE: Record<string, { label: string; fill: string }> = {
    worker: { label: "workers", fill: "bg-graphlane-1" },
    lead: { label: "lead", fill: "bg-success" },
    "plan-reviewer": { label: "plan reviewer", fill: "bg-warning" },
    verifier: { label: "verifier", fill: "bg-graphlane-4" },
    reviewer: { label: "reviewers", fill: "bg-graphlane-6" },
};
const OTHER_FILL = "bg-ink-faint";

function shortSha(sha: string | undefined): string | undefined {
    return sha ? sha.slice(0, SHORT_SHA) : undefined;
}

function runPill(run: Run): RunShowModel["pill"] {
    const land = run.land;
    if (land?.state === "landed") {
        return { text: "landed", sha: shortSha(land.commit ?? run.endcommit), tone: "ok" };
    }
    if (land?.state === "held") {
        return { text: "land held", tone: "warn" };
    }
    return { text: run.status, tone: statusTone(run.status) };
}

export function statusTone(status: string | undefined): Tone {
    switch (status) {
        case "done":
            return "ok";
        case "cancelled":
            return "bad";
        case "blocked":
        case "awaiting-review":
            return "warn";
        default:
            return "ok";
    }
}

function stageValue(stage: { state: string; round: number } | undefined): string | undefined {
    return stage ? `${stage.state}, round ${stage.round}` : undefined;
}

function finalTone(state: string): Tone {
    if (state === "passed") {
        return "ok";
    }
    return state === "unverified" ? "warn" : state === "failed" ? "bad" : "muted";
}

function elapsedMs(src: RunShowSource, now: number): number | undefined {
    const { run } = src;
    if (run.completedts) {
        return run.completedts - run.createdts;
    }
    if (src.digest?.durations?.elapsedms) {
        return src.digest.durations.elapsedms;
    }
    return run.createdts ? now - run.createdts : undefined;
}

function tiles(src: RunShowSource, now: number): RunShowTile[] {
    const out: RunShowTile[] = [];
    const counts = src.digest?.counts;
    if (counts) {
        out.push({ label: "Tasks", value: `${counts.done} of ${counts.total}` });
    }
    const elapsed = elapsedMs(src, now);
    if (elapsed != null) {
        out.push({ label: "Elapsed", value: fmtDuration(elapsed) });
    }
    const review = stageValue(src.group?.planreview);
    if (review) {
        out.push({
            label: "Plan review",
            value: review,
            tone: src.group?.planreview?.state === "failed" ? "bad" : undefined,
        });
    }
    const final = src.group?.final;
    if (final) {
        out.push({ label: "Final", value: stageValue(final)!, tone: finalTone(final.state) });
    }
    return out;
}

function tokenBar(src: RunShowSource): TokenBar | null {
    const rows = src.usage ?? src.run.evidence?.usage ?? src.digest?.report?.usage ?? [];
    const byRole = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
        if (r.missing) {
            continue;
        }
        const tokens = r.input + r.output + r.cacheread + r.cachewrite + r.cachewrite1h;
        byRole.set(r.role, (byRole.get(r.role) ?? 0) + tokens);
        total += tokens;
    }
    if (total === 0) {
        return null;
    }
    const roles = [...byRole]
        .filter(([, tokens]) => tokens > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([role, tokens]) => ({
            role,
            tokens,
            label: ROLE_STYLE[role]?.label ?? role,
            fill: ROLE_STYLE[role]?.fill ?? OTHER_FILL,
            text: formatTokens(tokens),
        }));
    return { total: formatTokens(total), meta: runRouteText(src.run), roles };
}

// "claude opus · autonomous"
function runRouteText(run: Run): string {
    const parts = [[run.runtime, run.model ? shortModel(run.model) : ""].filter(Boolean).join(" ")];
    if (run.autonomous) {
        parts.push("autonomous");
    }
    return parts.filter(Boolean).join(" · ");
}

function taskTitle(t: TaskNode): string {
    return t.label?.trim() || t.description?.trim().split("\n")[0] || t.id;
}

export function runShowModel(src: RunShowSource, now: number): RunShowModel {
    const commits = new Map((src.digest?.report?.commits ?? []).map((c) => [c.taskid, c.commit]));
    const all = (src.group?.tasks ?? []).map((t) => ({
        id: t.id,
        title: taskTitle(t),
        sha: shortSha(commits.get(t.id)),
    }));
    return {
        runId: src.run.id,
        title: runTitle(src.run, src.group),
        pill: runPill(src.run),
        tiles: tiles(src, now),
        tokens: tokenBar(src),
        tasks: all.slice(0, SHOWN_TASKS),
        moreTasks: Math.max(0, all.length - SHOWN_TASKS),
        unverified: (src.digest?.report?.unverifiednotes ?? []).map((n) => ({ taskId: n.taskid, text: n.text })),
    };
}

// ---- runs attention

export interface AttentionRow {
    key: string;
    action: string;
    kind: string;
    source: string;
    text: string;
    waited?: string;
    runId?: string;
}

export interface AttentionModel {
    empty: boolean;
    rows: AttentionRow[];
}

export function attentionModel(items: AttentionItem[] | null | undefined, now: number): AttentionModel {
    const rows = (items ?? []).map((it) => ({
        key: it.key,
        action: it.action,
        kind: it.kind,
        source: it.source,
        text: it.text.replace(/\s+/g, " ").trim(),
        waited: it.waitingsince > 0 ? fmtDuration(Math.max(0, now - it.waitingsince)) : undefined,
        runId: it.runid || undefined,
    }));
    return { empty: rows.length === 0, rows };
}

export const NOTHING_WAITING = "nothing waiting";

// the collapsed step row's summary, from the call's own --json output only: a row never fetches, and only an empty
// list is worth a word there (a non-empty one needs the opened view)
export function attentionStepSummary(call: WshCall, output: string | undefined): string | undefined {
    const json = call.flags["json"];
    if (!output || !(json === true || json === "true")) {
        return undefined;
    }
    try {
        const v = JSON.parse(output);
        return Array.isArray(v) && v.length === 0 ? NOTHING_WAITING : undefined;
    } catch {
        return undefined;
    }
}

// ---- runs start

export interface RunStartedModel {
    title: string;
    // the run's current status when it was found, so a card for a run still planning says so
    status?: { text: string; tone: Tone };
    mode: string;
    runtimeModel: string;
    runId?: string;
    // chunk numbers the run takes, as the initiative numbers them
    chunks: string[];
    initiative?: string;
}

// "2. Projection fixes" is chunk 2; a label with no number stays as it is
function chunkNumber(label: string): string {
    const m = /^\s*(\d+)\b/.exec(label);
    return m ? m[1] : label.trim();
}

function firstLine(s: string): string {
    return s.trim().split("\n")[0].trim();
}

function flagText(call: WshCall, name: string): string {
    const v = call.flags[name];
    return typeof v === "string" ? v : "";
}

export function runStartedModel(input: { call: WshCall; run?: Run; effortTitle?: string }): RunStartedModel {
    const { call, run } = input;
    const goal = firstLine(call.args[0] ?? "");
    const plan = flagText(call, "plan");
    const planName = plan ? (plan.split(/[\\/]/).pop() ?? plan) : "";
    const labels = [flagText(call, "chunk"), run?.effortref?.chunklabel ?? ""].filter(Boolean).map(chunkNumber);
    return {
        title: (run ? runTitle(run, undefined) : "") || goal || planName || "Run",
        status: run ? { text: run.status, tone: statusTone(run.status) } : undefined,
        mode: run?.mode || flagText(call, "mode") || (plan ? "orchestrator" : "quick"),
        runtimeModel: run
            ? runRouteText(run)
            : [flagText(call, "runtime"), flagText(call, "model") ? shortModel(flagText(call, "model")) : ""]
                  .filter(Boolean)
                  .join(" "),
        runId: run?.id,
        chunks: [...new Set(labels)],
        initiative: input.effortTitle || undefined,
    };
}

// the run a start call created, among its channel's runs, when the call carried no --json: created within the
// call's own span, with the goal it was given; with no goal only a lone candidate counts, never a guess
export function matchStartedRun(
    runs: Run[],
    call: { goal?: string; ts?: number; durationMs?: number }
): Run | undefined {
    if (call.ts == null) {
        return undefined;
    }
    const from = call.ts - START_MATCH_SLACK_MS;
    const to = call.ts + (call.durationMs ?? 0) + START_MATCH_SLACK_MS;
    const inWindow = runs.filter((r) => r.createdts >= from && r.createdts <= to);
    const goal = call.goal?.trim();
    const matched = goal ? inWindow.filter((r) => r.goal.trim() === goal) : inWindow;
    return matched.length === 1 ? matched[0] : undefined;
}

// ---- runs answer

export interface RunAnsweredModel {
    runId: string;
    // one per question answered; the question and option labels only when the ask is still known
    items: { question?: string; picked: string[] }[];
}

function parseAnswers(text: string | undefined): AgentAnswerItem[] {
    try {
        const v = JSON.parse(text ?? "");
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

// the run's pending ask is read after the call landed, so one raised later than the call is a different question:
// only asks raised by `ts` name what was answered, and with no `ts` none do
export function runAnsweredModel(input: { call: WshCall; asks?: DagAskItem[] | null; ts?: number }): RunAnsweredModel {
    const { ts } = input;
    const raised = ts == null ? [] : (input.asks ?? []).filter((a) => a.ts <= ts);
    const questions = raised.flatMap((a) => a.questions ?? []);
    const items = parseAnswers(input.call.args[1]).map((answer, i) => {
        const q = questions[i];
        const picked = (answer.selectedindexes ?? []).map((idx) => q?.options?.[idx]?.label ?? `Option ${idx + 1}`);
        if (answer.text) {
            picked.push(answer.text);
        }
        return q ? { question: q.question, picked } : { picked };
    });
    return { runId: input.call.args[0] ?? "", items };
}
