// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Presentational token maps for the Radar surface, shared by the master list and detail pane so the
// two never disagree on a color. Pure class-string lookups — no logic lives here (see radarmodel.ts).

import type { RadarMode, RadarTone } from "./radarmodel";

// Severity → pill classes + dot color. Unknown severities fall back to the low/accent styling.
export const SEVERITY_PILL: Record<string, string> = {
    high: "bg-error/15 text-error",
    medium: "bg-warning/15 text-warning",
    low: "bg-accent/15 text-accent",
};

export function severityPill(severity: string): string {
    return SEVERITY_PILL[severity] ?? SEVERITY_PILL.low;
}

// Lifecycle tone → text/dot color, keyed by GROUP_META.tone.
export const TONE_TEXT: Record<RadarTone, string> = {
    new: "text-accent",
    recurring: "text-warning",
    nolonger: "text-success",
    muted: "text-muted",
};

export const TONE_DOT: Record<RadarTone, string> = {
    new: "bg-accent",
    recurring: "bg-warning",
    nolonger: "bg-success",
    muted: "bg-muted",
};

// Collector → accent color, mirroring the handoff's evidence-chip palette.
const COLLECTOR_TEXT: Record<string, string> = {
    git: "text-accent",
    runs: "text-success",
    transcript: "text-warning",
    memory: "text-secondary",
    config: "text-working",
    structure: "text-muted",
};

export function collectorText(collector: string): string {
    return COLLECTOR_TEXT[collector] ?? "text-muted";
}

// Mode → badge classes (border + faint fill + text), all @theme tokens. Correctness reuses the
// surface's existing accent-soft treatment; security/debt reuse error/warning tones.
export const MODE_BADGE: Record<RadarMode, string> = {
    correctness: "border-accent/25 bg-accent/10 text-accent-soft",
    security: "border-error/25 bg-error/10 text-error",
    debt: "border-warning/25 bg-warning/10 text-warning",
};

export function modeBadge(mode: RadarMode): string {
    return MODE_BADGE[mode] ?? MODE_BADGE.correctness;
}
