// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure helpers for the Jarvis profile editor: which layer each section resolves from (for the badge)
// and a dirty check for the Save button. The merge rule itself lives only in Go (ResolveProfile) — the
// editor reads the resolved profile from the backend and never re-derives it here.

export type SectionSource = "global" | "project";

// A section is "project" when the override carries it (non-null), else "global". Uses != null so an
// explicit empty override (empty principles string / empty playbook array) still counts as project.
export function sectionSource(override: ProfileOverride | null | undefined): {
    playbook: SectionSource;
    principles: SectionSource;
} {
    return {
        playbook: override?.playbook != null ? "project" : "global",
        principles: override?.principles != null ? "project" : "global",
    };
}

// Structural equality is enough here — the override is a small JSON-serializable object.
export function isDirty(a: ProfileOverride, b: ProfileOverride): boolean {
    return JSON.stringify(a) !== JSON.stringify(b);
}
