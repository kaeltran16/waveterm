// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: everything the brainstorm pane, tree, popup, roster and approve flow derive from the agent's
// brainstorm.json. The agent writes the file; Arc only reads it and types one line back.

import type { NewRunPrefill } from "@/app/view/jarvis/newrun";
import type { AgentVM } from "./agentsviewmodel";
import { canvasDir, canvasProjectDir, join } from "./canvasmodel";

export const BRAINSTORM_POLL_MS = 3000;
export const BUILDER_PART = "builder";

const FILE_VERSION = 1;
const RUN_ID_CHARS = 8;
const PART_STATES = ["yours", "guess", "asked", "open"] as const;

export type PartState = (typeof PART_STATES)[number];
export type BrainstormPart = {
    id: string;
    title: string;
    state: PartState;
    from?: string;
    body: string;
    boards?: string[];
    was?: string;
    why?: string;
};
export type BrainstormQuestion = { n: number; text: string; part: string };
export type HistoryEntry = { kind: "question" | "recon"; n?: number; q: string; a: string; into: string[] };
export type BuilderQuestion = { q: string; why?: string; a?: string; into?: string };
export type BuilderCall = { text: string; part?: string };
export type BuilderCheck = { yours: BuilderQuestion[]; calls: BuilderCall[]; answered: string[]; touched?: string[] };
export type BrainstormFile = {
    v: 1;
    title: string;
    spec: string;
    canvas?: string;
    question: BrainstormQuestion | null;
    working: string | null;
    parts: BrainstormPart[];
    history: HistoryEntry[];
    done: boolean;
    check: BuilderCheck | null;
    run: string | null;
    compacted?: number;
};
export type ParseResult = { ok: true; file: BrainstormFile } | { ok: false; error: string };

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
    return v != null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
    return typeof v === "string" ? v : undefined;
}

function strings(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

class FieldError extends Error {}

function parsePart(raw: unknown, i: number): BrainstormPart {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "") {
        throw new FieldError(`parts[${i}] has no id`);
    }
    const id = raw.id;
    if (!PART_STATES.includes(raw.state as PartState)) {
        throw new FieldError(`part "${id}" has an unknown state "${String(raw.state)}"`);
    }
    const boards = strings(raw.boards);
    return {
        id,
        title: str(raw.title) ?? id,
        state: raw.state as PartState,
        body: str(raw.body) ?? "",
        ...(str(raw.from) != null ? { from: str(raw.from) } : {}),
        ...(boards.length > 0 ? { boards } : {}),
        ...(str(raw.was) != null ? { was: str(raw.was) } : {}),
        ...(str(raw.why) != null ? { why: str(raw.why) } : {}),
    };
}

function parseQuestion(raw: unknown): BrainstormQuestion | null {
    if (raw == null) {
        return null;
    }
    if (!isRecord(raw) || typeof raw.n !== "number" || typeof raw.text !== "string") {
        throw new FieldError("question needs a numeric n and a text");
    }
    return { n: raw.n, text: raw.text, part: str(raw.part) ?? "" };
}

function parseHistory(raw: unknown): HistoryEntry[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter(isRecord).map((h) => ({
        kind: h.kind === "recon" ? "recon" : "question",
        ...(typeof h.n === "number" ? { n: h.n } : {}),
        q: str(h.q) ?? "",
        a: str(h.a) ?? "",
        into: strings(h.into),
    }));
}

function parseCheck(raw: unknown): BuilderCheck | null {
    if (raw == null) {
        return null;
    }
    if (!isRecord(raw)) {
        throw new FieldError("check must be an object");
    }
    const yours = (Array.isArray(raw.yours) ? raw.yours : []).filter(isRecord).map(
        (y): BuilderQuestion => ({
            q: str(y.q) ?? "",
            ...(str(y.why) != null ? { why: str(y.why) } : {}),
            ...(str(y.a) != null ? { a: str(y.a) } : {}),
            ...(str(y.into) != null ? { into: str(y.into) } : {}),
        })
    );
    const calls: BuilderCall[] = [];
    for (const c of Array.isArray(raw.calls) ? raw.calls : []) {
        if (typeof c === "string") {
            calls.push({ text: c });
        } else if (isRecord(c) && typeof c.text === "string") {
            calls.push({ text: c.text, ...(str(c.part) != null ? { part: str(c.part) } : {}) });
        }
    }
    return {
        yours,
        calls,
        answered: strings(raw.answered),
        ...(Array.isArray(raw.touched) ? { touched: strings(raw.touched) } : {}),
    };
}

function buildFile(j: Rec): BrainstormFile {
    if (j.v !== FILE_VERSION) {
        throw new FieldError(
            `unsupported brainstorm.json version ${String(j.v)}; this Arc reads version ${FILE_VERSION}`
        );
    }
    if (typeof j.title !== "string") {
        throw new FieldError("brainstorm.json has no title");
    }
    if (!Array.isArray(j.parts)) {
        throw new FieldError("brainstorm.json has no parts array");
    }
    const parts = j.parts.map(parsePart);
    const seen = new Set<string>();
    for (const p of parts) {
        if (seen.has(p.id)) {
            throw new FieldError(`duplicate part id "${p.id}"`);
        }
        seen.add(p.id);
    }
    return {
        v: FILE_VERSION,
        title: j.title,
        spec: str(j.spec) ?? "",
        ...(str(j.canvas) ? { canvas: str(j.canvas) } : {}),
        question: parseQuestion(j.question),
        working: str(j.working) ?? null,
        parts,
        history: parseHistory(j.history),
        done: j.done === true,
        check: parseCheck(j.check),
        run: str(j.run) ?? null,
        ...(typeof j.compacted === "number" ? { compacted: j.compacted } : {}),
    };
}

export function parseBrainstorm(text: string): ParseResult {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (e) {
        return { ok: false, error: `brainstorm.json is not valid JSON: ${(e as Error).message}` };
    }
    if (!isRecord(json)) {
        return { ok: false, error: "brainstorm.json is not a JSON object" };
    }
    try {
        return { ok: true, file: buildFile(json) };
    } catch (e) {
        if (e instanceof FieldError) {
            return { ok: false, error: e.message };
        }
        throw e;
    }
}

export function brainstormFilePath(cwd: string, topic: string): string {
    return join(cwd, ".superpowers", "brainstorm", topic, "brainstorm.json");
}

const BRAINSTORM_PATH = /^(.+?)[\\/]\.superpowers[\\/]brainstorm[\\/]([^\\/]+)[\\/]brainstorm\.json$/i;

export function parseBrainstormPath(path: string): { cwd: string; topic: string } | null {
    const m = BRAINSTORM_PATH.exec(path);
    return m ? { cwd: m[1], topic: m[2] } : null;
}

export function brainstormCounts(f: BrainstormFile): { yours: number; guesses: number; open: number } {
    const n = (...states: PartState[]) => f.parts.filter((p) => states.includes(p.state)).length;
    return { yours: n("yours"), guesses: n("guess"), open: n("asked", "open") };
}

// a question still open (one about no part can come after done) waits for its answer first
export function canCheck(f: BrainstormFile): boolean {
    return f.done && f.question == null && f.parts.length > 0 && f.parts.every((p) => p.state === "yours");
}

// a line Arc sent, which the agent has not answered yet: modifiedMs is the file's when it was sent
export type SentLine = { at: number; modifiedMs: number | null; answer: boolean };

const PENDING_ANSWER = "Writing up your answer.";
const PENDING_LINE = "Taking in your change.";

// the agent has taken a sent line once its turn ends after the send, or its file changed while it is not at work.
// A write mid-turn settles nothing: a line sent before that turn ends would join it, not start the next
export function settleSent(
    sent: SentLine | null,
    modifiedMs: number | null,
    agent: Pick<AgentVM, "state" | "idleSince"> | undefined
): SentLine | null {
    if (sent == null) {
        return null;
    }
    const turnEnded = agent?.state === "idle" && agent.idleSince != null && agent.idleSince > sent.at;
    const written = modifiedMs !== sent.modifiedMs;
    return turnEnded || (written && agent?.state !== "working") ? null : sent;
}

// the file as Arc shows it: the agent writes once per turn, so while a sent line is pending Arc says the agent is
// writing, as a `working` the file sets itself would
export function shownFile(f: BrainstormFile, sent: SentLine | null): BrainstormFile {
    if (sent == null || f.working != null) {
        return f;
    }
    return sent.answer ? { ...f, working: PENDING_ANSWER, question: null } : { ...f, working: PENDING_LINE };
}

export function isAsking(f: BrainstormFile): boolean {
    return f.question != null && f.working == null;
}

export function asksUser(f: BrainstormFile | null, agent: Pick<AgentVM, "state" | "atPrompt">): boolean {
    return f != null && isAsking(f) && (agent.state === "idle" || agent.atPrompt === true);
}

// the file knows a question the agent's own status does not: its turn ended on a prose question
export function withBrainstorm(agent: AgentVM, f: BrainstormFile | null, now: number): AgentVM {
    if (!asksUser(f, agent)) {
        return agent;
    }
    return {
        ...agent,
        state: "asking",
        activeMs: undefined,
        blockedMs: agent.idleSince != null ? Math.max(0, now - agent.idleSince) : agent.blockedMs,
    };
}

export type TreeLine = { lead: "Brainstorm" | "Brainstorm done"; text: string; runId?: string };

export function treeLine(f: BrainstormFile, asking: boolean): TreeLine {
    if (f.run != null) {
        return { lead: "Brainstorm done", text: `run ${f.run.slice(0, RUN_ID_CHARS)}`, runId: f.run };
    }
    if (asking) {
        return { lead: "Brainstorm", text: `asking question ${f.question?.n ?? ""}`.trim() };
    }
    if (f.check != null) {
        return { lead: "Brainstorm", text: "builder check" };
    }
    if (f.working != null) {
        return { lead: "Brainstorm", text: "writing up your answer" };
    }
    return { lead: "Brainstorm", text: "in progress" };
}

export type BrainstormAction =
    | { kind: "answer"; text: string }
    | { kind: "guess" }
    | { kind: "skip" }
    | { kind: "confirm"; part: string }
    | { kind: "confirm-all" }
    | { kind: "edit"; part: string; text: string }
    | { kind: "keep"; part: string }
    | { kind: "restore"; part: string }
    | { kind: "check" }
    | { kind: "builder-answer"; text: string }
    | { kind: "approved" }
    | { kind: "keep-talking" }
    | { kind: "run"; runId: string };

// a typed line is one line: every run of whitespace, newlines included, becomes one space
function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

export function brainstormLine(a: BrainstormAction): string | null {
    switch (a.kind) {
        case "answer":
            return oneLine(a.text) || null;
        case "edit": {
            const t = oneLine(a.text);
            return t ? `brainstorm: edit ${a.part}: ${t}` : null;
        }
        case "builder-answer": {
            const t = oneLine(a.text);
            return t ? `brainstorm: builder answer: ${t}` : null;
        }
        case "guess":
            return "brainstorm: guess";
        case "skip":
            return "brainstorm: skip questions";
        case "confirm":
            return `brainstorm: confirm ${a.part}`;
        case "confirm-all":
            return "brainstorm: confirm every guess";
        case "keep":
            return `brainstorm: keep ${a.part}`;
        case "restore":
            return `brainstorm: restore ${a.part}`;
        case "check":
            return "brainstorm: check";
        case "approved":
            return "brainstorm: approved";
        case "keep-talking":
            return "brainstorm: keep talking";
        case "run":
            return `brainstorm: run ${a.runId}`;
    }
}

// a part id the file names but does not define shows as the raw id
export function partTitle(f: BrainstormFile, id: string): string {
    return f.parts.find((p) => p.id === id)?.title ?? id;
}

export type HistoryRow = { label: string; q: string; a: string; into: { id: string; title: string }[] };

export function historyRows(f: BrainstormFile): HistoryRow[] {
    return f.history
        .map((h, i) => ({
            label: h.kind === "recon" ? "Recon" : `Q${h.n ?? i + 1}`,
            q: h.q,
            a: h.a,
            into: h.into.map((id) => ({ id, title: partTitle(f, id) })),
        }))
        .reverse();
}

export function orderedParts(f: BrainstormFile): BrainstormPart[] {
    return [...f.parts.filter((p) => p.id !== BUILDER_PART), ...f.parts.filter((p) => p.id === BUILDER_PART)];
}

// how a part draws: a guess that was yours reads as changed, an asked part the agent is writing up as writing
export type PartView = "yours" | "guess" | "changed" | "asked" | "writing" | "open";

export function partView(f: BrainstormFile, p: BrainstormPart): PartView {
    if (p.state === "guess") {
        return p.was != null ? "changed" : "guess";
    }
    if (p.state === "asked" && f.working != null && f.question == null) {
        return "writing";
    }
    return p.state;
}

export type Phase = "talk" | "check" | "run";
export type PhaseStep = { phase: Phase; label: string; status: "done" | "current" | "todo" };

const PHASES: { phase: Phase; label: string }[] = [
    { phase: "talk", label: "Talking it through" },
    { phase: "check", label: "Builder check" },
    { phase: "run", label: "Run" },
];

export function brainstormPhase(f: BrainstormFile): Phase {
    if (f.run != null) {
        return "run";
    }
    return f.check != null ? "check" : "talk";
}

export function phaseSteps(f: BrainstormFile): PhaseStep[] {
    const at = PHASES.findIndex((p) => p.phase === brainstormPhase(f));
    return PHASES.map((p, i) => ({ ...p, status: i < at ? "done" : i === at ? "current" : "todo" }));
}

export type ProgressView = {
    segments: { id: string; title: string; state: PartState }[];
    lead: string;
    rest: string;
};

// one segment per part, in the order the design draws them; the label reads per phase
export function progressView(f: BrainstormFile): ProgressView {
    const parts = orderedParts(f);
    const { yours, open } = brainstormCounts(f);
    const segments = parts.map((p) => ({ id: p.id, title: p.title, state: p.state }));
    if (brainstormPhase(f) === "talk") {
        return { segments, lead: `${yours} of ${parts.length}`, rest: "parts yours" };
    }
    return { segments, lead: `${yours} yours`, rest: open === 0 ? "· nothing open" : `· ${open} open` };
}

export type LeftKind = "answer" | "confirm" | "review" | "last" | "talk";
export type LeftRow = { id: string; title: string; kind: LeftKind; text: string };

function leftRow(f: BrainstormFile, p: BrainstormPart): LeftRow | null {
    const row = (kind: LeftKind, text: string): LeftRow => ({ id: p.id, title: p.title, kind, text });
    switch (partView(f, p)) {
        case "yours":
            return null;
        case "asked":
        case "writing":
            return row("answer", f.question?.part === p.id ? `Answer question ${f.question.n}` : "Answer its question");
        case "guess":
            return row("confirm", "Confirm the agent’s guess");
        case "changed":
            return row("review", "Review what changed");
        case "open":
            return p.id === BUILDER_PART
                ? row("last", "The agent writes this last")
                : row("talk", "Not talked through yet");
    }
}

// what stands between the design and the builder check: every part not yet yours, the asked one first
export function whatsLeft(f: BrainstormFile): LeftRow[] {
    const rows = orderedParts(f)
        .map((p) => leftRow(f, p))
        .filter((r): r is LeftRow => r != null);
    return [...rows.filter((r) => r.kind === "answer"), ...rows.filter((r) => r.kind !== "answer")];
}

// the guesses one press confirms: a changed part is left out, since it asks keep or restore
export function confirmableGuesses(f: BrainstormFile): number {
    return f.parts.filter((p) => partView(f, p) === "guess").length;
}

// what the left column holds under the question: the builder check once it is ready, else what stands before it.
// nothing while the agent writes, nor beside the first question, when the list would only repeat it
export function leftPanel(f: BrainstormFile): "ready" | "left" | "none" {
    if (f.working != null) {
        return "none";
    }
    if (canCheck(f)) {
        return "ready";
    }
    return f.history.length === 0 && f.question != null ? "none" : "left";
}

export type SentenceDiff = { kind: "same" | "added" | "removed"; text: string }[];

function sentences(text: string): string[] {
    return text.split(/(?<=[.!?])\s+/).filter((s) => s !== "");
}

export function sentenceDiff(was: string, now: string): SentenceDiff {
    const a = sentences(was);
    const b = sentences(now);
    // lcs[i][j]: the longest common run of a[i..] and b[j..]
    const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const out: SentenceDiff = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            out.push({ kind: "same", text: a[i] });
            i++;
            j++;
        } else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
            out.push({ kind: "removed", text: a[i++] });
        } else {
            out.push({ kind: "added", text: b[j++] });
        }
    }
    return out;
}

export type HandoffView = {
    questions: number;
    open: BuilderQuestion | null;
    answered: BuilderQuestion[];
    calls: BuilderCall[];
    callsByPart: Record<string, string[]>;
    touched: BrainstormPart[];
    untouched: BrainstormPart[];
    // the check's three tiles: the builder's questions for you, the calls the agent made, those already answered
    forYou: number;
    already: number;
};

export function handoffView(f: BrainstormFile): HandoffView {
    const check = f.check ?? { yours: [], calls: [], answered: [] };
    const callsByPart: Record<string, string[]> = {};
    for (const c of check.calls) {
        if (c.part != null) {
            (callsByPart[c.part] ??= []).push(c.text);
        }
    }
    const parts = orderedParts(f);
    const touchedIds = check.touched != null ? new Set(check.touched) : null;
    const isTouched = (p: BrainstormPart) => touchedIds == null || touchedIds.has(p.id);
    const open = check.yours.find((y) => y.a == null) ?? null;
    return {
        questions: check.yours.length + check.calls.length + check.answered.length,
        open,
        answered: check.yours.filter((y) => y.a != null),
        calls: check.calls,
        callsByPart,
        touched: parts.filter(isTouched),
        untouched: parts.filter((p) => !isTouched(p)),
        forYou: check.yours.length,
        already: check.answered.length,
    };
}

function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

// why Approve is off, said in words beside it; null when it is on
export function approveBlocker(f: BrainstormFile): string | null {
    if (f.run != null) {
        return null;
    }
    if (f.working != null) {
        return "The agent is writing; this opens when it is done";
    }
    return handoffView(f).open != null ? "Answer the builder’s question first" : null;
}

export function compactedSummary(f: BrainstormFile): string {
    const c = brainstormCounts(f);
    return `The agent compacted its context and re-read its brainstorm file: ${plural(c.yours, "part", "parts")} yours, ${plural(c.guesses, "guess", "guesses")}, ${c.open} open. Nothing was lost.`;
}

export function exitedSummary(f: BrainstormFile): string {
    const c = brainstormCounts(f);
    const saved = `The brainstorm is saved: ${plural(c.yours, "part", "parts")} yours, ${plural(c.guesses, "guess", "guesses")}`;
    if (f.question != null) {
        return `${saved}, and question ${f.question.n} still unanswered. A new agent reads it and carries on from that question.`;
    }
    return `${saved}. A new agent reads it and carries on.`;
}

export function resumePrompt(path: string): string {
    return `Resume the brainstorm in ${path} with arc:brainstorm.`;
}

const ABSOLUTE_PATH = /^([a-zA-Z]:[\\/]|[\\/])/;

function absoluteSpec(spec: string, cwd: string): string {
    if (ABSOLUTE_PATH.test(spec)) {
        return spec;
    }
    const sep = cwd.includes("\\") ? "\\" : "/";
    return join(cwd, ...spec.split(/[\\/]+/).filter(Boolean)).replace(/[\\/]/g, sep);
}

// the first board any part lists: a brainstorm's canvas need not have a Main board
function firstBoard(f: BrainstormFile): string | undefined {
    return f.parts.find((p) => p.boards != null && p.boards.length > 0)?.boards?.[0];
}

export function runPrefill(f: BrainstormFile, a: { projectName: string; cwd: string }): NewRunPrefill {
    const board = firstBoard(f);
    const prototype = f.canvas && board ? join(canvasProjectDir(canvasDir(a.cwd, f.canvas)), board) : undefined;
    const goal = f.spec ? `Build ${f.title} as specified in ${absoluteSpec(f.spec, a.cwd)}.` : `Build ${f.title}.`;
    return { projectName: a.projectName, shape: "orchestrator", goal, ...(prototype != null ? { prototype } : {}) };
}

export function runLine(projectName: string): string {
    return `${projectName} · orchestrator · this design attached`;
}

// made in the frontend and fed only to the taskbar flash and the desktop popup; the server has no such item
export function brainstormAttention(
    a: { agentId: string; agentName: string; topic: string },
    f: BrainstormFile
): AttentionItem {
    const q = f.question ?? { n: 0, text: "", part: "" };
    return {
        kind: "brainstorm",
        key: `brainstorm:${a.agentId}:${q.n}`,
        source: a.agentName,
        text: q.text,
        // a question outside the design (a choice the agent needs to go on) is for no part
        reason: q.part ? `For “${partTitle(f, q.part)}” · question ${q.n}` : `Question ${q.n}`,
        action: "brainstorm",
        oref: `brainstorm:${a.topic}`,
        phaseidx: 0,
        waitingsince: 0,
    };
}

export type PaneView = "error" | "removed" | "exited" | "check" | "board" | "design";

export function paneView(s: {
    file: BrainstormFile | null;
    error: string | null;
    removed: boolean;
    exited: boolean;
    showDesign: boolean;
    board: string | null;
}): PaneView {
    if (s.removed) {
        return "removed";
    }
    if (s.error != null && s.file == null) {
        return "error";
    }
    if (s.exited && !s.showDesign && s.file?.run == null) {
        return "exited";
    }
    if (s.board != null) {
        return "board";
    }
    return s.file?.check != null ? "check" : "design";
}
