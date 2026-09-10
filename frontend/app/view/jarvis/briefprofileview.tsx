// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's Profile modal: the future-run defaults for one channel. It is the Brief-side mount of the
// channel profile the Stage rail's drawer owns in the three-pane composition, and it deliberately keeps
// the same authority chain — resolution, empty-override detection and validation all live in Go, and this
// modal only projects and patches the override it is given.
//
// Every field is a section-level override with the same two affordances the drawer's editor has: Customize
// copies the inherited value into the override, Reset drops the key so it inherits again. Nothing here is
// written until Save, and a refused save leaves the draft standing with the server's own message.

import { channelsAtom, loadChannels } from "@/app/view/agents/channelsstore";
import { RoutePicker } from "@/app/view/agents/routepicker";
import { getJarvisProfile, refreshResolvedProfile, setChannelProfile } from "@/app/view/agents/runactions";
import { MAX_PARALLELISM } from "@/app/view/agents/runconfig";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState, type ReactNode } from "react";
import { PrinciplesEditor } from "./principleseditor";
import { isDirty, resetActionState } from "./profilemodel";

const LABEL = "font-mono text-[9.5px] font-bold uppercase tracking-[.13em] text-feed-label";
const FIELD = "rounded-[7px] border border-border bg-background px-2 py-1 text-[11.5px] text-ink-hi";
const BTN =
    "rounded-[7px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-default";

type Loaded = { global: JarvisProfile; override: ProfileOverride; diagnostics: PrincipleDiagnostic[] };

// one row per future-run default: a labelled control, the section it comes from, and the two ways back to
// inheriting. disabled is the whole modal's save flag, so a reset cannot mutate the draft mid-write.
function DefaultRow({
    label,
    hint,
    inherited,
    disabled,
    onReset,
    children,
}: {
    label: string;
    hint: string;
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
                <span
                    className={cn(
                        "rounded-[4px] px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.08em]",
                        inherited ? "border border-edge-mid text-muted" : "bg-accentbg/50 text-accent-soft"
                    )}
                >
                    {inherited ? "global" : "project"}
                </span>
                {reset.show ? (
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

export function BriefProfileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const channels = useAtomValue(channelsAtom);
    const [channelId, setChannelId] = useState("");
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [draft, setDraft] = useState<ProfileOverride>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    useEffect(() => {
        if (open) {
            fireAndForget(loadChannels);
        }
    }, [open]);

    useEffect(() => {
        if (!open || channels == null || channels.length === 0) {
            return;
        }
        if (channelId === "" || !channels.some((c) => c.oid === channelId)) {
            setChannelId(channels[0].oid);
        }
    }, [open, channels, channelId]);

    useEffect(() => {
        if (!open || channelId === "") {
            return;
        }
        let live = true;
        setLoaded(null);
        setError(null);
        setNotice(null);
        fireAndForget(async () => {
            try {
                const p = await getJarvisProfile(channelId);
                if (!live) {
                    return;
                }
                setLoaded({ global: p.global, override: p.override ?? {}, diagnostics: p.principlediagnostics ?? [] });
                setDraft(p.override ?? {});
            } catch (e) {
                if (live) {
                    setError(String(e));
                }
            }
        });
        return () => {
            live = false;
        };
    }, [open, channelId]);

    if (!open) {
        return null;
    }

    const channel = channels?.find((c) => c.oid === channelId) ?? null;
    const dirty = loaded != null && isDirty(draft, loaded.override);
    const set = (patch: Partial<ProfileOverride>) => setDraft((d) => ({ ...d, ...patch }));
    const drop = (key: keyof ProfileOverride) =>
        setDraft((d) => {
            const next = { ...d };
            delete next[key];
            return next;
        });

    const save = () => {
        setSaving(true);
        setError(null);
        setNotice(null);
        fireAndForget(async () => {
            try {
                await setChannelProfile(channelId, draft);
                setLoaded((l) => (l ? { ...l, override: draft } : l));
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
                className="relative flex max-h-[86vh] w-[560px] max-w-[94vw] flex-col rounded-[12px] border border-border bg-surface shadow-xl"
            >
                <header className="flex flex-none items-center gap-2.5 border-b border-edge-faint px-4 py-3">
                    <span className={cn(LABEL, "text-accent-soft")}>profile</span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink-hi">
                        {channel != null ? channel.name : "No project"}
                    </span>
                    <button type="button" aria-label="Close profile" onClick={onClose} className={BTN}>
                        Close
                    </button>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
                    {(channels?.length ?? 0) > 1 ? (
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
                    {channel?.projectpath ? (
                        <span className="truncate font-mono text-[10.5px] text-muted">{channel.projectpath}</span>
                    ) : null}
                    {error != null ? (
                        <p data-jarvis-brief-modal-state="error" className="text-[11.5px] text-error">
                            {error}
                        </p>
                    ) : null}
                    {loaded == null && error == null ? (
                        <div className="h-24 animate-pulse rounded-[10px] bg-surface-raised motion-reduce:animate-none" />
                    ) : null}
                    {loaded != null ? (
                        <>
                            <section className="flex flex-col gap-3.5">
                                <span className={LABEL}>future-run defaults</span>
                                <DefaultRow
                                    label="Shape"
                                    inherited={draft.defaultmode == null}
                                    disabled={saving}
                                    onReset={() => drop("defaultmode")}
                                    hint="How a new run in this project is composed."
                                >
                                    <select
                                        value={draft.defaultmode ?? loaded.global.defaultmode ?? "pipeline"}
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
                                    label="Orchestrator machine"
                                    inherited={draft.machine == null}
                                    disabled={saving}
                                    onReset={() => drop("machine")}
                                    hint="Engine schedules a DAG into managed worktrees; adaptive lets the lead dispatch its own subagents."
                                >
                                    <select
                                        value={draft.machine ?? loaded.global.machine ?? "adaptive"}
                                        disabled={saving}
                                        onChange={(e) => set({ machine: e.target.value })}
                                        className={cn(FIELD, "w-40")}
                                    >
                                        <option value="adaptive">adaptive</option>
                                        <option value="engine">engine</option>
                                    </select>
                                </DefaultRow>
                                <DefaultRow
                                    label="Parallelism"
                                    inherited={draft.parallelism == null}
                                    disabled={saving}
                                    onReset={() => drop("parallelism")}
                                    hint={`Engine children in flight at once. Leave it unset to let the lead choose (1 through ${MAX_PARALLELISM}).`}
                                >
                                    <input
                                        type="number"
                                        min={1}
                                        max={MAX_PARALLELISM}
                                        value={draft.parallelism ?? loaded.global.parallelism ?? ""}
                                        disabled={saving}
                                        placeholder="let the lead choose"
                                        onChange={(e) =>
                                            set({
                                                parallelism: e.target.value === "" ? undefined : Number(e.target.value),
                                            })
                                        }
                                        className={cn(FIELD, "w-40")}
                                    />
                                </DefaultRow>
                                <DefaultRow
                                    label="Lead route"
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
                                <DefaultRow
                                    label="Worker route"
                                    inherited={draft.workerroute == null}
                                    disabled={saving}
                                    onReset={() => drop("workerroute")}
                                    hint="The route engine children launch on. Unset inherits the lead."
                                >
                                    <RoutePicker
                                        value={draft.workerroute ?? null}
                                        canInherit
                                        inheritedLabel="Inherit the lead"
                                        disabled={saving}
                                        onChange={(route) =>
                                            route == null ? drop("workerroute") : set({ workerroute: route })
                                        }
                                    />
                                </DefaultRow>
                                <DefaultRow
                                    label="Plan gate"
                                    inherited={draft.defaultplangate == null}
                                    disabled={saving}
                                    onReset={() => drop("defaultplangate")}
                                    hint="Hold a new plan for review before its first worker is dispatched."
                                >
                                    <label className="flex items-center gap-2 text-[11.5px] text-secondary">
                                        <input
                                            type="checkbox"
                                            disabled={saving}
                                            checked={draft.defaultplangate ?? loaded.global.defaultplangate ?? true}
                                            onChange={(e) => set({ defaultplangate: e.target.checked })}
                                        />
                                        hold the plan for review
                                    </label>
                                </DefaultRow>
                            </section>
                            <section className="flex flex-col gap-2 border-t border-edge-faint pt-3.5">
                                <span className={LABEL}>standing rules</span>
                                <PrinciplesEditor
                                    global={loaded.global.principles ?? []}
                                    patch={draft.principles}
                                    diagnostics={loaded.diagnostics}
                                    disabled={saving}
                                    onChange={(patch) => set({ principles: patch })}
                                />
                            </section>
                            {notice != null ? (
                                <p data-jarvis-brief-modal-state="saved" className="text-[11.5px] text-success">
                                    {notice}
                                </p>
                            ) : null}
                        </>
                    ) : null}
                </div>
                <footer className="flex flex-none items-center gap-2 border-t border-edge-faint px-4 py-3">
                    <button
                        type="button"
                        onClick={save}
                        disabled={saving || !dirty || loaded == null}
                        className={cn(BTN, "border-accent/40 text-accent-soft")}
                    >
                        {saving ? "Saving…" : "Save project profile"}
                    </button>
                    <span className="text-[11px] text-muted">Edits affect future runs only.</span>
                </footer>
            </div>
        </div>
    );
}
