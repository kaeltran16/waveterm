// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Setup surface's Instructions tab: it edits the shared doc, which every save writes into each
// harness's file, and lists each harness file's state. Logic lives in setupmodel.ts, the RPCs and atoms
// in setupstore.ts.

import { composerReveal } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { cn, fireAndForget } from "@/util/util";
import useResizeObserver from "@react-hook/resize-observer";
import { useAtomValue } from "jotai";
import { Share2, TriangleAlert } from "lucide-react";
import { Fragment, useLayoutEffect, useState, type KeyboardEvent } from "react";
import { formatAgo } from "./agentsviewmodel";
import { PathTail } from "./pathtail";
import {
    changedLineCount,
    diskChanges,
    harnessRowLabel,
    harnessRowState,
    harnessRowTone,
    headerStatus,
    isDirty,
    lineCount,
    needsSync,
    saveTargetCount,
    type DocEditor,
    type Tone,
} from "./setupmodel";
import {
    BTN_PRIMARY,
    BTN_SECONDARY,
    Dot,
    ErrorBanner,
    FilePreview,
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
    syncNow,
    typeShared,
} from "./setupstore";

// below this tab width the "Where this goes" rail is not drawn: the file list already names every target
const RAIL_MIN_TAB_PX = 1200;
// a discard this size or smaller goes at once; a larger one asks first
const DISCARD_ASKS_ABOVE_LINES = 2;
// lines of an outside edit listed in the conflict notice before "+N more"
const DISK_LINES_SHOWN = 8;

function useRows(): AgentSyncHarness[] {
    return useAtomValue(setupStatusAtom)?.harnesses ?? [];
}

const retryLoad = () => fireAndForget(loadSetup);

function noteTone(t: string | undefined): Tone {
    return t === "ok" || t === "warn" ? t : "none";
}

export function InstructionsHeader() {
    const rows = useRows();
    const status = useAtomValue(setupStatusAtom);
    const busy = useAtomValue(setupBusyAtom);
    if (status == null) {
        return null;
    }
    const s = headerStatus(rows);
    return (
        <div data-instructions-header className="flex items-center gap-3">
            <div
                className={cn(
                    "flex items-center gap-2 text-[12px] whitespace-nowrap",
                    s.tone === "warn" ? "text-warning-soft" : "text-ink-mid"
                )}
            >
                <Dot tone={s.tone} size={7} />
                {s.text}
            </div>
            {needsSync(rows) ? (
                <button
                    type="button"
                    data-sync-now
                    disabled={busy}
                    onClick={() => fireAndForget(syncNow)}
                    className={BTN_SECONDARY}
                >
                    Sync now
                </button>
            ) : null}
        </div>
    );
}

// ---- left list ----

// null = the shared doc's editor; a runtime = that harness's file, read-only
type Shown = string | null;

const ROW = "flex w-full items-start gap-2.5 rounded border-0 px-2.5 py-[9px] text-left";
const ROW_SELECTED = "bg-surface-selected text-primary ring-1 ring-edge-strong ring-inset";
const ROW_IDLE = "cursor-pointer bg-transparent text-secondary hover:bg-surface-hover";

function FileList({ rows, shown, onShow }: { rows: AgentSyncHarness[]; shown: Shown; onShow: (s: Shown) => void }) {
    const shared = useAtomValue(setupSharedAtom);
    const status = useAtomValue(setupStatusAtom);
    const error = useAtomValue(setupInstructionsErrorAtom);
    return (
        <aside
            aria-label="Instruction files"
            className="flex w-[264px] flex-none flex-col gap-1 overflow-y-auto border-r border-border bg-surface px-2.5 py-3.5"
        >
            <div className={cn(SECTION_HEAD, "px-2 pb-1.5")}>Shared</div>
            <button
                type="button"
                data-instruction-row="shared"
                aria-pressed={shown == null}
                onClick={() => onShow(null)}
                className={cn(ROW, shown == null ? ROW_SELECTED : ROW_IDLE)}
            >
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
            </button>

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
                const selected = shown === r.runtime;
                return (
                    <button
                        key={r.runtime}
                        type="button"
                        data-instruction-row={r.runtime}
                        aria-pressed={selected}
                        disabled={!r.present}
                        onClick={() => onShow(r.runtime)}
                        className={cn(
                            ROW,
                            selected ? ROW_SELECTED : ROW_IDLE,
                            !r.present && "cursor-default opacity-50 hover:bg-transparent"
                        )}
                    >
                        <HarnessMark runtime={r.runtime} />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="text-[13px] font-medium">{r.label}</span>
                            <PathTail path={r.path} />
                            <span className={cn("mt-[3px] flex items-center gap-1.5 text-[11px]", TONE_TEXT[tone])}>
                                <Dot tone={tone} />
                                {harnessRowLabel(state)}
                            </span>
                            {r.note ? (
                                <span
                                    data-harness-note
                                    className={cn("text-[11px] leading-[1.4]", TONE_TEXT[noteTone(r.notetone)])}
                                >
                                    {r.note}
                                </span>
                            ) : null}
                        </span>
                    </button>
                );
            })}
        </aside>
    );
}

// ---- shared doc ----

function DiskLines({ label, lines }: { label: string; lines: string[] }) {
    if (lines.length === 0) {
        return null;
    }
    return (
        <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11.5px] font-semibold text-ink-mid">{label}</span>
            {lines.map((l, i) => (
                <span key={i} title={l} className="truncate font-mono text-[11.5px] text-secondary">
                    {l}
                </span>
            ))}
        </div>
    );
}

// what the outside edit added and dropped, at most DISK_LINES_SHOWN lines in all, added first
function DiskChangeList({ added, dropped }: { added: string[]; dropped: string[] }) {
    if (added.length + dropped.length === 0) {
        return null;
    }
    const shownAdded = added.slice(0, DISK_LINES_SHOWN);
    const shownDropped = dropped.slice(0, DISK_LINES_SHOWN - shownAdded.length);
    const more = added.length + dropped.length - shownAdded.length - shownDropped.length;
    return (
        <div data-disk-changes className="flex min-w-0 flex-col gap-2 pl-7">
            <DiskLines label="Added on disk" lines={shownAdded} />
            <DiskLines label="Dropped on disk" lines={shownDropped} />
            {more > 0 ? <span className="text-[11.5px] text-muted">+{more} more</span> : null}
        </div>
    );
}

function ConflictNotice({
    ed,
    onReload,
    onOverwrite,
    busy,
}: {
    ed: DocEditor;
    onReload: () => void;
    onOverwrite: () => void;
    busy: boolean;
}) {
    const changes = ed.disk == null ? null : diskChanges(ed.base, ed.disk);
    return (
        <div role="alert" className="flex flex-col gap-2 rounded border border-warning/30 bg-warning/10 px-3.5 py-2.5">
            <div className="flex items-center gap-3">
                <TriangleAlert size={16} strokeWidth={2} className="flex-none text-warning" />
                <span className="min-w-0 flex-1 text-[12.5px] text-secondary">
                    <span className="font-semibold text-warning-soft">Changed on disk since you opened it.</span>{" "}
                    {changes == null ? "The disk version could not be read. " : null}
                    Reload to take the file as it is now and lose your edits, or overwrite it with yours
                    {changes != null && changes.added.length > 0 ? ", which drops the lines added on disk." : "."}
                </span>
                <button type="button" disabled={busy} onClick={onReload} className={BTN_SECONDARY}>
                    Reload
                </button>
                <button type="button" disabled={busy} onClick={onOverwrite} className={BTN_SECONDARY}>
                    Overwrite
                </button>
            </div>
            {changes ? <DiskChangeList added={changes.added} dropped={changes.dropped} /> : null}
        </div>
    );
}

function LineEditor({
    ed,
    onChange,
    onSave,
    path,
    placeholder,
}: {
    ed: DocEditor;
    onChange: (v: string) => void;
    onSave: () => void;
    path: string;
    placeholder: string;
}) {
    const lines = ed.draft.split("\n");
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
            e.preventDefault();
            onSave();
        }
    };
    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded border border-edge-mid bg-surface-code focus-within:ring-2 focus-within:ring-accent/25">
            <div className="flex h-[30px] flex-none items-center gap-2.5 border-b border-edge-faint px-3 font-mono text-[11px] text-muted">
                <span title={path} className="min-w-0 truncate">
                    {path}
                </span>
                <span className="flex-1" />
                <span>Markdown</span>
                <span className="text-muted">·</span>
                <span className="whitespace-nowrap">
                    {lineCount(ed.draft)} {lineCount(ed.draft) === 1 ? "line" : "lines"}
                </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-2 pr-4 font-mono text-[12.5px] leading-[21px]">
                {/* lines soft-wrap, so each row holds a number beside an invisible copy of its line: the row
                    takes the wrapped height and the number stays level with the line the textarea draws over it.
                    the last 1fr row lets the textarea fill the rest of the box. minmax(0,1fr) and
                    overflow-wrap:anywhere on both copies keep an unbroken token from widening the column, so
                    the ghost and the textarea wrap at the same place. */}
                <div
                    className="grid min-h-full"
                    style={{
                        gridTemplateColumns: "2.5rem minmax(0,1fr)",
                        gridTemplateRows: `repeat(${lines.length}, auto) 1fr`,
                    }}
                >
                    {lines.map((line, i) => (
                        <Fragment key={i}>
                            <div
                                aria-hidden
                                data-line-number={i + 1}
                                style={{ gridRow: i + 1 }}
                                className="pr-3 text-right text-ink-faint select-none"
                            >
                                {i + 1}
                            </div>
                            {/* placed by row: the textarea already holds column 2, so auto-placement would skip it */}
                            <div
                                aria-hidden
                                data-ghost-line={i + 1}
                                style={{ gridRow: i + 1, gridColumn: 2 }}
                                className="invisible whitespace-pre-wrap [overflow-wrap:anywhere]"
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
                        onKeyDown={onKeyDown}
                        style={{ gridColumn: 2, gridRow: "1 / -1" }}
                        className="h-full min-w-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-secondary outline-none [overflow-wrap:anywhere] placeholder:text-muted"
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
    // the draft the Discard was armed on: typing changes the draft, which disarms it
    const [armedFor, setArmedFor] = useState<string | null>(null);
    const dirty = isDirty(ed);
    const n = saveTargetCount(rows);
    const changed = changedLineCount(ed.base, ed.draft);
    const armed = dirty && armedFor === ed.draft;
    const canSave = dirty && !busy && n > 0;
    const save = () => {
        if (canSave) {
            fireAndForget(() => saveShared(false));
        }
    };
    const discard = () => {
        if (changed > DISCARD_ASKS_ABOVE_LINES && !armed) {
            setArmedFor(ed.draft);
            return;
        }
        setArmedFor(null);
        discardShared();
    };
    return (
        <div className="flex min-w-0 flex-1 flex-col gap-3 px-5 pb-5 pt-4">
            <div className="flex items-center gap-3.5">
                <div className="flex min-w-0 flex-col gap-[3px]">
                    <div className="text-[15px] font-semibold text-primary">Instructions for every harness</div>
                    <div className="text-[12px] text-muted">
                        Saving writes this into each harness file listed on the left.{" "}
                        <span data-last-saved className="whitespace-nowrap">
                            {ed.mtime > 0
                                ? `Last saved ${formatAgo(Math.max(0, Date.now() - ed.mtime))}.`
                                : "Not saved yet."}
                        </span>
                    </div>
                </div>
                <div className="flex-1" />
                {dirty ? (
                    <span className="whitespace-nowrap text-[12px] text-accent-soft">
                        {changed} {changed === 1 ? "line" : "lines"} changed
                    </span>
                ) : null}
                {armed ? (
                    <button
                        type="button"
                        onClick={() => setArmedFor(null)}
                        className={cn(BTN_SECONDARY, "h-8 flex-none text-[13px]")}
                    >
                        Cancel
                    </button>
                ) : null}
                <button
                    type="button"
                    disabled={!dirty || busy}
                    onClick={discard}
                    className={cn(armed ? BTN_PRIMARY : cn(BTN_SECONDARY, "h-8 text-[13px]"), "flex-none")}
                >
                    {armed ? `Discard ${changed} lines` : "Discard"}
                </button>
                <button type="button" disabled={!canSave} onClick={save} className={cn(BTN_PRIMARY, "flex-none")}>
                    {busy ? "Saving…" : `Save to ${n} ${n === 1 ? "harness" : "harnesses"}`}
                </button>
            </div>
            <PaneReveal open={!!ed.conflict} variants={composerReveal} className="flex-none">
                <ConflictNotice
                    ed={ed}
                    busy={busy}
                    onReload={() => fireAndForget(reloadShared)}
                    onOverwrite={() => fireAndForget(() => saveShared(true))}
                />
            </PaneReveal>
            <LineEditor
                ed={ed}
                path={path}
                onChange={typeShared}
                onSave={save}
                placeholder="The instructions every harness should follow. Saving writes them into each harness's file."
            />
        </div>
    );
}

function HarnessPreview({ row }: { row: AgentSyncHarness }) {
    return (
        <div className="flex min-w-0 flex-1 flex-col gap-3 px-5 pb-5 pt-4">
            <div className="flex min-w-0 flex-col gap-[3px]">
                <div className="text-[15px] font-semibold text-primary">{row.label}</div>
                <div className="text-[12px] text-muted">
                    Read-only. Arc writes the shared doc between its marker lines; edit it under Shared.
                </div>
            </div>
            <FilePreview path={row.path} className="flex-1" />
        </div>
    );
}

function SharedRail({ rows }: { rows: AgentSyncHarness[] }) {
    return (
        <aside
            aria-label="Where this goes"
            className="flex w-[300px] flex-none flex-col gap-[18px] overflow-y-auto border-l border-border bg-surface px-4 py-[18px]"
        >
            <div className="flex flex-col gap-2">
                <div className={SECTION_HEAD}>How saving works</div>
                <p className="m-0 text-[12px] leading-[1.45] text-ink-mid">
                    Each harness file gets this doc between two Arc marker lines. Anything outside them is left alone.
                    Arc also re-applies it whenever it launches an agent.
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
        </aside>
    );
}

// ---- tab ----

// the tab's own width, so the rail follows the space the tab has rather than the window's
function useWidth(el: HTMLElement | null): number {
    const [width, setWidth] = useState(0);
    useLayoutEffect(() => {
        if (el) setWidth(el.clientWidth);
    }, [el]);
    useResizeObserver(el, (e) => setWidth(e.contentRect.width));
    return width;
}

export function InstructionsTab() {
    const rows = useRows();
    const error = useAtomValue(setupInstructionsErrorAtom);
    const status = useAtomValue(setupStatusAtom);
    const [shown, setShown] = useState<Shown>(null);
    const [root, setRoot] = useState<HTMLDivElement | null>(null);
    const width = useWidth(root);
    // a harness that is gone or no longer set up after a reload falls back to the shared doc
    const preview = rows.find((r) => r.runtime === shown && r.present) ?? null;
    // a failed first read shows its error with Retry in place of the content, so the banner would repeat it
    const firstReadFailed = status == null && error != null;
    return (
        <div ref={setRoot} className="flex min-h-0 min-w-0 flex-1">
            <FileList rows={rows} shown={preview?.runtime ?? null} onShow={setShown} />
            <div className="flex min-w-0 flex-1 flex-col">
                <ErrorBanner error={firstReadFailed ? null : error} />
                <div className="flex min-h-0 flex-1">
                    {firstReadFailed ? (
                        <LoadFailed error={error} onRetry={retryLoad} />
                    ) : status == null ? (
                        <div className="flex flex-1 items-center justify-center text-[13px] text-muted">Reading…</div>
                    ) : (
                        <>
                            {preview ? <HarnessPreview row={preview} /> : <SharedEditor rows={rows} />}
                            {width >= RAIL_MIN_TAB_PX ? <SharedRail rows={rows} /> : null}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
