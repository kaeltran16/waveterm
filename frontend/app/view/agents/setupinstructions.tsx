// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Setup surface's Instructions tab: it edits the shared doc, which every save writes into each
// harness's file, and lists each harness file's state. Logic lives in setupmodel.ts, the RPCs and atoms
// in setupstore.ts.

import { composerReveal } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Share2, TriangleAlert } from "lucide-react";
import { Fragment } from "react";
import { formatAgo } from "./agentsviewmodel";
import { PathTail } from "./pathtail";
import {
    changedLineCount,
    harnessRowLabel,
    harnessRowState,
    harnessRowTone,
    headerStatus,
    isDirty,
    lineCount,
    saveTargetCount,
    type DocEditor,
} from "./setupmodel";
import {
    BTN_PRIMARY,
    BTN_SECONDARY,
    Dot,
    ErrorBanner,
    HarnessMark,
    LoadFailed,
    SECTION_HEAD,
    TONE_TEXT,
} from "./setupparts";
import {
    discardShared,
    loadSetup,
    reloadShared,
    saveShared,
    setupBusyAtom,
    setupInstructionsErrorAtom,
    setupSharedAtom,
    setupSharedPathAtom,
    setupStatusAtom,
    typeShared,
} from "./setupstore";

function useRows(): AgentSyncHarness[] {
    return useAtomValue(setupStatusAtom)?.harnesses ?? [];
}

const retryLoad = () => fireAndForget(loadSetup);

export function InstructionsHeader() {
    const rows = useRows();
    const status = useAtomValue(setupStatusAtom);
    if (status == null) {
        return null;
    }
    const s = headerStatus(rows);
    return (
        <div
            className={cn(
                "flex items-center gap-2 text-[12px]",
                s.tone === "warn" ? "text-warning-soft" : "text-ink-mid"
            )}
        >
            <Dot tone={s.tone} size={7} />
            {s.text}
        </div>
    );
}

// ---- left list ----

function FileList({ rows }: { rows: AgentSyncHarness[] }) {
    const shared = useAtomValue(setupSharedAtom);
    const status = useAtomValue(setupStatusAtom);
    const error = useAtomValue(setupInstructionsErrorAtom);
    const rowClass = "flex w-full items-start gap-2.5 rounded px-2.5 py-[9px]";
    return (
        <aside
            aria-label="Instruction files"
            className="flex w-[264px] flex-none flex-col gap-1 overflow-y-auto border-r border-border bg-surface px-2.5 py-3.5"
        >
            <div className={cn(SECTION_HEAD, "px-2 pb-1.5")}>Shared</div>
            <div className={cn(rowClass, "bg-surface-selected text-primary ring-1 ring-edge-strong ring-inset")}>
                <span className="flex h-5 w-5 flex-none items-center justify-center rounded-[5px] bg-accentbg text-accent-soft">
                    <Share2 size={12} strokeWidth={2.2} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-[13px] font-semibold">
                        For every harness
                        {isDirty(shared) ? (
                            <span
                                aria-label="Unsaved changes"
                                title="Unsaved changes"
                                className="ml-auto h-[7px] w-[7px] rounded-full bg-accent"
                            />
                        ) : null}
                    </span>
                    <span className="font-mono text-[10.5px] text-muted">vault/steering/AGENTS.md</span>
                </span>
            </div>

            <div className={cn(SECTION_HEAD, "px-2 pb-1.5 pt-4")}>Harness files</div>
            {status == null ? (
                error != null ? (
                    // a row, so it sits where "Reading…" was rather than filling the list's height
                    <div className="flex">
                        <LoadFailed error={error} onRetry={retryLoad} />
                    </div>
                ) : (
                    <div className="px-2 text-[12px] text-muted">Reading…</div>
                )
            ) : null}
            {rows.map((r) => {
                const state = harnessRowState(r);
                const tone = harnessRowTone(state);
                return (
                    <div key={r.runtime} className={cn(rowClass, "text-secondary", !r.present && "opacity-50")}>
                        <HarnessMark runtime={r.runtime} />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="text-[13px] font-medium">{r.label}</span>
                            <PathTail path={r.path} />
                            <span className={cn("mt-[3px] flex items-center gap-1.5 text-[11px]", TONE_TEXT[tone])}>
                                <Dot tone={tone} />
                                {harnessRowLabel(state)}
                            </span>
                        </span>
                    </div>
                );
            })}
        </aside>
    );
}

// ---- shared doc ----

function ConflictNotice({
    onReload,
    onOverwrite,
    busy,
}: {
    onReload: () => void;
    onOverwrite: () => void;
    busy: boolean;
}) {
    return (
        <div
            role="alert"
            className="flex items-center gap-3 rounded border border-warning/30 bg-warning/10 px-3.5 py-2.5"
        >
            <TriangleAlert size={16} strokeWidth={2} className="flex-none text-warning" />
            <span className="min-w-0 flex-1 text-[12.5px] text-secondary">
                <span className="font-semibold text-warning-soft">Changed on disk since you opened it.</span> Reload to
                take the file as it is now and lose your edits, or overwrite it with yours.
            </span>
            <button type="button" disabled={busy} onClick={onReload} className={BTN_SECONDARY}>
                Reload
            </button>
            <button type="button" disabled={busy} onClick={onOverwrite} className={BTN_SECONDARY}>
                Overwrite
            </button>
        </div>
    );
}

function LineEditor({
    ed,
    onChange,
    path,
    placeholder,
}: {
    ed: DocEditor;
    onChange: (v: string) => void;
    path: string;
    placeholder: string;
}) {
    const lines = ed.draft.split("\n");
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-edge-mid bg-surface-code focus-within:ring-2 focus-within:ring-accent/25">
            <div className="flex h-[30px] flex-none items-center gap-2.5 border-b border-edge-faint px-3 font-mono text-[11px] text-muted">
                <span title={path} className="min-w-0 truncate">
                    {path}
                </span>
                <span className="flex-1" />
                <span>Markdown</span>
                <span className="text-muted">·</span>
                <span>
                    {lineCount(ed.draft)} {lineCount(ed.draft) === 1 ? "line" : "lines"}
                </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-2 pr-4 font-mono text-[12.5px] leading-[21px]">
                {/* lines soft-wrap, so each row holds a number beside an invisible copy of its line: the row
                    takes the wrapped height and the number stays level with the line the textarea draws over it.
                    the last 1fr row lets the textarea fill the rest of the box. */}
                <div
                    className="grid min-h-full"
                    style={{ gridTemplateColumns: "2.5rem 1fr", gridTemplateRows: `repeat(${lines.length}, auto) 1fr` }}
                >
                    {lines.map((line, i) => (
                        <Fragment key={i}>
                            <div
                                aria-hidden
                                style={{ gridRow: i + 1 }}
                                className="pr-3 text-right text-ink-faint select-none"
                            >
                                {i + 1}
                            </div>
                            {/* placed by row: the textarea already holds column 2, so auto-placement would skip it */}
                            <div
                                aria-hidden
                                style={{ gridRow: i + 1, gridColumn: 2 }}
                                className="invisible whitespace-pre-wrap break-words"
                            >
                                {line || " "}
                            </div>
                        </Fragment>
                    ))}
                    <textarea
                        aria-label="Instructions for every harness"
                        value={ed.draft}
                        spellCheck={false}
                        rows={1}
                        placeholder={placeholder}
                        onChange={(e) => onChange(e.target.value)}
                        style={{ gridColumn: 2, gridRow: "1 / -1" }}
                        className="h-full resize-none overflow-hidden border-0 bg-transparent p-0 text-secondary outline-none placeholder:text-muted"
                    />
                </div>
            </div>
        </div>
    );
}

function SharedEditor({ rows }: { rows: AgentSyncHarness[] }) {
    const ed = useAtomValue(setupSharedAtom);
    const path = useAtomValue(setupSharedPathAtom);
    const busy = useAtomValue(setupBusyAtom);
    const dirty = isDirty(ed);
    const n = saveTargetCount(rows);
    const changed = changedLineCount(ed.base, ed.draft);
    return (
        <div className="flex min-w-0 flex-1 flex-col gap-3 px-5 pb-5 pt-4">
            <div className="flex items-center gap-3.5">
                <div className="flex min-w-0 flex-col gap-[3px]">
                    <div className="text-[15px] font-semibold text-primary">Instructions for every harness</div>
                    <div className="text-[12px] text-muted">Saving writes this into each harness file below.</div>
                </div>
                <div className="flex-1" />
                {dirty ? (
                    <span className="text-[12px] text-accent-soft">
                        {changed} {changed === 1 ? "line" : "lines"} changed
                    </span>
                ) : null}
                <button
                    type="button"
                    disabled={!dirty || busy}
                    onClick={discardShared}
                    className={cn(BTN_SECONDARY, "h-8 text-[13px]")}
                >
                    Discard
                </button>
                <button
                    type="button"
                    disabled={!dirty || busy || n === 0}
                    onClick={() => fireAndForget(() => saveShared(false))}
                    className={BTN_PRIMARY}
                >
                    {busy ? "Saving…" : `Save to ${n} ${n === 1 ? "harness" : "harnesses"}`}
                </button>
            </div>
            <PaneReveal open={!!ed.conflict} variants={composerReveal} className="flex-none">
                <ConflictNotice
                    busy={busy}
                    onReload={() => fireAndForget(reloadShared)}
                    onOverwrite={() => fireAndForget(() => saveShared(true))}
                />
            </PaneReveal>
            <LineEditor
                ed={ed}
                path={path}
                onChange={typeShared}
                placeholder="The instructions every harness should follow. Saving writes them into each harness's file."
            />
        </div>
    );
}

function SharedRail({ rows }: { rows: AgentSyncHarness[] }) {
    const ed = useAtomValue(setupSharedAtom);
    return (
        <aside
            aria-label="Where this goes"
            className="flex w-[300px] flex-none flex-col gap-[18px] overflow-y-auto border-l border-border bg-surface px-4 py-[18px]"
        >
            <div className="flex flex-col gap-2">
                <div className={SECTION_HEAD}>How saving works</div>
                <p className="m-0 text-[12px] leading-[1.45] text-ink-mid">
                    Each harness file gets this doc between two Arc marker lines. Anything outside them is left alone.
                </p>
            </div>
            <div className="flex flex-col gap-2">
                <div className={SECTION_HEAD}>Saving writes to</div>
                {rows
                    .filter((r) => r.present)
                    .map((r) => (
                        <div
                            key={r.runtime}
                            className="flex flex-col gap-[3px] rounded border border-border px-2.5 py-2"
                        >
                            <span className="flex items-center gap-2 text-[12.5px] font-semibold text-secondary">
                                {r.label}
                            </span>
                            <PathTail path={r.path} />
                        </div>
                    ))}
            </div>
            <div className="flex-1" />
            <div className="text-[11.5px] leading-[1.5] text-muted">
                {ed.mtime > 0 ? `Last saved ${formatAgo(Math.max(0, Date.now() - ed.mtime))}.` : "Not saved yet."} Arc
                also re-applies this on every launch.
            </div>
        </aside>
    );
}

// ---- tab ----

export function InstructionsTab() {
    const rows = useRows();
    const error = useAtomValue(setupInstructionsErrorAtom);
    const status = useAtomValue(setupStatusAtom);
    // a failed first read shows its error with Retry in place of the content, so the banner would repeat it
    const firstReadFailed = status == null && error != null;
    return (
        <div className="flex min-h-0 flex-1">
            <FileList rows={rows} />
            <div className="flex min-w-0 flex-1 flex-col">
                <ErrorBanner error={firstReadFailed ? null : error} />
                <div className="flex min-h-0 flex-1">
                    {firstReadFailed ? (
                        <LoadFailed error={error} onRetry={retryLoad} />
                    ) : status == null ? (
                        <div className="flex flex-1 items-center justify-center text-[13px] text-muted">Reading…</div>
                    ) : (
                        <>
                            <SharedEditor rows={rows} />
                            <SharedRail rows={rows} />
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
