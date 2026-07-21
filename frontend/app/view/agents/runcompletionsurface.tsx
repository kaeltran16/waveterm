// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Run-completion surface (Wave-run-completion.dc.html): the sealed evidence snapshot + phase history
// shown when a run is done. Renders run.evidence (derived server-side, immutable). Replaces RunBody's
// terminal phase-rail view. Read-only — the run stays done; file/artifact clicks open in the OS editor.

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { type ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import {
    artifactKindClass,
    fmtBytes,
    fmtClock,
    fmtDuration,
    phaseHistory,
    runShortId,
    statColor,
    verifCounts,
    verifTone,
} from "./runcompletion";
import { CHANNEL_COL } from "./channelsprimitives";

function openPath(projectPath: string, rel: string) {
    const sep = projectPath.includes("\\") ? "\\" : "/";
    getApi().openExternal(rel.match(/^([/\\]|[a-zA-Z]:)/) ? rel : `${projectPath}${sep}${rel}`);
}

function StatCell({ label, value, sub, dot, valueClass }: { label: string; value: string; sub?: string; dot?: boolean; valueClass?: string }) {
    return (
        <div className="border-r border-border px-4 py-3 last:border-r-0">
            <div className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">{label}</div>
            <div className="flex items-center gap-1.5">
                {dot ? <span className="h-[7px] w-[7px] rounded-full bg-success" /> : null}
                <span className={"text-[15px] font-bold " + (valueClass ?? "text-primary")}>{value}</span>
            </div>
            {sub ? <div className="mt-0.5 font-mono text-[10.5px] text-muted">{sub}</div> : null}
        </div>
    );
}

function Section({ label, right, children }: { label: string; right?: ReactNode; children: ReactNode }) {
    return (
        <div className="border-b border-border px-[18px] py-4">
            <div className="mb-2.5 flex items-center gap-2.5">
                <div className="font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">{label}</div>
                <div className="flex-1" />
                {right}
            </div>
            {children}
        </div>
    );
}

export function RunCompletion({ channel, run, model }: { channel: Channel; run: Run; model: AgentsViewModel }) {
    const ev = run.evidence;
    if (!ev) {
        return null;
    }
    const counts = verifCounts(ev.verifs ?? []);
    const nodes = phaseHistory(run);
    return (
        <div className="sc min-h-0 flex-1 overflow-y-auto">
            {/* header */}
            <div className="flex items-center gap-3 border-b border-border bg-surface px-6 py-[13px]">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
                        <span className="text-ink-mid">#{channel.name}</span>
                        <span>/</span>
                        <span>run {runShortId(run.id)}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[16px] font-bold tracking-[-.01em] text-primary">{run.goal}</div>
                </div>
                <div className="flex-1" />
                <div className="flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-3 py-[5px]">
                    <span className="text-[12px] text-success">✓</span>
                    <span className="font-mono text-[11px] font-bold uppercase tracking-[.02em] text-success">Done</span>
                </div>
            </div>

            <div className="px-6 pb-10 pt-[22px]">
                <div className={CHANNEL_COL}>
                    {/* evidence snapshot card */}
                    <div className="overflow-hidden rounded-2xl border border-accent/25 bg-surface shadow-[0_20px_50px_rgba(0,0,0,.35)]">
                        {/* sealed header */}
                        <div className="flex items-center gap-3 border-b border-accent/20 bg-accentbg px-[18px] py-3.5">
                            <span className="text-[13px] text-accent">🔒</span>
                            <span className="font-mono text-[10px] font-semibold uppercase tracking-[.11em] text-accent-soft">Evidence snapshot</span>
                            <span className="rounded-[5px] border border-accent/25 bg-accentbg px-[7px] py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[.06em] text-accent-soft">Immutable</span>
                            <div className="flex-1" />
                            <span className="font-mono text-[10.5px] text-muted">sealed {fmtClock(ev.capturedts)}</span>
                            <span className="font-mono text-[10.5px] text-ink-faint">·</span>
                            <span className="font-mono text-[10.5px] text-muted">{ev.hash}</span>
                        </div>

                        {/* stat strip */}
                        <div className="grid grid-cols-4 border-b border-border">
                            <StatCell label="Status" value="Done" valueClass="text-success" dot sub="completed cleanly" />
                            <StatCell label="Runtime" value={fmtDuration(ev.runtimems)} sub="active compute" />
                            <StatCell label="Duration" value={fmtDuration(ev.durationms)} sub="wall clock" />
                            <StatCell label="Completed" value={fmtClock(ev.capturedts)} sub="today" />
                        </div>

                        {/* completion summary */}
                        <Section label="Completion summary">
                            {ev.summary ? (
                                <div className="min-w-0 flex-1">
                                    <div className="mb-1.5 flex items-center gap-2">
                                        <span className="rounded border border-edge-mid bg-background px-1.5 font-mono text-[9px] font-semibold uppercase tracking-[.07em] text-ink-mid">final response</span>
                                    </div>
                                    <p className="text-[13.5px] leading-[1.62] text-secondary">{ev.summary}</p>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-edge-mid bg-background px-3.5 py-3">
                                    <span className="text-[13px] text-muted">∅</span>
                                    <span className="text-[13px] italic text-ink-mid">No completion summary was recorded</span>
                                </div>
                            )}
                        </Section>

                        {/* files touched */}
                        <Section
                            label="Files touched"
                            right={
                                <>
                                    <span className="font-mono text-[10px] text-ink-faint">git diff since run baseline</span>
                                    <span className="font-mono text-[11px] font-semibold text-success">+{ev.addtotal}</span>
                                    <span className="font-mono text-[11px] font-semibold text-error">−{ev.deltotal}</span>
                                </>
                            }
                        >
                            <div className="flex flex-col gap-0.5">
                                {(ev.files ?? []).map((f) => (
                                    <button
                                        key={f.path}
                                        onClick={() => openPath(run.projectpath, f.path)}
                                        className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-hover"
                                    >
                                        <span className={"w-[15px] text-center font-mono text-[11px] font-bold " + statColor(f.stat)}>{f.stat}</span>
                                        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-secondary">{f.path}</span>
                                        <span className="w-[34px] text-right font-mono text-[10.5px] font-semibold text-success">+{f.add}</span>
                                        <span className="w-[30px] text-right font-mono text-[10.5px] font-semibold text-error">−{f.del}</span>
                                    </button>
                                ))}
                            </div>
                        </Section>

                        {/* verification */}
                        <Section
                            label="Verification"
                            right={
                                <>
                                    <span className="font-mono text-[10px] font-semibold text-success">{counts.pass} pass</span>
                                    <span className="font-mono text-[10px] font-semibold text-error">{counts.fail} fail</span>
                                    <span className="font-mono text-[10px] font-semibold text-warning">{counts.unknown} unknown</span>
                                </>
                            }
                        >
                            <div className="flex flex-col gap-1.5">
                                {(ev.verifs ?? []).map((v) => {
                                    const tone = verifTone(v.result);
                                    return (
                                        <div key={v.cmd} className={"flex items-center gap-2.5 rounded-[9px] border bg-background px-2.5 py-2 " + tone.borderClass}>
                                            <span className={"flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] font-mono text-[10px] font-bold " + tone.badgeClass}>{tone.icon}</span>
                                            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-secondary">{v.cmd}</span>
                                            {v.detail ? <span className="font-mono text-[10.5px] text-muted">{v.detail}</span> : null}
                                            <span className={"font-mono text-[9px] font-semibold uppercase tracking-[.06em] " + tone.labelClass}>{v.result}</span>
                                        </div>
                                    );
                                })}
                                {(ev.verifs ?? []).length === 0 ? (
                                    <span className="text-[12px] italic text-ink-mid">No verification commands recorded</span>
                                ) : null}
                            </div>
                        </Section>

                        {/* artifacts */}
                        <Section label="Artifacts produced">
                            <div className="flex flex-wrap gap-2">
                                {(ev.artifacts ?? []).map((a) => (
                                    <button
                                        key={a.path}
                                        onClick={() => openPath(run.projectpath, a.path)}
                                        className="flex items-center gap-2 rounded-[9px] border border-edge-mid bg-background px-3 py-2 hover:border-edge-strong"
                                    >
                                        <span className={"rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase " + artifactKindClass(a.kind)}>{a.kind}</span>
                                        <span className="font-mono text-[12px] text-secondary">{a.path}</span>
                                        {a.size ? <span className="font-mono text-[10px] text-muted">{fmtBytes(a.size)}</span> : null}
                                        <span className="text-[11px] text-ink-faint">↗</span>
                                    </button>
                                ))}
                                {(ev.artifacts ?? []).length === 0 ? (
                                    <span className="text-[12px] italic text-ink-mid">No artifacts recorded</span>
                                ) : null}
                            </div>
                        </Section>

                        {/* diff action */}
                        <div className="flex items-center gap-3 px-[18px] py-3.5">
                            <button
                                onClick={() => {
                                    globalStore.set(model.filesRunAtom, { runId: run.id, cwd: run.projectpath, baseCommit: run.basecommit ?? "" });
                                    globalStore.set(model.surfaceAtom, "files");
                                }}
                                className="flex items-center gap-2.5 rounded-[9px] bg-accent px-4 py-2.5 text-[12.5px] font-bold text-background hover:bg-accent/90"
                            >
                                <span className="text-[12px]">⑂</span>Open repository diff
                                <span className="font-mono text-[10.5px] text-background/60">+{ev.addtotal} −{ev.deltotal}</span>
                            </button>
                            <span className="text-[11.5px] text-muted">Snapshot is read-only — the run stays done. No approval needed.</span>
                        </div>
                    </div>

                    {/* phase history */}
                    <div className="mx-0.5 mb-3.5 mt-[26px] flex items-center gap-3">
                        <span className="font-mono text-[10px] font-semibold uppercase tracking-[.11em] text-muted">Phase history</span>
                        <div className="h-px flex-1 bg-border" />
                        <span className="font-mono text-[11px] text-muted">{nodes.length} phases · all complete</span>
                    </div>
                    <div className="pl-0.5">
                        {nodes.map((n, i) => (
                            <div key={i} className="flex gap-[15px]">
                                <div className="flex w-[38px] flex-none flex-col items-center">
                                    <div className={"flex h-[26px] w-[26px] flex-none items-center justify-center border-[1.5px] border-success/50 bg-success/15 font-mono text-[11px] font-bold text-success " + (n.isGate || n.isBoundary ? "rounded-lg" : "rounded-full")}>
                                        {n.isBoundary ? "↻" : "✓"}
                                    </div>
                                    {n.notLast ? <div className="min-h-[26px] w-0.5 flex-1 bg-success/40" /> : null}
                                </div>
                                <div className="min-w-0 flex-1 pb-4">
                                    <div className="flex items-center gap-2.5">
                                        <span className="text-[14px] font-bold text-primary">{n.name}</span>
                                        {n.tag ? (
                                            <span className={"rounded border px-1.5 py-px font-mono text-[8.5px] font-semibold uppercase tracking-[.07em] " + (n.isGate ? "border-warning/30 bg-warning/10 text-warning" : "border-accent/25 bg-accentbg text-accent-soft")}>{n.tag}</span>
                                        ) : null}
                                        <div className="flex-1" />
                                        <span className="font-mono text-[10.5px] text-muted">{n.timeLabel}</span>
                                    </div>
                                    <div className="mt-0.5 font-mono text-[11px] text-muted">{n.detail}</div>
                                    {n.artifacts.map((art) => (
                                        <button
                                            key={art}
                                            onClick={() => openPath(run.projectpath, art)}
                                            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-edge-mid bg-background px-2.5 py-1.5 hover:border-edge-strong"
                                        >
                                            <span className="rounded bg-success/15 px-1.5 py-px font-mono text-[8.5px] font-bold text-success">OUT</span>
                                            <span className="font-mono text-[11.5px] text-ink-mid">{art}</span>
                                            <span className="text-[10px] text-ink-faint">↗</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
