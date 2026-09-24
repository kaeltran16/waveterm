// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Setup surface: the instructions and skills every harness reads. The Instructions tab edits the
// shared doc once and shows each harness's file as its three zones (own rules, the shared block, an old
// memory block); only the own zone is editable per harness. The Skills tab views every harness's skills
// and moves them into the vault; it never creates or edits one. Logic lives in setupmodel.ts and
// skillsmatrix.ts, the RPCs and the atoms in setupstore.ts.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Lock, Share2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import { formatAgo } from "./agentsviewmodel";
import { RuntimeMark } from "./runtimemark";
import { runtimeMeta } from "./runtimemeta";
import {
    changedLineCount,
    firstRunOffer,
    formatSize,
    harnessRowLabel,
    harnessRows,
    harnessRowState,
    harnessRowTone,
    headerStatus,
    isDirty,
    isFirstRun,
    joinLabels,
    lineCount,
    memoryNotices,
    previewLines,
    saveTargetCount,
    saveTargetNote,
    SHARED,
    sharedZoneStatus,
    type DocEditor,
    type HarnessRow,
    type Tone,
} from "./setupmodel";
import {
    adoptSkills,
    discardOwn,
    discardShared,
    dropMemory,
    foldIntoShared,
    loadSetup,
    loadSkills,
    openSkillFile,
    reloadOwn,
    reloadShared,
    saveOwn,
    saveShared,
    selectHarness,
    selectShared,
    selectSkill,
    setSkillKeep,
    setupBusyAtom,
    setupDocsAtom,
    setupErrorAtom,
    setupFreshStartAtom,
    setupOwnAtom,
    setupSelectionAtom,
    setupSharedAtom,
    setupSharedPathAtom,
    setupSkillKeepAtom,
    setupSkillsAtom,
    setupSkillSelectedAtom,
    setupStatusAtom,
    setupTabAtom,
    startEmptyPage,
    typeOwn,
    typeShared,
    type SetupTab,
} from "./setupstore";
import {
    adoptCount,
    copyDelta,
    manageLabel,
    skillFilePath,
    skillGroups,
    skillNote,
    skillsSummary,
    type SkillCell,
    type SkillGroup,
    type SkillRow,
} from "./skillsmatrix";

const SECTION_HEAD = "text-[10px] font-bold uppercase tracking-[0.08em] text-muted";
const BTN_SECONDARY =
    "h-[30px] cursor-pointer rounded border border-edge-mid bg-surface-raised px-3 text-[12.5px] font-semibold text-ink-mid hover:border-edge-strong hover:bg-surface-hover hover:text-primary disabled:cursor-default disabled:text-ink-faint disabled:hover:border-edge-mid disabled:hover:bg-surface-raised";
const BTN_PRIMARY =
    "h-8 cursor-pointer rounded border-0 bg-accent px-[14px] text-[13px] font-bold text-background shadow-inset-highlight hover:bg-accenthover disabled:cursor-default disabled:opacity-40 disabled:hover:bg-accent";
const LINK = "cursor-pointer border-0 bg-transparent p-0 font-semibold text-accent hover:text-accenthover";
const PREVIEW_LINES = 4;

const TONE_DOT: Record<Tone, string> = { ok: "bg-success", warn: "bg-warning", none: "bg-ink-faint" };
const TONE_TEXT: Record<Tone, string> = { ok: "text-ink-mid", warn: "text-warning-soft", none: "text-muted" };

const TABS: { key: SetupTab; label: string }[] = [
    { key: "instructions", label: "Instructions" },
    { key: "skills", label: "Skills" },
];

function useRows(): HarnessRow[] {
    const status = useAtomValue(setupStatusAtom);
    const docs = useAtomValue(setupDocsAtom);
    return harnessRows(status?.harnesses ?? [], docs);
}

function useFirstRun(): boolean {
    const status = useAtomValue(setupStatusAtom);
    const shared = useAtomValue(setupSharedAtom);
    const fresh = useAtomValue(setupFreshStartAtom);
    // nothing is known before the first load; a draft means the user is already past the offer
    return status != null && isFirstRun(shared.base, fresh || isDirty(shared));
}

function Dot({ tone, size = 6 }: { tone: Tone; size?: 6 | 7 }) {
    return (
        <span
            className={cn("flex-none rounded-full", TONE_DOT[tone], size === 7 ? "h-[7px] w-[7px]" : "h-1.5 w-1.5")}
        />
    );
}

function HarnessMark({ runtime, large }: { runtime: string; large?: boolean }) {
    const meta = runtimeMeta(runtime);
    return (
        <span
            className={cn(
                "flex flex-none items-center justify-center rounded-[5px] border font-mono text-[9.5px] font-bold",
                meta.line,
                meta.text,
                large ? "h-[26px] w-[26px] rounded-md" : "h-5 w-5"
            )}
        >
            <RuntimeMark runtime={runtime} imageClassName={large ? "h-3.5 w-3.5" : "h-3 w-3"} />
        </span>
    );
}

function Tabs() {
    const tab = useAtomValue(setupTabAtom);
    const onKey = (e: KeyboardEvent) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
            return;
        }
        e.preventDefault();
        const i = TABS.findIndex((t) => t.key === tab);
        const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
        globalStore.set(setupTabAtom, next.key);
        document.getElementById(`setup-tab-${next.key}`)?.focus();
    };
    return (
        <div
            role="tablist"
            aria-label="Setup"
            onKeyDown={onKey}
            className="flex gap-0.5 rounded border border-border bg-surface p-[3px]"
        >
            {TABS.map((t) => (
                <button
                    key={t.key}
                    id={`setup-tab-${t.key}`}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.key}
                    aria-controls="setup-tabpanel"
                    tabIndex={tab === t.key ? 0 : -1}
                    onClick={() => globalStore.set(setupTabAtom, t.key)}
                    className={cn(
                        "cursor-pointer rounded-md border-0 px-3 py-[5px] text-[13px]",
                        tab === t.key
                            ? "bg-surface-selected font-semibold text-primary"
                            : "bg-transparent font-medium text-ink-mid hover:text-primary"
                    )}
                >
                    {t.label}
                </button>
            ))}
        </div>
    );
}

function HeaderStatus() {
    const rows = useRows();
    const firstRun = useFirstRun();
    const status = useAtomValue(setupStatusAtom);
    if (status == null) {
        return null;
    }
    const s = headerStatus(rows, firstRun);
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

function FileList({ rows, firstRun }: { rows: HarnessRow[]; firstRun: boolean }) {
    const selection = useAtomValue(setupSelectionAtom);
    const shared = useAtomValue(setupSharedAtom);
    const status = useAtomValue(setupStatusAtom);
    const sharedEmpty = shared.base.trim() === "";
    const rowClass = (selected: boolean) =>
        cn(
            "flex w-full cursor-pointer items-start gap-2.5 rounded border-0 px-2.5 py-[9px] text-left",
            selected
                ? "bg-surface-selected text-primary ring-1 ring-edge-strong ring-inset"
                : "bg-transparent text-secondary hover:bg-surface-hover"
        );
    return (
        <nav
            aria-label="Instruction files"
            className="flex w-[264px] flex-none flex-col gap-1 overflow-y-auto border-r border-border bg-surface px-2.5 py-3.5"
        >
            <div className={cn(SECTION_HEAD, "px-2 pb-1.5")}>Shared</div>
            <button
                type="button"
                aria-current={selection === SHARED ? "page" : undefined}
                onClick={selectShared}
                className={rowClass(selection === SHARED)}
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
                    {firstRun ? (
                        <span className="text-[11px] text-ink-mid">Not created yet</span>
                    ) : (
                        <span className="font-mono text-[10.5px] text-muted">vault/steering/AGENTS.md</span>
                    )}
                </span>
            </button>

            <div className={cn(SECTION_HEAD, "px-2 pb-1.5 pt-4")}>Harness files</div>
            {status == null ? <div className="px-2 text-[12px] text-muted">Reading…</div> : null}
            {rows.map((r) => {
                const state = harnessRowState(r.present, r.doc, sharedEmpty);
                const tone = harnessRowTone(state);
                return (
                    <button
                        key={r.runtime}
                        type="button"
                        aria-current={selection === r.runtime ? "page" : undefined}
                        onClick={() => selectHarness(r.runtime)}
                        className={cn(rowClass(selection === r.runtime), !r.present && "opacity-50")}
                    >
                        <HarnessMark runtime={r.runtime} />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="text-[13px] font-medium">{r.label}</span>
                            <span title={r.path} className="truncate font-mono text-[10.5px] text-muted">
                                {r.path}
                            </span>
                            <span className={cn("mt-[3px] flex items-center gap-1.5 text-[11px]", TONE_TEXT[tone])}>
                                <Dot tone={tone} />
                                {harnessRowLabel(state, r.doc?.carried ?? 0)}
                            </span>
                        </span>
                    </button>
                );
            })}
        </nav>
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
    const gutter = useRef<HTMLDivElement>(null);
    const n = Math.max(1, ed.draft.split("\n").length);
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-edge-mid bg-surface-code focus-within:ring-2 focus-within:ring-accent/25">
            <div className="flex h-[30px] flex-none items-center gap-2.5 border-b border-edge-faint px-3 font-mono text-[11px] text-muted">
                <span title={path} className="min-w-0 truncate">
                    {path}
                </span>
                <span className="flex-1" />
                <span>Markdown</span>
                <span className="text-ink-faint">·</span>
                <span>
                    {lineCount(ed.draft)} {lineCount(ed.draft) === 1 ? "line" : "lines"}
                </span>
            </div>
            <div className="flex min-h-0 flex-1 font-mono text-[12.5px] leading-[21px]">
                {/* the gutter follows the textarea's scroll, so the numbers stay beside their lines */}
                <div
                    ref={gutter}
                    aria-hidden
                    className="w-10 flex-none overflow-hidden py-2 pr-3 text-right text-ink-faint select-none"
                >
                    {Array.from({ length: n }, (_, i) => (
                        <div key={i}>{i + 1}</div>
                    ))}
                </div>
                <textarea
                    aria-label="Instructions for every harness"
                    value={ed.draft}
                    spellCheck={false}
                    wrap="off"
                    placeholder={placeholder}
                    onChange={(e) => onChange(e.target.value)}
                    onScroll={(e) => {
                        if (gutter.current) {
                            gutter.current.scrollTop = e.currentTarget.scrollTop;
                        }
                    }}
                    className="min-h-0 flex-1 resize-none border-0 bg-transparent py-2 pr-4 text-secondary outline-none placeholder:text-muted"
                />
            </div>
        </div>
    );
}

function SharedEditor({ rows }: { rows: HarnessRow[] }) {
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
                    <div className="text-[12px] text-muted">
                        Saving writes this into each harness file below. Their own rules stay as they are.
                    </div>
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
            {ed.conflict ? (
                <ConflictNotice
                    busy={busy}
                    onReload={() => fireAndForget(reloadShared)}
                    onOverwrite={() => fireAndForget(() => saveShared(true))}
                />
            ) : null}
            <LineEditor
                ed={ed}
                path={path}
                onChange={typeShared}
                placeholder="The instructions every harness should follow. Saving writes them into each harness's file, above anything already there."
            />
        </div>
    );
}

function SharedRail({ rows }: { rows: HarnessRow[] }) {
    const ed = useAtomValue(setupSharedAtom);
    const zone = "flex flex-col gap-[3px] px-3 py-2.5";
    return (
        <aside
            aria-label="Where this goes"
            className="flex w-[300px] flex-none flex-col gap-[18px] overflow-y-auto border-l border-border bg-surface px-4 py-[18px]"
        >
            <div className="flex flex-col gap-2.5">
                <div className={SECTION_HEAD}>How each harness file is split</div>
                <div className="flex flex-col overflow-hidden rounded border border-edge-mid text-[12px]">
                    <div className={cn(zone, "bg-surface-raised")}>
                        <span className="font-semibold text-primary">That harness's own rules</span>
                        <span className="leading-[1.45] text-ink-mid">
                            Yours. Edit them on the harness's page. Arc never overwrites them.
                        </span>
                    </div>
                    <div className={cn(zone, "border-t border-edge-mid bg-accentbg")}>
                        <span className="font-semibold text-accent-soft">These instructions</span>
                        <span className="leading-[1.45] text-secondary">
                            Replaced on every save, the same text in every harness.
                        </span>
                    </div>
                    <div className={cn(zone, "border-t border-edge-mid bg-surface-raised")}>
                        <span className="font-semibold text-ink-mid">Old memory block</span>
                        <span className="leading-[1.45] text-muted">
                            Left by an older Arc. Kept as is; nothing updates it.
                        </span>
                    </div>
                </div>
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
                                <span className="ml-auto text-[11px] font-normal text-muted">
                                    {saveTargetNote(r.doc)}
                                </span>
                            </span>
                            <span title={r.path} className="truncate font-mono text-[10.5px] text-muted">
                                {r.path}
                            </span>
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

// ---- first run ----

function Preview({ text, className }: { text: string; className?: string }) {
    const p = previewLines(text, PREVIEW_LINES);
    return (
        <div
            className={cn(
                "overflow-hidden rounded-md bg-surface-code px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre",
                className
            )}
        >
            {p.lines.map((l, i) => (
                <div key={i} className={cn("truncate", l.startsWith("#") && "font-semibold text-accent-soft")}>
                    {l || " "}
                </div>
            ))}
            {p.more > 0 ? (
                <div className="text-ink-faint">
                    … {p.more} more {p.more === 1 ? "line" : "lines"}
                </div>
            ) : null}
        </div>
    );
}

function FirstRun({ rows }: { rows: HarnessRow[] }) {
    const busy = useAtomValue(setupBusyAtom);
    const offer = firstRunOffer(rows);
    const n = saveTargetCount(rows);
    const others = rows.filter((r) => r.present && r.runtime !== offer?.runtime).map((r) => r.label);
    const notices = memoryNotices(rows);
    return (
        <div className="flex min-w-0 flex-1 justify-center overflow-y-auto px-10 py-14">
            <div className="flex w-full max-w-[640px] flex-col gap-[22px]">
                <div className="flex flex-col gap-2">
                    <h1 className="m-0 text-[18px] font-semibold text-primary">
                        {offer ? `Your rules only reach ${offer.label}` : "No shared instructions yet"}
                    </h1>
                    <p className="m-0 text-[13.5px] leading-[1.6] text-ink-mid">
                        {offer ? (
                            <>
                                Your preferences are in{" "}
                                <span className="font-mono text-[12.5px] text-secondary">{offer.path}</span> and nowhere
                                else.{" "}
                                {others.length > 0
                                    ? `Arc has no shared copy to write into ${joinLabels(others)}, so they start every session without them.`
                                    : "Arc has no shared copy of them yet."}
                            </>
                        ) : (
                            "None of your harnesses holds rules of its own. Write the instructions every harness should follow, and each save writes them into every harness's file."
                        )}
                    </p>
                </div>

                {offer ? (
                    <div className="flex flex-col gap-2.5 rounded-lg border border-edge-mid bg-surface-raised p-4">
                        <div className="flex items-center gap-2.5">
                            <HarnessMark runtime={offer.runtime} />
                            <span className="text-[13.5px] font-semibold text-primary">
                                Start from {offer.label}'s rules
                            </span>
                            <span className="text-[12px] text-muted">
                                {offer.lines} {offer.lines === 1 ? "line" : "lines"}
                            </span>
                        </div>
                        <Preview text={offer.rules} className="text-ink-mid" />
                        <div className="flex flex-col gap-1.5 text-[12.5px] text-secondary">
                            <span className={SECTION_HEAD}>This will</span>
                            <span className="flex gap-2">
                                <span className="text-success">1</span>Save these {offer.lines} lines as your shared
                                instructions
                            </span>
                            {others.length > 0 ? (
                                <span className="flex gap-2">
                                    <span className="text-success">2</span>Write them into {joinLabels(others)}, above
                                    anything already there
                                </span>
                            ) : null}
                            <span className="flex gap-2">
                                <span className="text-success">{others.length > 0 ? 3 : 2}</span>Leave {offer.label}'s
                                file as it is: it already has them
                            </span>
                        </div>
                        <div className="flex gap-2 pt-1">
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => fireAndForget(() => foldIntoShared(offer.runtime, false))}
                                className={cn(BTN_PRIMARY, "h-[34px]")}
                            >
                                Share with all {n} {n === 1 ? "harness" : "harnesses"}
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => fireAndForget(() => foldIntoShared(offer.runtime, true))}
                                className={cn(BTN_SECONDARY, "h-[34px] text-[13px]")}
                            >
                                Edit first
                            </button>
                        </div>
                    </div>
                ) : null}

                <div className="flex items-center gap-3 text-[12.5px] text-muted">
                    {offer ? <span>Or</span> : null}
                    <button type="button" onClick={startEmptyPage} className={LINK}>
                        {offer ? "start with an empty page" : "Start with an empty page"}
                    </button>
                </div>

                {notices.length > 0 ? (
                    <div className="flex gap-2.5 rounded border border-warning/30 px-3.5 py-3 text-[12.5px] leading-[1.55] text-secondary">
                        <TriangleAlert size={16} strokeWidth={2} className="mt-px flex-none text-warning" />
                        <span>
                            {notices.map((m, i) => (
                                <span key={m.runtime}>
                                    {i > 0 ? (i === notices.length - 1 ? " and " : ", ") : null}
                                    <button type="button" onClick={() => selectHarness(m.runtime)} className={LINK}>
                                        {m.label}
                                    </button>{" "}
                                    ({formatSize(m.bytes)})
                                </span>
                            ))}{" "}
                            {notices.length === 1 ? "loads" : "each load"} an old memory block from an older Arc in
                            every session. You can remove it from {notices.length === 1 ? "its page" : "their pages"}.
                        </span>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

// ---- one harness ----

function Zone({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
    return (
        <section aria-label={label} className={cn("flex flex-none flex-col gap-2.5 rounded p-3.5", className)}>
            {children}
        </section>
    );
}

function OwnZone({ row }: { row: HarnessRow }) {
    const own = useAtomValue(setupOwnAtom);
    const busy = useAtomValue(setupBusyAtom);
    if (own == null || own.runtime !== row.runtime) {
        return null;
    }
    const ed = own.editor;
    const dirty = isDirty(ed);
    const carried = row.doc?.carried ?? 0;
    const id = `setup-own-${row.runtime}`;
    return (
        <Zone label={`${row.label}-only rules`} className="border border-edge-mid bg-surface-raised">
            <div className="flex items-center gap-2.5">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <label htmlFor={id} className="text-[13px] font-semibold text-primary">
                        Rules only {row.label} follows
                    </label>
                    <span className="text-[12px] text-muted">
                        Kept at the top of this file. Other harnesses never see them, and a shared save leaves them
                        alone.
                    </span>
                </div>
                <div className="flex-1" />
                {dirty ? (
                    <button type="button" disabled={busy} onClick={discardOwn} className={BTN_SECONDARY}>
                        Discard
                    </button>
                ) : null}
                <button
                    type="button"
                    disabled={busy || dirty || carried === 0}
                    title={dirty ? "Save or discard this edit first" : undefined}
                    onClick={() => fireAndForget(() => foldIntoShared(row.runtime, false))}
                    className={BTN_SECONDARY}
                >
                    Move into shared
                </button>
                <button
                    type="button"
                    disabled={busy || !dirty}
                    onClick={() => fireAndForget(() => saveOwn(false))}
                    className={BTN_SECONDARY}
                >
                    Save
                </button>
            </div>
            {ed.conflict ? (
                <ConflictNotice
                    busy={busy}
                    onReload={() => fireAndForget(reloadOwn)}
                    onOverwrite={() => fireAndForget(() => saveOwn(true))}
                />
            ) : null}
            <textarea
                id={id}
                value={ed.draft}
                spellCheck={false}
                placeholder={`Nothing ${row.label}-only yet. Write a rule here that only ${row.label} should follow.`}
                onChange={(e) => typeOwn(e.target.value)}
                className="field-sizing-content max-h-[360px] min-h-[112px] resize-none rounded-md border border-edge-mid bg-surface-code px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] text-secondary outline-none placeholder:text-muted focus:border-accent/40"
            />
        </Zone>
    );
}

function SharedZone({ row }: { row: HarnessRow }) {
    if (row.doc == null) {
        return null;
    }
    const s = sharedZoneStatus(row.doc);
    return (
        <Zone label="Shared instructions" className="gap-2 border border-dashed border-edge-strong">
            <div className="flex items-center gap-2.5">
                <Lock size={14} strokeWidth={2} className="flex-none text-muted" />
                <span className="text-[13px] font-semibold text-secondary">Instructions for every harness</span>
                <span className={cn("flex items-center gap-1.5 text-[11.5px]", TONE_TEXT[s.tone])}>
                    <Dot tone={s.tone} />
                    {s.text}
                </span>
                <div className="flex-1" />
                <button type="button" onClick={selectShared} className={cn(LINK, "text-[12.5px]")}>
                    Edit shared
                </button>
            </div>
            {row.doc.shared.trim() !== "" ? <Preview text={row.doc.shared} className="text-muted" /> : null}
        </Zone>
    );
}

function MemoryZone({ row }: { row: HarnessRow }) {
    const busy = useAtomValue(setupBusyAtom);
    const [open, setOpen] = useState(false);
    // a destructive action with no modal: the first click arms it, the second removes
    const [armed, setArmed] = useState(false);
    const memory = row.doc?.memory ?? "";
    if (memory === "") {
        return null;
    }
    const n = lineCount(memory);
    return (
        <div className="flex flex-none flex-col gap-2">
            <section
                aria-label="Old memory block"
                className="flex items-center gap-3 rounded border border-warning/30 bg-warning/10 px-3.5 py-3"
            >
                <TriangleAlert size={16} strokeWidth={2} className="flex-none text-warning" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[13px] font-semibold text-warning-soft">
                        Old memory block · {n} {n === 1 ? "line" : "lines"}
                    </span>
                    <span className="text-[12px] text-secondary">
                        Left by an older Arc. Nothing updates it, but {row.label} still loads it in every session.
                    </span>
                </div>
                <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={BTN_SECONDARY}>
                    {open ? "Hide" : "Show"}
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onBlur={() => setArmed(false)}
                    onClick={() => {
                        if (!armed) {
                            setArmed(true);
                            return;
                        }
                        setArmed(false);
                        fireAndForget(() => dropMemory(row.runtime));
                    }}
                    className={cn(
                        BTN_SECONDARY,
                        "text-error-soft hover:text-error-soft",
                        armed && "border-error/50 bg-error/15"
                    )}
                >
                    {armed ? "Click again to remove" : "Remove from file"}
                </button>
            </section>
            {open ? (
                <pre className="m-0 max-h-[420px] overflow-auto rounded border border-edge-faint bg-surface-code px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap text-muted">
                    {memory}
                </pre>
            ) : null}
        </div>
    );
}

function HarnessPane({ row }: { row: HarnessRow }) {
    if (!row.present) {
        return (
            <div className="flex flex-1 items-center justify-center px-10 text-[13px] text-muted">
                {row.label} has never run on this machine, so it has no config directory. Arc never creates one.
            </div>
        );
    }
    return (
        <div className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 pb-5 pt-4">
            <div className="flex items-center gap-3">
                <HarnessMark runtime={row.runtime} large />
                <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="text-[15px] font-semibold text-primary">{row.label}</div>
                    <div title={row.path} className="truncate font-mono text-[11px] text-muted">
                        {row.path} · loaded into every {row.label} session
                    </div>
                </div>
            </div>
            <OwnZone row={row} />
            <SharedZone row={row} />
            <MemoryZone key={row.runtime} row={row} />
        </div>
    );
}

// ---- tabs ----

function InstructionsTab() {
    const rows = useRows();
    const firstRun = useFirstRun();
    const selection = useAtomValue(setupSelectionAtom);
    const error = useAtomValue(setupErrorAtom);
    const status = useAtomValue(setupStatusAtom);
    const selected = rows.find((r) => r.runtime === selection);
    let main: ReactNode;
    if (status == null) {
        main = <div className="flex flex-1 items-center justify-center text-[13px] text-muted">Reading…</div>;
    } else if (selected != null) {
        main = <HarnessPane row={selected} />;
    } else if (firstRun) {
        main = <FirstRun rows={rows} />;
    } else {
        main = (
            <>
                <SharedEditor rows={rows} />
                <SharedRail rows={rows} />
            </>
        );
    }
    return (
        <div className="flex min-h-0 flex-1">
            <FileList rows={rows} firstRun={firstRun} />
            <div className="flex min-w-0 flex-1 flex-col">
                {error ? (
                    <div
                        role="alert"
                        className="flex-none border-b border-error/30 bg-error/10 px-5 py-2 text-[12.5px] text-error-soft"
                    >
                        {error}
                    </div>
                ) : null}
                <div className="flex min-h-0 flex-1">{main}</div>
            </div>
        </div>
    );
}

// ---- skills ----

const SKILL_COLUMN_WIDTH = "118px";

function useSkillGroups(): { data: CommandAgentSyncSkillsRtnData | null; groups: SkillGroup[] } {
    const data = useAtomValue(setupSkillsAtom);
    const keep = useAtomValue(setupSkillKeepAtom);
    return { data, groups: data == null ? [] : skillGroups(data, keep) };
}

function SkillsHeader() {
    const data = useAtomValue(setupSkillsAtom);
    const keep = useAtomValue(setupSkillKeepAtom);
    const busy = useAtomValue(setupBusyAtom);
    if (data == null) {
        return null;
    }
    const n = adoptCount(data, keep);
    return (
        <>
            <span className="text-[12px] text-ink-mid">{skillsSummary(data)}</span>
            <button
                type="button"
                disabled={busy || n === 0}
                onClick={() => fireAndForget(adoptSkills)}
                className={BTN_PRIMARY}
            >
                {manageLabel(n)}
            </button>
        </>
    );
}

function SkillCellView({ cell }: { cell: SkillCell }) {
    return (
        <span
            role="cell"
            title={cell.title}
            className={cn(
                "flex min-w-0 items-center gap-1.5 text-[11.5px]",
                cell.tone == null ? "text-ink-faint" : TONE_TEXT[cell.tone]
            )}
        >
            {cell.tone != null ? <Dot tone={cell.tone} /> : null}
            <span className="truncate">{cell.label}</span>
        </span>
    );
}

function SkillsMatrix({
    columns,
    groups,
    selected,
}: {
    columns: AgentSyncSkillColumn[];
    groups: SkillGroup[];
    selected: string | null;
}) {
    // the column count comes from the backend, so the template cannot be a static utility
    const grid = { gridTemplateColumns: `minmax(0, 1fr) repeat(${columns.length}, ${SKILL_COLUMN_WIDTH})` };
    const onKey = (e: KeyboardEvent, name: string) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectSkill(name);
        }
    };
    return (
        <div
            role="table"
            aria-label="Skills by harness"
            className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-edge-mid bg-surface"
        >
            <div
                role="row"
                style={grid}
                className="grid min-h-9 flex-none items-center border-b border-edge-mid bg-surface-raised px-3 py-1 text-[11px] font-bold tracking-[0.04em] text-ink-mid"
            >
                <span role="columnheader">Skill</span>
                {columns.map((c) => (
                    <span key={c.runtime} role="columnheader" className="flex min-w-0 flex-col gap-px">
                        <span className="flex items-center gap-1.5">
                            <HarnessMark runtime={c.runtime} />
                            <span className="truncate">{c.label}</span>
                        </span>
                        {c.present ? null : (
                            <span className="text-[9.5px] font-semibold tracking-normal text-warning">not set up</span>
                        )}
                    </span>
                ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                {groups.length === 0 ? (
                    <div className="px-3 py-6 text-center text-[12.5px] text-muted">No skills in any harness.</div>
                ) : null}
                {groups.map((g) => (
                    <div key={g.key} role="rowgroup" aria-label={g.title}>
                        <div className="flex h-[26px] items-center gap-2 border-b border-edge-faint bg-background px-3 text-[10px] font-bold uppercase tracking-[0.08em] text-muted">
                            {g.title}
                            <span className="font-medium normal-case tracking-normal text-ink-faint">
                                · {g.rows.length}
                            </span>
                        </div>
                        {g.rows.map((r) => (
                            <div
                                key={r.name}
                                role="row"
                                tabIndex={0}
                                aria-selected={r.name === selected}
                                onClick={() => selectSkill(r.name)}
                                onKeyDown={(e) => onKey(e, r.name)}
                                style={grid}
                                className={cn(
                                    "grid h-7 cursor-pointer items-center border-b border-edge-faint px-3 outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset",
                                    r.name === selected
                                        ? "bg-surface-selected shadow-[inset_2px_0_0_var(--color-accent)]"
                                        : "hover:bg-surface-hover"
                                )}
                            >
                                <span role="cell" className="truncate font-mono text-[12px] text-ink-hi">
                                    {r.name}
                                </span>
                                {r.cells.map((c) => (
                                    <SkillCellView key={c.runtime} cell={c} />
                                ))}
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}

function KeepChoice({ row }: { row: SkillRow }) {
    const keep = useAtomValue(setupSkillKeepAtom);
    const chosen = keep[row.name] ?? null;
    const option = (runtime: string | null, title: string, hint: string) => (
        <label
            key={runtime ?? ""}
            className={cn(
                "flex cursor-pointer items-start gap-2 rounded px-2.5 py-2 text-[12.5px] text-secondary",
                chosen === runtime ? "bg-surface-selected ring-1 ring-edge-strong ring-inset" : "hover:bg-surface-hover"
            )}
        >
            <input
                type="radio"
                name={`skill-keep-${row.name}`}
                checked={chosen === runtime}
                onChange={() => setSkillKeep(row.name, runtime)}
                className="mt-0.5 accent-accent"
            />
            <span className="flex flex-col gap-0.5">
                <span className="font-semibold">{title}</span>
                <span className="text-[11.5px] text-muted">{hint}</span>
            </span>
        </label>
    );
    return (
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className={cn(SECTION_HEAD, "pb-1.5")}>When Arc manages it</legend>
            {row.copies.map((c) =>
                option(c.runtime, `Keep ${c.label}'s copy`, "Every harness gets it. The other copies are set aside.")
            )}
            {option(null, "Leave these copies alone", "Arc skips this skill; each harness keeps its own file.")}
        </fieldset>
    );
}

function SkillRail({ model, row, skillsroot }: { model: AgentsViewModel; row: SkillRow; skillsroot: string }) {
    const keep = useAtomValue(setupSkillKeepAtom);
    const busy = useAtomValue(setupBusyAtom);
    const differs = row.kind === "decide" || row.kind === "differs";
    const card = "flex flex-col gap-[5px] rounded border border-border px-2.5 py-[9px]";
    return (
        <aside
            aria-label="Skill detail"
            className="flex w-[360px] flex-none flex-col gap-3.5 overflow-y-auto border-l border-border bg-surface p-4"
        >
            <div className="flex flex-col gap-1.5">
                <div className="font-mono text-[14px] font-medium text-primary">{row.name}</div>
                <div className="text-[12.5px] leading-[1.5] text-ink-mid">{skillNote(row)}</div>
            </div>
            <div className="flex flex-col gap-2">
                <div className={SECTION_HEAD}>{differs ? "What differs" : "Where it lives"}</div>
                {row.kind === "managed" ? (
                    <>
                        <div className={card}>
                            <span className="text-[12.5px] font-semibold text-secondary">Arc vault</span>
                            <span className="truncate font-mono text-[10.5px] text-muted">
                                {skillFilePath(row, skillsroot, keep)}
                            </span>
                        </div>
                        {Object.entries(row.deltas).map(([runtime, over]) => (
                            <div key={runtime} className={card}>
                                <span className="flex items-center gap-2 text-[12.5px] font-semibold text-secondary">
                                    <HarnessMark runtime={runtime} />
                                    {runtimeMeta(runtime).label}
                                </span>
                                <span className="font-mono text-[10.5px] text-muted">Overrides {over.join(", ")}</span>
                            </div>
                        ))}
                    </>
                ) : (
                    row.copies.map((c) => (
                        <div key={c.runtime} className={card}>
                            <span className="flex items-center gap-2 text-[12.5px] font-semibold text-secondary">
                                <HarnessMark runtime={c.runtime} />
                                {c.label}
                                {differs ? (
                                    <span className="ml-auto text-[11px] font-normal text-muted">{copyDelta(c)}</span>
                                ) : null}
                            </span>
                            <span title={c.path} className="truncate font-mono text-[10.5px] text-muted">
                                {c.path}
                            </span>
                        </div>
                    ))
                )}
            </div>
            {row.needsKeep ? <KeepChoice row={row} /> : null}
            <div className="flex-1" />
            <div className="flex gap-2">
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => fireAndForget(() => openSkillFile(model, skillFilePath(row, skillsroot, keep)))}
                    className={BTN_SECONDARY}
                >
                    Open SKILL.md
                </button>
            </div>
        </aside>
    );
}

function SkillsTab({ model }: { model: AgentsViewModel }) {
    const { data, groups } = useSkillGroups();
    const selectedName = useAtomValue(setupSkillSelectedAtom);
    const error = useAtomValue(setupErrorAtom);
    // re-read on every visit: an agent may have written a skill since
    useEffect(() => {
        fireAndForget(loadSkills);
    }, []);
    const rows = groups.flatMap((g) => g.rows);
    const selected = rows.find((r) => r.name === selectedName) ?? rows[0] ?? null;
    return (
        <div className="flex min-w-0 flex-1 flex-col">
            {error ? (
                <div
                    role="alert"
                    className="flex-none border-b border-error/30 bg-error/10 px-5 py-2 text-[12.5px] text-error-soft"
                >
                    {error}
                </div>
            ) : null}
            <div className="flex min-h-0 flex-1">
                {data == null ? (
                    <div className="flex flex-1 items-center justify-center text-[13px] text-muted">Reading…</div>
                ) : (
                    <>
                        <div className="flex min-w-0 flex-1 flex-col px-5 pb-4 pt-3.5">
                            <SkillsMatrix
                                columns={data.columns ?? []}
                                groups={groups}
                                selected={selected?.name ?? null}
                            />
                        </div>
                        {selected != null ? (
                            <SkillRail model={model} row={selected} skillsroot={data.skillsroot} />
                        ) : null}
                    </>
                )}
            </div>
        </div>
    );
}

export function SetupSurface({ model }: { model: AgentsViewModel }) {
    const tab = useAtomValue(setupTabAtom);
    // re-read on every visit: a harness file edited outside Arc must not show stale
    useEffect(() => {
        fireAndForget(loadSetup);
    }, []);
    return (
        <div className="flex h-full min-h-0 flex-col bg-background">
            <div className="flex h-[52px] flex-none items-center gap-5 border-b border-border px-5">
                <div className="text-[15px] font-semibold text-primary">Setup</div>
                <Tabs />
                <div className="flex-1" />
                {tab === "instructions" ? <HeaderStatus /> : <SkillsHeader />}
            </div>
            <div
                id="setup-tabpanel"
                role="tabpanel"
                aria-labelledby={`setup-tab-${tab}`}
                className="flex min-h-0 flex-1"
            >
                {tab === "instructions" ? <InstructionsTab /> : <SkillsTab model={model} />}
            </div>
        </div>
    );
}
