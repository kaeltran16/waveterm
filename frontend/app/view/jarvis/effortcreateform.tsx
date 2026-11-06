// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Paste-and-tick effort creation: one line per chunk in the textarea, live checkbox rows below,
// ticked lines become status=done at save (two RPCs — the chunk seed carries no status field).

import { microFade } from "@/app/element/motiontokens";
import { ModalShell } from "@/app/modals/modalshell";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { projectListAtom } from "@/app/view/agents/projectsstore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Check, X } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AgentsViewModel } from "../agents/agents";
import { briefingStateAtom, stateRpcTimeoutMs } from "./briefingstore";
import { briefUndo } from "./briefundo";
import { parentChoices } from "./effortmodel";
import { setEffortDetails, type EffortDetails } from "./effortstore";
import { openJiraSettings } from "./jiraactions";
import { fromLookupError, lookupLine, shouldLookUp, type LookupState } from "./jiralookup";
import { normalizeKey } from "./jiraticket";
import { ProjectChips } from "./projectchips";
import { TicketChip } from "./recordpicker";

export interface ParsedChunkLine {
    label: string;
    stage: string;
    checked: boolean;
}

// pure parse: one chunk per line, `Stage: chunk` groups it (split on the FIRST ": ", so a label may
// itself contain one after the stage). The preview shows stage headers, so a line that merely
// contains ": " is visible as a stage before anything is created. Ticks live in the form's state.
export function parseChunkLines(text: string): ParsedChunkLine[] {
    const lines: ParsedChunkLine[] = [];
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (line === "") {
            continue;
        }
        const cut = line.indexOf(": ");
        const stage = cut > 0 ? line.slice(0, cut).trim() : "";
        const label = cut > 0 ? line.slice(cut + 2).trim() : line;
        lines.push({ label: label === "" ? line : label, stage: label === "" ? "" : stage, checked: false });
    }
    return lines;
}

const inputCls =
    "w-full rounded-[7px] border border-edge-mid bg-background px-2.5 py-1.5 text-[12px] text-primary placeholder:text-muted outline-none focus:border-accent/60";
const fieldLabel = "font-mono text-[10.5px] font-bold uppercase tracking-[.09em] text-ink-mid";

const LINE_TONE = { muted: "text-ink-mid", error: "text-error", faint: "text-muted", ok: "text-success" } as const;

export function EffortCreateForm({
    model,
    onClose,
    edit,
}: {
    model: AgentsViewModel;
    onClose: () => void;
    // details mode: the same fields over an existing initiative; its chunks are edited in the plan
    edit?: { oref: string; details: EffortDetails };
}) {
    const [title, setTitle] = useState(edit?.details.title ?? "");
    const [project, setProject] = useState(edit?.details.project ?? "");
    const [ticket, setTicket] = useState(edit?.details.ticket ?? "");
    const [parent, setParent] = useState(edit?.details.parent ?? "");
    const [text, setText] = useState("");
    const [lines, setLines] = useState<ParsedChunkLine[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [titleError, setTitleError] = useState<string | null>(null);
    const projects = useAtomValue(projectListAtom);
    const [lookup, setLookup] = useState<LookupState>({ kind: "idle" });
    // the key last looked up (the saved one, in details mode) and a counter so only the newest lookup lands
    const lookedUp = useRef(normalizeKey(edit?.details.ticket ?? ""));
    const lookupSeq = useRef(0);

    // re-parse on text change, keeping ticks by label so a tick survives edits elsewhere in the list
    useEffect(() => {
        setLines((prev) => {
            const ticks = new Map(prev.map((l) => [l.label, l.checked]));
            return parseChunkLines(text).map((l) => ({ ...l, checked: ticks.get(l.label) ?? false }));
        });
    }, [text]);

    const ticked = lines.filter((l) => l.checked).length;
    const isDupe = (l: ParsedChunkLine, i: number) => lines.findIndex((x) => x.label === l.label) !== i;
    const dupes = lines.some(isDupe);
    const stages = new Set(lines.map((l) => l.stage)).size;
    const canSubmit = !submitting && title.trim() !== "" && (edit != null || !dupes);

    // saving never waits on this or depends on it: the field is plain text either way
    const lookUpTicket = (): void => {
        const key = shouldLookUp(lookedUp.current, ticket, lookup);
        if (key == null) {
            if (normalizeKey(ticket) === "" && lookedUp.current !== "") {
                lookupSeq.current++;
                lookedUp.current = "";
                setLookup({ kind: "idle" });
            }
            return;
        }
        const mine = ++lookupSeq.current;
        lookedUp.current = key;
        setTicket(key);
        setLookup({ kind: "looking", key });
        RpcApi.JiraShowCommand(TabRpcClient, { key, via: "lookup" }, { timeout: stateRpcTimeoutMs })
            .then(
                (r): LookupState => ({
                    kind: "found",
                    key,
                    summary: r.ticket.summary,
                    type: r.ticket.type,
                    status: r.ticket.status,
                }),
                (e): LookupState => fromLookupError(key, e)
            )
            .then((next) => {
                if (mine === lookupSeq.current) {
                    setLookup(next);
                }
            });
    };
    const line = lookupLine(lookup);

    const submit = async (): Promise<void> => {
        setTitleError(title.trim() === "" ? "Title is required" : null);
        if (title.trim() === "") {
            return;
        }
        setError(null);
        setSubmitting(true);
        if (edit != null) {
            try {
                await setEffortDetails(edit.oref, edit.details, { title, project, ticket, parent });
                briefUndo.notify("Initiative updated");
                onClose();
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setSubmitting(false);
            }
            return;
        }
        try {
            const parentOid = bareOid(parent);
            const rtn = await RpcApi.EffortCreateCommand(
                TabRpcClient,
                {
                    title: title.trim(),
                    project: project.trim() || undefined,
                    ticket: ticket.trim() || undefined,
                    parentoid: parentOid || undefined,
                    chunks: lines.map((l) => ({ label: l.label })),
                },
                { timeout: stateRpcTimeoutMs }
            );
            // the chunk seed carries neither status nor stage, so both land in one atomic follow-up batch
            const followOps: EffortOp[] = [
                ...lines
                    .filter((l) => l.stage !== "")
                    .map((l) => ({ op: "setChunkStage", chunk: l.label, stage: l.stage })),
                ...lines
                    .filter((l) => l.checked)
                    .map((l) => ({ op: "setChunkStatus", chunk: l.label, status: "done" })),
            ];
            if (followOps.length > 0) {
                await RpcApi.EffortMutateCommand(
                    TabRpcClient,
                    { effortoid: rtn.effortoid, ops: followOps, author: "you" },
                    { timeout: stateRpcTimeoutMs }
                );
            }
            briefUndo.notify(`Created “${title.trim()}” · ${lines.length} chunks`);
            onClose();
        } catch (e) {
            // the effort may exist with all-pending chunks if the mutate failed — the documented fallback.
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    };

    return (
        <ModalShell open onClose={onClose} onSubmit={() => void submit()} className="flex w-[min(580px,93vw)] flex-col">
            <div className="flex shrink-0 items-center gap-[11px] border-b border-border px-[18px] py-[15px]">
                <div className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accentbg font-mono text-[10.5px] font-bold text-accent-soft">
                    ✦
                </div>
                <span className="flex-1 text-[15px] font-semibold text-primary">
                    {edit != null ? "Edit initiative" : "New initiative"}
                </span>
                <span className="rounded-[5px] border border-edge-mid px-[7px] py-0.5 font-mono text-[10.5px] text-ink-mid">
                    ctrl+⏎ to save
                </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-[13px] overflow-y-auto px-[18px] py-4">
                <div className="flex flex-col gap-1">
                    <span className={fieldLabel}>Title</span>
                    <input
                        autoFocus
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="e.g. Scenario gate clearance"
                        className={cn(inputCls, "text-[12.5px]", titleError != null && "border-error/60")}
                    />
                    {titleError != null ? <span className="text-[11px] text-error">{titleError}</span> : null}
                </div>
                <div className="flex flex-col gap-1.5">
                    <span className={fieldLabel}>Project</span>
                    {/* the project is optional, so pressing the picked chip again clears it */}
                    <ProjectChips
                        names={projects.map((p) => p.name)}
                        picked={project || null}
                        recent={null}
                        onPick={(name) => setProject((cur) => (cur === name ? "" : name))}
                        columns={1}
                        allowCustom
                    />
                </div>
                <div className="grid grid-cols-2 gap-[13px]">
                    <div className="flex flex-col gap-1">
                        <span className={fieldLabel}>Ticket</span>
                        <input
                            data-effort-field="ticket"
                            value={ticket}
                            onChange={(e) => setTicket(e.target.value)}
                            onBlur={lookUpTicket}
                            placeholder="optional"
                            className={cn(inputCls, "font-mono", line?.fieldError && "border-error/60")}
                        />
                    </div>
                    <div className="flex flex-col gap-1">
                        <span className={fieldLabel}>Parent initiative</span>
                        <ParentPicker
                            value={parent}
                            selfOid={edit != null ? bareOid(edit.oref) : null}
                            onChange={setParent}
                        />
                    </div>
                </div>
                <MotionConfig reducedMotion="user">
                    <AnimatePresence mode="wait" initial={false}>
                        {lookup.kind === "idle" ? null : (
                            <motion.div
                                key={lookup.kind}
                                data-jira-lookup={lookup.kind}
                                variants={microFade}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                                className="-mt-1"
                            >
                                {lookup.kind === "found" ? (
                                    <div className="flex items-center gap-[9px] rounded-[7px] bg-surface px-[11px] py-[9px]">
                                        <Check
                                            className="h-[13px] w-[13px] flex-none text-success"
                                            strokeWidth={2.4}
                                            aria-hidden
                                        />
                                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-secondary">
                                            {lookup.summary}
                                        </span>
                                        <span className="flex-none text-[11.5px] text-muted">
                                            {lookup.type} · {lookup.status}
                                        </span>
                                    </div>
                                ) : line != null ? (
                                    <span className={cn("text-[12px] leading-normal", LINE_TONE[line.tone])}>
                                        {line.text}
                                        {line.connect ? (
                                            <>
                                                {" "}
                                                <button
                                                    type="button"
                                                    data-jira-connect
                                                    onClick={() => {
                                                        onClose();
                                                        openJiraSettings(model);
                                                    }}
                                                    className="cursor-pointer text-accent-soft hover:text-accent"
                                                >
                                                    Connect Jira
                                                </button>
                                            </>
                                        ) : null}
                                    </span>
                                ) : null}
                            </motion.div>
                        )}
                    </AnimatePresence>
                </MotionConfig>
                {edit == null ? (
                    <div className="flex flex-col gap-1.5">
                        <div className="flex items-baseline gap-2">
                            <span className={fieldLabel}>Chunks · one per line</span>
                            <span className="font-mono text-[10.5px] text-muted">Stage: chunk to group</span>
                        </div>
                        <textarea
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            placeholder={
                                "Phase 1: WAF posture scan\nPhase 1: Rule diff vs prod\nPhase 2: N1 box upgrade"
                            }
                            spellCheck={false}
                            className="min-h-[110px] w-full resize-y rounded-[7px] border border-edge-mid bg-background px-2.5 py-2 font-mono text-[11px] leading-[1.7] text-primary placeholder:text-muted outline-none focus:border-accent/60"
                        />
                        {lines.length > 0 ? (
                            <>
                                <div className="flex items-center gap-2">
                                    <span
                                        className={cn("font-mono text-[10.5px]", dupes ? "text-error" : "text-ink-mid")}
                                    >
                                        {dupes
                                            ? "duplicate chunk labels"
                                            : `${lines.length} chunks · ${stages} stage${stages === 1 ? "" : "s"} · ${ticked} done`}
                                    </span>
                                    <span className="flex-1" />
                                    <span className="font-mono text-[10.5px] text-muted">tick what's already done</span>
                                </div>
                                <div className="flex max-h-[170px] flex-col overflow-y-auto rounded-[7px] border border-edge-faint bg-surface px-2 py-1.5">
                                    {lines.map((l, i) => (
                                        <Fragment key={l.label + ":" + i}>
                                            {/* a header on every stage change, including the first unstaged
                                                line after a staged run (design L1672) */}
                                            {l.stage !== (i === 0 ? "" : lines[i - 1].stage) ? (
                                                <StageHeader label={l.stage || "unstaged"} />
                                            ) : null}
                                            <button
                                                type="button"
                                                aria-pressed={l.checked}
                                                onClick={() =>
                                                    setLines((prev) =>
                                                        prev.map((x, j) =>
                                                            j === i ? { ...x, checked: !x.checked } : x
                                                        )
                                                    )
                                                }
                                                className="flex w-full cursor-pointer items-center gap-2 rounded-[4px] px-1 py-[3px] text-left hover:bg-surface-hover"
                                            >
                                                <span
                                                    className={cn(
                                                        "flex h-[13px] w-[13px] flex-none items-center justify-center rounded-[3px] border text-background",
                                                        l.checked ? "border-success bg-success" : "border-edge-strong"
                                                    )}
                                                >
                                                    {l.checked ? (
                                                        <Check
                                                            className="h-[11px] w-[11px]"
                                                            strokeWidth={3}
                                                            aria-hidden
                                                        />
                                                    ) : null}
                                                </span>
                                                <span
                                                    className={cn(
                                                        "min-w-0 flex-1 truncate font-mono text-[11.5px]",
                                                        l.checked ? "text-ink-mid line-through" : "text-primary"
                                                    )}
                                                >
                                                    {l.label}
                                                </span>
                                                {isDupe(l, i) ? (
                                                    <span className="flex-none font-mono text-[10.5px] text-error">
                                                        duplicate
                                                    </span>
                                                ) : null}
                                            </button>
                                        </Fragment>
                                    ))}
                                </div>
                            </>
                        ) : null}
                    </div>
                ) : (
                    <span className="text-[12px] text-ink-mid">
                        Chunks are edited in the plan: double-click to rename, the status pill to change status.
                    </span>
                )}
            </div>
            <div className="flex shrink-0 items-center gap-2 border-t border-border px-[18px] py-3">
                {error != null ? (
                    <span className="min-w-0 flex-1 truncate text-[11px] text-error">{error}</span>
                ) : edit == null ? (
                    <span className="flex-1 font-mono text-[10.5px] text-ink-mid">
                        ticked lines save as already done
                    </span>
                ) : null}
                {/* nothing applies before Save, so Edit has no line here: ml-auto keeps the buttons right */}
                <button
                    type="button"
                    onClick={onClose}
                    className="ml-auto cursor-pointer rounded-[7px] border border-border bg-surface-raised px-3.5 py-1.5 text-[11.5px] font-semibold text-secondary hover:text-primary"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    disabled={!canSubmit}
                    onClick={() => void submit()}
                    className="cursor-pointer rounded-[7px] bg-accent px-3.5 py-1.5 text-[11.5px] font-semibold text-background hover:bg-accenthover disabled:cursor-default disabled:bg-border disabled:text-muted"
                >
                    {edit != null ? "Save changes" : submitting ? "Creating…" : "Create initiative"}
                </button>
            </div>
        </ModalShell>
    );
}

const bareOid = (s: string) => s.trim().replace(/^effort:/, "");

const PARENT_ROWS = 6;

// Type to filter the live initiatives by title or ticket, modelled on RecordPicker. The value is the bare
// oid; the briefing's efforts are read here because the New form mounts outside the Brief.
function ParentPicker({
    value,
    selfOid,
    onChange,
}: {
    value: string;
    selfOid: string | null;
    onChange: (oid: string) => void;
}) {
    const efforts = useAtomValue(briefingStateAtom).snapshot?.state.efforts;
    const [q, setQ] = useState("");
    const [open, setOpen] = useState(false);
    const matches = useMemo(() => parentChoices(efforts ?? [], q, selfOid, PARENT_ROWS), [efforts, q, selfOid]);
    const oid = bareOid(value);
    if (oid !== "") {
        const chosen = efforts?.find((c) => bareOid(c.oref) === oid);
        return (
            <div data-effort-parent-chosen={oid} className={cn(inputCls, "flex items-center gap-2")}>
                <span className="min-w-0 flex-1 truncate">{chosen?.title ?? oid}</span>
                <button
                    type="button"
                    data-effort-parent-clear
                    aria-label="Clear parent initiative"
                    onClick={() => onChange("")}
                    className="flex-none cursor-pointer text-muted hover:text-primary"
                >
                    <X className="h-3 w-3" aria-hidden />
                </button>
            </div>
        );
    }
    const pick = (oref: string) => {
        onChange(bareOid(oref));
        setQ("");
        setOpen(false);
    };
    // stopped here because ModalShell listens on window: the form would otherwise close with its Escape
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.stopPropagation();
            setQ("");
            setOpen(false);
        } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && open && matches.length > 0) {
            e.preventDefault();
            pick(matches[0].oref);
        }
    };
    return (
        <div className="flex flex-col gap-1">
            <input
                data-effort-field="parent"
                value={q}
                onChange={(e) => {
                    setQ(e.target.value);
                    setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onKeyDown={onKeyDown}
                placeholder="optional · type a title or ticket"
                aria-label="Parent initiative"
                className={inputCls}
            />
            {open ? (
                matches.length === 0 ? (
                    <span className="px-1 font-mono text-[10.5px] text-muted">
                        {efforts == null ? "Initiatives load with the Brief" : "No initiative matches"}
                    </span>
                ) : (
                    <div data-effort-parent-list className="flex flex-col gap-px">
                        {matches.map((c) => (
                            <button
                                key={c.oref}
                                type="button"
                                data-effort-parent-row={bareOid(c.oref)}
                                // mousedown, so the pick lands before the input's blur closes the list
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    pick(c.oref);
                                }}
                                className="flex cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1 text-left transition-colors duration-[140ms] hover:bg-surface-hover"
                            >
                                <span className="min-w-0 flex-1 truncate text-[11.5px] text-secondary">{c.title}</span>
                                <TicketChip ticket={c.ticket} />
                            </button>
                        ))}
                    </div>
                )
            ) : null}
        </div>
    );
}

function StageHeader({ label }: { label: string }) {
    return (
        <div className="px-1 pb-0.5 pt-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[.08em] text-ink-mid">
            {label}
        </div>
    );
}
