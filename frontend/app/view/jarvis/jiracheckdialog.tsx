// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Check Jira: your open tickets without an initiative, each with Make initiative. The check runs when the
// dialog opens and on Check again, never on a remount: its result and the Building in Agent marks live in
// jiracheck.ts's atoms, which outlast the Brief while Make initiative's agent has the Agent surface.

import { pushToast } from "@/app/cockpit/notificationstore";
import { cardVariants, microFade, MOTION, paneReveal } from "@/app/element/motiontokens";
import { ModalShell } from "@/app/modals/modalshell";
import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUpRight, Check, CircleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo } from "react";
import { briefEffortIndexAtom } from "./jarvisstore";
import { openJiraSettings } from "./jiraactions";
import {
    checkFailure,
    checkJiraOpenAtom,
    checkJiraStateAtom,
    checkSubtitle,
    emptyDetail,
    footerLine,
    headerWhen,
    jiraBuildingAtom,
    refusedHeadline,
    ticketMeta,
    visibleRows,
    type CheckState,
} from "./jiracheck";
import { makeInitiative } from "./jiramake";
import { parseJiraError, ticketUrl } from "./jiraticket";
import { openTarget } from "./openref";

// the search plus wavesrv's project inference over each project's history outlasts the default 5s rpc budget
const JIRA_CHECK_TIMEOUT_MS = 60_000;

const ROW_GRID = "grid grid-cols-[76px_minmax(0,1fr)_190px_150px_28px] items-center gap-[14px]";
// the loading board's summary bars, as a share of the column
const BAR_WIDTHS = ["78%", "64%", "71%"];

// a newer check, or a close, supersedes the one in flight: its answer is dropped
let checkSeq = 0;

function jiraSite(): string {
    return (globalStore.get(atoms.settingsAtom)?.["jira:site"] as string | undefined) ?? "";
}

async function runJiraCheck(): Promise<void> {
    const seq = ++checkSeq;
    const prev = globalStore.get(checkJiraStateAtom);
    globalStore.set(checkJiraStateAtom, { kind: "loading", prev: prev?.kind === "list" ? prev.data : undefined });
    let next: CheckState;
    try {
        next = { kind: "list", data: await RpcApi.JiraCheckCommand(TabRpcClient, { timeout: JIRA_CHECK_TIMEOUT_MS }) };
    } catch (err) {
        const failure = parseJiraError(err);
        // "Last checked" comes from wavesrv's in-memory status, read without calling Jira
        const conn =
            failure.kind === "refused"
                ? await RpcApi.JiraConnectionCommand(TabRpcClient, { test: false }).catch((e) => {
                      console.error("jira: reading the connection status failed", e);
                      return null;
                  })
                : null;
        next = checkFailure(failure, conn?.site || jiraSite(), conn?.lastokts ?? 0);
    }
    if (seq === checkSeq) {
        globalStore.set(checkJiraStateAtom, next);
    }
}

export function closeCheckJira(): void {
    checkSeq++;
    globalStore.set(checkJiraOpenAtom, false);
    globalStore.set(checkJiraStateAtom, null);
    globalStore.set(jiraBuildingAtom, {});
}

async function make(model: AgentsViewModel, row: JiraTicketRow): Promise<void> {
    globalStore.set(jiraBuildingAtom, (b) => ({ ...b, [row.key]: "" }));
    try {
        const tabId = await makeInitiative(model, row);
        globalStore.set(jiraBuildingAtom, (b) => (row.key in b ? { ...b, [row.key]: tabId } : b));
    } catch (err) {
        globalStore.set(jiraBuildingAtom, (b) => {
            const { [row.key]: _, ...rest } = b;
            return rest;
        });
        pushToast({
            title: `Couldn't start an agent for ${row.key}`,
            message: err instanceof Error ? err.message : String(err),
            level: "error",
        });
    }
}

function openInJira(url: string | null) {
    if (url) {
        getApi().openExternal(url);
    }
}

export function JiraCheckDialog({ model }: { model: AgentsViewModel }) {
    const open = useAtomValue(checkJiraOpenAtom);
    const state = useAtomValue(checkJiraStateAtom);
    const index = useAtomValue(briefEffortIndexAtom);
    const settingsSite = useAtomValue(atoms.settingsAtom)?.["jira:site"] as string | undefined;

    // opening checks once; a remount (back from the Agent surface) finds the state already there
    useEffect(() => {
        if (open && globalStore.get(checkJiraStateAtom) == null) {
            void runJiraCheck();
        }
    }, [open]);

    const onInitiative = useMemo(() => new Set([...index.values()].map((e) => e.ticket).filter(Boolean)), [index]);
    const rows = state?.kind === "list" ? visibleRows(state.data, onInitiative) : [];
    const loading = state == null || state.kind === "loading";
    const shown: CheckState = state ?? { kind: "loading" };
    // a list whose rows have all left reads as Nothing new
    const bodyKind = state?.kind === "list" && rows.length === 0 ? "empty" : shown.kind;
    const covered = state?.kind === "list" ? state.data.covered + state.data.tickets.length - rows.length : 0;
    const footer = state?.kind === "list" ? footerLine(covered) : "";
    const subtitle = checkSubtitle(shown, rows.length);
    const when = headerWhen(shown, settingsSite, Date.now());
    const toSettings = () => {
        closeCheckJira();
        openJiraSettings(model);
    };

    return (
        <ModalShell open={open} onClose={closeCheckJira} className="w-[900px] max-w-[calc(100vw-48px)]">
            <div data-jira-check className="flex flex-col">
                <div className="flex items-center gap-3 border-b border-border px-[18px] py-[15px]">
                    <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                        <span className="text-[15px] font-semibold text-foreground">Your Jira tickets</span>
                        {subtitle ? (
                            <span data-jira-check-subtitle className="text-[12px] text-ink-mid">
                                {subtitle}
                            </span>
                        ) : null}
                    </div>
                    {when ? <span className="font-mono text-[10.5px] text-muted">{when}</span> : null}
                    <button
                        type="button"
                        data-jira-check-again
                        disabled={loading}
                        onClick={() => void runJiraCheck()}
                        className={cn(
                            "grid h-[28px] rounded-[7px] border border-edge-mid px-2.5 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                            loading ? "text-muted" : "cursor-pointer text-secondary hover:border-edge-strong"
                        )}
                    >
                        {/* both labels share one cell, so Checking… keeps Check again's width */}
                        <span aria-hidden className="invisible col-start-1 row-start-1">
                            Check again
                        </span>
                        <span className="col-start-1 row-start-1">{loading ? "Checking…" : "Check again"}</span>
                    </button>
                    <button
                        type="button"
                        aria-label="Close"
                        onClick={closeCheckJira}
                        className="flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[7px] text-ink-mid hover:bg-surface-hover hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                        <X aria-hidden size={13} strokeWidth={2.2} />
                    </button>
                </div>
                {/* a fixed height: the bars, the rows and the states trade places without moving anything */}
                <div data-jira-check-body className="relative h-[292px] overflow-hidden">
                    <AnimatePresence mode="popLayout" initial={false}>
                        <motion.div
                            key={bodyKind}
                            data-jira-check-state={bodyKind}
                            variants={microFade}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            className="h-full"
                        >
                            <CheckBody model={model} state={shown} rows={rows} onSettings={toSettings} />
                        </motion.div>
                    </AnimatePresence>
                </div>
                <AnimatePresence initial={false}>
                    {footer ? (
                        <motion.div
                            key="footer"
                            data-jira-check-footer
                            variants={paneReveal}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            className="overflow-hidden"
                        >
                            <div className="border-t border-border px-[26px] py-3 text-[12px] text-muted">{footer}</div>
                        </motion.div>
                    ) : null}
                </AnimatePresence>
            </div>
        </ModalShell>
    );
}

function CheckBody({
    model,
    state,
    rows,
    onSettings,
}: {
    model: AgentsViewModel;
    state: CheckState;
    rows: JiraTicketRow[];
    onSettings: () => void;
}) {
    switch (state.kind) {
        case "loading":
            return <LoadingBars />;
        case "list":
            return rows.length > 0 ? (
                <TicketList model={model} site={state.data.site} rows={rows} />
            ) : (
                <StateBlock>
                    <span className="flex items-center gap-2 text-[13.5px] text-ink-hi">
                        <Check aria-hidden size={14} strokeWidth={2.4} className="text-success" />
                        Every ticket assigned to you has an initiative.
                    </span>
                    <span className="pl-[22px] text-[12px] text-muted">
                        {emptyDetail(state.data.tickets.length + state.data.covered)}
                    </span>
                </StateBlock>
            );
        case "off":
            return (
                <StateBlock className="items-start gap-3">
                    <span className="max-w-[60ch] text-[13.5px] leading-normal text-ink-hi">
                        Arc isn't connected to Jira yet. Add your site, email and an API token, then check again.
                    </span>
                    <button
                        type="button"
                        data-jira-connect
                        onClick={onSettings}
                        className="flex h-[30px] cursor-pointer items-center rounded-[7px] border border-accent/50 bg-accentbg px-3 text-[12px] font-semibold text-accent-soft hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                        Connect Jira
                    </button>
                </StateBlock>
            );
        case "refused":
            return (
                <StateBlock className="items-start">
                    <ErrorLine>{refusedHeadline(state.status)}</ErrorLine>
                    <span data-jira-check-refused className="pl-[22px] font-mono text-[11px] text-ink-mid">
                        {state.status} · {state.message}
                    </span>
                    <button
                        type="button"
                        data-jira-replace-token
                        onClick={onSettings}
                        className="ml-[22px] mt-1.5 flex h-[30px] cursor-pointer items-center rounded-[7px] border border-edge-mid px-3 text-[12px] font-semibold text-secondary hover:border-edge-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                        Replace token
                    </button>
                </StateBlock>
            );
        case "other":
            return (
                <StateBlock className="items-start">
                    <ErrorLine>Arc couldn't reach Jira.</ErrorLine>
                    <span className="pl-[22px] font-mono text-[11px] text-ink-mid">{state.message}</span>
                </StateBlock>
            );
    }
}

function StateBlock({ className, children }: { className?: string; children: React.ReactNode }) {
    return (
        <div className={cn("flex h-full flex-col justify-center gap-1.5 px-[26px] py-6", className)}>{children}</div>
    );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
    return (
        <span className="flex max-w-[60ch] items-start gap-2 text-[13.5px] leading-normal text-ink-hi">
            <CircleAlert aria-hidden size={14} strokeWidth={2.2} className="mt-[3px] flex-none text-error" />
            {children}
        </span>
    );
}

function LoadingBars() {
    return (
        <div data-jira-check-bars className="flex flex-col gap-[22px] px-[26px] py-3">
            {BAR_WIDTHS.map((w) => (
                <div
                    key={w}
                    data-jira-check-bar
                    className="grid grid-cols-[76px_minmax(0,1fr)_150px] items-center gap-[14px]"
                >
                    <span className="h-3 w-[58px] rounded-[3px] bg-surface-hover" />
                    <div className="flex flex-col gap-[7px]">
                        <span className="h-[11px] rounded-[3px] bg-surface-hover" style={{ width: w }} />
                        <span className="h-[9px] w-[150px] rounded-[3px] bg-surface-hover" />
                    </div>
                    <span className="h-[30px] rounded-[7px] bg-surface-hover" />
                </div>
            ))}
        </div>
    );
}

function TicketList({ model, site, rows }: { model: AgentsViewModel; site: string; rows: JiraTicketRow[] }) {
    const building = useAtomValue(jiraBuildingAtom);
    const now = Date.now();
    return (
        <div className="flex h-full flex-col">
            <div className={cn(ROW_GRID, "px-[26px] pb-1.5 pt-2.5 text-[11.5px] text-muted")}>
                <span>Ticket</span>
                <span>Summary</span>
                <span>Project</span>
                <span />
                <span />
            </div>
            <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-2">
                <AnimatePresence mode="popLayout" initial={false}>
                    {rows.map((row) => (
                        <motion.div
                            key={row.key}
                            layout
                            data-jira-row={row.key}
                            variants={cardVariants}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            transition={{ layout: { duration: MOTION.durMacro, ease: MOTION.easeFluid } }}
                            className={cn(ROW_GRID, "rounded-[8px] px-4 py-2.5")}
                        >
                            <TicketRow model={model} site={site} row={row} now={now} tabId={building[row.key]} />
                        </motion.div>
                    ))}
                </AnimatePresence>
            </div>
        </div>
    );
}

function TicketRow({
    model,
    site,
    row,
    now,
    tabId,
}: {
    model: AgentsViewModel;
    site: string;
    row: JiraTicketRow;
    now: number;
    tabId: string | undefined;
}) {
    const url = row.url || ticketUrl(site, row.key);
    const sure = row.sure && !!row.project;
    return (
        <>
            <a
                href={url ?? undefined}
                title={`Open ${row.key} in Jira`}
                onClick={(e) => {
                    e.preventDefault();
                    openInJira(url);
                }}
                className="font-mono text-[12px] font-bold text-accent-soft hover:text-accent"
            >
                {row.key}
            </a>
            <div className="flex min-w-0 flex-col gap-[3px]">
                <span className="truncate text-[13px] text-ink-hi">{row.summary}</span>
                <span className="whitespace-nowrap text-[11.5px] text-muted">{ticketMeta(row, now)}</span>
            </div>
            <div className="flex min-w-0 flex-col gap-[3px]">
                {sure ? (
                    <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-secondary">
                        <Check aria-hidden size={12} strokeWidth={2.4} className="flex-none text-success" />
                        <span className="truncate">{row.project}</span>
                    </span>
                ) : (
                    <span
                        data-jira-agent-asks
                        className="flex items-center gap-1.5 text-[12.5px] font-semibold text-warning"
                    >
                        <CircleAlert aria-hidden size={12} strokeWidth={2.2} className="flex-none" />
                        Agent will ask
                    </span>
                )}
                {row.evidence ? <span className="truncate text-[11.5px] text-muted">{row.evidence}</span> : null}
            </div>
            {/* Make initiative and Building in Agent share one box, so the crossfade moves nothing */}
            <div data-jira-action className="relative h-[30px] w-[150px]">
                <AnimatePresence initial={false}>
                    {tabId == null ? (
                        <motion.button
                            key="make"
                            type="button"
                            data-jira-make
                            variants={microFade}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            onClick={() => void make(model, row)}
                            className="absolute inset-0 cursor-pointer rounded-[7px] border border-accent/50 bg-accentbg text-[12px] font-semibold text-accent-soft hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            Make initiative
                        </motion.button>
                    ) : (
                        <motion.button
                            key="building"
                            type="button"
                            data-jira-building
                            title="Open the agent building this initiative"
                            disabled={tabId === ""}
                            variants={microFade}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            onClick={() => fireAndForget(() => openTarget(model, { kind: "agent", tabId }))}
                            className="absolute inset-0 flex cursor-pointer items-center justify-center gap-[7px] rounded-[7px] border border-edge-mid text-[12px] font-semibold text-secondary hover:border-edge-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            <span className="h-1.5 w-1.5 rounded-full bg-success" />
                            Building in Agent
                        </motion.button>
                    )}
                </AnimatePresence>
            </div>
            <a
                href={url ?? undefined}
                aria-label={`Open ${row.key} in Jira`}
                title="Open in Jira"
                onClick={(e) => {
                    e.preventDefault();
                    openInJira(url);
                }}
                className="flex h-[28px] w-[28px] items-center justify-center rounded-[7px] text-ink-mid hover:bg-surface-hover hover:text-ink-hi"
            >
                <ArrowUpRight aria-hidden size={13} strokeWidth={2} />
            </a>
        </>
    );
}
