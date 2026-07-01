// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Memory-note types + type/scope presentation helpers. Mirrors the generated MemoryNote/MemoryEdge
// wire types but kept local + pure so the graph/list can be unit-tested in node env.

export type MemNote = {
    id: string;
    title: string;
    description: string;
    type: string; // Claude schema: user|feedback|project|reference (verbatim; may be "" or unknown)
    scope: string;
    source: string; // vault|claude|codex
    path: string;
    links: string[];
    updatedts: number;
};

export type MemEdge = { from: string; to: string };

export type TypeMeta = { label: string; dotClass: string; pillClass: string };

// The four Claude types → handoff colors (tokens from tailwindsetup.css). pillClass uses the same
// token as text color so we never introduce a second hardcoded color.
const META: Record<string, TypeMeta> = {
    project: { label: "Project", dotClass: "bg-mem-project", pillClass: "text-mem-project" },
    reference: { label: "Reference", dotClass: "bg-mem-reference", pillClass: "text-mem-reference" },
    feedback: { label: "Feedback", dotClass: "bg-mem-feedback", pillClass: "text-mem-feedback" },
    user: { label: "User", dotClass: "bg-mem-user", pillClass: "text-mem-user" },
};

const FALLBACK: TypeMeta = { label: "Note", dotClass: "bg-ink-mid", pillClass: "text-ink-mid" };

export function typeMeta(type: string): TypeMeta {
    return META[type] ?? FALLBACK;
}

export type ScopeGroup = { name: string; count: number; items: MemNote[] };

// Groups notes by scope: "shared" first, then remaining scopes alphabetically. Items keep input order.
export function groupByScope(notes: MemNote[]): ScopeGroup[] {
    const byScope = new Map<string, MemNote[]>();
    for (const n of notes) {
        const s = n.scope || "shared";
        (byScope.get(s) ?? byScope.set(s, []).get(s)!).push(n);
    }
    const names = [...byScope.keys()].sort((a, b) => {
        if (a === "shared") return -1;
        if (b === "shared") return 1;
        return a.localeCompare(b);
    });
    return names.map((name) => ({ name, count: byScope.get(name)!.length, items: byScope.get(name)! }));
}
