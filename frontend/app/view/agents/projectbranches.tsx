// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The project Overview's Branches region: the newest commits across every branch, drawn as a graph. It reads
// the log itself rather than through githistorystore, whose atoms belong to the one Diff surface.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { BODY_LINK, MONO_FAINT, MONO_META } from "@/app/view/jarvis/briefstyle";
import { cn } from "@/util/util";
import { useEffect, useState } from "react";
import { openDiff, projectDiffScope } from "./agentdiffnav";
import { scopeKey } from "./diffscope";
import { assignLanes, laneCount } from "./gitgraph";
import { graphGeometry } from "./gitgraphgeom";
import { requestCommitLink } from "./githistorystore";
import { GraphGutter } from "./graphgutter";
import { HISTORY_RPC_TIMEOUT_MS } from "./historyquery";
import { commitCount, refChipClass, type HistoryRow } from "./historyrows";
import { RegionAlert, RegionHead, RegionNote, RegionSkeleton, type OverviewRegionProps } from "./overviewregion";
import {
    authorInitial,
    BRANCH_MAX_LANES,
    BRANCH_ROW_H,
    BRANCH_ROWS,
    branchesState,
    type BranchesState,
} from "./projectbranchesmodel";
import { changesLabel } from "./projectoverviewmodel";

type Read = { reply: CommandGitHistoryRtnData | null; error: string | null; at: number };

// The first page of `git log --all`, re-read on Retry. A reply for a path the region has moved past is dropped.
function useBranchesState(path: string, changedFiles: number): { state: BranchesState; retry: () => void } {
    const [read, setRead] = useState<Read>({ reply: null, error: null, at: 0 });
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        setRead({ reply: null, error: null, at: 0 });
        let live = true;
        RpcApi.GitHistoryCommand(TabRpcClient, { cwd: path, limit: BRANCH_ROWS }, { timeout: HISTORY_RPC_TIMEOUT_MS })
            .then((reply) => {
                if (live) {
                    setRead({ reply, error: null, at: Date.now() });
                }
            })
            .catch((e) => {
                if (live) {
                    setRead({ reply: null, error: String((e as Error)?.message ?? e), at: Date.now() });
                }
            });
        return () => {
            live = false;
        };
    }, [path, attempt]);
    const state: BranchesState =
        read.error != null ? { kind: "failed", reason: read.error } : branchesState(read.reply, changedFiles, read.at);
    return { state, retry: () => setAttempt((n) => n + 1) };
}

export function ProjectBranches({
    model,
    project,
    path,
    close,
    changedFiles,
}: OverviewRegionProps & { changedFiles: number }) {
    const { state, retry } = useBranchesState(path, changedFiles);
    const scope = projectDiffScope(project, path);
    const open = (hash?: string) => {
        if (hash) {
            requestCommitLink(scopeKey(scope), hash);
        }
        openDiff(model, scope);
        close();
    };
    const link = (
        <button type="button" onClick={() => open()} className={BODY_LINK}>
            open in Diff ↗
        </button>
    );
    return (
        <section aria-label="Branches" className="flex min-h-0 flex-1 flex-col gap-1.5">
            <RegionHead
                label="Branches"
                count={state.kind === "rows" ? commitCount(state.rows) : undefined}
                aside={state.kind === "rows" ? link : undefined}
            />
            {state.kind === "loading" ? <RegionSkeleton rows={4} /> : null}
            {state.kind === "norepo" ? <RegionNote>{project} is not a git repository.</RegionNote> : null}
            {state.kind === "empty" ? <RegionNote>No commits yet.</RegionNote> : null}
            {state.kind === "failed" ? (
                <RegionAlert onRetry={retry}>
                    Could not read the commits: <span className="font-mono text-[11px]">{state.reason}</span>
                </RegionAlert>
            ) : null}
            {state.kind === "rows" ? <CommitGraph rows={state.rows} onOpen={open} /> : null}
        </section>
    );
}

function CommitGraph({ rows, onOpen }: { rows: HistoryRow[]; onOpen: (hash?: string) => void }) {
    const laned = assignLanes(rows);
    const lanes = Math.min(Math.max(laneCount(laned), 1), BRANCH_MAX_LANES);
    const geom = graphGeometry(laned, { rowH: BRANCH_ROW_H, maxLanes: lanes });
    return (
        <div data-overview-graph className="min-h-0 flex-1 overflow-y-auto">
            <div className="relative">
                <GraphGutter geom={geom} />
                {laned.map((row) => (
                    <CommitRow
                        key={row.hash || "__wt__"}
                        row={row}
                        indent={geom.gutter}
                        onOpen={() => onOpen(row.workingTree ? undefined : row.hash)}
                    />
                ))}
            </div>
        </div>
    );
}

function CommitRow({ row, indent, onOpen }: { row: HistoryRow; indent: number; onOpen: () => void }) {
    return (
        <button
            type="button"
            data-overview-commit={row.workingTree ? "uncommitted" : row.hash}
            onClick={onOpen}
            style={{ height: BRANCH_ROW_H, paddingLeft: indent }}
            className="relative flex w-full cursor-pointer items-center gap-2 rounded-[7px] pr-2 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
            {row.workingTree ? (
                <>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-warning">
                        {row.subject}
                    </span>
                    <span className={cn("flex-none", MONO_META)}>{changesLabel({ files: row.fileCount })}</span>
                </>
            ) : (
                <>
                    <span className={cn("w-[58px] flex-none", MONO_FAINT)}>{row.hash.slice(0, 7)}</span>
                    {row.refs.map((r) => (
                        <span
                            key={r.label}
                            data-ref-chip
                            className={cn(
                                "max-w-[160px] flex-none truncate rounded-[5px] border px-[5px] font-mono text-[10.5px] font-semibold leading-[17px]",
                                refChipClass(r.kind)
                            )}
                        >
                            {r.label}
                        </span>
                    ))}
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-primary">{row.subject}</span>
                    <span
                        aria-hidden="true"
                        title={row.author}
                        className="flex h-[17px] w-[17px] flex-none items-center justify-center rounded-full border border-edge-mid bg-background text-[9px] font-semibold text-ink-mid"
                    >
                        {authorInitial(row.author)}
                    </span>
                </>
            )}
            <span className={cn("w-[34px] flex-none text-right", MONO_FAINT)}>{row.workingTree ? "" : row.when}</span>
        </button>
    );
}
