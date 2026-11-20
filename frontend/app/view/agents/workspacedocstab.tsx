// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Markdown } from "@/app/element/markdown";
import { SkeletonLine } from "@/app/element/skeleton";
import { ViewSwap } from "@/app/element/viewswap";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { base64ToString, cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { FileText, RotateCw } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { SurfaceEmptyState } from "./surfacescaffold";
import { docRows, docsFold, selectedDocRow, type DocRow } from "./workspacedocsmodel";
import { agentDocsAtom, agentDocsReadAtom, loadAgentDocs, useAgentDocsRefresh } from "./workspacedocsstore";
import { tabKey, type WorkspaceTab } from "./workspacemodel";
import { openBeside, updateWorkspaceTab } from "./workspacestore";

const LOADING_ROWS = 2;

// decision 10 of the plan: under this pane width the rows drop the folder and the verb
const NARROW = "@max-[420px]:hidden";

const emptyGlyph = (
    <span className="mb-[12px] flex h-[28px] w-[28px] items-center justify-center rounded-[8px] border border-edge-mid bg-surface text-muted">
        <FileText size={16} />
    </span>
);

// the Main board's type: the renderer's 2em/1.5em headings are a document page's, too large beside a transcript.
// Important, since its unlayered stylesheet beats a layered utility
const DOC_CONTENT = "px-[24px] py-[18px] [&_.heading.is-1]:text-[20px]! [&_.heading.is-2]:text-[15.5px]!";

const smallBtn =
    "inline-flex flex-none cursor-pointer items-center gap-[5px] rounded-[6px] border border-edge-mid bg-surface-raised px-[9px] py-[3px] text-[11.5px] font-semibold text-ink-mid hover:bg-surface-hover hover:text-ink-hi";

// The workspace pane's Docs tab: the Markdown files the agent wrote this session, newest first, with the selected one
// rendered under a path bar
export function DocsTab({
    model,
    agent,
    tab,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "docs" }>;
}) {
    useAgentDocsRefresh(agent);
    const docs = useAtomValue(agentDocsAtom(agent.id));
    const read = useAtomValue(agentDocsReadAtom(agent.id));
    const [expanded, setExpanded] = useState(false);
    const rows = useMemo(() => docRows(docs, read.cwd, new Date()), [docs, read.cwd]);
    const fold = docsFold(rows, expanded, tab.selected);
    const current = selectedDocRow(rows, tab.selected);
    const pick = (path: string) => updateWorkspaceTab(agent.id, tabKey(tab), { selected: path });
    const retry = () => fireAndForget(() => loadAgentDocs(agent));

    let body: ReactNode;
    if (rows.length === 0) {
        body = !read.loaded ? (
            <DocsLoading />
        ) : read.failure != null ? null : (
            <SurfaceEmptyState
                data={{ "data-docs-empty": "" }}
                glyph={emptyGlyph}
                title="No docs yet"
                body="The Markdown files this agent writes or edits show here, the newest rendered."
            />
        );
    } else {
        body = (
            <>
                <div
                    role="listbox"
                    aria-label="Docs written this session"
                    data-docs-list
                    className="flex max-h-[40%] flex-none flex-col overflow-y-auto border-b border-border px-[8px] py-[6px]"
                >
                    {fold.shown.map((r) => (
                        <DocListRow key={r.path} row={r} selected={r.path === current?.path} onPick={pick} />
                    ))}
                    {fold.more != null ? (
                        <button
                            type="button"
                            data-docs-more
                            onClick={() => setExpanded(true)}
                            className="flex h-[30px] w-full flex-none cursor-pointer items-center rounded-[6px] px-[10px] text-left text-[12px] font-semibold text-accent-soft hover:bg-surface-hover"
                        >
                            {fold.more}
                        </button>
                    ) : null}
                </div>
                {current != null ? (
                    <ViewSwap swapKey={current.path} className="flex min-h-0 flex-1 flex-col">
                        {current.gone ? (
                            <DocGone row={current} />
                        ) : (
                            <DocView model={model} agent={agent} row={current} />
                        )}
                    </ViewSwap>
                ) : null}
            </>
        );
    }
    return (
        <div data-workspace-docs className="@container flex min-h-0 flex-1 flex-col">
            {read.failure != null ? (
                <div
                    data-docs-failed
                    className="m-[8px] flex flex-none items-center gap-[10px] rounded-[8px] border border-border bg-surface py-[6px] pl-[12px] pr-[6px] text-[12px]"
                >
                    <span className="min-w-0 flex-1 break-words text-ink-mid">
                        <span className="text-error">Couldn’t read the docs list.</span> {read.failure}
                    </span>
                    <button type="button" data-docs-retry onClick={retry} className={smallBtn}>
                        <RotateCw size={13} />
                        Retry
                    </button>
                </div>
            ) : null}
            {body}
        </div>
    );
}

function DocListRow({ row, selected, onPick }: { row: DocRow; selected: boolean; onPick: (path: string) => void }) {
    return (
        <button
            type="button"
            role="option"
            aria-selected={selected}
            data-docs-row={row.path}
            title={row.rel}
            onClick={() => onPick(row.path)}
            className={cn(
                "flex h-[30px] w-full flex-none cursor-pointer items-center gap-[8px] rounded-[6px] px-[10px] text-left text-ink-mid",
                selected ? "bg-surface-selected" : "hover:bg-surface-hover"
            )}
        >
            <FileText size={13} aria-hidden className="flex-none" />
            <span
                data-docs-name
                className={cn(
                    "min-w-0 shrink truncate text-[12.5px] font-semibold",
                    row.gone ? "text-muted line-through" : "text-primary"
                )}
            >
                {row.name}
            </span>
            <span data-docs-folder className={cn("min-w-0 flex-1 truncate font-mono text-[11px] text-muted", NARROW)}>
                {row.folder}
            </span>
            <span data-docs-when className="ml-auto flex-none whitespace-nowrap text-[11.5px] text-muted">
                {row.verb != null ? <span className={NARROW}>{row.verb} </span> : null}
                {row.time}
            </span>
        </button>
    );
}

type DocText = { path: string; status: "loading" | "ok" | "error"; text: string; failure: string };

// re-read when the doc's entry changes (the agent edited it again), keeping the old text until the new one lands
function useDocText(row: DocRow): DocText {
    const [load, setLoad] = useState<DocText>({ path: row.path, status: "loading", text: "", failure: "" });
    useEffect(() => {
        let live = true;
        fireAndForget(async () => {
            try {
                const data = await RpcApi.FileReadCommand(TabRpcClient, { info: { path: row.path } });
                if (live) {
                    setLoad({ path: row.path, status: "ok", text: base64ToString(data?.data64 ?? ""), failure: "" });
                }
            } catch (e) {
                if (live) {
                    const failure =
                        (e instanceof Error ? e.message : String(e ?? "")) || "The read failed with no message.";
                    setLoad({ path: row.path, status: "error", text: "", failure });
                }
            }
        });
        return () => {
            live = false;
        };
    }, [row.path, row.ts]);
    return load.path === row.path ? load : { path: row.path, status: "loading", text: "", failure: "" };
}

function DocView({ model, agent, row }: { model: AgentsViewModel; agent: AgentVM; row: DocRow }) {
    const doc = useDocText(row);
    return (
        <>
            <div className="flex flex-none items-center gap-[8px] border-b border-edge-faint px-[18px] py-[8px]">
                <span
                    data-docs-path
                    className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted"
                    title={row.path}
                >
                    {row.rel}
                </span>
                <button
                    type="button"
                    data-docs-open-raw
                    title="Open the raw text in a File tab"
                    onClick={() => openBeside(model, agent.id, { kind: "file", path: row.path, line: null })}
                    className={smallBtn}
                >
                    Open raw
                </button>
            </div>
            <ViewSwap swapKey={doc.status} className="flex min-h-0 flex-1 flex-col">
                {doc.status === "loading" ? (
                    <DocsLoading />
                ) : doc.status === "error" ? (
                    <div data-docs-read-failed className="px-[24px] py-[18px] text-[12.5px] text-ink-mid break-words">
                        <span className="text-error">Couldn’t read the doc.</span> {doc.failure}
                    </div>
                ) : (
                    <div data-docs-body className="flex min-h-0 flex-1 flex-col">
                        <Markdown
                            text={doc.text}
                            scrollable
                            className="min-h-0 flex-1"
                            contentClassName={DOC_CONTENT}
                        />
                    </div>
                )}
            </ViewSwap>
        </>
    );
}

function DocGone({ row }: { row: DocRow }) {
    return (
        <div data-docs-gone className="flex flex-1 flex-col items-center justify-center gap-[8px] p-[24px] text-center">
            <span className="text-[13.5px] font-semibold text-secondary">No such file</span>
            <span data-docs-gone-path className="break-all font-mono text-[11px] text-muted">
                {row.rel}
            </span>
            <span className="text-[12.5px] text-ink-mid">It was deleted or moved after the agent wrote it.</span>
        </div>
    );
}

function DocsLoading() {
    return (
        <div data-docs-loading aria-hidden className="flex flex-col gap-[10px] px-[18px] py-[14px]">
            {Array.from({ length: LOADING_ROWS }, (_, i) => (
                <SkeletonLine key={i} className={cn("h-[12px]", i % 2 ? "w-[54%]" : "w-[72%]")} />
            ))}
        </div>
    );
}
