// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The ticket bar above an open initiative's plan (board Initiative): compact by default, the chevron or the
// first line expands it to the ticket's description and acceptance criteria. It draws the last-seen copy and
// talks to Jira only when you press refresh.

import { paneReveal, turnTransition } from "@/app/element/motiontokens";
import { getSettingsKeyAtom, openLink } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { atom, useAtom, useAtomValue, type PrimitiveAtom } from "jotai";
import { ArrowUpRight, ChevronRight, RefreshCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { stateRpcTimeoutMs } from "./briefingstore";
import { effortDetailAtom, loadEffortDetail } from "./effortstore";
import { normalizeKey, parseJiraError, STATUS_CHIP } from "./jiraticket";
import { ticketBarModel } from "./ticketbar";

// effort orefs whose bar is expanded: the Brief unmounts on a surface switch, so this outlives it
const ticketOpenAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;
// the refresh just wrote a newer copy, so the cached effort is stale whatever its updatedts says
const ALWAYS_REFETCH = Number.MAX_SAFE_INTEGER;

// the key drawn as a link to the ticket in Jira, plain text without a site; it never opens the row under it
export function TicketKeyLink({
    ticketKey,
    url,
    className,
    plainClassName,
    children,
}: {
    ticketKey: string;
    url: string | null;
    className?: string;
    plainClassName?: string;
    children?: ReactNode;
}) {
    if (url == null) {
        return <span className={plainClassName}>{ticketKey}</span>;
    }
    return (
        <a
            href={url}
            title={`Open ${ticketKey} in Jira`}
            data-jarvis-ticket-link={ticketKey}
            onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openLink(url);
            }}
            className={cn("text-accent-soft hover:text-accent", className)}
        >
            {ticketKey}
            {children}
        </a>
    );
}

// the comment a Jira post wrote, drawn wherever its note is read: the sidebar's note card and the activity feed
export function JiraCommentLink({
    url,
    label = "View comment ↗",
    className,
}: {
    url: string;
    label?: string;
    className?: string;
}) {
    return (
        <a
            href={url}
            title="Open the comment in Jira"
            data-jarvis-jira-comment-link
            onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openLink(url);
            }}
            className={cn("text-accent-soft hover:text-accent", className)}
        >
            {label}
        </a>
    );
}

export function TicketBar({ oref }: { oref: string }) {
    const effort = useAtomValue(effortDetailAtom).get(oref);
    const site = useAtomValue(getSettingsKeyAtom("jira:site"));
    const [openSet, setOpenSet] = useAtom(ticketOpenAtom);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const m = effort != null ? ticketBarModel(effort, site, Date.now()) : null;
    if (m == null) {
        return null;
    }
    const open = openSet.has(oref);
    const setOpen = (next: boolean) =>
        setOpenSet((cur) => {
            const s = new Set(cur);
            if (next) {
                s.add(oref);
            } else {
                s.delete(oref);
            }
            return s;
        });
    const refresh = async () => {
        const key = normalizeKey(m.key);
        if (key === "") {
            setError(`${m.key} is not a Jira key`);
            return;
        }
        setRefreshing(true);
        setError(null);
        try {
            await RpcApi.JiraShowCommand(TabRpcClient, { key, via: "refresh" }, { timeout: stateRpcTimeoutMs });
            await loadEffortDetail(oref, ALWAYS_REFETCH);
        } catch (e) {
            setError(parseJiraError(e).message);
        } finally {
            setRefreshing(false);
        }
    };
    const toggleLabel = open ? "Collapse the ticket" : "Expand the ticket";
    return (
        // continues the open card's frame down to the plan below it
        <div className="border-x border-border bg-surface pl-2.5 pr-3.5 pt-3">
            <section
                aria-label={`Jira ticket ${m.key}`}
                data-jarvis-ticket-bar={open ? "open" : "folded"}
                className={cn(
                    "flex flex-col rounded-[8px] bg-surface-raised",
                    open ? "pb-3.5 pl-2 pr-3 pt-2.5" : "py-1.5 pl-2 pr-2.5"
                )}
            >
                <div className="flex min-w-0 items-center gap-2.5">
                    <button
                        type="button"
                        data-jarvis-ticket-chevron
                        aria-expanded={open}
                        aria-label={toggleLabel}
                        title={toggleLabel}
                        onClick={() => setOpen(!open)}
                        className="flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded-[5px] text-ink-mid hover:text-primary"
                    >
                        <ChevronRight
                            size={12}
                            strokeWidth={2.2}
                            aria-hidden
                            style={turnTransition}
                            className={cn("transition-transform motion-reduce:transition-none", open && "rotate-90")}
                        />
                    </button>
                    <TicketKeyLink
                        ticketKey={m.key}
                        url={m.url}
                        className="inline-flex flex-none items-center gap-[5px] font-mono text-[12px] font-bold"
                        plainClassName="flex-none font-mono text-[12px] font-bold text-primary"
                    >
                        <ArrowUpRight size={10} strokeWidth={2.2} aria-hidden />
                    </TicketKeyLink>
                    {m.type !== "" ? (
                        <span data-jarvis-ticket-type className="flex-none text-[12px] text-ink-mid">
                            {m.type}
                        </span>
                    ) : null}
                    {m.status !== "" ? (
                        <span
                            data-jarvis-ticket-status={m.tone}
                            style={turnTransition}
                            className={cn(
                                "inline-flex flex-none items-center gap-1.5 rounded-[6px] px-[7px] py-px text-[11.5px] font-semibold transition-colors motion-reduce:transition-none",
                                STATUS_CHIP[m.tone]
                            )}
                        >
                            <span className="h-1.5 w-1.5 rounded-full bg-current" />
                            {m.status}
                        </span>
                    ) : null}
                    {!open && m.firstLine !== "" ? (
                        <span
                            data-jarvis-ticket-first
                            onClick={() => setOpen(true)}
                            title={m.firstLine}
                            className="min-w-0 flex-1 cursor-pointer truncate text-[12px] text-muted"
                        >
                            {m.firstLine}
                        </span>
                    ) : (
                        <span className="flex-1" />
                    )}
                    {error != null ? (
                        <span
                            data-jarvis-ticket-error
                            title={error}
                            className="min-w-0 max-w-[40%] flex-none truncate text-[11.5px] text-error"
                        >
                            {error}
                        </span>
                    ) : null}
                    <span
                        data-jarvis-ticket-seen
                        title={m.seenTitle || undefined}
                        className="flex-none text-[11.5px] text-muted"
                    >
                        {m.seen}
                    </span>
                    <button
                        type="button"
                        data-jarvis-ticket-refresh={refreshing ? "running" : "idle"}
                        aria-label="Refresh from Jira"
                        title="Refresh from Jira"
                        disabled={refreshing}
                        onClick={() => void refresh()}
                        className="flex h-[22px] w-[22px] flex-none cursor-pointer items-center justify-center rounded-[5px] text-ink-mid hover:text-primary disabled:cursor-default"
                    >
                        <RefreshCw
                            size={12}
                            aria-hidden
                            className={cn(refreshing && "animate-spin motion-reduce:animate-none")}
                        />
                    </button>
                </div>
                <AnimatePresence initial={false}>
                    {open ? (
                        <motion.div
                            key="body"
                            data-jarvis-ticket-body
                            variants={paneReveal}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            className="overflow-hidden"
                        >
                            <div className="flex flex-col gap-2.5 pl-[30px] pt-2.5">
                                {m.description !== "" ? (
                                    <p
                                        data-jarvis-ticket-description
                                        className="m-0 max-w-[78ch] whitespace-pre-line text-[12.5px] leading-[1.6] text-secondary"
                                    >
                                        {m.description}
                                    </p>
                                ) : null}
                                {m.acceptance.length > 0 ? (
                                    <div className="flex max-w-[78ch] flex-col gap-[5px]">
                                        <span className="text-[12px] font-semibold text-ink-mid">
                                            Acceptance criteria
                                        </span>
                                        {m.acceptance.map((a, i) => (
                                            <div
                                                key={i}
                                                data-jarvis-ticket-criterion
                                                className="flex items-baseline gap-[9px] text-[12.5px] leading-[1.5] text-secondary"
                                            >
                                                <span className="h-1 w-1 flex-none -translate-y-0.5 rounded-full bg-ink-faint" />
                                                {a}
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        </motion.div>
                    ) : null}
                </AnimatePresence>
            </section>
        </div>
    );
}
