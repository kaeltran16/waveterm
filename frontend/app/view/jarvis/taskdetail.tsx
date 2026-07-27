// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ConfirmDialog } from "@/app/modals/confirmdialog";
import { cn } from "@/util/util";
import { Lock } from "lucide-react";
import { useState, type ReactNode } from "react";
import { DecisionLog } from "./decisionlog";
import { allowedTransitions, isTerminalTransition } from "./tasksderive";
import { setDossierStatus } from "./tasksstore";

// A machine-maintained region: muted panel + a lock glyph, non-editable. The visible expression of
// the write-ownership model's inside-Wave tier (spec §4).
function MachineField({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="mb-3">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                <Lock size={10} strokeWidth={2} className="text-muted" />
                {label}
            </div>
            <div className="text-[13px] leading-[1.55] text-secondary">{children}</div>
        </div>
    );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="mb-6">
            <h2 className="mb-2.5 text-[13px] font-bold uppercase tracking-[0.08em] text-primary">{title}</h2>
            {children}
        </div>
    );
}

function StatusControl({ dossierId, status }: { dossierId: string; status: string }) {
    const [pending, setPending] = useState<string | null>(null);
    const apply = (next: string) => {
        if (isTerminalTransition(next)) {
            setPending(next);
        } else {
            setDossierStatus(dossierId, next);
        }
    };
    return (
        <>
            <div className="flex items-center gap-1.5">
                {allowedTransitions(status).map((next) => (
                    <button
                        key={next}
                        type="button"
                        onClick={() => apply(next)}
                        className="cursor-pointer rounded border border-border px-2 py-0.5 font-mono text-[11px] text-secondary hover:bg-surface-hover"
                    >
                        → {next}
                    </button>
                ))}
            </div>
            {pending != null ? (
                <ConfirmDialog
                    tone={pending === "archived" ? "danger" : "warning"}
                    title={`Mark this task ${pending}?`}
                    body={`This sets the dossier status to "${pending}". You can reactivate it later.`}
                    confirmLabel={`Yes, ${pending}`}
                    cancelLabel="Cancel"
                    onConfirm={() => {
                        setDossierStatus(dossierId, pending);
                        setPending(null);
                    }}
                    onClose={() => setPending(null)}
                />
            ) : null}
        </>
    );
}

export function TaskDetail({ detail }: { detail: DossierDetail }) {
    // The dossier scaffold seeds an empty "## Notes" heading; the read projection keeps it. Strip that
    // redundant leading heading so the FE's own "Notes" section is the only heading and a dossier with
    // no real notes renders no Notes section at all.
    const notes = detail.notes.replace(/^##\s+Notes\s*/i, "").trim();
    return (
        <div className="mx-auto max-w-[720px] px-8 py-6">
            <div className="mb-5">
                <div className="flex items-center gap-2.5">
                    <h1 className="text-[22px] font-bold tracking-[-0.02em] text-primary">{detail.objective}</h1>
                    {detail.ticket ? (
                        <span className="rounded bg-surface-hover px-2 py-0.5 font-mono text-[11px] text-muted">
                            {detail.ticket}
                        </span>
                    ) : null}
                </div>
                <div className="mt-1.5 flex items-center gap-3 text-[12px] text-muted">
                    <span
                        className={cn(
                            "rounded px-1.5 py-0.5 font-mono",
                            detail.status === "active" ? "bg-success/12 text-success" : "bg-surface-hover"
                        )}
                    >
                        {detail.status}
                    </span>
                    {detail.confidence ? <span>confidence: {detail.confidence}</span> : null}
                    <StatusControl dossierId={detail.id} status={detail.status} />
                </div>
            </div>

            <Section title="Machine-maintained">
                <div className="rounded-xl border border-border bg-surface/50 px-4 py-3.5">
                    {detail.acceptance.length > 0 ? (
                        <MachineField label="Acceptance">
                            <ul className="list-inside list-disc">
                                {detail.acceptance.map((a, i) => (
                                    <li key={i}>{a}</li>
                                ))}
                            </ul>
                        </MachineField>
                    ) : null}
                    {detail.state ? (
                        <MachineField label="State">
                            <div className="whitespace-pre-wrap">{detail.state}</div>
                        </MachineField>
                    ) : null}
                    {detail.blockers.length > 0 ? (
                        <MachineField label="Blockers">
                            <ul className="list-inside list-disc">
                                {detail.blockers.map((b, i) => (
                                    <li key={i}>{b}</li>
                                ))}
                            </ul>
                        </MachineField>
                    ) : null}
                    {detail.refs.length > 0 ? (
                        <MachineField label="Refs">
                            <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
                                {detail.refs.map((r) => (
                                    <span key={r} className="rounded bg-surface-hover px-1.5 py-0.5">
                                        {r}
                                    </span>
                                ))}
                            </div>
                        </MachineField>
                    ) : null}
                </div>
            </Section>

            {notes ? (
                <Section title="Notes">
                    <div className="whitespace-pre-wrap text-[13px] leading-[1.6] text-secondary">{notes}</div>
                </Section>
            ) : null}

            <Section title="Decisions">
                <DecisionLog decisions={detail.decisions} dossierId={detail.id} />
            </Section>
        </div>
    );
}
