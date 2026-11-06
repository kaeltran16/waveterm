// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's Profile modal: the run defaults Jarvis composes future work from. It is the Brief-side mount
// of the channel profile the Stage rail's drawer owned in the three-pane composition, and it deliberately
// keeps the same authority chain — resolution, empty-override detection and validation all live in Go, and
// this modal only projects and patches what it is given.
//
// Two scopes, because the backend has two. Project scope edits a ProfileOverride: every field is a
// section-level override with the same two affordances the drawer's editor had — Customize copies the
// inherited value in, Reset drops the key so it inherits again. Global scope edits the JarvisProfile every
// project inherits from. The global face lost its mount when B5 deleted profilepanel.tsx, which left
// global principles reachable only over the RPC; this is
// the re-home meta-spec 4a item 10 asked for.
//
// Nothing is written until Save, and a refused save leaves the draft standing with the server's message.
// Autonomy is not here: it is one policy for all work, set from the Brief header.

import { Skeleton } from "@/app/element/skeleton";
import { ModalShell } from "@/app/modals/modalshell";
import { channelsAtom, loadChannels } from "@/app/view/agents/channelsstore";
import { channelProjectLabel } from "@/app/view/agents/projectlabel";
import { projectListAtom, projectsAtom, rowsWithChannel, type ProjectRow } from "@/app/view/agents/projectsstore";
import { RoutePicker } from "@/app/view/agents/routepicker";
import {
    clearResolvedProfiles,
    getGlobalProfile,
    getJarvisProfile,
    refreshResolvedProfile,
    setChannelProfile,
    setGlobalProfile,
} from "@/app/view/agents/runactions";
import { clampParallelism, DEFAULT_PARALLELISM } from "@/app/view/agents/runconfig";
import { WorkerStepper } from "@/app/view/agents/runlauncher";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { briefUndo } from "./briefundo";
import { GlobalPrinciplesEditor } from "./globalprincipleseditor";
import { PrinciplesEditor, PROFILE_PANEL } from "./principleseditor";
import {
    applyApprovals,
    applyWorkersChoice,
    approvalsRow,
    blankMessage,
    blankPrinciples,
    defaultReach,
    discardPrompt,
    errorMessage,
    globalProfileIsDirty,
    isDirty,
    lightReviewerRow,
    normalizePrinciplePatch,
    overridesRow,
    overrideSummary,
    principleNote,
    principleRows,
    principleSummary,
    profileOverrideIsEmpty,
    removedPrincipleNotes,
    resetActionState,
    resetRow,
    reviewerRow,
    saveScopes,
    unsavedLabel,
    unsavedScopes,
    workersRow,
    type GlobalDefaultKey,
    type ProfileDefaults,
    type ProjectOverride,
    type Reach,
    type WorkersChoice,
} from "./profilemodel";
import { ProjectChips } from "./projectchips";

const FOOTER_BTN = "h-8 cursor-pointer rounded-[7px] px-3.5 text-[12.5px] font-semibold disabled:cursor-default";
const SEGMENTS = "flex w-fit rounded-[7px] border border-edge-mid p-0.5";
const SEGMENT =
    "cursor-pointer whitespace-nowrap rounded-[5px] font-semibold disabled:cursor-default disabled:opacity-40";
const segmentTone = (on: boolean) => (on ? "bg-accentbg text-accent-soft" : "text-ink-mid hover:text-secondary");
const SHAPES = [
    ["quick", "Quick"],
    ["orchestrator", "Orchestrator"],
] as const;
// values mirror jarvis.Landing_Checkout / Landing_Branch
const LANDINGS = [
    ["checkout", "Project checkout"],
    ["branch", "Own branch"],
] as const;
const APPROVALS = [
    [false, "Ask me"],
    [true, "Autonomous"],
] as const;
const APPROVALS_NOTE = {
    ask: "The lead stops for a goal that needs a design, a plan review that failed twice, product calls, and the last failed final stage.",
    autonomous:
        "The lead takes the option it would recommend at each of those points and records why in its report. If the final stage still fails after the last round, the land stays held for you.",
};

type Scope = "project" | "global";
type Loaded = { global: JarvisProfile; override: ProfileOverride; diagnostics: PrincipleDiagnostic[] };
// an action held by the footer's discard confirm: closing the modal, or switching to another project
type Pending = { kind: "close" } | { kind: "project"; oid: string };

// the chips name projects, the modal edits channels: project name -> its channel's oid
function channelOptionsOf(rows: ProjectRow[]): Map<string, string> {
    return new Map(rowsWithChannel(rows).map((r) => [r.name, r.channel.oid]));
}

// one row of the run-defaults panel: the label with its explanation, the control, and a right-hand cell
// that says where the value comes from (project scope) or how far it reaches (global scope). alignTop keeps the
// label and that cell level with the control when a line of text sits under it.
function DefaultRow({
    label,
    hint,
    aside,
    alignTop = false,
    attrs,
    children,
}: {
    label: string;
    hint: string;
    aside: ReactNode;
    alignTop?: boolean;
    attrs?: Record<`data-${string}`, string>;
    children: ReactNode;
}) {
    return (
        <div
            {...attrs}
            className={cn(
                "grid grid-cols-[156px_minmax(0,1fr)_140px] gap-x-3.5 px-3.5 py-[11px]",
                alignTop ? "items-start" : "items-center"
            )}
        >
            <div className={cn("flex flex-col gap-0.5", alignTop && "pt-0.5")}>
                <span className="text-[13px] font-medium text-ink-hi">{label}</span>
                <span className="text-[11.5px] leading-[1.35] text-muted">{hint}</span>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</div>
            {alignTop ? <div className="pt-1">{aside}</div> : aside}
        </div>
    );
}

// project scope: inheriting reads as a hollow "Global" dot, a project value as a filled one with the way back.
// The reset is inert for the whole save, since a reset mutates the draft the in-flight write carries.
function SourceCell({
    label,
    inherited,
    saving,
    onReset,
}: {
    label: string;
    inherited: boolean;
    saving: boolean;
    onReset: () => void;
}) {
    const reset = resetActionState(inherited, saving);
    return (
        <div className="flex items-center justify-end gap-2.5 text-[11.5px]">
            {inherited ? (
                <span className="flex items-center gap-1.5 text-muted">
                    <span className="h-1.5 w-1.5 rounded-full border border-ink-faint" />
                    Global
                </span>
            ) : (
                <span className="flex items-center gap-1.5 text-accent-soft">
                    <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                    Project
                </span>
            )}
            {reset.show ? (
                <button
                    type="button"
                    aria-label={`Reset ${label.toLowerCase()} to global`}
                    onClick={onReset}
                    disabled={reset.disabled}
                    className="h-[22px] cursor-pointer rounded-[5px] border border-edge-mid px-2 text-ink-mid hover:border-edge-strong hover:text-secondary disabled:cursor-default disabled:opacity-40"
                >
                    Reset
                </button>
            ) : null}
        </div>
    );
}

function ReachCell({ reach }: { reach: Reach | null }) {
    if (reach == null) {
        return <div />;
    }
    return (
        <div className="flex min-w-0 flex-col items-end gap-px text-right">
            <span className="text-[11.5px] text-ink-mid">{reach.main}</span>
            {reach.sub != null ? (
                <span title={reach.sub} className="max-w-full truncate text-[11px] text-muted">
                    {reach.sub}
                </span>
            ) : null}
        </div>
    );
}

// The run defaults, rendered once for both scopes. `base` is what a silent field falls back to: the global
// profile in project scope, and the draft itself in global scope, where a field is either set or unset.
function DefaultsFields({
    inheritable,
    draft,
    base,
    saving,
    set,
    drop,
    aside,
    routeRow,
    setWorkers,
    setApprovals,
}: {
    inheritable: boolean;
    draft: ProfileDefaults;
    base: JarvisProfile;
    saving: boolean;
    set: (patch: ProfileDefaults) => void;
    drop: (key: GlobalDefaultKey) => void;
    aside: (key: GlobalDefaultKey, label: string) => ReactNode;
    routeRow?: ReactNode;
    setWorkers: (choice: WorkersChoice) => void;
    setApprovals: (autonomous: boolean) => void;
}) {
    const shape = draft.defaultmode ?? base.defaultmode ?? "quick";
    const width = draft.parallelism ?? base.parallelism ?? null;
    // "" is a stored global meaning branch; an empty project override is refused on save
    const landing = draft.landing || base.landing || "branch";
    const workers = workersRow(draft, base, inheritable);
    const reviewers = reviewerRow(draft, base, inheritable);
    const lightReviewers = lightReviewerRow(draft, base, inheritable);
    const { autonomous } = approvalsRow(draft, base, inheritable);
    return (
        <div className={PROFILE_PANEL}>
            <DefaultRow
                label="Default shape"
                hint="How new runs are composed"
                aside={aside("defaultmode", "Default shape")}
            >
                <div role="group" aria-label="Default shape" className={cn(SEGMENTS, "bg-surface-raised")}>
                    {SHAPES.map(([name, label]) => (
                        <button
                            key={name}
                            type="button"
                            aria-pressed={shape === name}
                            disabled={saving}
                            onClick={() => set({ defaultmode: name })}
                            className={cn(
                                SEGMENT,
                                "h-6 px-[11px] text-[12.5px] font-medium",
                                segmentTone(shape === name)
                            )}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </DefaultRow>
            <DefaultRow
                label="Parallel workers"
                hint="Auto lets the lead choose"
                aside={aside("parallelism", "Parallel workers")}
            >
                <WorkerStepper
                    value={width}
                    unsetLabel="auto"
                    disabled={saving}
                    // an unset width starts from the launcher's own default rather than one step off it
                    onStep={(delta) =>
                        set({ parallelism: width == null ? DEFAULT_PARALLELISM : clampParallelism(width + delta) })
                    }
                />
                {/* only in global scope: nothing sits above it to reset to, but a set width can go back to unset */}
                {!inheritable && draft.parallelism != null ? (
                    <button
                        type="button"
                        disabled={saving}
                        onClick={() => drop("parallelism")}
                        className="ml-1.5 h-[22px] cursor-pointer rounded-[5px] px-[7px] text-[12px] text-ink-mid underline decoration-edge-strong underline-offset-[3px] hover:text-secondary disabled:cursor-default disabled:opacity-40"
                    >
                        Back to auto
                    </button>
                ) : null}
            </DefaultRow>
            {routeRow}
            <DefaultRow
                label="Worker route"
                hint="Where engine workers run"
                aside={aside("workerroute", "Worker route")}
            >
                <RoutePicker
                    value={workers.route}
                    canInherit
                    inheritedLabel="Same as lead"
                    disabled={saving}
                    onChange={(route) => setWorkers(route == null ? { kind: "lead" } : { kind: "route", route })}
                    extraOption={{
                        label: "Reviewer picks",
                        selected: workers.picks,
                        onSelect: () => setWorkers({ kind: "picks" }),
                    }}
                />
            </DefaultRow>
            <DefaultRow
                label="Reviewer route"
                hint="Task reviews, plan review and final verify"
                aside={aside("reviewerroute", "Reviewer route")}
            >
                <RoutePicker
                    value={reviewers.value}
                    canInherit
                    inheritedLabel={reviewers.inheritedLabel}
                    disabled={saving}
                    onChange={(route) => (route == null ? drop("reviewerroute") : set({ reviewerroute: route }))}
                />
            </DefaultRow>
            <DefaultRow
                label="Light reviewers route"
                hint="Plan review second pass and follow-up"
                aside={aside("lightreviewerroute", "Light reviewers route")}
                attrs={{ "data-light-reviewers-row": "" }}
            >
                <RoutePicker
                    value={lightReviewers.value}
                    canInherit
                    inheritedLabel={lightReviewers.inheritedLabel}
                    disabled={saving}
                    onChange={(route) =>
                        route == null ? drop("lightreviewerroute") : set({ lightreviewerroute: route })
                    }
                />
            </DefaultRow>
            <DefaultRow
                label="Runs land on"
                hint="Where orchestrator runs commit"
                aside={aside("landing", "Runs land on")}
            >
                <div role="group" aria-label="Runs land on" className={cn(SEGMENTS, "bg-surface-raised")}>
                    {LANDINGS.map(([name, label]) => (
                        <button
                            key={name}
                            type="button"
                            aria-pressed={landing === name}
                            disabled={saving}
                            onClick={() => set({ landing: name })}
                            className={cn(
                                SEGMENT,
                                "h-6 px-[11px] text-[12.5px] font-medium",
                                segmentTone(landing === name)
                            )}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </DefaultRow>
            <DefaultRow
                label="Approvals"
                hint="When the lead needs a decision from you"
                aside={aside("autonomous", "Approvals")}
                alignTop
            >
                <div className="flex min-w-0 flex-col gap-[7px]">
                    <div role="group" aria-label="Approvals" className={cn(SEGMENTS, "bg-surface-raised")}>
                        {APPROVALS.map(([on, label]) => (
                            <button
                                key={label}
                                type="button"
                                aria-pressed={autonomous === on}
                                disabled={saving}
                                onClick={() => setApprovals(on)}
                                className={cn(
                                    SEGMENT,
                                    "h-6 px-[11px] text-[12.5px] font-medium",
                                    segmentTone(autonomous === on)
                                )}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <span className="text-[11.5px] leading-[1.5] text-muted">
                        {autonomous ? APPROVALS_NOTE.autonomous : APPROVALS_NOTE.ask}
                    </span>
                </div>
            </DefaultRow>
        </div>
    );
}

function SectionHeader({ title, meta, metaTitle }: { title: string; meta: string; metaTitle?: string }) {
    return (
        <div className="flex items-baseline gap-2">
            <h2 className="m-0 text-[13px] font-semibold text-primary">{title}</h2>
            <span title={metaTitle} className="text-[12px] text-muted">
                {meta}
            </span>
        </div>
    );
}

// the footer's left side, most urgent first: a save or load error, a blank principle holding Save, what is unsaved
function FooterStatus({
    error,
    blank,
    scopes,
}: {
    error: string | null;
    blank: string | null;
    scopes: ("Project" | "Global")[];
}) {
    if (error != null || blank != null) {
        return (
            <span
                data-jarvis-brief-modal-state={error != null ? "error" : "blank"}
                className="min-w-0 flex-1 text-[12px] leading-[1.4] text-error"
            >
                {error ?? blank}
            </span>
        );
    }
    if (scopes.length > 0) {
        return (
            <span className="flex flex-1 items-center gap-[7px] text-[12px] text-asking">
                <span className="h-1.5 w-1.5 rounded-full bg-asking" />
                {unsavedLabel(scopes)}
            </span>
        );
    }
    return <span className="flex-1 text-[12px] text-muted">No changes</span>;
}

// initialChannelId "" opens on the first project; the caller keys the modal by it so a new one takes effect
export function BriefProfileModal({
    open,
    initialChannelId = "",
    onClose,
}: {
    open: boolean;
    initialChannelId?: string;
    onClose: () => void;
}) {
    const channels = useAtomValue(channelsAtom);
    const projects = useAtomValue(projectsAtom);
    const rows = useAtomValue(projectListAtom);
    // memoized: the effects below key on it, and a fresh Map per render would refetch every override
    const channelOptions = useMemo(() => channelOptionsOf(rows), [rows]);
    const [channelId, setChannelId] = useState(initialChannelId);
    const [scope, setScope] = useState<Scope>("project");
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [draft, setDraft] = useState<ProfileOverride>({});
    const [globalLoaded, setGlobalLoaded] = useState<JarvisProfile | null>(null);
    const [globalDraft, setGlobalDraft] = useState<JarvisProfile | null>(null);
    // every project's stored override, for global scope to say whom an edit reaches
    const [projectOverrides, setProjectOverrides] = useState<ProjectOverride[] | null>(null);
    const [overridesError, setOverridesError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState<Pending | null>(null);

    useEffect(() => {
        if (open) {
            fireAndForget(loadChannels);
        }
    }, [open]);

    // the global draft outlives a project switch but not a close: the modal stays mounted between opens,
    // and a reopen starts from the stored profile
    useEffect(() => {
        if (!open) {
            setGlobalLoaded(null);
            setGlobalDraft(null);
            setPending(null);
        }
    }, [open]);

    const noProjects = channels != null && channelOptions.size === 0;

    useEffect(() => {
        const first = channelOptions.values().next().value;
        if (!open || first == null) {
            return;
        }
        if (channelId === "" || ![...channelOptions.values()].includes(channelId)) {
            setChannelId(first);
        }
    }, [open, channelOptions, channelId]);

    // with no projects there is no override to edit, so global is the only scope that means anything.
    useEffect(() => {
        if (noProjects) {
            setScope("global");
        }
    }, [noProjects]);

    useEffect(() => {
        if (!open || (channelId === "" && !noProjects)) {
            return;
        }
        let live = true;
        setLoaded(null);
        setError(null);
        // the global profile is the same for every project, so a project switch keeps its draft; only a
        // first load seeds it
        const seedGlobal = (g: JarvisProfile) => {
            setGlobalLoaded((cur) => cur ?? g);
            setGlobalDraft((cur) => cur ?? g);
        };
        fireAndForget(async () => {
            try {
                if (channelId === "") {
                    const g = await getGlobalProfile();
                    if (live) {
                        seedGlobal(g);
                    }
                    return;
                }
                const p = await getJarvisProfile(channelId);
                if (!live) {
                    return;
                }
                setLoaded({ global: p.global, override: p.override ?? {}, diagnostics: p.principlediagnostics ?? [] });
                setDraft(p.override ?? {});
                // p.global is LoadGlobalProfile()'s own result — seed global scope without a second call.
                seedGlobal(p.global);
            } catch (e) {
                if (live) {
                    setError(errorMessage(e));
                }
            }
        });
        return () => {
            live = false;
        };
    }, [open, channelId, noProjects]);

    // one read per project, only once global scope is showing: it is the only face that uses them
    useEffect(() => {
        if (!open || scope !== "global" || channels == null) {
            return;
        }
        let live = true;
        setProjectOverrides(null);
        setOverridesError(null);
        fireAndForget(async () => {
            try {
                const list = await Promise.all(
                    [...channelOptions].map(async ([name, oid]) => ({
                        name,
                        override: (await getJarvisProfile(oid)).override ?? {},
                    }))
                );
                if (live) {
                    setProjectOverrides(list);
                }
            } catch (e) {
                if (live) {
                    setOverridesError(String(e));
                }
            }
        });
        return () => {
            live = false;
        };
    }, [open, scope, channels, channelOptions]);

    if (!open) {
        return null;
    }

    const channel = channels?.find((c) => c.oid === channelId) ?? null;
    const isGlobal = scope === "global";
    const ready = isGlobal ? globalDraft != null : loaded != null;
    const inheritedPrinciples = loaded?.global.principles ?? [];
    // Customize alone pins nothing, so dirty, the summary and the save all read the normalized patch
    const normalized = (o: ProfileOverride): ProfileOverride => ({
        ...o,
        principles: normalizePrinciplePatch(o.principles, inheritedPrinciples),
    });
    const projectDirty = loaded != null && isDirty(normalized(draft), normalized(loaded.override));
    const globalDirty = globalLoaded != null && globalDraft != null && globalProfileIsDirty(globalDraft, globalLoaded);
    const scopes = unsavedScopes(projectDirty, globalDirty);
    const projectRows = loaded != null ? principleRows(inheritedPrinciples, draft.principles, loaded.diagnostics) : [];
    const blank = blankMessage(blankPrinciples(projectRows, globalDraft?.principles ?? null), scope);
    const canSave = !saving && scopes.length > 0 && blank == null;

    // every edit drops a stale error and an armed confirm, whose held action no longer matches the draft
    const touched = () => {
        setError(null);
        setPending(null);
    };
    const editDraft = (fn: (d: ProfileOverride) => ProfileOverride) => {
        touched();
        setDraft(fn);
    };
    const editGlobal = (fn: (g: JarvisProfile) => JarvisProfile) => {
        touched();
        setGlobalDraft((g) => (g ? fn(g) : g));
    };
    const set = (patch: Partial<ProfileOverride>) => editDraft((d) => ({ ...d, ...patch }));
    const drop = (key: keyof ProfileOverride) =>
        editDraft((d) => {
            const next = { ...d };
            delete next[key];
            return next;
        });
    const setGlobal = (patch: Partial<JarvisProfile>) => editGlobal((g) => ({ ...g, ...patch }));
    const dropGlobal = (key: GlobalDefaultKey) =>
        editGlobal((g) => {
            const next = { ...g };
            delete next[key];
            return next;
        });

    // Cancel, Esc and the backdrop arm the footer's confirm while anything is unsaved; on an armed confirm
    // they mean Keep editing
    const requestClose = () => {
        if (pending != null) {
            setPending(null);
        } else if (projectDirty || globalDirty) {
            setPending({ kind: "close" });
        } else {
            onClose();
        }
    };
    // a project switch loses only the project draft, so only that arms the confirm
    const pickProject = (oid: string) => {
        if (saving || oid === channelId) {
            return;
        }
        if (projectDirty) {
            setPending({ kind: "project", oid });
        } else {
            touched();
            setChannelId(oid);
        }
    };
    const discard = () => {
        const held = pending;
        setPending(null);
        if (held?.kind === "close") {
            onClose();
        } else if (held?.kind === "project") {
            setChannelId(held.oid);
        }
    };
    const pickScope = (s: Scope) => {
        touched();
        setScope(s);
    };

    // Every dirty scope is written, global first since the project resolves against it. Full success closes
    // with one toast; a failure leaves its scope dirty with the server's message in the footer, while a scope
    // that landed before it reads saved.
    const save = () => {
        const globalSnapshot = globalDirty ? globalDraft : null;
        const override = projectDirty ? normalized(draft) : null;
        setSaving(true);
        touched();
        fireAndForget(async () => {
            try {
                const result = await saveScopes({
                    global:
                        globalSnapshot == null
                            ? undefined
                            : async () => {
                                  await setGlobalProfile(globalSnapshot);
                                  setGlobalLoaded(globalSnapshot);
                                  // the project face reads its inherited baseline off loaded.global, and every
                                  // profile cached anywhere was resolved against the list this write replaced.
                                  setLoaded((l) => (l ? { ...l, global: globalSnapshot } : l));
                                  clearResolvedProfiles();
                              },
                    project:
                        override == null
                            ? undefined
                            : async () => {
                                  await setChannelProfile(channelId, override);
                                  // mirror Go's own emptiness rule: a structurally empty override is stored as
                                  // no override at all, so the modal must not go on believing it saved one.
                                  setLoaded((l) =>
                                      l ? { ...l, override: profileOverrideIsEmpty(override) ? {} : override } : l
                                  );
                              },
                });
                // refresh only after a write landed: a cache refreshed on a refused save would describe a
                // profile that does not exist.
                if (result.saved.length > 0 && channelId !== "") {
                    await refreshResolvedProfile(channelId);
                }
                if (result.error != null) {
                    setError(result.error.message);
                    return;
                }
                const names = result.saved.map((s) => (s === "global" ? "global" : projectLabel));
                briefUndo.notify(`Profile saved for ${names.join(" and ")} · applies to future runs`);
                onClose();
            } catch (e) {
                setError(errorMessage(e));
            } finally {
                setSaving(false);
            }
        });
    };

    const sourceCell = (key: GlobalDefaultKey | "route", label: string) => (
        <SourceCell
            label={label}
            inherited={!overridesRow(draft, key)}
            saving={saving}
            onReset={() => editDraft((d) => resetRow(d, key))}
        />
    );
    const leadRouteRow =
        loaded != null ? (
            <DefaultRow
                label="Lead route"
                hint="Where the lead and phase workers run"
                aside={sourceCell("route", "Lead route")}
            >
                <RoutePicker
                    value={draft.route ?? null}
                    canInherit
                    inheritedLabel="Same as global"
                    disabled={saving}
                    onChange={(route) => (route == null ? drop("route") : set({ route }))}
                />
            </DefaultRow>
        ) : null;

    const pickedLabel = [...channelOptions].find(([, oid]) => oid === channelId)?.[0] ?? null;
    const projectLabel = channelProjectLabel(channel, projects) || "project";

    const globalReach = (key: GlobalDefaultKey) => (
        <ReachCell reach={projectOverrides == null ? null : defaultReach(projectOverrides, key)} />
    );
    const loadedText = new Map((globalLoaded?.principles ?? []).map((p) => [p.id, p.text]));
    const principleNotes = Object.fromEntries(
        (globalDraft?.principles ?? []).map((p) => [
            p.id,
            principleNote(
                projectOverrides ?? [],
                p.id,
                loadedText.get(p.id),
                loadedText.has(p.id) && loadedText.get(p.id) !== p.text
            ),
        ])
    );
    const removedNotes = removedPrincipleNotes(
        globalLoaded?.principles ?? [],
        globalDraft?.principles ?? [],
        projectOverrides ?? []
    );

    return (
        <ModalShell open={open} onClose={requestClose} className="flex max-h-[86vh] w-[min(620px,93vw)] flex-col">
            <div
                data-jarvis-brief-modal="profile"
                data-jarvis-profile-scope={scope}
                className="flex min-h-0 flex-1 flex-col"
            >
                <header className="flex flex-none items-center gap-3 border-b border-border px-5 py-4">
                    <div className="flex flex-1 flex-col gap-0.5">
                        <span className="text-[15px] font-semibold text-primary">Profile</span>
                        <span className="text-[12px] text-muted">
                            {isGlobal ? "The base every project inherits" : "Defaults Jarvis uses for future runs"}
                        </span>
                    </div>
                    <div role="group" aria-label="Scope" className={cn(SEGMENTS, "rounded-[8px] bg-surface")}>
                        {(["project", "global"] as const).map((s) => (
                            <button
                                key={s}
                                type="button"
                                data-jarvis-profile-tab={s}
                                aria-pressed={scope === s}
                                disabled={saving || (s === "project" && noProjects)}
                                onClick={() => pickScope(s)}
                                className={cn(
                                    SEGMENT,
                                    "h-[26px] rounded-[6px] px-3 text-[12px]",
                                    segmentTone(scope === s)
                                )}
                            >
                                {s === "project" ? "Project" : "Global"}
                            </button>
                        ))}
                    </div>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-5 pt-[18px] pb-5">
                    {!isGlobal && channelOptions.size > 0 ? (
                        <div className="flex items-start gap-3">
                            <span className="w-14 flex-none pt-[5px] text-[12px] text-ink-mid">Project</span>
                            <ProjectChips
                                names={[...channelOptions.keys()]}
                                picked={pickedLabel}
                                recent={null}
                                onPick={(label) => {
                                    const oid = channelOptions.get(label);
                                    if (oid != null) {
                                        pickProject(oid);
                                    }
                                }}
                                columns={1}
                            />
                        </div>
                    ) : null}
                    {!ready && error == null ? <Skeleton className="h-24 rounded-[8px]" /> : null}
                    {isGlobal && globalDraft != null ? (
                        <>
                            <section className="flex flex-col gap-2">
                                <SectionHeader
                                    title="Run defaults"
                                    meta={
                                        overridesError == null
                                            ? "Projects without their own value use these"
                                            : "Couldn't load which projects override these"
                                    }
                                    metaTitle={overridesError ?? undefined}
                                />
                                <DefaultsFields
                                    inheritable={false}
                                    draft={globalDraft}
                                    base={globalDraft}
                                    saving={saving}
                                    set={setGlobal}
                                    drop={dropGlobal}
                                    aside={globalReach}
                                    setWorkers={(choice) => editGlobal((g) => applyWorkersChoice(g, choice, false))}
                                    setApprovals={(on) => editGlobal((g) => applyApprovals(g, on, false))}
                                />
                                <p className="m-0 text-[11.5px] leading-[1.45] text-muted">
                                    Lead route is set per project; autonomy lives in the Brief header.
                                </p>
                            </section>
                            <section className="flex flex-col gap-2">
                                <SectionHeader title="Principles" meta="Every project starts from these" />
                                <GlobalPrinciplesEditor
                                    principles={globalDraft.principles ?? []}
                                    notes={principleNotes}
                                    disabled={saving}
                                    onChange={(principles) => setGlobal({ principles })}
                                />
                                {removedNotes.map((n) => (
                                    <span
                                        key={n.id}
                                        data-jarvis-removed-principle=""
                                        title={n.text}
                                        className="flex min-w-0 items-center gap-1.5 pl-2 text-[11.5px] text-asking"
                                    >
                                        <span className="h-[5px] w-[5px] flex-none rounded-full bg-asking" />
                                        <span className="min-w-0 truncate">{n.text}</span>
                                    </span>
                                ))}
                            </section>
                        </>
                    ) : null}
                    {!isGlobal && loaded != null ? (
                        <>
                            <section className="flex flex-col gap-2">
                                <SectionHeader title="Run defaults" meta={overrideSummary(draft)} />
                                <DefaultsFields
                                    inheritable
                                    draft={draft}
                                    base={loaded.global}
                                    saving={saving}
                                    set={set}
                                    drop={drop}
                                    aside={sourceCell}
                                    routeRow={leadRouteRow}
                                    setWorkers={(choice) => editDraft((d) => applyWorkersChoice(d, choice, true))}
                                    setApprovals={(on) => editDraft((d) => applyApprovals(d, on, true))}
                                />
                            </section>
                            <section className="flex flex-col gap-2">
                                <SectionHeader
                                    title="Principles"
                                    meta={principleSummary(
                                        principleRows(
                                            inheritedPrinciples,
                                            normalized(draft).principles,
                                            loaded.diagnostics
                                        )
                                    )}
                                />
                                <PrinciplesEditor
                                    global={loaded.global.principles ?? []}
                                    patch={draft.principles}
                                    diagnostics={loaded.diagnostics}
                                    disabled={saving}
                                    onChange={(patch) => set({ principles: patch })}
                                />
                            </section>
                        </>
                    ) : null}
                </div>
                <footer className="flex flex-none items-center gap-2 border-t border-border bg-surface-raised px-5 py-3">
                    {pending != null ? (
                        <>
                            <span data-jarvis-profile-confirm="" className="flex-1 text-[12px] text-asking">
                                {discardPrompt(pending.kind === "close" ? scopes : ["Project"])}
                            </span>
                            <button
                                type="button"
                                onClick={() => setPending(null)}
                                className={cn(
                                    FOOTER_BTN,
                                    "border border-border bg-surface-raised text-secondary hover:text-primary"
                                )}
                            >
                                Keep editing
                            </button>
                            <button
                                type="button"
                                onClick={discard}
                                className={cn(FOOTER_BTN, "bg-error/15 text-error-soft hover:bg-error/25")}
                            >
                                Discard
                            </button>
                        </>
                    ) : (
                        <>
                            <FooterStatus error={error} blank={blank} scopes={scopes} />
                            <button
                                type="button"
                                onClick={requestClose}
                                className={cn(
                                    FOOTER_BTN,
                                    "border border-border bg-surface-raised text-secondary hover:text-primary"
                                )}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={save}
                                disabled={!canSave}
                                className={cn(
                                    FOOTER_BTN,
                                    canSave ? "bg-accent text-background hover:bg-accenthover" : "bg-border text-muted"
                                )}
                            >
                                {saving ? "Saving…" : isGlobal ? "Save global profile" : "Save profile"}
                            </button>
                        </>
                    )}
                </footer>
            </div>
        </ModalShell>
    );
}
