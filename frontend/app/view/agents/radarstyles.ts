// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Presentational token maps for the Radar surface, shared by the master list and detail pane so the
// two never disagree on a color. Pure class-string lookups — no logic lives here (see radarmodel.ts).

import type { RadarTone } from "./radarmodel";

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
