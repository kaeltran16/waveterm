// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { SkeletonLine } from "@/app/element/skeleton";
import { ViewSwap } from "@/app/element/viewswap";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUpRight, FileText, RotateCw } from "lucide-react";
import { useEffect } from "react";
import { agentDiffScope, openDiff } from "./agentdiffnav";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { ChangedFileList } from "./changedfilelist";
import { makeDiffPairSource } from "./diffcontentstore";
import { DiffPane } from "./diffpane";
import { treeModeAtom } from "./filetree";
import { lineCountsShown } from "./gitstatus";
import { useRailGit } from "./railgit";
import { loadRailForAgent } from "./railstore";
import { SurfaceEmptyState } from "./surfacescaffold";
import { changesLine, changesShown, changesView } from "./workspacechangesmodel";
import type { WorkspaceTab } from "./workspacemodel";
import { updateWorkspaceTab } from "./workspacestore";

// the tab's own pair, so its file never shows on the Diff surface, which keeps the module's pair
const changesPair = makeDiffPairSource();

const emptyGlyph = (
    <span className="mb-[12px] flex h-[28px] w-[28px] items-center justify-center rounded-[8px] border border-edge-mid bg-surface text-muted">
        <FileText size={16} />
    </span>
);

// the workspace pane's Changes tab: the agent's changed files beside the selected file's diff
export function ChangesTab({
    model,
    agent,
    tab,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "changes" }>;
}) {
    const rail = useRailGit(agent);
    const tree = useAtomValue(treeModeAtom);
    // the Agent surface stays mounted under the others; off it, the tab neither reads nor mounts the diff, whose
    // editor publishes the hunk nav and split width the Diff surface reads
    const onScreen = useAtomValue(model.surfaceAtom) === "agent";
    const view = changesView(rail);
    const files = rail?.changes?.files ?? [];
    const path = changesShown(files, tab.selected, tree);
    const change = files.find((f) => f.path === path);
    const cwd = rail?.cwd;

    // rail is a dependency so the agent's next edit, which reloads the list, re-reads the open file too
    useEffect(() => {
        if (!onScreen || !cwd || path == null) {
            return;
        }
        const sel = { kind: "worktree", anchorRef: rail?.ref ?? "", head: rail?.head ?? "" } as const;
        fireAndForget(() => changesPair.load(cwd, path, sel, change?.from));
    }, [onScreen, cwd, path, change?.from, rail]);

    if (view === "failed" || view === "norepo" || view === "clean") {
        return <ChangesEmpty view={view} agent={agent} cwd={cwd} failure={rail?.failure} />;
    }
    const line = rail != null && view === "files" ? changesLine(rail) : null;
    const counted = lineCountsShown(rail?.changes);
    return (
        <div data-workspace-changes className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-[10px] border-b border-border px-[18px] py-[11px]">
                {line != null ? (
                    <span
                        data-workspace-changes-line
                        className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-mid"
                    >
                        {line.count}
                        {counted ? (
                            <>
                                {" "}
                                <span className="text-diff-added">+{line.adds}</span>{" "}
                                <span className="text-diff-removed">−{line.dels}</span>
                            </>
                        ) : null}
                        {` · ${line.where}`}
                    </span>
                ) : (
                    <span className="flex-1">
                        <SkeletonLine className="h-[12px] w-[180px]" />
                    </span>
                )}
                <button
                    type="button"
                    data-workspace-open-diff
                    onClick={() => openDiff(model, agentDiffScope(agent.id, agent.name))}
                    className="inline-flex flex-none cursor-pointer items-center gap-[3px] font-mono text-[10.5px] font-semibold text-accent-soft hover:text-ink-hi"
                >
                    Open on Diff
                    <ArrowUpRight size={11} aria-hidden />
                </button>
            </div>
            <div className="flex min-h-0 flex-1">
                <div
                    data-workspace-changes-list
                    className="flex w-[206px] flex-none flex-col gap-[2px] overflow-y-auto border-r border-border px-[6px] py-[8px]"
                >
                    <ChangedFileList
                        changes={rail?.changes ?? null}
                        selectedFile={path}
                        onSelectFile={(p) => updateWorkspaceTab(agent.id, "changes", { selected: p })}
                        review={null}
                        lineCounts={counted}
                    />
                </div>
                {onScreen && path != null ? (
                    <ViewSwap swapKey={path} className="flex min-h-0 min-w-0 flex-1 flex-col">
                        <DiffPane
                            path={path}
                            adds={change?.adds ?? 0}
                            dels={change?.dels ?? 0}
                            lineCounts={counted}
                            repoCwd={cwd ?? null}
                            model={model}
                            source={changesPair}
                        />
                    </ViewSwap>
                ) : null}
            </div>
        </div>
    );
}

function ChangesEmpty({
    view,
    agent,
    cwd,
    failure,
}: {
    view: "failed" | "norepo" | "clean";
    agent: AgentVM;
    cwd: string | null | undefined;
    failure: string | undefined;
}) {
    if (view === "failed") {
        return (
            <SurfaceEmptyState
                data={{ "data-workspace-changes-empty": view }}
                glyph={emptyGlyph}
                title="Couldn’t read the changed files"
                body={<span className="break-words">{failure}</span>}
                action={{
                    label: (
                        <>
                            <RotateCw size={13} />
                            Retry
                        </>
                    ),
                    onClick: () => fireAndForget(() => loadRailForAgent(agent.transcriptPath, agent.blockId)),
                    data: { "data-workspace-changes-retry": "" },
                }}
            />
        );
    }
    return (
        <SurfaceEmptyState
            data={{ "data-workspace-changes-empty": view }}
            glyph={emptyGlyph}
            title={view === "clean" ? "No changes" : "Not a git repository"}
            body={
                view === "clean" ? (
                    "The files this agent changes show here, each beside its diff."
                ) : (
                    <span className="break-words">
                        {cwd
                            ? `${cwd} is not inside a git repository.`
                            : "The agent’s working folder is not known yet."}
                    </span>
                )
            }
        />
    );
}
