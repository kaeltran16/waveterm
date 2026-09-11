// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// + Run: the Brief's way to start work. It was + Channel, which asked you to create a container and then
// find the goal box somewhere else — two steps because the Subjects column owned channel creation and the
// Stage owned composition, and B5 rescued each affordance to wherever it would still mount rather than
// asking whether they were one thing. They are: a project is what you pick, a goal is what you write, and
// the channel underneath is storage that resolves by path or gets minted (newrun.resolveChannelTarget).
//
// No run configuration here on purpose. Shape, machine and routes come from the project's own profile, and
// the sheet's launcher is where they are tuned — a second set of the same controls in the doorway is a
// second answer to what this project dispatches with.
//
// The `r` binding presses this button by its data attribute (buildJarvisBindings), which is why the
// attribute matters more than the label.

import { ModalShell } from "@/app/modals/modalshell";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useRef, useState } from "react";
import type { AgentsViewModel } from "../agents/agents";
import { channelsAtom, createChannel } from "../agents/channelsstore";
import { projectsAtom } from "../agents/projectsstore";
import { createRun, resolveChannelLaunchRoute, resolvedProfileAtom } from "../agents/runactions";
import { launchOptsFromProfile, resolveChannelTarget } from "./newrun";
import { openChannelSheet } from "./openref";

const FIELD_LABEL = "font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted";
const CANCEL_BTN =
    "cursor-pointer rounded-[7px] border border-border bg-surface-raised px-3.5 py-1.5 text-[11.5px] font-semibold text-secondary hover:text-primary";

function NewRunModal({ model, onClose }: { model: AgentsViewModel; onClose: () => void }) {
    const projects = useAtomValue(projectsAtom);
    const channels = useAtomValue(channelsAtom);
    const entries = Object.entries(projects ?? {});
    // one project is not a choice, and preselecting it makes the common case type-a-goal-and-go
    const [picked, setPicked] = useState<string | null>(entries.length === 1 ? entries[0][0] : null);
    const [goal, setGoal] = useState("");
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const goalRef = useRef<HTMLTextAreaElement>(null);

    const select = (project: string) => {
        setPicked(project);
        // back to the field, so focus never rests on a non-editable target: a locally mounted modal is
        // invisible to deriveKeyContext, so every bare-letter Jarvis binding stays live behind it
        goalRef.current?.focus();
    };

    const start = () => {
        const text = goal.trim();
        if (picked == null || text === "" || starting) {
            return;
        }
        const target = resolveChannelTarget(channels, picked, projects?.[picked]?.path ?? "");
        if (target == null) {
            setError("Still reading your projects — try again in a moment.");
            return;
        }
        setStarting(true);
        setError(null);
        fireAndForget(async () => {
            try {
                // a channel minted here and then orphaned by a failed launch is the project's channel
                // either way, so there is nothing to roll back — the next run finds it
                const oid = target.kind === "existing" ? target.oid : await createChannel(target.name, target.path);
                // resolves the route AND caches the profile this launch reads its shape from, so the two
                // never disagree about which project's settings they are describing
                const route = await resolveChannelLaunchRoute(oid);
                const run = await createRun(
                    oid,
                    text,
                    route,
                    launchOptsFromProfile(globalStore.get(resolvedProfileAtom)[oid])
                );
                await openChannelSheet(oid, run.id);
                onClose();
            } catch (e) {
                setError(String(e));
                setStarting(false);
            }
        });
    };

    return (
        <ModalShell open onClose={onClose} onSubmit={start} className="flex w-[min(520px,93vw)] flex-col">
            <div className="flex shrink-0 items-center gap-[11px] border-b border-border px-[18px] py-[15px]">
                <div className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accentbg font-mono text-[10px] font-bold text-accent-soft">
                    ▸
                </div>
                <span className="flex-1 text-[15px] font-semibold text-primary">New run</span>
                <span className="rounded-[5px] border border-edge-mid px-[7px] py-0.5 font-mono text-[10.5px] text-muted">
                    ⌘⏎ to start
                </span>
            </div>
            {entries.length === 0 ? (
                <div className="flex flex-col items-start gap-2.5 px-[18px] py-4">
                    <span className="text-[12px] text-secondary">
                        A run needs a project, and none are registered yet.
                    </span>
                    <button
                        type="button"
                        onClick={() => {
                            onClose();
                            globalStore.set(model.newProjectOpenAtom, true);
                        }}
                        className="cursor-pointer rounded-[7px] border border-accent/30 bg-accentbg px-2.5 py-1.5 text-[11.5px] font-semibold text-accent-soft hover:bg-accent/20"
                    >
                        Register a project
                    </button>
                </div>
            ) : (
                <>
                    <div className="flex min-h-0 flex-col gap-[13px] px-[18px] py-4">
                        <div className="flex min-h-0 flex-col gap-1.5">
                            <span className={FIELD_LABEL}>Project</span>
                            <div className="flex max-h-[180px] flex-col gap-1 overflow-y-auto">
                                {entries.map(([project]) => (
                                    <button
                                        key={project}
                                        type="button"
                                        aria-pressed={picked === project}
                                        onClick={() => select(project)}
                                        className={cn(
                                            "cursor-pointer truncate rounded-[7px] border px-2.5 py-1.5 text-left text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                            picked === project
                                                ? "border-accent/40 bg-accentbg text-accent-soft"
                                                : "border-border bg-surface-raised text-ink-mid hover:border-accent"
                                        )}
                                    >
                                        {project}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="flex flex-col gap-1">
                            <span className={FIELD_LABEL}>Goal</span>
                            <textarea
                                ref={goalRef}
                                autoFocus
                                rows={3}
                                value={goal}
                                onChange={(e) => setGoal(e.target.value)}
                                placeholder="What should it do?"
                                className="w-full resize-none rounded-[7px] border border-edge-mid bg-background px-2.5 py-1.5 text-[12.5px] leading-[1.5] text-primary placeholder:text-muted outline-none focus:border-accent/60"
                            />
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 border-t border-border px-[18px] py-3">
                        {error != null ? (
                            <span className="min-w-0 flex-1 truncate text-[11px] text-error">{error}</span>
                        ) : (
                            <span className="flex-1 font-mono text-[10px] text-muted">
                                {picked == null ? "pick a project" : "shape and route come from its profile"}
                            </span>
                        )}
                        <button type="button" onClick={onClose} className={CANCEL_BTN}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            disabled={picked == null || goal.trim() === "" || starting}
                            onClick={start}
                            className="cursor-pointer rounded-[7px] bg-accent px-3.5 py-1.5 text-[11.5px] font-semibold text-background hover:bg-accenthover disabled:cursor-default disabled:opacity-40"
                        >
                            {starting ? "Starting…" : "Start run"}
                        </button>
                    </div>
                </>
            )}
        </ModalShell>
    );
}

export function NewRunControl({ model }: { model: AgentsViewModel }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="flex-none">
            {/* data-jarvis-new-run: the `r` key presses this rather than owning a second copy of the
                modal's open state (buildJarvisBindings). */}
            <button
                type="button"
                data-jarvis-new-run
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen(true)}
                className={cn(
                    "cursor-pointer rounded-[6px] border px-2.5 py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[.06em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    "border-accent/30 bg-accentbg text-accent-soft hover:bg-accent/20"
                )}
            >
                + Run
            </button>
            {open ? <NewRunModal model={model} onClose={() => setOpen(false)} /> : null}
        </div>
    );
}
