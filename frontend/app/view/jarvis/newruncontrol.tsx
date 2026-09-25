// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// + Run: the Brief's way to start work. It was + Channel, which asked you to create a container and then
// find the goal box somewhere else — two steps because the Subjects column owned channel creation and the
// Stage owned composition, and B5 rescued each affordance to wherever it would still mount rather than
// asking whether they were one thing. They are: a project is what you pick, a goal is what you write, and
// the channel underneath is storage that resolves by path or gets minted (newrun.resolveChannelTarget).
//
// The launcher's own controls are here too, not a reduced copy of them. They used to live only on the
// sheet, which renders the launcher while a project has never run and the run body forever after
// (briefsheetmodel: body is "run" once a run exists) — so after the first launch there was no reachable
// way to say "not this time", and every run silently took the profile's shape. Rendering
// RunLauncherSections rather than a second set of pickers is what keeps one answer to what a launch
// dispatches with: the same atoms, the same profile hydration, the same route.
//
// The `r` binding presses this button by its data attribute (buildJarvisBindings), which is why the
// attribute matters more than the label.

import { ModalShell } from "@/app/modals/modalshell";
import { globalStore } from "@/app/store/jotaiStore";
import { harnessPreferenceAtom } from "@/app/view/agents/harnessstore";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AgentsViewModel } from "../agents/agents";
import { channelsAtom, createChannel } from "../agents/channelsstore";
import { projectsAtom } from "../agents/projectsstore";
import {
    channelOverrideAtom,
    createRun,
    loadResolvedProfile,
    resolveChannelLaunchRoute,
    resolvedProfileAtom,
} from "../agents/runactions";
import { launchBlocker } from "../agents/runconfig";
import {
    endRunConfigDraft,
    hydrateRunConfigFromProfile,
    parallelismAtom,
    planPathAtom,
    planPreviewAtom,
    resetRunConfigForChannel,
    routeTouchedAtom,
    runRouteAtom,
    runShapeAtom,
    startAtom,
    workerRouteAtom,
} from "../agents/runconfigstore";
import { RunLauncherSections } from "../agents/runlauncher";
import { initialPick, launchGoal, launchOptsFromConfig, resolveChannelTarget, stepPick } from "./newrun";
import { openTarget } from "./openref";
import { ProjectChips } from "./projectchips";

// Module scope, not component state: NewRunControl unmounts the modal on close, so a project picked for
// one launch was gone by the next one and every run started by re-picking the same project. Not persisted
// — where you last started work is a convenience for the session, not a setting.
const lastPickedProjectAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

const FIELD_LABEL = "font-mono text-[10.5px] font-bold uppercase tracking-[.09em] text-ink-mid";
const CANCEL_BTN =
    "cursor-pointer rounded-[7px] border border-border bg-surface-raised px-3.5 py-1.5 text-[11.5px] font-semibold text-secondary hover:text-primary";

function NewRunModal({ model, onClose }: { model: AgentsViewModel; onClose: () => void }) {
    const projects = useAtomValue(projectsAtom);
    const channels = useAtomValue(channelsAtom);
    const profiles = useAtomValue(resolvedProfileAtom);
    const overrides = useAtomValue(channelOverrideAtom);
    const pref = useAtomValue(harnessPreferenceAtom);
    const shape = useAtomValue(runShapeAtom);
    const parallelism = useAtomValue(parallelismAtom);
    const workerRoute = useAtomValue(workerRouteAtom);
    const startFrom = useAtomValue(startAtom);
    const planPath = useAtomValue(planPathAtom);
    const preview = useAtomValue(planPreviewAtom);
    const runRoute = useAtomValue(runRouteAtom);
    const routeTouched = useAtomValue(routeTouchedAtom);
    const entries = Object.entries(projects ?? {});
    // read once: "last used" names where the previous launch went, not the pick being made now
    const [recent] = useState(() => globalStore.get(lastPickedProjectAtom));
    // the project you last started work in, else the only one there is — either way the common case is
    // type-a-goal-and-go rather than pick-the-same-project-again
    const [picked, setPicked] = useState<string | null>(() =>
        initialPick(
            entries.map(([name]) => name),
            recent
        )
    );
    const [goal, setGoal] = useState("");
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const goalRef = useRef<HTMLTextAreaElement>(null);
    const config = { shape, parallelism, workerRoute, start: startFrom, planPath };
    // a plan start is named by its plan, so it has no goal field to fill
    const planStart = shape === "orchestrator" && startFrom === "plan";
    const blocker = launchBlocker({ shape, start: startFrom, goal, planPath, preview });

    // The project's own channel is where its profile lives, and a project that has never run has no channel
    // yet — hydrating from `undefined` then leaves the launcher on its baselines, which is the right answer
    // for a project that has never said otherwise.
    const target = picked != null ? resolveChannelTarget(channels, picked, projects?.[picked]?.path ?? "") : null;
    const pickedOid = target?.kind === "existing" ? target.oid : null;
    useEffect(() => {
        // keepTouched: the project is a field of this one launch, not a place you navigated to, so
        // changing it must not rewrite the shape or the width you already picked
        resetRunConfigForChannel(pickedOid, true);
        if (pickedOid != null) {
            loadResolvedProfile(pickedOid);
        }
    }, [pickedOid]);
    useEffect(() => {
        hydrateRunConfigFromProfile(pickedOid != null ? profiles[pickedOid] : null);
    }, [pickedOid, profiles]);
    // the lead route the picker opens on, same precedence the sheet's composer uses: the project's own
    // saved route, else the harness preference — and never over a route the user has picked by hand
    const profileRoute = (pickedOid != null ? overrides[pickedOid]?.route : null) ?? pref.route ?? null;
    useEffect(() => {
        if (!routeTouched && profileRoute != null) {
            globalStore.set(runRouteAtom, profileRoute);
        }
    }, [pickedOid, profileRoute, routeTouched]);

    const select = (project: string) => {
        setPicked(project);
        globalStore.set(lastPickedProjectAtom, project);
        // back to the field, so focus never rests on a non-editable target: a locally mounted modal is
        // invisible to deriveKeyContext, so every bare-letter Jarvis binding stays live behind it
        goalRef.current?.focus();
    };

    // Arrow keys walk the chips the search leaves without leaving the search box; Enter takes the
    // highlighted one. Enter is swallowed rather than allowed to bubble, because ModalShell's onSubmit would
    // otherwise read it as "start the run" while the user is still choosing which project to start it in.
    const onSearchKey = (e: KeyboardEvent<HTMLInputElement>, rows: string[]) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setPicked(stepPick(rows, picked, e.key === "ArrowDown" ? 1 : -1));
            return;
        }
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            const next = picked != null && rows.includes(picked) ? picked : rows[0];
            if (next != null) {
                select(next);
            }
        }
    };

    const start = () => {
        if (picked == null || blocker != null || starting) {
            return;
        }
        if (target == null) {
            setError("Still reading your projects — try again in a moment.");
            return;
        }
        setStarting(true);
        setError(null);
        fireAndForget(async () => {
            let oid: string;
            let run: Run;
            try {
                // a channel minted here and then orphaned by a failed launch is the project's channel
                // either way, so there is nothing to roll back — the next run finds it
                oid = target.kind === "existing" ? target.oid : await createChannel(target.name, target.path);
                // a route the user picked in the Routing section is the answer; otherwise resolve the
                // project's own, which also validates that the route is actually available right now
                const route = routeTouched && runRoute != null ? runRoute : await resolveChannelLaunchRoute(oid);
                run = await createRun(oid, launchGoal(config, goal), route, launchOptsFromConfig(config));
            } catch (e) {
                // only a failure BEFORE the run exists keeps this modal: there is still a launch to retry
                setError(String(e));
                setStarting(false);
                return;
            }
            // the launch consumed this draft, so the next one starts from the project's saved defaults
            endRunConfigDraft(globalStore.get(resolvedProfileAtom)[oid]);
            // The run exists, so the launch has succeeded and the modal's work is done. Landing on it is a
            // separate concern that reports its own failures (openTarget toasts) — holding the modal open
            // over a run that is already running told the user their launch had failed. openTarget rather
            // than openChannelSheet because + Run is on the app bar: a launch from any surface has to
            // switch to the Brief, or the sheet opens where nobody is looking.
            onClose();
            await openTarget(model, { kind: "channel", channelId: oid, runId: run.id });
        });
    };

    return (
        <ModalShell open onClose={onClose} onSubmit={start} className="flex max-h-[88vh] w-[min(640px,94vw)] flex-col">
            <div className="flex shrink-0 items-center gap-[11px] border-b border-border px-[18px] py-[15px]">
                <div className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accentbg font-mono text-[10.5px] font-bold text-accent-soft">
                    ▸
                </div>
                <span className="flex-1 text-[15px] font-semibold text-primary">New run</span>
                <span className="rounded-[5px] border border-edge-mid px-[7px] py-0.5 font-mono text-[10.5px] text-ink-mid">
                    ctrl+⏎ to start
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
                    <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-[18px] py-4">
                        <div className="flex flex-col gap-1.5">
                            <span className={FIELD_LABEL}>Project</span>
                            <ProjectChips
                                names={entries.map(([name]) => name)}
                                picked={picked}
                                recent={recent}
                                onPick={select}
                                columns={2}
                                onKeyDown={onSearchKey}
                            />
                        </div>
                        <RunLauncherSections projectPath={picked != null ? (projects?.[picked]?.path ?? "") : ""} />
                        {planStart ? null : (
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
                        )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 border-t border-border px-[18px] py-3">
                        {error != null ? (
                            <span className="min-w-0 flex-1 truncate text-[11px] text-error">{error}</span>
                        ) : (
                            <span className="flex-1 truncate font-mono text-[10.5px] text-ink-mid">
                                {/* the blocker first whenever there is one: a disabled Start run that
                                    named the shape instead of saying "Write the goal" read as a dead
                                    button, which is what a silent click on it looks like */}
                                {picked == null
                                    ? "pick a project"
                                    : (blocker ??
                                      `${shape}${shape === "orchestrator" ? " × " + parallelism : ""} in ${picked}`)}
                            </span>
                        )}
                        <button type="button" onClick={onClose} className={CANCEL_BTN}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            disabled={picked == null || blocker != null || starting}
                            onClick={start}
                            className="cursor-pointer rounded-[7px] bg-accent px-3.5 py-1.5 text-[11.5px] font-semibold text-background hover:bg-accenthover disabled:cursor-default disabled:bg-border disabled:text-muted"
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
                className="flex h-[28px] cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[8px] bg-accent px-[11px] text-[12px] font-semibold text-background shadow-inset-highlight hover:bg-accenthover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
            >
                New run
                <kbd className="font-mono text-[10px] font-normal opacity-55">R</kbd>
            </button>
            {open ? <NewRunModal model={model} onClose={() => setOpen(false)} /> : null}
        </div>
    );
}
