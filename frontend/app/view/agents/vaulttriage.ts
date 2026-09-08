// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure helpers for the Vault memory tab's review queue (Wave-vault-tab.dc.html). Kept out of the
// component so the cursor arithmetic and the filtering — the parts a keystroke can get wrong — are
// unit-testable without rendering or RPC.

const WORDS_PER_MINUTE = 200;

export type QueueItem = {
    path: string;
    scope: string;
    source: string;
    title: string;
    body: string;
};

export type ScopeChip = { key: string; label: string; count: number };

// Chips are derived from what is actually in the queue, never a fixed list: a scope with nothing
// pending is not a filter the user can usefully press.
export function scopeChips(items: QueueItem[]): ScopeChip[] {
    const counts = new Map<string, number>();
    for (const p of items) {
        const s = p.scope || "shared";
        counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const scopes = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    return [
        { key: "all", label: "all", count: items.length },
        ...scopes.map((s) => ({ key: s, label: s, count: counts.get(s)! })),
    ];
}

// Search matches the queue as well as the saved list: a note you half-remember is as likely to be
// awaiting review as saved, and two search boxes for one vault is one too many.
export function filterQueue(items: QueueItem[], scope: string, search: string): QueueItem[] {
    const q = search.trim().toLowerCase();
    return items.filter((p) => {
        if (scope !== "all" && (p.scope || "shared") !== scope) return false;
        if (!q) return true;
        return `${p.title} ${p.body} ${p.scope}`.toLowerCase().includes(q);
    });
}

// Clamped cursor movement. An empty queue holds at 0 so the caller never indexes into nothing.
export function moveCursor(length: number, cursor: number, delta: number): number {
    if (length <= 0) return 0;
    return Math.max(0, Math.min(length - 1, cursor + delta));
}

// Where the cursor lands after the item at `removedPath` leaves: the row that shifts up into its
// index, else the last remaining row. Mirrors memstore.advanceSelection, which picks the same
// "who fills the gap" rule for the detail selection.
export function cursorAfterResolve(paths: string[], removedPath: string): number {
    const idx = paths.indexOf(removedPath);
    if (idx < 0) return 0;
    return Math.max(0, Math.min(paths.length - 2, idx));
}

// Other candidates harvested by the same agent, for the rail's "from the same run" cluster. Capped
// because the cluster is a hint, not a second queue.
export function sameRun(items: QueueItem[], current: QueueItem | undefined, limit = 3): QueueItem[] {
    if (!current) return [];
    return items.filter((p) => p.source === current.source && p.path !== current.path).slice(0, limit);
}

export function wordCount(text: string): number {
    const t = text.trim();
    return t ? t.split(/\s+/).length : 0;
}

// "N min read", floored at 0.1 so a one-line note reads as a duration rather than as zero.
export function readingTime(text: string): string {
    const mins = Math.max(0.1, Math.round((wordCount(text) / WORDS_PER_MINUTE) * 10) / 10);
    return `${mins} min read`;
}

// A candidate long enough that the inline preview clips it and the reader overlay earns its key.
const LONG_BODY_CHARS = 340;

export function isLong(body: string): boolean {
    return body.length > LONG_BODY_CHARS;
}

// Slug of a title, close enough to the vault's own filename slugging to spot the same fact arriving
// twice. Not a normalizer for storage — only for comparing two titles.
export function titleSlug(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

// Shortest slug worth treating as a containment match. Below this, containment is noise: "memory"
// sits inside half the vault.
const MIN_CONTAINMENT_LEN = 12;

// Saved notes that look like this candidate arriving again: identical slugs, or one slug contained in
// the other. Deliberately literal — this catches a re-harvest, which is the duplicate that actually
// happens here. It does not claim semantic similarity, and the UI must not describe it as one.
export function overlapping<T extends { title: string }>(candidateTitle: string, saved: T[], limit = 3): T[] {
    const a = titleSlug(candidateTitle);
    if (!a) return [];
    const hits = saved.filter((n) => {
        const b = titleSlug(n.title);
        if (!b) return false;
        if (a === b) return true;
        const shorter = a.length <= b.length ? a : b;
        if (shorter.length < MIN_CONTAINMENT_LEN) return false;
        return a.includes(b) || b.includes(a);
    });
    return hits.slice(0, limit);
}

// Display name for a scope. A scope is either a plain namespace ("shared", "arc-cockpit") or the
// absolute path of the project it belongs to — and an absolute path eats a group header whole, so
// show its last segment and keep the full string for the tooltip. Windows and POSIX separators both,
// since a vault is read on either.
export function scopeLabel(scope: string): string {
    if (!scope) return "shared";
    const parts = scope.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : scope;
}
