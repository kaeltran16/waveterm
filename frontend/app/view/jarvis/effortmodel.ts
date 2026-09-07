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

// delta rows carry Title = effort title, Detail = "<label> · <stamp>" (Task 1 fold); the param is
// structural so both wire TimelineEvents and the briefing's derived DeltaRows can feed it.
export function effortDeltaRow(ev: { kind: string; title: string; detail?: string | null }): {
    title: string;
    meta: string;
} | null {
    if (!EFFORT_DELTA_KINDS.has(ev.kind)) return null;
    return { title: ev.title, meta: ev.detail ?? "" };
}

// The collapsed card's one-to-three informative lines, replacing the chip cloud: what is moving and
// what is stuck. Chips showed every chunk's tone and said nothing about which one matters; these say
// it in words. A card with neither an active nor a blocked chunk states that rather than rendering
// nothing, so a stalled initiative is visibly stalled.
export const STATUS_LINE_CAP = 3;
export type EffortStatusLine = { mark: string; tone: ChunkTone; text: string; reading: string };

export function effortStatusLines(card: EffortCardModel): EffortStatusLine[] {
    const lines: EffortStatusLine[] = [];
    if (card.activeChunk != null && card.activeChunk !== "") {
        lines.push({ mark: "▶", tone: "active", text: card.activeChunk, reading: "active" });
    }
    // "in your queue" is a claim about the briefing above, and it holds: buildAttentionQueue folds
    // every blocked chunk into that queue from the same blockedChunks list.
    for (const label of card.blockedChunks) {
        lines.push({ mark: "!", tone: "blocked", text: label, reading: "in your queue" });
    }
    if (lines.length === 0) {
        return [{ mark: "⏸", tone: "deferred", text: "no chunk active", reading: card.countLine }];
    }
    if (lines.length > STATUS_LINE_CAP) {
        const hidden = lines.length - (STATUS_LINE_CAP - 1);
        return [
            ...lines.slice(0, STATUS_LINE_CAP - 1),
            { mark: "!", tone: "blocked", text: `+${hidden} more blocked`, reading: "in your queue" },
        ];
    }
    return lines;
}

// the square that leads the collapsed header: blocked beats done beats moving, so the colour reads
// as "does this need me" rather than "how far along is it" — the count and bar already say that.
export function effortTone(card: EffortCardModel): "blocked" | "done" | "active" {
    if (card.blockedChunks.length > 0) {
        return "blocked";
    }
    return card.status === "done" ? "done" : "active";
}
