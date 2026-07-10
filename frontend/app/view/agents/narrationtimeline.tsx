// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ContextMenuModel } from "@/app/store/contextmenu";
import { modalsModel } from "@/app/store/modalmodel";
import { cn } from "@/util/util";
import { AnimatePresence, motion } from "motion/react";
import { MOTION, composerReveal, shouldFadeEntry } from "@/app/element/motiontokens";
import { Fragment, useState } from "react";
import {
    burstRenderMode,
    conversationText,
    detailExceedsInline,
    formatTokens,
    groupTimeline,
    summarizeActions,
    type ActionDetail,
    type AgentActionEntry,
    type AgentEntry,
    type EditFile,
} from "./agentsviewmodel";
import { MarkdownMessage } from "./markdownmessage";
import { highlightLine } from "./highlight";
import { formatDuration } from "./tooldetail";

// Handoff lane feed (Wave-cockpit-live.dc.html:211-247). message -> narration row
// (accent avatar + prose); user -> right-aligned bubble; action -> tool line
// (outcome chip + tool + summary + note). Bursts of >= CollapseRunThreshold
// consecutive actions fold into one summary line (groupTimeline) that expands on
// click; while `active`, the trailing run stays expanded. tool_result content is
// never present. Per-tool timestamps are omitted (not in AgentEntry).

// Shared per-kind detail renderer. Used inline (capped by max-height) and by the modal (uncapped).
// Tokens only — no raw hex. See Wave-transcript-feed.dc.html.
export function ToolDetailBody({ detail, variant }: { detail: ActionDetail; variant: "inline" | "modal" }) {
    const pad = variant === "modal" ? "px-4 py-3" : "px-[11px] py-[9px]";
    if (detail.kind === "grep") {
        return (
            <div className={pad}>
                {detail.matches.map((g, i) => (
                    <div key={i} className="flex gap-2.5 whitespace-pre font-mono text-[11px] leading-[1.6]">
                        <span className="shrink-0 text-muted">{g.loc}</span>
                        <span className="truncate text-secondary">{g.code}</span>
                    </div>
                ))}
                {detail.more ? <div className="pt-1.5 font-mono text-[10px] text-feed-time">{detail.more}</div> : null}
            </div>
        );
    }
    if (detail.kind === "read") {
        // syntax-highlight the file body with the feed's lightweight tokenizer (same one CodeBlock uses).
        // Kept off shiki deliberately — the feed is on the cockpit boot path.
        return (
            <div className={`overflow-x-auto ${pad}`}>
                <div className="min-w-min font-mono text-[11px] leading-[1.7]">
                    {detail.snippet.split("\n").map((ln, i) => (
                        <div key={i} className="whitespace-pre">
                            {highlightLine(ln).map((tk, k) => (
                                <span key={k} className={tk.cls}>
                                    {tk.t}
                                </span>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        );
    }
    if (detail.kind === "bash") {
        return (
            <div>
                {detail.command ? (
                    <div
                        className={`flex gap-2 whitespace-pre-wrap break-all font-mono text-[11px] leading-[1.6] text-secondary ${pad}`}
                    >
                        <span className="shrink-0 select-none text-accent">$</span>
                        <span>{detail.command}</span>
                    </div>
                ) : null}
                {detail.output ? (
                    <pre
                        className={`overflow-x-auto whitespace-pre font-mono text-[11px] leading-[1.7] ${detail.command ? "border-t border-edge-faint" : ""} ${pad} ${detail.exit ? "text-error" : "text-ink-mid"}`}
                    >
                        {detail.output}
                    </pre>
                ) : null}
                <div className="flex items-center gap-2 px-[13px] pb-[9px]">
                    <span
                        className={`rounded-[4px] px-[7px] py-0.5 font-mono text-[8.5px] font-semibold uppercase ${detail.exit ? "bg-error/15 text-error" : "bg-success/15 text-success"}`}
                    >
                        exit {detail.exit}
                    </span>
                </div>
            </div>
        );
    }
    if (detail.kind === "skill") {
        return (
            <div className={pad}>
                <div className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="text-syntax-keyword">skill</span>
                    <span className="text-primary">{detail.name}</span>
                </div>
                {detail.args ? (
                    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.6] text-secondary">
                        {detail.args}
                    </pre>
                ) : null}
            </div>
        );
    }
    // edit
    return (
        <div className="flex flex-col">
            {detail.files.map((f, i) => (
                <div key={i} className="border-b border-lane last:border-b-0">
                    <div className="flex items-center gap-2.5 bg-surface px-[11px] py-[7px]">
                        <span
                            className={`flex h-[15px] w-[15px] items-center justify-center rounded-[4px] font-mono text-[8.5px] font-bold ${f.badge === "A" ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}
                        >
                            {f.badge}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-hi">{f.path}</span>
                        <span className="font-mono text-[9.5px] font-bold text-success">+{f.adds}</span>
                        <span className="font-mono text-[9.5px] font-bold text-error">−{f.dels}</span>
                    </div>
                    <div className="overflow-x-auto bg-surface-code py-1">
                        <div className="min-w-min">
                            {f.lines.map((l, k) => (
                                <div
                                    key={k}
                                    className={`flex whitespace-pre font-mono text-[11px] leading-[1.7] ${l.sign === "+" ? "bg-success/[0.09]" : l.sign === "-" ? "bg-error/[0.09]" : ""}`}
                                >
                                    <span
                                        className={`w-[13px] shrink-0 text-center ${l.sign === "+" ? "text-success" : l.sign === "-" ? "text-error" : "text-ink-faint"}`}
                                    >
                                        {l.sign}
                                    </span>
                                    <span
                                        className={`pr-3.5 ${l.sign === "+" ? "text-success-soft" : l.sign === "-" ? "text-error" : "text-secondary"}`}
                                    >
                                        {l.text}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}

// A single tool action row. Clickable when it carries detail: short detail expands inline, detail
// past the per-kind budget opens the viewport modal. The bare-line look is preserved when detail
// is absent (e.g. Codex actions, or Claude tools with no captured body).
function ToolLine({ action }: { action: AgentActionEntry }) {
    const [open, setOpen] = useState(false);
    const ok = action.outcome !== "fail";
    const detail = action.detail;
    const toModal = detail ? detailExceedsInline(detail) : false;
    const onClick = () => {
        if (!detail) {
            return;
        }
        if (toModal) {
            modalsModel.pushModal("AgentToolDetailModal", { action });
        } else {
            setOpen((v) => !v);
        }
    };
    return (
        <div>
            <div
                onClick={onClick}
                className={cn(
                    "flex items-center gap-1.5 rounded-[6px] px-1.5 py-[3px]",
                    detail ? "cursor-pointer opacity-[0.72] hover:bg-lane hover:opacity-100" : "opacity-[0.68]"
                )}
            >
                <span
                    className={cn(
                        "flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[3px] text-[8px]",
                        ok ? "bg-success/15 text-success" : "bg-error/15 text-error"
                    )}
                >
                    {ok ? "✓" : "✗"}
                </span>
                <span className="shrink-0 font-mono text-[8px] font-semibold uppercase tracking-[0.03em] text-feed-label">
                    {action.verb}
                </span>
                <span className="min-w-0 truncate font-mono text-[10.5px] text-feed-summary">{action.target}</span>
                {action.summary ? (
                    <span className={cn("shrink-0 font-mono text-[10.5px]", ok ? "text-feed-summary" : "text-error")}>
                        {action.summary}
                    </span>
                ) : null}
                <div className="min-w-[6px] flex-1" />
                {action.durationMs ? (
                    <span className="shrink-0 font-mono text-[9.5px] text-feed-time">{formatDuration(action.durationMs)}</span>
                ) : null}
                {detail ? (
                    <span className="shrink-0 font-mono text-[8px] text-edge-strong">
                        {toModal ? "↗" : open ? "▼" : "▶"}
                    </span>
                ) : null}
            </div>
            <AnimatePresence initial={false}>
                {detail && open && !toModal ? (
                    <motion.div
                        key="detail"
                        variants={composerReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="my-1.5 overflow-hidden rounded-[9px] border border-edge-faint bg-surface-code"
                    >
                        <div className="max-h-[200px] overflow-auto">
                            <ToolDetailBody detail={detail} variant="inline" />
                        </div>
                        <div className="flex items-center border-t border-edge-faint px-3 py-1">
                            <div className="flex-1" />
                            <button
                                type="button"
                                title="Expand"
                                onClick={() => modalsModel.pushModal("AgentToolDetailModal", { action })}
                                className="text-accent hover:text-accent-soft"
                            >
                                ↗
                            </button>
                        </div>
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
}

// A folded run of consecutive edits (Wave-transcript-feed.dc.html burst). Summary row: "N files
// +adds −dels"; expands inline when the combined diff fits the edit budget, else opens the modal.
function CommandChip({ name, args, isSkill }: { name: string; args?: string; isSkill?: boolean }) {
    return (
        <div className="mt-2 flex justify-end">
            <span
                className={cn(
                    "inline-flex max-w-[88%] flex-wrap items-baseline rounded-lg border px-[11px] py-[5px] font-mono",
                    isSkill ? "border-skill/35 bg-skill/[0.08]" : "border-accent/35 bg-accent/[0.07]"
                )}
            >
                {isSkill ? <span className="mr-[7px] self-center text-[11px] text-skill">✦</span> : null}
                <span className={cn("text-[12px] font-semibold", isSkill ? "text-skill-soft" : "text-accent-soft")}>{name}</span>
                {args ? (
                    <span className={cn("ml-2 border-l pl-2 text-[11.5px] text-feed-summary", isSkill ? "border-skill/25" : "border-accent/25")}>
                        {args}
                    </span>
                ) : null}
            </span>
        </div>
    );
}

function CompactionDivider({
    trigger,
    preTokens,
    postTokens,
    summary,
}: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    summary?: string;
}) {
    const [open, setOpen] = useState(false);
    const stat = preTokens != null && postTokens != null ? `${formatTokens(preTokens)} → ${formatTokens(postTokens)} tokens` : null;
    const canExpand = !!summary;
    return (
        <div className="mt-3.5">
            <button type="button" disabled={!canExpand} onClick={() => setOpen((v) => !v)} className={cn("flex w-full items-center gap-2.5", canExpand ? "cursor-pointer" : "cursor-default")}>
                <span className="h-px flex-1 bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
                <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-accent/30 bg-accent/[0.07] px-[11px] py-[3px] font-mono text-[10px]">
                    <span className="text-[9px] font-semibold uppercase tracking-[0.05em] text-accent-soft">Compacted</span>
                    {stat ? (
                        <>
                            <span className="text-edge-strong">·</span>
                            <span className="text-feed-summary">{stat}</span>
                        </>
                    ) : null}
                    {trigger ? (
                        <>
                            <span className="text-edge-strong">·</span>
                            <span className="text-muted">{trigger}</span>
                        </>
                    ) : null}
                    {canExpand ? <span className="text-[8px] text-muted">{open ? "▲" : "▼"}</span> : null}
                </span>
                <span className="h-px flex-1 bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
            </button>
            <AnimatePresence initial={false}>
                {open && summary ? (
                    <motion.div
                        key="sum"
                        variants={composerReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="my-2 overflow-hidden rounded-[10px] border border-edge-faint bg-surface-code px-3.5 py-3"
                    >
                        <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.06em] text-feed-label">Summary — kept context</div>
                        <MarkdownMessage text={summary} />
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
}
function EditBurstRow({ files, adds, dels }: { files: EditFile[]; adds: number; dels: number }) {
    const [open, setOpen] = useState(false);
    const detail = { kind: "edit" as const, files };
    const toModal = detailExceedsInline(detail);
    const action = {
        kind: "action" as const,
        verb: "edited",
        target: `${files.length} file${files.length === 1 ? "" : "s"}`,
        detail,
    };
    const onClick = () => (toModal ? modalsModel.pushModal("AgentToolDetailModal", { action }) : setOpen((v) => !v));
    return (
        <div>
            <div
                onClick={onClick}
                className="flex cursor-pointer items-center gap-1.5 rounded-[6px] px-1.5 py-[3px] opacity-[0.72] hover:bg-lane hover:opacity-100"
            >
                <span className="flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[3px] bg-success/15 text-[8px] text-success">
                    ✓
                </span>
                <span className="shrink-0 font-mono text-[8px] font-semibold uppercase tracking-[0.03em] text-feed-label">
                    edited
                </span>
                <span className="font-mono text-[10.5px] text-feed-summary">{action.target}</span>
                <span className="shrink-0 font-mono text-[10px] text-success">+{adds}</span>
                <span className="shrink-0 font-mono text-[10px] text-error">−{dels}</span>
                <div className="min-w-[6px] flex-1" />
                <span className="shrink-0 font-mono text-[8px] text-edge-strong">{toModal ? "↗" : open ? "▼" : "▶"}</span>
            </div>
            <AnimatePresence initial={false}>
                {open && !toModal ? (
                    <motion.div
                        key="detail"
                        variants={composerReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="my-1.5 overflow-hidden rounded-[9px] border border-edge-faint bg-surface-code"
                    >
                        <ToolDetailBody detail={detail} variant="inline" />
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
}

// The human interrupted the agent mid-turn. A thin centered marker, not a You bubble.
function InterruptedDivider() {
    return (
        <div className="mt-3 flex items-center gap-2.5">
            <span className="h-px flex-1 bg-edge-faint" />
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-edge-mid bg-surface px-[10px] py-[2px] font-mono text-[9px] font-semibold uppercase tracking-[0.05em] text-muted">
                <span className="text-[9px] leading-none">⊘</span>
                Interrupted
            </span>
            <span className="h-px flex-1 bg-edge-faint" />
        </div>
    );
}

// A finished background Task/subagent (<task-notification>). Collapsed: a "Task" chip + summary +
// status pill; expands to the child's full result via MarkdownMessage (result can be large).
function TaskNotificationRow({ summary, status, result }: { summary: string; status?: string; result?: string }) {
    const [open, setOpen] = useState(false);
    const canExpand = !!result;
    const ok = status == null || status === "completed";
    return (
        <div className="mt-2 flex gap-2.5">
            <span
                className={cn(
                    "mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border font-mono text-[10px]",
                    ok ? "border-success/30 bg-success/[0.12] text-success" : "border-warning/30 bg-warning/[0.12] text-warning"
                )}
            >
                ⑃
            </span>
            <div className="min-w-0 flex-1">
                <button
                    type="button"
                    disabled={!canExpand}
                    onClick={() => setOpen((v) => !v)}
                    className={cn(
                        "flex w-full items-center gap-2 rounded-[8px] border border-edge-faint bg-surface px-2.5 py-1.5 text-left",
                        canExpand ? "cursor-pointer hover:border-edge-strong" : "cursor-default"
                    )}
                >
                    <span className="shrink-0 font-mono text-[8.5px] font-semibold uppercase tracking-[0.06em] text-feed-label">Task</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-secondary">{summary || "Subagent finished"}</span>
                    {status ? (
                        <span
                            className={cn(
                                "shrink-0 rounded-[4px] px-[6px] py-0.5 font-mono text-[8.5px] font-semibold uppercase",
                                ok ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
                            )}
                        >
                            {status}
                        </span>
                    ) : null}
                    {canExpand ? <span className="shrink-0 font-mono text-[8px] text-edge-strong">{open ? "▼" : "▶"}</span> : null}
                </button>
                <AnimatePresence initial={false}>
                    {open && result ? (
                        <motion.div
                            key="res"
                            variants={composerReveal}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            className="mt-1.5 overflow-hidden rounded-[9px] border border-edge-faint bg-surface-code px-3.5 py-3"
                        >
                            <MarkdownMessage text={result} />
                        </motion.div>
                    ) : null}
                </AnimatePresence>
            </div>
        </div>
    );
}

export function NarrationTimeline({
    entries,
    accentLatest,
    active,
    className,
}: {
    entries: AgentEntry[];
    accentLatest?: boolean;
    active?: boolean;
    className?: string;
}) {
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
    const items = groupTimeline(entries);
    const copyMenu = (text: string) => (e: React.MouseEvent) =>
        ContextMenuModel.getInstance().showContextMenu(
            [
                { label: "Copy text", click: () => void navigator.clipboard.writeText(text) },
                { label: "Copy conversation", click: () => void navigator.clipboard.writeText(conversationText(entries)) },
            ],
            e
        );

    let lastMessageIdx = -1;
    if (accentLatest) {
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].kind === "message") {
                lastMessageIdx = i;
                break;
            }
        }
    }

    const expand = (startIndex: number) => setExpanded((prev) => new Set(prev).add(startIndex));

    return (
        <div className={cn("leading-relaxed", className)}>
            <AnimatePresence initial={false}>
            {items.map((item, idx) => {
                if (item.kind === "message") {
                    return (
                        <motion.div
                            key={item.index}
                            className="mt-2 flex gap-2.5"
                            onContextMenu={copyMenu(item.text)}
                            initial={shouldFadeEntry("message") ? { opacity: 0 } : false}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border border-accent/30 bg-accent/[0.13]">
                                <span className="h-[7px] w-[7px] rounded-full bg-accent-soft" />
                            </span>
                            <div
                                className={cn(
                                    "min-w-0 flex-1 text-[13px] leading-[1.55]",
                                    item.index === lastMessageIdx ? "text-primary" : "text-secondary"
                                )}
                            >
                                <MarkdownMessage text={item.text} />
                            </div>
                        </motion.div>
                    );
                }
                if (item.kind === "user") {
                    return (
                        <motion.div
                            key={item.index}
                            className="mt-2 flex justify-end pl-[30px]"
                            onContextMenu={copyMenu(item.text)}
                            initial={shouldFadeEntry("user") ? { opacity: 0 } : false}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <div className="max-w-[90%] rounded-[11px_11px_4px_11px] border border-accent/25 bg-accent/10 px-2.5 py-1.5">
                                <div className="mb-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.08em] text-accent-soft">
                                    You
                                </div>
                                <p className="text-[12.5px] leading-[1.5] text-primary">{item.text}</p>
                            </div>
                        </motion.div>
                    );
                }
                if (item.kind === "command") {
                    return (
                        <motion.div
                            key={item.index}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <CommandChip name={item.name} args={item.args} isSkill={item.isSkill} />
                        </motion.div>
                    );
                }
                if (item.kind === "compaction") {
                    return (
                        <motion.div
                            key={item.index}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <CompactionDivider trigger={item.trigger} preTokens={item.preTokens} postTokens={item.postTokens} summary={item.summary} />
                        </motion.div>
                    );
                }
                if (item.kind === "notification") {
                    return (
                        <motion.div
                            key={item.index}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <TaskNotificationRow summary={item.summary} status={item.status} result={item.result} />
                        </motion.div>
                    );
                }
                if (item.kind === "interrupted") {
                    return (
                        <motion.div
                            key={item.index}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <InterruptedDivider />
                        </motion.div>
                    );
                }
                if (item.kind === "action") {
                    return <ToolLine key={item.index} action={item.action} />;
                }
                if (item.kind === "edit-burst") {
                    return <EditBurstRow key={"eb" + item.startIndex} files={item.files} adds={item.adds} dels={item.dels} />;
                }
                const isTrailing = idx === items.length - 1;
                const mode = burstRenderMode({ userOpened: expanded.has(item.startIndex), autoOpen: !!active && isTrailing });
                if (mode !== "collapsed") {
                    const lines = item.actions.map((action, k) => (
                        <ToolLine key={item.startIndex + k} action={action} />
                    ));
                    // "reveal" (user expanded a historical burst) grows open; "open" (auto-open trailing
                    // burst during streaming) renders plain so the live run never strobes.
                    return mode === "reveal" ? (
                        <motion.div
                            key={"g" + item.startIndex}
                            variants={composerReveal}
                            initial="initial"
                            animate="animate"
                            className="overflow-hidden"
                        >
                            {lines}
                        </motion.div>
                    ) : (
                        <Fragment key={"g" + item.startIndex}>{lines}</Fragment>
                    );
                }
                const summary = summarizeActions(item.actions);
                return (
                    <button
                        key={"g" + item.startIndex}
                        type="button"
                        onClick={() => expand(item.startIndex)}
                        className="my-1.5 flex w-full cursor-pointer items-center gap-1.5 rounded-r border-l-2 border-accent/50 bg-accent/[0.06] px-2.5 py-1 font-mono text-[12px] text-muted hover:bg-accent/10"
                    >
                        <span className="text-accent">▸</span>
                        <span className="text-secondary">{summary.total} tools</span>
                        {summary.byVerb.map((v) => (
                            <span key={v.verb}>
                                · {v.count} {v.verb}
                            </span>
                        ))}
                        <span className={cn("ml-0.5", summary.outcome === "ok" ? "text-accent" : "text-error")}>
                            {summary.outcome === "ok" ? "✓" : "✗"}
                        </span>
                    </button>
                );
            })}
            </AnimatePresence>
        </div>
    );
}

