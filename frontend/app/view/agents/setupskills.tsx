// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Setup surface's Skills tab: it views every harness's skills and moves them into the vault; it never
// creates or edits one. Logic lives in skillsmatrix.ts, the RPCs and atoms in setupskillsstore.ts.

import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useEffect, useState, type KeyboardEvent } from "react";
import type { AgentsViewModel } from "./agents";
import { PathTail } from "./pathtail";
import { runtimeMeta } from "./runtimemeta";
import {
    BTN_PRIMARY,
    BTN_SECONDARY,
    Dot,
    ErrorBanner,
    FADE_IN,
    FilePreview,
    HarnessMark,
    LoadFailed,
    SECTION_HEAD,
    TONE_TEXT,
} from "./setupparts";
import {
    adoptSkills,
    loadSkills,
    selectSkill,
    setSkillKeep,
    setupSkillKeepAtom,
    setupSkillsAtom,
    setupSkillSelectedAtom,
    setupSkillsErrorAtom,
} from "./setupskillsstore";
import { setupBusyAtom, setupStatusAtom } from "./setupstore";
import {
    adoptCount,
    copyDelta,
    KEEP_LEAVE,
    KEEP_VAULT,
    keepHint,
    manageLabel,
    piSkillsLine,
    skillFilePath,
    skillGroups,
    skillNote,
    skillsSummary,
    type SkillCell,
    type SkillGroup,
    type SkillRow,
} from "./skillsmatrix";

const SKILL_COLUMN_WIDTH = "118px";

function useSkillGroups(): { data: CommandAgentSyncSkillsRtnData | null; groups: SkillGroup[] } {
    const data = useAtomValue(setupSkillsAtom);
    const keep = useAtomValue(setupSkillKeepAtom);
    return { data, groups: data == null ? [] : skillGroups(data, keep) };
}

export function SkillsHeader() {
    const data = useAtomValue(setupSkillsAtom);
    const keep = useAtomValue(setupSkillKeepAtom);
    const busy = useAtomValue(setupBusyAtom);
    const pi = piSkillsLine(useAtomValue(setupStatusAtom));
    if (data == null) {
        return null;
    }
    const n = adoptCount(data, keep);
    return (
        <>
            <span className="text-[12px] text-ink-mid">{skillsSummary(data)}</span>
            {pi != null ? (
                <span
                    data-pi-line
                    title={pi.text}
                    className={cn("flex min-w-0 items-center gap-1.5 text-[12px]", TONE_TEXT[pi.tone])}
                >
                    <Dot tone={pi.tone} />
                    <span className="truncate">{pi.text}</span>
                </span>
            ) : null}
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
                cell.tone == null ? "text-muted" : TONE_TEXT[cell.tone]
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
                            <span className="text-[10.5px] font-semibold tracking-normal text-warning">not set up</span>
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
                        <div
                            className={cn(
                                REGION_LABEL,
                                "flex h-[26px] items-center gap-2 border-b border-edge-faint bg-background px-3 text-muted"
                            )}
                        >
                            {g.title}
                            <span className="font-medium normal-case tracking-normal text-muted">
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

interface Choice {
    value: string | null; // null is the row's default: nothing in the keep map
    title: string;
    hint: string;
}

const LEAVE_HINT = "Arc skips this skill; each harness keeps its own file.";

// the rail's choices for a row, all held in the one keep map; a managed or linked row has none
function rowChoices(row: SkillRow, columns: AgentSyncSkillColumn[]): Choice[] {
    if (row.kind === "stray") {
        return [
            { value: null, title: "Leave the own copy", hint: "Arc keeps writing the vault copy everywhere else." },
            {
                value: KEEP_VAULT,
                title: "Replace it with the vault copy",
                hint: "The own copy is set aside under skills-replaced and the vault copy takes its place.",
            },
        ];
    }
    if (row.kind === "managed" || row.kind === "linked") {
        return [];
    }
    if (row.needsKeep) {
        return [
            ...row.copies.map((c) => ({ value: c.runtime, title: `Keep ${c.label}'s copy`, hint: keepHint(columns) })),
            { value: KEEP_LEAVE, title: "Leave these copies alone", hint: LEAVE_HINT },
        ];
    }
    return [
        { value: null, title: "Move it into the vault", hint: "Arc keeps one copy in the vault and writes it out." },
        { value: KEEP_LEAVE, title: "Leave it where it is", hint: LEAVE_HINT },
    ];
}

function KeepChoice({ row, columns }: { row: SkillRow; columns: AgentSyncSkillColumn[] }) {
    const keep = useAtomValue(setupSkillKeepAtom);
    const choices = rowChoices(row, columns);
    if (choices.length === 0) {
        return null;
    }
    const chosen = keep[row.name] ?? null;
    return (
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className={cn(SECTION_HEAD, "pb-1.5")}>
                {row.kind === "stray" ? "The own copy" : "When Arc manages it"}
            </legend>
            {choices.map((o) => (
                <label
                    key={o.value ?? ""}
                    className={cn(
                        "flex cursor-pointer items-start gap-2 rounded px-2.5 py-2 text-[12.5px] text-secondary",
                        chosen === o.value
                            ? "bg-surface-selected ring-1 ring-edge-strong ring-inset"
                            : "hover:bg-surface-hover"
                    )}
                >
                    <input
                        type="radio"
                        name={`skill-keep-${row.name}`}
                        checked={chosen === o.value}
                        onChange={() => setSkillKeep(row.name, o.value)}
                        className="mt-0.5 accent-accent"
                    />
                    <span className="flex flex-col gap-0.5">
                        <span className="font-semibold">{o.title}</span>
                        <span className="text-[11.5px] text-muted">{o.hint}</span>
                    </span>
                </label>
            ))}
        </fieldset>
    );
}

const CARD = "flex min-w-0 flex-col gap-[5px] rounded border border-border px-2.5 py-[9px]";

function HarnessCardHead({ runtime, label, aside }: { runtime: string; label: string; aside?: string }) {
    return (
        <span className="flex items-center gap-2 text-[12.5px] font-semibold text-secondary">
            <HarnessMark runtime={runtime} />
            {label}
            {aside != null ? <span className="ml-auto text-[11px] font-normal text-muted">{aside}</span> : null}
        </span>
    );
}

function VaultCard({ path }: { path: string }) {
    return (
        <div data-vault-card className={CARD}>
            <span className="text-[12.5px] font-semibold text-secondary">Arc vault</span>
            <PathTail path={path} />
        </div>
    );
}

function SkillCards({ row, path }: { row: SkillRow; path: string }) {
    const differs = row.kind === "decide" || row.kind === "differs" || row.kind === "stray";
    if (row.kind === "linked") {
        return (
            <>
                {row.links.map((l) => (
                    <div key={l.runtime} className={CARD}>
                        <HarnessCardHead runtime={l.runtime} label={l.label} aside="Link" />
                        <PathTail path={l.path} />
                        <span title={l.target} className="truncate font-mono text-[10.5px] text-muted">
                            Links to {l.target}
                        </span>
                    </div>
                ))}
            </>
        );
    }
    return (
        <>
            {row.kind === "managed" || row.kind === "stray" ? <VaultCard path={path} /> : null}
            {Object.entries(row.deltas).map(([runtime, over]) => (
                <div key={runtime} className={CARD}>
                    <HarnessCardHead runtime={runtime} label={runtimeMeta(runtime).label} />
                    <span className="font-mono text-[10.5px] text-muted">Overrides {over.join(", ")}</span>
                </div>
            ))}
            {row.copies.map((c) => (
                <div key={c.runtime} className={CARD}>
                    <HarnessCardHead runtime={c.runtime} label={c.label} aside={differs ? copyDelta(c) : undefined} />
                    <PathTail path={c.path} />
                </div>
            ))}
        </>
    );
}

function SkillRail({
    row,
    columns,
    skillsroot,
}: {
    row: SkillRow;
    columns: AgentSyncSkillColumn[];
    skillsroot: string;
}) {
    const keep = useAtomValue(setupSkillKeepAtom);
    // the preview stays in the rail, so Setup keeps its place and Code's project is never repointed
    const [preview, setPreview] = useState(false);
    const path = skillFilePath(row, skillsroot, keep);
    const differs = row.kind === "decide" || row.kind === "differs" || row.kind === "stray";
    return (
        <motion.aside
            {...FADE_IN}
            aria-label="Skill detail"
            className="flex w-[360px] flex-none flex-col gap-3.5 overflow-y-auto border-l border-border bg-surface p-4"
        >
            <div className="flex flex-col gap-1.5">
                <div className="font-mono text-[14px] font-medium text-primary">{row.name}</div>
                <div className="text-[12.5px] leading-[1.5] text-ink-mid">{skillNote(row, columns)}</div>
            </div>
            <div className="flex flex-col gap-2">
                <div className={SECTION_HEAD}>{differs ? "What differs" : "Where it lives"}</div>
                <SkillCards row={row} path={path} />
            </div>
            <KeepChoice row={row} columns={columns} />
            {preview ? <FilePreview path={path} className="min-h-[240px] flex-1" /> : <div className="flex-1" />}
            <div className="flex gap-2">
                <button
                    type="button"
                    aria-pressed={preview}
                    onClick={() => setPreview((v) => !v)}
                    className={BTN_SECONDARY}
                >
                    Preview SKILL.md
                </button>
            </div>
        </motion.aside>
    );
}

// the model prop is the surface's common shape; the tab no longer opens anything in Code
export function SkillsTab(_props: { model: AgentsViewModel }) {
    const { data, groups } = useSkillGroups();
    const selectedName = useAtomValue(setupSkillSelectedAtom);
    const error = useAtomValue(setupSkillsErrorAtom);
    // re-read on every visit: an agent may have written a skill since
    useEffect(() => {
        fireAndForget(loadSkills);
    }, []);
    const rows = groups.flatMap((g) => g.rows);
    const selected = rows.find((r) => r.name === selectedName) ?? rows[0] ?? null;
    // a failed first read shows its error with Retry in place of the matrix, so the banner would repeat it
    const firstReadFailed = data == null && error != null;
    return (
        <div className="flex min-w-0 flex-1 flex-col">
            <ErrorBanner error={firstReadFailed ? null : error} />
            <div className="flex min-h-0 flex-1">
                {firstReadFailed ? (
                    <LoadFailed error={error} onRetry={() => fireAndForget(loadSkills)} />
                ) : data == null ? (
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
                            // keyed by skill, so a new pick fades in with its preview closed
                            <SkillRail
                                key={selected.name}
                                row={selected}
                                columns={data.columns ?? []}
                                skillsroot={data.skillsroot}
                            />
                        ) : null}
                    </>
                )}
            </div>
        </div>
    );
}
