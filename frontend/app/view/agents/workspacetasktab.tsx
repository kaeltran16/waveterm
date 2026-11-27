// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The workspace pane's Task tab: a finished task as its lead's run recorded it, opened beside the ended worker's
// transcript in place of the details rail. What each section says is workspacetaskmodel.ts'.

import { cn } from "@/util/util";
import { atom, useAtomValue, type Atom } from "jotai";
import { Check, X } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { runAtom } from "./channelsstore";
import { MarkdownMessage } from "./markdownmessage";
import { useRunEvents } from "./runeventstore";
import type { RunInfo } from "./runlineage";
import { useRunUsage } from "./runtokenstore";
import { AddsDels } from "./steprows";
import type { WorkspaceTab } from "./workspacemodel";
import { STRIP_FILL } from "./workspaceruntabmodel";
import { openWorkspaceTab } from "./workspacestore";
import { taskTabView, type TaskTabView } from "./workspacetaskmodel";

type TaskTabProps = {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "task" }>;
};

const META = "font-mono text-[11px] text-muted";
// a task never dispatched has no worker run
const NO_CHILD: Atom<Run | undefined> = atom(undefined as Run | undefined);
const CARD = "flex flex-col gap-[4px] rounded-[8px] border border-edge-mid px-[11px] py-[9px]";

export function TaskTab({ model, agent, tab }: TaskTabProps) {
    // the lead's run from the lineage the tree already holds, so a run only the page knows still reads
    const run = useAtomValue(model.lineageAtom).runs[tab.runId];
    const task = run?.dag?.tasks?.find((t) => t.id === tab.taskId);
    if (run?.dag == null || task == null) {
        return (
            <div data-workspace-task={tab.taskId} className="p-[18px] text-[12.5px] text-muted">
                {`Arc cannot find task ${tab.taskId} of run ${tab.runId}.`}
            </div>
        );
    }
    return <TaskTabBody agent={agent} run={run} dag={run.dag} task={task} />;
}

function TaskTabBody({ agent, run, dag, task }: { agent: AgentVM; run: RunInfo; dag: TaskGroup; task: TaskNode }) {
    const child = useAtomValue(useMemo(() => (task.runid ? runAtom(task.runid) : NO_CHILD), [task.runid]));
    const events = useRunEvents(run.runId, run.channelId);
    const usage = useRunUsage(run.channelId, run.runId);
    const v = taskTabView({
        task,
        dag,
        digest: run.digest,
        child,
        usage: usage?.rows,
        events,
    });
    // reopens Changes when it was closed, else activates it with its selection kept
    const openChanges = () => openWorkspaceTab(agent.id, { kind: "changes", selected: null });
    return (
        <div data-workspace-task={task.id} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div
                data-workspace-task-head
                className="flex flex-none flex-col gap-[8px] border-b border-border px-[18px] pb-[14px] pt-[16px]"
            >
                <div className="flex items-center gap-[10px]">
                    <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-primary">{v.title}</span>
                    <span data-task-state className="inline-flex items-center gap-[5px] text-[12px] text-secondary">
                        <span className={cn("h-[6px] w-[6px] rounded-full", STRIP_FILL[v.state.dot])} />
                        {v.state.word}
                    </span>
                </div>
                <div data-task-meta className={META}>
                    {v.meta}
                </div>
            </div>
            <div className="flex flex-col gap-[18px] px-[18px] pb-[20px] pt-[16px]">
                <Brief brief={v.brief} />
                {v.asked.length > 0 ? <Asked asked={v.asked} /> : null}
                {v.review.length > 0 ? <Review review={v.review} /> : null}
                {v.verify != null ? <Verify verify={v.verify} /> : null}
                {v.changes != null ? (
                    <section data-task-section="changes" className="flex items-center gap-[10px]">
                        <Heading>Changes</Heading>
                        <span data-task-changes className={cn(META, "flex flex-1 items-center gap-[6px]")}>
                            {v.changes.files}
                            <AddsDels adds={v.changes.adds} dels={v.changes.dels} compact />
                        </span>
                        <button
                            type="button"
                            data-task-open-changes
                            onClick={openChanges}
                            className="inline-flex cursor-pointer items-center rounded-[6px] border border-edge-mid px-[9px] py-[3px] text-[12px] text-secondary hover:border-edge-strong"
                        >
                            Open changes
                        </button>
                    </section>
                ) : null}
            </div>
        </div>
    );
}

function Heading({ children }: { children: ReactNode }) {
    return <h3 className="m-0 text-[12px] font-semibold text-ink-mid">{children}</h3>;
}

function Section({ name, title, children }: { name: string; title: string; children: ReactNode }) {
    return (
        <section data-task-section={name} className="flex flex-col gap-[8px]">
            <Heading>{title}</Heading>
            {children}
        </section>
    );
}

function Brief({ brief }: { brief: TaskTabView["brief"] }) {
    if (!brief.text && !brief.links) {
        return null;
    }
    return (
        <Section name="brief" title="Brief">
            {brief.text ? <MarkdownMessage text={brief.text} className="text-[13px] text-ink-hi" /> : null}
            {brief.links ? (
                <div data-task-links className={META}>
                    {brief.links}
                </div>
            ) : null}
        </Section>
    );
}

function Asked({ asked }: { asked: TaskTabView["asked"] }) {
    return (
        <Section name="asked" title="Asked the lead">
            {asked.map((a) => (
                <div key={a.key} data-task-ask className={cn(CARD, "bg-surface-raised")}>
                    <span className="text-[13px] leading-[1.5] text-ink-hi">{a.question}</span>
                    <span className="text-[12.5px] leading-[1.5] text-ink-mid">
                        {a.answer != null ? (
                            <>
                                <span className={META}>{a.meta} · </span>
                                {a.answer}
                            </>
                        ) : (
                            <span className={META}>not answered</span>
                        )}
                    </span>
                </div>
            ))}
        </Section>
    );
}

function Review({ review }: { review: TaskTabView["review"] }) {
    return (
        <Section name="review" title="Review">
            {review.map((r) => (
                <div key={r.key} data-task-review={r.round} className={CARD}>
                    <span className="flex items-center gap-[8px] text-[12.5px] text-secondary">
                        <span className={cn("h-[7px] w-[7px] rounded-full", r.passed ? "bg-success" : "bg-error")} />
                        {`Round ${r.round} · ${r.passed ? "passed" : "sent back"}`}
                        <span className="flex-1" />
                        {r.time ? <span className={META}>{r.time}</span> : null}
                    </span>
                    {r.note ? <span className="text-[12.5px] leading-[1.5] text-ink-mid">{r.note}</span> : null}
                </div>
            ))}
        </Section>
    );
}

function Verify({ verify }: { verify: NonNullable<TaskTabView["verify"]> }) {
    const result = verify.result;
    const Icon = result?.ok === false ? X : Check;
    return (
        <Section name="verify" title="Verify">
            <div className="flex items-center gap-[8px] rounded-[8px] border border-edge-mid bg-surface-code px-[11px] py-[7px] font-mono text-[12px]">
                {result != null ? (
                    <span
                        className={cn(
                            "inline-flex h-[16px] w-[16px] flex-none items-center justify-center rounded-[4px]",
                            result.ok ? "bg-success/15 text-success" : "bg-error/15 text-error"
                        )}
                    >
                        <Icon size={10} strokeWidth={3} aria-hidden />
                    </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-secondary">{verify.command}</span>
                <span data-task-verify className={result?.ok === false ? "text-error" : "text-muted"}>
                    {result?.text ?? "no Verify ran at its merge"}
                </span>
            </div>
        </Section>
    );
}
