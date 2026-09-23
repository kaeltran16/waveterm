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
// The one exception is the autonomy chip, which keeps its own write-on-pick behaviour from the header.

import { ModalShell } from "@/app/modals/modalshell";
import { channelsAtom, loadChannels } from "@/app/view/agents/channelsstore";
import { channelProjectLabel, dedupeByProject } from "@/app/view/agents/projectlabel";
import { projectsAtom } from "@/app/view/agents/projectsstore";
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
import { useEffect, useState, type ReactNode } from "react";
import { AutonomyLadder } from "./autonomyladderview";
import { briefUndo } from "./briefundo";
import { GlobalPrinciplesEditor } from "./globalprincipleseditor";
import { PrinciplesEditor } from "./principleseditor";
import { globalProfileIsDirty, isDirty, profileOverrideIsEmpty, resetActionState } from "./profilemodel";
import { ProjectChips } from "./projectchips";

const LABEL = "font-mono text-[10.5px] font-bold uppercase tracking-[.09em] text-ink-mid";
const BADGE = "rounded-[4px] px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-[.08em]";
const FOOTER_BTN = "cursor-pointer rounded-[7px] px-3.5 py-1.5 text-[11.5px] font-semibold disabled:cursor-default";
const SHAPES = ["quick", "orchestrator"] as const;

type Scope = "project" | "global";
type Loaded = { global: JarvisProfile; override: ProfileOverride; diagnostics: PrincipleDiagnostic[] };
// the fields both scopes share. ProfileOverride and JarvisProfile agree on all of them; `route` is the one
// that does not exist globally, which is why the lead-route row is passed in rather than rendered here.
type Defaults = Pick<ProfileOverride, "defaultmode" | "parallelism" | "workerroute">;

// one row of the run-defaults grid (design L914-925): the label cell, then the control with where its value
// comes from and the way back to inheriting. disabled is the whole modal's save flag, so a reset cannot
// mutate the draft mid-write. The row's longer explanation rides on the label as a tooltip.
function DefaultRow({
    label,
    hint,
    inheritable,
    inherited,
    clearable = false,
    disabled,
    onReset,
    children,
}: {
    label: string;
    hint: string;
    // false in global scope: there is nothing above the global profile to inherit from, so a badge naming a
    // source and a reset that drops back to it would both describe something that does not exist.
    inheritable: boolean;
    inherited: boolean;
    // global scope only: a set value can still be dropped back to "unset" (parallelism: the lead chooses)
    clearable?: boolean;
    disabled: boolean;
    onReset: () => void;
    children: ReactNode;
}) {
    const reset = resetActionState(inherited, disabled);
    return (
        <>
            <span title={hint} className="text-[12px] text-secondary">
                {label}
            </span>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                {children}
                {inheritable ? (
                    <span
                        className={cn(
                            BADGE,
                            inherited ? "border border-edge-mid text-ink-mid" : "bg-accent/8 text-accent-soft"
                        )}
                    >
                        {inherited ? "global" : "project"}
                    </span>
                ) : null}
                {(inheritable || clearable) && reset.show ? (
                    <button
                        type="button"
                        onClick={onReset}
                        disabled={reset.disabled}
                        className="cursor-pointer font-mono text-[10px] text-ink-mid hover:text-secondary disabled:cursor-default disabled:opacity-40"
                    >
                        reset
                    </button>
                ) : null}
            </div>
        </>
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
    routeRow,
    autonomyRow,
}: {
    inheritable: boolean;
    draft: Defaults;
    base: JarvisProfile;
    saving: boolean;
    set: (patch: Defaults) => void;
    drop: (key: keyof Defaults) => void;
    routeRow?: ReactNode;
    autonomyRow?: ReactNode;
}) {
    const row = (key: keyof Defaults) => ({
        inheritable,
        inherited: inheritable && draft[key] == null,
        disabled: saving,
        onReset: () => drop(key),
    });
    const shape = draft.defaultmode ?? base.defaultmode ?? "quick";
    const width = draft.parallelism ?? base.parallelism ?? null;
    return (
        <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-2.5">
            <DefaultRow {...row("defaultmode")} label="Default shape" hint="How a new run in this project is composed.">
                <div className="flex gap-1.5">
                    {SHAPES.map((name) => (
                        <button
                            key={name}
                            type="button"
                            aria-pressed={shape === name}
                            disabled={saving}
                            onClick={() => set({ defaultmode: name })}
                            className={cn(
                                "cursor-pointer rounded-[6px] border px-2.5 py-1 font-mono text-[10.5px] disabled:cursor-default",
                                shape === name
                                    ? "border-accent/40 bg-accentbg text-accent-soft"
                                    : "border-edge-mid text-ink-mid hover:border-edge-strong"
                            )}
                        >
                            {name}
                        </button>
                    ))}
                </div>
            </DefaultRow>
            <DefaultRow
                {...row("parallelism")}
                clearable={!inheritable && draft.parallelism != null}
                label="Parallel workers"
                hint="Engine children in flight at once. Unset (–) lets the lead choose."
            >
                <div className="flex items-center gap-1.5">
                    <WorkerStepper
                        value={width}
                        disabled={saving}
                        // an unset width starts from the launcher's own default rather than one step off it
                        onStep={(delta) =>
                            set({ parallelism: width == null ? DEFAULT_PARALLELISM : clampParallelism(width + delta) })
                        }
                    />
                </div>
            </DefaultRow>
            {routeRow}
            <DefaultRow
                {...row("workerroute")}
                label="Worker route"
                hint="The route engine children launch on. Unset inherits the lead."
            >
                <RoutePicker
                    value={draft.workerroute ?? null}
                    canInherit
                    inheritedLabel="Inherit the lead"
                    disabled={saving}
                    onChange={(route) => (route == null ? drop("workerroute") : set({ workerroute: route }))}
                />
            </DefaultRow>
            {autonomyRow}
        </div>
    );
}

export function BriefProfileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const channels = useAtomValue(channelsAtom);
    const projects = useAtomValue(projectsAtom);
    const [channelId, setChannelId] = useState("");
    const [scope, setScope] = useState<Scope>("project");
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [draft, setDraft] = useState<ProfileOverride>({});
    const [globalLoaded, setGlobalLoaded] = useState<JarvisProfile | null>(null);
    const [globalDraft, setGlobalDraft] = useState<JarvisProfile | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (open) {
            fireAndForget(loadChannels);
        }
    }, [open]);

    const noProjects = channels != null && channels.length === 0;

    useEffect(() => {
        if (!open || channels == null || channels.length === 0) {
            return;
        }
        if (channelId === "" || !channels.some((c) => c.oid === channelId)) {
            setChannelId(channels[0].oid);
        }
    }, [open, channels, channelId]);

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
        setGlobalLoaded(null);
        setGlobalDraft(null);
        setError(null);
        fireAndForget(async () => {
            try {
                if (channelId === "") {
                    const g = await getGlobalProfile();
                    if (live) {
                        setGlobalLoaded(g);
                        setGlobalDraft(g);
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
                setGlobalLoaded(p.global);
                setGlobalDraft(p.global);
            } catch (e) {
                if (live) {
                    setError(String(e));
                }
            }
        });
        return () => {
            live = false;
        };
    }, [open, channelId, noProjects]);

    if (!open) {
        return null;
    }

    const channel = channels?.find((c) => c.oid === channelId) ?? null;
    const isGlobal = scope === "global";
    const ready = isGlobal ? globalDraft != null : loaded != null;
    const dirty = isGlobal
        ? globalLoaded != null && globalDraft != null && globalProfileIsDirty(globalDraft, globalLoaded)
        : loaded != null && isDirty(draft, loaded.override);

    const set = (patch: Partial<ProfileOverride>) => setDraft((d) => ({ ...d, ...patch }));
    const drop = (key: keyof ProfileOverride) =>
        setDraft((d) => {
            const next = { ...d };
            delete next[key];
            return next;
        });
    const setGlobal = (patch: Partial<JarvisProfile>) => setGlobalDraft((g) => (g ? { ...g, ...patch } : g));
    const dropGlobal = (key: keyof Defaults) =>
        setGlobalDraft((g) => {
            if (g == null) {
                return g;
            }
            const next = { ...g };
            delete next[key];
            return next;
        });

    // a landed save closes the modal and says so in the Brief's toast (design L1734); a refused one keeps
    // the draft standing with the server's message
    const save = (scopeLabel: string) => {
        const saved = () => {
            briefUndo.notify(`Profile saved for ${scopeLabel} · applies to future runs`);
            onClose();
        };
        setSaving(true);
        setError(null);
        fireAndForget(async () => {
            try {
                if (isGlobal) {
                    if (globalDraft == null) {
                        return;
                    }
                    await setGlobalProfile(globalDraft);
                    setGlobalLoaded(globalDraft);
                    // the project face reads its inherited baseline off loaded.global, and every profile
                    // cached anywhere was resolved against the list this write just replaced.
                    setLoaded((l) => (l ? { ...l, global: globalDraft } : l));
                    clearResolvedProfiles();
                    if (channelId !== "") {
                        await refreshResolvedProfile(channelId);
                    }
                    saved();
                    return;
                }
                await setChannelProfile(channelId, draft);
                // mirror Go's own emptiness rule: a structurally empty override is stored as no override at
                // all, so the modal must not go on believing it saved one.
                setLoaded((l) => (l ? { ...l, override: profileOverrideIsEmpty(draft) ? {} : draft } : l));
                // refresh only after the write landed: a cache refreshed on a refused save would describe
                // a profile that does not exist.
                await refreshResolvedProfile(channelId);
                saved();
            } catch (e) {
                setError(String(e));
            } finally {
                setSaving(false);
            }
        });
    };

    const leadRouteRow =
        loaded != null ? (
            <DefaultRow
                label="Lead route"
                inheritable
                inherited={draft.route == null}
                disabled={saving}
                onReset={() => drop("route")}
                hint="The route every phase worker and the lead launch on."
            >
                <RoutePicker
                    value={draft.route ?? null}
                    canInherit
                    inheritedLabel="Inherit the global route"
                    disabled={saving}
                    onChange={(route) => (route == null ? drop("route") : set({ route }))}
                />
            </DefaultRow>
        ) : null;
    // the autonomy chip writes the tier the moment it is picked, like it did in the header; it is not part of
    // the draft Save writes
    const autonomyRow = (
        <>
            <span title="How much Jarvis decides without you, per project" className="text-[12px] text-secondary">
                Autonomy
            </span>
            <div className="flex">
                <AutonomyLadder channels={channels} />
            </div>
        </>
    );

    // the chips name projects, the modal edits channels: map one to the other, keeping a colliding label
    // distinct so both channels stay reachable
    const channelOptions = new Map<string, string>();
    for (const c of dedupeByProject(channels ?? [])) {
        const label = channelProjectLabel(c, projects) || c.oid.slice(0, 8);
        channelOptions.set(channelOptions.has(label) ? `${label} (${c.oid.slice(0, 8)})` : label, c.oid);
    }
    const pickedLabel = [...channelOptions].find(([, oid]) => oid === channelId)?.[0] ?? null;
    const projectLabel = channelProjectLabel(channel, projects) || "project";

    return (
        <ModalShell open={open} onClose={onClose} className="flex max-h-[86vh] w-[min(620px,93vw)] flex-col">
            <div
                data-jarvis-brief-modal="profile"
                data-jarvis-profile-scope={scope}
                className="flex min-h-0 flex-1 flex-col"
            >
                <header className="flex flex-none items-center gap-[11px] border-b border-border px-[18px] py-[15px]">
                    <span className="flex-1 text-[15px] font-semibold text-primary">Profile</span>
                    <div className="flex rounded-[7px] border border-edge-mid p-0.5">
                        {(["project", "global"] as const).map((s) => (
                            <button
                                key={s}
                                type="button"
                                data-jarvis-profile-tab={s}
                                aria-pressed={scope === s}
                                disabled={saving || (s === "project" && noProjects)}
                                onClick={() => setScope(s)}
                                className={cn(
                                    "max-w-[200px] cursor-pointer truncate rounded-[5px] px-2.5 py-[3px] font-mono text-[10.5px] font-semibold disabled:cursor-default disabled:opacity-40",
                                    scope === s ? "bg-accentbg text-accent-soft" : "text-ink-mid hover:text-secondary"
                                )}
                            >
                                {s === "project" ? projectLabel : "global"}
                            </button>
                        ))}
                    </div>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-[18px] py-4">
                    {!isGlobal && channelOptions.size > 1 ? (
                        <ProjectChips
                            names={[...channelOptions.keys()]}
                            picked={pickedLabel}
                            recent={null}
                            onPick={(label) => {
                                const oid = channelOptions.get(label);
                                if (oid != null && !saving) {
                                    setChannelId(oid);
                                }
                            }}
                            columns={1}
                        />
                    ) : null}
                    {error != null ? (
                        <p data-jarvis-brief-modal-state="error" className="text-[11.5px] text-error">
                            {error}
                        </p>
                    ) : null}
                    {!ready && error == null ? (
                        <div className="h-24 animate-pulse rounded-[10px] bg-surface-raised motion-reduce:animate-none" />
                    ) : null}
                    {isGlobal && globalDraft != null ? (
                        <>
                            <section className="flex flex-col gap-2">
                                <span className={LABEL}>Run defaults</span>
                                <DefaultsFields
                                    inheritable={false}
                                    draft={globalDraft}
                                    base={globalDraft}
                                    saving={saving}
                                    set={setGlobal}
                                    drop={dropGlobal}
                                />
                            </section>
                            <section className="flex flex-col gap-2">
                                <PrinciplesHeader meta="every project inherits these" />
                                <GlobalPrinciplesEditor
                                    principles={globalDraft.principles ?? []}
                                    disabled={saving}
                                    onChange={(principles) => setGlobal({ principles })}
                                />
                            </section>
                        </>
                    ) : null}
                    {!isGlobal && loaded != null ? (
                        <>
                            <section className="flex flex-col gap-2">
                                <span className={LABEL}>Run defaults</span>
                                <DefaultsFields
                                    inheritable
                                    draft={draft}
                                    base={loaded.global}
                                    saving={saving}
                                    set={set}
                                    drop={drop}
                                    routeRow={leadRouteRow}
                                    autonomyRow={autonomyRow}
                                />
                            </section>
                            <section className="flex flex-col gap-2">
                                <PrinciplesHeader meta="global set, with this project's changes" />
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
                <footer className="flex flex-none items-center gap-2 border-t border-border px-[18px] py-3">
                    <span className={cn("flex-1 font-mono text-[10.5px]", dirty ? "text-asking" : "text-muted")}>
                        {dirty ? "unsaved changes · applies to future runs" : "no changes"}
                    </span>
                    <button
                        type="button"
                        onClick={onClose}
                        className={cn(
                            FOOTER_BTN,
                            "border border-border bg-surface-raised text-secondary hover:text-primary"
                        )}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => save(isGlobal ? "global" : projectLabel)}
                        disabled={saving || !dirty || !ready}
                        className={cn(
                            FOOTER_BTN,
                            dirty && ready ? "bg-accent text-background hover:bg-accenthover" : "bg-border text-muted"
                        )}
                    >
                        {saving ? "Saving…" : "Save profile"}
                    </button>
                </footer>
            </div>
        </ModalShell>
    );
}

function PrinciplesHeader({ meta }: { meta: string }) {
    return (
        <div className="flex items-baseline gap-2">
            <span className={LABEL}>Principles</span>
            <span className="font-mono text-[10.5px] text-muted">{meta}</span>
        </div>
    );
}
