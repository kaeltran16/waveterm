export type ChunkTone = "done" | "active" | "blocked" | "deferred" | "skipped" | "pending";

// single source of truth for chips, detail-row status pills, and mark squares
export const CHUNK_CHIP_CLASSES: Record<ChunkTone, string> = {
    done: "bg-success/15 text-success",
    active: "bg-accent/15 text-accent-soft",
    blocked: "bg-asking/15 text-asking",
    deferred: "text-muted border border-dashed border-edge-strong",
    skipped: "text-ink-faint line-through",
    pending: "bg-surface-raised text-muted",
};

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
    chips: ChunkChip[];
    chipOverflow: number;
    blockedChunks: string[];
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
        chips,
        chipOverflow: Math.max(0, chunks.length - CHIP_CAP),
        blockedChunks: chunks.filter((c) => c.status === "blocked").map((c) => c.label),
    };
}

const EFFORT_DELTA_KINDS = new Set(["effort-created", "chunk-done", "chunk-added", "chunk-status", "effort-status", "effort-note"]);

// delta rows carry Title = effort title, Detail = "<label> · <stamp>" (Task 1 fold)
export function effortDeltaRow(ev: TimelineEvent): { title: string; meta: string } | null {
    if (!EFFORT_DELTA_KINDS.has(ev.kind)) return null;
    return { title: ev.title, meta: ev.detail ?? "" };
}
