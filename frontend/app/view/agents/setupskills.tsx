// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Setup surface's Skills tab: it views every harness's skills and moves them into the vault; it never
// creates or edits one. Logic lives in skillsmatrix.ts, the RPCs and atoms in setupskillsstore.ts.

import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useEffect, type KeyboardEvent } from "react";
import type { AgentsViewModel } from "./agents";
import { PathTail } from "./pathtail";
import { runtimeMeta } from "./runtimemeta";
import {
    BTN_PRIMARY,
    BTN_SECONDARY,
    Dot,
    ErrorBanner,
    FADE_IN,
    HarnessMark,
    LoadFailed,
    SECTION_HEAD,
    TONE_TEXT,
} from "./setupparts";
import {
    adoptSkills,
    loadSkills,
    openSkillFile,
    selectSkill,
    setSkillKeep,
    setupSkillKeepAtom,
    setupSkillsAtom,
    setupSkillSelectedAtom,
    setupSkillsErrorAtom,
} from "./setupskillsstore";
import { setupBusyAtom } from "./setupstore";
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
        <motion.aside
            key={row.name}
            {...FADE_IN}
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
                            <PathTail path={c.path} />
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
        </motion.aside>
    );
}

export function SkillsTab({ model }: { model: AgentsViewModel }) {
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
                            <SkillRail model={model} row={selected} skillsroot={data.skillsroot} />
                        ) : null}
                    </>
                )}
            </div>
        </div>
    );
}
