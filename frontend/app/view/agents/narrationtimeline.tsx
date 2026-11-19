// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { pushToast } from "@/app/cockpit/notificationstore";
import { writeClipboard } from "@/app/element/copyfeedback";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { localFileUrl } from "@/app/view/jarvis/localimage";
import { getWebServerEndpoint } from "@/util/endpoints";
import { fetch } from "@/util/fetchutil";
import { cn, fireAndForget } from "@/util/util";
import {
    Activity,
    Ban,
    Check,
    Copy,
    File as FileIcon,
    GitBranch,
    Info,
    SquareTerminal,
    X,
    type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { cardVariants, shouldFadeEntry, viewFade } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { conversationText, formatTokens, type AgentEntry } from "./agentsviewmodel";
import { ArcMessageRow, BoardChip, HumanActionRow } from "./arcmessagerow";
import { ClampedText } from "./clampedtext";
import { MarkdownMessage } from "./markdownmessage";
import { placeMarks, type TimelineMark } from "./permissionmodel";
import { ImageThumbs } from "./imagethumbs";
import { fmtDuration } from "./runcompletion";
import { TIMELINE_RENDER_CAP } from "./sessionstranscript";
import { ShellRunRow } from "./shellrunrow";
import { AddsDels, StepBox, ThoughtText, TurnChevron } from "./steprows";
import type { TranscriptContext } from "./transcriptcontext";
import { layoutTranscript, type FoldSummary, type LayoutItem, type Step } from "./transcriptlayout";
import { WshChangeRow } from "./wshchangerow";
import { wshRendererFor } from "./wshrenderers";

// The transcript feed. layoutTranscript (transcriptlayout.ts) decides the items: prose, user bubbles, events, Arc's own
// messages, wsh change cards, stretches of tool steps, and a finished turn's work folded into one "Worked for N" line.
// While `active`, the live turn stays unfolded.

// a host that passes no ctx: cards still render, with no links
const NO_CTX: TranscriptContext = {};

export const VERB = "min-w-[50px] shrink-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted";

// "Worked for N · phrase +a −d ✗ k failed": a finished turn's folded work. Fades in when a turn folds after mount.
function FoldLine({ fold, open, onClick, compact }: { fold: FoldSummary; open: boolean; onClick: () => void; compact: boolean }) {
    return (
        <motion.button
            type="button"
            data-fold
            variants={viewFade}
            initial="initial"
            animate="animate"
            aria-expanded={open}
            onClick={onClick}
            className={cn(
                "mt-2 flex max-w-full cursor-pointer items-center gap-1.5 text-left font-sans text-muted hover:text-ink-mid",
                compact ? "text-[12.5px]" : "text-[14px]"
            )}
        >
            <span className="shrink-0 text-secondary">
                {fold.durationMs != null ? `Worked for ${fmtDuration(fold.durationMs)}` : "Worked"}
            </span>
            {fold.phrase ? <span className="min-w-0 truncate">· {fold.phrase}</span> : null}
            {fold.adds > 0 || fold.dels > 0 ? <AddsDels adds={fold.adds} dels={fold.dels} compact={compact} /> : null}
            {/* the word carries the outcome, so colour is never the only signal */}
            {fold.failed > 0 ? (
                <span className="ml-1 inline-flex shrink-0 items-center gap-1 text-error">
                    <X size={11} strokeWidth={3} aria-hidden />
                    {fold.failed} failed
                </span>
            ) : null}
            <span className="flex shrink-0">
                <TurnChevron open={open} size={14} strokeWidth={2} />
            </span>
        </motion.button>
    );
}

// A finished turn's work behind its Worked-for line, which opens to the items in order. live: the working turn, drawn
// open with no line and unclipped, so its rows sit as they would flat; when it finishes the same rows fold. finishing:
// the turn just finished under a mounted feed, so it mounts open and folds its work away under the new line. unfold:
// drawn open with no reveal, so a find over the transcript sees every row where it will stay.
function TurnFold({
    fold,
    live,
    finishing,
    unfold,
    compact,
    children,
}: {
    fold: FoldSummary;
    live: boolean;
    finishing: boolean;
    unfold: boolean;
    compact: boolean;
    children: React.ReactNode;
}) {
    const [toggled, setToggled] = useState(false);
    // open for one render after the turn is done, which clips the pane before it collapses: an exiting pane keeps the
    // props it last rendered with
    const [settled, setSettled] = useState(!finishing && !live);
    useEffect(() => {
        if (!live) {
            setSettled(true);
        }
    }, [live]);
    const open = unfold || !settled || toggled;
    // a turn that mounts live gains rows as they arrive, and those enter as the feed's own do
    const body = <AnimatePresence initial={live}>{children}</AnimatePresence>;
    return (
        <div data-turn-fold={live ? undefined : ""} data-turn-live={live ? "" : undefined}>
            {live ? null : <FoldLine fold={fold} open={open} onClick={() => setToggled((v) => !v)} compact={compact} />}
            {unfold ? (
                <div>{body}</div>
            ) : (
                <PaneReveal open={open} className={live ? "overflow-visible" : undefined}>
                    {body}
                </PaneReveal>
            )}
        </div>
    );
}

// a wsh change call that succeeded: its family's card, or the generic change row
function WshCardItem({ step, ctx, compact }: { step: Step; ctx: TranscriptContext; compact: boolean }) {
    const { call, key } = step.wsh!;
    const Card = key === "other-change" ? undefined : wshRendererFor(key);
    if (Card == null) {
        return <WshChangeRow call={call} action={step.action} compact={compact} />;
    }
    return (
        <div data-wsh-card={key}>
            <Card call={call} wshKey={key} action={step.action} ctx={ctx} compact={compact} />
        </div>
    );
}

// a typed slash command, or a skill (✦), as a right-aligned chip; the Rendered view's queued foot draws one too
export function CommandChip({
    name,
    args,
    isSkill,
    output,
    compact,
}: {
    name: string;
    args?: string;
    isSkill?: boolean;
    output?: string;
    compact: boolean;
}) {
    return (
        <div data-command-chip={isSkill ? "skill" : "command"} className="my-2.5 flex justify-end">
            <div className="flex min-w-0 max-w-[88%] flex-col items-end gap-1">
                {/* only the command is code; its arguments are what the person typed */}
                <span
                    className={cn(
                        "inline-flex max-w-full flex-wrap items-baseline gap-x-2 rounded-[12px] bg-surface-hover px-3 py-1.5 font-sans",
                        compact ? "text-[12.5px]" : "text-[13px]"
                    )}
                >
                    {isSkill ? <span className="text-[11.5px] text-skill">✦</span> : null}
                    <span
                        data-command-name
                        className={cn(
                            "font-mono font-semibold",
                            compact ? "text-[12px]" : "text-[12.5px]",
                            isSkill ? "text-skill-soft" : "text-accent-soft"
                        )}
                    >
                        {name}
                    </span>
                    {args ? (
                        <span data-command-args className="min-w-0 text-ink-mid [overflow-wrap:anywhere]">
                            {args}
                        </span>
                    ) : null}
                </span>
                {output ? (
                    <div
                        data-command-output
                        className={cn(
                            "whitespace-pre-wrap px-3 text-right font-mono text-ink-mid [overflow-wrap:anywhere]",
                            compact ? "text-[11.5px]" : "text-[12px]"
                        )}
                    >
                        {output}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

// a centred event on a rule: compaction, an interrupt
const EVENT_RULE = "h-px flex-1 bg-edge-mid";
// an event's opened markdown panel; set here, or it inherits the page's 16px foreground
const EVENT_PANEL_TEXT = "text-[13px] leading-[1.55] text-secondary";

function CompactionDivider({
    trigger,
    preTokens,
    postTokens,
    summary,
    compact,
}: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    summary?: string;
    compact: boolean;
}) {
    const [open, setOpen] = useState(false);
    const stat = preTokens != null && postTokens != null ? `${formatTokens(preTokens)} → ${formatTokens(postTokens)} tokens` : null;
    const canExpand = !!summary;
    return (
        <div data-compaction className={compact ? "my-4" : "my-6"}>
            <button
                type="button"
                disabled={!canExpand}
                aria-expanded={canExpand ? open : undefined}
                onClick={() => setOpen((v) => !v)}
                className={cn("flex w-full items-center gap-3", canExpand ? "cursor-pointer" : "cursor-default")}
            >
                <span className={EVENT_RULE} />
                <span
                    className={cn(
                        "inline-flex min-w-0 items-center gap-[7px] text-muted",
                        compact ? "text-[12px]" : "text-[12.5px]"
                    )}
                >
                    <span className="shrink-0 text-secondary">Context compacted</span>
                    {stat ? <span className="truncate">· {stat}</span> : null}
                    {trigger ? <span className="shrink-0">· {trigger}</span> : null}
                    {canExpand ? (
                        <span className="flex shrink-0">
                            <TurnChevron open={open} size={12} strokeWidth={2.2} flip />
                        </span>
                    ) : null}
                </span>
                <span className={EVENT_RULE} />
            </button>
            <PaneReveal open={open && !!summary}>
                <div className="my-2 rounded-[8px] border border-edge-mid bg-surface-code px-3.5 py-3">
                    <div className="mb-1.5 text-[12px] text-muted">Summary, kept context</div>
                    <MarkdownMessage text={summary ?? ""} className={EVENT_PANEL_TEXT} />
                </div>
            </PaneReveal>
        </div>
    );
}
// The human interrupted the agent mid-turn: a human action's row, not a bubble.
function InterruptedDivider({ compact }: { compact: boolean }) {
    return (
        <HumanActionRow
            data-interrupted
            icon={<Ban size={13} strokeWidth={2} className="shrink-0" aria-hidden />}
            phrase="You interrupted"
            compact={compact}
            className={compact ? "my-3.5" : "my-5"}
        />
    );
}

type NotificationSource = Extract<AgentEntry, { kind: "notification" }>["source"];

// each source's label and icon, and the leading words of its summary the label already says (Claude Code writes
// "Background command "x" completed", "Monitor event: "x"", "Agent "x" finished")
const NOTIFICATION_LABELS: Record<NonNullable<NotificationSource>, { label: string; lead: RegExp; icon: LucideIcon }> = {
    command: { label: "Background command", lead: /^Background command\b:?\s*/, icon: SquareTerminal },
    monitor: { label: "Monitor", lead: /^Monitor(?: event)?\b:?\s*/, icon: Activity },
    subagent: { label: "Subagent", lead: /^(?:Sub)?agent\b:?\s*/i, icon: GitBranch },
};

// a notification's label and icon by its source (fallback when unknown) and its summary without the words the label
// repeats
function notificationHead(
    source: NotificationSource,
    summary: string,
    fallback: string
): { label: string; text: string; icon: LucideIcon } {
    const known = source != null ? NOTIFICATION_LABELS[source] : undefined;
    return known
        ? { label: known.label, text: summary.replace(known.lead, ""), icon: known.icon }
        : { label: fallback, text: summary, icon: Info };
}

const NOTIFICATION_COMPLETED = "completed";
const NOTIFICATION_FAILED = "failed";
const NOTIFICATION_RUNNING = "running";

// a background task's status in its tone (E4): failed in the error tone, completed in success, any other end (stopped,
// killed) or a running one in warning
function statusTone(status: string): string {
    return status === NOTIFICATION_FAILED
        ? "text-error"
        : status === NOTIFICATION_COMPLETED
          ? "text-success"
          : "text-warning";
}

// the status word after the summary, unless the summary already says it ("… failed with exit code 2")
function statusWordOf(summary: string, status: string | undefined): string | undefined {
    if (status == null) return undefined;
    return new RegExp(`\\b${status.replace(/\W/g, "")}\\b`, "i").test(summary) ? undefined : status;
}

// A finished background task (<task-notification> as its own record): "<label> · summary · status", opening to its
// full result (which can be large) through MarkdownMessage.
function TaskNotificationRow({
    summary,
    status,
    result,
    source,
    compact,
}: {
    summary: string;
    status?: string;
    result?: string;
    source: NotificationSource;
    compact: boolean;
}) {
    const [open, setOpen] = useState(false);
    const canExpand = !!result;
    const tone = statusTone(status ?? NOTIFICATION_COMPLETED);
    const head = notificationHead(source, summary, "Background task");
    const word = statusWordOf(head.text, status);
    return (
        <div data-task-notification data-notification-source={source} className={compact ? "my-3" : "my-5"}>
            <button
                type="button"
                disabled={!canExpand}
                aria-expanded={canExpand ? open : undefined}
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    "flex w-full items-center border border-edge-mid text-left text-ink-mid",
                    compact ? "gap-2 rounded-[8px] px-2.5 py-[7px] text-[12.5px]" : "gap-2.5 rounded-[10px] px-3.5 py-2.5 text-[13.5px]",
                    canExpand ? "cursor-pointer hover:border-edge-strong" : "cursor-default"
                )}
            >
                <head.icon size={14} strokeWidth={2.2} className={cn("shrink-0", tone)} aria-hidden />
                <span className="shrink-0 text-secondary">{head.label}</span>
                {head.text ? <span className="min-w-0 truncate">{head.text}</span> : null}
                <span className="min-w-[6px] flex-1" />
                {word ? <span className={cn("shrink-0 text-[12px]", tone)}>{word}</span> : null}
                {canExpand ? (
                    <span className="flex shrink-0 text-muted">
                        <TurnChevron open={open} size={13} strokeWidth={2} />
                    </span>
                ) : null}
            </button>
            <PaneReveal open={open && !!result}>
                <div className="mt-1.5 rounded-[8px] border border-edge-mid bg-surface-code px-3.5 py-3">
                    <MarkdownMessage text={result ?? ""} className={EVENT_PANEL_TEXT} />
                </div>
            </PaneReveal>
        </div>
    );
}

// A background-task notice (a shell finished, a hook skipped): one muted line, not the notification box. It reads its
// source's label; else a structured one (with a status) reads "Background task", a free-text one "Notice". It opens to
// the whole text when the line hides some.
function NoticeRow({
    summary,
    status,
    result,
    source,
    compact,
}: {
    summary: string;
    status?: string;
    result?: string;
    source: NotificationSource;
    compact: boolean;
}) {
    const [open, setOpen] = useState(false);
    const canExpand = summary.includes("\n") || !!result;
    const size = compact ? "text-[12.5px]" : "text-[13.5px]";
    const head = notificationHead(source, summary.split("\n")[0], status ? "Background task" : "Notice");
    const word = statusWordOf(head.text, status);
    return (
        <div data-notice data-notification-source={source} className={compact ? "my-2" : "my-3"}>
            <button
                type="button"
                disabled={!canExpand}
                aria-expanded={canExpand ? open : undefined}
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    "flex w-full min-w-0 items-center gap-2 text-left text-muted",
                    size,
                    canExpand ? "cursor-pointer hover:text-ink-mid" : "cursor-default"
                )}
            >
                {/* a notice stays muted while it runs or when it went well; its icon carries a failure or a stop */}
                <Info
                    size={13}
                    strokeWidth={2.2}
                    className={cn(
                        "shrink-0",
                        status != null &&
                            status !== NOTIFICATION_COMPLETED &&
                            status !== NOTIFICATION_RUNNING &&
                            statusTone(status)
                    )}
                    aria-hidden
                />
                <span className="shrink-0 text-ink-mid">{head.label}</span>
                <span className="min-w-0 truncate">{head.text}</span>
                {word ? (
                    <span className={cn("shrink-0", word !== NOTIFICATION_COMPLETED && statusTone(word))}>· {word}</span>
                ) : null}
                {canExpand ? (
                    <span className="flex shrink-0">
                        <TurnChevron open={open} size={12} strokeWidth={2.2} />
                    </span>
                ) : null}
            </button>
            <PaneReveal open={open && canExpand}>
                <div data-notice-body className={cn("mt-1 ml-[21px] text-muted", size)}>
                    <MarkdownMessage text={summary} breaks className="[overflow-wrap:break-word]" />
                    {result ? <MarkdownMessage text={result} className="mt-1.5" /> : null}
                </div>
            </PaneReveal>
        </div>
    );
}

// a prompt that is one JSON document (a pasted payload) reads as code, not as prose
function isJsonDocument(text: string): boolean {
    if (!/^[[{]/.test(text)) return false;
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
}

// A You bubble renders its markdown as the agent's prose does, keeping the prompt's line breaks; a long one (a run's
// goal, a pasted spec) is clamped behind Show more.
function UserBubbleText({ text, clamp, compact }: { text: string; clamp: boolean; compact: boolean }) {
    const body = text.trim();
    const json = isJsonDocument(body);
    return (
        <ClampedText
            lines="bubble"
            clamp={clamp}
            findTurn
            className={cn(
                "text-foreground [overflow-wrap:anywhere]",
                compact ? "text-[13px] leading-[1.5]" : "text-[14px] leading-[1.55]"
            )}
        >
            {json ? (
                <div data-bubble-code className={cn("whitespace-pre-wrap font-mono", compact ? "text-[11.5px]" : "text-[12.5px]")}>
                    {body}
                </div>
            ) : (
                <MarkdownMessage text={body} breaks />
            )}
        </ClampedText>
    );
}

// the person's bubble; the Rendered view's queued foot draws one too
export function PersonBubble({
    text,
    clamp,
    compact,
    children,
}: {
    text: string;
    clamp: boolean;
    compact: boolean;
    children?: React.ReactNode;
}) {
    return (
        <div
            className={cn(
                "max-w-[82%] bg-surface-hover",
                compact ? "rounded-[10px] px-[11px] py-2" : "rounded-[12px] px-[15px] py-[11px]"
            )}
        >
            {text ? <UserBubbleText text={text} clamp={clamp} compact={compact} /> : null}
            {children}
        </div>
    );
}

// path -> a blob url, or null once it failed; a path still loading is absent
type LocalImages = Record<string, string | null>;

// An <img src> cannot carry the auth header wavesrv needs under tauri (fetchutil.ts), so each attached image path is
// fetched and drawn from a blob url. A failed fetch, or an image that fails to decode (fail), falls back to a file chip.
function useLocalImages(paths: string[]): [LocalImages, (path: string) => void] {
    const key = paths.join("\n");
    const [loaded, setLoaded] = useState<LocalImages>({});
    useEffect(() => {
        setLoaded({});
        if (key === "") {
            return;
        }
        let cancelled = false;
        const urls: string[] = [];
        for (const path of key.split("\n")) {
            fireAndForget(async () => {
                let url: string | null = null;
                try {
                    const resp = await fetch(localFileUrl(getWebServerEndpoint(), path));
                    if (resp.ok && !cancelled) {
                        const blob = await resp.blob();
                        // the blob can land after cleanup revoked the list; a url made then would never be revoked
                        if (!cancelled) {
                            url = URL.createObjectURL(blob);
                            urls.push(url);
                        }
                    }
                } catch (e) {
                    console.warn("bubble attachment: cannot load", path, e);
                }
                if (!cancelled) {
                    setLoaded((cur) => ({ ...cur, [path]: url }));
                }
            });
        }
        return () => {
            cancelled = true;
            urls.forEach((u) => URL.revokeObjectURL(u));
        };
    }, [key]);
    const fail = (path: string) => setLoaded((cur) => ({ ...cur, [path]: null }));
    return [loaded, fail];
}

function FileChip({ path }: { path: string }) {
    return (
        <span
            data-file-chip
            title={path}
            className="flex h-[26px] min-w-0 items-center gap-1.5 rounded-[7px] border border-edge-mid bg-surface px-2 text-[12px] text-secondary"
        >
            <FileIcon size={13} className="shrink-0 text-muted" aria-hidden />
            <span className="max-w-[200px] truncate font-mono">{path.split(/[\\/]/).pop() || path}</span>
        </span>
    );
}

// a bubble's pasted images and attached paths, under its text: thumbnails that open the zoom view, then file chips
function BubbleAttachments({ item, compact }: { item: Extract<LayoutItem, { kind: "user" }>; compact: boolean }) {
    const imagePaths = item.imagePaths ?? [];
    const [loaded, fail] = useLocalImages(imagePaths);
    const pasted = (item.images ?? []).map((img, i) => ({
        src: `data:${img.mediaType};base64,${img.data}`,
        alt: `Pasted image ${i + 1}`,
    }));
    const local = imagePaths.filter((p) => loaded[p] != null);
    const thumbs = [...pasted, ...local.map((p) => ({ src: loaded[p], alt: p.split(/[\\/]/).pop() || p }))];
    const chips = [...imagePaths.filter((p) => loaded[p] === null), ...(item.filePaths ?? [])];
    if (thumbs.length === 0 && chips.length === 0) {
        return null;
    }
    return (
        <div data-bubble-attachments className="mt-2 flex flex-col gap-2 first:mt-0">
            {thumbs.length > 0 ? (
                <ImageThumbs
                    images={thumbs}
                    compact={compact}
                    onError={(i) => {
                        if (i >= pasted.length) fail(local[i - pasted.length]);
                    }}
                />
            ) : null}
            {chips.length > 0 ? (
                <div className="flex min-w-0 flex-wrap gap-1.5">
                    {chips.map((p, i) => (
                        <FileChip key={i} path={p} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}

// A mark's text is "<choice>: <subject>" (permissionLogText). A yes reads "You allowed <subject>"; any other answer
// reads "You answered <choice>", so a refusal never claims an allow. The whole text stays in the row.
const MARK_SEP = ": ";

function PermissionMarkRow({ text, compact }: { text: string; compact: boolean }) {
    const at = text.indexOf(MARK_SEP);
    const choice = at < 0 ? text : text.slice(0, at);
    const subject = at < 0 ? "" : text.slice(at + MARK_SEP.length);
    const allowed = /^yes\b/i.test(choice);
    return (
        <div
            data-permission-mark
            className={cn("flex min-w-0 items-center gap-2 text-muted", compact ? "my-3 text-[12.5px]" : "my-[18px] text-[13.5px]")}
        >
            <Check size={13} strokeWidth={2.6} className="shrink-0 text-ink-mid" aria-hidden />
            <span className="shrink-0">{allowed ? "You allowed" : `You answered ${choice}`}</span>
            {subject ? (
                <span className={cn("min-w-0 truncate font-mono text-ink-mid", compact ? "text-[11.5px]" : "text-[12px]")}>{subject}</span>
            ) : null}
            {/* a bare "Yes" adds nothing to "You allowed"; a scoped one ("…this session") does */}
            {allowed && choice.toLowerCase() !== "yes" ? <span className="min-w-0 truncate">· {choice}</span> : null}
        </div>
    );
}

// memo: every agent:status rebuilds each AgentVM and re-renders every card, while a card's entries change only on its
// own transcript chunk, so an unchanged timeline (up to TIMELINE_RENDER_CAP items) skips the re-render
// copy on select, as in the claude code TUI. the mouseup listener is on window so a drag released outside the
// transcript still copies; the flag keeps a nested timeline (a subagent's) and its host from copying twice.
let selectionCopyArmed = false;
function armSelectionCopy(e: React.MouseEvent<HTMLElement>) {
    if (e.button !== 0 || selectionCopyArmed) return;
    selectionCopyArmed = true;
    const root = e.currentTarget;
    window.addEventListener(
        "mouseup",
        () => {
            selectionCopyArmed = false;
            const sel = window.getSelection();
            if (sel == null || sel.isCollapsed || !root.contains(sel.anchorNode)) return;
            const text = sel.toString();
            if (text.trim() === "") return;
            void writeClipboard(text).then((state) =>
                pushToast(
                    state === "copied"
                        ? { title: `Copied ${text.length} chars to clipboard`, message: "", level: "info" }
                        : { title: "Copy to clipboard failed", message: "", level: "error" }
                )
            );
        },
        { once: true }
    );
}

export const NarrationTimeline = memo(function NarrationTimeline({
    entries,
    accentLatest,
    active,
    renderAll,
    renderers,
    marks,
    thoughts,
    className,
    tail,
    ctx,
    compact,
    unfold,
    entryRow,
}: {
    entries: AgentEntry[];
    accentLatest?: boolean;
    active?: boolean;
    // lifts the item cap, for a whole session loaded or read in full; the clamp stays, since only a find needs it gone
    renderAll?: boolean;
    // draws the registered tool output cards open under their rows; only the rendered view sets it,
    // since always-open cards would bloat the cockpit's narrow cards
    renderers?: boolean;
    // session-local rows the rendered view records after answering a permission prompt, each drawn after the item
    // holding entry afterEntry - 1
    marks?: TimelineMark[];
    // draws a thinking-only message as a muted line between steps; only the rendered view sets it
    thoughts?: boolean;
    className?: string;
    // what the host knows about the agent, for wsh cards' links and Arc's messages
    ctx?: TranscriptContext;
    // a card-width host (agent row, lead card, subagent interior)
    compact?: boolean;
    // drawn after the last item, inside the column
    tail?: React.ReactNode;
    // a find is active: every finished turn's fold draws open and no bubble is clamped, so a match never sits in hidden
    // text
    unfold?: boolean;
    // consulted for each user prompt and Arc message: a row returned replaces the one the timeline would draw
    entryRow?: (entry: AgentEntry, index: number) => React.ReactNode | null;
}) {
    // ctx feeds the layout only through its role (a run brief), so a host's fresh ctx object does not relayout; a host's
    // fresh marks array relayouts only when a mark moves
    const role = ctx?.role;
    const marksKey = (marks ?? []).map((m) => m.afterEntry).join(",");
    const items = useMemo(
        () => layoutTranscript(entries, { active: !!active, ctx: { role }, thoughts, marks }),
        [entries, active, role, thoughts, marksKey]
    );
    // a turn folding after the first render is one that just finished
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
    }, []);
    // a row enters with its fade once: one a turn takes in (its first step, or the live turn's start) is redrawn
    // inside it, and must not fade in again. Recorded after commit, so a render React discards records nothing
    const drawn = useRef(new Set<string>());
    const rendered: string[] = [];
    const entering = (id: string) => {
        rendered.push(id);
        return mounted.current && !drawn.current.has(id);
    };
    useEffect(() => {
        rendered.forEach((id) => drawn.current.add(id));
    });
    const cardCtx = ctx ?? NO_CTX;
    const isCompact = !!compact;
    const visibleItems =
        !renderAll && items.length > TIMELINE_RENDER_CAP ? items.slice(items.length - TIMELINE_RENDER_CAP) : items;
    const lastTurn = items.filter((i) => i.kind === "turn").pop();
    const copyMenu = (text: string) => (e: React.MouseEvent) =>
        ContextMenuModel.getInstance().showContextMenu(
            [
                { label: "Copy text", icon: <Copy size={15} />, click: () => void navigator.clipboard.writeText(text) },
                { label: "Copy conversation", icon: <Copy size={15} />, click: () => void navigator.clipboard.writeText(conversationText(entries)) },
            ],
            e
        );

    const placed = placeMarks(visibleItems, marks ?? []);
    const markRows = (list: TimelineMark[] | undefined) =>
        (list ?? []).map((m, k) => <PermissionMarkRow key={`pm${m.afterEntry}-${k}`} text={m.text} compact={isCompact} />);
    const withMarks = (rows: React.ReactNode[]) => [
        ...markRows(placed.lead),
        ...rows.flatMap((row, idx) => [row, ...markRows(placed.after.get(idx))]),
    ];

    // latest: the item sits in the live or latest turn, or outside any fold, so its cards draw open
    const renderItem = (item: LayoutItem, latest = true): React.ReactNode => {
        if (item.kind === "turn") {
            return (
                <TurnFold
                    key={"f" + item.startIndex}
                    fold={item.fold}
                    live={!!item.live}
                    finishing={mounted.current && item === lastTurn}
                    unfold={!!unfold}
                    compact={isCompact}
                >
                    {item.items.map((child) => renderItem(child, item.latest || !!item.live))}
                </TurnFold>
            );
        }
        if (item.kind === "message") {
            return (
                <motion.div
                    key={item.index}
                    data-find-turn
                    className={cn(
                        "min-w-0",
                        isCompact ? "my-3 text-[13px] leading-[1.55]" : "my-[18px] text-[14px] leading-[1.6]",
                        accentLatest && item.latest ? "text-foreground" : "text-secondary"
                    )}
                    onContextMenu={copyMenu(item.text)}
                    variants={viewFade}
                    initial={entering("m" + item.index) && shouldFadeEntry("message") ? "initial" : false}
                    animate="animate"
                >
                    <MarkdownMessage text={item.text} breaks />
                </motion.div>
            );
        }
        if (item.kind === "thought") {
            return (
                <motion.div
                    key={"t" + item.index}
                    data-thought
                    className={cn("min-w-0", isCompact ? "my-2" : "my-2.5")}
                    variants={viewFade}
                    initial={entering("t" + item.index) && shouldFadeEntry("thought") ? "initial" : false}
                    animate="animate"
                >
                    <ThoughtText text={item.text} compact={isCompact} />
                </motion.div>
            );
        }
        // a host's own row for a prompt or an Arc message (the Rendered view's brainstorm answers) stands in its place
        const at = item.kind === "user" || item.kind === "arc" ? item.index : null;
        const own = at != null ? (entryRow?.(entries[at], at) ?? null) : null;
        if (own != null) {
            return (
                <motion.div
                    key={(item.kind === "arc" ? "a" : "") + at}
                    data-entry-row
                    data-entry-index={at}
                    variants={viewFade}
                    initial={shouldFadeEntry("user") ? "initial" : false}
                    animate="animate"
                >
                    {own}
                </motion.div>
            );
        }
        if (item.kind === "user") {
            return (
                <motion.div
                    key={item.index}
                    data-user-bubble
                    data-entry-index={item.index}
                    className={cn("flex justify-end", isCompact ? "my-3.5 ml-7" : "my-6")}
                    onContextMenu={copyMenu(item.text)}
                    variants={viewFade}
                    initial={shouldFadeEntry("user") ? "initial" : false}
                    animate="animate"
                >
                    <PersonBubble text={item.text} clamp={!unfold} compact={isCompact}>
                        {item.images || item.imagePaths || item.filePaths ? (
                            <BubbleAttachments item={item} compact={isCompact} />
                        ) : null}
                    </PersonBubble>
                </motion.div>
            );
        }
        if (item.kind === "command") {
            return (
                <motion.div
                    key={item.index}
                    variants={viewFade}
                    initial="initial"
                    animate="animate"
                >
                    <CommandChip name={item.name} args={item.args} isSkill={item.isSkill} output={item.output} compact={isCompact} />
                </motion.div>
            );
        }
        if (item.kind === "compaction") {
            return (
                <motion.div
                    key={item.index}
                    variants={viewFade}
                    initial="initial"
                    animate="animate"
                >
                    <CompactionDivider trigger={item.trigger} preTokens={item.preTokens} postTokens={item.postTokens} summary={item.summary} compact={isCompact} />
                </motion.div>
            );
        }
        if (item.kind === "notification") {
            return (
                <motion.div
                    key={item.index}
                    variants={viewFade}
                    initial={entering("n" + item.index) ? "initial" : false}
                    animate="animate"
                >
                    {item.notice ? (
                        <NoticeRow
                            summary={item.summary}
                            status={item.status}
                            result={item.result}
                            source={item.source}
                            compact={isCompact}
                        />
                    ) : (
                        <TaskNotificationRow
                            summary={item.summary}
                            status={item.status}
                            result={item.result}
                            source={item.source}
                            compact={isCompact}
                        />
                    )}
                </motion.div>
            );
        }
        if (item.kind === "interrupted") {
            return (
                <motion.div
                    key={item.index}
                    variants={viewFade}
                    initial="initial"
                    animate="animate"
                >
                    <InterruptedDivider compact={isCompact} />
                </motion.div>
            );
        }
        if (item.kind === "arc" && item.message.kind === "board") {
            return (
                <motion.div
                    key={"a" + item.index}
                    data-arc-message="board"
                    data-user-bubble
                    data-entry-index={item.index}
                    className={cn("flex flex-col items-end gap-1.5", isCompact ? "my-3.5 ml-7" : "my-6")}
                    onContextMenu={copyMenu(item.message.text)}
                    variants={viewFade}
                    initial={shouldFadeEntry("user") ? "initial" : false}
                    animate="animate"
                >
                    <BoardChip message={item.message} compact={isCompact} />
                    <PersonBubble text={item.message.text} clamp={!unfold} compact={isCompact} />
                </motion.div>
            );
        }
        if (item.kind === "arc") {
            return (
                <motion.div key={"a" + item.index} variants={cardVariants} initial="initial" animate="animate">
                    <ArcMessageRow
                        message={item.message}
                        ts={item.ts}
                        idleMs={item.idleMs}
                        latest={item.latest}
                        ctx={cardCtx}
                        compact={isCompact}
                    />
                </motion.div>
            );
        }
        if (item.kind === "card") {
            return (
                <motion.div
                    key={"c" + item.index}
                    className={isCompact ? "my-2" : "my-2.5"}
                    variants={cardVariants}
                    initial={entering("c" + item.index) ? "initial" : false}
                    animate="animate"
                >
                    <WshCardItem step={item.step} ctx={cardCtx} compact={isCompact} />
                </motion.div>
            );
        }
        if (item.kind === "shell") {
            return (
                <motion.div key={"sh" + item.index} variants={cardVariants} initial="initial" animate="animate">
                    <ShellRunRow
                        command={item.command}
                        stdout={item.stdout}
                        stderr={item.stderr}
                        exit={item.exit}
                        cancelled={item.cancelled}
                        truncated={item.truncated}
                        excluded={item.excluded}
                        compact={isCompact}
                    />
                </motion.div>
            );
        }
        // a new stretch arrives as one box, so its fade is one entrance, never a burst of tool lines
        return (
            <motion.div
                key={"s" + item.startIndex}
                variants={viewFade}
                initial={entering("s" + item.startIndex) ? "initial" : false}
                animate="animate"
            >
                <StepBox
                    steps={item.steps}
                    thoughts={item.thoughts}
                    renderers={renderers}
                    latest={latest}
                    ctx={cardCtx}
                    compact={isCompact}
                />
            </motion.div>
        );
    };

    return (
        <div className={cn("leading-relaxed", className)} onMouseDown={armSelectionCopy}>
            <AnimatePresence initial={false}>{withMarks(visibleItems.map((item) => renderItem(item)))}</AnimatePresence>
            {tail}
        </div>
    );
});

