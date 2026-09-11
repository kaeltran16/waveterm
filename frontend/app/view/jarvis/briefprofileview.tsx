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
// project inherits from. The global face and the playbook editor both lost their mount when B5 deleted
// profilepanel.tsx, which left custom playbooks and global principles reachable only over the RPC; this is
// the re-home meta-spec 4a item 10 asked for.
//
// Nothing is written until Save, and a refused save leaves the draft standing with the server's message.

import { channelsAtom, loadChannels } from "@/app/view/agents/channelsstore";
import { RoutePicker } from "@/app/view/agents/routepicker";
import {
    clearResolvedProfiles,
    getGlobalProfile,
    getJarvisProfile,
    refreshResolvedProfile,
    setChannelProfile,
    setGlobalProfile,
} from "@/app/view/agents/runactions";
import { MAX_PARALLELISM } from "@/app/view/agents/runconfig";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState, type ReactNode } from "react";
import { GlobalPrinciplesEditor } from "./globalprincipleseditor";
import { PlaybookEditor, PlaybookSummary } from "./playbookeditor";
import { PrinciplesEditor } from "./principleseditor";
import { globalProfileIsDirty, isDirty, profileOverrideIsEmpty, resetActionState } from "./profilemodel";

const LABEL = "font-mono text-[9.5px] font-bold uppercase tracking-[.13em] text-feed-label";
const FIELD = "rounded-[7px] border border-border bg-background px-2 py-1 text-[11.5px] text-ink-hi";
const BTN =
    "rounded-[7px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-default";
const SECTION = "flex flex-col gap-2 border-t border-edge-faint pt-3.5";
const BADGE = "rounded-[4px] px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.08em]";

type Scope = "project" | "global";
type Loaded = { global: JarvisProfile; override: ProfileOverride; diagnostics: PrincipleDiagnostic[] };
// the fields both scopes share. ProfileOverride and JarvisProfile agree on all of them; `route` is the one
// that does not exist globally, which is why the lead-route row is passed in rather than rendered here.
type Defaults = Pick<ProfileOverride, "defaultmode" | "defaultplangate" | "machine" | "parallelism" | "workerroute">;

// one row per run default: a labelled control, where the value comes from, and the two ways back to
// inheriting. disabled is the whole modal's save flag, so a reset cannot mutate the draft mid-write.
function DefaultRow({
    label,
    hint,
    inheritable,
    inherited,
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
    disabled: boolean;
    onReset: () => void;
    children: ReactNode;
}) {
    const reset = resetActionState(inherited, disabled);
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
                <span className="text-[11.5px] font-semibold text-secondary">{label}</span>
                {inheritable ? (
                    <span
                        className={cn(
                            BADGE,
                            inherited ? "border border-edge-mid text-muted" : "bg-accentbg/50 text-accent-soft"
                        )}
                    >
                        {inherited ? "global" : "project"}
                    </span>
                ) : null}
                {inheritable && reset.show ? (
                    <button
                        type="button"
                        onClick={onReset}
                        disabled={reset.disabled}
                        className="text-[10px] text-muted hover:text-secondary disabled:cursor-default disabled:text-muted disabled:opacity-40 disabled:hover:text-muted"
                    >
                        reset
                    </button>
                ) : null}
            </div>
            {children}
            <span className="text-[11px] text-muted">{hint}</span>
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
    routeRow,
}: {
    inheritable: boolean;
    draft: Defaults;
    base: JarvisProfile;
    saving: boolean;
    set: (patch: Defaults) => void;
    drop: (key: keyof Defaults) => void;
    routeRow?: ReactNode;
}) {
    const row = (key: keyof Defaults) => ({
        inheritable,
        inherited: inheritable && draft[key] == null,
        disabled: saving,
        onReset: () => drop(key),
    });
    return (
        <>
            <DefaultRow {...row("defaultmode")} label="Shape" hint="How a new run in this project is composed.">
                <select
                    value={draft.defaultmode ?? base.defaultmode ?? "pipeline"}
                    disabled={saving}
                    onChange={(e) => set({ defaultmode: e.target.value })}
                    className={cn(FIELD, "w-40")}
                >
                    <option value="quick">quick</option>
                    <option value="pipeline">pipeline</option>
                    <option value="orchestrator">orchestrator</option>
                </select>
            </DefaultRow>
            <DefaultRow
                {...row("machine")}
                label="Orchestrator machine"
                hint="Engine schedules a DAG into managed worktrees; adaptive lets the lead dispatch its own subagents."
            >
                <select
                    value={draft.machine ?? base.machine ?? "adaptive"}
                    disabled={saving}
                    onChange={(e) => set({ machine: e.target.value })}
                    className={cn(FIELD, "w-40")}
                >
                    <option value="adaptive">adaptive</option>
                    <option value="engine">engine</option>
                </select>
            </DefaultRow>
            <DefaultRow
                {...row("parallelism")}
                label="Parallelism"
                hint={`Engine children in flight at once. Leave it unset to let the lead choose (1 through ${MAX_PARALLELISM}).`}
            >
                <input
                    type="number"
                    min={1}
                    max={MAX_PARALLELISM}
                    value={draft.parallelism ?? base.parallelism ?? ""}
                    disabled={saving}
                    placeholder="let the lead choose"
                    onChange={(e) => set({ parallelism: e.target.value === "" ? undefined : Number(e.target.value) })}
                    className={cn(FIELD, "w-40")}
                />
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
            <DefaultRow
                {...row("defaultplangate")}
                label="Plan gate"
                hint="Hold a new plan for review before its first worker is dispatched."
            >
                <label className="flex items-center gap-2 text-[11.5px] text-secondary">
                    <input
                        type="checkbox"
                        disabled={saving}
                        checked={draft.defaultplangate ?? base.defaultplangate ?? true}
                        onChange={(e) => set({ defaultplangate: e.target.checked })}
                    />
                    hold the plan for review
                </label>
            </DefaultRow>
        </>
    );
}

export function BriefProfileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const channels = useAtomValue(channelsAtom);
    const [channelId, setChannelId] = useState("");
    const [scope, setScope] = useState<Scope>("project");
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [draft, setDraft] = useState<ProfileOverride>({});
    const [globalLoaded, setGlobalLoaded] = useState<JarvisProfile | null>(null);
    const [globalDraft, setGlobalDraft] = useState<JarvisProfile | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

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
        setNotice(null);
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

    const save = () => {
        setSaving(true);
        setError(null);
        setNotice(null);
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
                    setNotice("Saved. Global defaults apply to future runs in every project.");
                    return;
                }
                await setChannelProfile(channelId, draft);
                // mirror Go's own emptiness rule: a structurally empty override is stored as no override at
                // all, so the modal must not go on believing it saved one.
                setLoaded((l) => (l ? { ...l, override: profileOverrideIsEmpty(draft) ? {} : draft } : l));
                // refresh only after the write landed: a cache refreshed on a refused save would describe
                // a profile that does not exist.
                await refreshResolvedProfile(channelId);
                setNotice("Saved. This applies to future runs only.");
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

    return (
        <div data-jarvis-brief-modal="profile" className="absolute inset-0 z-30 flex items-center justify-center">
            <button
                type="button"
                aria-label="Close profile"
                onClick={onClose}
                className="absolute inset-0 cursor-default bg-background/60"
            />
            <div
                role="dialog"
                aria-label="Jarvis profile"
                data-jarvis-profile-scope={scope}
                className="relative flex max-h-[86vh] w-[560px] max-w-[94vw] flex-col rounded-[12px] border border-border bg-surface shadow-xl"
            >
                <header className="flex flex-none items-center gap-2.5 border-b border-edge-faint px-4 py-3">
                    <span className={cn(LABEL, "text-accent-soft")}>profile</span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink-hi">
                        {isGlobal ? "Global defaults" : (channel?.name ?? "No project")}
                    </span>
                    <button type="button" aria-label="Close profile" onClick={onClose} className={BTN}>
                        Close
                    </button>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
                    <div className="flex flex-none gap-1 rounded-[8px] border border-edge-mid p-0.5">
                        {(["project", "global"] as const).map((s) => (
                            <button
                                key={s}
                                type="button"
                                data-jarvis-profile-tab={s}
                                aria-pressed={scope === s}
                                disabled={saving || (s === "project" && noProjects)}
                                onClick={() => setScope(s)}
                                className={cn(
                                    "flex-1 cursor-pointer rounded-[6px] px-2 py-1 text-[11px] font-medium disabled:cursor-default disabled:opacity-40",
                                    scope === s ? "bg-accentbg/50 text-accent-soft" : "text-muted hover:text-secondary"
                                )}
                            >
                                {s === "project" ? "This project" : "Global defaults"}
                            </button>
                        ))}
                    </div>
                    {!isGlobal && (channels?.length ?? 0) > 1 ? (
                        <label className="flex flex-col gap-1">
                            <span className={LABEL}>project</span>
                            <select
                                value={channelId}
                                disabled={saving}
                                onChange={(e) => setChannelId(e.target.value)}
                                className={FIELD}
                            >
                                {(channels ?? []).map((c) => (
                                    <option key={c.oid} value={c.oid}>
                                        {c.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}
                    {!isGlobal && channel?.projectpath ? (
                        <span className="truncate font-mono text-[10.5px] text-muted">{channel.projectpath}</span>
                    ) : null}
                    {isGlobal ? (
                        <span className="text-[11px] text-muted">
                            Inherited by every project that has not overridden the section.
                        </span>
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
                            <section className="flex flex-col gap-3.5">
                                <span className={LABEL}>future-run defaults</span>
                                <DefaultsFields
                                    inheritable={false}
                                    draft={globalDraft}
                                    base={globalDraft}
                                    saving={saving}
                                    set={setGlobal}
                                    drop={dropGlobal}
                                />
                            </section>
                            <section className={SECTION}>
                                <span className={LABEL}>playbook</span>
                                <span className="text-[11px] text-muted">
                                    The phases a pipeline run is composed from, in order.
                                </span>
                                <PlaybookEditor
                                    phases={globalDraft.playbook ?? []}
                                    disabled={saving}
                                    onChange={(playbook) => setGlobal({ playbook })}
                                />
                            </section>
                            <section className={SECTION}>
                                <span className={LABEL}>standing rules</span>
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
                            <section className="flex flex-col gap-3.5">
                                <span className={LABEL}>future-run defaults</span>
                                <DefaultsFields
                                    inheritable
                                    draft={draft}
                                    base={loaded.global}
                                    saving={saving}
                                    set={set}
                                    drop={drop}
                                    routeRow={leadRouteRow}
                                />
                            </section>
                            <section className={SECTION}>
                                <div className="flex items-center gap-2">
                                    <span className={LABEL}>playbook</span>
                                    <span
                                        className={cn(
                                            BADGE,
                                            draft.playbook == null
                                                ? "border border-edge-mid text-muted"
                                                : "bg-accentbg/50 text-accent-soft"
                                        )}
                                    >
                                        {draft.playbook == null ? "global" : "project"}
                                    </span>
                                    <div className="flex-1" />
                                    {/* the whole playbook is one section-level override: a project either
                                        states its own phase list or inherits the global one. Customize copies
                                        the inherited phases in, so the edit starts from what runs today. */}
                                    {draft.playbook == null ? (
                                        <button
                                            type="button"
                                            disabled={saving}
                                            onClick={() =>
                                                set({ playbook: (loaded.global.playbook ?? []).map((p) => ({ ...p })) })
                                            }
                                            className="cursor-pointer text-[10px] text-accent-soft hover:text-accent disabled:cursor-default disabled:opacity-40"
                                        >
                                            customize
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            disabled={saving}
                                            onClick={() => drop("playbook")}
                                            className="cursor-pointer text-[10px] text-muted hover:text-secondary disabled:cursor-default disabled:opacity-40"
                                        >
                                            reset
                                        </button>
                                    )}
                                </div>
                                {draft.playbook == null ? (
                                    <PlaybookSummary phases={loaded.global.playbook ?? []} />
                                ) : (
                                    <PlaybookEditor
                                        phases={draft.playbook}
                                        disabled={saving}
                                        onChange={(playbook) => set({ playbook })}
                                    />
                                )}
                            </section>
                            <section className={SECTION}>
                                <span className={LABEL}>standing rules</span>
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
                    {notice != null ? (
                        <p data-jarvis-brief-modal-state="saved" className="text-[11.5px] text-success">
                            {notice}
                        </p>
                    ) : null}
                </div>
                <footer className="flex flex-none items-center gap-2 border-t border-edge-faint px-4 py-3">
                    <button
                        type="button"
                        onClick={save}
                        disabled={saving || !dirty || !ready}
                        className={cn(BTN, "border-accent/40 text-accent-soft")}
                    >
                        {saving ? "Saving…" : isGlobal ? "Save global defaults" : "Save project profile"}
                    </button>
                    <span className="text-[11px] text-muted">
                        {isGlobal
                            ? "Applies wherever a project has not overridden it."
                            : "Edits affect future runs only."}
                    </span>
                </footer>
            </div>
        </div>
    );
}
