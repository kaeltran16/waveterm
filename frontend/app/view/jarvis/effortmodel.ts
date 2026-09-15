export type ChunkTone = "done" | "active" | "blocked" | "deferred" | "skipped" | "pending";

const TONES: Record<string, ChunkTone> = {
    done: "done", active: "active", blocked: "blocked",
    deferred: "deferred", skipped: "skipped", pending: "pending",
};

export function chunkTone(status: string): ChunkTone {
    return TONES[status] ?? "pending";
}

export const CHIP_CAP = 12;

export type ChunkChip = { label: string; tone: ChunkTone };

export type EffortCardModel = {
    oref: string;
    title: string;
    project?: string;
    ticket?: string;
    status: string;
    parentoid?: string;
    done: number;
    remaining: number;
    skipped: number;
    progressPct: number;
    countLine: string;
    activeChunk?: string;
    // the next chunk's tone, so a row can say the only work left is deferred
    activeTone?: ChunkTone;
    chips: ChunkChip[];
    chipOverflow: number;
    blockedChunks: string[];
    // carried so the card can tell the detail cache how fresh the summary it is drawing from is
    updatedts: number;
};

// done/(total-skipped): skips shrink the denominator so a finished-by-skipping effort still reads 100%.
// the count line shows "x of y · n skipped" only when something was skipped; all-skipped is a corner.
export function buildEffortCard(e: EffortSummary): EffortCardModel {
    const skipped = e.chunks?.filter((c) => c.status === "skipped").length ?? 0;
    const denominator = Math.max(1, e.total - skipped);
    let countLine: string;
    if (e.total > 0 && skipped === e.total) {
        countLine = "all skipped";
    } else {
        countLine = `${e.done} of ${e.total - skipped}`;
        if (skipped > 0) countLine += ` · ${skipped} skipped`;
        if (e.activechunk) countLine += ` · active: ${e.activechunk}`;
    }
    const pct = skipped === e.total && e.total > 0 ? 100 : Math.round((e.done / denominator) * 100);
    const chunks = e.chunks ?? [];
    const chips = chunks.slice(0, CHIP_CAP).map((c) => ({ label: c.label, tone: chunkTone(c.status) }));
    return {
        oref: e.oref,
        updatedts: e.updatedts,
        title: e.title,
        project: e.project,
        ticket: e.ticket,
        status: e.status,
        parentoid: e.parentoid,
        done: e.done,
        remaining: Math.max(0, e.total - e.done - skipped),
        skipped,
        progressPct: Math.min(100, pct),
        countLine,
        activeChunk: e.activechunk,
        activeTone:
            e.activechunk != null ? chunkTone(chunks.find((c) => c.label === e.activechunk)?.status ?? "") : undefined,
        chips,
        chipOverflow: Math.max(0, chunks.length - CHIP_CAP),
        blockedChunks: chunks.filter((c) => c.status === "blocked").map((c) => c.label),
    };
}

// A stage is a label on chunks, not a container: grouping is by CONSECUTIVE run, never a global
// group-by. Chunk order is the plan's order, so gathering scattered same-stage chunks would silently
// reorder the plan; a stage that reappears later simply prints its header again. Chunks with no
// stage form their own unlabelled runs and render without a header.
export type StageGroup<T> = { stage: string; rows: T[]; fraction: string };

// the card's rule, kept: skipped chunks shrink the denominator, so a stage finished by skipping
// reads as finished rather than stuck.
function stageFraction(rows: { status: string }[]): string {
    const skipped = rows.filter((r) => r.status === "skipped").length;
    if (skipped === rows.length) {
        return "all skipped";
    }
    return `${rows.filter((r) => r.status === "done").length} of ${rows.length - skipped}`;
}

export function groupChunksByStage<T extends { stage: string; status: string }>(rows: T[]): StageGroup<T>[] {
    const groups: StageGroup<T>[] = [];
    for (const row of rows) {
        const last = groups[groups.length - 1];
        if (last != null && last.stage === row.stage) {
            last.rows.push(row);
            continue;
        }
        groups.push({ stage: row.stage, rows: [row], fraction: "" });
    }
    return groups.map((g) => ({ ...g, fraction: stageFraction(g.rows) }));
}

// The datalist behind every stage editor: the stages already on this effort, in first-seen order.
// Assigning a chunk to an existing stage is then a pick rather than a retype — which matters because
// a typo does not error, it silently starts a second run under a near-identical name.
export function stageOptions(rows: { stage: string }[]): string[] {
    const seen: string[] = [];
    for (const row of rows) {
        if (row.stage !== "" && !seen.includes(row.stage)) {
            seen.push(row.stage);
        }
    }
    return seen;
}

// the chunk an initiative picks up next: the active one, else the first not yet settled. It is the rule
// the backend's summary leg applies, so every surface that names "next" names the same chunk.
export function nextChunk<T extends { status: string }>(chunks: T[]): T | undefined {
    return (
        chunks.find((c) => c.status === "active") ?? chunks.find((c) => c.status !== "done" && c.status !== "skipped")
    );
}

const TALLY_STATUSES = ["pending", "active", "blocked", "deferred", "skipped"];

export type EffortFacts = { facts: [string, string][]; next: string };

// The quiet line under the sheet's title, and the sentence that says what comes next. Parent and children
// come off the briefing's summaries because that is the one list holding every effort; the updated age is
// left to the caller, which owns the clock.
export function effortFacts(effort: Effort, all: EffortSummary[]): EffortFacts {
    const chunks = effort.chunks ?? [];
    const facts: [string, string][] = [["project", effort.project ?? "none"]];
    if (effort.ticket != null && effort.ticket !== "") {
        facts.push(["ticket", effort.ticket]);
    }
    const done = chunks.filter((c) => c.status === "done").length;
    const skipped = chunks.filter((c) => c.status === "skipped").length;
    const tally = TALLY_STATUSES.map((s) => [s, chunks.filter((c) => c.status === s).length] as const).filter(
        ([, n]) => n > 0
    );
    // skips shrink the total, as on the Brief's row and the stage headers
    facts.push([
        "chunks",
        `${done} of ${chunks.length - skipped} done` + tally.map(([s, n]) => ` · ${n} ${s}`).join(""),
    ]);
    const next = nextChunk(chunks);
    if (next?.stage) {
        facts.push(["stage", next.stage]);
    }
    const parent = effort.parentoid ? all.find((e) => e.oref === "effort:" + effort.parentoid) : undefined;
    if (parent != null) {
        facts.push(["parent", parent.title]);
    }
    for (const k of all) {
        if (k.parentoid === effort.oid && k.status !== "archived") {
            facts.push(["child", `${k.title} · ${k.done} of ${k.total} · ${k.status}`]);
        }
    }
    const nextLine =
        next != null
            ? (next.status === "deferred" ? "Next (deferred): " : "Next: ") + next.label
            : chunks.length === 0
              ? "No chunks yet."
              : "No open chunk.";
    return { facts, next: nextLine };
}

const EFFORT_DELTA_KINDS = new Set(["effort-created", "chunk-done", "chunk-added", "chunk-status", "effort-status", "effort-note"]);

// delta rows carry Title = effort title, Detail = "<label> · <stamp>" (Task 1 fold); the param is
// structural so both wire TimelineEvents and the briefing's derived DeltaRows can feed it.
export function effortDeltaRow(ev: { kind: string; title: string; detail?: string | null }): {
    title: string;
    meta: string;
} | null {
    if (!EFFORT_DELTA_KINDS.has(ev.kind)) return null;
    return { title: ev.title, meta: ev.detail ?? "" };
}

// The efforts list splits archived rows into their own group so "show archived" is a render toggle
// rather than a second fetch shape. Wire order is already newest-updated first; both groups keep it.
export function partitionEfforts(efforts: EffortSummary[]): {
    active: EffortCardModel[];
    archived: EffortCardModel[];
} {
    const active: EffortCardModel[] = [];
    const archived: EffortCardModel[] = [];
    for (const e of efforts) {
        (e.status === "archived" ? archived : active).push(buildEffortCard(e));
    }
    return { active, archived };
}
