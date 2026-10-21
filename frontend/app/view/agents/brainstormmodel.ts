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
// a note is background the decisions stand on (recon, research, a trade-off write-up): nothing to confirm, so every
// count, gate and confirm leaves it out, whatever state it carries
export type BrainstormPart = {
    id: string;
    title: string;
    state: PartState;
    kind?: "note";
    from?: string;
    gist?: string;
    body: string;
    boards?: string[];
    was?: string;
    why?: string;
};
// an answer the agent offers; pick marks the one it recommends, pros and cons are its reasons for and against
export type AnswerOption = { label: string; detail: string; pick?: boolean; pros?: string[]; cons?: string[] };
// read is the agent's one-line comparison of the options
export type BrainstormQuestion = {
    n: number;
    text: string;
    part: string;
    why?: string;
    read?: string;
    options?: AnswerOption[];
};
// picked is the option's index, absent when the answer was typed in the user's own words
export type HistoryEntry = {
    kind: "question" | "recon";
    n?: number;
    q: string;
    // why the question was asked, kept so the rail can show it again
    why?: string;
    a: string;
    into: string[];
    options?: AnswerOption[];
    picked?: number;
};
// a question the builder check left for the user. into is every decision its answer changed; label is the rail's
// short line for it, the full q when absent
export type BuilderQuestion = {
    q: string;
    label?: string;
    why?: string;
    a?: string;
    into?: string[];
    part?: string;
    options?: AnswerOption[];
};
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

function lines(v: unknown): string[] {
    return strings(v).filter((s) => s.trim() !== "");
}

class FieldError extends Error {}

function parsePart(raw: unknown, i: number): BrainstormPart {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "") {
        throw new FieldError(`parts[${i}] has no id`);
    }
    const id = raw.id;
    const note = raw.kind === "note";
    const known = PART_STATES.includes(raw.state as PartState);
    if (!note && !known) {
        throw new FieldError(`part "${id}" has an unknown state "${String(raw.state)}"`);
    }
    const boards = strings(raw.boards);
    return {
        id,
        title: str(raw.title) ?? id,
        state: known ? (raw.state as PartState) : "yours",
        ...(note ? { kind: "note" as const } : {}),
        body: str(raw.body) ?? "",
        ...(str(raw.from) != null ? { from: str(raw.from) } : {}),
        ...(str(raw.gist) ? { gist: str(raw.gist) } : {}),
        ...(boards.length > 0 ? { boards } : {}),
        ...(str(raw.was) != null ? { was: str(raw.was) } : {}),
        ...(str(raw.why) != null ? { why: str(raw.why) } : {}),
    };
}

// an option with no label is dropped, not an error: the question still reads with the rest and the answer box
function parseOptions(raw: unknown): AnswerOption[] {
    return (Array.isArray(raw) ? raw : [])
        .filter((o): o is Rec => isRecord(o) && typeof o.label === "string" && o.label.trim() !== "")
        .map((o) => {
            const pros = lines(o.pros);
            const cons = lines(o.cons);
            return {
                label: o.label as string,
                detail: str(o.detail) ?? "",
                ...(o.pick === true ? { pick: true } : {}),
                ...(pros.length > 0 ? { pros } : {}),
                ...(cons.length > 0 ? { cons } : {}),
            };
        });
}

function parseQuestion(raw: unknown): BrainstormQuestion | null {
    if (raw == null) {
        return null;
    }
    if (!isRecord(raw) || typeof raw.n !== "number" || typeof raw.text !== "string") {
        throw new FieldError("question needs a numeric n and a text");
    }
    const options = parseOptions(raw.options);
    return {
        n: raw.n,
        text: raw.text,
        part: str(raw.part) ?? "",
        ...(str(raw.why) ? { why: str(raw.why) } : {}),
        ...(str(raw.read) ? { read: str(raw.read) } : {}),
        ...(options.length > 0 ? { options } : {}),
    };
}

function parseHistory(raw: unknown): HistoryEntry[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter(isRecord).map((h) => {
        const options = parseOptions(h.options);
        // an index past the options it names reads as an answer in the user's own words
        const picked = Number.isInteger(h.picked) && (h.picked as number) >= 0 && (h.picked as number) < options.length;
        return {
            kind: h.kind === "recon" ? "recon" : "question",
            ...(typeof h.n === "number" ? { n: h.n } : {}),
            q: str(h.q) ?? "",
            ...(str(h.why) ? { why: str(h.why) } : {}),
            a: str(h.a) ?? "",
            into: strings(h.into),
            ...(options.length > 0 ? { options } : {}),
            ...(picked ? { picked: h.picked as number } : {}),
        };
    });
}

function parseCheck(raw: unknown): BuilderCheck | null {
    if (raw == null) {
        return null;
    }
    if (!isRecord(raw)) {
        throw new FieldError("check must be an object");
    }
    const yours = (Array.isArray(raw.yours) ? raw.yours : []).filter(isRecord).map((y): BuilderQuestion => {
        // a file written before into became a list names its one part as a string
        const into = lines(typeof y.into === "string" ? [y.into] : y.into);
        const options = parseOptions(y.options);
        return {
            q: str(y.q) ?? "",
            ...(str(y.label) ? { label: str(y.label) } : {}),
            ...(str(y.why) != null ? { why: str(y.why) } : {}),
            ...(str(y.a) != null ? { a: str(y.a) } : {}),
            ...(into.length > 0 ? { into } : {}),
            ...(str(y.part) ? { part: str(y.part) } : {}),
            ...(options.length > 0 ? { options } : {}),
        };
    });
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

export function isNote(p: BrainstormPart): boolean {
    return p.kind === "note";
}

export function brainstormCounts(f: BrainstormFile): { yours: number; guesses: number; open: number } {
    const n = (...states: PartState[]) => decisionParts(f).filter((p) => states.includes(p.state)).length;
    return { yours: n("yours"), guesses: n("guess"), open: n("asked", "open") };
}

// a question still open (one about no part can come after done) waits for its answer first
export function canCheck(f: BrainstormFile): boolean {
    const parts = decisionParts(f);
    return f.done && f.question == null && parts.length > 0 && parts.every((p) => p.state === "yours");
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

// an answer typed in the terminal never passes through Arc: a turn that started after the file last asked is one,
// pending like a sent answer until that turn ends. A turn that wrote the question itself started before the write
export function terminalAnswer(
    f: BrainstormFile,
    modifiedMs: number | null,
    agent: Pick<AgentVM, "state"> | undefined,
    turnStartMs: number | undefined
): SentLine | null {
    if (f.question == null || agent?.state !== "working" || modifiedMs == null || turnStartMs == null) {
        return null;
    }
    return turnStartMs > modifiedMs ? { at: turnStartMs, modifiedMs, answer: true } : null;
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

// run is what Arc knows of the brainstorm's run: done only once it merged, since a started run can still fail
export function treeLine(f: BrainstormFile, asking: boolean, run?: { text: string; merged: boolean }): TreeLine {
    if (f.run != null) {
        return {
            lead: run?.merged ? "Brainstorm done" : "Brainstorm",
            text: run?.text ?? `run ${f.run.slice(0, RUN_ID_CHARS)}`,
            runId: f.run,
        };
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
    | { kind: "builder-decide" }
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
        case "builder-decide":
            return "brainstorm: builder decide";
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

export type HistoryRow = {
    kind: "question" | "recon";
    label: string;
    q: string;
    // every option the question offered, the picked one and the agent's recommendation marked
    options: { label: string; detail: string; picked: boolean; agentPick: boolean }[];
    why: string | null;
    // the reasoning toggle has something to show: why it was asked, or an option not picked that says what it is
    reasons: boolean;
    // the answer as said, drawn after the options; null when it was one of them
    answer: string | null;
    // the question offered options and the user answered in their own words instead
    ownWords: boolean;
    into: { id: string; title: string }[];
};

function historyRow(f: BrainstormFile, h: HistoryEntry, i: number): HistoryRow {
    const options = (h.options ?? []).map((o, j) => ({
        label: o.label,
        detail: o.detail,
        picked: j === h.picked,
        agentPick: o.pick === true,
    }));
    const recon = h.kind === "recon";
    const answer = h.picked != null ? null : (recon ? h.a || h.q : h.a) || null;
    const why = recon ? null : (h.why ?? null);
    return {
        kind: h.kind,
        label: recon ? "Recon" : `Q${h.n ?? i + 1}`,
        q: h.q,
        options,
        why,
        reasons: why != null || options.some((o) => !o.picked && o.detail !== ""),
        answer,
        ownWords: answer != null && options.length > 0,
        into: h.into.map((id) => ({ id, title: partTitle(f, id) })),
    };
}

// what was decided, newest first; recon is the ground every question stood on, so it stays at the bottom
export function historyRows(f: BrainstormFile): HistoryRow[] {
    const rows = f.history.map((h, i) => historyRow(f, h, i)).reverse();
    return [...rows.filter((r) => r.kind === "question"), ...rows.filter((r) => r.kind === "recon")];
}

export const OPTION_KEYS = ["a", "b", "c", "d"] as const;

// the question carries the agent's reasons, which the pane draws under each answer behind one toggle
export function hasProsCons(q: BrainstormQuestion): boolean {
    return (q.options ?? []).some((o) => o.pros != null || o.cons != null);
}

export function optionLetter(i: number): string {
    return String.fromCharCode("A".charCodeAt(0) + i);
}

// what the design view's main area holds: the question, or the agent writing, unless the user opened the design
// over it; with neither, the design itself
export type MainView = "question" | "working" | "design";

export function mainView(f: BrainstormFile, designOpen: boolean): MainView {
    if (designOpen) {
        return "design";
    }
    if (f.working != null) {
        return "working";
    }
    return f.question != null ? "question" : "design";
}

// what the builder check's main area holds. The talk question comes first: the agent waits on it in the terminal, and
// its answer may settle the builder's questions. The design opened over a question is the review
export type CheckMain = "working" | "question" | "builder" | "review";

export function checkMain(f: BrainstormFile, designOpen: boolean): CheckMain {
    if (designOpen) {
        return "review";
    }
    if (f.working != null) {
        return "working";
    }
    if (f.question != null) {
        return "question";
    }
    return openBuilderQuestion(f) != null ? "builder" : "review";
}

function openBuilderQuestion(f: BrainstormFile): BuilderQuestion | null {
    return f.check?.yours.find((y) => y.a == null) ?? null;
}

// how many of the asked question's options a letter key picks: as many as the pane draws, up to the keys there are
export function pickableOptions(
    f: BrainstormFile | null,
    s: { designOpen: boolean; board: string | null; removed: boolean }
): number {
    if (f == null || s.board != null || s.removed) {
        return 0;
    }
    let options: AnswerOption[] | undefined;
    if (f.check != null) {
        const main = checkMain(f, s.designOpen);
        options = main === "question" ? f.question!.options : main === "builder" ? openBuilderQuestion(f)!.options : [];
    } else if (isAsking(f) && mainView(f, s.designOpen) === "question") {
        options = f.question!.options;
    }
    return Math.min(options?.length ?? 0, OPTION_KEYS.length);
}

// the bar over the question: one segment per question answered, the one asked now, and one per part still open,
// each of which a question is still to fill. The builder part is written last without one
export type TrackSegment = "done" | "now" | "ahead";

export function questionTrack(f: BrainstormFile): TrackSegment[] {
    const done = f.history.filter((h) => h.kind === "question").length;
    const ahead = decisionParts(f).filter((p) => p.state === "open" && p.id !== BUILDER_PART).length;
    return [
        ...Array<TrackSegment>(done).fill("done"),
        ...(f.question != null ? (["now"] as TrackSegment[]) : []),
        ...Array<TrackSegment>(ahead).fill("ahead"),
    ];
}

export function designLabel(f: BrainstormFile): string {
    const n = decisionParts(f).length;
    if (n === 0) {
        return "The design";
    }
    return `The design · ${brainstormCounts(f).yours} of ${n} yours`;
}

export function orderedParts(f: BrainstormFile): BrainstormPart[] {
    return [...f.parts.filter((p) => p.id !== BUILDER_PART), ...f.parts.filter((p) => p.id === BUILDER_PART)];
}

// what the run builds, each of which has to be yours
export function decisionParts(f: BrainstormFile): BrainstormPart[] {
    return orderedParts(f).filter((p) => !isNote(p));
}

export function noteParts(f: BrainstormFile): BrainstormPart[] {
    return orderedParts(f).filter(isNote);
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

// once the run merged nothing is current: every phase is done
export function phaseSteps(f: BrainstormFile, merged = false): PhaseStep[] {
    const at = merged ? PHASES.length : PHASES.findIndex((p) => p.phase === brainstormPhase(f));
    return PHASES.map((p, i) => ({ ...p, status: i < at ? "done" : i === at ? "current" : "todo" }));
}

export type ProgressView = {
    segments: { id: string; title: string; state: PartState }[];
    lead: string;
    rest: string;
};

// one segment per part, in the order the design draws them; the label reads per phase
export function progressView(f: BrainstormFile): ProgressView {
    const parts = decisionParts(f);
    const { yours, open } = brainstormCounts(f);
    const segments = parts.map((p) => ({ id: p.id, title: p.title, state: p.state }));
    if (brainstormPhase(f) === "talk") {
        return { segments, lead: `${yours} of ${parts.length}`, rest: "parts yours" };
    }
    return { segments, lead: `${yours} yours`, rest: open === 0 ? "· nothing open" : `· ${open} open` };
}

// the one line a part reads as in the design: the agent's gist, else the body's first sentence, else what the part
// waits on
export function partGist(f: BrainstormFile, p: BrainstormPart): string {
    if (p.gist) {
        return p.gist;
    }
    const first = sentences(p.body.trim())[0];
    if (first) {
        return first;
    }
    switch (partView(f, p)) {
        case "asked":
            return f.question?.part === p.id
                ? `Written from your answer to question ${f.question.n}.`
                : "Waiting on the agent’s question.";
        case "writing":
            return "The agent is writing this from your answer.";
        case "open":
            return p.id === BUILDER_PART ? "The agent writes this last." : "Not talked through yet.";
        default:
            return "";
    }
}

// the guesses one press confirms: a changed part is left out, since it asks keep or restore
export function confirmableGuesses(f: BrainstormFile): number {
    return decisionParts(f).filter((p) => partView(f, p) === "guess").length;
}

// the head of the design once there is something to review: what stands before the builder check, and the one
// press that moves it on. Confirm all needs two guesses, since one has its own That's right
export type ReviewHead = { line: string; action: "confirm-all" | "check" | null; guesses: number };

export function reviewHead(f: BrainstormFile): ReviewHead {
    if (canCheck(f)) {
        return {
            line: "Every decision is yours. Next, a fresh agent reads the design as a builder would.",
            action: "check",
            guesses: 0,
        };
    }
    const guesses = confirmableGuesses(f);
    const changed = decisionParts(f).filter((p) => partView(f, p) === "changed").length;
    const said: string[] = [];
    if (guesses > 0) {
        said.push(`${plural(guesses, "decision is", "decisions are")} still the agent’s guess.`);
    }
    if (changed > 0) {
        said.push(
            `${plural(changed, "decision", "decisions")} changed since you confirmed ${changed === 1 ? "it" : "them"}.`
        );
    }
    if (said.length > 0) {
        said.push("Each reads in one line; open one to read it whole.");
    } else {
        said.push("Nothing to confirm; the agent still has questions.");
    }
    return { line: said.join(" "), action: guesses > 1 ? "confirm-all" : null, guesses };
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
    const open = openBuilderQuestion(f);
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

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// why Approve is off, said in words beside it; null when it is on. The design is settled only once the builder is
// answered, no talk question is open, and every decision is yours
export function approveBlocker(f: BrainstormFile): string | null {
    if (f.run != null) {
        return null;
    }
    if (f.working != null) {
        return "The agent is writing; this opens when it is done";
    }
    const asked = f.question != null ? `answer question ${f.question.n}` : null;
    const unanswered = f.check?.yours.filter((y) => y.a == null).length ?? 0;
    if (unanswered > 0) {
        const answer = `Answer the builder’s ${plural(unanswered, "question, then review what it changes", "questions, then review what they change")}`;
        return asked != null ? `${answer}, and ${asked}` : answer;
    }
    const decisions = decisionParts(f);
    const count = (view: PartView) => decisions.filter((p) => partView(f, p) === view).length;
    const changed = count("changed");
    const guesses = count("guess");
    const open = decisions.filter(
        (p) => (p.state === "asked" || p.state === "open") && p.id !== f.question?.part
    ).length;
    const items = [
        changed > 0 ? `review ${plural(changed, "change", "changes")}` : null,
        guesses > 0 ? `confirm ${plural(guesses, "guess", "guesses")}` : null,
        asked,
        open > 0 ? `${plural(open, "decision", "decisions")} still open` : null,
    ].filter((s): s is string => s != null);
    return items.length > 0 ? capitalize(items.join(", ")) : null;
}

// the agent's calls under the part each is about. A call about no part, or one the design does not have, is still
// shown, among the others
function groupCalls(f: BrainstormFile): { byPart: Map<string, string[]>; other: string[] } {
    const ids = new Set(f.parts.map((p) => p.id));
    const byPart = new Map<string, string[]>();
    const other: string[] = [];
    for (const c of f.check?.calls ?? []) {
        if (c.part != null && ids.has(c.part)) {
            byPart.set(c.part, [...(byPart.get(c.part) ?? []), c.text]);
        } else {
            other.push(c.text);
        }
    }
    return { byPart, other };
}

// the builder check while it asks: the open builder question, the rail's queue, and the agent's calls by part
export type AskModel = {
    index: number;
    total: number;
    open: BuilderQuestion | null;
    queue: { label: string; state: "now" | "waiting" | "answered" }[];
    callGroups: { part: string | null; title: string; calls: string[] }[];
    calls: number;
    already: string[];
    questions: number;
};

export function checkAsk(f: BrainstormFile): AskModel {
    const check = f.check ?? { yours: [], calls: [], answered: [] };
    const open = openBuilderQuestion(f);
    const { byPart, other } = groupCalls(f);
    const callGroups: AskModel["callGroups"] = orderedParts(f)
        .filter((p) => byPart.has(p.id))
        .map((p) => ({ part: p.id, title: p.title, calls: byPart.get(p.id)! }));
    if (other.length > 0) {
        callGroups.push({ part: null, title: "Other decisions", calls: other });
    }
    return {
        index: open != null ? check.yours.indexOf(open) + 1 : 0,
        total: check.yours.length,
        open,
        queue: check.yours.map((y) => ({
            label: y.label ?? y.q,
            state: y === open ? "now" : y.a != null ? "answered" : "waiting",
        })),
        callGroups,
        calls: check.calls.length,
        already: check.answered,
        questions: check.yours.length + check.calls.length + check.answered.length,
    };
}

// one decision in the check's review: what caused its change, and the one action it asks for
export type ReviewRow = {
    id: string;
    title: string;
    gist: string;
    cause: string;
    was?: string;
    body: string;
    view: PartView;
    action: "keep-restore" | "confirm" | "answer" | null;
    question?: number;
    calls: string[];
};

export type ReviewModel = {
    changed: ReviewRow[];
    fresh: ReviewRow[];
    unchanged: BrainstormPart[];
    notes: BrainstormPart[];
    cursorIds: string[];
    summary: string;
    answered: { q: string; a: string; changed: { id: string; title: string }[] }[];
};

function reviewRow(f: BrainstormFile, p: BrainstormPart, calls: string[]): ReviewRow {
    const view = partView(f, p);
    const asks = p.state === "asked" && f.question?.part === p.id;
    const action = view === "changed" ? "keep-restore" : view === "guess" ? "confirm" : asks ? "answer" : null;
    return {
        id: p.id,
        title: p.title,
        gist: partGist(f, p),
        // the skill names the answer that caused the change in why
        cause: p.why ?? p.from ?? "",
        ...(p.was != null ? { was: p.was } : {}),
        body: p.body,
        view,
        action,
        ...(asks ? { question: f.question!.n } : {}),
        calls,
    };
}

function reviewSummary(changed: number, fresh: number, pending: number, calls: number): string {
    const what: string[] = [];
    if (changed > 0) {
        what.push(
            `Your answers to the builder changed ${plural(changed, "decision", "decisions")} you had confirmed` +
                (fresh > 0 ? `, and ${fresh} ${fresh === 1 ? "is" : "are"} new.` : ".")
        );
    } else if (fresh > 0) {
        what.push(`${plural(fresh, "decision is", "decisions are")} new since the check.`);
    } else {
        what.push("The check changed nothing you had confirmed.");
    }
    const callLine =
        calls > 0
            ? `the agent’s ${plural(calls, "call sits under the decision it belongs", "calls sit under the decision they belong")} to.`
            : null;
    if (pending > 0) {
        what.push(
            callLine != null ? `Keep each change or put yours back; ${callLine}` : "Keep each change or put yours back."
        );
    } else if (callLine != null) {
        what.push(capitalize(callLine));
    }
    return what.join(" ");
}

// what the check changed, for the review. Only yours exists when the check starts, so a decision that is a guess
// without was, or asked or open, is new since it; a yours decision the check touched or put a call under is changed,
// though settled
export function checkReview(f: BrainstormFile): ReviewModel {
    const { byPart } = groupCalls(f);
    const touched = new Set(f.check?.touched ?? []);
    const callsOf = (p: BrainstormPart) => byPart.get(p.id) ?? [];
    const changed: ReviewRow[] = [];
    const fresh: ReviewRow[] = [];
    const unchanged: BrainstormPart[] = [];
    for (const p of decisionParts(f)) {
        if (p.was != null || (p.state === "yours" && (touched.has(p.id) || callsOf(p).length > 0))) {
            changed.push(reviewRow(f, p, callsOf(p)));
        } else if (p.state !== "yours") {
            fresh.push(reviewRow(f, p, callsOf(p)));
        } else {
            unchanged.push(p);
        }
    }
    const rows = [...changed, ...fresh];
    const pending = changed.filter((r) => r.action === "keep-restore").length;
    const calls = rows.reduce((n, r) => n + r.calls.length, 0);
    return {
        changed,
        fresh,
        unchanged,
        notes: noteParts(f),
        cursorIds: rows.map((r) => r.id),
        summary: reviewSummary(changed.length, fresh.length, pending, calls),
        answered: (f.check?.yours ?? [])
            .filter((y) => y.a != null)
            .map((y) => ({
                q: y.q,
                a: y.a!,
                changed: (y.into ?? []).map((id) => ({ id, title: partTitle(f, id) })),
            })),
    };
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

export type PaneView = "error" | "removed" | "exited" | "run" | "check" | "board" | "design";

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
    if (s.file?.run != null) {
        return "run";
    }
    return s.file?.check != null ? "check" : "design";
}
