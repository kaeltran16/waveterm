// frontend/app/view/code/codereviewbar.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The review's toolbar controls, shown only while the project has comments: how many, Send review and
// Clear. A review spans the project like a PR spans files, so the count is the project's total.

import { PopoverReveal } from "@/app/element/popoverreveal";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { useAtom, useAtomValue } from "jotai";
import { MessageSquare, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { AgentPicker } from "./codeagentpicker";
import { handoffProjectName, liveAgentsForProject } from "./codehandoff";
import { projectComments } from "./codereview";
import { codeReviewSendOpenAtom, codeReviewsAtom, confirmClearReview, sendReview } from "./codereviewstore";
import { codeProjectAtom, codeWorktreesAtom, registeredProjects } from "./codestore";

const BUTTON =
    "flex flex-none cursor-pointer items-center gap-1 rounded-[8px] border border-border bg-surface px-2 py-1 text-[12px] text-secondary hover:text-primary";

export function CodeReviewBar({ model }: { model: AgentsViewModel }) {
    const project = useAtomValue(codeProjectAtom);
    const reviews = useAtomValue(codeReviewsAtom);
    const registry = useAtomValue(projectsAtom);
    const worktrees = useAtomValue(codeWorktreesAtom);
    const agents = useAtomValue(model.agentsAtom);
    const [open, setOpen] = useAtom(codeReviewSendOpenAtom);
    const [error, setError] = useState<string | null>(null);

    const count = project == null ? 0 : projectComments(reviews, project.path).length;
    if (project == null || count === 0) {
        return null;
    }
    const projectName = handoffProjectName(
        project,
        registeredProjects(registry),
        worktrees.find((wt) => wt.ismain)?.path ?? null
    );
    const targets = liveAgentsForProject(agents, projectName);

    const send = async (target: AgentVM | null) => {
        setOpen(false);
        const res = await sendReview(target, projectName);
        setError("message" in res ? res.message : null);
    };

    return (
        <div className="flex flex-none items-center gap-1.5">
            <span
                data-code-review-count={count}
                title={`${count} review comment${count === 1 ? "" : "s"} in this project`}
                className="flex flex-none items-center gap-1 text-[12px] text-accent-soft"
            >
                <MessageSquare size={13} strokeWidth={1.8} />
                {count}
            </span>
            <div className="relative">
                <button
                    type="button"
                    data-code-review-send
                    title="Send the review (Alt+Shift+M)"
                    onClick={() => {
                        setError(null);
                        setOpen(!open);
                    }}
                    className={BUTTON}
                >
                    <Send size={13} strokeWidth={1.8} />
                    <span>Send review</span>
                </button>
                <PopoverReveal
                    open={open}
                    origin="top right"
                    className="absolute right-0 top-[calc(100%+6px)] z-20 w-[260px] overflow-hidden rounded-[10px] border border-border bg-surface p-2 shadow-popover-md"
                >
                    <AgentPicker
                        targets={targets}
                        onPick={(t) => void send(t)}
                        emptyLabel="Copy review"
                        onEmpty={() => void send(null)}
                    />
                </PopoverReveal>
            </div>
            <button
                type="button"
                data-code-review-clear
                title="Clear every comment in this project"
                aria-label="Clear review"
                onClick={confirmClearReview}
                className={BUTTON}
            >
                <Trash2 size={13} strokeWidth={1.8} />
            </button>
            {error != null ? (
                <span role="alert" className="max-w-[240px] truncate text-[11.5px] text-error" title={error}>
                    {error}
                </span>
            ) : null}
        </div>
    );
}
