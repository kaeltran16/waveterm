// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// A project's Overview: a modal over the current surface, opened from the overview button on a project's row in
// the project switcher (projectswitcher.tsx). The header names the project, its branch, its uncommitted changes and
// its path; the body holds the project's regions: Activity, Now, Branches and History.

import { ModalShell } from "@/app/modals/modalshell";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useAtomValue } from "jotai";
import { GitBranch, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { diffStatsFromChanges } from "./cardgitstore";
import { parseGitChanges } from "./gitstatus";
import type { OverviewRegionProps } from "./overviewregion";
import { ProjectActivity } from "./projectactivity";
import { ProjectBranches } from "./projectbranches";
import { ProjectHistory } from "./projecthistory";
import { ProjectNow } from "./projectnow";
import { changesLabel } from "./projectoverviewmodel";
import { projectsAtom } from "./projectsstore";

type ProjectGit = { branch: string; files: number; adds: number; dels: number };

// the branch and the uncommitted changes of the project's checkout, read once per project shown
function useProjectGit(path: string | undefined): ProjectGit | null {
    const [git, setGit] = useState<ProjectGit | null>(null);
    useEffect(() => {
        setGit(null);
        if (!path) {
            return;
        }
        let live = true;
        RpcApi.GitChangesCommand(TabRpcClient, { cwd: path })
            .then((ch) => {
                if (live && ch.isrepo) {
                    setGit({ branch: ch.branch, ...diffStatsFromChanges(parseGitChanges(ch.statusz, ch.numstat)) });
                }
            })
            .catch((e) => console.warn(`project overview: git read failed for ${path}:`, e));
        return () => {
            live = false;
        };
    }, [path]);
    return git;
}

export function ProjectOverviewModal({ model }: { model: AgentsViewModel }) {
    const project = useAtomValue(model.projectOverviewAtom);
    const close = () => globalStore.set(model.projectOverviewAtom, null);
    return (
        <ModalShell
            open={project != null}
            onClose={close}
            className="flex h-[84vh] w-[min(1120px,94vw)] flex-col"
            topClass="pt-[7vh]"
        >
            {project != null ? <OverviewBody model={model} project={project} close={close} /> : null}
        </ModalShell>
    );
}

function OverviewBody({ model, project, close }: { model: AgentsViewModel; project: string; close: () => void }) {
    const registry = useAtomValue(projectsAtom);
    const path = registry?.[project]?.path;
    const git = useProjectGit(path);
    return (
        <div data-project-overview={project} className="flex min-h-0 flex-1 flex-col">
            <header className="flex items-center gap-3 border-b border-border py-[13px] pl-[18px] pr-3">
                <h2 className="m-0 text-[15px] font-semibold text-primary">{project}</h2>
                {git != null ? (
                    <span className="flex h-[22px] items-center gap-[5px] rounded-full bg-pill px-2 text-[12px] text-secondary">
                        <GitBranch size={12} aria-hidden className="text-muted" />
                        {git.branch}
                    </span>
                ) : null}
                {git != null ? (
                    <span data-overview-changes className="text-[12px] tabular-nums text-muted">
                        {changesLabel(git)}
                        {git.files > 0 ? (
                            <>
                                {" · "}
                                <span className="text-diff-added">+{git.adds}</span>{" "}
                                <span className="text-diff-removed">−{git.dels}</span>
                            </>
                        ) : null}
                    </span>
                ) : null}
                <span className="flex-1" />
                {path ? <span className="min-w-0 truncate font-mono text-[11.5px] text-muted">{path}</span> : null}
                <button
                    type="button"
                    aria-label="Close"
                    onClick={close}
                    className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] text-muted hover:bg-surface-hover hover:text-primary"
                >
                    <X size={15} strokeWidth={2} />
                </button>
            </header>
            <div
                data-overview-body
                className="flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto px-5 pb-[22px] pt-[18px]"
            >
                {/* a registry entry removed while the modal is open leaves no folder to read */}
                {path ? (
                    <OverviewRegions
                        model={model}
                        project={project}
                        path={path}
                        close={close}
                        changedFiles={git?.files ?? 0}
                    />
                ) : null}
            </div>
        </div>
    );
}

// Activity across the top; under it Now above Branches on the left, History on the right. The two columns share one
// height, the modal's leftover, and Branches and History each scroll inside it, so neither side runs past the
// other. The data-overview-region wrappers are the scenario's hooks, so the regions own only their insides.
function OverviewRegions({ changedFiles, ...props }: OverviewRegionProps & { changedFiles: number }) {
    return (
        <>
            <div data-overview-region="activity">
                <ProjectActivity {...props} />
            </div>
            <div className="flex min-h-[360px] flex-1 gap-7">
                <div className="flex min-h-0 min-w-0 flex-[2] flex-col gap-6">
                    <div data-overview-region="now">
                        <ProjectNow {...props} />
                    </div>
                    <div data-overview-region="branches" className="flex min-h-0 flex-1 flex-col">
                        <ProjectBranches {...props} changedFiles={changedFiles} />
                    </div>
                </div>
                <div data-overview-region="history" className="flex min-h-0 min-w-0 flex-[3] flex-col">
                    <ProjectHistory {...props} />
                </div>
            </div>
        </>
    );
}
