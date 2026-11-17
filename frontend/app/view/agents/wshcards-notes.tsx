// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// wsh note, jira and brainstorm judge calls: the note card, the Jira show view and the judge's card. The model
// (notescards.ts) decides what each shows; this draws it.

import { getApi } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { openTarget } from "@/app/view/jarvis/openref";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUpRight, Check, File, FileText, Image, LoaderCircle, MessageSquare, Scale, Ticket } from "lucide-react";
import { useEffect, useState } from "react";
import { samePath } from "./brainstormmodel";
import { brainstormAtom } from "./brainstormstore";
import {
    findNote,
    jiraDateOf,
    jiraKeyOf,
    jiraShowOf,
    jiraTicketOf,
    judgeCardOf,
    noteCardOf,
    noteDataKey,
    noteIdOf,
    noteNeedsRecord,
    type JiraTicketCard,
    type JudgeCard,
    type NoteCard,
    type NoteSpan,
} from "./notescards";
import { LoadFailure } from "./recordedoutput";
import { fmtDuration } from "./runcompletion";
import { CallFacts } from "./wshchangerow";
import { useWshData } from "./wshdata";
import { AsOfNow, type WshRendererProps, type WshRenderers } from "./wshrenderers";

// how long a Jira read may take: the same budget the initiative form gives it
const JIRA_RPC_TIMEOUT_MS = 180_000;

const LINK = "flex shrink-0 cursor-pointer items-center gap-1 text-[12px] text-accent hover:text-accenthover";

function LoadNote({ compact, children }: { compact: boolean; children: string }) {
    return <div className={cn("text-muted", compact ? "mt-1 text-[11.5px]" : "mt-1 text-[12px]")}>{children}</div>;
}

// ---- note-add ----

function NoteBullet({ spans }: { spans: NoteSpan[] }) {
    return (
        <div data-note-bullet className="flex gap-2">
            <span className="text-ink-faint">{"•"}</span>
            <span>
                {spans.map((s, i) => (
                    <span key={i} className={s.strong ? "text-foreground" : undefined}>
                        {s.text}
                    </span>
                ))}
            </span>
        </div>
    );
}

function OpenNote({ noteId, props }: { noteId?: string; props: WshRendererProps }) {
    const model = props.ctx.model;
    if (model == null || !noteId) {
        return null;
    }
    return (
        <button
            type="button"
            aria-label="Open note"
            onClick={() => fireAndForget(() => openTarget(model, { kind: "note", noteId }))}
            className={LINK}
        >
            {props.compact ? null : "Open note"}
            <ArrowUpRight size={props.compact ? 13 : 11} strokeWidth={2.2} aria-hidden />
        </button>
    );
}

function NoteCardView({ card, props, loadFailed }: { card: NoteCard; props: WshRendererProps; loadFailed: boolean }) {
    const { action, compact } = props;
    const head = (
        <div className={cn("flex items-center font-sans", compact ? "gap-[7px] py-0.5" : "gap-2.5 px-3.5 py-3")}>
            <FileText size={compact ? 12 : 14} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />
            <span className={cn("shrink-0 text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}>
                Saved a note
            </span>
            <span
                className={cn(
                    "min-w-0 truncate text-foreground",
                    compact ? "text-[12.5px]" : "text-[13.5px] font-semibold"
                )}
            >
                {card.title}
            </span>
            <span className="flex-1" />
            <OpenNote noteId={card.noteId} props={props} />
            <CallFacts action={action} compact={compact} />
        </div>
    );
    const failed = loadFailed ? (
        <LoadFailure
            message="The note did not load, so this card shows only what the call passed."
            action={action}
            compact={compact}
            className="mt-1"
        />
    ) : null;
    if (compact) {
        return (
            <div data-note-card>
                {head}
                {failed}
            </div>
        );
    }
    return (
        <div data-note-card className="overflow-hidden rounded-[10px] border border-edge-mid">
            {head}
            {card.bullets.length > 0 ? (
                <div className="border-t border-edge-faint px-3.5 pb-3 pt-2.5 font-sans text-[13px] leading-[1.6] text-secondary">
                    {card.bullets.map((b, i) => (
                        <NoteBullet key={i} spans={b} />
                    ))}
                </div>
            ) : null}
            {failed ? <div className="px-3.5 pb-2.5">{failed}</div> : null}
        </div>
    );
}

async function fetchNote(title: string, id: string | undefined): Promise<UserNote | null> {
    return findNote(await RpcApi.NoteListCommand(TabRpcClient), id, title) ?? null;
}

function NoteAddCard(props: WshRendererProps) {
    const { call, action } = props;
    // a call that carried both the note's id and its body needs nothing more
    const key = noteNeedsRecord(call, action) ? noteDataKey(call, action) : null;
    const state = useWshData<UserNote | null>(key, () => fetchNote(call.args[0] ?? "", noteIdOf(action)));
    return (
        <NoteCardView
            card={noteCardOf(call, action, state.data ?? undefined)}
            props={props}
            loadFailed={state.status === "error"}
        />
    );
}

// ---- jira-show ----

function TicketTile({ filename, image, compact }: { filename: string; image: boolean; compact: boolean }) {
    const Icon = image ? Image : File;
    return (
        <div
            className={cn("overflow-hidden rounded-[6px] border border-edge-mid", compact ? "w-[104px]" : "w-[132px]")}
        >
            <div
                className={cn("flex items-center justify-center bg-surface-raised", compact ? "h-[48px]" : "h-[62px]")}
            >
                <Icon size={18} strokeWidth={1.8} className="text-ink-faint" aria-hidden />
            </div>
            <div className="truncate px-[7px] py-[5px] text-[11px] text-muted" title={filename}>
                {filename}
            </div>
        </div>
    );
}

function TicketView({ card, compact, asOfNow }: { card: JiraTicketCard; compact: boolean; asOfNow: boolean }) {
    const [full, setFull] = useState(false);
    const pad = compact ? "px-2.5" : "px-3";
    const { description, comment } = card;
    const date = jiraDateOf(comment?.createdTs);
    return (
        <div data-jira-card className="overflow-hidden rounded-[8px] border border-edge-mid bg-surface font-sans">
            <div className={cn("flex items-center gap-2.5 pb-2 pt-2.5", pad)}>
                <Ticket size={14} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />
                <span className="shrink-0 font-mono text-[12px] text-ink-mid">{card.key}</span>
                <span
                    className={cn(
                        "min-w-0 truncate font-semibold text-foreground",
                        compact ? "text-[12.5px]" : "text-[13.5px]"
                    )}
                >
                    {card.summary}
                </span>
                {!compact ? <span className="shrink-0 text-[12px] text-muted">{card.typeStatus}</span> : null}
                <span className="flex-1" />
                {asOfNow ? <AsOfNow /> : null}
                {card.url ? (
                    <button type="button" onClick={() => getApi().openExternal(card.url!)} className={LINK}>
                        Open in Jira
                        <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
                    </button>
                ) : null}
            </div>
            {compact ? <div className={cn("pb-1.5 text-[12px] text-muted", pad)}>{card.typeStatus}</div> : null}
            {description.full ? (
                <div
                    data-jira-description
                    className={cn(
                        "whitespace-pre-wrap pb-2.5 pt-0.5 text-secondary",
                        pad,
                        compact ? "text-[12.5px] leading-[1.55]" : "text-[13px] leading-[1.6]"
                    )}
                >
                    {full ? description.full : description.text}
                </div>
            ) : null}
            {description.clamped ? (
                <button
                    type="button"
                    onClick={() => setFull((v) => !v)}
                    className={cn("block cursor-pointer pb-2.5 text-[12px] text-muted hover:text-primary", pad)}
                >
                    {full ? "Show less" : "Show the full description"}
                </button>
            ) : null}
            {card.attachments.length > 0 ? (
                <div data-jira-attachments className={cn("flex flex-wrap gap-2 pb-3", pad)}>
                    {card.attachments.map((a) => (
                        <TicketTile key={a.id} filename={a.filename} image={a.image} compact={compact} />
                    ))}
                </div>
            ) : null}
            {comment ? (
                <div
                    data-jira-comment
                    className={cn(
                        "flex gap-2.5 border-t border-edge-faint py-[9px] text-[12.5px] leading-normal text-ink-mid",
                        pad
                    )}
                >
                    <MessageSquare size={13} strokeWidth={2} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0">
                        {comment.author ? <span className="text-secondary">{comment.author}</span> : null}
                        {comment.author && date ? " · " : null}
                        {date}
                        {comment.author || date ? " · " : null}
                        {comment.text}
                    </span>
                </div>
            ) : null}
            {card.project ? (
                <div data-jira-project className={cn("border-t border-edge-faint py-2 text-[12px] text-muted", pad)}>
                    Arc project <span className="text-secondary">{card.project}</span>
                    {card.projectSure ? null : " (not sure)"}
                </div>
            ) : null}
        </div>
    );
}

function JiraShowView(props: WshRendererProps) {
    const { call, action, compact } = props;
    const own = jiraShowOf(action);
    const key = jiraKeyOf(call);
    const state = useWshData<CommandJiraShowRtnData>(own == null && key ? `jira:${key}` : null, () =>
        RpcApi.JiraShowCommand(TabRpcClient, { key, via: "lookup" }, { timeout: JIRA_RPC_TIMEOUT_MS })
    );
    const data = own ?? state.data;
    if (data != null) {
        return <TicketView card={jiraTicketOf(data)} compact={compact} asOfNow={own == null} />;
    }
    if (state.status === "error") {
        return <LoadFailure message={`${key} did not load: ${state.error}`} action={action} compact={compact} />;
    }
    return <LoadNote compact={compact}>{`Reading ${key}…`}</LoadNote>;
}

// ---- brainstorm-judge ----

// the elapsed of a judge still weighing, ticking here so the memoised timeline does not re-render each second
function WeighingFor({ since }: { since?: number }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);
    return since == null ? null : <span data-judge-elapsed>{` · ${fmtDuration(Math.max(0, now - since))}`}</span>;
}

function JudgeStatus({ card, since }: { card: JudgeCard; since?: number }) {
    if (card.state === "weighing") {
        return (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-ink-mid">
                <LoaderCircle
                    size={12}
                    strokeWidth={2.4}
                    role="img"
                    aria-label="Weighing"
                    className="animate-spin motion-reduce:animate-none"
                />
                <span>
                    weighing
                    <WeighingFor since={since} />
                </span>
            </span>
        );
    }
    if (card.state === "done") {
        return (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-success">
                <Check size={12} strokeWidth={2.8} aria-hidden />
                done
            </span>
        );
    }
    return card.state === "failed" ? <span className="shrink-0 text-[12px] text-error">failed</span> : null;
}

function approachesText(n: number): string {
    return n === 1 ? "1 approach" : `${n} approaches`;
}

function JudgeCardView({ card, props }: { card: JudgeCard; props: WshRendererProps }) {
    const { action, compact } = props;
    const since = action.ts ?? action.startedTs;
    return (
        <div data-judge-card={card.state} className="overflow-hidden rounded-[10px] border border-edge-mid font-sans">
            <div className={cn("flex items-center", compact ? "gap-2 px-3 py-2.5" : "gap-2.5 px-3.5 py-3")}>
                <Scale size={compact ? 14 : 15} strokeWidth={2} className="shrink-0 text-skill" aria-hidden />
                <span className={cn("shrink-0 text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}>
                    Judge started
                </span>
                {card.n != null ? (
                    <span
                        className={cn(
                            "shrink-0 font-semibold text-foreground",
                            compact ? "text-[12.5px]" : "text-[13.5px]"
                        )}
                    >
                        question {card.n}
                    </span>
                ) : null}
                {card.approaches ? (
                    <span className={cn("min-w-0 truncate text-muted", compact ? "text-[12px]" : "text-[12.5px]")}>
                        {approachesText(card.approaches)}
                    </span>
                ) : null}
                <span className="flex-1" />
                <JudgeStatus card={card} since={since} />
                <CallFacts action={action} compact={compact} />
            </div>
            {card.text ? (
                <div
                    data-judge-question
                    className={cn(
                        "border-t border-edge-faint text-secondary",
                        compact ? "px-3 py-2 text-[12.5px]" : "px-3.5 pb-[11px] pt-[9px] text-[13px]"
                    )}
                >
                    {card.text}
                </div>
            ) : null}
        </div>
    );
}

function BrainstormJudgeCard(props: WshRendererProps) {
    const { agentId, brainstormFile } = props.ctx;
    const state = useAtomValue(brainstormAtom(agentId ?? ""));
    // another brainstorm than the one this transcript's agent has attached now is no record of this judge
    const file = state != null && (!brainstormFile || samePath(state.path, brainstormFile)) ? state.file : null;
    return <JudgeCardView card={judgeCardOf(file)} props={props} />;
}

export const NOTES_RENDERERS: WshRenderers = {
    "note-add": NoteAddCard,
    "jira-show": JiraShowView,
    "brainstorm-judge": BrainstormJudgeCard,
};
