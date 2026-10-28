// frontend/app/view/code/codepathbar.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Which file you are looking at, and the two things you want to do with its identity. Until this
// existed the only clue was the tree highlight, and the only copy-path affordance was buried in the
// "file too large" empty state.
//
// Save status stays in the surface toolbar. Splitting identity from save state is a real cost, but moving
// working controls for tidiness is churn.

import { useCopyFeedback, type CopyState } from "@/app/element/copyfeedback";
import { CrossFade } from "@/app/element/crossfade";
import { PopoverReveal } from "@/app/element/popoverreveal";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { joinRepoPath } from "@/util/paths";
import { cn, stringToBase64 } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { Check, Copy, Send, X } from "lucide-react";
import { useState } from "react";
import { AgentPicker } from "./codeagentpicker";
import { codeBlameOnAtom, toggleBlame } from "./codeblamestore";
import { isMarkdownPath } from "./codeclassify";
import { handoffLine, handoffProjectName, liveAgentsForProject } from "./codehandoff";
import { selectionLines } from "./codereview";
import {
    codeDraftsAtom,
    codeFileAtom,
    codePlainAtom,
    codeProjectAtom,
    codeViewModeAtom,
    codeWorktreesAtom,
    draftKey,
    enterDiff,
    NOT_TRACKED,
    registeredProjects,
} from "./codestore";
import { codeEditorSelection } from "./codeviewer";

const COPY_PATH_LABEL: Record<CopyState, string> = { idle: "Copy path", copied: "Copied", failed: "Copy failed" };
const COPY_PATH_TONE: Record<CopyState, string> = {
    idle: "text-muted hover:text-primary",
    copied: "text-accent-soft",
    failed: "text-error",
};

export function CodePathBar({ model }: { model: AgentsViewModel }) {
    const project = useAtomValue(codeProjectAtom);
    const file = useAtomValue(codeFileAtom);
    const drafts = useAtomValue(codeDraftsAtom);
    const registry = useAtomValue(projectsAtom);
    const worktrees = useAtomValue(codeWorktreesAtom);
    const { state: copyState, copy } = useCopyFeedback();

    if (project == null || file.kind === "none") {
        return null;
    }
    const abs = joinRepoPath(project.path, file.path);
    const dirty = file.kind === "text" && drafts.has(draftKey(project, file.path));

    return (
        <div className="flex flex-none items-center gap-2 border-b border-border px-3 py-1.5">
            <span data-code-path={file.path} className="min-w-0 truncate font-mono text-[11.5px] text-secondary">
                {file.path}
            </span>
            {dirty ? (
                <span
                    aria-label="Unsaved edits"
                    title="Unsaved edits"
                    className="size-[6px] flex-none rounded-full bg-accent-soft"
                />
            ) : null}
            {file.kind === "text" ? <ViewModeToggle markdown={isMarkdownPath(file.path)} /> : null}
            {file.kind === "text" ? <BlameToggle /> : null}
            <div className="flex-1" />
            <button
                type="button"
                aria-label="Copy absolute path"
                title={abs}
                onClick={() => copy(abs)}
                className={cn(
                    "flex flex-none cursor-pointer items-center rounded-[6px] border border-border px-2 py-[3px] text-[11px]",
                    COPY_PATH_TONE[copyState]
                )}
            >
                <CrossFade swapKey={copyState} className="gap-1">
                    {copyState === "copied" ? (
                        <Check size={11} strokeWidth={2} />
                    ) : copyState === "failed" ? (
                        <X size={11} strokeWidth={2} />
                    ) : (
                        <Copy size={11} strokeWidth={1.8} />
                    )}
                    <span>{COPY_PATH_LABEL[copyState]}</span>
                </CrossFade>
            </button>
            <SendToAgent
                model={model}
                rel={file.path}
                projectName={handoffProjectName(
                    project,
                    registeredProjects(registry),
                    worktrees.find((wt) => wt.ismain)?.path ?? null
                )}
            />
        </div>
    );
}

// Markdown files render as documents by default; Source is the escape back to the editable view and
// Diff shows the file against HEAD. Preview is markdown-only — there is nothing to render for a Go
// file — while Source and Diff are offered for any text file.
function ViewModeToggle({ markdown }: { markdown: boolean }) {
    const [mode, setMode] = useAtom(codeViewModeAtom);
    const plain = useAtomValue(codePlainAtom);
    const modes = (["preview", "source", "diff"] as const).filter((m) => markdown || m !== "preview");
    return (
        <div className="flex flex-none items-center gap-0.5 rounded-[6px] border border-border p-[2px]">
            {modes.map((m) => (
                <button
                    key={m}
                    type="button"
                    data-code-view-mode={m}
                    disabled={plain && m === "diff"}
                    title={plain && m === "diff" ? NOT_TRACKED : undefined}
                    onClick={() => (m === "diff" ? enterDiff() : setMode(m))}
                    className={cn(
                        "cursor-pointer rounded-[4px] px-2 py-[2px] text-[11px] capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-40",
                        m === mode ? "bg-accent/10 text-accent-soft" : "text-muted hover:text-primary"
                    )}
                >
                    {m}
                </button>
            ))}
        </div>
    );
}

// Blame draws beside the source editor only; in a plain directory there is no history to blame.
function BlameToggle() {
    const on = useAtomValue(codeBlameOnAtom);
    const plain = useAtomValue(codePlainAtom);
    return (
        <button
            type="button"
            data-code-blame-toggle
            aria-pressed={on}
            disabled={plain}
            title={plain ? NOT_TRACKED : "Toggle the blame column (b)"}
            onClick={toggleBlame}
            className={cn(
                "flex-none cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-40",
                on && !plain ? "bg-accent/10 text-accent-soft" : "text-muted hover:text-primary"
            )}
        >
            Blame
        </button>
    );
}

// A handoff is a keystroke injection into a live agent's terminal — exactly what typing there
// yourself would do. Deliberately not recorded: channel steering posts a directive message so a
// channel timeline stays the source of truth, and this surface has no channel to post to.
function SendToAgent({ model, rel, projectName }: { model: AgentsViewModel; rel: string; projectName: string }) {
    const agents = useAtomValue(model.agentsAtom);
    const [open, setOpen] = useState(false);
    const [note, setNote] = useState("");
    const [sent, setSent] = useState<string | null>(null);
    const targets = liveAgentsForProject(agents, projectName);

    const compose = () => {
        const sel = codeEditorSelection();
        const lines = sel != null ? selectionLines(sel) : null;
        return handoffLine({ rel, startLine: lines?.startLine, endLine: lines?.endLine, note });
    };

    const send = (target: AgentVM) => {
        const line = compose();
        setOpen(false);
        setNote("");
        setSent(`Sent to ${target.name}`);
        window.setTimeout(() => setSent(null), 1600);
        void RpcApi.ControllerInputCommand(TabRpcClient, {
            blockid: target.blockId!,
            inputdata64: stringToBase64(line + "\r"),
        });
    };

    // no live agent for this project — and a worktree browsed outside the registry never has one,
    // so the clipboard is the honest fallback rather than a disabled button with no explanation
    const copyInstead = () => {
        void navigator.clipboard?.writeText(compose());
        setOpen(false);
        setNote("");
        setSent("Copied reference");
        window.setTimeout(() => setSent(null), 1600);
    };

    return (
        <div className="relative flex-none">
            <button
                type="button"
                data-code-send-to-agent
                onClick={() => setOpen((v) => !v)}
                className="flex cursor-pointer items-center gap-1 rounded-[6px] border border-border px-2 py-[3px] text-[11px] text-muted hover:text-primary"
            >
                <Send size={11} strokeWidth={1.8} />
                <span>{sent ?? (targets.length === 0 ? "Copy reference" : "Send to agent")}</span>
            </button>
            <PopoverReveal
                open={open}
                origin="top right"
                className="absolute right-0 top-[calc(100%+6px)] z-20 w-[280px] overflow-hidden rounded-[10px] border border-border bg-surface p-2 shadow-popover-md"
            >
                <p className="px-1 pb-1 font-mono text-[10.5px] text-muted">{compose()}</p>
                <input
                    value={note}
                    placeholder="Add a note (optional)"
                    onChange={(e) => setNote(e.target.value)}
                    className="mb-1.5 w-full rounded-[6px] border border-border bg-surface px-2 py-1 text-[11.5px] text-primary outline-none placeholder:text-muted"
                />
                <AgentPicker targets={targets} onPick={send} emptyLabel="Copy reference" onEmpty={copyInstead} />
            </PopoverReveal>
        </div>
    );
}
