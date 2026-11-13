// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The DAG header's Run settings dialog: the run sheet's inline dials, laid out like the Profile modal. Both
// faces render useRunSettingsEditor, so saving here behaves exactly as the inline form does.
//
// The editor lives above ModalShell, so the component stays mounted while closed and a save in flight still
// lands; the header keys it by an open counter, so every open starts from the stored settings. Closing never
// asks: a dirty draft is simply dropped. Saving does not close, because its outcome shows in the footer.

import { CrossFade } from "@/app/element/crossfade";
import { errorNudge } from "@/app/element/motiontokens";
import { ModalShell } from "@/app/modals/modalshell";
import { RoutePicker } from "@/app/view/agents/routepicker";
import { MAX_PARALLELISM } from "@/app/view/agents/runconfig";
import { WorkerStepper } from "@/app/view/agents/runlauncher";
import { cn } from "@/util/util";
import { X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { DefaultRow, FOOTER_BTN, SEGMENT, SEGMENTS, segmentTone } from "./briefprofileview";
import { ResolvedNote, USE_FOR_NEW_RUNS_TITLE, useRunSettingsEditor, type RunSettingsEditor } from "./briefrunsheet";
import { PROFILE_PANEL } from "./principleseditor";
import {
    runSettingsStatus,
    stepParallelism,
    withWorkers,
    type RunSettingsDraft,
    type WaitingQuestion,
} from "./runsettings";
import type { ConfigNote } from "./runsheetmodel";

const APPROVALS: [boolean, string][] = [
    [false, "Ask me"],
    [true, "Autonomous"],
];
const LINE = "m-0 text-[11.5px] leading-[1.5]";

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-2">
            <h2 className="m-0 text-[13px] font-semibold text-primary">{title}</h2>
            {children}
        </section>
    );
}

// a run with nothing to reconfigure states its reason where the dials would be
function NoteBody({ note }: { note: ConfigNote }) {
    return (
        <div className="flex items-start gap-[9px]">
            <span
                className={cn(
                    "mt-1 h-1.5 w-1.5 flex-none rounded-full",
                    note.tone === "error" ? "bg-error" : note.tone === "muted" ? "bg-muted" : "bg-edge-strong",
                    note.pulse && "pulse-soft"
                )}
            />
            <div className="flex min-w-0 flex-col gap-[3px]">
                <span className="text-[11.5px] font-semibold text-secondary">{note.title}</span>
                {note.body ? <span className="text-[11px] leading-[1.5] text-muted">{note.body}</span> : null}
            </div>
        </div>
    );
}

function Dials({
    editor,
    draft,
    waiting,
}: {
    editor: RunSettingsEditor;
    draft: RunSettingsDraft;
    waiting: WaitingQuestion | null;
}) {
    const { setDraft, busy, approvalsNote } = editor;
    return (
        <>
            <p className={cn(LINE, "text-muted")}>Shape, machine and the lead route are fixed after launch.</p>
            <Section title="Workers and reviewers">
                <div className={PROFILE_PANEL}>
                    <DefaultRow label="Worker parallelism" hint={`1 through ${MAX_PARALLELISM}`}>
                        {/* a stored 0 (no width yet; the engine picks at submit) reads as auto */}
                        <WorkerStepper
                            value={draft.parallelism > 0 ? draft.parallelism : null}
                            unsetLabel="auto"
                            disabled={busy}
                            onStep={(d) => setDraft({ ...draft, parallelism: stepParallelism(draft.parallelism, d) })}
                        />
                    </DefaultRow>
                    <DefaultRow label="Worker route">
                        <RoutePicker
                            value={draft.workerRoute}
                            canInherit
                            inheritedLabel="Inherit the lead"
                            disabled={busy}
                            onChange={(route) => setDraft(withWorkers(draft, route))}
                            extraOption={{
                                label: "Reviewer picks",
                                selected: draft.reviewerPicks,
                                onSelect: () => setDraft(withWorkers(draft, "picks")),
                            }}
                        />
                    </DefaultRow>
                    <DefaultRow label="Reviewers">
                        <RoutePicker
                            value={draft.reviewerRoute}
                            canInherit
                            inheritedLabel="Inherit the lead"
                            disabled={busy}
                            onChange={(route) => setDraft({ ...draft, reviewerRoute: route })}
                        />
                    </DefaultRow>
                    <DefaultRow label="Light reviewers" attrs={{ "data-light-reviewers-row": "" }}>
                        <RoutePicker
                            value={draft.lightReviewerRoute}
                            canInherit
                            inheritedLabel="Sonnet (default)"
                            disabled={busy}
                            onChange={(route) => setDraft({ ...draft, lightReviewerRoute: route })}
                        />
                    </DefaultRow>
                </div>
                <p className={cn(LINE, "text-muted")}>
                    Parallelism and routes apply to workers and reviewers dispatched from now on.
                </p>
            </Section>
            <Section title="Approvals">
                <div className={PROFILE_PANEL}>
                    <DefaultRow label="Approvals">
                        <div role="group" aria-label="Approvals" className={cn(SEGMENTS, "bg-surface-raised")}>
                            {APPROVALS.map(([on, label]) => (
                                <button
                                    key={label}
                                    type="button"
                                    aria-pressed={draft.autonomous === on}
                                    disabled={busy}
                                    onClick={() => setDraft({ ...draft, autonomous: on })}
                                    className={cn(
                                        SEGMENT,
                                        "h-6 px-[11px] text-[12.5px] font-medium",
                                        segmentTone(draft.autonomous === on)
                                    )}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </DefaultRow>
                </div>
                <CrossFade swapKey={approvalsNote} className={LINE}>
                    {approvalsNote === "on" && waiting != null ? (
                        <span className="text-warning-soft">
                            Saving hands the waiting {waiting.header} back to the lead, and it answers everything from
                            then on.
                        </span>
                    ) : approvalsNote === "off" ? (
                        <span className="text-muted">
                            The lead asks you again from its next decision. Calls it already made stand.
                        </span>
                    ) : (
                        <span className="text-muted">Approvals apply to the lead's next decision.</span>
                    )}
                </CrossFade>
            </Section>
        </>
    );
}

function FooterStatus({ editor }: { editor: RunSettingsEditor }) {
    const status = runSettingsStatus({
        error: editor.error,
        invalid: editor.invalid,
        dirty: editor.dirty,
        notice: editor.notice,
        baselineWidth: editor.baseline?.parallelism ?? 0,
    });
    if (status.kind === "error") {
        return (
            <motion.span
                // keyed by the failure count, so a second refusal with the same message still nudges
                key={editor.failures}
                data-run-settings-status="error"
                variants={errorNudge}
                initial="initial"
                animate="animate"
                className="min-w-0 flex-1 text-[12px] leading-[1.4] text-error"
            >
                {status.text}
            </motion.span>
        );
    }
    if (status.kind === "unsaved") {
        return (
            <span
                data-run-settings-status="unsaved"
                className="flex flex-1 items-center gap-[7px] text-[12px] text-asking"
            >
                <span className="h-1.5 w-1.5 rounded-full bg-asking" />
                {status.text}
            </span>
        );
    }
    return (
        <span
            data-run-settings-status={status.kind}
            className={cn("min-w-0 flex-1 text-[12px]", status.kind === "saved" ? "text-success" : "text-muted")}
        >
            {status.text}
        </span>
    );
}

export function RunSettingsModal({
    open,
    run,
    group,
    waiting,
    onClose,
}: {
    open: boolean;
    run: Run;
    group: TaskGroup;
    waiting: WaitingQuestion | null;
    onClose: () => void;
}) {
    const editor = useRunSettingsEditor(run, group, "ready", waiting);
    const { note, draft, saving, canSave, resolvedHeader } = editor;
    const savingSettings = saving === "settings";
    return (
        <ModalShell open={open} onClose={onClose} className="flex max-h-[86vh] w-[min(620px,93vw)] flex-col">
            <div data-run-settings-modal className="flex min-h-0 flex-1 flex-col">
                <header className="flex flex-none items-center gap-3 border-b border-border px-5 py-4">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-[15px] font-semibold text-primary">Run settings</span>
                        <span className="truncate text-[12px] text-muted">{group.title || "orchestration dag"}</span>
                    </div>
                    <button
                        type="button"
                        data-run-settings-close
                        aria-label="Close run settings"
                        onClick={onClose}
                        className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-[6px] text-muted hover:bg-surface hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                        <X size={14} aria-hidden />
                    </button>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto bg-background px-5 pt-[18px] pb-5">
                    {note != null ? (
                        <NoteBody note={note} />
                    ) : draft != null ? (
                        <>
                            {resolvedHeader != null ? <ResolvedNote header={resolvedHeader} /> : null}
                            <Dials editor={editor} draft={draft} waiting={waiting} />
                        </>
                    ) : null}
                </div>
                <footer className="flex flex-none items-center gap-2 border-t border-border bg-surface-raised px-5 py-3">
                    {note == null ? (
                        <>
                            <FooterStatus editor={editor} />
                            <button
                                type="button"
                                onClick={editor.saveDefaults}
                                disabled={!editor.canSaveDefaults}
                                title={USE_FOR_NEW_RUNS_TITLE}
                                className={cn(
                                    FOOTER_BTN,
                                    "whitespace-nowrap border border-border bg-surface-raised text-secondary hover:text-primary disabled:opacity-40"
                                )}
                            >
                                {saving === "defaults" ? "Saving…" : "Use for new runs"}
                            </button>
                            <button
                                type="button"
                                onClick={editor.save}
                                disabled={!canSave}
                                className={cn(
                                    FOOTER_BTN,
                                    "whitespace-nowrap",
                                    canSave || savingSettings
                                        ? "bg-accent text-background hover:bg-accenthover"
                                        : "bg-border text-muted"
                                )}
                            >
                                <CrossFade swapKey={savingSettings ? "saving" : "idle"}>
                                    {savingSettings ? "Saving…" : "Save settings"}
                                </CrossFade>
                            </button>
                        </>
                    ) : null}
                </footer>
            </div>
        </ModalShell>
    );
}
