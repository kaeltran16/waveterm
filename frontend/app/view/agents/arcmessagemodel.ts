// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what Arc's own messages in a transcript say, read from the text the engine and the brainstorm pane send. A
// wake is classified by its leading phrase (the format strings in pkg/orchestrate/queue.go, wake.go and
// pkg/jarvis/leadprompt.go), a brainstorm line by its head (brainstormLine and settleLine in brainstormmodel.ts, and
// pkg/brainstormcheck), and the gap before a wake by the run's events in it. The row (arcmessagerow.tsx) words them.

import type { BrainstormFile } from "./brainstormmodel";
import type { RunRole } from "./runlineage";
import { detailOf } from "./runtimeline";

// a lead's silence this long before a wake folds into "Waited <gap>" (decision 11)
export const WAIT_FOLD_MIN_MS = 60_000;
// pkg/orchestrate LeadAskDeadline: how long the lead has to answer a worker's question before it goes to the human
export const LEAD_ASK_DEADLINE_MS = 10 * 60_000;

const WAKE_HEAD = "wake:";
const BRAINSTORM_HEAD = "brainstorm:";
// composeWake's section heads, each followed by its lines
const CAVEATS_HEAD = "Unverified:";
const QUIET_HEAD = "Since your last wake:";
// where a wake's own facts end and its instruction to the lead begins
const STATUS_CMD = /\.?\s*wsh jarvis dag status\b[\s\S]*$/;
// the engine's cut of a long section (pkg/orchestrate reportsections.go): "… N more characters: <cmd>", on its own
// line, or flattened into the plan review's one line. It and what follows on its line are plumbing for the lead.
const CUT_TAIL = /\s*… \d+ more characters?\b[^\n]*$/;

export type WakeKind =
    | "plan-review-failed"
    | "plan-reviewer-lost"
    | "never-started"
    | "merge-conflict"
    | "may-be-stuck"
    | "task-failed"
    | "task-hung"
    | "worker-idle"
    | "worker-exited"
    | "final-failed"
    | "final-killed"
    | "run-finished"
    | "questions"
    | "verify-failed"
    | "review-failed"
    | "review-note"
    | "engine-stuck"
    | "autonomous-on"
    | "autonomous-off"
    | "caveats"
    | "quiet"
    | "unknown";

export interface Finding {
    lens?: string;
    text: string;
}

// one line of a wake: its kind and what the line carries. items are its body lines (defects, failure lines, files,
// a section's lines); findings a plan review's numbered findings
export interface WakePart {
    kind: WakeKind;
    text: string;
    taskId?: string;
    round?: number;
    // the rounds the stage gets, as the wake names them
    of?: number;
    last?: boolean;
    sha?: string;
    count?: number;
    minutes?: number;
    failKind?: string;
    retrySpent?: boolean;
    reason?: string;
    files?: string[];
    items?: string[];
    findings?: Finding[];
}

type Matcher = { kind: WakeKind; re: RegExp; read: (m: RegExpExecArray) => Omit<WakePart, "kind" | "text"> };

const num = (s: string | undefined) => (s == null ? undefined : Number(s));
const nonEmpty = (s: string | undefined) => (s != null && s.trim() !== "" ? s.trim() : undefined);
const trimEnd = (s: string) => s.replace(/[.\s]+$/, "");

// the plan review's findings, flattened by the engine: "[Lens] 1) a. 2) b. Passed: Other." becomes one finding per
// numbered item (a block without numbers is one finding), its lens kept, the passed and lost tail dropped
export function splitFindings(flat: string): Finding[] {
    const body = flat.replace(/\s*(?:Passed:|Did not finish:)[\s\S]*$/, "");
    const out: Finding[] = [];
    for (const block of body.split(/(?=\[[^\]]+\]\s)/)) {
        const lensMatch = /^\[([^\]]+)\]\s*/.exec(block);
        const lens = lensMatch?.[1];
        const rest = lensMatch ? block.slice(lensMatch[0].length) : block;
        const numbered = rest.split(/(?:^|\s)\d+\)\s+/).map((s) => s.trim());
        const items = numbered.length > 1 ? numbered.slice(1) : numbered;
        for (const text of items) {
            if (text !== "") out.push(lens ? { lens, text } : { text });
        }
    }
    return out;
}

// the plan review's instruction tails (queue.go planReviewFailedWake), after the findings
const PLAN_REVIEW_TAIL = /\.\s+(?:Revise the plan|Put it to the human;|The run is autonomous)[\s\S]*$/;

const MATCHERS: Matcher[] = [
    {
        kind: "plan-review-failed",
        re: /^plan review failed in round (\d+)(, the last)?: ([\s\S]*)$/,
        read: (m) => ({
            round: num(m[1]),
            last: m[2] != null,
            findings: splitFindings(m[3].replace(PLAN_REVIEW_TAIL, "")),
        }),
    },
    {
        kind: "plan-reviewer-lost",
        re: /^the plan reviewer did not finish in round (\d+)(, the last)? \(([^)]*)\)/,
        read: (m) => ({ round: num(m[1]), last: m[2] != null, reason: m[3] }),
    },
    {
        kind: "never-started",
        re: /^task (\S+) never started: no worker process (\d+)m after spawn/,
        read: (m) => ({ taskId: m[1], minutes: num(m[2]) }),
    },
    {
        kind: "merge-conflict",
        re: /^merge conflict landing lane ending at task (\S+?)(?: in ([\s\S]+?))?\. (?:git status|wsh jarvis)/,
        read: (m) => ({ taskId: m[1], files: m[2] ? m[2].split(", ").map((f) => f.trim()) : [] }),
    },
    {
        kind: "may-be-stuck",
        re: /^task (\S+) may be stuck: ([\s\S]*?)\. Tell it/,
        read: (m) => ({ taskId: m[1], reason: m[2] }),
    },
    {
        kind: "task-failed",
        re: /^task (\S+) failed \(([^)]*)\)(?:: ([\s\S]*?))?(, retry spent)?\.\s*wsh jarvis dag status/,
        read: (m) => ({
            taskId: m[1],
            failKind: m[2],
            retrySpent: m[4] != null,
            items: nonEmpty(m[3]) ? [m[3].trim()] : [],
        }),
    },
    {
        kind: "task-hung",
        re: /^task (\S+) hung: silent (\d+)m/,
        read: (m) => ({ taskId: m[1], minutes: num(m[2]) }),
    },
    {
        kind: "worker-idle",
        re: /^task (\S+)'s worker (?:ended its turn without completing|is idle after its last turn failed: ([\s\S]*?)\.\s*wsh jarvis)/,
        read: (m) => ({ taskId: m[1], reason: nonEmpty(m[2]) }),
    },
    {
        kind: "worker-exited",
        re: /^task (\S+)'s worker exited without reporting complete/,
        read: (m) => ({ taskId: m[1] }),
    },
    {
        kind: "final-failed",
        // older wakes name neither the commit nor the total
        re: /^the final stage failed on the merged result(?: ([0-9a-f]{7,40}))? in round (\d+)(?: of (\d+))?(, the last)?\./,
        read: (m) => ({ sha: m[1], round: num(m[2]), of: num(m[3]), last: m[4] != null }),
    },
    {
        kind: "final-killed",
        re: /^a step of the final stage was killed from outside in round (\d+)/,
        read: (m) => ({ round: num(m[1]) }),
    },
    { kind: "run-finished", re: /^run finished\b/, read: () => ({}) },
    {
        kind: "questions",
        re: /^(\d+) questions? waiting/,
        read: (m) => ({ count: num(m[1]) }),
    },
    {
        kind: "verify-failed",
        re: /^Verify failed after merging task (\S+) \(([^)]*)\)(?:: ([\s\S]*))?$/,
        read: (m) => {
            const fact = nonEmpty(m[3]?.replace(STATUS_CMD, ""));
            return { taskId: m[1], reason: m[2], items: fact ? [fact] : [] };
        },
    },
    {
        kind: "review-failed",
        re: /^review failed for task (\S+?)(?:: ([\s\S]*))?\.\s*wsh jarvis dag status/,
        read: (m) => ({ taskId: m[1], reason: nonEmpty(m[2]) }),
    },
    {
        kind: "review-note",
        re: /^task (\S+) passed review[^:]*: ([\s\S]*)$/,
        read: (m) => ({ taskId: m[1], items: [trimEnd(m[2].replace(STATUS_CMD, ""))] }),
    },
    {
        kind: "engine-stuck",
        re: /^the engine is stuck: ([\s\S]*?)\. It will not recover/,
        read: (m) => ({ reason: m[1] }),
    },
    { kind: "autonomous-on", re: /^approvals for this run are now autonomous/, read: () => ({}) },
    { kind: "autonomous-off", re: /^approvals for this run are back to Ask me/, read: () => ({}) },
];

function classifyWakeLine(line: string): WakePart {
    const body = line.slice(WAKE_HEAD.length).trim();
    for (const { kind, re, read } of MATCHERS) {
        const m = re.exec(body);
        if (m) {
            return { kind, text: line, ...read(m) };
        }
    }
    return { kind: "unknown", text: line };
}

// a body line as the engine wrote it, its list bullet or numbering dropped
const bodyLine = (s: string) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();

// a failed final stage's body is the failing command's log: an indented line keeps its indentation and its markers
// ("  -  58" is a skipped test, not a bullet); a line at the margin is the engine's own defect line
const logLine = (s: string) => (/^\s/.test(s) ? s.trimEnd() : bodyLine(s));

// a test runner's failing line: playwright's x/✘, a FAIL/FAILED marker, pytest's E line, a thrown error, the "N
// failed" summary. A server log line that only mentions a failure is not one.
const FAILING_LINE = [
    /^\s*(?:x|✘|✗|×)\s+\d/,
    /^\s*FAIL(?:ED)?\b/,
    /^E\s/,
    /^\s*(?:[A-Z]\w*)?Error:/,
    /^[\s=]*\d+ failed\b/,
];

export function failingLogLine(line: string): boolean {
    return FAILING_LINE.some((re) => re.test(line));
}

// the engine's head over a failed command's log (final.go): "Final `<cmd>` failed (exit 1):"
const COMMAND_FAILED_HEAD = /^(?:Check|Verify|Final) `[^`]*` failed\b/;

// how many defects a failed final stage names: the verifier writes one per line, while a failed command's body is
// its log, whose line count is no defect count, so it has none
export function finalDefectCount(part: WakePart): number | undefined {
    const items = part.items ?? [];
    return items.length > 0 && COMMAND_FAILED_HEAD.test(items[0]) ? undefined : items.length;
}

// a wake split into its lines (composeWake): each `wake:` line is a part, the lines under it its body (a failed final
// stage's defects, the land's holds), and the Unverified and Since-your-last-wake sections parts of their own
export function wakeParts(text: string): WakePart[] {
    const parts: WakePart[] = [];
    for (const full of text.split("\n")) {
        const raw = full.replace(CUT_TAIL, "");
        const line = raw.trim();
        if (line === "") continue;
        if (line.startsWith(WAKE_HEAD)) {
            parts.push(classifyWakeLine(line));
            continue;
        }
        if (line === CAVEATS_HEAD || line === QUIET_HEAD) {
            parts.push({ kind: line === CAVEATS_HEAD ? "caveats" : "quiet", text: line, items: [] });
            continue;
        }
        const cur = parts[parts.length - 1];
        if (cur == null) {
            parts.push({ kind: "unknown", text: line });
            continue;
        }
        if (cur.kind === "unknown") {
            cur.text = `${cur.text}\n${line}`;
            continue;
        }
        cur.items = [...(cur.items ?? []), cur.kind === "final-failed" ? logLine(raw) : bodyLine(line)];
    }
    return parts;
}

// "round 1 of 3": the wake's own total, else a round marked the last is the last one; an older wake names no total
export function finalRoundOf(part: WakePart): { round: number; of?: number } | null {
    if (part.round == null) return null;
    const of = part.of ?? (part.last ? part.round : undefined);
    return of != null ? { round: part.round, of } : { round: part.round };
}

// what the run's events say about a wake, within the gap before it: the question a worker raised, the Final verdict a
// finished run ended on, and whether it passed
export interface WakeEvents {
    ask?: { taskId: string; question?: string; deadlineMs: number };
    finalPassed?: { round?: number };
}

const eventsBefore = (events: RunEvent[], ts: number) => events.filter((e) => e.ts <= ts).sort((a, b) => b.ts - a.ts);

export function wakeEvents(part: WakePart, events: RunEvent[], ts: number | undefined): WakeEvents {
    if (ts == null) return {};
    const before = eventsBefore(events, ts);
    if (part.kind === "questions") {
        const ask = before.find((e) => e.kind === "child-ask");
        const d = ask ? detailOf<{ taskid?: string; question?: string }>(ask) : undefined;
        if (ask && d?.taskid) {
            return { ask: { taskId: d.taskid, question: d.question, deadlineMs: ask.ts + LEAD_ASK_DEADLINE_MS - ts } };
        }
    }
    if (part.kind === "run-finished") {
        const ended = before.find((e) => e.kind === "final-ended");
        const d = ended ? detailOf<{ outcome?: string; round?: number }>(ended) : undefined;
        if (d?.outcome === "passed") {
            return { finalPassed: { round: d.round } };
        }
    }
    return {};
}

// the run's events between two times, oldest first
export function eventsInGap(events: RunEvent[], from: number, to: number): RunEvent[] {
    return events.filter((e) => e.ts > from && e.ts <= to).sort((a, b) => a.ts - b.ts);
}

export interface WaitedSummary {
    gapMs: number;
    landed: number;
    failed: number;
    finalRuns: number;
    events: RunEvent[];
}

// the Waited fold before a lead's wake: only in a lead's transcript, only for a gap of WAIT_FOLD_MIN_MS or more, and
// summarised from the run's events in the gap
export function waitedSummary(
    role: RunRole | undefined,
    ts: number | undefined,
    idleMs: number | undefined,
    events: RunEvent[]
): WaitedSummary | null {
    if (role?.kind !== "lead" || ts == null || idleMs == null || idleMs < WAIT_FOLD_MIN_MS) {
        return null;
    }
    const inGap = eventsInGap(events, ts - idleMs, ts);
    const count = (kind: string) => inGap.filter((e) => e.kind === kind).length;
    return {
        gapMs: idleMs,
        landed: count("task-merged"),
        failed: count("task-failed"),
        finalRuns: count("final-ended"),
        events: inGap,
    };
}

// a plan review that passed in the gap before a lead's wake: not a wake text, so only its event says it (decision on
// Task 12). tasks counts the workers spawned after it, before the wake
export function planPassedInGap(
    role: RunRole | undefined,
    ts: number | undefined,
    idleMs: number | undefined,
    events: RunEvent[]
): { round?: number; tasks: number } | null {
    if (role?.kind !== "lead" || ts == null || idleMs == null) return null;
    const inGap = eventsInGap(events, ts - idleMs, ts);
    const passed = [...inGap].reverse().find((e) => {
        const state = detailOf<{ state?: string }>(e)?.state;
        return e.kind === "plan-reviewed" && (state === "passed" || state === "accepted");
    });
    if (passed == null) return null;
    const spawned = new Set(
        inGap
            .filter((e) => e.kind === "task-spawned" && e.ts >= passed.ts)
            .map((e) => detailOf<{ taskid?: string }>(e)?.taskid)
            .filter(Boolean)
    );
    return { round: detailOf<{ round?: number }>(passed)?.round, tasks: spawned.size };
}

// "38m", "1h 05m": a lead's wait is minutes to hours, so seconds would be noise
export function fmtGap(ms: number): string {
    const m = Math.floor(ms / 60_000);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// --- briefs

// the run as a brief shows it: the goal, how it plans and approves, and its tasks
export interface BriefRun {
    goal?: string;
    planSkill?: string;
    autonomous?: boolean;
    tasks: { id: string; label?: string; state?: string }[];
}

export type BriefView =
    | { role: "lead"; goal: string; planSkill?: string; autonomous: boolean }
    | { role: "worker"; taskId: string; label?: string }
    | { role: "stage"; stageRole: string };

const firstLine = (s: string) =>
    s
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l !== "") ?? "";

// a lead's brief names the run's goal (its own text's first line until the run loads), a worker's its task, a stage
// agent's its stage
export function briefView(role: RunRole, text: string, run?: BriefRun): BriefView {
    switch (role.kind) {
        case "lead":
            return {
                role: "lead",
                goal: firstLine(run?.goal ?? "") || firstLine(text),
                planSkill: run?.planSkill || undefined,
                autonomous: run?.autonomous === true,
            };
        case "worker": {
            const label = run?.tasks.find((t) => t.id === role.taskId)?.label;
            return label ? { role: "worker", taskId: role.taskId, label } : { role: "worker", taskId: role.taskId };
        }
        case "stage":
            return { role: "stage", stageRole: role.stageRole };
    }
}

// a finished run's tasks: how many landed of how many
export function landedCount(run: BriefRun | undefined): { landed: number; total: number } | null {
    if (run == null || run.tasks.length === 0) return null;
    return { landed: run.tasks.filter((t) => t.state === "done").length, total: run.tasks.length };
}

// --- brainstorm lines

export type PaneActionKind =
    | "confirm-all"
    | "keep-all"
    | "guess"
    | "skip"
    | "check"
    | "approved"
    | "keep-talking"
    | "settle"
    | "edit"
    | "builder-answer"
    | "builder-decide"
    | "run";

export interface PaneAction {
    kind: PaneActionKind;
    count?: number;
    part?: string;
    text?: string;
}

export type BrainstormLineView =
    | { kind: "judged"; path: string }
    | { kind: "judge-failed"; reason: string }
    | { kind: "builder"; path: string }
    | { kind: "pane"; actions: PaneAction[] }
    | { kind: "unknown"; text: string };

// pkg/brainstormcheck's line heads, after "brainstorm: "
const JUDGED = "judged ";
const JUDGE_FAILED = "judge failed: ";
const BUILDER_QUESTIONS = "builder questions ";
// sendLine joins the picks' settle line to the line sent with it
const THEN = "; then: ";

const FIXED_ACTIONS: Record<string, PaneActionKind> = {
    "confirm every guess": "confirm-all",
    "keep every change": "keep-all",
    guess: "guess",
    "skip questions": "skip",
    check: "check",
    approved: "approved",
    "keep talking": "keep-talking",
    "builder decide": "builder-decide",
};

function paneAction(body: string): PaneAction | null {
    const fixed = FIXED_ACTIONS[body];
    if (fixed) return { kind: fixed };
    if (body.startsWith("settle ")) {
        const parts = body
            .slice("settle ".length)
            .split(";")
            .flatMap((group) => group.trim().split(/\s+/).slice(1).join(" ").split(","))
            .map((p) => p.trim())
            .filter(Boolean);
        return { kind: "settle", count: parts.length, text: body.slice("settle ".length) };
    }
    const edit = /^edit ([^:\s]+): ([\s\S]+)$/.exec(body);
    if (edit) return { kind: "edit", part: edit[1], text: edit[2] };
    if (body.startsWith("builder answer: "))
        return { kind: "builder-answer", text: body.slice("builder answer: ".length) };
    const run = /^run (\S+)$/.exec(body);
    if (run) return { kind: "run", text: run[1] };
    return null;
}

const bodyOf = (line: string) => line.slice(BRAINSTORM_HEAD.length).trim();

export function brainstormLineView(text: string): BrainstormLineView {
    const body = bodyOf(text);
    if (body.startsWith(JUDGED)) return { kind: "judged", path: body.slice(JUDGED.length).trim() };
    if (body.startsWith(JUDGE_FAILED)) return { kind: "judge-failed", reason: body.slice(JUDGE_FAILED.length).trim() };
    if (body.startsWith(BUILDER_QUESTIONS))
        return { kind: "builder", path: body.slice(BUILDER_QUESTIONS.length).trim() };
    const actions: PaneAction[] = [];
    for (const piece of text.split(THEN)) {
        const a = piece.trim().startsWith(BRAINSTORM_HEAD) ? paneAction(bodyOf(piece.trim())) : null;
        if (a == null) return { kind: "unknown", text };
        actions.push(a);
    }
    return { kind: "pane", actions };
}

// the judge's result on the question it weighed, as the brainstorm file records it: the open question when it carries
// the record, else the latest answered one that does
export interface JudgeResult {
    n?: number;
    pick?: string;
    kept: { name: string; detail?: string; pick: boolean }[];
    dropped: { name: string; reason: string }[];
}

export function judgeResultOf(f: BrainstormFile): JudgeResult | null {
    const q = f.question?.judge?.kind === "weighed" ? f.question : null;
    const h = q ? null : [...f.history].reverse().find((e) => e.judge?.kind === "weighed");
    const judge = q?.judge ?? h?.judge;
    if (judge?.kind !== "weighed") return null;
    const options = q?.options ?? h?.options ?? [];
    const pickIndex = h?.picked ?? options.findIndex((o) => o.pick);
    const kept = options.map((o, i) => ({ name: o.label, detail: o.detail || undefined, pick: i === pickIndex }));
    return { n: q?.n ?? h?.n, pick: kept.find((k) => k.pick)?.name, kept, dropped: judge.dropped };
}

// the builder check's questions as the file records them: answered from the design already, minor ones the agent
// calls itself, and the ones for the user
export function builderCountsOf(
    f: BrainstormFile
): { answered: number; calls: number; yours: number; total: number } | null {
    if (f.check == null) return null;
    const answered = f.check.answered.length;
    const calls = f.check.calls.length;
    const yours = f.check.yours.length;
    return { answered, calls, yours, total: answered + calls + yours };
}

// a judged line names judge.json beside the brainstorm file (JudgeResultPath)
export function brainstormFileFor(judgePath: string, ctxFile?: string): string {
    if (ctxFile) return ctxFile;
    return judgePath.replace(/[^\\/]+$/, "brainstorm.json");
}
